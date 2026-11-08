import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearTraffic, captureTraffic, getTrafficJsonl, setTrafficCaptureEnabled } from '@/core/Traffic';

const host = vi.hoisted(() => {
  let configurationChanged: ((event: { affectsConfiguration(section: string): boolean }) => void) | undefined;
  const configuration: { logTraffic: boolean | undefined } = { logTraffic: true };
  let affectedConfiguration = 'your-turn.logTraffic';
  const showSaveDialog = vi.fn<() => Promise<{ fsPath: string } | undefined>>();
  const writeFile = vi.fn(async (_uri: { fsPath: string }, _bytes: Uint8Array) => {});
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
  return {
    configuration,
    showSaveDialog,
    writeFile,
    commands,
    workspaceFolders,
    getConfiguration: vi.fn((section: string) => ({ get: (_key: string, fallback?: boolean) => section === 'your-turn' ? configuration.logTraffic ?? fallback : fallback })),
    onDidChangeConfiguration: vi.fn((listener: typeof configurationChanged) => {
      configurationChanged = listener;
      return { dispose: () => { configurationChanged = undefined; } };
    }),
    registerCommand: vi.fn((name: string, callback: (...args: unknown[]) => unknown) => {
      commands.set(name, callback);
      return { dispose: () => { commands.delete(name); } };
    }),
    setAffectedConfiguration: (section: string) => { affectedConfiguration = section; },
    fireConfigurationChanged: () => configurationChanged?.({ affectsConfiguration: (section) => section === affectedConfiguration }),
  };
});

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: host.getConfiguration,
    onDidChangeConfiguration: host.onDidChangeConfiguration,
    workspaceFolders: host.workspaceFolders,
    fs: { writeFile: host.writeFile },
  },
  window: { showSaveDialog: host.showSaveDialog },
  commands: { registerCommand: host.registerCommand },
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
    joinPath: (base: { fsPath: string }, ...segments: string[]) => ({ fsPath: `${base.fsPath}/${segments.join('/')}` }),
  },
}));

import { exportTraffic, registerTrafficAdapter } from '@/adapters/Traffic';

describe('ACP Traffic adapter', () => {
  const subscriptions: { dispose(): void }[] = [];

  afterEach(() => {
    for (const subscription of subscriptions.splice(0)) { subscription.dispose(); }
    clearTraffic();
    setTrafficCaptureEnabled(true);
    host.configuration.logTraffic = true;
    host.setAffectedConfiguration('your-turn.logTraffic');
    host.showSaveDialog.mockReset();
    host.writeFile.mockClear();
    host.commands.clear();
    vi.restoreAllMocks();
  });

  it('applies the capture setting and follows changes to that setting', () => {
    host.configuration.logTraffic = false;
    registerTrafficAdapter(subscriptions);
    captureTraffic('send', { id: 1 });
    expect(getTrafficJsonl()).toBe('');

    host.configuration.logTraffic = true;
    host.setAffectedConfiguration('your-turn.logTraffic');
    host.fireConfigurationChanged();
    captureTraffic('send', { id: 2 });

    expect(getTrafficJsonl()).toContain('"id":2');
  });

  it('does not capture traffic when no setting is available', () => {
    host.configuration.logTraffic = undefined;
    registerTrafficAdapter(subscriptions);

    captureTraffic('send', { id: 1 });

    expect(getTrafficJsonl()).toBe('');
  });

  it('disables capture and clears retained messages when disposed', () => {
    registerTrafficAdapter(subscriptions);
    captureTraffic('send', { id: 1 });
    expect(getTrafficJsonl()).toContain('"id":1');

    for (const subscription of subscriptions.splice(0)) { subscription.dispose(); }
    captureTraffic('send', { id: 2 });

    expect(getTrafficJsonl()).toBe('');
  });

  it('ignores configuration changes unrelated to traffic capture', () => {
    host.configuration.logTraffic = false;
    registerTrafficAdapter(subscriptions);
    host.configuration.logTraffic = true;
    host.setAffectedConfiguration('your-turn.agents');
    host.fireConfigurationChanged();
    captureTraffic('send', { id: 3 });

    expect(getTrafficJsonl()).toBe('');
  });

  it('registers the export command and cancellation does not write a file', async () => {
    host.showSaveDialog.mockResolvedValue(undefined);
    registerTrafficAdapter(subscriptions);
    captureTraffic('send', { method: 'initialize' });

    const command = host.commands.get('your-turn.exportTraffic');
    expect(command).toBeDefined();
    if (!command) { throw new Error('Export command was not registered'); }
    await command();

    expect(host.showSaveDialog).toHaveBeenCalledOnce();
    expect(host.writeFile).not.toHaveBeenCalled();
  });

  it('suggests a JSONL filename in the first workspace folder', async () => {
    host.showSaveDialog.mockResolvedValue(undefined);

    await exportTraffic();

    expect(host.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({
      defaultUri: { fsPath: '/workspace/acp-traffic.jsonl' },
    }));
  });

  it('exports the complete retained JSONL only to the URI selected by the user', async () => {
    const destination = { fsPath: '/tmp/export.jsonl' };
    host.showSaveDialog.mockResolvedValue(destination);
    clearTraffic();
    setTrafficCaptureEnabled(true);
    captureTraffic('recv', { method: 'session/update', params: { text: 'retained' } });
    const retained = getTrafficJsonl();

    await exportTraffic();

    expect(host.writeFile).toHaveBeenCalledOnce();
    expect(host.writeFile).toHaveBeenCalledWith(destination, new TextEncoder().encode(retained));
  });
});
