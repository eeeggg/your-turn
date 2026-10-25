import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { setup, suite, suiteSetup, suiteTeardown, teardown, test } from 'mocha';
import * as vscode from 'vscode';
import type { ExtensionTestApi } from '@/extension';
import type { ExtensionToWebviewMessage } from '@/shared/WebviewMessages';
import { observed } from './observed';

/** A change as quick diff's title passes it: 1-based inclusive lines, a side with none being `[the line before, 0]`. */
const quickDiffChange = ([originalStartLineNumber, originalEndLineNumber]: [number, number], [modifiedStartLineNumber, modifiedEndLineNumber]: [number, number]) =>
  ({ originalStartLineNumber, originalEndLineNumber, modifiedStartLineNumber, modifiedEndLineNumber });

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
    let created: string;
    let deleted: string;
    let mismatched: string;

    suiteSetup(async () => {
      const extension = vscode.extensions.getExtension<ExtensionTestApi | undefined>('formulahendry.acp-client');
      const activated = await extension?.activate();
      assert.ok(activated, 'activate returns the test API in extension tests');
      api = activated;
      subscriptions.push(api.chatPosts((post) => posts.push(post)));
      original = config().inspect('agents')?.globalValue;
      await config().update(
        'agents',
        { [agentName]: { command: process.execPath, args: [join(__dirname, 'fixtures', `fakeAgent-v${version}.js`)], env: { ELECTRON_RUN_AS_NODE: '1', ACP_TEST_SESSION_ID: `review-core-${process.env['VSCODE_TEST_GROUP'] ?? 'default'}-${version}` } } },
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
      created = join(folder, 'new.ts');
      deleted = join(folder, 'gone.ts');
      mismatched = join(folder, 'mismatch.ts');
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

    test('The files the agent changed come under review in the order reported, not one the disk does not hold as reported', () => {
      assert.deepStrictEqual(api.reviewedFiles(), [modified, created, deleted]);
      assert.strictEqual(fs.readFileSync(mismatched, 'utf8'), 'on disk\n');
    });

    test("The review's source control lists the files under review, giving quick diff each one's baseline and none for another file", async () => {
      assert.deepStrictEqual(api.reviewListedFiles(), [modified, created, deleted]);
      assert.strictEqual((await baselineDocument(modified)).getText(), 'one\ntwo\n');
      assert.strictEqual((await baselineDocument(created)).getText(), '');
      assert.strictEqual(api.reviewOriginal(vscode.Uri.file(mismatched)), undefined);
    });

    test("A baseline's document follows the review, and a file leaving it leaves the list and has no original", async () => {
      const baseline = await baselineDocument(modified);
      const emptied = observed(vscode.workspace.onDidChangeTextDocument, () => (baseline.getText() === '' ? true : undefined));
      await vscode.commands.executeCommand('acp.keepFile', vscode.Uri.file(modified));
      assert.deepStrictEqual(api.reviewListedFiles(), [created, deleted]);
      assert.strictEqual(api.reviewOriginal(vscode.Uri.file(modified)), undefined);
      await emptied;
    });

    test("Undo File, given the title area's URI, restores each file's baseline, and each leaves the review", async () => {
      await vscode.commands.executeCommand('acp.undoFile', vscode.Uri.file(modified));
      await vscode.commands.executeCommand('acp.undoFile', vscode.Uri.file(created));
      await vscode.commands.executeCommand('acp.undoFile', vscode.Uri.file(deleted));

      assert.strictEqual(fs.readFileSync(modified, 'utf8'), 'one\ntwo\n');
      assert.strictEqual(fs.existsSync(created), false);
      assert.strictEqual(fs.readFileSync(deleted, 'utf8'), 'gone\n');
      assert.deepStrictEqual(api.reviewedFiles(), []);
    });

    test('Keep File, given the URI, and Keep All take the files out of the review as they are', async () => {
      await vscode.commands.executeCommand('acp.keepFile', vscode.Uri.file(created));
      assert.deepStrictEqual(api.reviewedFiles(), [modified, deleted]);
      await vscode.commands.executeCommand('acp.keepAllFiles');

      assert.deepStrictEqual(api.reviewedFiles(), []);
      assert.strictEqual(fs.readFileSync(modified, 'utf8'), 'one\nTWO\n');
      assert.strictEqual(fs.existsSync(deleted), false);
    });

    test("Keep Change, given a change as quick diff's title gives it, takes it into the baseline, and the file leaves once none is left", async () => {
      await vscode.workspace.openTextDocument(modified);
      await vscode.workspace.openTextDocument(created);
      await vscode.commands.executeCommand('acp.keepChange', vscode.Uri.file(modified), [quickDiffChange([2, 2], [2, 2])], 0);
      // VS Code's diff takes a created file's empty baseline as one empty line, which its text replaces.
      await vscode.commands.executeCommand('acp.keepChange', vscode.Uri.file(created), [quickDiffChange([1, 1], [1, 2])], 0);

      assert.deepStrictEqual(api.reviewedFiles(), [deleted]);
      assert.strictEqual(fs.readFileSync(modified, 'utf8'), 'one\nTWO\n');
      assert.strictEqual(fs.readFileSync(created, 'utf8'), 'new\n');
    });

    test("Undo Change puts the baseline's lines back and saves the file, which then leaves the review", async () => {
      const document = await vscode.workspace.openTextDocument(modified);
      const left = observed(api.reviewChanges, () => (!api.reviewedFiles().includes(modified) ? true : undefined));
      await vscode.commands.executeCommand('acp.undoChange', vscode.Uri.file(modified), [quickDiffChange([2, 2], [2, 2])], 0);
      await left;

      assert.strictEqual(document.getText(), 'one\ntwo\n');
      assert.strictEqual(document.isDirty, false);
      assert.strictEqual(fs.readFileSync(modified, 'utf8'), 'one\ntwo\n');
      assert.ok(!api.reviewedFiles().includes(modified));
    });

    test('Keep and Undo Change do nothing given a change no longer between the baseline and the document', async () => {
      const document = await vscode.workspace.openTextDocument(modified);
      await vscode.commands.executeCommand('acp.keepChange', vscode.Uri.file(modified), [quickDiffChange([1, 1], [1, 1])], 0);
      await vscode.commands.executeCommand('acp.undoChange', vscode.Uri.file(modified), [quickDiffChange([1, 2], [1, 2])], 0);

      assert.strictEqual(document.getText(), 'one\nTWO\n');
      assert.strictEqual((await baselineDocument(modified)).getText(), 'one\ntwo\n');
      assert.deepStrictEqual(api.reviewedFiles(), [modified, created, deleted]);
    });
  });
}
