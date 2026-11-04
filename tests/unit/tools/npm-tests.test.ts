import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';

interface Invocation { command: string; args: string[]; files?: string; jobs?: string; electron?: string; display?: string }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'npm-tests-'));
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });
  await cp(resolve(import.meta.dirname, '../../../tools'), join(root, 'tools'), { recursive: true });
  const { scripts } = JSON.parse(await readFile(resolve(import.meta.dirname, '../../../package.json'), 'utf8')) as { scripts: Record<string, string> };
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.0.0', scripts }));
  const files = [
    'tests/unit/a.test.ts', 'tests/unit/b.test.ts', 'tests/webview/a.test.ts', 'tests/webview/unsupported.test.tsx', 'tests/integration/a.test.ts', 'tests/integration/b.test.ts',
    'tests/integration/empty/c.test.ts', 'tests/integration/other/d.test.ts', 'tests/ui/a.test.ts',
  ];
  for (const file of files) {
    await mkdir(join(root, file, '..'), { recursive: true });
    await writeFile(join(root, file), '');
  }
  const tools = {
    types: 'node_modules/typescript/bin/tsc',
    eslint: 'node_modules/eslint/bin/eslint.js',
    knip: 'node_modules/knip/bin/knip.js',
    bundle: 'esbuild.mjs',
    vitest: 'node_modules/vitest/vitest.mjs',
    playwright: 'node_modules/@playwright/test/cli.js',
    integration: 'tools/run-integration.mjs',
  };
  for (const [command, path] of Object.entries(tools)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), `
import('node:fs').then(({ appendFileSync }) => {
const command = ${JSON.stringify(command)};
const args = process.argv.slice(2);
appendFileSync(process.env.TRACE, JSON.stringify({ command, args, files: process.env.TEST_FILES, jobs: process.env.TEST_JOBS, display: process.env.TEST_DISPLAY || undefined, electron: process.env.ELECTRON_RUN_AS_NODE }) + '\\n');
process.exitCode = process.env.FAIL_COMMAND === command ? 7 : 0;
});
`);
  }
  await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
  await writeFile(join(root, 'node_modules', '.bin', 'tsc'), '#!/usr/bin/env node\nimport("../typescript/bin/tsc");\n', { mode: 0o755 });
  const trace = join(root, 'trace');
  async function run(target: string, controls: string[] = [], extraEnv: Record<string, string> = {}) {
    await writeFile(trace, '');
    const env = { ...process.env, CI: '', FILES: '', REPEAT: '', JOBS: '', TEST_FILES: '', TEST_JOBS: '', TEST_DISPLAY: '', TRACE: trace, ...extraEnv };
    const npm = process.env['npm_execpath'];
    if (!npm) { throw new Error('Run these command-interface tests through npm'); }
    const child = spawn(process.execPath, [npm, 'run', target, '--', ...controls], { cwd: root, env });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (text: string) => { output += text; });
    child.stderr.setEncoding('utf8').on('data', (text: string) => { output += text; });
    const code = await new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', resolveExit);
    });
    const calls = (await readFile(trace, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Invocation);
    return { code, output, calls };
  }
  return { run, root };
}

it('checks types and lint before selecting unit files without compiling them', async () => {
  const { run } = await fixture();
  const result = await run('test:unit', ['tests/unit/a.test.ts', '--repeat', '3']);
  expect(result.code, result.output).toBe(0);
  expect(result.calls.map(({ command, args }) => [command, args])).toEqual([
    ['types', ['-b']], ['eslint', ['.', '--max-warnings', '0']], ['knip', []],
    ...Array.from({ length: 3 }, () => ['vitest', ['run', '--project', 'unit', 'tests/unit/a.test.ts']]),
  ]);
});

