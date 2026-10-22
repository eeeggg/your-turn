import { basename } from 'node:path';
import { messageOf } from '@/core/Log';
import { addedLines, type LineRange } from './AddedLines';
import type { Reviews } from './Reviews';

/** The editors the review's controls act on, by a file's path. */
export interface ReviewEditors {
  /** The file in the active editor, when it is one on disk. */
  activePath(): string | undefined;
  open(path: string): Promise<void>;
  showError(message: string): void;
}

/**
 * What the human sees of the shown review and does with it, from the editor's title area and the status bar: each
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

  /** The lines `text` added to the file's baseline; nothing for a file not under review. */
  addedLines(path: string, text: string): LineRange[] {
    const file = this.reviews.shown()?.file(path);
    return file ? addedLines(file.baseline, text) : [];
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
