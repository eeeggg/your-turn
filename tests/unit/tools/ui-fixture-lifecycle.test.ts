import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';

it('real fixture teardown aborts held controls before Electron close, including setup and acknowledgment failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ui-fixture-lifecycle-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await cp(resolve('tools'), join(root, 'tools'), { recursive: true });
  await cp(resolve('tests/ui'), join(root, 'tests/ui'), { recursive: true, filter: (path) => !path.endsWith('.test.ts') });
  await cp(resolve('tsconfig.json'), join(root, 'tsconfig.json'));
  await symlink(resolve('node_modules'), join(root, 'node_modules'));
  const { scripts } = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { scripts: Record<string, string> };
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts }));
  await writeFile(join(root, 'esbuild.mjs'), '');
  await writeFile(join(root, 'tools/vscode-test.mjs'), 'export async function prepareVSCode() { return "/unused-editor"; }');
  await mkdir(join(root, 'test-results/ui-extension'), { recursive: true });
  await writeFile(join(root, 'test-results/ui-extension/package.json'), JSON.stringify({ name: 'your-turn', publisher: 'eeeggg', main: './dist/extension.js', yourTurnDesktopTest: true }));
  await writeFile(join(root, 'playwright.config.mts'), `
import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: 'tests/ui', workers: 1, retries: 0, timeout: 1500,
  reporter: [['json', { outputFile: 'report.json' }]], outputDir: 'test-results/lifecycle' });
`);
  await writeFile(join(root, 'tests/ui/lifecycle.test.ts'), `
import { EventEmitter } from 'node:events';
import { appendFile } from 'node:fs/promises';
import { _electron } from '@playwright/test';
import { test, expect } from './window';
import { connectControl } from './instrumentation/ControlChannel';
import { SchedulingControl } from './instrumentation/SchedulingControl';
const record = async (event: string) => appendFile('events.jsonl', JSON.stringify({ scenario, event }) + '\\n');
let scenario = '';
let abortSeen: Promise<void>;
let scheduling: SchedulingControl;
let client: ReturnType<typeof connectControl>;
let lifetime: AbortSignal;
let delivery: Promise<number>;
let dependentTornDown = false;
let commandEntered: Promise<void>;
const owned = test.extend<{ ownership: void }>({
  display: async ({}, use) => { await use(undefined); },
  ownership: [async ({ treeRefresh }, use) => {
    dependentTornDown = false;
    try { await use(); } finally { dependentTornDown = true; await record('dependent teardown'); }
  }, { auto: true }],
});
owned.use({ controlledTreeRefresh: true });
_electron.launch = async (options) => {
  let entered!: () => void;
  commandEntered = new Promise<void>((resolve) => { entered = resolve; });
  let aborted!: () => void;
  abortSeen = new Promise<void>((resolve) => { aborted = resolve; });
  scheduling = new SchedulingControl();
  client = connectControl(Number(options.env.UI_TREE_REFRESH_PORT), async (command, signal) => {
    lifetime = signal;
    if (command === 'hold') {
      scheduling.arm(signal);
      signal.addEventListener('abort', aborted, { once: true });
      if (scenario !== 'acknowledgment') { delivery = scheduling.hold(() => 31); }
      entered();
      await scheduling.waitForEntry();
      return 'pending';
    }
    throw new Error('Unexpected command');
  });
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  const page = Object.assign(new EventEmitter(), {
    isClosed: () => false, screenshot: async () => {},
    locator: () => ({ evaluate: async () => '<body/>' }),
    evaluate: async () => ({}), getByRole: () => ({ waitFor: async () => {} }),
  });
  const application = Object.assign(new EventEmitter(), {
    process: () => child,
    firstWindow: async () => {
      if (scenario === 'setup') {
        // Enter the same scheduling command during setup, before fixture use().
        await commandEntered;
        throw new Error('intentional setup failure');
      }
      return page;
    },
    evaluate: async () => [],
    context: () => ({ tracing: { start: async () => {}, stop: async () => {} } }),
    close: async () => {
      // Local closure rejects requests immediately; remote abort is delivered asynchronously.
      expect(dependentTornDown).toBe(false);
      await abortSeen;
      expect(lifetime.aborted).toBe(true);
      if (delivery) { expect(await delivery).toBe(31); }
      await record('application close after abort');
      client.close();
      child.emit('close');
    },
  });
  return application as never;
};
// Force setup to have an accepted command before firstWindow throws.
const setupOwned = owned.extend({
  treeRefresh: async ({ treeRefresh }, use, info) => {
    scenario = info.title;
    delivery = undefined;
    if (scenario === 'setup') {
      const pending = treeRefresh.hold();
      void pending.catch(() => {});
      await use(treeRefresh);
      await expect(pending).rejects.toThrow(/closed/);
    } else { await use(treeRefresh); }
  },
});
setupOwned('normal', async ({ window, treeRefresh }) => { await treeRefresh.hold(); });
setupOwned('setup', async ({ window }) => { throw new Error('Unexpected body'); });
setupOwned('acknowledgment', async ({ window, treeRefresh }) => { await treeRefresh.hold(); });
`);
  const npm = process.env['npm_execpath'];
  if (!npm) { throw new Error('Run lifecycle tests through npm'); }
  const child = spawn(process.execPath, [npm, 'run', 'test:ui:only', '--', 'tests/ui/lifecycle.test.ts'], {
    cwd: root, env: { ...process.env, CI: 'true', TEST_FILES: '', TEST_JOBS: '', TEST_DISPLAY: '', FILES: '', REPEAT: '', JOBS: '' },
  });
  onTestFinished(() => { if (child.exitCode === null) { child.kill('SIGKILL'); } });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (text: string) => { output += text; });
  child.stderr.setEncoding('utf8').on('data', (text: string) => { output += text; });
  const code = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', done); });
  expect(code, output).toBe(1);
  const report = JSON.parse(await readFile(join(root, 'report.json'), 'utf8')) as {
    suites: { specs: { title: string; tests: { results: { status: string; errors: { message: string }[] }[] }[] }[] }[];
  };
  const results = report.suites.flatMap((suite) => suite.specs).map((spec) => ({ title: spec.title, ...spec.tests[0]?.results[0] }));
  expect(results.map(({ title, status }) => [title, status]), output).toEqual([
    ['normal', 'passed'], ['setup', 'failed'], ['acknowledgment', 'timedOut'],
  ]);
  expect(results[1]?.errors?.[0]?.message).toContain('intentional setup failure');
  expect(await readFile(join(root, 'events.jsonl'), 'utf8')).toBe(
    ['normal', 'setup', 'acknowledgment'].flatMap((scenario) => [
      JSON.stringify({ scenario, event: 'application close after abort' }),
      JSON.stringify({ scenario, event: 'dependent teardown' }),
    ]).join('\n') + '\n',
  );
}, 30_000);