it('prepares integration bundles once and translates source paths and job count', async () => {
  const { run } = await fixture();
  const result = await run('test:integration', ['tests/integration/b.test.ts', 'tests/integration/empty/c.test.ts', 'tests/integration/a.test.ts', '--repeat', '2', '--jobs', '4'], { ELECTRON_RUN_AS_NODE: '1' });
  expect(result.code, result.output).toBe(0);
  expect(result.calls.map(({ command, args }) => [command, args])).toEqual([
    ['types', ['-b']], ['eslint', ['.', '--max-warnings', '0']], ['knip', []], ['bundle', []],
    ['integration', []], ['integration', []],
  ]);
  for (const call of result.calls.slice(1)) {
    expect(call.files).toBe('b.test.js,empty/c.test.js,a.test.js');
    expect(call.jobs).toBe('4');
    expect(call.electron).toBeUndefined();
  }
});

it.each([
  ['test:webview', ['tests/webview/a.test.ts'], ['run', '--project', 'webview', 'tests/webview/a.test.ts']],
  ['test:in-process', ['tests/unit/a.test.ts', 'tests/webview/a.test.ts'], ['run', 'tests/unit/a.test.ts', 'tests/webview/a.test.ts']],
  ['test:ui', ['tests/ui/a.test.ts'], ['test', '--config', 'playwright.config.mts', 'tests/ui/a.test.ts']],
])('%s prepares bundles and forwards the selected files', async (target, files, args) => {
  const { run } = await fixture();
  const result = await run(target, files);
  expect(result.code, result.output).toBe(0);
  expect(result.calls.slice(0, 4).map(({ command }) => command)).toEqual(['types', 'eslint', 'knip', 'bundle']);
  const last = result.calls.at(-1);
  expect(last?.args).toEqual(args);
});

it.each([
  ['test:unit', ['tests/unit/missing.test.ts']],
  ['test:unit', ['tests/unit/a.test.ts', 'tests/unit/missing.test.ts']],
  ['test:unit', ['tests/webview/a.test.ts']],
  ['test:webview', ['tests/webview/unsupported.test.tsx']],
  ['test:in-process', ['tests/unit/a.test.ts', 'tests/webview/unsupported.test.tsx']],
  ['test:integration', ['tests/integration/*.test.ts']],
  ['test:integration', ['tests/integration/../../package.json']],
  ['test:integration', ['tests/integration/other/d.test.ts']],
  ['test:unit', ['--repeat', '0']],
  ['test:unit', ['--repeat', '2junk']],
  ['test:integration', ['--jobs', '-1']],
  ['test:integration', ['--jobs', '1.5']],
  ['test:unit', ['--jobs', '2']],
  ['test', ['tests/unit/a.test.ts']],
  ['test', ['--repeat', '2']],
  ['test', ['--jobs', '2']],
  ['test:unit', ['--repeat']],
  ['test:integration', ['--jobs']],
  ['test:unit', ['--unknown']],
  ['test:unit', ['--repeat', '9007199254740992']],
  ['test:unit', ['tests/unit/a.test.ts tests/unit/b.test.ts']],
  ['test:unit', ['--repeat', '1', '--repeat', '2']],
  ['test:integration', ['--jobs', '1', '--jobs', '2']],
  ['check', ['tests/unit/a.test.ts']],
  ['compile', ['--repeat', '2']],
])('rejects invalid %s control %s before running anything', async (target, control) => {
  const { run } = await fixture();
  const result = await run(target, control);
  expect(result.code, result.output).not.toBe(0);
  expect(result.calls).toEqual([]);
});

it.each(['TEST_FILES', 'TEST_JOBS', 'TEST_DISPLAY', 'FILES', 'REPEAT', 'JOBS'])('rejects inherited %s rather than silently narrowing the gate', async (name) => {
  const { run } = await fixture();
  const result = await run('test', [], { [name]: name === 'TEST_FILES' ? 'a.test.js' : '1' });
  expect(result.code, result.output).not.toBe(0);
  expect(result.calls).toEqual([]);
});

it('stops repetitions on the first failure', async () => {
  const { run } = await fixture();
  const result = await run('test:unit', ['--repeat', '3'], { FAIL_COMMAND: 'vitest' });
  expect(result.code).not.toBe(0);
  expect(result.calls.map(({ command }) => command)).toEqual(['types', 'eslint', 'knip', 'vitest']);
});

