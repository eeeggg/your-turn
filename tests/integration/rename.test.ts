import * as assert from 'assert';
import { join } from 'node:path';
import { suite, suiteSetup, suiteTeardown, teardown, test } from 'mocha';
import * as vscode from 'vscode';
import { WorkspaceState } from '@/core/PersistedState';
import type { ExtensionTestApi } from '@/extension';
import { cleanup } from '@tests/integration/cleanup';

suite('Renaming an agent configuration in a folder window', () => {
  const group = process.env['VSCODE_TEST_GROUP'] ?? 'default';
  const before = `fake-rename-before-${group}`;
  const after = `fake-rename-after-${group}`;
  const sessionId = `rename-${group}`;
  const entry = { command: process.execPath, args: [join(__dirname, 'fixtures', 'fakeAgent-v1.js')], env: { ELECTRON_RUN_AS_NODE: '1', ACP_TEST_SESSION_ID: sessionId } };
  const config = () => vscode.workspace.getConfiguration('acp');
  let api: ExtensionTestApi;
  let original: unknown;

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension<ExtensionTestApi | undefined>('formulahendry.acp-client');
    const activated = await extension?.activate();
    assert.ok(activated, 'the extension returns its test API in extension tests');
    api = activated;
    await api.persistedStateSettled();
    original = config().inspect('agents')?.globalValue;
  });

  teardown(async function () {
    const { workspaceState } = api.storage;
    await cleanup(this.currentTest, [
      () => vscode.commands.executeCommand('acp.disconnectAgent', before),
      () => api.persistedStateSettled(),
      ...workspaceState.keys().map((key) => () => workspaceState.update(key, undefined)),
      () => api.sessionReferences.reset(),
    ]);
  });

  suiteTeardown(async function () {
    await cleanup(this.currentTest, [() => config().update('agents', original, vscode.ConfigurationTarget.Global)]);
  });

  test("rebinds the session's reference and this workspace's last active session to the new name", async () => {
    await config().update('agents', { [before]: entry }, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('acp.connectAgent', before);
    await api.persistedStateSettled();
    const id = (configuredName: string) => ({ host: 'file://', configuredName, sessionId });
    assert.ok(api.sessionReferences.get(id(before)), 'the session has a reference under its first name');

    // Listeners run in the order they subscribed, so the extension, subscribed at activation, has handled the change by
    // the time this one runs; settling then waits for the writes it started.
    const handled = new Promise<void>((resolve) => {
      const subscription = vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('acp.agents')) {
          subscription.dispose();
          resolve();
        }
      });
    });
    await config().update('agents', { [after]: entry }, vscode.ConfigurationTarget.Global);
    await handled;
    await api.persistedStateSettled();

    assert.strictEqual(api.sessionReferences.get(id(before)), undefined);
    assert.ok(api.sessionReferences.get(id(after)), 'the reference is under the new name');
    assert.strictEqual(new WorkspaceState(api.storage.workspaceState).lastActiveSession()?.configuredName, after);
  });
});
