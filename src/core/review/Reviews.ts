import type { AcpSchema, SessionUpdate } from '@/core/acp/AcpDriver';
import { FollowedFiles, type WatchFile } from './FollowedFiles';
import { Review, type ReadFile, type RestoreFile } from './Review';
import { V1Guard } from './V1Guard';
import { V2Guard } from './V2Guard';

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
  /** The sibling of the driver whose update came last. */
  guard: { readonly schema: AcpSchema; readonly guard: V1Guard | V2Guard };
  readonly followed: FollowedFiles;
}

/**
 * Each session's review, the guard that feeds it and its files followed, made on its first update and kept until
 * disposed, so a session removed and opened again shows its review again; a removed session's turn may go on, so its
 * evidence is still taken. The guard is the sibling of the driver that passed the update up, made anew, the review
 * kept, when another driver's update comes for the session. The one shown is the active session's, the one the chat
 * view shows. A load's replay is not evidence.
 */
export class Reviews {
  private readonly sessions = new Map<string, SessionReview>();
  private readonly loading = new Set<string>();
  private readonly listeners = new Set<ShownReviewListener>();
  /** Each session's updates so far, settled once all were taken. */
  private readonly taken = new Map<string, Promise<unknown>>();
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
  handleSessionUpdate(sessionId: string, update: SessionUpdate, schema: AcpSchema): Promise<void> {
    if (this.loading.has(sessionId)) { return Promise.resolve(); }
    const session = this.session(sessionId, schema);
    if (session.guard.schema !== schema) { session.guard = this.guard(schema, session.review); }
    const handled = session.guard.guard.handleSessionUpdate(update);
    this.taken.set(sessionId, Promise.allSettled([this.taken.get(sessionId), handled]));
    return handled;
  }

  /** Settles once the session's updates so far were taken, as its turn can end before the files they name were read. */
  async settled(sessionId: string): Promise<void> {
    await this.taken.get(sessionId);
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
    this.taken.delete(sessionId);
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

  private session(sessionId: string, schema: AcpSchema): SessionReview {
    let session = this.sessions.get(sessionId);
    if (!session) {
      const review = new Review(this.files.restore);
      review.addListener(() => {
        if (sessionId === this.shownSessionId) { this.changed(); }
      });
      session = { review, guard: this.guard(schema, review), followed: new FollowedFiles(review, this.files.read, this.files.watch) };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private guard(schema: AcpSchema, review: Review): SessionReview['guard'] {
    return { schema, guard: schema === 'v1' ? new V1Guard(review, this.files.read) : new V2Guard(review, this.files.read) };
  }

  private changed(): void {
    for (const listener of this.listeners) { listener(); }
  }
}
