import { logWarning, messageOf } from '@/core/Log';
import type { ReadFile, Review } from './Review';

/** Watches what is at `path`, calling `changed` whenever it may have changed, until disposed. */
export type WatchFile = (path: string, changed: () => void) => { dispose(): void };

interface Followed {
  readonly watcher: { dispose(): void };
  reading: boolean;
  /** How often its watcher heard it may have changed. */
  changes: number;
}

/**
 * Keeps a review's files following what they hold: each watched while under review and read again whenever it may
 * have changed, one read at a time, so an older read never lands after a newer one.
 */
export class FollowedFiles {
  private readonly followed = new Map<string, Followed>();
  private readonly pending = new Set<Promise<void>>();
  private disposed = false;
  private disposal: Promise<void> | undefined;
  private readonly reviewListener = (path: string) => this.follow(path);

  constructor(
    private readonly review: Review,
    private readonly readFile: ReadFile,
    private readonly watchFile: WatchFile,
  ) {
    review.addListener(this.reviewListener);
  }

  /** Its review may still hear evidence read before, which starts no watcher now. */
  dispose(): Promise<void> {
    if (this.disposal) { return this.disposal; }
    this.disposed = true;
    this.review.removeListener(this.reviewListener);
    const followed = [...this.followed.values()];
    this.followed.clear();
    const failures: unknown[] = [];
    for (const file of followed) {
      try { file.watcher.dispose(); }
      catch (error) { failures.push(error); }
    }
    this.disposal = Promise.allSettled(this.pending).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') { failures.push(result.reason); }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Failed to dispose followed files');
      }
    });
    return this.disposal;
  }

  private follow(path: string): void {
    if (this.disposed) { return; }
    const file = this.followed.get(path);
    const underReview = this.review.file(path) !== undefined;
    if (underReview && !file) {
      const watched: Followed = { watcher: this.watchFile(path, () => this.changed(path, watched)), reading: false, changes: 0 };
      this.followed.set(path, watched);
    } else if (!underReview && file) {
      file.watcher.dispose();
      this.followed.delete(path);
    }
  }

  private changed(path: string, file: Followed): void {
    if (this.disposed || this.followed.get(path) !== file) { return; }
    const reading = this.readAgain(path, file);
    this.pending.add(reading);
    void reading.then(
      () => this.pending.delete(reading),
      () => this.pending.delete(reading),
    );
  }

  private async readAgain(path: string, file: Followed): Promise<void> {
    file.changes++;
    if (file.reading) { return; }
    file.reading = true;
    let read = 0;
    while (read < file.changes && this.followed.get(path) === file) {
      read = file.changes;
      try {
        const content = await this.readFile(path);
        if (this.followed.get(path) === file) { this.review.read(path, content); }
      } catch (e) {
        logWarning('Review file could not be read after it changed', { path, reason: messageOf(e) });
      }
    }
    file.reading = false;
  }
}
