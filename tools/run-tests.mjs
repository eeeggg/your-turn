import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { windowKinds } from './integration-windows.mjs';

const root = resolve(import.meta.dirname, '..');
const windowDirectories = new Set(windowKinds.map(({ directory }) => directory));
const target = process.argv[2] ?? '';
/** @typedef {{ mode: 'full' | 'integration' | 'vitest' | 'ui' | 'check' | 'compile', layers: string[], bundle: boolean, vitestArgs?: string[], coverage?: boolean }} Target */
/** @type {Record<string, Target>} */
const targets = {
  test: { mode: 'full', layers: [], bundle: true },
  'test:integration': { mode: 'integration', layers: ['integration'], bundle: true },
  'coverage:integration': { mode: 'integration', layers: ['integration'], bundle: true, coverage: true },
  'test:in-process': { mode: 'vitest', layers: ['unit', 'webview'], bundle: true, vitestArgs: [] },
  'test:unit': { mode: 'vitest', layers: ['unit'], bundle: false, vitestArgs: ['--project', 'unit'] },
  'test:webview': { mode: 'vitest', layers: ['webview'], bundle: true, vitestArgs: ['--project', 'webview'] },
  coverage: { mode: 'vitest', layers: ['unit'], bundle: false, vitestArgs: ['--project', 'unit', '--coverage'] },
  'test:ui': { mode: 'ui', layers: ['ui'], bundle: true },
  check: { mode: 'check', layers: [], bundle: false },
  compile: { mode: 'compile', layers: [], bundle: true },
};

/** @param {string[]} args */
function parseArguments(args) {
  const files = [];
  let repeatText;
  let jobsText;
  let displayText;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--repeat' || arg === '--jobs' || arg === '--display') {
      const value = args[++index];
      if (value === undefined) { throw new Error(`${arg} requires ${arg === '--display' ? 'auto, xvfb or existing' : 'a positive integer'}`); }
      if (arg === '--repeat') {
        if (repeatText !== undefined) { throw new Error('Duplicate --repeat'); }
        repeatText = value;
      } else if (arg === '--jobs') {
        if (jobsText !== undefined) { throw new Error('Duplicate --jobs'); }
        jobsText = value;
      } else {
        if (displayText !== undefined) { throw new Error('Duplicate --display'); }
        displayText = value;
      }
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      files.push(arg);
    }
  }
  return { files, repeatText, jobsText, displayText };
}

/** @param {string} value @param {string} name */
function positiveInteger(value, name) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(value);
}

/** @param {Target} settings @param {ReturnType<typeof parseArguments>} controls */
function validateControls(settings, { files, repeatText, jobsText, displayText }) {
  if (['FILES', 'REPEAT', 'JOBS', 'TEST_FILES', 'TEST_JOBS', 'TEST_DISPLAY'].some((name) => process.env[name])) {
    throw new Error('Use positional test paths, --repeat and --jobs instead of legacy environment controls');
  }
  if (settings.layers.length === 0 && (files.length > 0 || repeatText !== undefined || jobsText !== undefined || displayText !== undefined)) {
    throw new Error(`${target} is unfiltered; use a test layer for file selection, --repeat or --jobs`);
  }
  if (jobsText !== undefined && settings.mode !== 'integration') { throw new Error('--jobs is supported only for integration targets'); }
  if (displayText !== undefined && settings.mode !== 'integration') { throw new Error('--display is supported only for integration targets'); }
  const repeat = repeatText !== undefined ? positiveInteger(repeatText, '--repeat') : 1;
  if (jobsText !== undefined) { positiveInteger(jobsText, '--jobs'); }
  if (displayText !== undefined) { validateDisplay(displayText); }
  return repeat;
}

/** @param {string} value */
function validateDisplay(value) {
  if (!['auto', 'xvfb', 'existing'].includes(value)) { throw new Error('Test display must be auto, xvfb or existing'); }
}

/** @param {Target} settings @param {ReturnType<typeof parseArguments>} controls */
async function loadPreferences(settings, controls) {
  let { jobsText, displayText } = controls;
  let uiJobsText;
  if (['integration', 'full', 'ui'].includes(settings.mode) && !process.env['CI']) {
    const local = await readFile(join(root, '.env.test.local'), 'utf8').catch(/** @param {unknown} error */ (error) => {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') { return undefined; }
      throw error;
    });
    if (local !== undefined) {
      const preferences = parseEnv(local);
      for (const name of Object.keys(preferences)) {
        if (!['TEST_JOBS', 'TEST_DISPLAY', 'UI_JOBS'].includes(name)) { throw new Error(`Unsupported .env.test.local setting: ${name}`); }
      }
      const localJobs = preferences['TEST_JOBS'];
      const localDisplay = preferences['TEST_DISPLAY'];
      if (settings.mode !== 'ui') {
        if (localJobs !== undefined) { positiveInteger(localJobs, 'TEST_JOBS'); }
        if (localDisplay !== undefined) { validateDisplay(localDisplay); }
        jobsText ??= localJobs;
        displayText ??= localDisplay;
      } else {
        uiJobsText = preferences['UI_JOBS'];
        if (uiJobsText !== undefined) { positiveInteger(uiJobsText, 'UI_JOBS'); }
      }
      console.log(`${settings.mode === 'ui' ? 'UI' : 'Integration'} preferences loaded from .env.test.local (command arguments take precedence)`);
    }
  }
  return { jobsText, displayText, uiJobsText };
}

