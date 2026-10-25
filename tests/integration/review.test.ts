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

/** Quick diff's view shows `file`: its original side is an editor of the file's baseline. */
const viewShown = (file: string) =>
  vscode.window.visibleTextEditors.some(({ document: { uri } }) => uri.scheme === 'review-baseline' && uri.fsPath === file);

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

    test('A text the agent writes again, though the document had it, is a change for review, not a return to its baseline then', async () => {
      const baseline = await baselineDocument(modified);
      const editor = await typed(modified, 0, 'ONE');
      await until(() => baseline.getText() === 'ONE\ntwo\n', 'the baseline to take the typed line outside the change');
      await editor.document.save();
      // A watcher starts hearing some time after it is made, so the file is written until it is heard.
      for (let attempt = 0; editor.document.getText() !== 'one\nTWO\n' && attempt < 20; attempt++) {
        fs.writeFileSync(modified, 'one\nTWO\n');
        await sleep(150);
      }
      assert.strictEqual(editor.document.getText(), 'one\nTWO\n');
      await sleep(300);
      assert.strictEqual(baseline.getText(), 'ONE\ntwo\n');
      assert.ok(api.reviewedFiles().includes(modified));
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

    test("The agent's turn ending shows the first file under review in quick diff's view", async () => {
      assert.ok(viewShown(modified));
      assert.strictEqual(activeFile(), modified);
    });

    test("Coming to a file under review, by Next File or its tab, shows its change in quick diff's view again", async function () {
      this.timeout(8000);
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(mismatched));
      await until(() => !viewShown(modified), "the view to close as its editor shows another file");
      await vscode.commands.executeCommand('acp.nextReviewFile');
      await until(() => viewShown(modified), 'the view to show again after Next File', 4000);
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(mismatched));
      await until(() => !viewShown(modified), 'the view to close again');
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(modified));
      await until(() => viewShown(modified), "the view to show again on the file's tab", 4000);
    });

    /** Whether quick diff has a change for `file`, as Show Next Change opens its view only then, in a new editor. */
    async function quickDiffHasChange(file: string): Promise<boolean> {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
      for (let attempt = 0; attempt < 10 && !viewShown(file); attempt++) {
        await vscode.commands.executeCommand('editor.action.dirtydiff.next');
        await sleep(200);
      }
      return viewShown(file);
    }

    test("A file the agent changes again after its review was kept shows its new change in quick diff's view", async function () {
      this.timeout(8000);
      await vscode.commands.executeCommand('toggleQuickDiffWidgetFocus');
      await vscode.commands.executeCommand('acp.keepChange', vscode.Uri.file(modified), [quickDiffChange([2, 2], [2, 2])], 0);
      await vscode.commands.executeCommand('acp.keepAllFiles');
      assert.deepStrictEqual(api.reviewedFiles(), []);
      const ended = posts.filter((post) => post.type === 'promptEnd').length;
      void api.sendChatMessage({ type: 'sendPrompt', text: `again ${folder}` });
      await until(() => posts.filter((post) => post.type === 'promptEnd').length > ended, 'the second turn to end');
      await api.turnEndShown();

      assert.deepStrictEqual(api.reviewedFiles(), [modified]);
      assert.ok(await quickDiffHasChange(modified), 'quick diff has the second change');
    });

    test("The turn ending shows the active editor's file's change though the chat view has the focus", async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(modified));
      await vscode.commands.executeCommand('acp-chat.focus');
      const window = vscode.window as { showQuickPick: unknown };
      const original = window.showQuickPick;
      window.showQuickPick = async (items: readonly vscode.QuickPickItem[]) => items[0];
      try {
        const ended = posts.filter((post) => post.type === 'promptEnd').length;
        void api.sendChatMessage({ type: 'sendPrompt', text: 'hello' });
        await until(() => posts.filter((post) => post.type === 'promptEnd').length > ended, 'the turn to end');
        await api.turnEndShown();
      } finally {
        window.showQuickPick = original;
      }
      assert.ok(viewShown(modified));
    });

    test("The review's decisions do nothing while the agent's turn runs, and act again once it ends", async () => {
      const window = vscode.window as { showQuickPick: unknown };
      const original = window.showQuickPick;
      let answer: (() => void) | undefined;
      window.showQuickPick = (items: readonly vscode.QuickPickItem[]) => new Promise((resolve) => { answer = () => resolve(items[0]); });
      try {
        const ended = posts.filter((post) => post.type === 'promptEnd').length;
        void api.sendChatMessage({ type: 'sendPrompt', text: 'hold the turn' });
        await until(() => answer !== undefined, 'the agent to ask for permission, holding its turn');
        await vscode.commands.executeCommand('acp.keepChange', vscode.Uri.file(modified), [quickDiffChange([2, 2], [2, 2])], 0);
        await vscode.commands.executeCommand('acp.undoFile', vscode.Uri.file(modified));
        await vscode.commands.executeCommand('acp.keepAllFiles');
        assert.deepStrictEqual(api.reviewedFiles(), [modified, created, deleted]);
        assert.strictEqual(fs.readFileSync(modified, 'utf8'), 'one\nTWO\n');

        answer?.();
        await until(() => posts.filter((post) => post.type === 'promptEnd').length > ended, 'the turn to end');
        await api.turnEndShown();
        await vscode.commands.executeCommand('acp.keepFile', vscode.Uri.file(created));
        assert.deepStrictEqual(api.reviewedFiles(), [modified, deleted]);
      } finally {
        window.showQuickPick = original;
      }
    });

    test("Coming to a file under review while the agent's turn runs leaves quick diff's view closed", async function () {
      this.timeout(6000);
      const window = vscode.window as { showQuickPick: unknown };
      const original = window.showQuickPick;
      let answer: (() => void) | undefined;
      window.showQuickPick = (items: readonly vscode.QuickPickItem[]) => new Promise((resolve) => { answer = () => resolve(items[0]); });
      try {
        const ended = posts.filter((post) => post.type === 'promptEnd').length;
        void api.sendChatMessage({ type: 'sendPrompt', text: 'hold the turn' });
        await until(() => answer !== undefined, 'the agent to ask for permission, holding its turn');
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(mismatched));
        await until(() => !viewShown(modified), 'the view to close as its editor shows another file');
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(modified));
        await sleep(1500);
        assert.ok(!viewShown(modified), 'the view stays closed during the turn');

        answer?.();
        await until(() => posts.filter((post) => post.type === 'promptEnd').length > ended, 'the turn to end');
        await api.turnEndShown();
      } finally {
        answer?.();
        window.showQuickPick = original;
      }
    });

    test("Keep and Undo Change in quick diff's view go on to the next change, round from the last to the first", async function () {
      this.timeout(12000);
      const three = join(folder, 'm.ts');
      const lines = Array.from({ length: 30 }, (_, index) => `l${index + 1}`);
      fs.writeFileSync(three, `${lines.join('\n')}\n`);
      const ended = posts.filter((post) => post.type === 'promptEnd').length;
      void api.sendChatMessage({ type: 'sendPrompt', text: `three ${folder}` });
      await until(() => posts.filter((post) => post.type === 'promptEnd').length > ended, 'the turn to end');
      await api.turnEndShown();
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(three));
      const changed = [2, 15, 28];
      /** The view shows the change of 1-based line `line`: its editor of the file shows that line and no other change's. */
      const viewOn = (line: number) => vscode.window.visibleTextEditors.some((editor) =>
        editor.viewColumn === undefined && editor.document.uri.scheme === 'file' && editor.document.uri.fsPath === three
        && changed.every((other) => editor.visibleRanges.some((range) => range.contains(new vscode.Position(other - 1, 0))) === (other === line)));
      const changes = (...at: number[]) => at.map((line) => quickDiffChange([line, line], [line, line]));
      await until(() => viewOn(2), 'the view on the first change', 5000);

      await vscode.commands.executeCommand('acp.keepChange', vscode.Uri.file(three), changes(2, 15, 28), 1);
      await until(() => viewOn(28), 'the view on the change after the one kept', 5000);
      await vscode.commands.executeCommand('acp.undoChange', vscode.Uri.file(three), changes(2, 28), 1);
      await until(() => viewOn(2), 'the view on the first change after the last was undone', 5000);
      assert.strictEqual(fs.readFileSync(three, 'utf8'), `${lines.map((line) => (['l2', 'l15'].includes(line) ? line.toUpperCase() : line)).join('\n')}\n`);
      await vscode.commands.executeCommand('acp.keepChange', vscode.Uri.file(three), changes(2), 0);
      assert.ok(!api.reviewedFiles().includes(three));
      await sleep(500);
      assert.ok(!viewShown(three), 'no view once the file has no change');
    });

    test('The workbench still has closeQuickDiff, which closing the view relies on though VS Code does not document it', async () => {
      assert.ok((await vscode.commands.getCommands()).includes('closeQuickDiff'));
    });

    test('Next File Under Review opens the first file from no argument, as the status bar gives, and the next from a URI', async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
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
