import * as vscode from 'vscode';
import type { ReviewControls, ReviewEditors } from '@/core/review/ReviewControls';
import type { Reviews } from '@/core/review/Reviews';

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
  addedLines(editor: vscode.TextEditor, ranges: vscode.Range[]): void;
}

/** The file in the active tab, a diff's modified side among them, when it is one on disk. */
function activePath(): string | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  const uri = input instanceof vscode.TabInputText ? input.uri : input instanceof vscode.TabInputTextDiff ? input.modified : undefined;
  return uri?.scheme === 'file' ? uri.fsPath : undefined;
}

export const vscodeReviewEditors: ReviewEditors = {
  activePath,
  /** `vscode.open`, as it opens a tab for a file not there too, which a text document cannot. */
  open: async (path) => { await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path)); },
  showError: (message) => { void vscode.window.showErrorMessage(message); },
};

function vscodeReviewDisplay(): ReviewDisplay {
  const item = vscode.window.createStatusBarItem('acp.review', vscode.StatusBarAlignment.Left, 99);
  item.name = 'ACP Review';
  item.command = 'acp.nextReviewFile';
  item.tooltip = 'Files under review: go to the next one';
  const added = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
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
    addedLines: (editor, ranges) => editor.setDecorations(added, ranges),
    dispose: () => {
      item.dispose();
      added.dispose();
    },
  };
}

/**
 * Shows the shown review in the editor: the title area's buttons on every editor while a session is active, always in
 * the same order, those for a file enabled on its files only; the active file's place among them in the status bar;
 * and the lines each visible editor added to its file's baseline, its unsaved edits included. Each is shown again when
 * what it depends on changes.
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
      vscode.window.onDidChangeVisibleTextEditors((editors) => { for (const editor of editors) { this.decorate(editor); } }),
      vscode.workspace.onDidChangeTextDocument(({ document }) => {
        for (const editor of vscode.window.visibleTextEditors) {
          if (editor.document === document) { this.decorate(editor); }
        }
      }),
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
    for (const editor of vscode.window.visibleTextEditors) { this.decorate(editor); }
  }

  private showPosition(): void {
    this.display.position(this.controls.position(activePath()));
  }

  private decorate(editor: vscode.TextEditor): void {
    const { uri } = editor.document;
    const lines = uri.scheme === 'file' ? this.controls.addedLines(uri.fsPath, editor.document.getText()) : [];
    this.display.addedLines(editor, lines.map(({ first, last }) => new vscode.Range(first, 0, last, 0)));
  }
}
