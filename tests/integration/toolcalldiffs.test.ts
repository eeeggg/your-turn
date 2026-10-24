import * as assert from 'assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, suite, suiteSetup, suiteTeardown, test } from 'mocha';
import * as vscode from 'vscode';
import type { ExtensionTestApi } from '@/extension';
import type { DiffFile, ExtensionToWebviewMessage, ToolCallContent, WebviewToExtensionMessage } from '@/shared/WebviewMessages';

type ToolCallPost = Extract<ExtensionToWebviewMessage, { type: 'toolCall' }>;

async function waitFor<T>(find: () => T | undefined, what: string, timeoutMs = 1000): Promise<T> {
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

const activeTab = () => vscode.window.tabGroups.activeTabGroup.activeTab;

/** Waits for the file itself in the active tab; a diff editor's modified side has the same path, so it does not count. */
async function shownFile(path: string): Promise<void> {
  await waitFor(() => {
    const input = activeTab()?.input;
    return input instanceof vscode.TabInputText && input.uri.scheme === 'file' && input.uri.fsPath === path ? true : undefined;
  }, `${path} to open`);
}

/** Waits for the diff editor under the title and gives the texts of its two sides. */
async function shownChanges(title: string): Promise<{ before: string; after: string }> {
  const input = await waitFor(() => {
    const tab = activeTab();
    return tab?.label === title && tab.input instanceof vscode.TabInputTextDiff ? tab.input : undefined;
  }, `the diff editor ${title}`);
  const [before, after] = await Promise.all([input.original, input.modified].map((uri) => vscode.workspace.openTextDocument(uri)));
  return { before: before?.getText() ?? '', after: after?.getText() ?? '' };
}

for (const version of [1, 2]) {
  suite(`Tool Call Diffs Test Suite, ACP v${version}`, () => {
    const agentName = `fake-diffs-v${version}`;
    let api: ExtensionTestApi;
    let dir: string;
    let original: { agents: unknown; showToolCallDiffs: unknown };
    const posts: ExtensionToWebviewMessage[] = [];
    const answers: WebviewToExtensionMessage[] = [];
    const subscriptions: vscode.Disposable[] = [];
    const config = () => vscode.workspace.getConfiguration('acp');

    const editCall = () => posts.find((post): post is ToolCallPost => post.type === 'toolCall' && post.toolCallId === 'edit-1');
    const prompt = async () => {
      posts.length = 0;
      await api.sendChatMessage({ type: 'sendPrompt', text: `edit ${dir}` });
      await waitFor(() => posts.find((post) => post.type === 'promptEnd'), 'the turn to end');
      return waitFor(editCall, 'the edit tool call');
    };
    const showDiffs = (on: boolean) => config().update('showToolCallDiffs', on, vscode.ConfigurationTarget.Global);

    suiteSetup(async () => {
      const extension = vscode.extensions.getExtension<ExtensionTestApi | undefined>('formulahendry.acp-client');
      const activated = await extension?.activate();
      assert.ok(activated, 'activate returns the test API in extension tests');
      api = activated;
      subscriptions.push(api.chatPosts((post) => posts.push(post)), api.chatMessages((message) => answers.push(message)));
      dir = mkdtempSync(join(tmpdir(), 'acp-diffs-'));
      original = { agents: config().inspect('agents')?.globalValue, showToolCallDiffs: config().inspect('showToolCallDiffs')?.globalValue };
      await config().update(
        'agents',
        { [agentName]: { command: process.execPath, args: [join(__dirname, 'fixtures', `fakeAgent-v${version}.js`)], env: { ELECTRON_RUN_AS_NODE: '1' } } },
        vscode.ConfigurationTarget.Global,
      );
      await vscode.commands.executeCommand('acp-chat.focus');
      await api.chatViewReady;
      await vscode.commands.executeCommand('acp.connectAgent', agentName);
    });

    setup(() => {
      writeFileSync(join(dir, 'a.ts'), 'one\ntwo\n');
      writeFileSync(join(dir, 'gone.ts'), 'bye\n');
      rmSync(join(dir, 'new.ts'), { force: true });
    });

    suiteTeardown(async () => {
      await vscode.commands.executeCommand('acp.disconnectAgent', agentName);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await config().update('agents', original.agents, vscode.ConfigurationTarget.Global);
      await config().update('showToolCallDiffs', original.showToolCallDiffs, vscode.ConfigurationTarget.Global);
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
      rmSync(dir, { recursive: true, force: true });
    });

    test('With acp.showToolCallDiffs off, the tool call reaches the chat view without its diffs', async () => {
      await showDiffs(false);

      const call = await prompt();

      assert.strictEqual(call.title, 'Edit a.ts');
      assert.deepStrictEqual(call.content, []);
    });

    test("With it on, the tool call carries its diffs' files, diffed in the extension", async () => {
      await showDiffs(true);

      const call = await prompt();

      const a: DiffFile = {
        operation: 'modify',
        path: join(dir, 'a.ts'),
        oldPath: null,
        added: 1,
        removed: 1,
        hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' one', '-two', '+TWO'] }],
        note: null,
        opens: 'fileAndChanges',
      };
      const expected: ToolCallContent[] =
        version === 1
          ? [
              { kind: 'diff', files: [a] },
              { kind: 'diff', files: [{ ...a, operation: 'add', path: join(dir, 'new.ts'), removed: 0, hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+new'] }] }] },
            ]
          : [
              { kind: 'diff', files: [a, { ...a, operation: 'delete', path: join(dir, 'gone.ts'), added: 0, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 0, lines: ['-bye'] }] }] },
            ];
      assert.deepStrictEqual(call.content, expected);
    });

    test("Open File and Open Changes, given a link's context, open the file and the agent's change from what the extension keeps", async () => {
      await showDiffs(true);
      await prompt();
      const a = join(dir, 'a.ts');

      answers.length = 0;
      await vscode.commands.executeCommand('acp.openToolCallFile', { acpToolCallId: 'edit-1', acpDiffFile: 0 });
      await shownFile(a);
      assert.deepStrictEqual(answers, []);

      await vscode.commands.executeCommand('acp.openToolCallChanges', { acpToolCallId: 'edit-1', acpDiffFile: 0 });
      assert.deepStrictEqual(await shownChanges("a.ts (Agent's Change)"), { before: 'one\ntwo\n', after: 'one\nTWO\n' });
    });

    test(version === 1 ? "Open Changes on a new file shows it against an empty side" : "Open File on a deleted file shows what the agent removed", async () => {
      await showDiffs(true);
      await prompt();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');

      await vscode.commands.executeCommand(version === 1 ? 'acp.openToolCallChanges' : 'acp.openToolCallFile', { acpToolCallId: 'edit-1', acpDiffFile: 1 });

      assert.deepStrictEqual(
        version === 1 ? await shownChanges("new.ts (Agent's Change)") : await shownChanges("gone.ts (Agent's Change)"),
        version === 1 ? { before: '', after: 'new\n' } : { before: 'bye\n', after: '' },
      );
    });
  });
}
