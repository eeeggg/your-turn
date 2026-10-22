import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setup, suite, teardown, test } from 'mocha';
import * as vscode from 'vscode';
import { workspaceFiles } from '@/adapters/review/WorkspaceFiles';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for `count` changes to have been heard, as a watcher reports a write some time after it. */
async function heard(changes: () => number, count: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (changes() < count) {
    if (Date.now() > deadline) { throw new Error(`Heard ${changes()} changes, expected ${count}`); }
    await sleep(20);
  }
}

suite('Workspace files', () => {
  let folder: string;

  setup(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-review-'));
  });

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(folder, { recursive: true, force: true });
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
    const editor = await edited(file, 'human\n');

    await workspaceFiles.restore(file, 'baseline\n');

    assert.strictEqual(editor.document.getText(), 'baseline\n');
    assert.strictEqual(editor.document.isDirty, true);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'agent\n');
    await vscode.commands.executeCommand('undo');
    assert.strictEqual(editor.document.getText(), 'human\nagent\n');
  });

  test('restores a file shown with no unsaved edits on disk, and its editor follows', async () => {
    const file = path.join(folder, 'a.txt');
    fs.writeFileSync(file, 'agent\n');
    const { document } = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
    // VS Code starts watching a file outside the workspace some time after it is opened, so the file is written until
    // its editor follows.
    let written = '';
    for (let attempt = 0; document.getText() !== written && attempt < 20; attempt++) {
      written = `agent ${attempt}\n`;
      fs.writeFileSync(file, written);
      await sleep(150);
    }
    assert.strictEqual(document.getText(), written, 'the editor never followed the disk');

    await workspaceFiles.restore(file, 'baseline\n');

    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'baseline\n');
    for (let attempt = 0; document.getText() !== 'baseline\n' && attempt < 50; attempt++) { await sleep(20); }
    assert.strictEqual(document.getText(), 'baseline\n');
    assert.strictEqual(document.isDirty, false);
  });

  test("deletes a created file whose document has unsaved edits, leaving the edits in its editor", async () => {
    const file = path.join(folder, 'new.txt');
    fs.writeFileSync(file, 'agent\n');
    const editor = await edited(file, 'human\n');

    await workspaceFiles.restore(file, null);

    assert.strictEqual(fs.existsSync(file), false);
    assert.strictEqual(editor.document.getText(), 'human\nagent\n');
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

  test('hears a file outside the workspace created, written, replaced by a rename and deleted, until disposed', async () => {
    const file = path.join(folder, 'watched.txt');
    let changes = 0;
    const watcher = workspaceFiles.watch(file, () => changes++);
    // The watcher starts some time after it is made, so the file is written until it is heard.
    for (let attempt = 0; changes === 0 && attempt < 20; attempt++) {
      fs.writeFileSync(file, `created ${attempt}\n`);
      await sleep(150);
    }
    assert.ok(changes > 0, 'the watcher never heard the file');

    let expected = changes + 1;
    fs.writeFileSync(file, 'changed\n');
    await heard(() => changes, expected);
    fs.writeFileSync(`${file}.tmp`, 'renamed over\n');
    fs.renameSync(`${file}.tmp`, file);
    await heard(() => changes, ++expected);
    fs.unlinkSync(file);
    await heard(() => changes, ++expected);

    watcher.dispose();
    await sleep(300);
    const disposedAt = changes;
    fs.writeFileSync(file, 'after dispose\n');
    await sleep(500);
    assert.strictEqual(changes, disposedAt);
  });
});
