import { readdir, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { windowKinds } from './integration-windows.mjs';
import { vscodeVersion } from './vscode-test.mjs';

const root = resolve(import.meta.dirname, '..');
const testDirectory = join(root, 'dist', 'test');
const cli = join(root, 'node_modules', '@vscode', 'test-cli', 'out', 'bin.mjs');
const jobWatchdogMs = 10 * 60 * 1000;
const shutdownWatchdogMs = 5000;
const coverage = process.argv.includes('--coverage');

const requestedText = process.env['TEST_JOBS'] || '1';
const requestedJobs = Number(requestedText);
if (!/^[1-9]\d*$/.test(requestedText) || !Number.isSafeInteger(requestedJobs)) {
  throw new Error('Integration jobs must be a positive integer');
}

const requestedFiles = process.env['TEST_FILES']?.split(',').filter(Boolean);
const compiledFiles = (await readdir(testDirectory, { recursive: true }))
  .map((file) => file.replaceAll('\\', '/'))
  .filter((file) => file.endsWith('.test.js'));
const missing = requestedFiles?.filter((file) => !compiledFiles.includes(file)) ?? [];
if (missing.length > 0) { throw new Error(`Unmatched compiled integration tests: ${missing.join(', ')}`); }
const testFiles = compiledFiles
  .filter((file) => !requestedFiles || requestedFiles.includes(file))
  .sort();

if (testFiles.length === 0) {
  throw new Error(`No compiled integration tests found in ${testDirectory}; run npm run compile first`);
}

/** @param {string} file */
const kindOf = (file) => windowKinds.find(({ directory }) => dirname(file) === (directory || '.'));
const unplaced = testFiles.filter((file) => !kindOf(file));
if (unplaced.length > 0) {
  throw new Error(`Compiled integration tests in no window kind's directory: ${unplaced.join(', ')}`);
}

/** @typedef {{ kind: typeof windowKinds[number], files: string[] }} Group */
const groups = windowKinds
  .map((kind) => ({ kind, files: testFiles.filter((file) => kindOf(file) === kind).map((file) => join(testDirectory, file)) }))
  .filter(({ files }) => files.length > 0);

let jobs = Math.min(requestedJobs, groups.length);
const displayPolicy = process.env['TEST_DISPLAY'] || 'auto';
if (!['auto', 'xvfb', 'existing'].includes(displayPolicy)) { throw new Error('Test display must be auto, xvfb or existing'); }
let isolatedDisplay = false;
/** @param {number} count */
async function probeDisplays(count) {
  const results = await Promise.allSettled(Array.from({ length: count }, () => runSetup('xvfb-run', ['-a', process.execPath, '-e', ''], 10_000)));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') { throw failure.reason; }
}
async function selectDisplay() {
  if (process.platform === 'linux') {
    if (displayPolicy !== 'existing') {
      try {
        await probeDisplays(jobs);
        isolatedDisplay = true;
      } catch (error) {
        if (stopping) { throw error; }
        if (displayPolicy === 'xvfb' || !process.env['DISPLAY']) {
          throw new Error('Integration tests need working Xvfb (xvfb-run); auto mode can also use an existing DISPLAY', { cause: error });
        }
        console.log(`Xvfb unavailable; falling back to serial on existing DISPLAY=${process.env['DISPLAY']}. Test windows may appear on your desktop or SSH-forwarded display.`);
        jobs = 1;
      }
    } else {
      if (!process.env['DISPLAY']) { throw new Error('Existing-display mode requires DISPLAY; use auto or install Xvfb'); }
      if (jobs > 1) { console.log('Existing-display policy: falling back to serial for display isolation'); }
      jobs = 1;
    }
  } else if (displayPolicy === 'xvfb') {
    throw new Error('Xvfb display mode is supported only on Linux; use auto or existing');
  }
  console.log(`Integration execution: requested jobs=${requestedJobs}, effective jobs=${jobs}, display=${isolatedDisplay ? 'xvfb' : process.platform === 'linux' ? 'existing' : 'native'} (policy=${displayPolicy})`);
}

/** @type {string | undefined} */
let profiles;
/** @type {string | undefined} */
let configDirectory;
let executablePath = '';
/** @type {string | undefined} */
let coverageDirectory;
let stopping = false;
let interruptedExitCode = 0;
/** @type {Set<() => void>} */
const activeJobs = new Set();

function stopJobs() {
  stopping = true;
  for (const stop of activeJobs) { stop(); }
}

function interrupt() {
  interruptedExitCode = 130;
  stopJobs();
}

function terminate() {
  interruptedExitCode = 143;
  stopJobs();
}

process.on('SIGINT', interrupt);
process.on('SIGTERM', terminate);

/** @param {import('node:child_process').ChildProcess} child @param {NodeJS.Signals} signal */
function signalProcessGroup(child, signal) {
  if (child.pid === undefined) { return; }
  if (process.platform === 'win32') { child.kill(signal); return; }
  try { process.kill(-child.pid, signal); } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ESRCH') { throw error; }
  }
}

