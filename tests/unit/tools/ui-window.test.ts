import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { existsSync, watch } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, assert, expect, it, onTestFinished, vi } from 'vitest';
import type { Page } from '@playwright/test';
import { selectListedSession } from '@tests/ui/workbench';

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

interface RecordedDiagnostics {
  timeline: { event: string; at: string; elapsedMs: number; phase: string; code?: number | null; signal?: string | null }[];
  stdout: { text: string; truncated: boolean };
  stderr: { text: string; truncated: boolean };
}

afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); vi.unstubAllEnvs(); });

it('leaves the agent and awaits hover dismissal before selecting a listed session', async () => {
  const events: string[] = [];
  let dismiss: () => void = () => { throw new Error('Hover dismissal has not started'); };
  let observed: () => void = () => {};
  const observing = new Promise<void>((resolve) => { observed = resolve; });
  const hidden = new Promise<void>((resolve) => { dismiss = resolve; });
  const row = {
    waitFor: async (options: unknown) => { expect(options).toEqual({ state: 'visible' }); events.push('row visible'); },
    click: async () => { events.push('click'); observed(); },
  };
  const title = { hover: async () => { events.push('leave agent'); } };
  const pane = { locator: (selector: string) => {
    expect(selector).toBe('.pane-header > .title');
    return title;
  } };
  const page = {
    locator: (selector: string) => {
      if (selector === '.pane') { return { filter: () => pane }; }
      expect(selector).toBe('.pane-header > .codicon-hubot');
      return {};
    },
    getByRole: (role: string, options?: unknown) => {
      if (role === 'tooltip') {
        return { waitFor: async (options: unknown) => {
          expect(options).toEqual({ state: 'hidden' });
          events.push('observe hover');
          observed();
          await hidden;
        } };
      }
      if (role === 'main') {
        return { hover: async () => { events.push('leave agent'); } };
      }
      expect([role, options]).toEqual(['tree', { name: 'Agents', exact: true }]);
      return { getByRole: (role: string) => {
        expect(role).toBe('treeitem');
        return { filter: (options: unknown) => { expect(options).toEqual({ hasText: 'Compaction session' }); return row; } };
      } };
    },
  } as unknown as Page;

  const selection = selectListedSession(page, 'Compaction session');
  await observing;
  expect(events).toEqual(['leave agent', 'observe hover']);
  dismiss();
  await selection;
  expect(events).toEqual(['leave agent', 'observe hover', 'row visible', 'click']);
});

