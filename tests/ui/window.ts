import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { listenControl } from '@tests/ui/instrumentation/ControlChannel';
import { isValid, parseISO } from 'date-fns';
import {
  _electron,
  test as base,
  type ConsoleMessage,
  type ElectronApplication,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { yourTurnContainerControl } from '@tests/ui/workbench';

const root = resolve(__dirname, '../..');
const extensionPath = join(root, 'test-results/ui-extension');
const windowSize = { width: 1400, height: 900 };
const teardownWatchdogMs = 5000;
const processOutputLimit = 20_000;

async function duringTeardown<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolveAction, reject) => {
    const aborted = () => { reject(signal.reason instanceof Error ? signal.reason : new Error('UI teardown aborted')); };
    signal.addEventListener('abort', aborted, { once: true });
    void action().then(resolveAction, reject).finally(() => { signal.removeEventListener('abort', aborted); });
  });
}

interface UiFixtures {
  agentVersion: 'v1' | 'v2';
  reviewPresentation: 'diffEditor' | 'quickDiff' | undefined;
  workspaceFiles: Record<string, string>;
  gitRepository: boolean;
  listsSessions: boolean;
  compaction: boolean;
  preSessionQuestion: boolean;
  authenticationQuestion: boolean;
  controlledTreeRefresh: boolean;
  controlledReviewPresentation: boolean;
  controlledNativeDiff: boolean;
  nativeDiffControl: UiFixtures['reviewPresentationControl'];
  reviewPresentationControl: { port: number; request(command: string, response: string): Promise<void>; close(): Promise<void> } | undefined;
  treeRefresh: { port: number; hold(): Promise<void>; release(): Promise<void>; close(): Promise<void> } | undefined;
  workspace: string;
  window: Page;
  display: string | undefined;
}

interface Diagnostics {
  display: string | undefined;
  events: string[];
  extensionLogs: Record<string, string>;
  timeline: { event: string; at: string; elapsedMs: number; phase: 'setup' | 'test' | 'cleanup'; code?: number | null; signal?: string | null }[];
  stdout: { text: string; truncated: boolean };
  stderr: { text: string; truncated: boolean };
  renderer?: {
    inner: { width: number; height: number };
    outer: { width: number; height: number };
    screen: { width: number; height: number; availableWidth: number; availableHeight: number };
  };
  windowBounds?: { x: number; y: number; width: number; height: number }[];
}

interface ElectronWindow {
  getBounds(): { x: number; y: number; width: number; height: number };
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
}

interface ElectronMain {
  BrowserWindow: { getAllWindows(): ElectronWindow[] };
}

function errorText(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

async function vscodeLogs(profile: string): Promise<Record<string, string>> {
  const directory = join(profile, 'logs');
  const found: string[] = [];
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        await visit(child);
      } else if (entry.isFile() && entry.name.endsWith('.log')) {
        const name = relative(directory, child);
        const parts = name.split(/[\\/]/);
        const mainLog = parts.length === 2 && parts[1] === 'main.log' && isValid(parseISO(parts[0] ?? ''));
        if (mainLog || /\/renderer\.log$|\/exthost\/exthost\.log$|Your Turn\.log$/.test(name)) {
          found.push(child);
        }
      }
    }
  }

  try {
    await visit(directory);
  } catch {
    return {};
  }

  const logs: Record<string, string> = {};
  for (const path of found.sort((left, right) => left.localeCompare(right)).slice(0, 30)) {
    const text = await readFile(path, 'utf8');
    logs[relative(directory, path)] = text.slice(-20_000);
  }
  return logs;
}

function recordConsole(source: string, message: ConsoleMessage, diagnostics: Diagnostics): void {
  if (message.type() === 'warning' || message.type() === 'error') {
    diagnostics.events.push(`[${source}:${message.type()}] ${message.text()}`);
  }
}