/** @param {string} command @param {string[]} args @param {number} timeout @returns {Promise<string>} */
function runSetup(command, args, timeout) {
  return new Promise((resolveSetup, reject) => {
    if (stopping) { reject(new Error('Integration preparation interrupted')); return; }
    const child = spawn(command, args, {
      cwd: root, detached: process.platform !== 'win32',
      stdio: command === process.execPath ? ['ignore', 'inherit', 'inherit', 'ipc'] : ['ignore', 'inherit', 'inherit'],
    });
    let value = '';
    /** @type {Error | undefined} */
    let failure;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let escalation;
    const stop = () => {
      if (escalation !== undefined) { return; }
      signalProcessGroup(child, 'SIGTERM');
      escalation = setTimeout(() => { signalProcessGroup(child, 'SIGKILL'); }, shutdownWatchdogMs);
    };
    activeJobs.add(stop);
    const watchdog = setTimeout(() => {
      failure = new Error(`${command} preparation timed out after ${timeout / 1000} seconds`);
      stop();
    }, timeout);
    child.on('message', (message) => { if (typeof message === 'string') { value = message; } });
    child.on('error', (error) => { failure = error; });
    child.on('close', (code) => {
      clearTimeout(watchdog);
      clearTimeout(escalation);
      activeJobs.delete(stop);
      try { signalProcessGroup(child, 'SIGKILL'); } catch (error) { reject(new Error('Could not close preparation process group', { cause: error })); return; }
      if (failure || stopping || code !== 0) { reject(failure ?? new Error(`${command} preparation ${stopping ? 'interrupted' : `exited with code ${String(code)}`}`)); }
      else { resolveSetup(value); }
    });
  });
}

/** @typedef {{ code: number, output: string }} RunResult */

/** @param {Group} group @param {number} index */
async function prepareGroup({ kind, files }, index) {
  if (!profiles || !configDirectory) { throw new Error('Integration directories are not prepared'); }
  const profileDirectory = profiles;
  const profile = join(profiles, `profile-${index}`);
  const config = join(configDirectory, `config-${index}.mjs`);
  // Under the run's temporary directory, so outside any Git worktree, and removed with the profiles.
  const folders = Array.from({ length: kind.folders }, (_, folder) => join(profileDirectory, `folder-${index}-${folder + 1}`));
  await Promise.all(folders.map((folder) => mkdir(folder)));
  const workspaceFile = kind.saved ? join(profiles, `workspace-${index}.code-workspace`) : undefined;
  if (workspaceFile !== undefined) { await writeFile(workspaceFile, JSON.stringify({ folders: folders.map((path) => ({ path })) })); }
  // The test CLI opens one path; several folders on the command line open as an unsaved workspace.
  const workspaceFolder = workspaceFile ?? (folders.length === 1 ? folders[0] : undefined);
  const launchArgs = JSON.stringify([
    `--user-data-dir=${profile}`,
    `--extensions-dir=${join(profiles, `extensions-${index}`)}`,
    '--disable-extensions',
    ...(workspaceFolder === undefined ? folders : []),
  ]);
  const configText = `import base from ${JSON.stringify(pathToFileURL(join(root, '.vscode-test.mjs')).href)};
export default {
  ...base,
  tests: [{
    version: ${JSON.stringify(vscodeVersion)},
    useInstallation: { fromPath: ${JSON.stringify(executablePath)} },
    files: ${JSON.stringify(files)},
    extensionDevelopmentPath: ${JSON.stringify(root)},${workspaceFolder === undefined ? '' : `
    workspaceFolder: ${JSON.stringify(workspaceFolder)},`}
    launchArgs: ${launchArgs},
    mocha: { timeout: 0 },
  }],
};\n`;

  await writeFile(config, configText);
  return config;
}

