import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { setup, suite, suiteSetup, suiteTeardown, teardown, test } from 'mocha';
import * as vscode from 'vscode';
import type { ExtensionTestApi } from '@/extension';
import type { ExtensionToWebviewMessage } from '@/shared/WebviewMessages';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for `condition`, as files come under review once read, and VS Code tells of editors some time after. */
async function until(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) { throw new Error(`Timed out waiting for ${what}`); }
    await sleep(20);
  }
}

const activeFile = () => vscode.window.activeTextEditor?.document.uri.fsPath;

/** A change as quick diff's title passes it: 1-based inclusive lines, a side with none being `[the line before, 0]`. */
const quickDiffChange = ([originalStartLineNumber, originalEndLineNumber]: [number, number], [modifiedStartLineNumber, modifiedEndLineNumber]: [number, number]) =>
  ({ originalStartLineNumber, originalEndLineNumber, modifiedStartLineNumber, modifiedEndLineNumber });

for (const version of [1, 2]) {
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
        { [agentName]: { command: process.execPath, args: [join(__dirname, 'fixtures', `fakeAgent-v${version}.js`)], env: { ELECTRON_RUN_AS_NODE: '1' } } },
        vscode.ConfigurationTarget.Global,
      );
      await vscode.commands.executeCommand('acp-chat.focus');
      await api.chatViewReady;
      await vscode.commands.executeCommand('acp.connectAgent', agentName);
      // Every fake agent's session has the same ID, and a session's review outlives it, so earlier suites' edits show.
      await vscode.commands.executeCommand('acp.keepAllFiles');
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
      await api.sendChatMessage({ type: 'sendPrompt', text: `review ${folder}` });
      await until(() => posts.filter((post) => post.type === 'promptEnd').length > ended, 'the turn to end');
      await until(() => api.reviewedFiles().length === 3, 'the files to come under review');
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
      await vscode.commands.executeCommand('acp.keepFile', vscode.Uri.file(modified));
      assert.deepStrictEqual(api.reviewListedFiles(), [created, deleted]);
      assert.strictEqual(api.reviewOriginal(vscode.Uri.file(modified)), undefined);
      await until(() => baseline.getText() === '', "the kept file's baseline document to be emptied");
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
      await vscode.commands.executeCommand('acp.undoChange', vscode.Uri.file(modified), [quickDiffChange([2, 2], [2, 2])], 0);

      assert.strictEqual(document.getText(), 'one\ntwo\n');
      assert.strictEqual(document.isDirty, false);
      assert.strictEqual(fs.readFileSync(modified, 'utf8'), 'one\ntwo\n');
      await until(() => !api.reviewedFiles().includes(modified), 'the undone file to leave the review');
    });

    test('Keep and Undo Change do nothing given a change no longer between the baseline and the document', async () => {
      const document = await vscode.workspace.openTextDocument(modified);
      await vscode.commands.executeCommand('acp.keepChange', vscode.Uri.file(modified), [quickDiffChange([1, 1], [1, 1])], 0);
      await vscode.commands.executeCommand('acp.undoChange', vscode.Uri.file(modified), [quickDiffChange([1, 2], [1, 2])], 0);

      assert.strictEqual(document.getText(), 'one\nTWO\n');
      assert.strictEqual((await baselineDocument(modified)).getText(), 'one\ntwo\n');
      assert.deepStrictEqual(api.reviewedFiles(), [modified, created, deleted]);
    });

    /** Line `line` of `file` replaced in its editor, as the user types. */
    async function typed(file: string, line: number, text: string): Promise<vscode.TextEditor> {
      const editor = await vscode.window.showTextDocument(vscode.Uri.file(file));
      await editor.edit((edit) => edit.replace(editor.document.lineAt(line).range, text));
      return editor;
    }

    test("Typing in a change takes it over: the baseline follows, and the file leaves the review once saved", async () => {
      const baseline = await baselineDocument(modified);
      const editor = await typed(modified, 1, 'TWO!');
      await until(() => baseline.getText() === 'one\nTWO!\n', 'the baseline to take the typed line');
      assert.ok(api.reviewedFiles().includes(modified), 'the file stays under review until saved');
      await editor.document.save();
      await until(() => !api.reviewedFiles().includes(modified), 'the saved file to leave the review');
    });

    test('Ctrl+Z and Revert File bring back the change a takeover took', async () => {
      const baseline = await baselineDocument(modified);
      await typed(modified, 1, 'TWO!');
      await until(() => baseline.getText() === 'one\nTWO!\n', 'the baseline to take the typed line');
      await vscode.commands.executeCommand('undo');
      await until(() => baseline.getText() === 'one\ntwo\n', 'the baseline to be back after Ctrl+Z');

      await typed(modified, 1, 'TWO!');
      await until(() => baseline.getText() === 'one\nTWO!\n', 'the baseline to take the typed line again');
      await vscode.commands.executeCommand('workbench.action.files.revert');
      await until(() => baseline.getText() === 'one\ntwo\n', 'the baseline to be back after a revert');
    });

    test("A save's own edits go into the baseline where they touch no change, and leave a change they touch under review", async () => {
      const baseline = await baselineDocument(modified);
      const editor = await typed(modified, 0, 'one!');
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
      await until(() => baseline.getText() === 'ONE\ntwo\n', "the baseline to take the save's edit outside the change only");
      assert.ok(api.reviewedFiles().includes(modified));
    });

    test('The workbench still has closeQuickDiff, which closing the view relies on though VS Code does not document it', async () => {
      assert.ok((await vscode.commands.getCommands()).includes('closeQuickDiff'));
    });

    test('Next File Under Review opens the first file from no argument, as the status bar gives, and the next from a URI', async () => {
      await vscode.commands.executeCommand('acp.nextReviewFile');
      await until(() => activeFile() === modified, 'a.ts to be opened');
      await vscode.commands.executeCommand('acp.nextReviewFile', vscode.Uri.file(modified));
      await until(() => activeFile() === created, 'new.ts to be opened');
      await vscode.commands.executeCommand('acp.previousReviewFile', vscode.Uri.file(created));
      await until(() => activeFile() === modified, 'a.ts to be opened again');
    });

    test('A file written back to its baseline by anyone leaves the review', async () => {
      // A watcher starts hearing some time after it is made, so the file is written until it is heard.
      for (let attempt = 0; api.reviewedFiles().includes(modified) && attempt < 20; attempt++) {
        fs.writeFileSync(modified, 'one\ntwo\n');
        await sleep(150);
      }
      assert.deepStrictEqual(api.reviewedFiles(), [created, deleted]);
    });

    test("Disconnecting the agent keeps its session's review, shown again once its session is", async () => {
      const baseline = await baselineDocument(modified);
      await vscode.commands.executeCommand('acp.disconnectAgent', agentName);
      assert.deepStrictEqual(api.reviewedFiles(), []);
      assert.deepStrictEqual(api.reviewListedFiles(), []);
      await until(() => baseline.getText() === '', 'the baseline document to be emptied with no session shown');
      // The fake agent gives every session the same ID, so connecting again shows the same session.
      await vscode.commands.executeCommand('acp.connectAgent', agentName);
      assert.deepStrictEqual(api.reviewedFiles(), [modified, created, deleted]);
      assert.deepStrictEqual(api.reviewListedFiles(), [modified, created, deleted]);
      await until(() => baseline.getText() === 'one\ntwo\n', 'the baseline document to be the shown review\'s again');
    });
  });
}
