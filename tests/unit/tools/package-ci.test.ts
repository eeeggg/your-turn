import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';

async function fixture(version = '0.4.0') {
  const root = await mkdtemp(join(tmpdir(), 'package-ci-'));
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });
  await cp(resolve(import.meta.dirname, '../../../tools'), join(root, 'tools'), { recursive: true });
  const project = JSON.parse(await readFile(resolve(import.meta.dirname, '../../../package.json'), 'utf8')) as { scripts: Record<string, string> };
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'your-turn', version,
    scripts: { 'package:ci': project.scripts['package:ci'], 'package:dev': project.scripts['package:dev'], 'package:vsix': 'node package.mjs' },
  }));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({
    name: 'your-turn', version, lockfileVersion: 3, packages: { '': { name: 'your-turn', version } },
  }));
  await writeFile(join(root, 'package.mjs'), `
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
writeFileSync('invocation.json', JSON.stringify(args));
if (process.env.FAIL_PACKAGE) { process.exit(7); }
writeFileSync(args[args.indexOf('--out') + 1], 'fixture VSIX');
`);
  function git(...args: string[]) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  }
  git('init', '--quiet');
  git('add', 'package.json', 'package-lock.json', 'package.mjs', 'tools');
  git('-c', 'user.name=Packaging Test', '-c', 'user.email=packaging@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Fixture source');
  const commit = git('rev-parse', 'HEAD');
  const env = {
    ...process.env, CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/master', GITHUB_SHA: commit,
    GITHUB_RUN_ID: '900', GITHUB_RUN_NUMBER: '100', GITHUB_RUN_ATTEMPT: '2',
    GITHUB_REPOSITORY: 'eeeggg/your-turn',
  };
  async function run(channel: string, overrides: Record<string, string> = {}, script = 'package:ci') {
    const npm = process.env['npm_execpath'];
    if (!npm) { throw new Error('Run through npm'); }
    const child = spawn(process.execPath, [npm, 'run', script, '--', ...(channel ? [channel] : [])], { cwd: root, env: { ...env, ...overrides } });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (text: string) => { output += text; });
    child.stderr.setEncoding('utf8').on('data', (text: string) => { output += text; });
    const code = await new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', resolveExit);
    });
    return { code, output };
  }
  return { root, run, git, commit };
}

it('assigns a development version through npm and records package identity and checksum', async () => {
  const { root, run, commit } = await fixture();
  const result = await run('development');
  expect(result.code, result.output).toBe(0);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')) as { version: string; packages: Record<string, { version: string }> };
  expect([manifest.version, lock.version, lock.packages['']?.version]).toEqual(Array<string>(3).fill('0.4.0-dev.100.2'));
  const metadata = JSON.parse(await readFile(join(root, 'test-results/packages/build.json'), 'utf8')) as Record<string, unknown>;
  expect(metadata).toMatchObject({
    channel: 'development', version: '0.4.0-dev.100.2', sourceVersion: '0.4.0',
    commit, runId: '900', runNumber: '100', runAttempt: '2',
    sha256: createHash('sha256').update('fixture VSIX').digest('hex'),
  });
  expect(await readFile(join(root, 'invocation.json'), 'utf8')).not.toContain('--pre-release');
});

it('packages dirty local inputs with a staging-only dev version and preserves previous outputs', async () => {
  const { root, run, commit } = await fixture('0.4.1');
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, '.gitignore'), 'node_modules/\ntest-results/\n');
  await writeFile(join(root, 'draft.txt'), 'uncommitted source');
  await writeFile(join(root, 'package.mjs'), `
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--pre-release')) { throw new Error('Not a Marketplace pre-release'); }
if (!args.includes('--no-dependencies')) { throw new Error('Local bundled packages must not scan shared dependencies'); }
writeFileSync(args[args.indexOf('--out') + 1], JSON.stringify({
 version: JSON.parse(readFileSync('package.json', 'utf8')).version,
 draft: readFileSync('draft.txt', 'utf8'), staging: process.cwd()
}));
`);
  const before = await Promise.all(['package.json', 'package-lock.json'].map((file) => readFile(join(root, file), 'utf8')));
  const result = await run('', { GITHUB_ACTIONS: '' }, 'package:dev');
  expect(result.code, result.output).toBe(0);
  const output = join(root, 'test-results/packages/local');
  const [build] = await readdir(output);
  if (!build) { throw new Error('Missing local build'); }
  const metadata = JSON.parse(await readFile(join(output, build, 'build.json'), 'utf8')) as { filename: string; version: string; sha256: string };
  expect(metadata).toMatchObject({ channel: 'local-development', sourceVersion: '0.4.1', commit, dirty: true });
  expect(metadata.version).toMatch(/^0\.4\.1-dev\.local\.[0-9]+\.[a-f0-9]+$/);
  const bytes = await readFile(join(output, build, metadata.filename));
  expect(metadata.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  const packaged = JSON.parse(bytes.toString()) as { version: string; draft: string; staging: string };
  expect(packaged).toMatchObject({ version: metadata.version, draft: 'uncommitted source' });
  await expect(readFile(join(packaged.staging, 'package.json'))).rejects.toThrow();
  expect(await Promise.all(['package.json', 'package-lock.json'].map((file) => readFile(join(root, file), 'utf8')))).toEqual(before);
  expect((await run('', { GITHUB_ACTIONS: '' }, 'package:dev')).code).toBe(0);
  expect(await readdir(output)).toHaveLength(2);
  expect(await readFile(join(output, build, metadata.filename))).toEqual(bytes);
});

