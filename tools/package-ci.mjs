import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [channel, ...extra] = process.argv.slice(2);
const env = process.env;
if (extra.length || !['development', 'release', 'pre-release'].includes(channel ?? '')) {
  throw new Error('Specify development, release, or pre-release');
}
if (env['GITHUB_ACTIONS'] !== 'true' || !process.env['npm_execpath']) {
  throw new Error('CI packaging must run through npm in a disposable GitHub Actions checkout');
}
const commit = env['GITHUB_SHA'] ?? '';
const runId = env['GITHUB_RUN_ID'] ?? '';
const runNumber = env['GITHUB_RUN_NUMBER'] ?? '';
const runAttempt = env['GITHUB_RUN_ATTEMPT'] ?? '';
if (!/^[a-f0-9]{40}$/.test(commit) || ![runId, runNumber, runAttempt].every((value) => /^[1-9]\d*$/.test(value))) {
  throw new Error('Invalid source commit or CI run identity');
}
const expectedRef = 'refs/heads/master';
if (env['GITHUB_REF'] !== expectedRef || !['push', 'workflow_dispatch'].includes(env['GITHUB_EVENT_NAME'] ?? '')) {
  throw new Error('Packaging requires a push or explicit dispatch on the channel branch');
}
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (head !== commit) {
  throw new Error('Checkout HEAD must match GITHUB_SHA');
}
if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()) {
  throw new Error('Tracked files must be unchanged before packaging');
}
/** @param {unknown} value */
function object(value) {
  if (!value || typeof value !== 'object') { throw new Error('Invalid manifest object'); }
  return /** @type {Record<string, unknown>} */ (value);
}
const manifest = object(JSON.parse(await readFile('package.json', 'utf8')));
const lock = object(JSON.parse(await readFile('package-lock.json', 'utf8')));
const sourceVersion = manifest['version'];
if (typeof sourceVersion !== 'string') { throw new Error('Missing version'); }
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(sourceVersion)
  || lock['version'] !== sourceVersion || object(object(lock['packages'])[''])['version'] !== sourceVersion) {
  throw new Error('Both manifests must agree on a numeric release target');
}
const minor = Number(sourceVersion.split('.')[1]);
if ((channel === 'release' && minor % 2 !== 0) || (channel === 'pre-release' && minor % 2 !== 1)) {
  throw new Error('Regular releases require even minor versions; pre-releases require odd minor versions');
}
const output = resolve('test-results/packages');
await mkdir(resolve('test-results'), { recursive: true });
await mkdir(output, { recursive: false });
const version = channel === 'development' ? `${sourceVersion}-dev.${runNumber}.${runAttempt}` : sourceVersion;
/** @param {string[]} args */
function npm(args) {
  execFileSync(process.execPath, [env['npm_execpath'] ?? '', ...args], { stdio: 'inherit' });
}
if (channel === 'development') {
  npm(['version', version, '--no-git-tag-version', '--ignore-scripts']);
}
const filename = `your-turn-${channel ?? ''}-${version}-${commit}.vsix`;
npm(['run', 'package:vsix', '--', '--out', resolve(output, filename), ...(channel === 'pre-release' ? ['--pre-release'] : [])]);
const sha256 = createHash('sha256').update(await readFile(resolve(output, filename))).digest('hex');
await writeFile(resolve(output, 'build.json'), JSON.stringify({
  channel, version, sourceVersion, commit, runId, runNumber, runAttempt, filename, sha256,
}, null, 2) + '\n', { flag: 'wx' });
