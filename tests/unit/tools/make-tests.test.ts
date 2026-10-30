import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';

interface Invocation { command: string; args: string[]; files?: string; jobs?: string; electron?: string }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'acp-make-tests-'));
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });
  await cp(resolve(import.meta.dirname, '../../../Makefile'), join(root, 'Makefile'));
  await cp(resolve(import.meta.dirname, '../../../tools'), join(root, 'tools'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"version":"0.0.0"}');
  const files = [
    'tests/unit/a.test.ts', 'tests/unit/b.test.ts', 'tests/webview/a.test.ts', 'tests/integration/a.test.ts', 'tests/integration/b.test.ts',
    'tests/integration/empty/c.test.ts', 'tests/integration/other/d.test.ts', 'tests/ui/a.test.ts',
  ];
  for (const file of files) {
    await mkdir(join(root, file, '..'), { recursive: true });
    await writeFile(join(root, file), '');
  }
  const bin = join(root, 'bin');
  await mkdir(bin);
  const recorder = `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.TRACE, JSON.stringify({ command, args, files: process.env.ACP_TEST_FILES, jobs: process.env.ACP_TEST_JOBS, electron: process.env.ELECTRON_RUN_AS_NODE }) + '\\n');
process.exitCode = process.env.FAIL_COMMAND && process.env.FAIL_COMMAND === args[1] ? 7 : 0;
`;
  for (const name of ['npm', 'xvfb-run']) { await writeFile(join(bin, name), recorder, { mode: 0o755 }); }
  await writeFile(join(root, 'tools', 'run-integration.mjs'), recorder.replace("basename(process.argv[1])", "'integration'"));
  const trace = join(root, 'trace');
  async function run(target: string, controls: string[] = [], extraEnv: Record<string, string> = {}) {
    await writeFile(trace, '');
    const env = { ...process.env, MAKEFLAGS: '', MFLAGS: '', MAKELEVEL: '', FILES: '', REPEAT: '', JOBS: '', ACP_TEST_FILES: '', ACP_TEST_JOBS: '', PATH: bin + delimiter + (process.env['PATH'] ?? ''), TRACE: trace, ...extraEnv };
    const child = spawn('make', ['--no-print-directory', target, ...controls], { cwd: root, env });
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
  return { run };
}

it('checks types and lint before selecting unit files without compiling them', async () => {
  const { run } = await fixture();
  const result = await run('test-unit', ['FILES=tests/unit/a.test.ts', 'REPEAT=3']);
  expect(result.code, result.output).toBe(0);
  expect(result.calls.map(({ args }) => args)).toEqual([
    ['run', 'check-types'], ['run', 'lint'],
    ...Array.from({ length: 3 }, () => ['run', 'test:unit', '--', 'tests/unit/a.test.ts']),
  ]);
});

it('prepares integration bundles once and translates source paths and job count', async () => {
  const { run } = await fixture();
  const result = await run('test-integration', ['FILES=tests/integration/b.test.ts tests/integration/empty/c.test.ts tests/integration/a.test.ts', 'REPEAT=2', 'JOBS=4'], { ELECTRON_RUN_AS_NODE: '1' });
  expect(result.code, result.output).toBe(0);
  expect(result.calls.map(({ command, args }) => [command, args])).toEqual([
    ['npm', ['run', 'check-types']], ['npm', ['run', 'lint']], ['npm', ['run', 'bundle']],
    ['integration', []], ['integration', []],
  ]);
  for (const call of result.calls.slice(1)) {
    expect(call.files).toBe('b.test.js,empty/c.test.js,a.test.js');
    expect(call.jobs).toBe('4');
    expect(call.electron).toBeUndefined();
  }
});

it.each([
  ['test-webview', 'tests/webview/a.test.ts', 'test:webview'],
  ['test-vitest', 'tests/unit/a.test.ts tests/webview/a.test.ts', 'test:vitest'],
  ['test-ui', 'tests/ui/a.test.ts', 'test:ui'],
])('%s prepares bundles and forwards the selected files', async (target, files, script) => {
  const { run } = await fixture();
  const result = await run(target, [`FILES=${files}`]);
  expect(result.code, result.output).toBe(0);
  expect(result.calls.slice(0, 3).map(({ args }) => args)).toEqual([
    ['run', 'check-types'], ['run', 'lint'], ['run', 'bundle'],
  ]);
  const last = result.calls.at(-1);
  expect(last?.args).toEqual(['run', script, '--', ...files.split(' ')]);
});

it.each([
  ['test-unit', 'FILES=tests/unit/missing.test.ts'],
  ['test-unit', 'FILES=tests/unit/a.test.ts tests/unit/missing.test.ts'],
  ['test-unit', 'FILES=tests/webview/a.test.ts'],
  ['test-integration', 'FILES=tests/integration/*.test.ts'],
  ['test-integration', 'FILES=tests/integration/../../package.json'],
  ['test-integration', 'FILES=tests/integration/other/d.test.ts'],
  ['test-unit', 'REPEAT=0'],
  ['test-unit', 'REPEAT=2junk'],
  ['test-integration', 'JOBS=-1'],
  ['test-integration', 'JOBS=1.5'],
  ['test-unit', 'JOBS=2'],
  ['test', 'FILES=tests/unit/a.test.ts'],
  ['test', 'REPEAT=2'],
  ['test', 'JOBS=2'],
])('rejects invalid %s control %s before running anything', async (target, control) => {
  const { run } = await fixture();
  const result = await run(target, [control]);
  expect(result.code, result.output).not.toBe(0);
  expect(result.calls).toEqual([]);
});

it.each(['ACP_TEST_FILES', 'ACP_TEST_JOBS'])('rejects inherited %s rather than silently narrowing the gate', async (name) => {
  const { run } = await fixture();
  const result = await run('test', [], { [name]: name === 'ACP_TEST_FILES' ? 'a.test.js' : '1' });
  expect(result.code, result.output).not.toBe(0);
  expect(result.calls).toEqual([]);
});

it('stops repetitions on the first failure', async () => {
  const { run } = await fixture();
  const result = await run('test-unit', ['REPEAT=3'], { FAIL_COMMAND: 'test:unit' });
  expect(result.code).not.toBe(0);
  expect(result.calls.map(({ args }) => args)).toEqual([
    ['run', 'check-types'], ['run', 'lint'], ['run', 'test:unit'],
  ]);
});

it.each(['check-types', 'lint', 'bundle'])('does not execute tests after %s preparation fails', async (script) => {
  const { run } = await fixture();
  const result = await run('coverage-integration', ['REPEAT=3'], { FAIL_COMMAND: script });
  expect(result.code).not.toBe(0);
  expect(result.calls.map(({ args }) => args)).toEqual(script === 'bundle'
    ? [['run', 'check-types'], ['run', 'lint'], ['run', 'bundle']]
    : script === 'lint' ? [['run', 'check-types'], ['run', 'lint']]
      : [['run', 'check-types']]);
});

it.each([
  'test', 'test-vitest', 'test-unit', 'test-webview', 'test-integration', 'test-ui',
  'coverage', 'coverage-integration',
])('%s typechecks and lints before target-specific work', async (target) => {
  const { run } = await fixture();
  const result = await run(target);
  expect(result.code, result.output).toBe(0);
  expect(result.calls.slice(0, 2).map(({ args }) => args)).toEqual([
    ['run', 'check-types'], ['run', 'lint'],
  ]);
});

it.each([
  'test', 'test-vitest', 'test-unit', 'test-webview', 'test-integration', 'test-ui',
  'coverage', 'coverage-integration',
])('%s stops before target-specific work when typechecking fails', async (target) => {
  const { run } = await fixture();
  const result = await run(target, [], { FAIL_COMMAND: 'check-types' });
  expect(result.code).not.toBe(0);
  expect(result.calls.map(({ args }) => args)).toEqual([['run', 'check-types']]);
});

it('prepares unit coverage once and keeps each repetition focused', async () => {
  const { run } = await fixture();
  const result = await run('coverage', ['FILES=tests/unit/a.test.ts', 'REPEAT=2']);
  expect(result.code, result.output).toBe(0);
  expect(result.calls.map(({ args }) => args)).toEqual([
    ['run', 'check-types'], ['run', 'lint'],
    ['run', 'coverage:unit', '--', 'tests/unit/a.test.ts'], ['run', 'coverage:unit', '--', 'tests/unit/a.test.ts'],
  ]);
});

it('keeps the full regression gate unfiltered', async () => {
  const { run } = await fixture();
  const result = await run('test');
  expect(result.code, result.output).toBe(0);
  expect(result.calls.map(({ command, args }) => [command, args])).toEqual([
    ['npm', ['run', 'check-types']], ['npm', ['run', 'lint']], ['npm', ['run', 'bundle']],
    ['npm', ['run', 'test:vitest']], ['integration', []],
  ]);
});

it('exposes type checking through Make', async () => {
  const { run } = await fixture();
  const result = await run('typecheck');
  expect(result.code, result.output).toBe(0);
  expect(result.calls.map(({ args }) => args)).toEqual([['run', 'check-types']]);
});

it('does not retain the old check-types Make alias', async () => {
  const { run } = await fixture();
  const result = await run('check-types');
  expect(result.code).not.toBe(0);
  expect(result.calls).toEqual([]);
});
