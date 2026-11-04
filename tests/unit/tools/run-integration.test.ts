import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { assert, expect, it, onTestFinished } from 'vitest';

interface JobEvent {
  event: string;
  group: string;
  leader: number;
  config: string;
  profile: string;
  files: string[];
  workspaceFolder: string | null;
  /** Whether the job's folder existed when its window started; null for a window with no folder. */
  folderExisted: boolean | null;
  version: string;
  executable: string;
  display: string | undefined;
  descendant?: number;
  /** What the window was given to open, as it was when the window started, with the folders a workspace file lists. */
  opened: { path: string; existed: boolean; folders: { path: string; existed: boolean }[] | null }[];
}

/** Compiled tests: two for the folder window, one for the window with no folder. */
const TESTS = ['alpha.test.js', 'beta.test.js', 'empty/gamma.test.js'];

interface RunnerOptions {
  coverage?: boolean;
  failGroup?: string;
  throughCoordinator?: boolean;
  jobs?: number | null;
  display?: string;
  xvfb?: boolean;
  resourceFailure?: boolean;
  selectedFiles?: string;
  zeroTests?: boolean;
  displayPolicy?: string;
  blockedSetup?: 'display' | 'editor';
  disconnectedDescendant?: boolean;
  /** Jobs report and finish at once instead of running until they are stopped. */
  finishAtOnce?: boolean;
  tests?: string[];
}

