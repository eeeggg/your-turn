import { availableParallelism } from 'node:os';
import { readdir, readFile, readlink, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const testDirectory = join(root, 'dist', 'test');
const cli = join(root, 'node_modules', '@vscode', 'test-cli', 'out', 'bin.mjs');
const jobWatchdogMs = 10 * 60 * 1000;
const inotifyInstancesPerJob = 32;

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
const testFiles = (await readdir(testDirectory))
  .filter((file) => file.endsWith('.test.js'))
  .filter((file) => !requestedFiles || requestedFiles.includes(file))
  .sort()
  .map((file) => join(testDirectory, file));

if (testFiles.length === 0) {
  throw new Error(`No compiled integration tests found in ${testDirectory}; run make compile first`);
}

const groupCount = Math.min(jobs, testFiles.length);
const groups = Array.from({ length: groupCount }, () => /** @type {string[]} */ ([]));
testFiles.forEach((file, index) => {
  const group = groups[index % groups.length];
  if (!group) { throw new Error(`No integration group for ${file}`); }
  group.push(file);
});
const profiles = await mkdtemp(join(tmpdir(), 'acp-integration-'));
const configDirectory = await mkdtemp(join(root, '.vscode-test', 'parallel-config-'));

/** @typedef {{ code: number, output: string }} RunResult */

/** @param {string[]} group @param {number} index */
function runGroup(group, index) {
  const profile = join(profiles, `profile-${index}`);
  const config = join(configDirectory, `config-${index}.mjs`);
  const files = JSON.stringify(group);
  const launchArgs = JSON.stringify([
    `--user-data-dir=${profile}`,
    '--disable-extensions',
  ]);
  const configText = `export default {
  tests: [{
    files: ${files},
    extensionDevelopmentPath: ${JSON.stringify(root)},
    launchArgs: ${launchArgs},
    mocha: { timeout: 0 },
  }],
};\n`;

  /** @returns {Promise<RunResult>} */
  const run = () => new Promise((resolveRun) => {
    const command = process.platform === 'linux' ? 'xvfb-run' : process.execPath;
    const display = 1000 + (process.pid % 50000) + index;
    const args = process.platform === 'linux'
      ? [`--server-num=${display}`, process.execPath, cli, '--config', config]
      : [cli, '--config', config];
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, VSCODE_TEST_GROUP: String(index + 1) },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let completeOutput = '';
    let timedOut = false;
    const stop = () => {
      if (child.pid === undefined) { return; }
      if (process.platform === 'win32') {
        child.kill('SIGTERM');
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* The child may have exited already. */ }
      }
    };
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
      if (output) { process.stdout.write(`[integration ${index + 1}] ${output}`); }
      resolveRun({ code: timedOut ? 1 : code ?? 1, output: completeOutput });
    });
  });
  return writeFile(config, configText).then(run);
}

try {
  const inotifyDetails = inotify.limit === undefined
    ? ''
    : `, ${inotify.used}/${inotify.limit} inotify instances already used, budgeting ${inotifyInstancesPerJob} per job`;
  console.log(`Running ${testFiles.length} integration files in ${groups.length} VS Code jobs (default ${detectedJobs}, ${availableParallelism()} available CPUs${inotifyDetails})`);
  const results = await Promise.all(groups.map(runGroup));
  const passed = results.reduce((sum, { output }) => sum + Number(/(\d+) passing/.exec(output)?.[1] ?? 0), 0);
  const failed = results.filter(({ code }) => code !== 0);
  if (failed.length > 0) {
    console.error(`Integration run failed: ${passed} tests passed across ${failed.length} failed job(s)`);
    process.exitCode = 1;
  } else {
    console.log(`Integration run passed: ${passed} tests across ${results.length} jobs`);
  }
} finally {
  await rm(configDirectory, { recursive: true, force: true });
  await rm(profiles, { recursive: true, force: true });
}
