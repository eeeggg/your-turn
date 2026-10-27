import { basename } from 'node:path';
import * as vscode from 'vscode';
import { logError } from '@/core/Log';
import type { Change } from '@/core/review/Hunks';
import type { ReviewControls, ReviewEditors } from '@/core/review/ReviewControls';
import type { Reviews } from '@/core/review/Reviews';
import { createReviewEditors } from './ReviewPresenters';

const SCHEME = 'acp-review-diff';
const enabled = () => vscode.workspace.getConfiguration('acp').get<string>('review.presentation', 'diffEditor') === 'diffEditor';

interface Baseline {
  readonly uri: vscode.Uri;
  text: string;
  opening?: Promise<unknown>;
}

type OpenDiff = (original: vscode.Uri, modified: vscode.Uri, title: string, options: vscode.TextDocumentShowOptions) => Thenable<unknown>;

interface LensChange {
  readonly review: string;
  readonly path: string;
  readonly baseline: string;
  readonly document: string;
  readonly index: number;
}

/** Public diff editors use the real file on the right, so editing, saving and Ctrl+Z retain their normal ownership. */
export class DiffReviewPresentation implements ReviewEditors, vscode.CodeLensProvider, vscode.Disposable {
  private controls: ReviewControls | undefined;
  private review: ReturnType<Reviews['shown']>;
  private generation = 0;
  private identity = 0;
  private readonly baselines = new Map<string, Baseline>();
  private readonly retained = new Map<string, Baseline>();
  private readonly contentChanged = new vscode.EventEmitter<vscode.Uri>();
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensesChanged.event;
  private readonly subscriptions: vscode.Disposable[];
  private readonly registrations: vscode.Disposable[];
  private readonly position = vscode.window.createStatusBarItem('acp.review.change', vscode.StatusBarAlignment.Left, 98);
  private latest = Promise.resolve();
  private readonly pending = new Set<Promise<void>>();
  private disposed = false;
  private disposal: Promise<void> | undefined;
  private readonly reviewListener = () => this.changed();
  private readonly editors = createReviewEditors();

