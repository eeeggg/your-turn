import { basename } from 'node:path';
import { lineChanges, splitLines } from '@/core/diff/LineChanges';
import type { Change } from '@/core/review/Hunks';
import type { FileContent } from '@/core/review/Review';
import type { Reviews, ReviewDecision, ReviewDecisionResult } from '@/core/review/Reviews';
import type { SessionRegistration } from '@/core/sessions/UpdateHandler';

/** The editors the review's controls act on, by a file's path. */
export interface ReviewEditors {
  captureNavigation(): () => boolean;
  /** The file in the active editor, when it is one on disk. */
  activePath(): string | undefined;
  /** Whether this file's review presentation is open in an editor. */
  isOpen(path: string): boolean;
  open(path: string, stillCurrent?: () => boolean): Promise<void>;
  /** Opens the file with quick diff's view showing the change after the cursor, once VS Code has diffed it. */
  showChange(path: string, stillCurrent?: () => boolean): Promise<void>;
  /** Opens the file with quick diff's view showing `changes[index]`, once VS Code's diff of it is `changes`. */
  showChangeOf(path: string, changes: readonly Change[], index: number, stillCurrent?: () => boolean): Promise<void>;
  /** Closes quick diff's view on the file, before the review's edit would move it on to a change of VS Code's choice. */
  closeChange(path: string): Promise<void>;
  showError(message: string): void;
  /** The text of the file's open document, its unsaved edits included; undefined when it is not open. */
  text(path: string): string | undefined;
}

export type ReviewOpeningOutcome = 'opened' | 'already-open' | 'no-files' | 'not-automatic' | 'invalidated';

/**
 * What the user sees of the shown review and does with it, from the editor's title area and the status bar: each
 * command acts on the file it is given, or the active editor's. Moving between files goes round from the last to the
 * first.
 */
export class ReviewControls {
  constructor(private readonly reviews: Reviews, private readonly editors: ReviewEditors,
    private readonly canRevealDeferred = () => true) {}

  /** A session is active, so its review is shown, whether or not it has files yet. */
  sessionShown(): boolean {
    return this.reviews.sessionShown();
  }

  reviewedPaths(): string[] {
    return this.reviews.shown()?.files().map((file) => file.path) ?? [];
  }

  /**
   * "2 of 5" for the second of five files under review, "– of 5" for a file not under review, "0 of 0" with none;
   * nothing with no session shown.
   */
  position(path: string | undefined): string | undefined {
    if (!this.sessionShown()) { return undefined; }
    const paths = this.reviewedPaths();
    const index = path === undefined ? -1 : paths.indexOf(path);
    if (paths.length === 0) { return '0 of 0'; }
    return index < 0 ? `– of ${paths.length}` : `${index + 1} of ${paths.length}`;
  }

  /** The file's baseline in the shown review, `null` for a file the agent created; undefined for a file not under review. */
  baseline(path: string): FileContent | undefined {
    return this.reviews.shown()?.file(path)?.baseline;
  }

  deleted(path: string): boolean {
    return this.reviews.shown()?.file(path)?.current === null;
  }

  /** The unresolved changes against the open document, including unsaved edits. */
  changes(path: string): Change[] {
    if (this.deleted(path)) { return []; }
    const baseline = this.baseline(path);
    const document = this.editors.text(path);
    return baseline === undefined || document === undefined ? []
      : lineChanges(splitLines(baseline ?? ''), splitLines(document)).map(({ original, modified }) => ({ original, modified }));
  }

  /** The change at the cursor, otherwise the next one with wraparound; empty ranges anchor on the preceding line. */
  changeAt(path: string, line: number, side: 'original' | 'modified'): { change: Change; index: number; total: number } | undefined {
    const changes = this.changes(path);
    const anchor = (change: Change) => Math.max(0, change[side].start - (change[side].start === change[side].end ? 1 : 0));
    let index = changes.findIndex((change) => line >= anchor(change) && line < Math.max(anchor(change) + 1, change[side].end));
    if (index < 0) { index = changes.findIndex((change) => anchor(change) >= line); }
    if (index < 0) { index = 0; }
    const change = changes[index];
    return change && { change, index, total: changes.length };
  }

