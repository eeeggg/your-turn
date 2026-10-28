import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const target = process.argv[2] ?? '';
const files = (process.env['FILES'] ?? '').trim().split(/\s+/).filter(Boolean);
const repeatText = (process.env['REPEAT'] ?? '').trim();
const jobsText = (process.env['JOBS'] ?? '').trim();
const integration = target === 'test-integration' || target === 'coverage-integration';
const full = target === 'test';
const layers = target === 'test-vitest' ? ['unit', 'webview']
  : integration ? ['integration']
    : target === 'coverage' ? ['unit']
      : target === 'test-ui' ? ['ui']
        : target === 'test-unit' ? ['unit']
          : target === 'test-webview' ? ['webview'] : [];

/** @param {string} value @param {string} name */
function positiveInteger(value, name) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(value);
}

if (!full && layers.length === 0) { throw new Error(`Unknown test target: ${target}`); }
if (process.env['ACP_TEST_FILES'] || process.env['ACP_TEST_JOBS']) {
  throw new Error('Use Make FILES and JOBS instead of ACP_TEST_FILES or ACP_TEST_JOBS');
}
if (full && (files.length > 0 || repeatText || jobsText)) {
  throw new Error('make test is the unfiltered full gate; use a layer target for FILES, REPEAT or JOBS');
}
if (jobsText && !integration) { throw new Error('JOBS is supported only for integration targets'); }
const repeat = repeatText ? positiveInteger(repeatText, 'REPEAT') : 1;
if (jobsText) { positiveInteger(jobsText, 'JOBS'); }
for (const file of files) {
  const parts = file.split('/');
  const extension = parts.at(-1) ?? '';
  if (parts[0] !== 'tests' || !layers.includes(parts[1] ?? '') || parts.some((part) => part === '' || part === '.' || part === '..')
    || !/^[\w./-]+$/.test(file) || !/\.test\.tsx?$/.test(extension)
    || (integration && (parts.length !== 3 || !extension.endsWith('.test.ts')))
    || (target === 'test-ui' && (parts.length !== 3 || !extension.endsWith('.test.ts')))
    || !(await stat(join(root, file)).catch(() => undefined))?.isFile()) {
    throw new Error(`FILES contains an invalid or unmatched ${layers.join('/')} test path: ${file}`);
  }
}

const env = { ...process.env };
delete env['ACP_TEST_FILES'];
delete env['ACP_TEST_JOBS'];
if (integration) {
  if (files.length > 0) { env['ACP_TEST_FILES'] = files.map((file) => file.slice('tests/integration/'.length).replace(/\.ts$/, '.js')).join(','); }
  if (jobsText) { env['ACP_TEST_JOBS'] = jobsText; }
}
if (integration || target === 'test-ui' || full) { delete env['ELECTRON_RUN_AS_NODE']; }
// Nested Make checks must not inherit this batch's selection or repetition controls.
delete env['FILES'];
delete env['REPEAT'];
delete env['JOBS'];

/** @type {import('node:child_process').ChildProcess | undefined} */
let active;
let activeOwnsJobs = false;
let interrupted = 0;
/** @param {NodeJS.Signals} signal */
function stop(signal) {
  interrupted = signal === 'SIGINT' ? 130 : 143;
  if (active?.pid === undefined) { return; }
  if (activeOwnsJobs || process.platform === 'win32') {
    active.kill(signal);
  } else {
    try { process.kill(-active.pid, signal); } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ESRCH') { throw error; }
    }
  }
}
const interrupt = () => { stop('SIGINT'); };
const terminate = () => { stop('SIGTERM'); };
process.on('SIGINT', interrupt);
process.on('SIGTERM', terminate);

/** @param {string} command @param {string[]} args @param {boolean} [ownsJobs] @returns {Promise<number>} */
async function run(command, args, ownsJobs = false) {
  if (interrupted) { return interrupted; }
  activeOwnsJobs = ownsJobs;
  const child = spawn(command, args, { cwd: root, env, stdio: 'inherit', detached: !ownsJobs && process.platform !== 'win32' });
  active = child;
  const code = await new Promise(/** @param {(code: number) => void} resolveCode */ (resolveCode) => {
    child.on('error', (error) => { console.error(error); });
    child.on('close', (exitCode) => { resolveCode(exitCode ?? 1); });
  });
  active = undefined;
  return interrupted || code;
}

/** @param {string} script @param {string[]} [args] */
const npm = (script, args = []) => run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script, ...(args.length ? ['--', ...args] : [])]);

try {
  let code = await npm('check-types');
  if (code === 0) { code = await npm('lint'); }
  if (full) {
    if (code === 0) { code = await npm('bundle'); }
    if (code === 0) { code = await npm('test:vitest'); }
    if (code === 0) { code = await run(process.execPath, [join(root, 'tools', 'run-integration.mjs')], true); }
  } else {
    if (code === 0 && target !== 'test-unit' && target !== 'coverage') { code = await npm('bundle'); }
    for (let iteration = 1; code === 0 && iteration <= repeat; iteration += 1) {
      console.log(`Test batch: ${target}, run ${iteration}/${repeat}, files: ${files.join(' ') || 'all'}`);
      if (integration) {
        code = await run(process.execPath, [join(root, 'tools', 'run-integration.mjs'), ...(target === 'coverage-integration' ? ['--coverage'] : [])], true);
      } else {
        const script = target === 'coverage' ? 'coverage:unit' : `test:${target.slice('test-'.length)}`;
        code = await npm(script, files);
      }
    }
  }
  process.exitCode = code;
} finally {
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', terminate);
}