async function launchRunner({ coverage = false, failGroup = '', throughCoordinator = true, jobs = 2, finishAtOnce = coverage, tests = TESTS, display = '', xvfb = true, resourceFailure = false, selectedFiles, zeroTests = false, displayPolicy, blockedSetup, disconnectedDescendant = false }: RunnerOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'integration-runner-test-'));
  const events: JobEvent[] = [];
  const changed = new EventEmitter();
  let output = '';
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, 'tools'));
  if (displayPolicy) { await writeFile(join(root, '.env.test.local'), `TEST_DISPLAY=${displayPolicy}\n`); }
  await mkdir(join(root, 'dist', 'test'), { recursive: true });
  await cp(resolve(import.meta.dirname, '../../../tools/run-integration.mjs'), join(root, 'tools', 'run-integration.mjs'));
  await cp(resolve(import.meta.dirname, '../../../tools/run-tests.mjs'), join(root, 'tools', 'run-tests.mjs'));
  await cp(resolve(import.meta.dirname, '../../../tools/integration-windows.mjs'), join(root, 'tools', 'integration-windows.mjs'));
  const editorSetup = resolve(import.meta.dirname, '../../../tools/vscode-test.mjs');
  if (existsSync(editorSetup)) { await cp(editorSetup, join(root, 'tools', 'vscode-test.mjs')); }
  await writeFile(join(root, 'package.json'), '{"version":"0.0.0"}');
  await writeFile(join(root, '.vscode-test.mjs'), `export default { coverage: { include: [${JSON.stringify(join(root, 'dist/**'))}], exclude: [], reporter: ['text', 'html'] } };`);
  for (const test of tests) {
    await mkdir(dirname(join(root, 'dist', 'test', test)), { recursive: true });
    await writeFile(join(root, 'dist', 'test', test), '');
  }
  const cli = join(root, 'node_modules', '@vscode', 'test-cli', 'out', 'bin.mjs');
  await mkdir(dirname(cli), { recursive: true });
  const downloader = join(root, 'node_modules', '@vscode', 'test-electron');
  await mkdir(downloader, { recursive: true });
  await writeFile(join(downloader, 'package.json'), JSON.stringify({ main: 'index.cjs' }));
  const blocked = `
    process.on('SIGTERM', () => {});
    console.log(JSON.stringify({ event: 'setup-ready', leader: process.pid, profile: ${JSON.stringify(join(root, 'setup-profile'))} }));
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  `;
  await writeFile(join(downloader, 'index.cjs'), `
exports.downloadAndUnzipVSCode = async (options) => {
  const fs = require('node:fs');
  if (!fs.existsSync(options.cachePath)) throw new Error('Cache parent was not prepared');
  fs.appendFileSync('downloads.jsonl', JSON.stringify(options) + '\\n');
  ${blockedSetup === 'editor' ? blocked : ''}
  return '/prepared-vscode';
};
`);
  const preload = join(root, 'resource-check.cjs');
  await writeFile(preload, `
const fs = require('node:fs/promises');
const original = fs.readFile;
const originalReaddir = fs.readdir;
fs.readdir = (...args) => args[0] === '/proc' ? Promise.resolve([]) : originalReaddir(...args);
fs.readFile = (...args) => {
  if (args[0] === '/proc/sys/fs/inotify/max_user_instances') {
    if (${String(resourceFailure)}) throw new Error('resource probe unavailable');
    return Promise.resolve('8192');
  }
  return original(...args);
};
require('node:module').syncBuiltinESMExports();
`);
  const descendant = `
    const { watch, existsSync } = require('node:fs');
    const details = JSON.parse(process.env.JOB_DETAILS);
    process.on('SIGTERM', () => {
      const gate = 'release-' + details.group;
      const watcher = watch(process.cwd(), (_event, file) => {
        if (file === gate && existsSync(gate)) {
          watcher.close();
          process.exit(0);
        }
      });
      console.log(JSON.stringify({ ...details, event: 'stopping' }));
    });
    console.log(JSON.stringify({ ...details, event: 'ready' }));
    setInterval(() => {}, 1000);
  `;
  await writeFile(cli, `
    import { spawn } from 'node:child_process';
    import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
    import { pathToFileURL } from 'node:url';
    const config = process.argv[process.argv.indexOf('--config') + 1];
    const settings = (await import(pathToFileURL(config).href)).default;
    const output = process.argv[process.argv.indexOf('--coverage-output') + 1];
    if (process.argv.includes('--coverage')) {
      mkdirSync(output, { recursive: true });
      writeFileSync(output + '/index.html', '<html>coverage</html>');
      writeFileSync(output + '/config.json', JSON.stringify(settings));
    }
    const [test] = settings.tests;
    const profile = test.launchArgs[0].slice('--user-data-dir='.length);
    mkdirSync(profile, { recursive: true });
    const workspaceFolder = test.workspaceFolder ?? null;
    const paths = [...test.launchArgs.filter((arg) => !arg.startsWith('--')), ...(workspaceFolder === null ? [] : [workspaceFolder])];
    const opened = paths.map((path) => ({
      path,
      existed: existsSync(path),
      folders: path.endsWith('.code-workspace') && existsSync(path)
        ? JSON.parse(readFileSync(path, 'utf8')).folders.map(({ path }) => ({ path, existed: existsSync(path) }))
        : null,
    }));
    const details = {
      group: process.env.VSCODE_TEST_GROUP, leader: process.pid, config, profile, files: test.files, workspaceFolder,
      folderExisted: workspaceFolder === null ? null : existsSync(workspaceFolder), opened,
      version: test.version, executable: test.useInstallation?.fromPath, display: process.env.DISPLAY,
    };
    if (!existsSync('downloads.jsonl')) throw new Error('Editor setup did not finish before jobs');
    if (${String(disconnectedDescendant)}) {
      const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000);'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child.once('message', () => {
        console.log(JSON.stringify({ ...details, event: 'disconnected', descendant: child.pid }));
        console.log('1 passing');
        process.exit(0);
      });
    } else if (process.env.FINISH_AT_ONCE === '1') {
      console.log(JSON.stringify({ ...details, event: 'finished' }));
      console.log(process.env.ZERO_TESTS === '1' ? '0 passing' : '1 passing');
      process.exitCode = process.env.FAIL_GROUP === process.env.VSCODE_TEST_GROUP || (process.env.ZERO_TESTS === '1' && process.argv.includes('--fail-zero')) ? 1 : 0;
    } else { spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, JOB_DETAILS: JSON.stringify(details) },
    }); }
  `);
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'xvfb-run'), xvfb
    ? '#!/bin/sh\nshift\nexport DISPLAY=:777\nexec "$@"\n'
    : '#!/bin/sh\necho "Xvfb unavailable" >&2\nexit 1\n', { mode: 0o755 });
  if (blockedSetup === 'display') {
    await writeFile(join(bin, 'xvfb-run'), `#!/usr/bin/env node\n(async () => { ${blocked} })();\n`, { mode: 0o755 });
  }
  for (const tool of ['node_modules/typescript/bin/tsc', 'node_modules/eslint/bin/eslint.js', 'node_modules/knip/bin/knip.js', 'esbuild.mjs']) {
    await mkdir(dirname(join(root, tool)), { recursive: true });
    await writeFile(join(root, tool), 'process.exitCode = 0;');
  }
  const runner = spawn(process.execPath, throughCoordinator
    ? [join(root, 'tools', 'run-tests.mjs'), coverage ? 'coverage:integration' : 'test:integration', ...(jobs === null ? [] : ['--jobs', String(jobs)]), '--repeat', String(coverage ? 2 : 1)]
    : [join(root, 'tools', 'run-integration.mjs')], {
    cwd: root,
    env: { ...process.env, CI: '', FILES: '', REPEAT: '', JOBS: '', PATH: bin + delimiter + (process.env['PATH'] ?? ''), DISPLAY: display, NODE_OPTIONS: `--require=${preload}`, TEST_DISPLAY: '', TEST_JOBS: throughCoordinator || jobs === null ? '' : String(jobs), TEST_FILES: throughCoordinator ? '' : selectedFiles ?? TESTS.join(','), FINISH_AT_ONCE: finishAtOnce ? '1' : '', FAIL_GROUP: failGroup, ZERO_TESTS: zeroTests ? '1' : '' },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClosed) => {
    runner.once('close', (code, signal) => { resolveClosed({ code, signal }); });
  });
  const lines = createInterface({ input: runner.stdout });
  lines.on('line', (line) => {
    output += line + '\n';
    const start = line.indexOf('{');
    if (start !== -1) {
      events.push(JSON.parse(line.slice(start)) as JobEvent);
      changed.emit('record');
    }
  });
  runner.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
  onTestFinished(async () => {
    try {
      for (const leader of new Set(events.map((event) => event.leader))) {
        try { process.kill(-leader, 'SIGKILL'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { throw error; }
        }
      }
      for (const event of events) {
        const pid = event.descendant;
        if (pid !== undefined) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { throw error; } } }
      }
      if (runner.pid !== undefined && runner.exitCode === null && runner.signalCode === null) {
        process.kill(-runner.pid, 'SIGKILL');
      }
      await closed;
      await Promise.all([...new Set(events.map((event) => dirname(event.profile)))].map((profile) => rm(profile, { recursive: true, force: true })));
    } finally {
      lines.close();
    }
  });
  const observe = (name: string) => new Promise<JobEvent[]>((resolveObserved, reject) => {
    const check = () => {
      const matching = events.filter((event) => event.event === name);
      if (matching.length === jobs) {
        cleanup();
        resolveObserved(matching);
      }
    };
    const exited = () => {
      cleanup();
      reject(new Error(`Runner exited before all ${jobs ?? 1} jobs reported ${name}:\n${output}`));
    };
    const cleanup = () => {
      changed.off('record', check);
      runner.off('exit', exited);
    };
    changed.on('record', check);
    runner.once('exit', exited);
    check();
    if (runner.exitCode !== null || runner.signalCode !== null) { exited(); }
  });
  return { root, runner, closed, observe, events, output: () => output };
}