it.each(['types', 'eslint', 'knip', 'bundle'])('does not execute tests after %s preparation fails', async (script) => {
  const { run } = await fixture();
  const result = await run('coverage:integration', ['--repeat', '3'], { FAIL_COMMAND: script });
  expect(result.code).not.toBe(0);
  const order = ['types', 'eslint', 'knip', 'bundle'];
  expect(result.calls.map(({ command }) => command)).toEqual(order.slice(0, order.indexOf(script) + 1));
});

it.each([
  'test', 'test:in-process', 'test:unit', 'test:webview', 'test:integration', 'test:ui',
  'coverage', 'coverage:integration',
])('%s typechecks and lints before target-specific work', async (target) => {
  const { run } = await fixture();
  const result = await run(target);
  expect(result.code, result.output).toBe(0);
  expect(result.calls.slice(0, 3).map(({ command }) => command)).toEqual(['types', 'eslint', 'knip']);
});

it.each([
  'test', 'test:in-process', 'test:unit', 'test:webview', 'test:integration', 'test:ui',
  'coverage', 'coverage:integration',
])('%s stops before target-specific work when typechecking fails', async (target) => {
  const { run } = await fixture();
  const result = await run(target, [], { FAIL_COMMAND: 'types' });
  expect(result.code).not.toBe(0);
  expect(result.calls.map(({ command }) => command)).toEqual(['types']);
});

it('prepares unit coverage once and keeps each repetition focused', async () => {
  const { run } = await fixture();
  const result = await run('coverage', ['tests/unit/a.test.ts', '--repeat', '2']);
  expect(result.code, result.output).toBe(0);
  expect(result.calls.map(({ command, args }) => [command, args])).toEqual([
    ['types', ['-b']], ['eslint', ['.', '--max-warnings', '0']], ['knip', []],
    ['vitest', ['run', '--project', 'unit', '--coverage', 'tests/unit/a.test.ts']],
    ['vitest', ['run', '--project', 'unit', '--coverage', 'tests/unit/a.test.ts']],
  ]);
});

it('keeps the full regression gate unfiltered', async () => {
  const { run } = await fixture();
  const result = await run('test');
  expect(result.code, result.output).toBe(0);
  expect(result.calls.map(({ command, args }) => [command, args])).toEqual([
    ['types', ['-b']], ['eslint', ['.', '--max-warnings', '0']], ['knip', []], ['bundle', []],
    ['vitest', ['run']], ['integration', []],
  ]);
});

it('checks the repository without building or testing', async () => {
  const { run } = await fixture();
  const result = await run('check');
  expect(result.code, result.output).toBe(0);
  expect(result.calls.map(({ command }) => command)).toEqual(['types', 'eslint', 'knip']);
});

it('compiles development output after typechecking without running tests', async () => {
  const { run } = await fixture();
  const result = await run('compile');
  expect(result.code, result.output).toBe(0);
  expect(result.calls.map(({ command }) => command)).toEqual(['types', 'bundle']);
});

it('typechecks without linting, bundling, or running tests', async () => {
  const { run } = await fixture();
  const result = await run('typecheck');
  expect(result.code, result.output).toBe(0);
  expect(result.calls.map(({ command, args }) => [command, args])).toEqual([['types', ['-b']]]);
});

it('builds production bundles after typechecking without running tests', async () => {
  const { run } = await fixture();
  const result = await run('build:production');
  expect(result.code, result.output).toBe(0);
  expect(result.calls.map(({ command, args }) => [command, args])).toEqual([
    ['types', ['-b']], ['bundle', ['--production']],
  ]);
});

it('stops the production build when typechecking fails', async () => {
  const { run } = await fixture();
  const result = await run('build:production', [], { FAIL_COMMAND: 'types' });
  expect(result.code).not.toBe(0);
  expect(result.calls.map(({ command }) => command)).toEqual(['types']);
});