/** @param {Target} settings @param {string[]} files */
async function validateFiles(settings, files) {
  const { layers } = settings;
  for (const file of files) {
    const parts = file.split('/');
    const extension = parts.at(-1) ?? '';
    if (parts[0] !== 'tests' || !layers.includes(parts[1] ?? '') || parts.some((part) => part === '' || part === '.' || part === '..')
      || !/^[\w./-]+$/.test(file) || !/\.test\.tsx?$/.test(extension)
      || (parts[1] === 'webview' && !extension.endsWith('.test.ts'))
      || (settings.mode === 'integration' && (!windowDirectories.has(parts.slice(2, -1).join('/')) || !extension.endsWith('.test.ts')))
      || (settings.mode === 'ui' && (parts.length !== 3 || !extension.endsWith('.test.ts')))
      || !(await stat(join(root, file)).catch(() => undefined))?.isFile()) {
      throw new Error(`Invalid or unmatched ${layers.join('/')} test path: ${file}`);
    }
  }
}

const controls = parseArguments(process.argv.slice(3));
const settings = Object.hasOwn(targets, target) ? targets[target] : undefined;
if (!settings) { throw new Error(`Unknown test target: ${target}`); }
const repeat = validateControls(settings, controls);
const { files } = controls;
const { jobsText, displayText, uiJobsText } = await loadPreferences(settings, controls);
await validateFiles(settings, files);
const integration = settings.mode === 'integration';
const full = settings.mode === 'full';

const env = { ...process.env };
delete env['TEST_FILES'];
delete env['TEST_JOBS'];
delete env['TEST_DISPLAY'];
if (integration) {
  if (files.length > 0) { env['TEST_FILES'] = files.map((file) => file.slice('tests/integration/'.length).replace(/\.ts$/, '.js')).join(','); }
} else if (files.length > 0 && settings.mode !== 'ui') {
  env['TEST_FILES'] = files.join(',');
}
if (integration || full) {
  if (jobsText !== undefined) { env['TEST_JOBS'] = jobsText; }
  if (displayText !== undefined) { env['TEST_DISPLAY'] = displayText; }
}
if (integration || settings.mode === 'ui' || full) { delete env['ELECTRON_RUN_AS_NODE']; }
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

/** @param {string} path @param {string[]} [args] @param {boolean} [ownsJobs] */
const node = (path, args = [], ownsJobs = false) => run(process.execPath, [join(root, path), ...args], ownsJobs);
const checkTypes = () => node('node_modules/typescript/bin/tsc', ['-b']);
const lint = async () => {
  const code = await node('node_modules/eslint/bin/eslint.js', ['.', '--max-warnings', '0']);
  return code || await node('node_modules/knip/bin/knip.js');
};
const bundle = () => node('esbuild.mjs');
/** @param {string[]} args */
const vitest = (args) => node('node_modules/vitest/vitest.mjs', ['run', ...args]);

try {
  let code = await checkTypes();
  if (code === 0 && settings.mode !== 'compile') { code = await lint(); }
  if (code === 0 && settings.bundle) { code = await bundle(); }
  if (full) {
    if (code === 0) { code = await vitest([]); }
    if (code === 0) { code = await run(process.execPath, [join(root, 'tools', 'run-integration.mjs')], true); }
  } else if (settings.layers.length > 0) {
    for (let iteration = 1; code === 0 && iteration <= repeat; iteration += 1) {
      console.log(`Test batch: ${target}, run ${iteration}/${repeat}, files: ${files.join(' ') || 'all'}`);
      if (integration) {
        code = await node('tools/run-integration.mjs', settings.coverage ? ['--coverage'] : [], true);
      } else if (settings.mode === 'ui') {
        code = await node('node_modules/@playwright/test/cli.js', ['test', '--config', 'playwright.config.mts', ...(uiJobsText !== undefined ? ['--workers', uiJobsText] : []), ...files]);
      } else {
        code = await vitest([...(settings.vitestArgs ?? []), ...files]);
      }
    }
  }
  process.exitCode = code;
} finally {
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', terminate);
}
