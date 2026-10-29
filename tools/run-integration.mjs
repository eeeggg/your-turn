import { availableParallelism } from 'node:os';
import { readdir, readFile, readlink, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { windowKinds } from './integration-windows.mjs';

const root = resolve(import.meta.dirname, '..');
const testDirectory = join(root, 'dist', 'test');
const cli = join(root, 'node_modules', '@vscode', 'test-cli', 'out', 'bin.mjs');
const jobWatchdogMs = 10 * 60 * 1000;
const shutdownWatchdogMs = 5000;
const inotifyInstancesPerJob = 32;
const coverage = process.argv.includes('--coverage');

async function detectInotifyCapacity() {
  if (process.platform !== 'linux' || process.getuid === undefined) {
    return { jobs: Number.POSITIVE_INFINITY, limit: undefined, used: undefined };
  }

  const limit = Number.parseInt(
    await readFile('/proc/sys/fs/inotify/max_user_instances', 'utf8'),
    10,
  );
  let used = 0;
  const uid = process.getuid();

  for (const processId of await readdir('/proc')) {
    if (!/^\d+$/.test(processId)) { continue; }
    const processDirectory = join('/proc', processId);
    try {
      if ((await stat(processDirectory)).uid !== uid) { continue; }
      for (const descriptor of await readdir(join(processDirectory, 'fd'))) {
        if (await readlink(join(processDirectory, 'fd', descriptor)) === 'anon_inode:inotify') {
          used += 1;
        }
      }
    } catch {
      // Processes and descriptors can disappear while /proc is being inspected.
    }
  }

  return {
    jobs: Math.max(1, Math.floor((limit - used) / inotifyInstancesPerJob)),
    limit,
    used,
  };
}

const cpuJobs = Math.max(1, Math.floor(availableParallelism() / 2));
const inotify = await detectInotifyCapacity();
const detectedJobs = Math.min(cpuJobs, inotify.jobs);
const requestedJobs = Number.parseInt(process.env['ACP_TEST_JOBS'] ?? '', 10);
const jobs = Number.isInteger(requestedJobs) && requestedJobs > 0 ? requestedJobs : detectedJobs;

const requestedFiles = process.env['ACP_TEST_FILES']?.split(',').filter(Boolean);
const testFiles = (await readdir(testDirectory, { recursive: true }))
  .filter((file) => file.endsWith('.test.js'))
  .filter((file) => !requestedFiles || requestedFiles.includes(file))
  .sort();

if (testFiles.length === 0) {
  throw new Error(`No compiled integration tests found in ${testDirectory}; run make compile first`);
}

/** @param {string} file */
const kindOf = (file) => windowKinds.find(({ directory }) => dirname(file) === (directory || '.'));
const unplaced = testFiles.filter((file) => !kindOf(file));
if (unplaced.length > 0) {
  throw new Error(`Compiled integration tests in no window kind's directory: ${unplaced.join(', ')}`);
}

/** @typedef {{ kind: typeof windowKinds[number], files: string[] }} Group */
const byKind = windowKinds
  .map((kind) => ({ kind, files: testFiles.filter((file) => kindOf(file) === kind) }))
  .filter(({ files }) => files.length > 0);
// Each kind present gets a job; each further job goes to the kind with the most files per job.
const jobCounts = byKind.map(() => 1);
for (let total = byKind.length; total < jobs; total += 1) {
  let busiest = -1;
  byKind.forEach(({ files }, index) => {
    const count = jobCounts[index] ?? 1;
    const busiestLoad = busiest === -1 ? 0 : (byKind[busiest]?.files.length ?? 0) / (jobCounts[busiest] ?? 1);
    if (count < files.length && files.length / count > busiestLoad) { busiest = index; }
  });
  if (busiest === -1) { break; }
  jobCounts[busiest] = (jobCounts[busiest] ?? 1) + 1;
}
/** @type {Group[]} */
const groups = byKind.flatMap(({ kind, files }, index) => {
  const kindGroups = Array.from({ length: jobCounts[index] ?? 1 }, () => /** @type {Group} */ ({ kind, files: [] }));
  files.forEach((file, fileIndex) => { kindGroups[fileIndex % kindGroups.length]?.files.push(join(testDirectory, file)); });
  return kindGroups;
});
const profiles = await mkdtemp(join(tmpdir(), 'acp-integration-'));
const configDirectory = await mkdtemp(join(root, '.vscode-test', 'parallel-config-'));
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

/** @typedef {{ code: number, output: string }} RunResult */

/** @param {Group} group @param {number} index */
async function runGroup({ kind, files }, index) {
  const profile = join(profiles, `profile-${index}`);
  const config = join(configDirectory, `config-${index}.mjs`);
  const launchArgs = JSON.stringify([
    `--user-data-dir=${profile}`,
    '--disable-extensions',
  ]);
  // Under the run's temporary directory, so outside any Git worktree, and removed with the profiles.
  const workspaceFolder = kind.opensFolder ? join(profiles, `folder-${index}`) : undefined;
  if (workspaceFolder !== undefined) { await mkdir(workspaceFolder); }
  const configText = `import base from ${JSON.stringify(pathToFileURL(join(root, '.vscode-test.mjs')).href)};
export default {
  ...base,
  tests: [{
    files: ${JSON.stringify(files)},
    extensionDevelopmentPath: ${JSON.stringify(root)},${workspaceFolder === undefined ? '' : `
    workspaceFolder: ${JSON.stringify(workspaceFolder)},`}
    launchArgs: ${launchArgs},
    mocha: { timeout: 0 },
  }],
};\n`;

  /** @returns {Promise<RunResult>} */
  const run = () => new Promise((resolveRun) => {
    if (stopping) { resolveRun({ code: 1, output: '' }); return; }
    console.log(`[integration ${index + 1}] Starting ${kind.name} window for ${files.map((file) => relative(testDirectory, file)).join(' ')}`);
    const command = process.platform === 'linux' ? 'xvfb-run' : process.execPath;
    const display = 1000 + (process.pid % 50000) + index;
    const coverageArgs = coverageDirectory === undefined
      ? []
      : ['--coverage', '--coverage-output', join(coverageDirectory, `job-${index + 1}`)];
    const args = process.platform === 'linux'
      ? [`--server-num=${display}`, process.execPath, cli, '--config', config, ...coverageArgs]
      : [cli, '--config', config, ...coverageArgs];
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
      if (child.pid === undefined) { return; }
      if (process.platform === 'win32') {
        child.kill(signal);
      } else {
        try { process.kill(-child.pid, signal); } catch (error) {
          if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ESRCH') {
            failed = true;
            console.error(`Could not signal integration job ${index + 1}:`, error);
          }
        }
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
      clearTimeout(watchdog);
      clearTimeout(shutdownWatchdog);
      activeJobs.delete(stop);
      if (output) { process.stdout.write(`[integration ${index + 1}] ${output}`); }
      resolveRun({ code: timedOut || failed ? 1 : code ?? 1, output: completeOutput });
    });
  });
  await writeFile(config, configText);
  return run();
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
  const inotifyDetails = inotify.limit === undefined
    ? ''
    : `, ${inotify.used}/${inotify.limit} inotify instances already used, budgeting ${inotifyInstancesPerJob} per job`;
  console.log(`Running ${testFiles.length} integration files in ${groups.length} VS Code jobs, at most ${jobs} at once (default ${detectedJobs}, ${availableParallelism()} available CPUs${inotifyDetails})`);
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
} finally {
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', terminate);
  await rm(configDirectory, { recursive: true, force: true });
  await rm(profiles, { recursive: true, force: true });
}