it('requests integration coverage on each focused execution', async () => {
  const { run } = await fixture();
  const result = await run('coverage:integration', ['tests/integration/a.test.ts', '--repeat', '2']);
  expect(result.code, result.output).toBe(0);
  expect(result.calls.slice(4)).toEqual([
    { command: 'integration', args: ['--coverage'], files: 'a.test.js' },
    { command: 'integration', args: ['--coverage'], files: 'a.test.js' },
  ]);
});

it('does not launch integration after the full gate fails in Vitest', async () => {
  const { run } = await fixture();
  const result = await run('test', [], { FAIL_COMMAND: 'vitest' });
  expect(result.code, result.output).toBe(7);
  expect(result.calls.map(({ command }) => command)).toEqual(['types', 'eslint', 'knip', 'bundle', 'vitest']);
});

it.each(['test:integration', 'coverage:integration', 'test'])('%s applies local execution preferences without filtering tests', async (target) => {
  const { root, run } = await fixture();
  await writeFile(join(root, '.env.test.local'), '# Local preferences\nTEST_JOBS="4"\nTEST_DISPLAY=xvfb\nUI_JOBS=2\n');
  const result = await run(target);
  expect(result.code, result.output).toBe(0);
  expect(result.calls.at(-1)).toMatchObject({ command: 'integration', jobs: '4', display: 'xvfb' });
  expect(result.calls.at(-1)?.files).toBeUndefined();
  expect(result.output).toContain('.env.test.local');
});

it('command arguments override local jobs and display preferences', async () => {
  const { root, run } = await fixture();
  await writeFile(join(root, '.env.test.local'), 'TEST_JOBS=4\nTEST_DISPLAY=xvfb\n');
  const result = await run('test:integration', ['--jobs', '1', '--display', 'existing']);
  expect(result.code, result.output).toBe(0);
  expect(result.calls.at(-1)).toMatchObject({ jobs: '1', display: 'existing' });
});

it('CI ignores the local file, even when it contains invalid settings', async () => {
  const { root, run } = await fixture();
  await writeFile(join(root, '.env.test.local'), 'TEST_JOBS=bad\nUNKNOWN=bad\n');
  const result = await run('test:integration', [], { CI: 'true' });
  expect(result.code, result.output).toBe(0);
  expect(result.calls.at(-1)?.jobs).toBeUndefined();
  expect(result.calls.at(-1)?.display).toBeUndefined();
});

it.each(['TEST_JOBS=0', 'TEST_DISPLAY=bad', 'FILES=tests/integration/a.test.ts', 'NODE_OPTIONS=--inspect'])('rejects unsupported local preference %s before preparation', async (content) => {
  const { root, run } = await fixture();
  await writeFile(join(root, '.env.test.local'), content);
  const result = await run('test:integration');
  expect(result.code, result.output).not.toBe(0);
  expect(result.calls).toEqual([]);
});

it('does not apply integration preferences to UI or unit execution', async () => {
  const { root, run } = await fixture();
  await writeFile(join(root, '.env.test.local'), 'TEST_JOBS=4\nTEST_DISPLAY=xvfb\n');
  for (const target of ['test:unit', 'test:ui']) {
    const result = await run(target);
    expect(result.code, result.output).toBe(0);
    expect(result.calls.at(-1)?.jobs).toBeUndefined();
    expect(result.calls.at(-1)?.display).toBeUndefined();
  }
});

it('applies local UI jobs to each Playwright execution without integration controls', async () => {
  const { root, run } = await fixture();
  await writeFile(join(root, '.env.test.local'), 'TEST_JOBS=4\nTEST_DISPLAY=xvfb\nUI_JOBS=2\n');
  const result = await run('test:ui', ['tests/ui/a.test.ts', '--repeat', '2']);
  expect(result.code, result.output).toBe(0);
  expect(result.calls.map(({ command }) => command)).toEqual(['types', 'eslint', 'knip', 'bundle', 'playwright', 'playwright']);
  for (const call of result.calls.slice(4)) {
    expect(call.args).toEqual(['test', '--config', 'playwright.config.mts', '--workers', '2', 'tests/ui/a.test.ts']);
    expect(call.jobs).toBeUndefined();
    expect(call.display).toBeUndefined();
  }
});

