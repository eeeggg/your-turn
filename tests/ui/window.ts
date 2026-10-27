import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import {
  _electron,
  test as base,
  type ConsoleMessage,
  type ElectronApplication,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { acpContainerControl } from './workbench';

const root = resolve(__dirname, '../..');
const vscodeVersion = '1.143.1';
const windowSize = { width: 1400, height: 900 };
const teardownWatchdogMs = 5000;

async function duringTeardown<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolveAction, reject) => {
    const aborted = () => { reject(signal.reason instanceof Error ? signal.reason : new Error('UI teardown aborted')); };
    signal.addEventListener('abort', aborted, { once: true });
    void action().then(resolveAction, reject).finally(() => { signal.removeEventListener('abort', aborted); });
  });
}

interface UiFixtures {
  reviewPresentation: 'diffEditor' | 'quickDiff' | undefined;
  workspaceFiles: Record<string, string>;
  gitRepository: boolean;
  workspace: string;
  window: Page;
  display: string | undefined;
}

interface Diagnostics {
  display: string | undefined;
  events: string[];
  extensionLogs: Record<string, string>;
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
        if (/^\d+\/main\.log$|\/exthost\/exthost\.log$|ACP Client\.log$/.test(name)) {
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
  if (profile) {
    try {
      diagnostics.extensionLogs = await duringTeardown(signal, () => vscodeLogs(profile));
    } catch (error) {
      signal.throwIfAborted();
      diagnostics.events.push(`Could not capture VS Code logs: ${errorText(error)}`);
    }
  }
}

export const test = base.extend<UiFixtures>({
  reviewPresentation: [undefined, { option: true }],
  workspaceFiles: [{}, { option: true }],
  gitRepository: [false, { option: true }],
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
    const workspace = await mkdtemp(join(tmpdir(), 'acp-ui-workspace-'));
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

  window: async ({ workspace, reviewPresentation, gitRepository, display }, use, testInfo) => {
    let application: ElectronApplication | undefined;
    let applicationProcess: ChildProcess | undefined;
    let profile: string | undefined;
    let extensions: string | undefined;
    let window: Page | undefined;
    let traceStarted = false;
    let originalFailure: unknown;
    let processClosed: Promise<void> | undefined;
    const diagnostics: Diagnostics = {
      display,
      events: [],
      extensionLogs: {},
    };

    try {
      profile = await mkdtemp(join(tmpdir(), 'acp-ui-profile-'));
      extensions = await mkdtemp(join(tmpdir(), 'acp-ui-extensions-'));
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
        ...(reviewPresentation ? { 'acp.review.presentation': reviewPresentation } : {}),
        'acp.agents': {
          'fake-v1': {
            command: process.execPath,
            args: [join(root, 'dist', 'test', 'fixtures', 'fakeAgent-v1.js')],
            env: {
              ACP_TEST_SESSION_ID: `ui-${testInfo.testId}`,
              ELECTRON_RUN_AS_NODE: '1',
            },
          },
        },
      }, undefined, 2));

      const executablePath = await downloadAndUnzipVSCode({
        version: vscodeVersion,
        cachePath: join(root, '.vscode-test'),
      });
      const contained = process.platform === 'linux';
      application = await _electron.launch({
        executablePath: contained ? join(root, 'tests/ui/electron.sh') : executablePath,
        env: {
          ...process.env,
          ...(display ? { DISPLAY: display } : {}),
          ...(contained ? { ACP_UI_EXECUTABLE: executablePath, ACP_UI_STATUS: join(profile, 'namespace.jsonl') } : {}),
        },
        cwd: root,
        args: [
          '--disable-updates',
          '--disable-workspace-trust',
          '--new-window',
          '--skip-release-notes',
          '--skip-welcome',
          `--user-data-dir=${profile}`,
          `--extensions-dir=${extensions}`,
          `--extensionDevelopmentPath=${root}`,
          workspace,
        ],
      });
      const child = application.process();
      applicationProcess = child;
      processClosed = new Promise<void>((resolveClosed) => {
        child.once('close', resolveClosed);
        if ((child.exitCode !== null || child.signalCode !== null) && child.stdout?.closed !== false && child.stderr?.closed !== false) {
          resolveClosed();
        }
      });
      application.on('console', (message) => recordConsole('electron', message, diagnostics));
      try {
        await application.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
        traceStarted = true;
      } catch (error) {
        diagnostics.events.push(`Electron tracing is unavailable: ${errorText(error)}`);
      }

      window = await application.firstWindow();
      window.on('console', (message) => recordConsole('renderer', message, diagnostics));
      window.on('pageerror', (error) => diagnostics.events.push(`[renderer:error] ${errorText(error)}`));
      await application.evaluate((electron, size) => {
        const { BrowserWindow } = electron as unknown as ElectronMain;
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, ...size });
      }, windowSize);

      await acpContainerControl(window).waitFor({ state: 'visible' });
      await use(window);
    } catch (error) {
      originalFailure = error;
      throw error;
    } finally {
      const failed = originalFailure !== undefined || testInfo.status !== testInfo.expectedStatus;
      let cleanupFailure: unknown;
      let forcedShutdown: Promise<void> | undefined;
      const teardown = new AbortController();
      const forceShutdown = () => {
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
      if (failed || cleanupFailure !== undefined) {
        try {
          await writeFile(testInfo.outputPath('diagnostics.json'), JSON.stringify(diagnostics, undefined, 2));
        } catch (error) {
          cleanupFailure ??= error;
        }
      }
      if (cleanupFailure !== undefined && originalFailure === undefined) {
        throw cleanupFailure instanceof Error ? cleanupFailure : new Error(errorText(cleanupFailure));
      }
    }
  },
});

export { expect } from '@playwright/test';
