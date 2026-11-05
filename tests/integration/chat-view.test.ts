import * as assert from 'assert';
import { suite, test } from 'mocha';
import * as vscode from 'vscode';
import { ChatWebviewProvider } from '@/adapters/ChatWebviewProvider';
import type { ExtensionTestApi } from '@/extension';

suite('Chat View Test Suite', () => {
  test('Boots when focused: its script loads and its first message reaches the extension', async () => {
    const extension = vscode.extensions.getExtension<ExtensionTestApi | undefined>('eeeggg.your-turn');
    assert.ok(extension);
    const api = await extension.activate();
    assert.ok(api, 'activate returns the test API in extension tests');

    await vscode.commands.executeCommand('your-turn-chat.focus');

    await api.chatViewReady;
  });

  test('Gives out its webview while the view exists, and withdraws it once the view is disposed', () => {
    const given: (vscode.Webview | undefined)[] = [];
    const provider = new ChatWebviewProvider(vscode.Uri.file('/extension'), (webview) => { given.push(webview); });
    const disposed = new vscode.EventEmitter<void>();
    const messages = new vscode.EventEmitter<unknown>();
    const tokens = new vscode.CancellationTokenSource();
    // VS Code alone resolves the registered chat view, so the view here is a stand-in with a real webview's surface.
    const webview: vscode.Webview = {
      options: {},
      html: '',
      cspSource: 'test',
      asWebviewUri: (uri) => uri,
      postMessage: () => Promise.resolve(true),
      onDidReceiveMessage: messages.event,
    };
    const view = { webview, onDidDispose: disposed.event } as unknown as vscode.WebviewView;
    try {
      provider.post({ type: 'state', activeSessionId: 's1', session: { sessionId: 's1', agentName: 'First Agent', cwd: '/work', pickers: [], commands: [] } });
      provider.resolveWebviewView(view, { state: undefined }, tokens.token);
      assert.strictEqual(view.title, 'Chat First Agent');
      const html = webview.html;
      provider.post({ type: 'state', activeSessionId: 's2', session: { sessionId: 's2', agentName: 'Second Agent', cwd: '/work', pickers: [], commands: [] } });
      assert.strictEqual(view.title, 'Chat Second Agent');
      assert.strictEqual(webview.html, html, 'changing the title must not reload the webview');
      assert.strictEqual(given.length, 1);
      assert.strictEqual(given[0], webview);

      disposed.fire();
      assert.deepStrictEqual(given.slice(1), [undefined]);
      const replacement = { webview, onDidDispose: disposed.event } as unknown as vscode.WebviewView;
      provider.resolveWebviewView(replacement, { state: undefined }, tokens.token);
      assert.strictEqual(replacement.title, 'Chat Second Agent');
      provider.post({ type: 'state', activeSessionId: null, session: null });
      assert.strictEqual(replacement.title, 'Chat');
    } finally {
      provider.dispose();
      disposed.dispose();
      messages.dispose();
      tokens.dispose();
    }
  });
});