async function fixture(options: { diagnosticFailure?: boolean; closeFailure?: boolean; setupFailure?: boolean; statusFailure?: boolean; launchFailure?: boolean; detachedDescendant?: boolean; hang?: 'diagnostics' | 'trace' | 'close' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ui-cleanup-test-'));
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
    env: { ...process.env, UI_EXECUTABLE: process.execPath, UI_STATUS: status },
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
  const launchArguments: string[] = [];
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
  const page = Object.assign(new EventEmitter(), {
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
  });
  const application = Object.assign(new EventEmitter(), {
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
      page.emit('close');
      application.emit('close');
      await writeFile(stop, '');
      await exited;
    },
  });
  vi.stubEnv('UI_VSCODE_EXECUTABLE', '/unused-vscode');
  boundary.download.mockRejectedValue(new Error('Editor downloads belong to the batch coordinator'));
  boundary.launch.mockImplementation(async (launch: { args: string[]; executablePath: string; env: Record<string, string> }) => {
    expect(launch.executablePath).toBe(resolve('tests/ui/electron.sh'));
    expect(launch.env['UI_EXECUTABLE']).toBe('/unused-vscode');
    expect(launch.args).toContain('--log=debug');
    launchArguments.push(...launch.args);
    const target = launch.env['UI_STATUS'];
    expect(target).toBeDefined();
    if (target) { await writeFile(target, options.statusFailure ? 'invalid status' : await readFile(status)); }
    paths.push(...launch.args.filter((arg) => arg.startsWith('--user-data-dir=') || arg.startsWith('--extensions-dir=')).map((arg) => arg.slice(arg.indexOf('=') + 1)));
    for (const [name, text] of Object.entries({
      '20261108T015857/main.log': 'Main debug context',
      '2026-11-08T01:58:57/main.log': 'Extended ISO context',
      '20260230T015857/main.log': 'Invalid calendar date',
      'not-a-date/main.log': 'Unrelated main log',
      '20261108T015857/nested/main.log': 'Nested main log',
      '20261108T015857/window1/renderer.log': 'Renderer debug context',
      '20261108T015857/window1/exthost/exthost.log': 'Extension host context',
      '20261108T015857/window1/output/Your Turn.log': 'Extension context',
      '20261108T015857/unrelated.log': 'Unrelated log',
    })) {
      const path = join(paths[0] ?? '', 'logs', name);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, text);
    }
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
  return { run, paths, launchArguments, events, page, application, child, diagnosticError, closeError, setupError, blocked, descendantRunning, directory, closed: () => closed };
}

it('rejects an unprepared editor before launching a window', async () => {
  vi.stubEnv('UI_VSCODE_EXECUTABLE', undefined);
  const { test } = await import('@tests/ui/window');
  const window = (test as unknown as WindowFixture).window;
  await expect(window(
    { workspace: '/unused', reviewPresentation: undefined, gitRepository: false, display: undefined },
    async () => { throw new Error('Unprepared fixture reached the test body'); },
    { testId: 'unprepared', status: 'passed', expectedStatus: 'passed', outputPath: (name) => name },
  )).rejects.toThrow('UI editor is not prepared; use npm run test:ui');
});

it('cleans resources after successful close disposes the Electron application handle', async () => {
  const state = await fixture();

  await state.run(async () => {});

  expect(state.closed()).toBe(true);
  expect(await state.descendantRunning()).toBe(false);
  expect(state.paths).toHaveLength(2);
  for (const path of state.paths) { expect(existsSync(path)).toBe(false); }
});

it('records startup and normal shutdown timing for a passing test', async () => {
  const state = await fixture();
  const before = Date.now();
  await state.run(async () => {});
  const after = Date.now();
  const diagnostics = JSON.parse(await readFile(join(state.directory, 'diagnostics.json'), 'utf8')) as RecordedDiagnostics;
  expect(diagnostics.timeline.map(({ event, phase }) => [event, phase])).toEqual([
    ['launch started', 'setup'],
    ['launch completed', 'setup'],
    ['first window obtained', 'setup'],
    ['workbench ready', 'setup'],
    ['test body started', 'test'],
    ['cleanup started', 'cleanup'],
    ['window closed', 'cleanup'],
    ['application closed', 'cleanup'],
    ['process exited', 'cleanup'],
    ['cleanup completed', 'cleanup'],
  ]);
  let previous = 0;
  for (const entry of diagnostics.timeline) {
    expect(Date.parse(entry.at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(entry.at)).toBeLessThanOrEqual(after);
    expect(entry.elapsedMs).toBeGreaterThanOrEqual(previous);
    previous = entry.elapsedMs;
  }
  expect(diagnostics.timeline.find(({ event }) => event === 'process exited')).toMatchObject({ code: 0, signal: null });
});

it('distinguishes premature renderer failure from cleanup closure', async () => {
  const state = await fixture();
  const failure = new Error('renderer stopped responding');
  await expect(state.run(async () => {
    state.page.emit('crash');
    state.page.emit('close');
    state.application.emit('close');
    throw failure;
  })).rejects.toBe(failure);
  const diagnostics = JSON.parse(await readFile(join(state.directory, 'diagnostics.json'), 'utf8')) as RecordedDiagnostics;
  expect(diagnostics.timeline.filter(({ phase }) => phase === 'test').map(({ event }) => event)).toEqual([
    'test body started', 'renderer crashed', 'window closed', 'application closed',
  ]);
  expect(diagnostics.timeline.filter(({ phase }) => phase === 'cleanup').map(({ event }) => event)).toContain('cleanup completed');
});

it('records a test-time process exit before cleanup closes its streams', async () => {
  const state = await fixture();
  await state.run(async () => {
    state.child.emit('exit', 77, null);
  });
  const diagnostics = JSON.parse(await readFile(join(state.directory, 'diagnostics.json'), 'utf8')) as RecordedDiagnostics;
  expect(diagnostics.timeline.filter(({ event }) => event === 'process exited')).toEqual([
    expect.objectContaining({ phase: 'test', code: 77, signal: null }),
  ]);
  expect(state.closed()).toBe(true);
});

it('preserves separate bounded process-output tails through shutdown', async () => {
  const state = await fixture();
  await state.run(async () => {
    state.child.stdout?.emit('data', 'discard stdout' + 'a'.repeat(12_500));
    state.child.stdout?.emit('data', 'a'.repeat(12_500));
    state.child.stderr?.emit('data', 'discard stderr' + 'b'.repeat(25_000));
    state.application.once('close', () => {
      state.child.stdout?.emit('data', Buffer.from('stdout shutdown'));
      state.child.stderr?.emit('data', 'stderr shutdown');
    });
  });
  const diagnostics = JSON.parse(await readFile(join(state.directory, 'diagnostics.json'), 'utf8')) as RecordedDiagnostics;
  expect(diagnostics.stdout).toEqual({ text: 'a'.repeat(20_000 - 'stdout shutdown'.length) + 'stdout shutdown', truncated: true });
  expect(diagnostics.stderr).toEqual({ text: 'b'.repeat(20_000 - 'stderr shutdown'.length) + 'stderr shutdown', truncated: true });
});

it('does not report readiness or test execution after first-window setup fails', async () => {
  const state = await fixture({ setupFailure: true });
  await expect(state.run(async () => { throw new Error('Unexpected test body'); })).rejects.toBe(state.setupError);
  const diagnostics = JSON.parse(await readFile(join(state.directory, 'diagnostics.json'), 'utf8')) as RecordedDiagnostics;
  expect(diagnostics.timeline.filter(({ phase }) => phase === 'setup').map(({ event }) => event)).toEqual(['launch started', 'launch completed']);
  expect(diagnostics.timeline.some(({ phase }) => phase === 'test')).toBe(false);
});

it('disables shell probing and owns the application shared-data directory', async () => {
  const state = await fixture();

  await state.run(async () => {
    expect(state.launchArguments).toContain('--force-disable-user-env');
    expect(state.launchArguments).toContain(`--shared-data-dir=${join(state.paths[0] ?? '', 'shared-data')}`);
    await mkdir(join(state.paths[0] ?? '', 'shared-data'), { recursive: true });
    await writeFile(join(state.paths[0] ?? '', 'shared-data', 'owned'), 'test storage');
  });

  expect(state.closed()).toBe(true);
  for (const path of state.paths) { expect(existsSync(path)).toBe(false); }
});

it('preserves the test failure and cleans resources when diagnostics throw', async () => {
  const state = await fixture({ diagnosticFailure: true });
  const failure = new Error('test failed');

  await expect(state.run(async () => { throw failure; })).rejects.toBe(failure);

  expect(state.events).toContain('close');
  expect(state.closed()).toBe(true);
  const diagnostics = JSON.parse(await readFile(join(state.directory, 'diagnostics.json'), 'utf8')) as { extensionLogs: Record<string, string> };
  expect(diagnostics.extensionLogs['20261108T015857/main.log']).toBe('Main debug context');
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
  const diagnostics = JSON.parse(await readFile(join(state.directory, 'diagnostics.json'), 'utf8')) as { extensionLogs: Record<string, string> };
  expect(diagnostics.extensionLogs).toEqual({
    '20261108T015857/main.log': 'Main debug context',
    '2026-11-08T01:58:57/main.log': 'Extended ISO context',
    '20261108T015857/window1/renderer.log': 'Renderer debug context',
    '20261108T015857/window1/exthost/exthost.log': 'Extension host context',
    '20261108T015857/window1/output/Your Turn.log': 'Extension context',
  });
  for (const path of state.paths) { expect(existsSync(path)).toBe(false); }
});

it('preserves launch failure and removes directories before an application handle exists', async () => {
  const state = await fixture({ launchFailure: true, detachedDescendant: true });

  await expect(state.run(async () => {})).rejects.toBe(state.setupError);

  expect(state.closed()).toBe(true);
  for (const path of state.paths) { expect(existsSync(path)).toBe(false); }
});

it('real Playwright launch failure contains a detached descendant before returning', async () => {
  const { _electron } = await vi.importActual<typeof import('@playwright/test')>('@playwright/test');
  const directory = await mkdtemp(join(tmpdir(), 'ui-launch-failure-'));
  const ready = join(directory, 'ready');
  const release = join(directory, 'release');
  const status = join(directory, 'status');
  const executable = join(directory, 'launch');
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000);`;
  const workload = `
    const fs = require('node:fs');
    require('node:inspector').open(0);
    const watcher = fs.watch(${JSON.stringify(directory)}, () => {
      if (fs.existsSync(${JSON.stringify(release)})) { watcher.close(); process.stderr.write('Unable to open X display\\n'); }
    });
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { detached: true, stdio: 'ignore' });
  `;
  await writeFile(executable, '#!/bin/sh\nexec /bin/sh "$UI_WRAPPER" -e "$UI_WORKLOAD"\n', { mode: 0o755 });
  const watcher = watch(directory);
  const started = new Promise<void>((resolveReady) => {
    watcher.on('change', () => { if (existsSync(ready)) { resolveReady(); } });
  });
  onTestFinished(async () => {
    watcher.close();
    const contents = await readFile(status, 'utf8').catch(() => '');
    if (contents) {
      const pid = (JSON.parse(contents.split('\n')[0] ?? '') as { 'child-pid': number })['child-pid'];
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { throw error; } }
    }
    await rm(directory, { recursive: true, force: true });
  });
  const launch = _electron.launch({
    executablePath: executable, timeout: 10_000,
    env: { ...process.env, UI_WRAPPER: resolve('tests/ui/electron.sh'), UI_WORKLOAD: workload, UI_EXECUTABLE: process.execPath, UI_STATUS: status },
  });
  const rejected = expect(launch).rejects.toThrow();
  await Promise.race([started, launch.then(() => { throw new Error('Unexpected successful launch'); })]);
  const namespace = (JSON.parse((await readFile(status, 'utf8')).split('\n')[0] ?? '') as { 'child-pid': number })['child-pid'];
  const application = (await readFile(`/proc/${namespace}/task/${namespace}/children`, 'utf8')).trim().split(/\s+/)[0];
  expect(application).toMatch(/^\d+$/);
  assert(application !== undefined);
  const descendantPid = (await readFile(`/proc/${application}/task/${application}/children`, 'utf8')).trim();
  expect(descendantPid).toMatch(/^\d+$/);
  await writeFile(release, '');
  await rejected;
  const remaining = await readFile(`/proc/${descendantPid}/stat`, 'utf8').catch((error: unknown) => {
    if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) { throw error; }
    return undefined;
  });
  if (remaining) { expect(remaining.slice(remaining.lastIndexOf(')') + 2).split(' ')[0]).toBe('Z'); }
});

it('falls back to the contained launch group when namespace status is unreadable', async () => {
  const state = await fixture({ statusFailure: true, closeFailure: true, detachedDescendant: true });

  await expect(state.run(async () => {})).rejects.toBe(state.closeError);

  expect(state.closed()).toBe(true);
  expect(await state.descendantRunning()).toBe(false);
  for (const path of state.paths) { expect(existsSync(path)).toBe(false); }
});

it('terminates descendants that created their own process group', async () => {
  const state = await fixture({ closeFailure: true, detachedDescendant: true });

  await expect(state.run(async () => {})).rejects.toBe(state.closeError);

  expect(state.closed()).toBe(true);
  expect(await state.descendantRunning()).toBe(false);
  for (const path of state.paths) { expect(existsSync(path)).toBe(false); }
});

it.each(['diagnostics', 'trace', 'close'] as const)('the teardown watchdog releases unresponsive %s and awaits process closure', async (hang) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const state = await fixture({ hang });
  const failure = new Error('test failure before teardown');
  const result = expect(state.run(async () => { throw failure; })).rejects.toBe(failure);
  await state.blocked;
  state.child.stdout?.emit('data', 'output while teardown is blocked');

  expect(state.closed()).toBe(false);
  for (const path of state.paths) { expect(existsSync(path)).toBe(true); }
  await vi.advanceTimersByTimeAsync(5000);
  await result;

  expect(state.closed()).toBe(true);
  const diagnostics = JSON.parse(await readFile(join(state.directory, 'diagnostics.json'), 'utf8')) as { extensionLogs: Record<string, string> };
  expect(diagnostics.extensionLogs['20261108T015857/main.log']).toBe('Main debug context');
  const lifecycle = diagnostics as typeof diagnostics & RecordedDiagnostics;
  expect(lifecycle.stdout).toEqual({ text: 'output while teardown is blocked', truncated: false });
  expect(lifecycle.stderr).toEqual({ text: '', truncated: false });
  expect(lifecycle.timeline.find(({ event }) => event === 'process exited')).toMatchObject({ phase: 'cleanup', code: 137, signal: null });
  expect(await state.descendantRunning()).toBe(false);
  for (const path of state.paths) { expect(existsSync(path)).toBe(false); }
});
