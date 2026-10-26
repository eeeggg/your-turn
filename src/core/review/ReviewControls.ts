import { basename } from 'node:path';
import { lineChanges, splitLines } from '@/core/diff/LineChanges';
import { messageOf } from '@/core/Log';
import { keptChange, undoneChange, type Change, type TextEdit } from './Hunks';
import type { FileContent } from './Review';
import type { Reviews } from './Reviews';

/** The editors the review's controls act on, by a file's path. */
export interface ReviewEditors {
  /** The file in the active editor, when it is one on disk. */
  activePath(): string | undefined;
  open(path: string): Promise<void>;
  /** Opens the file with quick diff's view showing the change after the cursor, once VS Code has diffed it. */
  showChange(path: string): Promise<void>;
  /** Opens the file with quick diff's view showing `changes[index]`, once VS Code's diff of it is `changes`. */
  showChangeOf(path: string, changes: readonly Change[], index: number): Promise<void>;
  /** Closes quick diff's view on the file, before the review's edit would move it on to a change of VS Code's choice. */
  closeChange(path: string): Promise<void>;
  showError(message: string): void;
  /** The text of the file's open document, its unsaved edits included; undefined when it is not open. */
  text(path: string): string | undefined;
  /** Applies `edit` to the file's open document as an edit the user can undo; false when it was not applied. */
  applyEdit(path: string, edit: TextEdit): Promise<boolean>;
  /** Saves the file's open document when it has unsaved edits; rejects when it could not. */
  save(path: string): Promise<void>;
}

/** A change quick diff showed, as it still is between a file's baseline and its document. */
interface ShownChange {
  readonly baseline: string;
  readonly document: string;
  readonly change: Change;
}

/**
 * What the user sees of the shown review and does with it, from the editor's title area and the status bar: each
 * command acts on the file it is given, or the active editor's. Moving between files goes round from the last to the
 * first.
 */
export class ReviewControls {
  constructor(private readonly reviews: Reviews, private readonly editors: ReviewEditors) {}

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

  /** The unresolved changes against the open document, including unsaved edits. */
  changes(path: string): Change[] {
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
  async keepChange(path: string, change: Change): Promise<void> {
    const shown = this.shownChange(path, change);
    if (!shown) { return; }
    await this.editors.closeChange(path);
    this.reviews.shown()?.setBaseline(path, keptChange(shown.baseline, shown.document, shown.change));
    await this.save(path, 'kept');
    await this.showNextChange(path, shown.change);
  }

  /** Undoes one change quick diff showed: the document takes the baseline's lines, and the file is saved; then as Keep. */
  async undoChange(path: string, change: Change): Promise<void> {
    const shown = this.shownChange(path, change);
    if (!shown) { return; }
    await this.editors.closeChange(path);
    if (!(await this.editors.applyEdit(path, undoneChange(shown.baseline, shown.document, shown.change)))) {
      this.editors.showError(`${basename(path)}: the change could not be undone`);
      return;
    }
    await this.save(path, 'undone');
    await this.showNextChange(path, shown.change);
  }

  keepFile(path = this.editors.activePath()): void {
    if (path !== undefined) { this.reviews.shown()?.keepFile(path); }
  }

  keepAll(): void {
    this.reviews.shown()?.keepAll();
  }

  /** A deleted file written back is opened again, as its editor still says it was not found. */
  async undoFile(path = this.editors.activePath()): Promise<void> {
    const review = this.reviews.shown();
    const file = path === undefined ? undefined : review?.file(path);
    if (!review || !file) { return; }
    try {
      await review.undoFile(file.path);
    } catch (e) {
      this.editors.showError(`${basename(file.path)} could not be undone: ${messageOf(e)}`);
      return;
    }
    if (file.current === null) { await this.editors.open(file.path); }
  }

  next(path = this.editors.activePath()): Promise<void> {
    return this.move(path, 1);
  }

  previous(path = this.editors.activePath()): Promise<void> {
    return this.move(path, -1);
  }

  /** Opens the first unresolved file in review order, independent of the active editor; skips deleted files. */
  async openReview(): Promise<void> {
    const path = this.reviews.shown()?.files().find((file) => file.current !== null)?.path;
    if (path !== undefined) { await this.editors.showChange(path); }
  }

  /**
   * The shown session's turn ended: the first unresolved change in review order, once the files its edits name were
   * read; never a deleted file's, which no editor shows.
   */
  async turnEnded(sessionId: string): Promise<void> {
    await this.reviews.settled(sessionId);
    await this.openReview();
  }

  /**
   * The user came to a file's editor, Next and Previous File's among them: a change in quick diff's view while the file
   * is under review, as VS Code closes the view when its editor shows another file.
   */
  async entered(path: string): Promise<void> {
    const file = this.reviews.shown()?.file(path);
    if (file && file.current !== null) { await this.editors.showChange(path); }
  }

  /**
   * Quick diff's view on the change after one just kept or undone, which now starts where that one did or after, or on
   * the first from the last; none once the file has no change left.
   */
  private async showNextChange(path: string, done: Change): Promise<void> {
    const baseline = this.baseline(path);
    const document = this.editors.text(path);
    if (baseline === undefined || document === undefined) { return; }
    const changes = this.changes(path);
    if (changes.length === 0) { return; }
    const after = changes.findIndex(({ modified }) => modified.start >= done.modified.start);
    await this.editors.showChangeOf(path, changes, after < 0 ? 0 : after);
  }

  private shownChange(path: string, change: Change): ShownChange | undefined {
    const baseline = this.baseline(path);
    const document = this.editors.text(path);
    if (baseline === undefined || document === undefined) { return undefined; }
    const text = baseline ?? '';
    const still = this.changes(path).some(({ original, modified }) =>
      original.start === change.original.start && original.end === change.original.end
      && modified.start === change.modified.start && modified.end === change.modified.end);
    return still ? { baseline: text, document, change } : undefined;
  }

  private async save(path: string, done: 'kept' | 'undone'): Promise<void> {
    try {
      await this.editors.save(path);
    } catch (e) {
      this.editors.showError(`${basename(path)}: the change was ${done} but the file could not be saved: ${messageOf(e)}`);
    }
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
}
