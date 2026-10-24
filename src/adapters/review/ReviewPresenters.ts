import * as vscode from 'vscode';
import type { ReviewControls, ReviewEditors } from '@/core/review/ReviewControls';
import type { Reviews } from '@/core/review/Reviews';
import { applyReviewEdit, saveForReview } from './ReviewTakeovers';

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

const openDocument = (path: string) => vscode.workspace.textDocuments.find(({ uri }) => uri.scheme === 'file' && uri.fsPath === path);

export const vscodeReviewEditors: ReviewEditors = {
  activePath,
  /** `vscode.open`, as it opens a tab for a file not there too, which a text document cannot. */
  open: async (path) => { await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path)); },
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
};

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
 * bar. Each is shown again when what it depends on changes; quick diff's markers show a file's changes.
 */
export class ReviewPresenters implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly controls: ReviewControls,
    reviews: Reviews,
    private readonly display: ReviewDisplay = vscodeReviewDisplay(),
  ) {
    reviews.addListener(() => this.showAll());
    this.subscriptions = [
      vscode.window.tabGroups.onDidChangeTabs(() => this.showPosition()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.showPosition()),
    ];
    this.showAll();
  }

  dispose(): void {
    for (const subscription of this.subscriptions) { subscription.dispose(); }
    this.display.dispose();
  }

  private showAll(): void {
    this.display.review(this.controls.sessionShown(), this.controls.reviewedPaths().map((path) => vscode.Uri.file(path)));
    this.showPosition();
  }

  private showPosition(): void {
    this.display.position(this.controls.position(activePath()));
  }
}
