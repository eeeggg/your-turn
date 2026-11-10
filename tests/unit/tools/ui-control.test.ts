import { expect, it, onTestFinished } from 'vitest';
import { connectControl, listenControl } from '@tests/ui/instrumentation/ControlChannel';
import { SchedulingControl } from '@tests/ui/instrumentation/SchedulingControl';

it('acknowledges commands only after the controlled operation completes', async () => {
  const server = await listenControl();
  onTestFinished(() => server.close());
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const client = connectControl(server.port, async (command) => { entered(); await gate; return `${command}-done`; });
  onTestFinished(() => client.close());
  let acknowledged = false;
  const pending = server.request('work', 'work-done').then(() => { acknowledged = true; });
  await started;
  expect(acknowledged).toBe(false);
  await expect(server.request('overlap', 'done')).rejects.toThrow(/already pending/);
  release();
  await pending;
  await server.request('again', 'again-done');
  expect(acknowledged).toBe(true);
});

it('rejects a pending request and subsequent requests when the peer disconnects', async () => {
  const server = await listenControl();
  onTestFinished(() => server.close());
  const client = connectControl(server.port, async () => { client.close(); return 'unused'; });
  onTestFinished(() => client.close());
  await expect(server.request('work', 'done')).rejects.toThrow(/closed/);
  await expect(server.request('again', 'done')).rejects.toThrow(/closed/);
});

it('rejects requests waiting for a connection when disposed', async () => {
  const server = await listenControl();
  const pending = expect(server.request('work', 'done')).rejects.toThrow(/closed/);
  await server.close();
  await pending;
  await server.close();
});

it('reports handler errors to the requesting test', async () => {
  const server = await listenControl();
  onTestFinished(() => server.close());
  const client = connectControl(server.port, async () => { throw new Error('refresh failed'); });
  onTestFinished(() => client.close());
  await expect(server.request('work', 'done')).rejects.toThrow('refresh failed');
});

it('rejects unexpected acknowledgments rather than hanging', async () => {
  const server = await listenControl();
  onTestFinished(() => server.close());
  const client = connectControl(server.port, async () => 'wrong');
  onTestFinished(() => client.close());
  await expect(server.request('work', 'done')).rejects.toThrow(/Expected done.*wrong/);
});

it('aborts controlled operations when the test closes its endpoint', async () => {
  const server = await listenControl();
  onTestFinished(() => server.close());
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let aborted: () => void = () => {};
  const stopped = new Promise<void>((resolve) => { aborted = resolve; });
  const client = connectControl(server.port, async (_command, signal) => {
    signal.addEventListener('abort', aborted, { once: true });
    entered();
    await stopped;
    return 'done';
  });
  onTestFinished(() => client.close());
  const pending = expect(server.request('work', 'done')).rejects.toThrow(/closed/);
  await started;
  await server.close();
  await Promise.all([pending, stopped]);
});

it('handles a command queued before connection and rejects commands and clients arriving after close', async () => {
  const server = await listenControl();
  onTestFinished(() => server.close());
  const armed = server.request('arm', 'armed');
  const scheduling = new SchedulingControl();
  const client = connectControl(server.port, async (command, signal) => {
    expect(command).toBe('arm');
    scheduling.arm(signal);
    return 'armed';
  });
  onTestFinished(() => client.close());
  await armed;
  await server.close();
  await expect(server.request('arm', 'armed')).rejects.toThrow(/closed/);
  let handled = false;
  const late = connectControl(server.port, async () => { handled = true; return 'unexpected'; });
  onTestFinished(() => late.close());
  // A second endpoint closure remains safe while a late connection is refused.
  await server.close();
  late.close();
  expect(handled).toBe(false);
});