it.each([
  ['SIGINT', false, { code: 130, signal: null }],
  ['SIGTERM', false, { code: 143, signal: null }],
  ['SIGINT', true, { code: 130, signal: null }],
  ['SIGTERM', true, { code: 143, signal: null }],
] as const)(
  '%s stops every isolated job and awaits descendants before removing their profiles (coordinator entry: %s)',
  async (signal, throughCoordinator, expected) => {
    const { root, runner, closed, observe, output } = await launchRunner({ throughCoordinator });
    const ready = await observe('ready');

    if (runner.pid !== undefined) { process.kill(-runner.pid, signal); }
    await observe('stopping');

    expect(runner.exitCode).toBeNull();
    expect(runner.signalCode).toBeNull();
    for (const job of ready) {
      expect(existsSync(job.config)).toBe(true);
      expect(existsSync(job.profile)).toBe(true);
    }
    await Promise.all(ready.map((job) => writeFile(join(root, `release-${job.group}`), '')));

    const result = await closed;
    expect(result).toEqual(expected);
    if (throughCoordinator) {
      expect(output()).toContain('Integration run interrupted; isolated jobs have closed');
    }
    for (const job of ready) {
      expect(existsSync(dirname(job.config))).toBe(false);
      expect(existsSync(dirname(job.profile))).toBe(false);
    }
  },
);

