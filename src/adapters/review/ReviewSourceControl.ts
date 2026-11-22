import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { ReviewControls } from '@/core/review/ReviewControls';
import type { Reviews, ReviewDecision } from '@/core/review/Reviews';
import type { Change } from '@/core/review/Hunks';

/** The scheme of a file's baseline as quick diff opens it: the file's URI with this scheme in place of `file`. */
export const BASELINE_SCHEME = 'review-baseline';

/**
 * The review's own source control, there only because the stable API gives quick diff an original through a source
 * control alone: each file under review in the shown review has its baseline as its original, so VS Code draws its
 * markers and its inline change view, and the Source Control view lists those files. VS Code asks for a file's
 * original again only when it diffs again, which a change to the list makes it do, so a file that comes under review
 * after VS Code reloaded it, and another session's files, get their markers; a baseline that changes is diffed again
 * as its document's content changes.
 */
export class ReviewSourceControl implements vscode.Disposable {
  private readonly files: vscode.SourceControlResourceGroup;
  private readonly baselineChanged = new vscode.EventEmitter<vscode.Uri>();
  private readonly baselines: vscode.Disposable;
  private readonly documents: vscode.Disposable;
  private readonly changed = () => this.show();
  private readonly openCommand: vscode.Disposable;
  private readonly command = `_your-turn.openReviewResource.${randomUUID()}`;
  private review: ReturnType<Reviews['shown']>;
  private generation = 0;
  private disposed = false;
  private readonly comparisons = new Map<string, { changes: readonly Change[]; keep: readonly ReviewDecision[]; undo: readonly ReviewDecision[] }>();

  constructor(
    private readonly controls: ReviewControls,
    private readonly reviews: Reviews,
    private readonly control = vscode.scm.createSourceControl('your-turn-review-buffer', 'Review Buffer'),
  ) {
    this.files = control.createResourceGroup('files', 'Files Under Review');
    this.openCommand = vscode.commands.registerCommand(this.command, async (generation: number, path: string) => {
      if (generation !== this.generation || this.reviews.shown() !== this.review || this.controls.baseline(path) === undefined) { return; }
      await this.controls.entered(path);
    });
    this.control.inputBox.visible = false;
    this.control.quickDiffProvider = { provideOriginalResource: (uri) => this.originalResource(uri) };
    this.files.hideWhenEmpty = true;
    this.baselines = vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, {
      onDidChange: this.baselineChanged.event,
      provideTextDocumentContent: (uri) => {
        this.publish(uri.fsPath);
        return this.controls.baseline(uri.with({ scheme: 'file' }).fsPath) ?? '';
      },
    });
    this.documents = vscode.workspace.onDidOpenTextDocument((document) => {
      if (document.uri.scheme === 'file') { this.publish(document.uri.fsPath); }
    });
    reviews.addListener(this.changed);
    this.show();
  }

  /** The baseline's URI for a file under review in the shown review; none for any other. */
  originalResource(uri: vscode.Uri): vscode.Uri | undefined {
    if (this.disposed) { return undefined; }
    if (uri.scheme === 'file') { this.publish(uri.fsPath); }
    return uri.scheme === 'file' && this.controls.baseline(uri.fsPath) !== undefined ? uri.with({ scheme: BASELINE_SCHEME }) : undefined;
  }

  captureChange(action: 'keep' | 'undo', path: string, changes: readonly Change[], index: number): ReviewDecision | undefined {
    const comparison = this.comparisons.get(path);
    if (!comparison || JSON.stringify(comparison.changes) !== JSON.stringify(changes)) { return undefined; }
    return comparison[action][index];
  }

  private publish(path: string): void {
    if (this.disposed || this.controls.baseline(path) === undefined) { this.comparisons.delete(path); return; }
    // shortcut: stable quick diff carries no rendered version; use provenance if a stable API exposes it.
    const changes = this.controls.changes(path);
    const keep: ReviewDecision[] = [];
    const undo: ReviewDecision[] = [];
    for (const change of changes) {
      const kept = this.reviews.captureDecision({ action: 'keep-change', path, change });
      const undone = this.reviews.captureDecision({ action: 'undo-change', path, change });
      if (!kept || !undone) { this.comparisons.delete(path); return; }
      keep.push(kept);
      undo.push(undone);
    }
    this.comparisons.set(path, { changes, keep, undo });
  }

  listedFiles(): string[] {
    return this.files.resourceStates.map((file) => file.resourceUri.fsPath);
  }

  dispose(): void {
    this.disposed = true;
    this.comparisons.clear();
    this.reviews.removeListener(this.changed);
    this.baselines.dispose();
    this.documents.dispose();
    this.openCommand.dispose();
    this.baselineChanged.dispose();
    this.control.dispose();
  }

  private show(): void {
    if (this.review !== this.reviews.shown()) { this.generation++; this.comparisons.clear(); }
    this.review = this.reviews.shown();
    const left = this.listedFiles();
    const paths = this.controls.reviewedPaths();
    for (const path of this.comparisons.keys()) {
      if (!paths.includes(path)) { this.comparisons.delete(path); }
    }
    this.files.resourceStates = paths.map((path) => {
      const resourceUri = vscode.Uri.file(path);
      return { resourceUri, command: { command: this.command, title: 'Open Review', arguments: [this.generation, path] } };
    });
    for (const path of new Set([...left, ...paths])) {
      this.baselineChanged.fire(vscode.Uri.file(path).with({ scheme: BASELINE_SCHEME }));
    }
  }
}
