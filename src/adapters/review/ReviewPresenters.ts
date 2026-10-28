import { setTimeout as delay } from 'node:timers/promises';
import * as vscode from 'vscode';
import { logError } from '@/core/Log';
import type { Change } from '@/core/review/Hunks';
import type { ReviewControls, ReviewEditors } from '@/core/review/ReviewControls';
import type { Reviews } from '@/core/review/Reviews';
import { BASELINE_SCHEME } from './ReviewSourceControl';
import { applyReviewEdit, saveForReview } from './ReviewTakeovers';

/** VS Code diffs a file some time after it opens or the agent writes it; quick diff's view has nothing to show before. */
const VIEW_ATTEMPTS = 20;
const VIEW_ATTEMPT_MS = 250;
const DIFF_ATTEMPTS = 30;
const DIFF_ATTEMPT_MS = 100;

/** What the presenters put on screen, which VS Code's API cannot read back. */
export interface ReviewDisplay extends vscode.Disposable {
  /**
   * Whether a session is shown, for the title area's buttons to be, and the files under review, which enable them. The
   * files are `Uri`s: `setContext` makes them strings in the window, after a remote window's URIs were translated,
   * which strings made here would not be.
   */
  review(sessionShown: boolean, files: vscode.Uri[]): void;
  /** "2 of 5" in the status bar, or nothing. */
  position(text: string | undefined): void;
}

/** The file in the active tab, a diff's modified side among them, when it is one on disk. */
function activePath(): string | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  const uri = input instanceof vscode.TabInputText ? input.uri : input instanceof vscode.TabInputTextDiff ? input.modified : undefined;
  return uri?.scheme === 'file' ? uri.fsPath : undefined;
}

/** The file in the active tab when it is a text editor's, not a diff's, which quick diff's view does not open on. */
function textTabPath(): string | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputText && input.uri.scheme === 'file' ? input.uri.fsPath : undefined;
}

const openDocument = (path: string) => vscode.workspace.textDocuments.find(({ uri }) => uri.scheme === 'file' && uri.fsPath === path);

/** Quick diff's view shows the file: its original side is an editor of the file's baseline, as extensions see editors. */
const viewShown = (path: string) =>
  vscode.window.visibleTextEditors.some(({ document: { uri } }) => uri.scheme === BASELINE_SCHEME && uri.fsPath === path);

/** A change's first line as quick diff counts it, from 1, a deletion's being the line before it, and at least 1. */
const startLine = ({ modified: { start, end } }: Change) => Math.max(1, end > start ? start + 1 : start);

/**
 * The first lines of quick diff's changes to the editor's file, as Go to Next Change (Alt+F5) moves the cursor to each
 * in turn, from the last line round to the first; there is no other way to read them.
 */
async function quickDiffStarts(editor: vscode.TextEditor, most: number, current: () => boolean, execute: Execute): Promise<number[]> {
  const last = editor.document.lineCount - 1;
  editor.selection = new vscode.Selection(last, 0, last, 0);
  const starts = new Set<number>();
  for (let step = 0; step <= most && current(); step++) {
    await execute('workbench.action.editor.nextChange');
    const line = editor.selection.active.line + 1;
    if (starts.has(line)) { break; }
    starts.add(line);
  }
  return [...starts].sort((a, b) => a - b);
}

type Execute = (command: string, ...args: unknown[]) => Thenable<unknown>;
type Pause = (ms: number, signal: AbortSignal) => Promise<void>;