  /**
   * Keeps one change quick diff showed: the baseline takes the document's lines, and the file is saved. Nothing when the
   * change is no longer the document's, as the agent wrote the file since VS Code diffed it; its view shows the new one.
   * The view then shows the next change, as `showNextChange` says.
   */
  async keepChange(path: string, change: Change, captured?: ReviewDecision): Promise<void> {
    await this.decideChange('keep-change', path, change, captured);
  }

  /** Undoes one change quick diff showed: the document takes the baseline's lines, and the file is saved; then as Keep. */
  async undoChange(path: string, change: Change, captured?: ReviewDecision): Promise<void> {
    await this.decideChange('undo-change', path, change, captured);
  }

  async keepFile(path = this.editors.activePath()): Promise<void> {
    if (path === undefined) { return; }
    const decision = this.reviews.captureDecision({ action: 'keep-file', path });
    if (!decision) { return; }
    const paths = this.reviewedPaths();
    const active = this.editors.activePath() === path;
    const current = this.capturePresentation();
    const result = await this.reviews.decide(decision);
    if (!this.presentResult(result, path, 'kept') || !current()) { return; }
    await this.advanceAfterResolution(path, paths, active, false, current);
  }

  captureKeepAll(): ReviewDecision | undefined {
    return this.reviews.captureDecision({ action: 'keep-all' });
  }

  resolutionBlocked(): boolean { return this.reviews.resolutionBlocked(); }

  async keepAll(decision = this.captureKeepAll()): Promise<ReviewDecisionResult> {
    if (!decision) { return { kind: 'stale', reason: 'There are no captured files to keep.' }; }
    const result = await this.reviews.decide(decision);
    this.presentResult(result, 'Review', 'kept');
    return result;
  }

  /** A deleted file written back is opened again, as its editor still says it was not found. */
  async undoFile(path = this.editors.activePath()): Promise<void> {
    if (path === undefined) { return; }
    const file = this.reviews.shown()?.file(path);
    const decision = this.reviews.captureDecision({ action: 'undo-file', path });
    if (!file || !decision) { return; }
    const paths = this.reviewedPaths();
    const active = this.editors.activePath() === file.path;
    const current = this.capturePresentation();
    const result = await this.reviews.decide(decision);
    if (!this.presentResult(result, path, 'undone') || !current()) { return; }
    const next = active ? this.nextUnresolved(file.path, paths) : undefined;
    if (file.current === null && next === undefined) { await this.editors.open(file.path, current); }
    await this.advanceAfterResolution(file.path, paths, active, false, current);
  }

  next(path = this.editors.activePath()): Promise<void> {
    return this.move(path, 1);
  }

  previous(path = this.editors.activePath()): Promise<void> {
    return this.move(path, -1);
  }

  /** Opens the first unresolved file in review order, independent of the active editor. */
  async openReview(): Promise<void> {
    const path = this.reviews.shown()?.files()[0]?.path;
    if (path !== undefined) { await this.editors.showChange(path); }
  }

  /**
   * The shown session's turn ended: the first unresolved change in review order, once the files its edits name were
   * read, unless a review presentation is already open.
   */
  async turnEnded(registration: SessionRegistration, opportunityCurrent = () => true, deferred = false): Promise<ReviewOpeningOutcome> {
    const navigationCurrent = this.editors.captureNavigation();
    const outcome = await this.reviews.afterShownTurn(registration, async (review, stillSelected): Promise<ReviewOpeningOutcome> => {
      if (!stillSelected() || !opportunityCurrent() || !navigationCurrent()) { return 'invalidated'; }
      if (deferred && !this.canRevealDeferred()) { return 'not-automatic'; }
      const files = review.files();
      if (files.some((file) => this.editors.isOpen(file.path))) { return 'already-open'; }
      const file = files[0];
      if (!file) { return 'no-files'; }
      const attempt = { invalidated: false };
      await this.editors.showChange(file.path, () => {
        attempt.invalidated ||= !stillSelected() || !opportunityCurrent() || !navigationCurrent() || review.file(file.path) !== file
          || (deferred && !this.canRevealDeferred());
        return !attempt.invalidated;
      });
      return attempt.invalidated || !stillSelected() || !opportunityCurrent() ? 'invalidated' : 'opened';
    });
    return outcome ?? 'invalidated';
  }