async function expectStopped(pid: number) {
  const status = await readFile(`/proc/${pid}/status`, 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return ''; }
    throw error;
  });
  expect(status === '' || /^State:\s+Z/m.test(status), status).toBe(true);
}

it.each(['display', 'editor'] as const)('bounds cancellation during blocked %s preparation', { timeout: 15000 }, async (blockedSetup) => {
  const { runner, closed, observe, events, output } = await launchRunner({ jobs: 1, blockedSetup });
  const setup = await observe('setup-ready');
  runner.kill('SIGTERM');
  expect(await closed, output()).toEqual({ code: 143, signal: null });
  for (const { leader } of setup) { await expectStopped(leader); }
  expect(events.some(({ event }) => event === 'ready')).toBe(false);
});

it('terminates disconnected descendants after a successful CLI exit', async () => {
  const { closed, events, output } = await launchRunner({ jobs: 1, disconnectedDescendant: true });
  expect((await closed).code, output()).toBe(0);
  expect(events).toHaveLength(2);
  for (const event of events) {
    assert(event.descendant !== undefined);
    await expectStopped(event.descendant);
  }
});

it('force-stops descendants that do not finish after SIGTERM', { timeout: 15000 }, async () => {
  const { runner, closed, observe } = await launchRunner();
  const ready = await observe('ready');

  if (runner.pid !== undefined) { process.kill(-runner.pid, 'SIGTERM'); }
  await observe('stopping');

  expect(await closed).toEqual({ code: 143, signal: null });
  for (const job of ready) {
    expect(existsSync(dirname(job.config))).toBe(false);
    expect(existsSync(dirname(job.profile))).toBe(false);
  }
});

it.each(['', '2'])('preserves separate coverage reports and job mapping when failed group is %s', async (failGroup) => {
  const { root, closed } = await launchRunner({ coverage: true, failGroup });
  expect((await closed).code).toBe(failGroup ? 1 : 0);
  const reports = join(root, 'test-results/integration/coverage');
  const runs = await readdir(reports);
  expect(runs).toHaveLength(failGroup ? 1 : 2);
  for (const directory of runs) {
    const run = join(reports, directory);
    const jobs = JSON.parse(await readFile(join(run, 'jobs.json'), 'utf8')) as { files: string[]; window: string; report: string }[];
    expect(jobs.map(({ files, window }) => ({ files, window }))).toEqual([
      { files: ['alpha.test.js', 'beta.test.js'], window: 'folder' },
      { files: ['empty/gamma.test.js'], window: 'empty' },
    ]);
    expect(new Set(jobs.map((job) => job.report)).size).toBe(2);
    for (const job of jobs) {
      expect(await readFile(join(run, job.report), 'utf8')).toBe('<html>coverage</html>');
      const config = JSON.parse(await readFile(join(run, dirname(job.report), 'config.json'), 'utf8')) as { coverage: unknown; tests: { mocha: { timeout: number }; workspaceFolder?: string }[] };
      expect(config.coverage).toEqual({ include: [join(root, 'dist/**')], exclude: [], reporter: ['text', 'html'] });
      expect(config.tests[0]?.mocha.timeout).toBe(0);
      expect(config.tests[0]?.workspaceFolder !== undefined).toBe(job.window === 'folder');
    }
  }
});

/** Each job's files, relative to the compiled tests, and the folder its window opened. */
function jobsOf(root: string, finished: JobEvent[]) {
  return finished
    .map(({ files, workspaceFolder, folderExisted }) => ({ files: files.map((file) => relative(join(root, 'dist', 'test'), file)), workspaceFolder, folderExisted }))
    .sort((a, b) => (a.files[0] ?? '').localeCompare(b.files[0] ?? ''));
}

