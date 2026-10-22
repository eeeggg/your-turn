import * as assert from 'assert';
import { join } from 'node:path';
import { suite, suiteSetup, suiteTeardown, test } from 'mocha';
import * as vscode from 'vscode';
import type { ExtensionTestApi } from '@/extension';
import type { ExtensionToWebviewMessage } from '@/shared/WebviewMessages';

type ToolCallPost = Extract<ExtensionToWebviewMessage, { type: 'toolCall' }>;
type TerminalPost = Extract<ExtensionToWebviewMessage, { type: 'terminal' }>;

async function waitFor<T>(find: () => T | undefined, what: string, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found !== undefined) {
      return found;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** What both fake agents' command wrote, as a terminal shows it once done. */
const SHOWN = 'PASS a.test.ts\nDownloading done\ncafé';

const named = (name: string) => vscode.window.terminals.filter((terminal) => terminal.name === name);

for (const version of [1, 2]) {
  suite(`Command Output Test Suite, ACP v${version}`, () => {
    const agentName = `fake-output-v${version}`;
    let api: ExtensionTestApi;
    let original: unknown;
    const posts: ExtensionToWebviewMessage[] = [];
    const subscriptions: vscode.Disposable[] = [];
    const config = () => vscode.workspace.getConfiguration('acp');
    /** The context the chat view gives the command's output, which VS Code's menu passes to Open in Terminal. */
    const context = {
      acpSessionId: 'fake-session',
      acpTitle: 'npm test',
      ...(version === 1 ? { acpToolCallId: 'run-1' } : { acpTerminalId: 'term-1' }),
    };
    const openInTerminal = () => vscode.commands.executeCommand('acp.openCommandOutput', context);

    suiteSetup(async () => {
      const extension = vscode.extensions.getExtension<ExtensionTestApi | undefined>('formulahendry.acp-client');
      const activated = await extension?.activate();
      assert.ok(activated, 'activate returns the test API in extension tests');
      api = activated;
      subscriptions.push(api.chatPosts((post) => posts.push(post)));
      original = config().inspect('agents')?.globalValue;
      await config().update(
        'agents',
        { [agentName]: { command: process.execPath, args: [join(__dirname, 'fixtures', `fakeAgent-v${version}.js`)], env: { ELECTRON_RUN_AS_NODE: '1' } } },
        vscode.ConfigurationTarget.Global,
      );
      await vscode.commands.executeCommand('acp-chat.focus');
      await api.chatViewReady;
      await vscode.commands.executeCommand('acp.connectAgent', agentName);
      await api.sendChatMessage({ type: 'sendPrompt', text: 'run' });
      await waitFor(() => posts.find((post) => post.type === 'promptEnd'), 'the turn to end');
    });

    suiteTeardown(async () => {
      await vscode.commands.executeCommand('acp.disconnectAgent', agentName);
      for (const terminal of vscode.window.terminals) {
        terminal.dispose();
      }
      await config().update('agents', original, vscode.ConfigurationTarget.Global);
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
    });

    test("The command's output reaches the chat view as a terminal shows it, the same on both versions", async () => {
      if (version === 1) {
        const call = await waitFor(
          () => posts.find((post): post is ToolCallPost => post.type === 'toolCall' && post.toolCallId === 'run-1' && post.content !== undefined),
          "the command's output",
        );
        assert.deepStrictEqual(call.content, [{ kind: 'commandOutput', text: SHOWN, truncated: false }]);
        return;
      }
      const call = await waitFor(
        () => posts.find((post): post is ToolCallPost => post.type === 'toolCall' && post.toolCallId === 'run-1'),
        'the tool call',
      );
      assert.deepStrictEqual(call.content, [{ kind: 'terminal', terminalId: 'term-1' }]);
      const ended = await waitFor(
        () => posts.find((post): post is TerminalPost => post.type === 'terminal' && post.exitStatus !== null),
        "the terminal's end",
      );
      assert.deepStrictEqual(ended, { type: 'terminal', terminalId: 'term-1', text: SHOWN, truncated: false, exitStatus: { exitCode: 1, signal: null } });
    });

    test('Open in Terminal, given the output\'s context, opens one VS Code terminal named for the tool call, and brings it forward when opened again', async () => {
      await openInTerminal();
      await waitFor(() => (vscode.window.activeTerminal?.name === 'npm test' ? true : undefined), 'the terminal to be shown');

      vscode.window.createTerminal({ name: 'another', pty: { onDidWrite: new vscode.EventEmitter<string>().event, open: () => {}, close: () => {} } }).show();
      await waitFor(() => (vscode.window.activeTerminal?.name === 'another' ? true : undefined), 'another terminal to be shown');
      await openInTerminal();

      await waitFor(() => (vscode.window.activeTerminal?.name === 'npm test' ? true : undefined), 'the terminal to be brought forward');
      assert.strictEqual(named('npm test').length, 1);
    });

    test('Once the user disconnects the agent, the terminal open on its output stays, and its output is let go', async () => {
      await vscode.commands.executeCommand('acp.disconnectAgent', agentName);
      assert.strictEqual(named('npm test').length, 1);

      named('npm test')[0]?.dispose();
      await waitFor(() => (named('npm test').length === 0 ? true : undefined), 'the terminal to close');
      await openInTerminal();
      await new Promise((resolve) => setTimeout(resolve, 300));

      assert.strictEqual(named('npm test').length, 0);
    });
  });
}
