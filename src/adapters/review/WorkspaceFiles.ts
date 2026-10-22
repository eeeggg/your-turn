import { basename, dirname } from 'node:path';
import * as vscode from 'vscode';
import type { ReviewFiles } from '@/core/review/Reviews';

const notFound = (e: unknown) => e instanceof vscode.FileSystemError && e.code === 'FileNotFound';

/**
 * The encoding VS Code detected for the file, which keeps a byte-order mark it had, as `encode` given only a URI
 * uses the encoding configured for the path; `undefined` when the file is not there or not text.
 */
async function encodingOf(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return (await vscode.workspace.openTextDocument(uri)).encoding;
  } catch {
    return undefined;
  }
}

/** The files under review, inside the workspace or outside it, as VS Code reads, watches and writes them. */
export const workspaceFiles: ReviewFiles = {
  /** Its text as VS Code decodes it, or `null` when nothing is there; rejects for a binary file. */
  async read(path) {
    const uri = vscode.Uri.file(path);
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch (e) {
      if (notFound(e)) { return null; }
      throw e;
    }
    return vscode.workspace.decode(bytes, { uri });
  },

  /**
   * A file replaced by a rename is reported as created inside the workspace and as changed outside it, so every event
   * means only that it may have changed.
   */
  watch(path, changed) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dirname(path)), basename(path)));
    watcher.onDidCreate(changed);
    watcher.onDidChange(changed);
    watcher.onDidDelete(changed);
    return watcher;
  },

  /**
   * Into an open document with unsaved edits, where the human can undo it and nothing of theirs is lost; on disk
   * otherwise, as an edit to a document not open would land in a hidden one. Deleting leaves an open document's
   * unsaved edits in its editor.
   */
  async restore(path, content) {
    const uri = vscode.Uri.file(path);
    const document = vscode.workspace.textDocuments.find((open) => open.uri.toString() === uri.toString());
    if (content !== null && document?.isDirty) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(0, 0, document.lineCount, 0), content);
      if (!(await vscode.workspace.applyEdit(edit))) { throw new Error(`${path} could not be restored in its editor`); }
    } else if (content !== null) {
      const encoding = await encodingOf(uri);
      const bytes = await (encoding === undefined
        ? vscode.workspace.encode(content, { uri })
        : vscode.workspace.encode(content, { encoding }));
      await vscode.workspace.fs.writeFile(uri, bytes);
    } else {
      try {
        await vscode.workspace.fs.delete(uri, { useTrash: false });
      } catch (e) {
        if (!notFound(e)) { throw e; }
      }
    }
  },
};
