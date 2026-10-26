import { readFileSync } from 'node:fs';
import * as vscode from 'vscode';
import type { ReviewControls } from '@/core/review/ReviewControls';
import type { DocumentEdit, EditSource, Takeovers } from '@/core/review/Takeovers';

/** How long the view's cursor has to report where it was typed before the editor is given it. */
const VIEW_SELECTION_WAIT_MS = 100;
/** How long a save is taken to last when VS Code never says it ended, as when it failed. */
const SAVE_LIMIT_MS = 10_000;

const reviewEditing = new Set<string>();
const saving = new Map<string, ReturnType<typeof setTimeout>>();

function saveStarted(path: string): void {
  clearTimeout(saving.get(path));
  saving.set(path, setTimeout(() => saving.delete(path), SAVE_LIMIT_MS));
}

function saveEnded(path: string): void {
  clearTimeout(saving.get(path));
  saving.delete(path);
}

/** Applies the review's own edit to an open document, which the takeover does not take for the user's. */
export async function applyReviewEdit(path: string, edit: vscode.WorkspaceEdit): Promise<boolean> {
  reviewEditing.add(path);
  try {
    return await vscode.workspace.applyEdit(edit);
  } finally {
    reviewEditing.delete(path);
  }
}

/**
 * Saves for the review, its participants' edits being the save's: VS Code may run a formatter before it tells
 * extensions of a save, so the review's own saves are marked from the call.
 */
export async function saveForReview(path: string, document: vscode.TextDocument): Promise<boolean> {
  saveStarted(path);
  try {
    return await document.save();
  } finally {
    saveEnded(path);
  }
}

/** Whether `text` is what the disk holds: VS Code's reload, or a revert, gives the document the disk's text. */
function matchesDisk(path: string, text: string): boolean {
  try {
    return readFileSync(path, 'utf8').replace(/^\uFEFF/, '') === text;
  } catch {
    return false;
  }
}

function editOf({ range, rangeOffset, rangeLength, text }: vscode.TextDocumentContentChangeEvent): DocumentEdit {
  const wholeLines = range.end.line > range.start.line && range.end.character === 0;
  return {
    first: range.start.line,
    last: wholeLines ? range.end.line - 1 : range.end.line,
    addedLines: (text.match(/\r\n|\r|\n/g) ?? []).length - (range.end.line - range.start.line),
    start: rangeOffset,
    end: rangeOffset + rangeLength,
    text,
  };
}

/**
 * Hears each edit to a document under review and has core's baseline follow it. The user's edit, and their undo, close
 * the quick diff view of the editor typed in before VS Code diffs again, which would move it; typed in the view, whose
 * editor reaches extensions as one with no column, the file's editor is given the view's cursor first. Closing goes
 * through `closeQuickDiff`, the workbench's command for Escape, which is not in VS Code's API.
 */
export class ReviewTakeovers implements vscode.Disposable {
  /** Each open document's text before its latest change. */
  private readonly texts = new Map<string, string>();
  /**
   * Whether each open document had unsaved edits before its latest change, as VS Code last told: it tells of a change
   * of the dirty flag as a change with no content changes, after a revert's content change.
   */
  private readonly dirty = new Map<string, boolean>();
  /** The editor of each file last active, the view's being none of them. */
  private readonly editors = new Map<string, vscode.TextEditor>();
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly takeovers: Takeovers, private readonly controls: ReviewControls) {
    for (const document of vscode.workspace.textDocuments) { this.opened(document); }
    this.activated(vscode.window.activeTextEditor);
    this.subscriptions = [
      vscode.workspace.onDidOpenTextDocument((document) => this.opened(document)),
      vscode.workspace.onDidCloseTextDocument(({ uri }) => {
        if (uri.scheme !== 'file') { return; }
        this.texts.delete(uri.fsPath);
        this.dirty.delete(uri.fsPath);
      }),
      vscode.workspace.onDidChangeTextDocument((event) => this.changed(event)),
      vscode.workspace.onWillSaveTextDocument(({ document }) => saveStarted(document.uri.fsPath)),
      vscode.workspace.onDidSaveTextDocument(({ uri }) => saveEnded(uri.fsPath)),
      vscode.window.onDidChangeActiveTextEditor((editor) => this.activated(editor)),
    ];
  }

  dispose(): void {
    for (const subscription of this.subscriptions) { subscription.dispose(); }
  }

  private opened(document: vscode.TextDocument): void {
    if (document.uri.scheme !== 'file') { return; }
    this.texts.set(document.uri.fsPath, document.getText());
    this.dirty.set(document.uri.fsPath, document.isDirty);
  }

  private activated(editor: vscode.TextEditor | undefined): void {
    if (editor?.viewColumn !== undefined && editor.document.uri.scheme === 'file') { this.editors.set(editor.document.uri.fsPath, editor); }
  }

  private changed({ document, contentChanges, reason }: vscode.TextDocumentChangeEvent): void {
    if (document.uri.scheme !== 'file') { return; }
    const path = document.uri.fsPath;
    const wasDirty = this.dirty.get(path) ?? false;
    this.dirty.set(path, document.isDirty);
    if (contentChanges.length === 0) { return; }
    const before = this.texts.get(path);
    const after = document.getText();
    this.texts.set(path, after);
    if (before === undefined || this.controls.baseline(path) === undefined) { return; }
    const source = this.sourceOf(path, reason, after, wasDirty);
    if (source === 'user' || source === 'undo') { this.closeView(path, document); }
    this.takeovers.edited(path, source, before, after, contentChanges.map(editOf));
  }

  /** VS Code reloads only a document with no unsaved edits, so the disk's text over unsaved edits is a revert. */
  private sourceOf(path: string, reason: vscode.TextDocumentChangeReason | undefined, after: string, wasDirty: boolean): EditSource {
    if (reviewEditing.has(path)) { return 'review'; }
    if (saving.has(path)) { return 'save'; }
    if (reason !== undefined) { return 'undo'; }
    if (!matchesDisk(path, after)) { return 'user'; }
    return wasDirty ? 'revert' : 'reload';
  }

  private closeView(path: string, document: vscode.TextDocument): void {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputTextDiff) { return; }
    const active = vscode.window.activeTextEditor;
    if (active?.document !== document) { return; }
    if (active.viewColumn !== undefined) {
      void vscode.commands.executeCommand('closeQuickDiff');
      return;
    }
    void this.handOver(active, this.editors.get(path));
  }

  /** Gives the file's editor the view's cursor, once the view reports where it was typed, then closes the view. */
  private async handOver(view: vscode.TextEditor, editor: vscode.TextEditor | undefined): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, VIEW_SELECTION_WAIT_MS);
      const moved = vscode.window.onDidChangeTextEditorSelection(({ textEditor }) => { if (textEditor === view) { done(); } });
      function done() {
        clearTimeout(timer);
        moved.dispose();
        resolve();
      }
    });
    if (editor && vscode.window.visibleTextEditors.includes(editor)) { editor.selections = view.selections; }
    await vscode.commands.executeCommand('closeQuickDiff');
  }
}
