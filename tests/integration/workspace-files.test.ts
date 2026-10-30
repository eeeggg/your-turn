import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setup, suite, teardown, test } from 'mocha';
import * as vscode from 'vscode';
import { createWorkspaceFiles, workspaceFiles } from '@/adapters/review/WorkspaceFiles';
import { observed } from './observed';
import { cleanup } from './cleanup';

suite('Workspace files', () => {
  let folder: string;

  setup(function () {
    console.info('[workspace-files] starting', this.currentTest?.title);
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-review-'));
  });

  teardown(async function () {
    await cleanup(this.currentTest, [
      async () => {
        console.info('[workspace-files] reverting', this.currentTest?.title);
        await vscode.commands.executeCommand('workbench.action.files.revert');
        console.info('[workspace-files] reverted', this.currentTest?.title);
      },
      async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        console.info('[workspace-files] editors closed', this.currentTest?.title);
      },
      () => { if (folder) { fs.rmSync(folder, { recursive: true, force: true }); } },
    ]);
  });

  /** Opens the file in an editor, and types `typed` at its start, unsaved. */
  async function edited(file: string, typed: string): Promise<vscode.TextEditor> {
    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
    await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), typed));
    return editor;
  }

  test('restores a file on disk, keeping its encoding', async () => {
    const file = path.join(folder, 'a.txt');
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('agent\n')]));
    await workspaceFiles.restore(file, 'baseline\n');
    assert.deepStrictEqual(fs.readFileSync(file), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('baseline\n')]));
  });

  test('writes back a deleted file, making its folders', async () => {
    const file = path.join(folder, 'gone', 'a.txt');
    await workspaceFiles.restore(file, 'baseline\n');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'baseline\n');
  });

  test('deletes a created file, and takes one already gone as deleted', async () => {
    const file = path.join(folder, 'new.txt');
    fs.writeFileSync(file, 'agent\n');
    await workspaceFiles.restore(file, null);
    assert.strictEqual(fs.existsSync(file), false);
    await workspaceFiles.restore(file, null);
  });

  test('restores into an open document with unsaved edits, leaving the disk, and the editor can undo it', async () => {
    const file = path.join(folder, 'a.txt');
    fs.writeFileSync(file, 'agent\n');
    const editor = await edited(file, 'user\n');

    await workspaceFiles.restore(file, 'baseline\n');

    assert.strictEqual(editor.document.getText(), 'baseline\n');
    assert.strictEqual(editor.document.isDirty, true);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'agent\n');
    await vscode.window.showTextDocument(editor.document, { preserveFocus: false });
    await vscode.commands.executeCommand('undo');
    assert.strictEqual(editor.document.getText(), 'user\nagent\n');
  });

  // VS Code reloads a clean document once its watcher, started some time after the editor opens, sees the disk change;
  // nothing reports that watcher ready, so the test reloads the document itself, as reverting it would.
  test("restores a clean open document's file on disk, leaving the document clean to reload it", async () => {
    const file = path.join(folder, 'a.txt');
    fs.writeFileSync(file, 'agent\n');
    const { document } = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));

    await workspaceFiles.restore(file, 'baseline\n');

    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'baseline\n');
    assert.strictEqual(document.isDirty, false);
    const reloaded = observed(vscode.workspace.onDidChangeTextDocument, () => (document.getText() === 'baseline\n' ? true : undefined));
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await reloaded;
    assert.strictEqual(document.isDirty, false);
  });

  test("deletes a created file whose document has unsaved edits, leaving the edits in its editor", async () => {
    const file = path.join(folder, 'new.txt');
    fs.writeFileSync(file, 'agent\n');
    const editor = await edited(file, 'user\n');

    await workspaceFiles.restore(file, null);

    assert.strictEqual(fs.existsSync(file), false);
    assert.strictEqual(editor.document.getText(), 'user\nagent\n');
  });

  test('reads a file as VS Code decodes it, taking off a byte-order mark and keeping its line endings', async () => {
    const file = path.join(folder, 'a.txt');
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\r\ntwo\n')]));
    assert.strictEqual(await workspaceFiles.read(file), 'one\r\ntwo\n');
  });

  test('reads nothing at a missing path, and rejects a binary file', async () => {
    const binary = path.join(folder, 'a.bin');
    fs.writeFileSync(binary, Buffer.from([0x00, 0x01, 0x02, 0xff]));
    assert.strictEqual(await workspaceFiles.read(path.join(folder, 'missing.txt')), null);
    await assert.rejects(workspaceFiles.read(binary));
  });

  test('watches the exact file for creation, change and deletion until disposed', () => {
    const file = path.join(folder, 'watched.txt');
    const uri = vscode.Uri.file(file);
    const created = new vscode.EventEmitter<vscode.Uri>();
    const changed = new vscode.EventEmitter<vscode.Uri>();
    const deleted = new vscode.EventEmitter<vscode.Uri>();
    let pattern: vscode.RelativePattern | undefined;
    let disposed = false;
    const files = createWorkspaceFiles((watched) => {
      pattern = watched;
      return {
        ignoreCreateEvents: false,
        ignoreChangeEvents: false,
        ignoreDeleteEvents: false,
        onDidCreate: created.event,
        onDidChange: changed.event,
        onDidDelete: deleted.event,
        dispose: () => {
          disposed = true;
          created.dispose();
          changed.dispose();
          deleted.dispose();
        },
      };
    });

    let reports = 0;
    const watcher = files.watch(file, () => { reports++; });
    assert.ok(pattern);
    assert.strictEqual(pattern.baseUri.fsPath, folder);
    assert.strictEqual(pattern.pattern, 'watched.txt');
    created.fire(uri);
    changed.fire(uri);
    deleted.fire(uri);
    assert.strictEqual(reports, 3);
    watcher.dispose();
    assert.strictEqual(disposed, true);
    created.fire(uri);
    assert.strictEqual(reports, 3);
  });
});