async function captureFailure(
  application: ElectronApplication | undefined,
  window: Page | undefined,
  profile: string | undefined,
  testInfo: TestInfo,
  diagnostics: Diagnostics,
  signal: AbortSignal,
): Promise<void> {
  if (profile) {
    try {
      diagnostics.extensionLogs = await duringTeardown(signal, () => vscodeLogs(profile));
    } catch (error) {
      signal.throwIfAborted();
      diagnostics.events.push(`Could not capture VS Code logs: ${errorText(error)}`);
    }
  }
  if (window && !window.isClosed()) {
    for (const [name, capture] of [
      ['screenshot', () => window.screenshot({ path: testInfo.outputPath('failure.png') })],
      ['workbench DOM', async () => {
        await writeFile(testInfo.outputPath('workbench.html'), await window.locator('body').evaluate((body) => body.outerHTML));
      }],
      ['renderer dimensions', async () => {
        diagnostics.renderer = await window.evaluate(() => ({
          inner: { width: globalThis.innerWidth, height: globalThis.innerHeight },
          outer: { width: globalThis.outerWidth, height: globalThis.outerHeight },
          screen: {
            width: globalThis.screen.width,
            height: globalThis.screen.height,
            availableWidth: globalThis.screen.availWidth,
            availableHeight: globalThis.screen.availHeight,
          },
        }));
      }],
    ] as const) {
      try {
        await duringTeardown<unknown>(signal, capture);
      } catch (error) {
        signal.throwIfAborted();
        diagnostics.events.push(`Could not capture ${name}: ${errorText(error)}`);
      }
    }
  }

  if (application) {
    try {
      diagnostics.windowBounds = await duringTeardown(signal, () => application.evaluate((electron) => {
        const { BrowserWindow } = electron as unknown as ElectronMain;
        return BrowserWindow.getAllWindows().map((browserWindow) => browserWindow.getBounds());
      }));
    } catch (error) {
      signal.throwIfAborted();
      diagnostics.events.push(`Could not capture Electron window bounds: ${errorText(error)}`);
    }
  }
}

