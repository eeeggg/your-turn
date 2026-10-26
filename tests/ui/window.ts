import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
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

interface UiFixtures {
  reviewPresentation: 'diffEditor' | 'quickDiff' | undefined;
  workspaceFiles: Record<string, string>;
  gitRepository: boolean;
  workspace: string;
  window: Page;
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
        await capture();
      } catch (error) {
        diagnostics.events.push(`Could not capture ${name}: ${errorText(error)}`);
      }
    }
  }

  if (application) {
    try {
      diagnostics.windowBounds = await application.evaluate((electron) => {
        const { BrowserWindow } = electron as unknown as ElectronMain;
        return BrowserWindow.getAllWindows().map((browserWindow) => browserWindow.getBounds());
      });
    } catch (error) {
      diagnostics.events.push(`Could not capture Electron window bounds: ${errorText(error)}`);
    }
  }
  if (profile) {
    try {
      diagnostics.extensionLogs = await vscodeLogs(profile);
    } catch (error) {
      diagnostics.events.push(`Could not capture VS Code logs: ${errorText(error)}`);
    }
  }
}

async function closeApplication(application: ElectronApplication, diagnostics: Diagnostics): Promise<Error | undefined> {
  try {
    await application.close();
    return undefined;
  } catch (error) {
    diagnostics.events.push(`Graceful VS Code close failed: ${errorText(error)}`);
    application.process().kill('SIGKILL');
    return error instanceof Error ? error : new Error(String(error));
  }
}

export const test = base.extend<UiFixtures>({
  reviewPresentation: [undefined, { option: true }],
  workspaceFiles: [{}, { option: true }],
  gitRepository: [false, { option: true }],
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

  window: async ({ workspace, reviewPresentation, gitRepository }, use, testInfo) => {
    let application: ElectronApplication | undefined;
    let profile: string | undefined;
    let extensions: string | undefined;
    let window: Page | undefined;
    let traceStarted = false;
    let originalFailure: unknown;
    const diagnostics: Diagnostics = {
      display: process.env['DISPLAY'],
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
      application = await _electron.launch({
        executablePath,
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
      if (failed) {
        await captureFailure(application, window, profile, testInfo, diagnostics);
      }
      if (application && traceStarted) {
        try {
          await application.context().tracing.stop(failed ? { path: testInfo.outputPath('trace.zip') } : undefined);
        } catch (error) {
          diagnostics.events.push(`Could not stop Electron trace: ${errorText(error)}`);
        }
      }

      const cleanupFailure = application ? await closeApplication(application, diagnostics) : undefined;
      await Promise.all([
        profile ? rm(profile, { recursive: true, force: true }) : undefined,
        extensions ? rm(extensions, { recursive: true, force: true }) : undefined,
      ]);
      if (failed) {
        await writeFile(testInfo.outputPath('diagnostics.json'), JSON.stringify(diagnostics, undefined, 2));
      }
      if (cleanupFailure && originalFailure === undefined) {
        throw cleanupFailure;
      }
    }
  },
});

export { expect } from '@playwright/test';
