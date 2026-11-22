import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const npmPath = process.env['npm_execpath'];
if (!npmPath || process.argv.length !== 2) { throw new Error('Use npm run package:dev without arguments'); }
if (process.env['GITHUB_ACTIONS'] === 'true') { throw new Error('Use package:ci in GitHub Actions'); }
const root = process.cwd();
/** @param {string[]} args */
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
/** @param {unknown} value */
function object(value) {
  if (!value || typeof value !== 'object') { throw new Error('Invalid manifest object'); }
  return /** @type {Record<string, unknown>} */ (value);
}
const manifest = object(JSON.parse(await readFile('package.json', 'utf8')));
const lock = object(JSON.parse(await readFile('package-lock.json', 'utf8')));
const sourceVersion = manifest['version'];
if (typeof sourceVersion !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(sourceVersion)
  || lock['version'] !== sourceVersion || object(object(lock['packages'])[''])['version'] !== sourceVersion) {
  throw new Error('Both manifests must agree on a numeric release target');
}
const commit = git(['rev-parse', 'HEAD']);
const dirty = git(['status', '--porcelain']).length > 0;
const paths = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean))].sort();
const buildId = `${Date.now()}.${randomBytes(6).toString('hex')}`;
const version = `${sourceVersion}-dev.local.${buildId}`;
const outputRoot = resolve('test-results/packages/local');
await mkdir(outputRoot, { recursive: true });
const staging = await mkdtemp(join(outputRoot, '.staging-'));
const output = join(outputRoot, buildId);
let complete = false;
let ownsOutput = false;
try {
  const fingerprint = createHash('sha256');
  for (const path of paths) {
    const source = join(root, path);
    let stat;
    try { stat = await lstat(source); } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { continue; }
      throw error;
    }
    if (!stat.isFile()) { throw new Error(`Local packaging requires regular source files: ${path}`); }
    const destination = join(staging, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    const bytes = await readFile(destination);
    fingerprint.update(JSON.stringify([path, bytes.length])).update(bytes);
  }
  await symlink(join(root, 'node_modules'), join(staging, 'node_modules'), 'dir');
  /** @param {string[]} args */
  const npm = (args) => execFileSync(process.execPath, [npmPath, ...args], { cwd: staging, stdio: 'inherit' });
  npm(['version', version, '--no-git-tag-version', '--ignore-scripts']);
  await mkdir(output);
  ownsOutput = true;
  const filename = `your-turn-${version}.vsix`;
  npm(['run', 'package:vsix', '--', '--no-dependencies', '--out', join(output, filename)]);
  const sha256 = createHash('sha256').update(await readFile(join(output, filename))).digest('hex');
  await writeFile(join(output, 'build.json'), JSON.stringify({
    channel: 'local-development', version, sourceVersion, commit, dirty,
    inputSha256: fingerprint.digest('hex'), filename, sha256,
  }, null, 2) + '\n', { flag: 'wx' });
  complete = true;
  console.log(`Local development VSIX: ${join(output, filename)}\nVersion: ${version}\nSHA-256: ${sha256}`);
} finally {
  await rm(staging, { recursive: true, force: true });
  if (!complete && ownsOutput) { await rm(output, { recursive: true, force: true }); }
}