it('CI ignores local UI jobs and keeps Playwright configuration defaults', async () => {
  const { root, run } = await fixture();
  await writeFile(join(root, '.env.test.local'), 'UI_JOBS=bad\nUNKNOWN=bad\n');
  const result = await run('test:ui', [], { CI: 'true' });
  expect(result.code, result.output).toBe(0);
  expect(result.calls.at(-1)?.args).toEqual(['test', '--config', 'playwright.config.mts']);
});

it.each(['0', '-1', '1.5', '2junk', '9007199254740992'])('rejects invalid local UI jobs %s before preparation', async (jobs) => {
  const { root, run } = await fixture();
  await writeFile(join(root, '.env.test.local'), `UI_JOBS=${jobs}\n`);
  const result = await run('test:ui');
  expect(result.code, result.output).not.toBe(0);
  expect(result.calls).toEqual([]);
});

it('stops parallel UI repetitions on the first failure', async () => {
  const { root, run } = await fixture();
  await writeFile(join(root, '.env.test.local'), 'UI_JOBS=2\n');
  const result = await run('test:ui', ['--repeat', '3'], { FAIL_COMMAND: 'playwright' });
  expect(result.code, result.output).toBe(7);
  expect(result.calls.map(({ command }) => command)).toEqual(['types', 'eslint', 'knip', 'bundle', 'playwright']);
  expect(result.calls.at(-1)?.args).toContain('2');
});

it('runs exactly the requested unit and webview files through real Vitest discovery', async () => {
  const { root, run } = await fixture();
  const project = resolve(import.meta.dirname, '../../..');
  const config = await readFile(join(project, 'vitest.config.mts'), 'utf8');
  await writeFile(join(root, 'vitest.base.mts'), config.replace("'vitest/config'", JSON.stringify(join(project, 'node_modules/vitest/dist/config.js'))));
  const reportPath = join(root, 'results.json');
  await writeFile(join(root, 'vitest.config.mts'), `
import base from './vitest.base.mts';
export default {
  ...base,
  test: { ...base.test, reporters: ['default', 'json'], outputFile: { json: ${JSON.stringify(reportPath)} } },
};
`);
  await writeFile(join(root, 'node_modules/vitest/vitest.mjs'), `import ${JSON.stringify(pathToFileURL(join(project, 'node_modules/vitest/vitest.mjs')).href)};`);
  const testImport = JSON.stringify(join(project, 'node_modules/vitest/dist/index.js'));
  for (const path of ['tests/unit/a.test.ts', 'tests/webview/a.test.ts']) {
    await writeFile(join(root, path), `import { it } from ${testImport}; it('selected', () => {});`);
  }
  for (const path of ['tests/unit/a.test.tsx', 'tests/unit/A.test.ts', 'tests/webview/other.test.ts']) {
    await writeFile(join(root, path), `throw new Error('Unselected file executed: ${path}');`);
  }
  const result = await run('test:in-process', ['tests/unit/a.test.ts', 'tests/webview/a.test.ts'], { FORCE_COLOR: '1' });
  expect(result.code, result.output).toBe(0);
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
    success: boolean;
    numTotalTests: number;
    numPassedTests: number;
    numFailedTests: number;
    numPendingTests: number;
    numTodoTests: number;
    testResults: { name: string; status: string; assertionResults: { title: string; status: string }[] }[];
  };
  expect(report).toMatchObject({
    success: true, numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
  });
  expect(report.testResults.map(({ name, status, assertionResults }) => ({
    name, status, tests: assertionResults.map(({ title, status: testStatus }) => ({ title, status: testStatus })),
  })).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
    { name: join(root, 'tests/unit/a.test.ts'), status: 'passed', tests: [{ title: 'selected', status: 'passed' }] },
    { name: join(root, 'tests/webview/a.test.ts'), status: 'passed', tests: [{ title: 'selected', status: 'passed' }] },
  ]);
});
