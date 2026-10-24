import * as vscode from 'vscode';
import type { ReviewControls } from '@/core/review/ReviewControls';
import type { Reviews } from '@/core/review/Reviews';

/** The scheme of a file's baseline as quick diff opens it: the file's URI with this scheme in place of `file`. */
const BASELINE_SCHEME = 'review-baseline';

/**
 * The review's own source control, there only because the stable API gives quick diff an original through a source
 * control alone: each file under review in the shown review has its baseline as its original, so VS Code draws its
 * markers and its inline change view, and the Source Control view lists those files. VS Code asks for a file's
 * original again only when it diffs again, which a change to the list makes it do, so a file that comes under review
 * after VS Code reloaded it, and another session's files, get their markers; a baseline that changes is diffed again
 * as its document's content changes.
 */
export class ReviewSourceControl implements vscode.Disposable {
  private readonly control = vscode.scm.createSourceControl('acp-review', 'ACP Review');
  private readonly files = this.control.createResourceGroup('files', 'Files Under Review');
  private readonly baselineChanged = new vscode.EventEmitter<vscode.Uri>();
  private readonly baselines: vscode.Disposable;

  constructor(private readonly controls: ReviewControls, reviews: Reviews) {
    this.control.inputBox.visible = false;
    this.control.quickDiffProvider = { provideOriginalResource: (uri) => this.originalResource(uri) };
    this.files.hideWhenEmpty = true;
    this.baselines = vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, {
      onDidChange: this.baselineChanged.event,
      provideTextDocumentContent: (uri) => this.controls.baseline(uri.with({ scheme: 'file' }).fsPath) ?? '',
    });
    reviews.addListener(() => this.show());
    this.show();
  }

  /** The baseline's URI for a file under review in the shown review; none for any other. */
  originalResource(uri: vscode.Uri): vscode.Uri | undefined {
    return uri.scheme === 'file' && this.controls.baseline(uri.fsPath) !== undefined ? uri.with({ scheme: BASELINE_SCHEME }) : undefined;
  }

  listedFiles(): string[] {
    return this.files.resourceStates.map((file) => file.resourceUri.fsPath);
  }

  dispose(): void {
    this.baselines.dispose();
    this.baselineChanged.dispose();
    this.control.dispose();
  }

  private show(): void {
    this.files.resourceStates = this.controls.reviewedPaths().map((path) => {
      const resourceUri = vscode.Uri.file(path);
      return { resourceUri, command: { command: 'vscode.open', title: 'Open', arguments: [resourceUri] } };
    });
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme === BASELINE_SCHEME) { this.baselineChanged.fire(document.uri); }
    }
  }
}
