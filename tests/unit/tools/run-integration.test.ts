import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { expect, it, onTestFinished } from 'vitest';

interface JobEvent {
  event: string;
  group: string;
  leader: number;
  config: string;
  profile: string;
}

async function launchRunner(coverage = false, failGroup = '', throughMake = true) {
  const root = await mkdtemp(join(tmpdir(), 'acp-runner-test-'));
  const events: JobEvent[] = [];
  const changed = new EventEmitter();
  let output = '';
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, 'tools'));
  await mkdir(join(root, '.vscode-test'));
  await mkdir(join(root, 'dist', 'test'), { recursive: true });
  await cp(resolve(import.meta.dirname, '../../../tools/run-integration.mjs'), join(root, 'tools', 'run-integration.mjs'));
  await cp(resolve(import.meta.dirname, '../../../tools/run-tests.mjs'), join(root, 'tools', 'run-tests.mjs'));
  await cp(resolve(import.meta.dirname, '../../../Makefile'), join(root, 'Makefile'));
  await writeFile(join(root, 'package.json'), '{"version":"0.0.0"}');
  await writeFile(join(root, '.vscode-test.mjs'), `export default { coverage: { include: [${JSON.stringify(join(root, 'dist/**'))}], exclude: [], reporter: ['text', 'html'] } };`);
  await Promise.all(['alpha', 'beta'].map((name) => writeFile(join(root, 'dist', 'test', `${name}.test.js`), '')));
  const cli = join(root, 'node_modules', '@vscode', 'test-cli', 'out', 'bin.mjs');
  await mkdir(dirname(cli), { recursive: true });
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
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { pathToFileURL } from 'node:url';
    const config = process.argv[process.argv.indexOf('--config') + 1];
    const settings = (await import(pathToFileURL(config).href)).default;
    const output = process.argv[process.argv.indexOf('--coverage-output') + 1];
    if (process.argv.includes('--coverage')) {
      mkdirSync(output, { recursive: true });
      writeFileSync(output + '/index.html', '<html>coverage</html>');
      writeFileSync(output + '/config.json', JSON.stringify(settings));
    }
    const profile = settings.tests[0].launchArgs[0].slice('--user-data-dir='.length);
    mkdirSync(profile, { recursive: true });
    if (process.env.COVERAGE_FIXTURE === '1') {
      console.log('1 passing');
      process.exitCode = process.env.FAIL_GROUP === process.env.VSCODE_TEST_GROUP ? 1 : 0;
    } else { spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, JOB_DETAILS: JSON.stringify({
        group: process.env.VSCODE_TEST_GROUP, leader: process.pid, config, profile,
      }) },
    }); }
  `);
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'xvfb-run'), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o755 });
  await writeFile(join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const runner = spawn(throughMake ? 'make' : process.execPath, throughMake
    ? ['--no-print-directory', coverage ? 'coverage-integration' : 'test-integration', 'JOBS=2', `REPEAT=${coverage ? 2 : 1}`]
    : [join(root, 'tools', 'run-integration.mjs')], {
    cwd: root,
    env: { ...process.env, MAKEFLAGS: '', MFLAGS: '', MAKELEVEL: '', FILES: '', REPEAT: '', JOBS: '', PATH: bin + delimiter + (process.env['PATH'] ?? ''), ACP_TEST_JOBS: throughMake ? '' : '2', ACP_TEST_FILES: throughMake ? '' : 'alpha.test.js,beta.test.js', COVERAGE_FIXTURE: coverage ? '1' : '', FAIL_GROUP: failGroup },
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
      if (matching.length === 2) {
        cleanup();
        resolveObserved(matching);
      }
    };
    const exited = () => {
      cleanup();
      reject(new Error(`Runner exited before both jobs reported ${name}:\n${output}`));
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
  return { root, runner, closed, observe, output: () => output };
}

it.each([
  ['SIGINT', false, { code: 130, signal: null }],
  ['SIGTERM', false, { code: 143, signal: null }],
  ['SIGINT', true, { code: null, signal: 'SIGINT' }],
  ['SIGTERM', true, { code: null, signal: 'SIGTERM' }],
] as const)(
  '%s stops every isolated job and awaits descendants before removing their profiles (Make entry: %s)',
  async (signal, throughMake, expected) => {
    const { root, runner, closed, observe, output } = await launchRunner(false, '', throughMake);
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
    if (throughMake) {
      // Make may report its failed recipe or re-raise the interrupt after waiting for it.
      expect([2, null]).toContain(result.code);
      expect(result.code === null ? result.signal : null).toBe(result.code === null ? signal : null);
      expect(output()).toContain('Integration run interrupted; isolated jobs have closed');
    } else {
      expect(result).toEqual(expected);
    }
    for (const job of ready) {
      expect(existsSync(dirname(job.config))).toBe(false);
      expect(existsSync(dirname(job.profile))).toBe(false);
    }
  },
);

it('force-stops descendants that do not finish after SIGTERM', { timeout: 15000 }, async () => {
  const { runner, closed, observe } = await launchRunner();
  const ready = await observe('ready');

  if (runner.pid !== undefined) { process.kill(-runner.pid, 'SIGTERM'); }
  await observe('stopping');

  expect(await closed).toEqual({ code: null, signal: 'SIGTERM' });
  for (const job of ready) {
    expect(existsSync(dirname(job.config))).toBe(false);
    expect(existsSync(dirname(job.profile))).toBe(false);
  }
});

it.each(['', '2'])('preserves separate coverage reports and job mapping when failed group is %s', async (failGroup) => {
  const { root, closed } = await launchRunner(true, failGroup);
  expect((await closed).code).toBe(failGroup ? 2 : 0);
  const reports = join(root, 'test-results/integration/coverage');
  const runs = await readdir(reports);
  expect(runs).toHaveLength(failGroup ? 1 : 2);
  for (const directory of runs) {
    const run = join(reports, directory);
    const jobs = JSON.parse(await readFile(join(run, 'jobs.json'), 'utf8')) as { files: string[]; report: string }[];
    expect(jobs.flatMap((job) => job.files).sort()).toEqual(['alpha.test.js', 'beta.test.js']);
    expect(new Set(jobs.map((job) => job.report)).size).toBe(2);
    for (const job of jobs) {
      expect(await readFile(join(run, job.report), 'utf8')).toBe('<html>coverage</html>');
      const config = JSON.parse(await readFile(join(run, dirname(job.report), 'config.json'), 'utf8')) as { coverage: unknown; tests: { mocha: { timeout: number } }[] };
      expect(config.coverage).toEqual({ include: [join(root, 'dist/**')], exclude: [], reporter: ['text', 'html'] });
      expect(config.tests[0]?.mocha.timeout).toBe(0);
    }
  }
});
