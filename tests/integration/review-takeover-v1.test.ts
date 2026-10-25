import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { setup, suite, suiteSetup, suiteTeardown, teardown, test } from 'mocha';
import * as vscode from 'vscode';
import type { ExtensionTestApi } from '@/extension';
import type { ExtensionToWebviewMessage } from '@/shared/WebviewMessages';
import { observed } from './observed';


for (const version of [1]) {
  suite(`Review Test Suite, ACP v${version}`, () => {
    const agentName = `fake-review-v${version}`;
    let api: ExtensionTestApi;
    let original: unknown;
    const posts: ExtensionToWebviewMessage[] = [];
    const subscriptions: vscode.Disposable[] = [];
    const config = () => vscode.workspace.getConfiguration('acp');
    let folder: string;
    let modified: string;
    let deleted: string;

    suiteSetup(async () => {
      const extension = vscode.extensions.getExtension<ExtensionTestApi | undefined>('formulahendry.acp-client');
      const activated = await extension?.activate();
      assert.ok(activated, 'activate returns the test API in extension tests');
      api = activated;
      subscriptions.push(api.chatPosts((post) => posts.push(post)));
      original = config().inspect('agents')?.globalValue;
      await config().update(
        'agents',
        { [agentName]: { command: process.execPath, args: [join(__dirname, 'fixtures', `fakeAgent-v${version}.js`)], env: { ELECTRON_RUN_AS_NODE: '1', ACP_TEST_SESSION_ID: `review-takeover-${process.env['VSCODE_TEST_GROUP'] ?? 'default'}-${version}` } } },
        vscode.ConfigurationTarget.Global,
      );
      await vscode.commands.executeCommand('acp-chat.focus');
      await api.chatViewReady;
      await vscode.commands.executeCommand('acp.connectAgent', agentName);
    });

    suiteTeardown(async () => {
      await vscode.commands.executeCommand('acp.disconnectAgent', agentName);
      await config().update('agents', original, vscode.ConfigurationTarget.Global);
      for (const subscription of subscriptions) { subscription.dispose(); }
    });

    /**
     * The agent modifies `a.ts`, creates `new.ts`, deletes `gone.ts` and writes `mismatch.ts` other than it reports; on
     * v2, it also changes a file it reports with no patch and creates one it reports as binary.
     */
    setup(async () => {
      folder = fs.mkdtempSync(join(os.tmpdir(), 'acp-review-e2e-'));
      modified = join(folder, 'a.ts');
      deleted = join(folder, 'gone.ts');
      fs.writeFileSync(modified, 'one\ntwo\n');
      fs.writeFileSync(deleted, 'gone\n');
      const ended = posts.filter((post) => post.type === 'promptEnd').length;
      const promptEnded = observed(api.chatPosts, () => (posts.filter((post) => post.type === 'promptEnd').length > ended ? true : undefined));
      const reviewed = observed(api.reviewChanges, () => (api.reviewedFiles().length === 3 ? true : undefined));
      await api.sendChatMessage({ type: 'sendPrompt', text: `review ${folder}` });
      await Promise.all([promptEnded, reviewed]);
      await api.turnEndShown();
    });

    /** The baseline the review's source control gives quick diff as the file's original, through its document. */
    async function baselineDocument(file: string): Promise<vscode.TextDocument> {
      const original = api.reviewOriginal(vscode.Uri.file(file));
      assert.ok(original, `${file} has an original`);
      assert.strictEqual(original.scheme, 'review-baseline');
      return vscode.workspace.openTextDocument(original);
    }

    teardown(async () => {
      await vscode.commands.executeCommand('acp.keepAllFiles');
      await vscode.commands.executeCommand('workbench.action.files.revert');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(folder, { recursive: true, force: true });
    });

    /** Line `line` of `file` replaced in its editor, as the user types. */
    async function typed(file: string, line: number, text: string): Promise<vscode.TextEditor> {
      const editor = await vscode.window.showTextDocument(vscode.Uri.file(file));
      await editor.edit((edit) => edit.replace(editor.document.lineAt(line).range, text));
      return editor;
    }

    test("Typing in a change takes it over: the baseline follows, and the file leaves the review once saved", async () => {
      const baseline = await baselineDocument(modified);
      const taken = observed(vscode.workspace.onDidChangeTextDocument, () => (baseline.getText() === 'one\nTWO!\n' ? true : undefined));
      const editor = await typed(modified, 1, 'TWO!');
      await taken;
      assert.ok(api.reviewedFiles().includes(modified), 'the file stays under review until saved');
      const left = observed(api.reviewChanges, () => (!api.reviewedFiles().includes(modified) ? true : undefined));
      await editor.document.save();
      await left;
    });

    test('Ctrl+Z and Revert File bring back the change a takeover took', async () => {
      const baseline = await baselineDocument(modified);
      let changed = observed(vscode.workspace.onDidChangeTextDocument, () => (baseline.getText() === 'one\nTWO!\n' ? true : undefined));
      await typed(modified, 1, 'TWO!');
      await changed;
      changed = observed(vscode.workspace.onDidChangeTextDocument, () => (baseline.getText() === 'one\ntwo\n' ? true : undefined));
      await vscode.commands.executeCommand('undo');
      await changed;

      changed = observed(vscode.workspace.onDidChangeTextDocument, () => (baseline.getText() === 'one\nTWO!\n' ? true : undefined));
      await typed(modified, 1, 'TWO!');
      await changed;
      changed = observed(vscode.workspace.onDidChangeTextDocument, () => (baseline.getText() === 'one\ntwo\n' ? true : undefined));
      await vscode.commands.executeCommand('workbench.action.files.revert');
      await changed;
    });

    test('A text the agent writes again, though the document had it, is a change for review, not a return to its baseline then', async () => {
      const baseline = await baselineDocument(modified);
      const taken = observed(vscode.workspace.onDidChangeTextDocument, () => (baseline.getText() === 'ONE\ntwo\n' ? true : undefined));
      const editor = await typed(modified, 0, 'ONE');
      await taken;
      await editor.document.save();
      const followed = observed(vscode.workspace.onDidChangeTextDocument, () => (editor.document.getText() === 'one\nTWO\n' ? true : undefined));
      fs.writeFileSync(modified, 'one\nTWO\n');
      await followed;
      assert.strictEqual(editor.document.getText(), 'one\nTWO\n');
      assert.strictEqual(baseline.getText(), 'ONE\ntwo\n');
      assert.ok(api.reviewedFiles().includes(modified));
    });

    test("A save's own edits go into the baseline where they touch no change, and leave a change they touch under review", async () => {
      const baseline = await baselineDocument(modified);
      const editor = await typed(modified, 0, 'one!');
      const taken = observed(vscode.workspace.onDidChangeTextDocument, () => (baseline.getText() === 'ONE\ntwo\n' ? true : undefined));
      const participant = vscode.workspace.onWillSaveTextDocument((event) => {
        if (event.document !== editor.document) { return; }
        event.waitUntil(Promise.resolve([
          vscode.TextEdit.replace(event.document.lineAt(0).range, 'ONE'),
          vscode.TextEdit.replace(event.document.lineAt(1).range, 'TWO;'),
        ]));
      });
      try {
        await editor.document.save();
      } finally {
        participant.dispose();
      }
      assert.strictEqual(fs.readFileSync(modified, 'utf8'), 'ONE\nTWO;\n');
      await taken;
      assert.ok(api.reviewedFiles().includes(modified));
    });
  });
}
