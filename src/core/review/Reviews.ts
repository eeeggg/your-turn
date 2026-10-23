import type { SessionUpdate } from '@/core/acp/AcpDriver';
import { FollowedFiles, type WatchFile } from './FollowedFiles';
import { Review, type ReadFile, type RestoreFile } from './Review';
import { V1Guard } from './V1Guard';

/** What reviews need of the files they review. */
export interface ReviewFiles {
  read: ReadFile;
  restore: RestoreFile;
  watch: WatchFile;
}

/** The shown review changed: another session's is shown, or a file in it came under review, changed or left it. */
export type ShownReviewListener = () => void;

interface SessionReview {
  readonly review: Review;
  readonly guard: V1Guard;
  readonly followed: FollowedFiles;
}

/**
 * Each session's review, the guard that feeds it and its files followed, made on its first update and kept until
 * disposed, so a session removed and opened again shows its review again; a removed session's turn may go on, so its
 * evidence is still taken. The one shown is the active session's, the one the chat view shows. A load's replay is not
 * evidence.
 */
export class Reviews {
  private readonly sessions = new Map<string, SessionReview>();
  private readonly loading = new Set<string>();
  private readonly listeners = new Set<ShownReviewListener>();
  private shownSessionId: string | null = null;

  constructor(private readonly files: ReviewFiles) {}

  addListener(listener: ShownReviewListener): void {
    this.listeners.add(listener);
  }

  /** Whether a session is active, even one whose review was not made yet, as it is made on its first update. */
  sessionShown(): boolean {
    return this.shownSessionId !== null;
  }

  shown(): Review | undefined {
    return this.shownSessionId === null ? undefined : this.sessions.get(this.shownSessionId)?.review;
  }

  /** Settles once the files its evidence names were read. */
  handleSessionUpdate(sessionId: string, update: SessionUpdate): Promise<void> {
    if (this.loading.has(sessionId)) { return Promise.resolve(); }
    return this.session(sessionId).guard.handleSessionUpdate(update);
  }

  loadStarted(sessionId: string): void {
    this.loading.add(sessionId);
  }

  loadEnded(sessionId: string): void {
    this.loading.delete(sessionId);
  }

  /** A load it started will not end. */
  sessionRemoved(sessionId: string): void {
    this.loading.delete(sessionId);
  }

  activeSessionChanged(sessionId: string | null): void {
    if (sessionId === this.shownSessionId) { return; }
    this.shownSessionId = sessionId;
    this.changed();
  }

  dispose(): void {
    for (const session of this.sessions.values()) { session.followed.dispose(); }
    this.sessions.clear();
  }

  private session(sessionId: string): SessionReview {
    let session = this.sessions.get(sessionId);
    if (!session) {
      const review = new Review(this.files.restore);
      review.addListener(() => {
        if (sessionId === this.shownSessionId) { this.changed(); }
      });
      session = { review, guard: new V1Guard(review, this.files.read), followed: new FollowedFiles(review, this.files.read, this.files.watch) };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private changed(): void {
    for (const listener of this.listeners) { listener(); }
  }
}
