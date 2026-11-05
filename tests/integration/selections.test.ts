import * as assert from 'assert';
import { join } from 'node:path';
import { suite, suiteSetup, suiteTeardown, teardown, test } from 'mocha';
import * as vscode from 'vscode';
import type { ExtensionTestApi } from '@/extension';
import { cleanup } from '@tests/integration/cleanup';

for (const version of [1, 2]) {
  suite(`Saved selections, ACP v${version}`, () => {
    const agentName = `fake-selections-v${version}`;
    const sessionId = `selections-${process.env['VSCODE_TEST_GROUP'] ?? 'default'}-${version}`;
    const config = () => vscode.workspace.getConfiguration('your-turn');
    let api: ExtensionTestApi;
    let original: unknown;

    suiteSetup(async () => {
      const extension = vscode.extensions.getExtension<ExtensionTestApi | undefined>('eeeggg.your-turn');
      const activated = await extension?.activate();
      assert.ok(activated, 'the extension returns its test API in extension tests');
      api = activated;
      await api.persistedStateSettled();
      original = config().inspect('agents')?.globalValue;
      await config().update(
        'agents',
        { [agentName]: { command: process.execPath, args: [join(__dirname, 'fixtures', `fakeAgent-v${version}.js`)], env: { ELECTRON_RUN_AS_NODE: '1', ACP_TEST_SESSION_ID: sessionId } } },
        vscode.ConfigurationTarget.Global,
      );
    });

    teardown(async function () {
      const { workspaceState } = api.storage;
      await cleanup(this.currentTest, [
        () => vscode.commands.executeCommand('your-turn.disconnectAgent', agentName),
        () => api.persistedStateSettled(),
        ...workspaceState.keys().map((key) => () => workspaceState.update(key, undefined)),
        () => api.sessionReferences.reset(),
      ]);
    });

    suiteTeardown(async function () {
      await cleanup(this.currentTest, [() => config().update('agents', original, vscode.ConfigurationTarget.Global)]);
    });

    const saved = () => api.sessionReferences.get({ host: 'file://', configuredName: agentName, sessionId })?.selections;

    test('saves the options as the user changes them above the prompt, then as the agent changes them itself', async () => {
      await vscode.commands.executeCommand('your-turn.connectAgent', agentName);

      await api.sendChatMessage({ type: 'pickerValueChosen', pickerId: 'model', value: 'model-b' });
      await api.persistedStateSettled();
      assert.deepStrictEqual(saved(), { options: { model: 'model-b' } });

      await api.sendChatMessage({ type: 'sendPrompt', text: 'switch model-a' });
      await api.persistedStateSettled();
      assert.deepStrictEqual(saved(), { options: { model: 'model-a' } });
    });
  });
}