export function createReviewEditors(
  execute: Execute = (command, ...args) => vscode.commands.executeCommand(command, ...args),
  pause: Pause = (ms, signal) => delay(ms, undefined, { signal }),
): ReviewEditors & { dispose(): Promise<void> } {
  let shows = 0;
  let latestShow = Promise.resolve();
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const stopping = new AbortController();
  const pending = new Set<Promise<void>>();
  const accepted = (action: () => Promise<void>): Promise<void> => {
    if (disposed) { return Promise.resolve(); }
    const running = action();
    pending.add(running);
    void running.then(() => pending.delete(running), () => pending.delete(running));
    return running;
  };

  /**
   * `editor.action.dirtydiff.next`, VS Code's Alt+F3, acts on the focused editor only. Focus the file's text editor
   * explicitly, close any old view whose visible baseline would otherwise look like success, and start after the final
   * line so "next" wraps to the first change unless `prepare` chooses another. VS Code does nothing before it has diffed
   * the file, so the command is tried until the new view shows. Each show stops the one before, as two could both run it
   * before the view shows, and the one before may try an editor that lost the focus since; the one stopped ends with the
   * last.
   */
  function show(path: string, prepare: (current: () => boolean) => Promise<void> = async () => {}): Promise<void> {
    if (disposed) { return Promise.resolve(); }
    const own = ++shows;
    const current = () => !disposed && own === shows && activePath() === path;
    const shown = (async () => {
      try {
        const editor = await vscode.window.showTextDocument(vscode.Uri.file(path), { preview: false, preserveFocus: false });
        if (!current()) { return; }
        if (viewShown(path)) { await execute('closeQuickDiff'); }
        if (!current()) { return; }
        const end = editor.document.lineAt(editor.document.lineCount - 1).range.end;
        editor.selection = new vscode.Selection(end, end);
        await prepare(current);
        for (let attempt = 0; attempt < VIEW_ATTEMPTS && current() && !viewShown(path); attempt++) {
          await execute('editor.action.dirtydiff.next');
          if (!current()) { break; }
          await pause(VIEW_ATTEMPT_MS, stopping.signal);
        }
      } finally {
        if (own !== shows) { await latestShow; }
      }
    })().catch((error: unknown) => {
      if (error instanceof Error && error.name === 'AbortError' && stopping.signal.aborted) { return; }
      throw error;
    });
    latestShow = shown.catch(() => {});
    return shown;
  }

  return {
    activePath,
    isOpen: (path) => viewShown(path) || vscode.window.tabGroups.all.some(({ tabs }) => tabs.some(({ input }) =>
      input instanceof vscode.TabInputTextDiff
      && input.original.scheme === 'acp-review-diff'
      && input.modified.scheme === 'file'
      && input.modified.fsPath === path)),
    /** `vscode.open`, as it opens a tab for a file not there too, which a text document cannot. */
    open: (path) => accepted(async () => { await execute('vscode.open', vscode.Uri.file(path)); }),
    showChange: (path) => accepted(() => show(path)),
    /**
     * A view opened before VS Code diffs the file again would be moved on by it, so the cursor goes to the change only
     * once quick diff's changes start where `changes` do; the view opens at the change from the cursor.
     */
    showChangeOf: (path, changes, index) => accepted(() => show(path, async (current) => {
      const editor = vscode.window.activeTextEditor;
      const change = changes[index];
      if (editor?.document.uri.fsPath !== path || !change) { return; }
      const expected = changes.map(startLine).join();
      for (let attempt = 0; attempt < DIFF_ATTEMPTS && current(); attempt++) {
        if ((await quickDiffStarts(editor, changes.length, current, execute)).join() === expected) { break; }
        if (!current()) { return; }
        await pause(DIFF_ATTEMPT_MS, stopping.signal);
      }
      if (!current()) { return; }
      const line = startLine(change) - 1;
      editor.selection = new vscode.Selection(line, 0, line, 0);
    })),
    /** `closeQuickDiff`, Escape's command, which is not in VS Code's API; it closes the focused editor's view. */
    closeChange: (path) => accepted(async () => {
      if (viewShown(path)) { await execute('closeQuickDiff'); }
    }),
    showError: (message) => { void vscode.window.showErrorMessage(message); },
    text: (path) => openDocument(path)?.getText(),
    applyEdit: async (path, { start, end, text }) => {
      const document = openDocument(path);
      if (!document) { return false; }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(end)), text);
      return applyReviewEdit(path, edit);
    },
    save: async (path) => {
      const document = openDocument(path);
      if (document?.isDirty && !(await saveForReview(path, document))) { throw new Error('VS Code did not save it'); }
    },
    dispose: () => {
      if (disposal) { return disposal; }
      disposed = true;
      stopping.abort();
      disposal = Promise.allSettled(pending).then((results) => {
        const failures = results.filter((result) => result.status === 'rejected');
        if (failures.length > 0) {
          throw new AggregateError(failures.map((result) => result.reason as unknown), 'Failed to dispose review editors');
        }
      });
      return disposal;
    },
  };
}

