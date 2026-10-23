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
      await vscode.commands.executeCommand('acp.disconnectAgent', agentName);
      assert.deepStrictEqual(api.reviewedFiles(), []);
      // The fake agent gives every session the same ID, so connecting again shows the same session.
      await vscode.commands.executeCommand('acp.connectAgent', agentName);
      assert.deepStrictEqual(api.reviewedFiles(), [modified, created, deleted]);
    });
  });
}
