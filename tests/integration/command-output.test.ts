import * as assert from 'assert';
import { join } from 'node:path';
import { suite, suiteSetup, suiteTeardown, test } from 'mocha';
import * as vscode from 'vscode';
import { WorkspaceState } from '@/core/PersistedState';
import type { ExtensionTestApi } from '@/extension';
import type { ExtensionToWebviewMessage } from '@/shared/WebviewMessages';
import { initialState, update } from '@/webview/state/RootState';
import { observed } from '@tests/integration/observed';
import { cleanup } from '@tests/integration/cleanup';

/** What both fake agents' command wrote, as a terminal shows it once done. */
const SHOWN = 'PASS a.test.ts\nDownloading done\ncafé';

const named = (name: string) => vscode.window.terminals.filter((terminal) => terminal.name === name);

for (const version of [1, 2]) {
  suite(`Command Output Test Suite, ACP v${version}`, () => {
    const agentName = `fake-output-v${version}`;
    let api: ExtensionTestApi;
    let original: unknown;
    const posts: ExtensionToWebviewMessage[] = [];
    let view = initialState;
    const subscriptions: vscode.Disposable[] = [];
    const config = () => vscode.workspace.getConfiguration('your-turn');
    /** The context the chat view gives the command's output, which VS Code's menu passes to Open in Terminal. */
    const context = {
      yourTurnTitle: 'npm test',
      ...(version === 1 ? { yourTurnToolCallId: 'run-1' } : { yourTurnTerminalId: 'term-1' }),
    };
    const openInTerminal = () => {
      const target = view.transcript.projection?.target;
      assert.ok(target, 'the selected tab has an issued projection');
      return vscode.commands.executeCommand('your-turn.openCommandOutput', { ...context, yourTurnTarget: target });
    };

    suiteSetup(async () => {
      const extension = vscode.extensions.getExtension<ExtensionTestApi | undefined>('eeeggg.your-turn');
      const activated = await extension?.activate();
      assert.ok(activated, 'activate returns the test API in extension tests');
      api = activated;
      subscriptions.push(api.chatPosts((post) => {
        posts.push(post);
        view = update(view, post, Date.now()).state;
      }));
      original = config().inspect('agents')?.globalValue;
      await config().update(
        'agents',
        { [agentName]: { command: process.execPath, args: [join(__dirname, 'fixtures', `fakeAgent-v${version}.js`)], env: { ELECTRON_RUN_AS_NODE: '1' } } },
        vscode.ConfigurationTarget.Global,
      );
      await vscode.commands.executeCommand('your-turn-chat.focus');
      await api.chatViewReady;
      await vscode.commands.executeCommand('your-turn.connectAgent', agentName);
      await api.persistedStateSettled();
      const address = new WorkspaceState(api.storage.workspaceState).lastActiveSession();
      assert.ok(address, 'the created session was persisted');
      assert.strictEqual(address.configuredName, agentName);
      const promptTarget = view.transcript.projection?.target;
      assert.ok(promptTarget, 'the session has an issued projection before submission');
      await api.sendChatMessage({ type: 'sendPrompt', target: promptTarget, text: 'run' });
      await observed(api.chatPosts, () => posts.find((post) => post.type === 'promptEnd'));
      const target = view.transcript.projection?.target;
      assert.ok(target, 'the selected session has an issued projection');
      assert.strictEqual(target.configuredName, agentName);
      assert.strictEqual(target.sessionId, address.sessionId);
    });

    suiteTeardown(async function () {
      await cleanup(this.currentTest, [
        () => vscode.commands.executeCommand('your-turn.disconnectAgent', agentName),
        ...vscode.window.terminals.map((terminal) => async () => {
          let closed: () => void = () => {};
          const completion = new Promise<void>((resolve) => { closed = resolve; });
          const subscription = vscode.window.onDidCloseTerminal((ended) => { if (ended === terminal) { closed(); } });
          try { terminal.dispose(); await completion; } finally { subscription.dispose(); }
        }),
        () => config().update('agents', original, vscode.ConfigurationTarget.Global),
        ...subscriptions.map((subscription) => () => { subscription.dispose(); }),
      ]);
    });

    test("The command's output reaches the chat view as a terminal shows it, the same on both versions", async () => {
      const call = await observed(
        api.chatPosts,
        () => view.transcript.entries.flatMap((entry) => entry.kind === 'turn' ? entry.parts : [])
          .flatMap((part) => part.kind === 'toolCalls' ? part.toolCalls : [])
          .find((call) => call.toolCallId === 'run-1' && (version === 2 || call.content.some((item) => item.kind === 'commandOutput'))),
      );
      if (version === 1) {
        assert.deepStrictEqual(call.content, [{ kind: 'commandOutput', text: SHOWN, truncated: false }]);
        return;
      }
      assert.deepStrictEqual(call.content, [{ kind: 'terminal', terminalId: 'term-1' }]);
      const ended = await observed(
        api.chatPosts,
        () => {
          const terminal = view.transcript.terminals.get('term-1');
          return terminal?.exitStatus ? terminal : undefined;
        },
      );
      assert.deepStrictEqual(ended, { text: SHOWN, truncated: false, exitStatus: { exitCode: 1, signal: null } });
    });

    test('Open in Terminal, given the output\'s context, opens one VS Code terminal named for the tool call, and brings it forward when opened again', async () => {
      const outputShown = observed(vscode.window.onDidChangeActiveTerminal, () => (vscode.window.activeTerminal?.name === 'npm test' ? true : undefined));
      await openInTerminal();
      await outputShown;

      const writes = new vscode.EventEmitter<string>();
      subscriptions.push(writes);
      vscode.window.createTerminal({ name: 'another', pty: { onDidWrite: writes.event, open: () => {}, close: () => {} } }).show();
      await observed(vscode.window.onDidChangeActiveTerminal, () => (vscode.window.activeTerminal?.name === 'another' ? true : undefined));
      const broughtForward = observed(vscode.window.onDidChangeActiveTerminal, () => (vscode.window.activeTerminal?.name === 'npm test' ? true : undefined));
      await openInTerminal();

      await broughtForward;
      assert.strictEqual(named('npm test').length, 1);
    });

    test('Once the user disconnects the agent, its open tab retains output and can reopen its terminal', async () => {
      await vscode.commands.executeCommand('your-turn.disconnectAgent', agentName);
      assert.strictEqual(named('npm test').length, 1);

      const closed = observed(vscode.window.onDidCloseTerminal, () => (named('npm test').length === 0 ? true : undefined));
      named('npm test')[0]?.dispose();
      await closed;
      const reopened = observed(vscode.window.onDidOpenTerminal, () => (named('npm test').length === 1 ? true : undefined));
      await openInTerminal();
      await reopened;

      assert.strictEqual(named('npm test').length, 1);
    });
  });
}
