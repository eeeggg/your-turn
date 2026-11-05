import * as assert from 'assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, suiteSetup, suiteTeardown, teardown, test } from 'mocha';
import * as vscode from 'vscode';
import { ReportedFileEditor } from '@/adapters/ReportedFileEditor';
import { cleanup } from '@tests/integration/cleanup';

suite('Reported File Editor Test Suite', () => {
  let dir: string;
  let a: string;
  let b: string;
  let editor: ReportedFileEditor;
  let owned: ReportedFileEditor | undefined;

  suiteSetup(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    dir = mkdtempSync(join(tmpdir(), 'acp-reported-'));
    a = join(dir, 'a.ts');
    b = join(dir, 'b.ts');
    writeFileSync(a, 'a\n');
    writeFileSync(b, 'b\n');
    mkdirSync(join(dir, 'folder'));
    owned = editor = new ReportedFileEditor();
  });

  teardown(() => vscode.commands.executeCommand('workbench.action.closeAllEditors'));

  suiteTeardown(async function () {
    await cleanup(this.currentTest, [
      () => owned?.dispose(),
      () => { if (dir) { rmSync(dir, { recursive: true, force: true }); } },
    ]);
  });

  const activeTab = () => vscode.window.tabGroups.activeTabGroup.activeTab;
  const openFiles = () =>
    vscode.window.tabGroups.all.flatMap((group) => group.tabs).map((tab) => (tab.input instanceof vscode.TabInputText ? tab.input.uri.fsPath : tab.label));

  test('opens a file outside the workspace as a preview editor, which the next file opened replaces', async () => {
    await editor.open(a);
    assert.deepStrictEqual(openFiles(), [a]);
    assert.strictEqual(activeTab()?.isPreview, true);

    await editor.open(b);
    assert.deepStrictEqual(openFiles(), [b]);
  });

  test('brings a file already open in a tab forward rather than opening it again', async () => {
    await editor.open(a);
    await vscode.commands.executeCommand('workbench.action.keepEditor');
    await editor.open(b);

    await editor.open(a);

    assert.deepStrictEqual(openFiles(), [a, b]);
    assert.strictEqual(vscode.window.activeTextEditor?.document.uri.fsPath, a);
  });

  test('shows the changes in the diff editor under a title naming the file, its sides as given', async () => {
    await editor.showChanges(a, 'before\n', 'after\n');

    const tab = activeTab();
    assert.ok(tab?.input instanceof vscode.TabInputTextDiff);
    assert.strictEqual(tab.label, "a.ts (Agent's Change)");
    const [before, after] = await Promise.all([tab.input.original, tab.input.modified].map((uri) => vscode.workspace.openTextDocument(uri)));
    assert.deepStrictEqual([before?.getText(), after?.getText()], ['before\n', 'after\n']);
    assert.deepStrictEqual([before?.uri.path, after?.uri.path], [vscode.Uri.file(a).path, vscode.Uri.file(a).path]);
  });

  test('finds a file, and has no text for a missing path or a directory', async () => {
    assert.deepStrictEqual(await Promise.all([editor.exists(a), editor.exists(join(dir, 'missing.ts'))]), [true, false]);
    assert.deepStrictEqual(
      await Promise.all([editor.readText(a), editor.readText(join(dir, 'missing.ts')), editor.readText(join(dir, 'folder'))]),
      ['a\n', null, null],
    );
  });
});
