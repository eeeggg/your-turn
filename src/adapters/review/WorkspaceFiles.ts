import { basename, dirname } from 'node:path';
import * as vscode from 'vscode';
import type { ReviewFiles } from '@/core/review/Reviews';
import { applyReviewEdit, saveForReview } from '@/adapters/review/ReviewTakeovers';

const notFound = (e: unknown) => e instanceof vscode.FileSystemError && e.code === 'FileNotFound';

/**
 * The document VS Code opened to detect encoding, preserving a byte-order mark instead of using configured encoding.
 * Return its identity so a guarded restore can recognize its own preparation.
 */
async function encodingOf(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  try {
    return await vscode.workspace.openTextDocument(uri);
  } catch {
    return undefined;
  }
}

type WatcherFactory = (pattern: vscode.RelativePattern) => vscode.FileSystemWatcher;

/** The files under review, inside the workspace or outside it, as VS Code reads, watches and writes them. */
export function createWorkspaceFiles(
  createWatcher: WatcherFactory = (pattern) => vscode.workspace.createFileSystemWatcher(pattern),
): ReviewFiles {
  return {
    async applyEdit(path, { start, end, text }, stillCurrent) {
      const document = vscode.workspace.textDocuments.find((open) => open.uri.scheme === 'file' && open.uri.fsPath === path);
      if (!document || !stillCurrent()) { return false; }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(end)), text);
      const before = document.getText();
      return applyReviewEdit(path, edit, { before, after: before.slice(0, start) + text + before.slice(end) });
    },
    async save(path) {
      const document = vscode.workspace.textDocuments.find((open) => open.uri.scheme === 'file' && open.uri.fsPath === path);
      if (document?.isDirty && !(await saveForReview(path, document))) { throw new Error('VS Code did not save it'); }
    },
    snapshot(path) {
      const document = vscode.workspace.textDocuments.find((open) => open.uri.scheme === 'file' && open.uri.fsPath === path);
      return document && { instance: document, version: document.version, dirty: document.isDirty, text: document.getText() };
    },
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
      const watcher = createWatcher(new vscode.RelativePattern(vscode.Uri.file(dirname(path)), basename(path)));
      watcher.onDidCreate(changed);
      watcher.onDidChange(changed);
      watcher.onDidDelete(changed);
      return watcher;
    },

    /**
     * Into an open document with unsaved edits, where the user can undo it and nothing of theirs is lost; on disk
     * otherwise, as an edit to a document not open would land in a hidden one. Deleting leaves an open document's
     * unsaved edits in its editor.
     */
    async restore(path, content, stillCurrent = () => true) {
      if (!stillCurrent()) { throw new Error('The review decision is no longer current.'); }
      const uri = vscode.Uri.file(path);
      const document = vscode.workspace.textDocuments.find((open) => open.uri.toString() === uri.toString());
      if (content !== null && document?.isDirty) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(0, 0, document.lineCount, 0), content);
        if (!(await applyReviewEdit(path, edit, { before: document.getText(), after: content }))) { throw new Error(`${path} could not be restored in its editor`); }
      } else if (content !== null) {
        const prepared = await encodingOf(uri);
        const encoding = prepared?.encoding;
        const bytes = await (encoding === undefined
          ? vscode.workspace.encode(content, { uri })
          : vscode.workspace.encode(content, { encoding }));
        if (!stillCurrent(prepared)) { throw new Error('The review decision is no longer current.'); }
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
}

export const workspaceFiles = createWorkspaceFiles();