  /**
   * The user came to a file's editor, Next and Previous File's among them: a change in quick diff's view while the file
   * is under review, as VS Code closes the view when its editor shows another file.
   */
  async entered(path: string): Promise<void> {
    const file = this.reviews.shown()?.file(path);
    if (file) { await this.editors.showChange(path); }
  }

  /**
   * Quick diff's view on the change after one just kept or undone, which now starts where that one did or after, or on
   * the first from the last; none once the file has no change left.
   */
  private async showNextChange(path: string, done: Change, current: () => boolean): Promise<void> {
    const baseline = this.baseline(path);
    const document = this.editors.text(path);
    if (baseline === undefined || document === undefined) { return; }
    const changes = this.changes(path);
    if (changes.length === 0) { return; }
    const after = changes.findIndex(({ modified }) => modified.start >= done.modified.start);
    await this.editors.showChangeOf(path, changes, after < 0 ? 0 : after, current);
  }

  private async decideChange(action: 'keep-change' | 'undo-change', path: string, change: Change, captured?: ReviewDecision): Promise<void> {
    const decision = captured ?? this.reviews.captureDecision({ action, path, change });
    if (!decision) { return; }
    const paths = this.reviewedPaths();
    const active = this.editors.activePath() === path;
    const current = this.capturePresentation();
    await this.editors.closeChange(path);
    const result = await this.reviews.decide(decision);
    if (result.kind === 'failed' && result.reason === 'The change could not be undone.') {
      this.editors.showError(`${basename(path)}: the change could not be undone`);
      return;
    }
    if (!this.presentResult(result, path, action === 'keep-change' ? 'kept' : 'undone') || !current()) { return; }
    await this.showNextChange(path, change, current);
    if (current()) { await this.advanceAfterResolution(path, paths, active, this.changes(path).length === 0, current); }
  }

  private capturePresentation(): () => boolean {
    const selected = this.reviews.captureSelection();
    const navigation = this.editors.captureNavigation();
    return () => selected() && navigation();
  }

  private presentResult(result: ReviewDecisionResult, path: string, done: 'kept' | 'undone'): boolean {
    if (result.kind === 'applied') { return true; }
    if (result.kind === 'failed') {
      this.editors.showError(result.unsaved.length > 0
        ? `${basename(path)}: the change was ${done} but the file could not be saved: ${result.reason}`
        : `${basename(path)} could not be ${done}: ${result.reason}`);
    } else if (result.kind === 'blocked') { this.editors.showError(result.reason); }
    return false;
  }

  /** From a file not under review, the first or the last. */
  private async move(path: string | undefined, step: 1 | -1): Promise<void> {
    const paths = this.reviewedPaths();
    if (paths.length === 0) { return; }
    const index = path === undefined ? -1 : paths.indexOf(path);
    const from = index < 0 ? (step === 1 ? -1 : paths.length) : index;
    const to = paths[(from + step + paths.length) % paths.length];
    if (to !== undefined) { await this.editors.open(to); }
  }

  /** After the active file leaves review, continue with the next unresolved file in the order before it left. */
  private async advanceAfterResolution(
    path: string,
    before: readonly string[],
    wasActive: boolean,
    resolvedByAction = false,
    current: () => boolean = () => true,
  ): Promise<void> {
    if (!wasActive || (!resolvedByAction && this.reviews.shown()?.file(path))) { return; }
    const index = before.indexOf(path);
    if (index < 0) { return; }
    const candidate = this.nextUnresolved(path, before);
    if (candidate !== undefined) { await this.editors.open(candidate, current); }
  }

  private nextUnresolved(path: string, before: readonly string[]): string | undefined {
    const index = before.indexOf(path);
    if (index < 0) { return undefined; }
    const files = this.reviews.shown()?.files() ?? [];
    const unresolved = new Set(files.map((file) => file.path));
    for (let offset = 1; offset < before.length; offset++) {
      const candidate = before[(index + offset) % before.length];
      if (candidate !== undefined && candidate !== path && unresolved.has(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }
}