function vscodeReviewDisplay(): ReviewDisplay {
  const item = vscode.window.createStatusBarItem('acp.review', vscode.StatusBarAlignment.Left, 99);
  item.name = 'ACP Review';
  item.command = 'acp.nextReviewFile';
  item.tooltip = 'Files under review: go to the next one';
  return {
    review: (sessionShown, files) => {
      void vscode.commands.executeCommand('setContext', 'acp.reviewShown', sessionShown);
      void vscode.commands.executeCommand('setContext', 'acp.reviewHasFiles', files.length > 0);
      void vscode.commands.executeCommand('setContext', 'acp.reviewedFiles', files);
    },
    position: (text) => {
      if (text === undefined) {
        item.hide();
      } else {
        item.text = `$(diff) ${text}`;
        item.show();
      }
    },
    dispose: () => item.dispose(),
  };
}

/**
 * Shows the shown review in the editor: the title area's buttons on every editor while a session is active, always in
 * the same order, those for a file enabled on its files only; and the active file's place among them in the status
 * bar. Each is shown again when what it depends on changes; quick diff's markers show a file's changes, and its view
 * one of them as the file's tab comes to the front.
 */
export class ReviewPresenters implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[];
  private latestPresentation = Promise.resolve();
  private turnRuns = false;
  private disposed = false;
  private disposal: Promise<void> | undefined;
  private readonly pending = new Set<Promise<void>>();
  private readonly reviewListener = () => this.showAll();
  /**
   * The active tab's file, for a change of tab to show its change in quick diff's view; not the active editor, which
   * is the view's own once it has the focus.
   */
  private tabPath = textTabPath();

  constructor(
    private readonly controls: ReviewControls,
    private readonly reviews: Reviews,
    private readonly display: ReviewDisplay = vscodeReviewDisplay(),
  ) {
    reviews.addListener(this.reviewListener);
    this.subscriptions = [
      vscode.window.tabGroups.onDidChangeTabs(() => this.tabsChanged()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.tabsChanged()),
    ];
    this.showAll();
  }

  dispose(): Promise<void> {
    if (this.disposal) { return this.disposal; }
    this.disposed = true;
    this.reviews.removeListener(this.reviewListener);
    for (const subscription of this.subscriptions) { subscription.dispose(); }
    this.display.dispose();
    this.disposal = Promise.allSettled(this.pending).then(() => {});
    return this.disposal;
  }

  /** The shown session's turn started or ended; the title area's buttons follow `acp.turnInProgress` themselves. */
  turnInProgress(inProgress: boolean): void {
    if (this.disposed) { return; }
    this.turnRuns = inProgress;
  }

  /** A user's file-navigation command may open quick diff during a turn; agent-driven tab changes may not. */
  async navigated(): Promise<void> {
    if (this.disposed || vscode.workspace.getConfiguration('acp').get<string>('review.presentation', 'diffEditor') !== 'quickDiff') { return; }
    const path = textTabPath();
    if (path !== undefined) { await this.controls.entered(path); }
  }

  /** Settles presentations already started by tab changes. */
  settled(): Promise<void> {
    return Promise.allSettled([this.latestPresentation, ...this.pending]).then(() => {});
  }

  /** Only quick diff follows plain-tab entry; a normal editor must not reopen an ACP Review diff. */
  private tabsChanged(): void {
    if (this.disposed) { return; }
    this.showPosition();
    const path = textTabPath();
    if (path === this.tabPath) { return; }
    this.tabPath = path;
    if (path !== undefined && !this.turnRuns && vscode.workspace.getConfiguration('acp').get<string>('review.presentation', 'diffEditor') === 'quickDiff') {
      this.latestPresentation = this.controls.entered(path).catch((e: unknown) => logError("Showing the file's change failed", e));
      const presentation = this.latestPresentation;
      this.pending.add(presentation);
      void presentation.then(() => this.pending.delete(presentation));
    }
  }

  private showAll(): void {
    if (this.disposed) { return; }
    this.display.review(this.controls.sessionShown(), this.controls.reviewedPaths().map((path) => vscode.Uri.file(path)));
    this.showPosition();
  }

  private showPosition(): void {
    this.display.position(this.controls.position(activePath()));
  }
}