export const test = base.extend<UiFixtures>({
  agentVersion: ['v1', { option: true }],
  reviewPresentation: [undefined, { option: true }],
  workspaceFiles: [{}, { option: true }],
  gitRepository: [false, { option: true }],
  listsSessions: [false, { option: true }],
  compaction: [false, { option: true }],
  preSessionQuestion: [false, { option: true }],
  authenticationQuestion: [false, { option: true }],
  controlledTreeRefresh: [false, { option: true }],
  controlledReviewPresentation: [false, { option: true }],
  controlledNativeDiff: [false, { option: true }],
  nativeDiffControl: async ({ controlledNativeDiff }, use) => {
    if (!controlledNativeDiff) { await use(undefined); return; }
    const control = await listenControl();
    try { await use(control); } finally { await control.close(); }
  },
  reviewPresentationControl: async ({ controlledReviewPresentation }, use) => {
    if (!controlledReviewPresentation) { await use(undefined); return; }
    const control = await listenControl();
    try { await use(control); } finally { await control.close(); }
  },
  treeRefresh: async ({ controlledTreeRefresh }, use) => {
    if (!controlledTreeRefresh) { await use(undefined); return; }
    const control = await listenControl();
    try {
      await use({ port: control.port, hold: () => control.request('hold', 'pending'), release: () => control.request('release', 'settled'), close: () => control.close() });
    } finally {
      await control.close();
    }
  },
  display: async ({}, use) => {
    if (process.platform !== 'linux') { await use(process.env['DISPLAY']); return; }
    const server = spawn('Xvfb', ['-displayfd', '1', '-screen', '0', '1600x1000x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostic = '';
    server.stderr.setEncoding('utf8').on('data', (text: string) => { diagnostic += text; });
    const closed = new Promise<void>((resolveClosed) => { server.once('close', () => { resolveClosed(); }); });
    try {
      const display = await new Promise<string>((resolveDisplay, reject) => {
        let output = '';
        const failed = (error: Error) => { finished(); reject(error); };
        const exited = () => { failed(new Error(`Xvfb closed before readiness: ${diagnostic}`)); };
        const ready = (text: string) => {
          output += text;
          if (!output.includes('\n')) { return; }
          finished();
          if (/^\d+\n$/.test(output)) { resolveDisplay(`:${output.trim()}`); }
          else { reject(new Error(`Invalid Xvfb display: ${output}`)); }
        };
        const watchdog = setTimeout(() => { failed(new Error('Xvfb readiness watchdog expired')); }, 10_000);
        function finished() {
          clearTimeout(watchdog);
          server.off('error', failed);
          server.off('close', exited);
          server.stdout.off('data', ready);
        }
        server.once('error', failed);
        server.once('close', exited);
        server.stdout.setEncoding('utf8').on('data', ready);
      });
      await use(display);
    } finally {
      const watchdog = setTimeout(() => { server.kill('SIGKILL'); }, teardownWatchdogMs);
      try { server.kill('SIGTERM'); await closed; } finally { clearTimeout(watchdog); }
    }
  },
  workspace: async ({ workspaceFiles, gitRepository }, use) => {
    const workspace = await mkdtemp(join(tmpdir(), 'ui-workspace-'));
    try {
      await Promise.all(Object.entries(workspaceFiles).map(([name, text]) => writeFile(join(workspace, name), text)));
      if (gitRepository) {
        const run = promisify(execFile);
        await run('git', ['init', '--quiet', workspace]);
        await run('git', ['-C', workspace, 'add', '.']);
      }
      await use(workspace);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  },

  window: async ({ workspace, reviewPresentation, gitRepository, listsSessions, compaction, preSessionQuestion, authenticationQuestion, agentVersion, display, treeRefresh, reviewPresentationControl, nativeDiffControl }, use, testInfo) => {
    const closeControls = async () => { await Promise.all([treeRefresh?.close(), reviewPresentationControl?.close(), nativeDiffControl?.close()]); };
    const executablePath = process.env['UI_VSCODE_EXECUTABLE'];
    if (!executablePath) {
      await closeControls();
      throw new Error('UI editor is not prepared; use npm run test:ui');
    }
    try {
      const manifest = JSON.parse(await readFile(join(extensionPath, 'package.json'), 'utf8')) as Record<string, unknown>;
      if (manifest['name'] !== 'your-turn' || manifest['publisher'] !== 'eeeggg'
        || manifest['main'] !== './dist/extension.js' || manifest['yourTurnDesktopTest'] !== true) {
        throw new Error('Invalid desktop artifact identity');
      }
    } catch (cause) {
      await closeControls();
      throw new Error('Desktop extension artifact is not prepared; use npm run test:ui', { cause });
    }
    let application: ElectronApplication | undefined;
    let applicationProcess: ChildProcess | undefined;
    let profile: string | undefined;
    let extensions: string | undefined;
    let window: Page | undefined;
    let traceStarted = false;
    let originalFailure: unknown;
    let processClosed: Promise<void> | undefined;
    let phase: 'setup' | 'test' | 'cleanup' = 'setup';
    const started = performance.now();
    const diagnostics: Diagnostics = {
      display,
      events: [],
      extensionLogs: {},
      timeline: [],
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
    };
    const record = (event: string, details: { code?: number | null; signal?: string | null } = {}) => {
      diagnostics.timeline.push({ event, at: new Date().toISOString(), elapsedMs: performance.now() - started, phase, ...details });
    };
    const output = (stream: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const tail = diagnostics[stream];
      const text = tail.text + chunk.toString();
      tail.truncated ||= text.length > processOutputLimit;
      tail.text = text.slice(-processOutputLimit);
    };

    try {
      profile = await mkdtemp(join(tmpdir(), 'ui-profile-'));
      extensions = await mkdtemp(join(tmpdir(), 'ui-extensions-'));
      await mkdir(join(profile, 'User'), { recursive: true });
      await writeFile(join(profile, 'User', 'settings.json'), JSON.stringify({
        'extensions.autoCheckUpdates': false,
        'extensions.autoUpdate': false,
        'files.simpleDialog.enable': true,
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none',
        'window.dialogStyle': 'custom',
        'workbench.startupEditor': 'none',
        ...(gitRepository ? { 'git.enabled': true } : {}),
        ...(reviewPresentation ? { 'your-turn.review.presentation': reviewPresentation } : {}),
        'your-turn.agents': {
          [`fake-${agentVersion}`]: {
            command: process.execPath,
            args: [join(extensionPath, 'dist', 'test', 'fixtures', `fakeAgent-${agentVersion}.js`)],
            env: {
              ACP_TEST_SESSION_ID: `ui-${testInfo.testId}`,
              ELECTRON_RUN_AS_NODE: '1',
              ...(listsSessions ? { ACP_TEST_LISTS_SESSIONS: '1' } : {}),
              ...(compaction ? { ACP_TEST_COMPACTION: '1' } : {}),
              ...(preSessionQuestion ? { ACP_TEST_PRE_SESSION_QUESTION: '1' } : {}),
              ...(authenticationQuestion ? { ACP_TEST_AUTHENTICATION_QUESTION: '1' } : {}),
            },
          },
        },
      }, undefined, 2));

      const contained = process.platform === 'linux';
      record('launch started');
      application = await _electron.launch({
        executablePath: contained ? join(root, 'tests/ui/electron.sh') : executablePath,
        env: {
          ...process.env,
          UI_TREE_REFRESH_PORT: treeRefresh ? String(treeRefresh.port) : '',
          UI_REVIEW_PRESENTATION_PORT: reviewPresentationControl ? String(reviewPresentationControl.port) : '',
          UI_NATIVE_DIFF_PORT: nativeDiffControl ? String(nativeDiffControl.port) : '',
          ...(display ? { DISPLAY: display } : {}),
          ...(contained ? { UI_EXECUTABLE: executablePath, UI_STATUS: join(profile, 'namespace.jsonl') } : {}),
        },
        cwd: root,
        args: [
          '--disable-updates',
          '--force-disable-user-env',
          '--log=debug',
          '--disable-workspace-trust',
          '--new-window',
          '--skip-release-notes',
          '--skip-welcome',
          `--user-data-dir=${profile}`,
          `--shared-data-dir=${join(profile, 'shared-data')}`,
          `--extensions-dir=${extensions}`,
          `--extensionDevelopmentPath=${extensionPath}`,
          workspace,
        ],
      });
      record('launch completed');
      const child = application.process();
      applicationProcess = child;
      child.stdout?.on('data', (chunk: Buffer | string) => output('stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer | string) => output('stderr', chunk));
      child.once('exit', (code, signal) => record('process exited', { code, signal }));
      if (child.exitCode !== null || child.signalCode !== null) {
        record('process exited', { code: child.exitCode, signal: child.signalCode });
      }
      processClosed = new Promise<void>((resolveClosed) => {
        child.once('close', resolveClosed);
        if ((child.exitCode !== null || child.signalCode !== null) && child.stdout?.closed !== false && child.stderr?.closed !== false) {
          resolveClosed();
        }
      });
      application.on('console', (message) => recordConsole('electron', message, diagnostics));
      application.on('close', () => record('application closed'));
      try {
        await application.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
        traceStarted = true;
      } catch (error) {
        diagnostics.events.push(`Electron tracing is unavailable: ${errorText(error)}`);
      }

      window = await application.firstWindow();
      record('first window obtained');
      window.on('console', (message) => recordConsole('renderer', message, diagnostics));
      window.on('pageerror', (error) => diagnostics.events.push(`[renderer:error] ${errorText(error)}`));
      window.on('crash', () => record('renderer crashed'));
      window.on('close', () => record('window closed'));
      await application.evaluate((electron, size) => {
        const { BrowserWindow } = electron as unknown as ElectronMain;
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, ...size });
      }, windowSize);

      await yourTurnContainerControl(window).waitFor({ state: 'visible' });
      record('workbench ready');
      phase = 'test';
      record('test body started');
      await use(window);
    } catch (error) {
      originalFailure = error;
      throw error;
    } finally {
      phase = 'cleanup';
      record('cleanup started');
      const failed = originalFailure !== undefined || testInfo.status !== testInfo.expectedStatus;
      let cleanupFailure: unknown;
      let forcedShutdown: Promise<void> | undefined;
      const teardown = new AbortController();
      const forceShutdown = () => {
        void closeControls();
        const child = applicationProcess;
        if (forcedShutdown || !child) { return; }
        forcedShutdown = (async () => {
          if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
            try {
              if (process.platform === 'win32') {
                await promisify(execFile)('taskkill', ['/pid', String(child.pid), '/T', '/F']);
              } else if (process.platform === 'linux') {
                try {
                  const status = await readFile(join(profile ?? '', 'namespace.jsonl'), 'utf8');
                  const details = JSON.parse(status.split('\n')[0] ?? '') as { 'child-pid'?: unknown };
                  const pid = details['child-pid'];
                  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1) { throw new Error('Invalid UI namespace PID'); }
                  process.kill(pid, 'SIGKILL');
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
                    diagnostics.events.push(`UI namespace status unavailable; terminating the contained launch group: ${errorText(error)}`);
                    process.kill(-child.pid, 'SIGKILL');
                  }
                }
              } else {
                // Playwright launches Electron in a private process group on POSIX.
                process.kill(-child.pid, 'SIGKILL');
              }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { throw error; }
            }
          }
          await processClosed;
        })().catch((error: unknown) => {
          cleanupFailure ??= error;
          diagnostics.events.push(`Forced VS Code close failed: ${errorText(error)}`);
        });
      };
      // A dead renderer must not block diagnostics or leave the application alive.
      const watchdog = setTimeout(() => {
        cleanupFailure ??= new Error('UI teardown watchdog expired');
        diagnostics.events.push('UI teardown watchdog expired; terminating the owned application');
        teardown.abort(cleanupFailure);
        forceShutdown();
      }, teardownWatchdogMs);
      try {
        if (failed) {
          try {
            await captureFailure(application, window, profile, testInfo, diagnostics, teardown.signal);
          } catch (error) {
            diagnostics.events.push(`Could not capture failure diagnostics: ${errorText(error)}`);
          }
        }
        if (application && traceStarted) {
          const running = application;
          try {
            await duringTeardown(teardown.signal, () => running.context().tracing.stop(failed ? { path: testInfo.outputPath('trace.zip') } : undefined));
          } catch (error) {
            diagnostics.events.push(`Could not stop Electron trace: ${errorText(error)}`);
          }
        }
      } finally {
        try {
          await closeControls();
          if (application) {
            const running = application;
            try {
              await duringTeardown(teardown.signal, () => running.close());
            } catch (error) {
              cleanupFailure ??= error;
              diagnostics.events.push(`Graceful VS Code close failed: ${errorText(error)}`);
              forceShutdown();
            }
            await forcedShutdown;
            await processClosed;
          }
        } finally {
          clearTimeout(watchdog);
          const removed = await Promise.allSettled([
            profile ? rm(profile, { recursive: true, force: true }) : undefined,
            extensions ? rm(extensions, { recursive: true, force: true }) : undefined,
          ]);
          for (const result of removed) {
            if (result.status === 'rejected') {
              const error: unknown = result.reason;
              cleanupFailure ??= error;
              diagnostics.events.push(`Could not remove UI fixture directory: ${errorText(error)}`);
            }
          }
        }
      }
      record('cleanup completed');
      try {
        await writeFile(testInfo.outputPath('diagnostics.json'), JSON.stringify(diagnostics, undefined, 2));
      } catch (error) {
        cleanupFailure ??= error;
      }
      if (cleanupFailure !== undefined && originalFailure === undefined) {
        throw cleanupFailure instanceof Error ? cleanupFailure : new Error(errorText(cleanupFailure));
      }
    }
  },
});

export { expect } from '@playwright/test';
