import { createHash } from 'node:crypto';
import { savedOver, takenOver, type TextEdit, type UserEdit } from './Hunks';
import type { FileContent } from './Review';
import type { Reviews } from './Reviews';

/**
 * Who changed a document under review, as the adapter tells them apart: the user, the review itself (Undo Change, Undo
 * File), a save's participants (formatters), an undo or a redo, a revert of unsaved edits to the disk's text, or VS
 * Code reloading a document with none, which is the disk's new text, as the agent's write.
 */
export type EditSource = 'user' | 'review' | 'save' | 'undo' | 'revert' | 'reload';

/** One of a document change's edits, in the text before it, by its lines and by its text. */
export type DocumentEdit = UserEdit & TextEdit;

/** The texts each file's history keeps, the oldest forgotten first. */
const HISTORY_LENGTH = 200;

const hashOf = (text: string) => createHash('sha1').update(text).digest('base64');

/**
 * Keeps the shown review's baselines following the edits to the files' documents. The user's edits take over the
 * changes they touch; a save's go into the baseline where they touch none. Each file's history keeps the baseline it
 * had at each text its document had while under review, so an undo, a redo or a revert bringing a text back brings
 * its baseline back: Ctrl+Z after Undo Change brings the change back for review, and Ctrl+Z of a takeover the change it
 * took over. A reload is the disk's new text, never a return to an earlier one, so it leaves the baseline alone even
 * when the agent writes a text the document had.
 */
export class Takeovers {
  private readonly histories = new Map<string, Map<string, FileContent>>();

  constructor(private readonly reviews: Reviews) {
    reviews.addListener(() => this.forgetLeft());
  }

  edited(path: string, source: EditSource, before: string, after: string, edits: readonly DocumentEdit[]): void {
    const review = this.reviews.shown();
    const file = review?.file(path);
    if (!review || !file) {
      this.histories.delete(path);
      return;
    }
    this.remember(path, before, file.baseline);
    const baseline = this.followed(path, source, file.baseline, before, after, edits);
    if (baseline !== file.baseline) { review.setBaseline(path, baseline); }
    if (review.file(path)) { this.remember(path, after, baseline); }
  }

  private followed(path: string, source: EditSource, baseline: FileContent, before: string, after: string, edits: readonly DocumentEdit[]): FileContent {
    const text = baseline ?? '';
    const asText = (followed: string) => followed === text ? baseline : followed;
    switch (source) {
      case 'review':
      case 'reload':
        return baseline;
      case 'save':
        return asText(savedOver(text, before, edits));
      case 'user':
        return asText(takenOver(text, before, after, edits));
      case 'undo':
      case 'revert': {
        const earlier = this.histories.get(path)?.get(hashOf(after));
        if (earlier !== undefined) { return earlier; }
        return source === 'undo' ? asText(takenOver(text, before, after, edits)) : baseline;
      }
    }
  }

  /** A file out of the shown review forgets its history, so a round of review after it starts with none. */
  private forgetLeft(): void {
    const review = this.reviews.shown();
    for (const path of [...this.histories.keys()]) {
      if (!review?.file(path)) { this.histories.delete(path); }
    }
  }

  private remember(path: string, text: string, baseline: FileContent): void {
    const history = this.histories.get(path) ?? new Map<string, FileContent>();
    this.histories.set(path, history);
    const hash = hashOf(text);
    history.delete(hash);
    history.set(hash, baseline);
    if (history.size > HISTORY_LENGTH) {
      const [oldest] = history.keys();
      if (oldest !== undefined) { history.delete(oldest); }
    }
  }
}
