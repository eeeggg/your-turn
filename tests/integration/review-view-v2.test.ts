import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { setup, suite, suiteSetup, suiteTeardown, teardown, test } from 'mocha';
import * as vscode from 'vscode';
import type { ExtensionTestApi } from '@/extension';
import type { ExtensionToWebviewMessage } from '@/shared/WebviewMessages';
import { observed } from './observed';

const activeFile = () => vscode.window.activeTextEditor?.document.uri.fsPath;

/** Quick diff's view shows `file`: its original side is an editor of the file's baseline. */
const viewShown = (file: string) =>
  vscode.window.visibleTextEditors.some(({ document: { uri } }) => uri.scheme === 'review-baseline' && uri.fsPath === file);

/** A change as quick diff's title passes it: 1-based inclusive lines, a side with none being `[the line before, 0]`. */
const quickDiffChange = ([originalStartLineNumber, originalEndLineNumber]: [number, number], [modifiedStartLineNumber, modifiedEndLineNumber]: [number, number]) =>
  ({ originalStartLineNumber, originalEndLineNumber, modifiedStartLineNumber, modifiedEndLineNumber });

for (const version of [2]) {
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
        { [agentName]: { command: process.execPath, args: [join(__dirname, 'fixtures', `fakeAgent-v${version}.js`)], env: { ELECTRON_RUN_AS_NODE: '1', ACP_TEST_SESSION_ID: `review-view-${process.env['VSCODE_TEST_GROUP'] ?? 'default'}-${version}` } } },
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

    test("The agent's turn ending shows the first file under review in quick diff's view", async () => {
      assert.ok(viewShown(modified));
      assert.strictEqual(activeFile(), modified);
    });

    test("Coming to a file under review, by Next File or its tab, shows its change in quick diff's view again", async function () {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(mismatched));
      await api.reviewPresentationSettled();
      assert.ok(!viewShown(modified));
      await vscode.commands.executeCommand('acp.nextReviewFile');
      await api.reviewPresentationSettled();
      assert.ok(viewShown(modified));
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(mismatched));
      await api.reviewPresentationSettled();
      assert.ok(!viewShown(modified));
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(modified));
      await api.reviewPresentationSettled();
      assert.ok(viewShown(modified));
    });

    /** Whether quick diff has a change for `file`, as Show Next Change opens its view only then, in a new editor. */
    async function quickDiffHasChange(file: string): Promise<boolean> {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
      await api.reviewPresentationSettled();
      return viewShown(file);
    }

    test("A file the agent changes again after its review was kept shows its new change in quick diff's view", async function () {
      await vscode.commands.executeCommand('toggleQuickDiffWidgetFocus');
      await vscode.commands.executeCommand('acp.keepChange', vscode.Uri.file(modified), [quickDiffChange([2, 2], [2, 2])], 0);
      await vscode.commands.executeCommand('acp.keepAllFiles');
      assert.deepStrictEqual(api.reviewedFiles(), []);
      const ended = posts.filter((post) => post.type === 'promptEnd').length;
      const promptEnded = observed(api.chatPosts, () => (posts.filter((post) => post.type === 'promptEnd').length > ended ? true : undefined));
      await api.sendChatMessage({ type: 'sendPrompt', text: `again ${folder}` });
      await promptEnded;
      await api.turnEndShown();

      assert.deepStrictEqual(api.reviewedFiles(), [modified]);
      assert.ok(await quickDiffHasChange(modified), 'quick diff has the second change');
    });

    test("The turn ending shows the first review file's change though the chat view has the focus", async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(modified));
      await vscode.commands.executeCommand('acp-chat.focus');
      const window = vscode.window as { showQuickPick: unknown };
      const original = window.showQuickPick;
      window.showQuickPick = async (items: readonly vscode.QuickPickItem[]) => items[0];
      try {
        const ended = posts.filter((post) => post.type === 'promptEnd').length;
        const promptEnded = observed(api.chatPosts, () => (posts.filter((post) => post.type === 'promptEnd').length > ended ? true : undefined));
        await api.sendChatMessage({ type: 'sendPrompt', text: 'hello' });
        await promptEnded;
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
      let permissionAsked!: () => void;
      const asked = new Promise<void>((resolve) => { permissionAsked = resolve; });
      window.showQuickPick = (items: readonly vscode.QuickPickItem[]) => new Promise((resolve) => {
        answer = () => resolve(items[0]);
        permissionAsked();
      });
      try {
        const ended = posts.filter((post) => post.type === 'promptEnd').length;
        const promptEnded = observed(api.chatPosts, () => (posts.filter((post) => post.type === 'promptEnd').length > ended ? true : undefined));
        const turn = api.sendChatMessage({ type: 'sendPrompt', text: 'hold the turn' });
        await asked;
        await vscode.commands.executeCommand('acp.keepChange', vscode.Uri.file(modified), [quickDiffChange([2, 2], [2, 2])], 0);
        await vscode.commands.executeCommand('acp.undoFile', vscode.Uri.file(modified));
        await vscode.commands.executeCommand('acp.keepAllFiles');
        assert.deepStrictEqual(api.reviewedFiles(), [modified, created, deleted]);
        assert.strictEqual(fs.readFileSync(modified, 'utf8'), 'one\nTWO\n');

        answer?.();
        await Promise.all([turn, promptEnded]);
        await api.turnEndShown();
        await vscode.commands.executeCommand('acp.keepFile', vscode.Uri.file(created));
        assert.deepStrictEqual(api.reviewedFiles(), [modified, deleted]);
      } finally {
        window.showQuickPick = original;
      }
    });

    test("Coming to a file under review while the agent's turn runs leaves quick diff's view closed", async function () {
      const window = vscode.window as { showQuickPick: unknown };
      const original = window.showQuickPick;
      let answer: (() => void) | undefined;
      let permissionAsked!: () => void;
      const asked = new Promise<void>((resolve) => { permissionAsked = resolve; });
      window.showQuickPick = (items: readonly vscode.QuickPickItem[]) => new Promise((resolve) => {
        answer = () => resolve(items[0]);
        permissionAsked();
      });
      try {
        const ended = posts.filter((post) => post.type === 'promptEnd').length;
        const promptEnded = observed(api.chatPosts, () => (posts.filter((post) => post.type === 'promptEnd').length > ended ? true : undefined));
        const turn = api.sendChatMessage({ type: 'sendPrompt', text: 'hold the turn' });
        await asked;
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(mismatched));
        await api.reviewPresentationSettled();
        assert.ok(!viewShown(modified));
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(modified));
        assert.ok(!viewShown(modified), 'the view stays closed during the turn');

        answer?.();
        await Promise.all([turn, promptEnded]);
        await api.turnEndShown();
      } finally {
        answer?.();
        window.showQuickPick = original;
      }
    });

    test("Keep and Undo Change in quick diff's view go on to the next change, round from the last to the first", async function () {
      const three = join(folder, 'm.ts');
      const lines = Array.from({ length: 30 }, (_, index) => `l${index + 1}`);
      fs.writeFileSync(three, `${lines.join('\n')}\n`);
      const ended = posts.filter((post) => post.type === 'promptEnd').length;
      const promptEnded = observed(api.chatPosts, () => (posts.filter((post) => post.type === 'promptEnd').length > ended ? true : undefined));
      await api.sendChatMessage({ type: 'sendPrompt', text: `three ${folder}` });
      await promptEnded;
      await api.turnEndShown();
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(three));
      const changed = [2, 15, 28];
      /** The view shows the change of 1-based line `line`: its editor of the file shows that line and no other change's. */
      const viewOn = (line: number) => vscode.window.visibleTextEditors.some((editor) =>
        editor.viewColumn === undefined && editor.document.uri.scheme === 'file' && editor.document.uri.fsPath === three
        && changed.every((other) => editor.visibleRanges.some((range) => range.contains(new vscode.Position(other - 1, 0))) === (other === line)));
      const changes = (...at: number[]) => at.map((line) => quickDiffChange([line, line], [line, line]));
      await api.reviewPresentationSettled();
      assert.ok(viewOn(2));

      await vscode.commands.executeCommand('acp.keepChange', vscode.Uri.file(three), changes(2, 15, 28), 1);
      assert.ok(viewOn(28));
      await vscode.commands.executeCommand('acp.undoChange', vscode.Uri.file(three), changes(2, 28), 1);
      assert.ok(viewOn(2));
      assert.strictEqual(fs.readFileSync(three, 'utf8'), `${lines.map((line) => (['l2', 'l15'].includes(line) ? line.toUpperCase() : line)).join('\n')}\n`);
      await vscode.commands.executeCommand('acp.keepChange', vscode.Uri.file(three), changes(2), 0);
      assert.ok(!api.reviewedFiles().includes(three));
      assert.ok(!viewShown(three), 'no view once the file has no change');
    });

    test('The workbench still has closeQuickDiff, which closing the view relies on though VS Code does not document it', async () => {
      assert.ok((await vscode.commands.getCommands()).includes('closeQuickDiff'));
    });

    test('Next File Under Review opens the first file from no argument, as the status bar gives, and the next from a URI', async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('acp.nextReviewFile');
      assert.strictEqual(activeFile(), modified);
      await vscode.commands.executeCommand('acp.nextReviewFile', vscode.Uri.file(modified));
      assert.strictEqual(activeFile(), created);
      await vscode.commands.executeCommand('acp.previousReviewFile', vscode.Uri.file(created));
      assert.strictEqual(activeFile(), modified);
    });

    test('A file written back to its baseline by anyone leaves the review', async () => {
      const left = observed(api.reviewChanges, () => (!api.reviewedFiles().includes(modified) ? true : undefined));
      fs.writeFileSync(modified, 'one\ntwo\n');
      await left;
      assert.deepStrictEqual(api.reviewedFiles(), [created, deleted]);
    });

    test("Disconnecting the agent keeps its session's review, shown again once its session is", async () => {
      const baseline = await baselineDocument(modified);
      let changed = observed(vscode.workspace.onDidChangeTextDocument, () => (baseline.getText() === '' ? true : undefined));
      await vscode.commands.executeCommand('acp.disconnectAgent', agentName);
      assert.deepStrictEqual(api.reviewedFiles(), []);
      assert.deepStrictEqual(api.reviewListedFiles(), []);
      await changed;
      changed = observed(vscode.workspace.onDidChangeTextDocument, () => (baseline.getText() === 'one\ntwo\n' ? true : undefined));
      await vscode.commands.executeCommand('acp.connectAgent', agentName);
      assert.deepStrictEqual(api.reviewedFiles(), [modified, created, deleted]);
      assert.deepStrictEqual(api.reviewListedFiles(), [modified, created, deleted]);
      await changed;
    });
  });
}