it("keeps workspace groups fixed when requesting more workers than workspace kinds", async () => {
  const { root, closed, events, output } = await launchRunner({ jobs: 3, finishAtOnce: true });

  expect((await closed).code, output()).toBe(0);
  const jobs = jobsOf(root, events);
  expect(jobs.map(({ files, folderExisted }) => ({ files, folderExisted }))).toEqual([
    { files: ['alpha.test.js', 'beta.test.js'], folderExisted: true },
    { files: ['empty/gamma.test.js'], folderExisted: null },
  ]);
  const folders = jobs.filter(({ workspaceFolder }) => workspaceFolder !== null).map(({ workspaceFolder }) => workspaceFolder);
  expect(new Set(folders).size).toBe(1);
  for (const folder of folders) {
    assert(folder);
    expect(relative(root, folder).startsWith('..')).toBe(true);
    expect(existsSync(folder)).toBe(false);
  }
});

it("builds each job's fresh folders before its window starts, opening two as an unsaved workspace or through a workspace file it writes", async () => {
  const tests = [...TESTS, 'untitled-workspace/delta.test.js', 'saved-workspace/epsilon.test.js'];
  const { root, closed, events, output } = await launchRunner({ jobs: 4, finishAtOnce: true, tests });

  expect((await closed).code, output()).toBe(0);
  const jobs = events
    .map(({ files, workspaceFolder, opened }) => ({
      files: files.map((file) => relative(join(root, 'dist', 'test'), file)),
      workspaceFolder: workspaceFolder !== null,
      opened: opened.map(({ path, existed, folders }) => ({ file: path.endsWith('.code-workspace'), existed, folders: folders?.map((folder) => folder.existed) ?? null })),
    }))
    .sort((a, b) => (a.files[0] ?? '').localeCompare(b.files[0] ?? ''));
  const folder = { file: false, existed: true, folders: null };
  expect(jobs).toEqual([
    { files: ['alpha.test.js', 'beta.test.js'], workspaceFolder: true, opened: [folder] },
    { files: ['empty/gamma.test.js'], workspaceFolder: false, opened: [] },
    { files: ['saved-workspace/epsilon.test.js'], workspaceFolder: true, opened: [{ file: true, existed: true, folders: [true, true] }] },
    { files: ['untitled-workspace/delta.test.js'], workspaceFolder: false, opened: [folder, folder] },
  ]);
  const paths = events.flatMap(({ opened }) => opened.flatMap(({ path, folders }) => [path, ...(folders ?? []).map((listed) => listed.path)]));
  expect(new Set(paths).size).toBe(6);
  for (const path of paths) {
    expect(relative(root, path).startsWith('..')).toBe(true);
    expect(existsSync(path)).toBe(false);
  }
});

it('runs at most JOBS windows at once, even with fewer jobs than window kinds', async () => {
  const { root, closed, events, output } = await launchRunner({ jobs: 1, finishAtOnce: true });

  expect((await closed).code, output()).toBe(0);
  expect(jobsOf(root, events).map(({ files }) => files)).toEqual([['alpha.test.js', 'beta.test.js'], ['empty/gamma.test.js']]);
  const lines = output().split('\n');
  const firstPassed = lines.findIndex((line) => line.startsWith('[integration 1] 1 passing'));
  const secondStarted = lines.findIndex((line) => line.startsWith('[integration 2] Starting'));
  expect(firstPassed).toBeGreaterThan(-1);
  expect(secondStarted).toBeGreaterThan(firstPassed);
});

it('rejects compiled tests in a directory that is no window kind, before starting any window', async () => {
  const { closed, events, output } = await launchRunner({ finishAtOnce: true, tests: [...TESTS, 'other/delta.test.js'] });

  expect((await closed).code).not.toBe(0);
  expect(output()).toContain('other/delta.test.js');
  expect(events).toEqual([]);
});

it('runs every workspace shape serially by default without acceleration probes', async () => {
  const tests = [...TESTS, 'untitled-workspace/delta.test.js', 'saved-workspace/epsilon.test.js'];
  const { root, closed, events, output } = await launchRunner({ jobs: null, finishAtOnce: true, resourceFailure: true, tests });
  expect((await closed).code, output()).toBe(0);
  expect(events.map(({ files }) => files.map((file) => relative(join(root, 'dist/test'), file)))).toEqual([
    ['alpha.test.js', 'beta.test.js'], ['empty/gamma.test.js'], ['untitled-workspace/delta.test.js'], ['saved-workspace/epsilon.test.js'],
  ]);
  expect(output()).toContain('at most 1 at once');
  const lines = output().split('\n');
  for (let group = 2; group <= 4; group += 1) {
    expect(lines.findIndex((line) => line.startsWith(`[integration ${group}] Starting`)))
      .toBeGreaterThan(lines.findIndex((line) => line.startsWith(`[integration ${group - 1}] 1 passing`)));
  }
});