it('cleans local staging and leaves manifests untouched when packaging fails', async () => {
  const { root, run } = await fixture('0.4.1');
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, '.gitignore'), 'node_modules/\ntest-results/\n');
  const before = await readFile(join(root, 'package.json'), 'utf8');
  const result = await run('', { GITHUB_ACTIONS: '', FAIL_PACKAGE: '1' }, 'package:dev');
  expect(result.code, result.output).not.toBe(0);
  expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(before);
  expect(await readdir(join(root, 'test-results/packages/local'))).toEqual([]);
});

it.each([
  ['release', '0.4.0', 'master', false],
  ['pre-release', '0.5.0', 'master', true],
] as const)('packages a %s candidate without changing its numeric version', async (channel, version, branch, preRelease) => {
  const { root, run } = await fixture(version);
  const before = await readFile(join(root, 'package-lock.json'), 'utf8');
  const result = await run(channel, { GITHUB_REF: `refs/heads/${branch}` });
  expect(result.code, result.output).toBe(0);
  expect(await readFile(join(root, 'package-lock.json'), 'utf8')).toBe(before);
  const args = JSON.parse(await readFile(join(root, 'invocation.json'), 'utf8')) as string[];
  expect(args.includes('--pre-release')).toBe(preRelease);
  const metadata = JSON.parse(await readFile(join(root, 'test-results/packages/build.json'), 'utf8')) as Record<string, unknown>;
  expect(metadata).toMatchObject({ channel, version, sourceVersion: version });
});

it.each([
  ['release', '0.5.0', { GITHUB_REF: 'refs/heads/master' }],
  ['pre-release', '0.4.0', {}],
  ['development', '0.4.0-dev.1', {}],
  ['development', '0.4.0', { GITHUB_ACTIONS: '' }],
  ['development', '0.4.0', { GITHUB_RUN_ATTEMPT: '0' }],
  ['development', '0.4.0', { GITHUB_SHA: 'invalid' }],
  ['development', '0.4.0', { GITHUB_REF: 'refs/pull/1/merge' }],
  ['unknown', '0.4.0', {}],
] as const)('rejects invalid packaging inputs: %s / %s / %j', async (channel, version, overrides) => {
  const { root, run } = await fixture(version);
  const before = await readFile(join(root, 'package.json'), 'utf8');
  expect((await run(channel, overrides)).code).not.toBe(0);
  expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(before);
  await expect(readFile(join(root, 'invocation.json'))).rejects.toThrow();
});

it('rejects a source commit mismatch before changing versions or packaging', async () => {
  const { root, run, commit } = await fixture();
  const before = await readFile(join(root, 'package.json'), 'utf8');
  const result = await run('development', { GITHUB_SHA: commit === 'a'.repeat(40) ? 'b'.repeat(40) : 'a'.repeat(40) });
  expect(result.code, result.output).not.toBe(0);
  expect(result.output).toContain('Checkout HEAD must match GITHUB_SHA');
  expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(before);
  await expect(readFile(join(root, 'invocation.json'))).rejects.toThrow();
  await expect(readFile(join(root, 'test-results/packages/build.json'))).rejects.toThrow();
});

it.each([false, true])('rejects modified tracked source before changing versions or packaging (staged: %s)', async (staged) => {
  const { root, run, git } = await fixture();
  const before = await readFile(join(root, 'package.json'), 'utf8');
  await writeFile(join(root, 'tools/package-ci.mjs'), await readFile(join(root, 'tools/package-ci.mjs'), 'utf8') + '\n');
  if (staged) { git('add', 'tools/package-ci.mjs'); }
  const result = await run('development');
  expect(result.code, result.output).not.toBe(0);
  expect(result.output).toContain('Tracked files must be unchanged before packaging');
  expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(before);
  await expect(readFile(join(root, 'invocation.json'))).rejects.toThrow();
  await expect(readFile(join(root, 'test-results/packages/build.json'))).rejects.toThrow();
});

it('rejects inconsistent lock metadata before changing versions or packaging', async () => {
  const { root, run, git } = await fixture();
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ version: '0.3.22', packages: { '': { version: '0.4.0' } } }));
  git('-c', 'user.name=Packaging Test', '-c', 'user.email=packaging@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-am', 'Inconsistent fixture metadata');
  const result = await run('development', { GITHUB_SHA: git('rev-parse', 'HEAD') });
  expect(result.code).not.toBe(0);
  expect(result.output).toContain('Both manifests must agree on a numeric release target');
  await expect(readFile(join(root, 'invocation.json'))).rejects.toThrow();
});

it('does not overwrite prior output or publish metadata for a failed package', async () => {
  const { root, run } = await fixture();
  const result = await run('development', { FAIL_PACKAGE: '1' });
  expect(result.code, result.output).not.toBe(0);
  await expect(readFile(join(root, 'test-results/packages/build.json'))).rejects.toThrow();
  await mkdir(join(root, 'test-results/packages/existing'), { recursive: true });
  await writeFile(join(root, 'test-results/packages/existing/keep'), 'preserve');
  expect((await run('development')).code).not.toBe(0);
  expect(await readFile(join(root, 'test-results/packages/existing/keep'), 'utf8')).toBe('preserve');
});
