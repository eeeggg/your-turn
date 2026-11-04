import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
afterEach(() => { vi.useRealTimers(); vi.mocked(spawn).mockClear(); });

vi.mock('@playwright/test', () => ({ test: { extend: (fixtures: unknown) => fixtures }, expect: {}, _electron: {} }));

interface DisplayFixture {
  display(input: object, use: (display: string | undefined) => Promise<void>): Promise<void>;
}

async function fixture() {
  const { test } = await import('@tests/ui/window');
  return test as unknown as DisplayFixture;
}

it('owns a separate ready X display per test and closes both servers before returning', async () => {
  const fixtures = await fixture();
  if (process.platform !== 'linux') {
    await fixtures.display({}, async (display) => { expect(display).toBe(process.env['DISPLAY']); });
    return;
  }
  const displays: string[] = [];
  await fixtures.display({}, async (first) => {
    expect(first).toMatch(/^:\d+$/);
    displays.push(first ?? '');
    await access(`/tmp/.X11-unix/X${(first ?? '').slice(1)}`);
    await fixtures.display({}, async (second) => {
      expect(second).toMatch(/^:\d+$/);
      expect(second).not.toBe(first);
      displays.push(second ?? '');
      await access(`/tmp/.X11-unix/X${(second ?? '').slice(1)}`);
    });
  });
  for (const display of displays) { await expect(access(`/tmp/.X11-unix/X${display.slice(1)}`)).rejects.toThrow(); }
});

it('closes the display after a test failure without replacing the failure', async () => {
  const fixtures = await fixture();
  const failure = new Error('test failed');
  let display: string | undefined;
  await expect(fixtures.display({}, async (owned) => { display = owned; throw failure; })).rejects.toBe(failure);
  if (process.platform !== 'linux') { expect(display).toBe(process.env['DISPLAY']); return; }
  expect(display).toMatch(/^:\d+$/);
  await expect(access(`/tmp/.X11-unix/X${(display ?? '').slice(1)}`)).rejects.toThrow();
});

it.each(['early exit', 'invalid readiness', 'readiness timeout'] as const)('closes the owned server after %s without running the test', async (failure) => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const fixtures = await fixture();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const script = failure === 'early exit'
    ? 'process.stderr.write("startup failed"); process.exitCode = 3;'
    : `process.send('ready'); ${failure === 'invalid readiness' ? 'process.stdout.write("invalid\\n");' : ''} setInterval(() => {}, 1000);`;
  const server = actual.spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const closed = new Promise<void>((resolveClosed) => { server.once('close', () => { resolveClosed(); }); });
  const ready = new Promise<void>((resolveReady) => { server.once('message', () => { resolveReady(); }); });
  vi.mocked(spawn).mockReturnValueOnce(server);
  const use = vi.fn();
  const result = expect(fixtures.display({}, use)).rejects.toThrow(
    failure === 'early exit' ? 'Xvfb closed before readiness: startup failed'
      : failure === 'invalid readiness' ? 'Invalid Xvfb display: invalid'
        : 'Xvfb readiness watchdog expired',
  );
  try {
    if (failure === 'readiness timeout') { await ready; await vi.advanceTimersByTimeAsync(10_000); }
    await result;
    expect(server.exitCode !== null || server.signalCode !== null).toBe(true);
    expect(use).not.toHaveBeenCalled();
  } finally {
    server.kill('SIGKILL');
    await closed;
  }
});
