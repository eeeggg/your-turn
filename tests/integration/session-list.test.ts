import * as assert from 'assert';
import { join } from 'node:path';
import { suite, suiteSetup, suiteTeardown, test } from 'mocha';
import * as vscode from 'vscode';
import type { AgentSessions } from '@/core/SessionList';
import type { ExtensionTestApi } from '@/extension';
import { cleanup } from '@tests/integration/cleanup';

for (const version of [1, 2]) {
  suite(`Session list, ACP v${version}`, () => {
    const agentName = `fake-list-v${version}`;
    let api: ExtensionTestApi;
    let original: unknown;
    const config = () => vscode.workspace.getConfiguration('your-turn');

    suiteSetup(async () => {
      const extension = vscode.extensions.getExtension<ExtensionTestApi | undefined>('eeeggg.your-turn');
      const activated = await extension?.activate();
      assert.ok(activated, 'activate returns the test API in extension tests');
      api = activated;
      original = config().inspect('agents')?.globalValue;
      await config().update(
        'agents',
        { [agentName]: { command: process.execPath, args: [join(__dirname, 'fixtures', `fakeAgent-v${version}.js`)], env: { ELECTRON_RUN_AS_NODE: '1', ACP_TEST_LISTS_SESSIONS: '1' } } },
        vscode.ConfigurationTarget.Global,
      );
    });

    suiteTeardown(async function () {
      await cleanup(this.currentTest, [
        () => vscode.commands.executeCommand('your-turn.disconnectAgent', agentName),
        () => config().update('agents', original, vscode.ConfigurationTarget.Global),
      ]);
    });

    const shown = (sessions: AgentSessions) => (sessions.kind === 'listed' ? sessions.rows.map((row) => row.label) : sessions.kind);

    /** What is shown once the agent's sessions have been listed, asking for them if no one has. */
    async function listed(): Promise<string[] | AgentSessions['kind']> {
      for (;;) {
        let subscription: vscode.Disposable | undefined;
        const changed = new Promise<void>((resolve) => { subscription = api.sessionsChanged(() => { resolve(); }); });
        try {
          const sessions = await api.sessionsOf(agentName);
          if (sessions.kind !== 'loading') {
            return shown(sessions);
          }
          await changed;
        } finally {
          subscription?.dispose();
        }
      }
    }

    test('Refresh Sessions shows what the agent lists now in place of what it listed before', async () => {
      assert.deepStrictEqual(await listed(), ['Listed 1']);

      await vscode.commands.executeCommand('your-turn.refreshSessions', agentName);

      assert.deepStrictEqual(shown(await api.sessionsOf(agentName)), ['Listed 2']);
    });
  });
}
