import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ launch: vi.fn(), download: vi.fn() }));
vi.mock('@vscode/test-electron', () => ({ downloadAndUnzipVSCode: boundary.download }));
vi.mock('@playwright/test', () => ({
  _electron: { launch: boundary.launch },
  test: { extend: (fixtures: unknown) => fixtures },
  expect: {},
}));

interface WindowFixture {
  window(
    input: { workspace: string; reviewPresentation: undefined; gitRepository: boolean; display: undefined },
    use: () => Promise<void>,
    info: { testId: string; status: string; expectedStatus: string; outputPath(name: string): string },
  ): Promise<void>;
}

afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

async function fixture(options: { diagnosticFailure?: boolean; closeFailure?: boolean; setupFailure?: boolean; statusFailure?: boolean; launchFailure?: boolean; detachedDescendant?: boolean; hang?: 'diagnostics' | 'trace' | 'close' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'acp-ui-cleanup-test-'));
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }); });
  const status = join(directory, 'namespace.jsonl');
  const stop = join(directory, 'stop');
  const descendant = `process.send('ready'); setInterval(() => {}, 1000);`;
  const child = spawn('/bin/sh', [resolve('tests/ui/electron.sh'), '-e', `
    const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { detached: ${String(options.detachedDescendant ?? false)}, stdio: ['ignore', ${options.detachedDescendant ? "'ignore', 'ignore'" : "'inherit', 'inherit'"}, 'ipc'] });
    child.on('message', () => console.log('ready:' + child.pid));
    const { watch, existsSync } = require('node:fs');
    const watcher = watch(${JSON.stringify(directory)}, () => {
      if (existsSync(${JSON.stringify(stop)})) { watcher.close(); process.exit(0); }
    });
    setInterval(() => {}, 1000);
  `], {
    env: { ...process.env, ACP_UI_EXECUTABLE: process.execPath, ACP_UI_STATUS: status },
    detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
  });
  let closed = false;
  const exited = new Promise<void>((resolve) => { child.once('close', () => { closed = true; resolve(); }); });
  onTestFinished(async () => {
    child.stdio[3]?.destroy();
    if (child.pid !== undefined && !closed) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { throw error; }
      }
    }
    await exited;
  });
  let diagnostic = '';
  child.stderr?.setEncoding('utf8').on('data', (text: string) => { diagnostic += text; });
  const innerPid = await new Promise<string>((resolveReady, reject) => {
    if (!child.stdout) { throw new Error('Missing fixture application output'); }
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => { if (line.startsWith('ready:')) { lines.close(); resolveReady(line.slice(6)); } });
    child.once('close', () => { lines.close(); reject(new Error(`Fixture application closed before readiness: ${diagnostic}`)); });
    child.once('error', reject);
  });
  const details = JSON.parse((await readFile(status, 'utf8')).split('\n')[0] ?? '') as { 'child-pid': number };
  const namespace = details['child-pid'];
  const applicationPid = (await readFile(`/proc/${namespace}/task/${namespace}/children`, 'utf8')).trim().split(/\s+/)[0];
  if (!applicationPid) { throw new Error('Missing contained application PID'); }
  const descendantPid = (await readFile(`/proc/${applicationPid}/task/${applicationPid}/children`, 'utf8')).trim();
  expect(descendantPid).toMatch(/^\d+$/);
  expect((await readFile(`/proc/${descendantPid}/status`, 'utf8')).split('\n').find((line) => line.startsWith('NSpid:'))?.trim().split(/\s+/).at(-1)).toBe(innerPid);
  const paths: string[] = [];
  const events: string[] = [];
  let reportBlocked: () => void = () => {};
  const blocked = new Promise<void>((resolve) => { reportBlocked = resolve; });
  async function waitForShutdown() {
    reportBlocked();
    await new Promise<void>(() => {});
  }
  const diagnosticError = new Error('diagnostic failure');
  const closeError = new Error('graceful close failed');
  const setupError = new Error('first window failed');
  const page = {
    on: () => {},
    isClosed: () => {
      events.push('diagnostics');
      if (options.diagnosticFailure) { throw diagnosticError; }
      return false;
    },
    screenshot: async () => {
      if (options.hang === 'diagnostics') { await waitForShutdown(); }
    },
    locator: () => ({ evaluate: async () => '<body></body>' }),
    evaluate: async () => ({}),
    getByRole: () => ({ waitFor: async () => {} }),
  };
  const application = {
    on: () => {},
    process: () => {
      if (closed) { throw new Error('Electron application handle is disposed.'); }
      return child;
    },
    firstWindow: async () => {
      if (options.setupFailure) { throw setupError; }
      return page;
    },
    evaluate: async () => [],
    context: () => ({ tracing: {
      start: async () => {},
      stop: async () => {
        events.push('trace');
        if (options.hang === 'trace') { await waitForShutdown(); }
      },
    } }),
    close: async () => {
      events.push('close');
      if (options.hang === 'close') { await waitForShutdown(); }
      if (options.closeFailure) { throw closeError; }
      await writeFile(stop, '');
      await exited;
    },
  };
  boundary.download.mockResolvedValue('/unused-vscode');
  boundary.launch.mockImplementation(async (launch: { args: string[]; executablePath: string; env: Record<string, string> }) => {
    expect(launch.executablePath).toBe(resolve('tests/ui/electron.sh'));
    expect(launch.env['ACP_UI_EXECUTABLE']).toBe('/unused-vscode');
    const target = launch.env['ACP_UI_STATUS'];
    expect(target).toBeDefined();
    if (target) { await writeFile(target, options.statusFailure ? 'invalid status' : await readFile(status)); }
    paths.push(...launch.args.filter((arg) => arg.startsWith('--user-data-dir=') || arg.startsWith('--extensions-dir=')).map((arg) => arg.slice(arg.indexOf('=') + 1)));
    if (options.launchFailure) {
      if (child.pid) { process.kill(-child.pid, 'SIGKILL'); }
      await exited;
      throw setupError;
    }
    return application;
  });
  const { test } = await import('@tests/ui/window');
  const window = (test as unknown as WindowFixture).window;
  const run = (use: () => Promise<void>) => window(
    { workspace: directory, reviewPresentation: undefined, gitRepository: false, display: undefined },
    use,
    { testId: 'owned-cleanup', status: 'passed', expectedStatus: 'passed', outputPath: (name) => join(directory, name) },
  );
  const descendantRunning = async () => {
    try {
      const stat = await readFile(`/proc/${descendantPid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) { throw error; }
      return false;
    }
  };
  return { run, paths, events, diagnosticError, closeError, setupError, blocked, descendantRunning, closed: () => closed };
}

it('cleans resources after successful close disposes the Electron application handle', async () => {
  const state = await fixture();

  await state.run(async () => {});

  expect(state.closed()).toBe(true);
  expect(await state.descendantRunning()).toBe(false);
  expect(state.paths).toHaveLength(2);
  for (const path of state.paths) { expect(existsSync(path)).toBe(false); }
});

it('preserves the test failure and cleans resources when diagnostics throw', async () => {
  const state = await fixture({ diagnosticFailure: true });
  const failure = new Error('test failed');

  await expect(state.run(async () => { throw failure; })).rejects.toBe(failure);

  expect(state.events).toContain('close');
  expect(state.closed()).toBe(true);
  expect(state.paths).toHaveLength(2);
  for (const path of state.paths) { expect(existsSync(path)).toBe(false); }
});

it('awaits the complete process group before removing files after graceful close fails', async () => {
  const state = await fixture({ closeFailure: true });

  await expect(state.run(async () => {})).rejects.toBe(state.closeError);

  expect(state.closed()).toBe(true);
  expect(await state.descendantRunning()).toBe(false);
  for (const path of state.paths) { expect(existsSync(path)).toBe(false); }
});

it('reaps detached descendants even when graceful application close succeeds', async () => {
  const state = await fixture({ detachedDescendant: true });

  await state.run(async () => {});

  expect(state.closed()).toBe(true);
  expect(await state.descendantRunning()).toBe(false);
  for (const path of state.paths) { expect(existsSync(path)).toBe(false); }
});

it('cleans a launched process and temporary directories after fixture setup fails', async () => {
  const state = await fixture({ setupFailure: true });

  await expect(state.run(async () => {})).rejects.toBe(state.setupError);

  expect(state.closed()).toBe(true);
  for (const path of state.paths) { expect(existsSync(path)).toBe(false); }
});

it('preserves launch failure and removes directories before an application handle exists', async () => {
  const state = await fixture({ launchFailure: true, detachedDescendant: true });

  await expect(state.run(async () => {})).rejects.toBe(state.setupError);

  expect(state.closed()).toBe(true);
  for (const path of state.paths) { expect(existsSync(path)).toBe(false); }
});

it('falls back to the contained launch group when namespace status is unreadable', async () => {
  const state = await fixture({ statusFailure: true, closeFailure: true, detachedDescendant: true });

  await expect(state.run(async () => {})).rejects.toBe(state.closeError);

  expect(state.closed()).toBe(true);
  for (const path of state.paths) { expect(existsSync(path)).toBe(false); }
});

it('terminates descendants that created their own process group', async () => {
  const state = await fixture({ closeFailure: true, detachedDescendant: true });

  await expect(state.run(async () => {})).rejects.toBe(state.closeError);

  expect(state.closed()).toBe(true);
  for (const path of state.paths) { expect(existsSync(path)).toBe(false); }
});

it.each(['diagnostics', 'trace', 'close'] as const)('the teardown watchdog releases unresponsive %s and awaits process closure', async (hang) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const state = await fixture({ hang });
  const failure = new Error('test failure before teardown');
  const result = expect(state.run(async () => { throw failure; })).rejects.toBe(failure);
  await state.blocked;

  expect(state.closed()).toBe(false);
  for (const path of state.paths) { expect(existsSync(path)).toBe(true); }
  await vi.advanceTimersByTimeAsync(5000);
  await result;

  expect(state.closed()).toBe(true);
  expect(await state.descendantRunning()).toBe(false);
  for (const path of state.paths) { expect(existsSync(path)).toBe(false); }
});