/** @param {Group} group @param {number} index @param {string} config @returns {Promise<RunResult>} */
function executeGroup({ kind, files }, index, config) {
  return new Promise((resolveRun) => {
    if (stopping) { resolveRun({ code: 1, output: '' }); return; }
    console.log(`[integration ${index + 1}] Starting ${kind.name} window for ${files.map((file) => relative(testDirectory, file)).join(' ')}`);
    const command = isolatedDisplay ? 'xvfb-run' : process.execPath;
    const coverageArgs = coverageDirectory === undefined
      ? []
      : ['--coverage', '--coverage-output', join(coverageDirectory, `job-${index + 1}`)];
    const args = isolatedDisplay
      ? ['-a', process.execPath, cli, '--config', config, '--fail-zero', ...coverageArgs]
      : [cli, '--config', config, '--fail-zero', ...coverageArgs];
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, VSCODE_TEST_GROUP: String(index + 1) },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let completeOutput = '';
    let timedOut = false;
    let failed = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let shutdownWatchdog;
    /** @param {NodeJS.Signals} signal */
    const signalJob = (signal) => {
      try { signalProcessGroup(child, signal); } catch (error) {
        failed = true;
        console.error(`Could not signal integration job ${index + 1}:`, error);
      }
    };
    const stop = () => {
      if (shutdownWatchdog !== undefined) { return; }
      signalJob('SIGTERM');
      shutdownWatchdog = setTimeout(() => { signalJob('SIGKILL'); }, shutdownWatchdogMs);
    };
    activeJobs.add(stop);
    /** @param {string} chunk */
    const write = (chunk) => {
      output += chunk;
      completeOutput += chunk;
      let lineMatch;
      while ((lineMatch = /^(.*?)(?:\r?\n|$)/.exec(output)) && lineMatch[0].length > 0) {
        const line = lineMatch[0];
        if (!line.endsWith('\n') && !line.endsWith('\r')) { break; }
        output = output.slice(line.length);
        process.stdout.write(`[integration ${index + 1}] ${line}`);
      }
    };
    child.stdout.setEncoding('utf8').on('data', write);
    child.stderr.setEncoding('utf8').on('data', write);
    child.on('error', (error) => {
      failed = true;
      write(`Could not start integration job: ${error.message}\n`);
    });
    const watchdog = setTimeout(() => {
      timedOut = true;
      const message = `\n[integration ${index + 1}] Job watchdog expired after ${jobWatchdogMs / 60000} minutes\n`;
      output += message;
      completeOutput += message;
      process.stdout.write(message);
      stop();
    }, jobWatchdogMs);
    child.on('close', (code) => {
      // Closed stdio does not prove the remaining process-group members exited.
      signalJob('SIGKILL');
      clearTimeout(watchdog);
      clearTimeout(shutdownWatchdog);
      activeJobs.delete(stop);
      if (output) { process.stdout.write(`[integration ${index + 1}] ${output}`); }
      resolveRun({ code: timedOut || failed ? 1 : code ?? 1, output: completeOutput });
    });
  });
}

/** @param {Group} group @param {number} index */
async function runGroup(group, index) {
  const config = await prepareGroup(group, index);
  return executeGroup(group, index, config);
}

/** Run every group, at most `jobs` at once, settling in group order. */
async function runGroups() {
  /** @type {PromiseSettledResult<RunResult>[]} */
  const settled = [];
  let next = 0;
  const worker = async () => {
    while (next < groups.length) {
      const index = next;
      next += 1;
      const group = groups[index];
      if (!group) { throw new Error(`No integration group ${index}`); }
      settled[index] = await runGroup(group, index).then(
        (value) => /** @type {const} */ ({ status: 'fulfilled', value }),
        /** @param {unknown} reason */ (reason) => {
          stopJobs();
          return /** @type {const} */ ({ status: 'rejected', reason });
        },
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, groups.length) }, worker));
  return settled;
}

try {
  await selectDisplay();
  executablePath = await runSetup(process.execPath, ['--input-type=module', '-e',
    `import { prepareVSCode } from ${JSON.stringify(pathToFileURL(join(root, 'tools/vscode-test.mjs')).href)}; process.send(await prepareVSCode(${JSON.stringify(root)})); process.disconnect();`,
  ], jobWatchdogMs);
  configDirectory = await mkdtemp(join(root, '.vscode-test', 'integration-config-'));
  profiles = await mkdtemp(join(tmpdir(), 'integration-'));
  if (coverage) {
    const reports = join(root, 'test-results', 'integration', 'coverage');
    await mkdir(reports, { recursive: true });
    coverageDirectory = await mkdtemp(join(reports, 'run-'));
    await writeFile(join(coverageDirectory, 'jobs.json'), JSON.stringify(groups.map(({ kind, files }, index) => ({
      files: files.map((file) => relative(testDirectory, file)),
      window: kind.name,
      report: `job-${index + 1}/index.html`,
    })), null, 2));
    console.log(`Per-job coverage reports (not combined): ${coverageDirectory}`);
  }
  console.log(`Running ${testFiles.length} integration files in ${groups.length} VS Code jobs, at most ${jobs} at once`);
  const settled = await runGroups();
  const errors = settled.filter((result) => result.status === 'rejected');
  if (errors.length > 0) { throw new AggregateError(errors.map((result) => /** @type {unknown} */ (result.reason)), 'Integration jobs could not run'); }
  const results = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  if (coverageDirectory !== undefined) {
    console.log(`Coverage reports and job mapping: ${coverageDirectory}`);
  }
  const passed = results.reduce((sum, { output }) => sum + Number(/(\d+) passing/.exec(output)?.[1] ?? 0), 0);
  const failed = results.filter(({ code }) => code !== 0);
  if (interruptedExitCode !== 0) {
    console.error('Integration run interrupted; isolated jobs have closed');
    process.exitCode = interruptedExitCode;
  } else if (failed.length > 0) {
    console.error(`Integration run failed: ${passed} tests passed across ${failed.length} failed job(s)`);
    process.exitCode = 1;
  } else {
    console.log(`Integration run passed: ${passed} tests across ${results.length} jobs`);
  }
} catch (error) {
  if (interruptedExitCode !== 0) {
    console.error('Integration run interrupted; owned preparation and jobs have closed');
    process.exitCode = interruptedExitCode;
  } else { throw error; }
} finally {
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', terminate);
  await Promise.all([
    configDirectory ? rm(configDirectory, { recursive: true, force: true }) : undefined,
    profiles ? rm(profiles, { recursive: true, force: true }) : undefined,
  ]);
}