it('prepares the pinned editor once before jobs on a clean checkout', async () => {
  const { root, closed, events, output } = await launchRunner({ finishAtOnce: true });
  expect((await closed).code, output()).toBe(0);
  expect((await readFile(join(root, 'downloads.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as unknown)).toEqual([
    { version: '1.144.1', cachePath: join(root, '.vscode-test') },
  ]);
  expect(events).toHaveLength(2);
  for (const event of events) {
    expect(event.version).toBe('1.144.1');
    expect(event.executable).toBe('/prepared-vscode');
  }
});

it('uses an existing display for serial execution without Xvfb', async () => {
  const { closed, events, output } = await launchRunner({ jobs: null, finishAtOnce: true, display: ':88', xvfb: false });
  expect((await closed).code, output()).toBe(0);
  expect(events.map(({ display }) => display)).toEqual([':88', ':88']);
});

it('falls back before launch when parallel displays are unavailable but a serial display exists', async () => {
  const { closed, events, output } = await launchRunner({ finishAtOnce: true, display: ':88', xvfb: false });
  expect((await closed).code, output()).toBe(0);
  expect(output()).toContain('falling back to serial');
  expect(output().indexOf('falling back to serial')).toBeLessThan(output().indexOf('[integration 1] Starting'));
  expect(events.map(({ display }) => display)).toEqual([':88', ':88']);
});

it('honors explicit concurrency without resource detection', async () => {
  const { closed, events, output } = await launchRunner({ finishAtOnce: true, resourceFailure: true });
  expect((await closed).code, output()).toBe(0);
  expect(output()).not.toContain('resource probe unavailable');
  expect(output()).not.toContain('falling back to serial');
  expect(output()).toContain('at most 2 at once');
  expect(events).toHaveLength(2);
});

it('prefers owned Xvfb over an SSH-forwarded display even in serial mode', async () => {
  const { closed, events, output } = await launchRunner({ jobs: null, finishAtOnce: true, display: 'localhost:10.0' });
  expect((await closed).code, output()).toBe(0);
  expect(events.map(({ display }) => display)).toEqual([':777', ':777']);
});

it('required Xvfb fails before launch rather than falling back to the desktop', async () => {
  const { closed, events, output } = await launchRunner({ finishAtOnce: true, display: ':88', xvfb: false, displayPolicy: 'xvfb' });
  expect((await closed).code).not.toBe(0);
  expect(output()).toContain('Xvfb');
  expect(events).toEqual([]);
});

it('existing-display policy deliberately serializes without launching Xvfb', async () => {
  const { closed, events, output } = await launchRunner({ finishAtOnce: true, display: ':88', displayPolicy: 'existing' });
  expect((await closed).code, output()).toBe(0);
  expect(output()).toContain('at most 1 at once');
  expect(events.map(({ display }) => display)).toEqual([':88', ':88']);
});

it('reports missing baseline display support without starting any jobs', async () => {
  const { closed, events, output } = await launchRunner({ jobs: null, finishAtOnce: true, xvfb: false });
  expect((await closed).code).not.toBe(0);
  expect(output()).toContain('DISPLAY');
  expect(output()).toContain('Xvfb');
  expect(events).toEqual([]);
});

it('rejects a partially unmatched compiled selection before launch', async () => {
  const { closed, events, output } = await launchRunner({ throughCoordinator: false, finishAtOnce: true, selectedFiles: 'alpha.test.js,missing.test.js' });
  expect((await closed).code).not.toBe(0);
  expect(output()).toContain('missing.test.js');
  expect(events).toEqual([]);
});

it('fails zero-test jobs without retrying serially', async () => {
  const { closed, events, output } = await launchRunner({ finishAtOnce: true, zeroTests: true });
  expect((await closed).code).toBe(1);
  expect(events).toHaveLength(2);
  expect(output()).not.toContain('falling back to serial');
});