  constructor(
    private readonly reviews: Reviews,
    private readonly openDiff: OpenDiff = (...args) => vscode.commands.executeCommand('vscode.diff', ...args),
    private readonly closeTabs: (tabs: readonly vscode.Tab[]) => Thenable<boolean> = (tabs) => vscode.window.tabGroups.close(tabs, true),
  ) {
    this.review = reviews.shown();
    this.position.name = 'ACP Current Change';
    this.position.tooltip = 'Keep Change and Undo Change in the editor title act on this change; move the cursor to choose another';
    this.registrations = [
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
        onDidChange: this.contentChanged.event,
        provideTextDocumentContent: (uri) => this.retained.get(uri.toString())?.text ?? '',
      }),
      vscode.languages.registerCodeLensProvider([{ scheme: 'file' }, { scheme: SCHEME }], this),
    ];
    this.subscriptions = [
      vscode.window.onDidChangeTextEditorSelection(() => this.showPosition()),
      vscode.window.onDidChangeActiveTextEditor(() => this.showPosition()),
      vscode.window.tabGroups.onDidChangeTabs(() => this.showPosition()),
      vscode.workspace.onDidChangeTextDocument(() => { this.lensesChanged.fire(); this.showPosition(); }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('acp.review.presentation')) { this.changed(); }
      }),
    ];
    reviews.addListener(this.reviewListener);
  }

  attach(controls: ReviewControls): void {
    if (this.disposed) { return; }
    this.controls = controls;
    this.changed();
  }

  activePath(): string | undefined { return this.editors.activePath(); }
  text(path: string): string | undefined { return this.editors.text(path); }
  applyEdit(path: string, edit: Parameters<ReviewEditors['applyEdit']>[1]): Promise<boolean> { return this.editors.applyEdit(path, edit); }
  save(path: string): Promise<void> { return this.editors.save(path); }
  showError(message: string): void { this.editors.showError(message); }

  open(path: string): Promise<void> {
    return this.present(async () => {
      if (enabled() && this.controls?.baseline(path) !== undefined) { await this.showChange(path); }
      else { await this.editors.open(path); }
    });
  }

  showChange(path: string): Promise<void> {
    return this.present(async () => {
      if (!enabled()) { await this.editors.showChange(path); return; }
      await vscode.workspace.openTextDocument(vscode.Uri.file(path));
      if (this.disposed) { return; }
      const changes = this.controls?.changes(path) ?? [];
      if (changes.length > 0) { await this.showChangeOf(path, changes, 0); }
      // Disk evidence can precede VS Code's reload of an already-open document.
      else { await this.showDiff(path, 0); }
    });
  }

  showChangeOf(path: string, changes: readonly Change[], index: number): Promise<void> {
    return this.present(async () => {
      if (!enabled()) { await this.editors.showChangeOf(path, changes, index); return; }
      const change = changes[index];
      if (!change) { return; }
      const line = Math.max(0, change.modified.start - (change.modified.start === change.modified.end ? 1 : 0));
      await this.showDiff(path, line);
    });
  }

  private async showDiff(path: string, line: number): Promise<void> {
    const baseline = this.controls?.baseline(path);
    if (baseline === undefined) { return; }
    let entry = this.baselines.get(path);
    if (!entry) {
      entry = { uri: vscode.Uri.file(path).with({ scheme: SCHEME, query: String(++this.identity) }), text: baseline ?? '' };
      this.baselines.set(path, entry);
      this.retained.set(entry.uri.toString(), entry);
    }
    entry.text = baseline ?? '';
    const target = entry;
    const opening = (entry.opening ?? Promise.resolve()).then(async () => {
      if (this.baselines.get(path) !== target) { return; }
      await this.openDiff(target.uri, vscode.Uri.file(path), `${basename(path)} — ACP Review`, {
        preview: false, selection: new vscode.Range(line, 0, line, 0),
      });
    });
    // Reject this caller on failure, but let queued openings and tab cleanup continue.
    entry.opening = opening.catch(() => {});
    await opening;
    if (this.baselines.get(path) !== entry) { await this.latest; return; }
    if (!this.disposed) { this.lensesChanged.fire(); this.showPosition(); }
  }

  /** A full diff stays open during a decision; the review listener closes it when its file leaves review. */
  async closeChange(path: string): Promise<void> {
    if (this.disposed) { return; }
    if (!enabled()) { await this.editors.closeChange(path); }
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const path = document.uri.fsPath;
    if (this.disposed || !enabled() || !this.baselines.has(path) || !this.controls) { return []; }
    if (document.uri.scheme === SCHEME && this.baselines.get(path)?.uri.toString() !== document.uri.toString()) { return []; }
    const original = document.uri.scheme === SCHEME;
    const baseline = this.controls.baseline(path);
    const text = this.text(path);
    if (baseline === undefined || text === undefined) { return []; }
    const changes = this.controls.changes(path);
    return changes.flatMap((change, index) => {
      const side = original ? change.original : change.modified;
      const line = Math.min(document.lineCount - 1, Math.max(0, side.start - (side.end === side.start ? 1 : 0)));
      const range = new vscode.Range(line, 0, line, 0);
      const snapshot: LensChange = { review: String(this.generation), path, baseline: baseline ?? '', document: text, index };
      return [
        new vscode.CodeLens(range, { title: `Change ${index + 1} of ${changes.length}`, command: '' }),
        new vscode.CodeLens(range, { title: 'Keep Change', command: 'acp.keepDiffChange', arguments: [snapshot] }),
        new vscode.CodeLens(range, { title: 'Undo Change', command: 'acp.undoDiffChange', arguments: [snapshot] }),
      ];
    });
  }

  /** Lens commands carry a text snapshot; title commands resolve the cursor in either diff side at invocation. */
  async decide(action: 'keep' | 'undo', argument?: unknown): Promise<void> {
    if (this.disposed || !enabled() || !this.controls) { return; }
    let path: string;
    let change: Change | undefined;
    if (argument && typeof argument === 'object' && 'review' in argument) {
      const snapshot = argument as Partial<LensChange>;
      if (snapshot.review !== String(this.generation) || typeof snapshot.path !== 'string'
        || typeof snapshot.index !== 'number' || !Number.isInteger(snapshot.index)) { return; }
      path = snapshot.path;
      if ((this.controls.baseline(path) ?? '') !== snapshot.baseline || this.text(path) !== snapshot.document) { return; }
      change = this.controls.changes(path)[snapshot.index];
    } else {
      const selected = this.selectedChange();
      if (!selected) { return; }
      path = selected.path;
      change = selected.change;
    }
    if (change) {
      if (action === 'keep') { await this.controls.keepChange(path, change); }
      else { await this.controls.undoChange(path, change); }
      await this.latest;
    }
  }

  settled(): Promise<void> {
    return Promise.allSettled([this.latest, ...this.pending]).then(() => {});
  }

  dispose(): Promise<void> {
    if (this.disposal) { return this.disposal; }
    this.disposed = true;
    this.reviews.removeListener(this.reviewListener);
    const editors = this.editors.dispose();
    for (const subscription of this.subscriptions) { subscription.dispose(); }
    const closing = [...this.baselines].map(([path, entry]) => this.closeDiff(path, entry));
    this.latest = Promise.allSettled([this.latest, ...closing]).then(() => {});
    this.disposal = Promise.allSettled([...this.pending, this.latest, editors]).then((results) => {
      for (const registration of this.registrations) { registration.dispose(); }
      this.contentChanged.dispose();
      this.lensesChanged.dispose();
      this.position.dispose();
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length > 0) {
        throw new AggregateError(failures.map((result) => result.reason as unknown), 'Failed to dispose review diffs');
      }
    });
    return this.disposal;
  }

  private present(action: () => Promise<void>): Promise<void> {
    if (this.disposed) { return Promise.resolve(); }
    return this.track(action());
  }

  private track(pending: Promise<void>): Promise<void> {
    this.pending.add(pending);
    void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending));
    return pending;
  }

  private selectedChange(): { path: string; change: Change; index: number; total: number } | undefined {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (!(input instanceof vscode.TabInputTextDiff) || input.original.scheme !== SCHEME) { return undefined; }
    const path = input.modified.fsPath;
    if (this.baselines.get(path)?.uri.toString() !== input.original.toString()) { return undefined; }
    const editor = vscode.window.activeTextEditor;
    const original = editor?.document.uri.toString() === input.original.toString();
    if (!original && editor?.document.uri.toString() !== input.modified.toString()) { return undefined; }
    const selected = this.controls?.changeAt(path, editor.selection.active.line, original ? 'original' : 'modified');
    return selected && { path, ...selected };
  }

  private showPosition(): void {
    if (this.disposed) { return; }
    const selected = enabled() ? this.selectedChange() : undefined;
    void vscode.commands.executeCommand('setContext', 'acp.reviewDiffChange', selected !== undefined);
    if (selected) { this.position.text = `Change ${selected.index + 1} of ${selected.total}`; this.position.show(); }
    else { this.position.hide(); }
  }

  private changed(): void {
    if (this.disposed) { return; }
    const switched = this.review !== this.reviews.shown();
    this.review = this.reviews.shown();
    if (switched) { this.generation++; }
    const obsolete = [...this.baselines].filter(([path]) => switched || !enabled() || this.controls?.baseline(path) === undefined);
    // Keep retired content alive until VS Code has closed every tab using it.
    const closing = obsolete.map(([path, entry]) => this.closeDiff(path, entry));
    for (const [path, entry] of this.baselines) {
      if (obsolete.some(([, retired]) => retired === entry)) { continue; }
      entry.text = this.controls?.baseline(path) ?? '';
      this.contentChanged.fire(entry.uri);
    }
    this.latest = Promise.allSettled([this.latest, ...closing]).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') { logError('Closing review diffs failed', result.reason); }
      }
    });
    this.lensesChanged.fire();
    this.showPosition();
  }

  private closeDiff(path: string, entry: Baseline): Promise<void> {
    if (this.baselines.get(path) === entry) { this.baselines.delete(path); }
    return this.track((async () => {
      await entry.opening;
      const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter(({ input }) =>
        input instanceof vscode.TabInputTextDiff && input.original.toString() === entry.uri.toString());
      if (tabs.length > 0) { await this.closeTabs(tabs); }
    })());
  }
}
