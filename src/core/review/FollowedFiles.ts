import { log, messageOf } from '@/core/Log';
import type { Review } from './Review';
import type { ReadFile } from './V1Guard';

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
  private disposed = false;

  constructor(
    private readonly review: Review,
    private readonly readFile: ReadFile,
    private readonly watchFile: WatchFile,
  ) {
    review.addListener((path) => this.follow(path));
  }

  /** Its review may still hear evidence read before, which starts no watcher now. */
  dispose(): void {
    this.disposed = true;
    for (const file of this.followed.values()) { file.watcher.dispose(); }
    this.followed.clear();
  }

  private follow(path: string): void {
    if (this.disposed) { return; }
    const file = this.followed.get(path);
    const underReview = this.review.file(path) !== undefined;
    if (underReview && !file) {
      const watched: Followed = { watcher: this.watchFile(path, () => void this.readAgain(path, watched)), reading: false, changes: 0 };
      this.followed.set(path, watched);
    } else if (!underReview && file) {
      file.watcher.dispose();
      this.followed.delete(path);
    }
  }

  private async readAgain(path: string, file: Followed): Promise<void> {
    file.changes++;
    if (file.reading) { return; }
    file.reading = true;
    let read = 0;
    while (read < file.changes) {
      read = file.changes;
      try {
        const content = await this.readFile(path);
        if (this.followed.get(path) === file) { this.review.read(path, content); }
      } catch (e) {
        log(`Review: ${path} not read after it changed: ${messageOf(e)}`);
      }
    }
    file.reading = false;
  }
}
