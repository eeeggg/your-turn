import type { AcpSchema } from '@/core/acp/AcpDriver';
import type { QualifiedSessionUpdate, SessionIdentity, SessionRegistration, SessionLoad } from '@/core/SessionUpdateHandler';
import { FollowedFiles, type WatchFile } from '@/core/review/FollowedFiles';
import { Review, type ReadFile, type RestoreFile, type ReviewedFile } from '@/core/review/Review';
import { V1Guard } from '@/core/review/V1Guard';
import { V2Guard } from '@/core/review/V2Guard';

/** What reviews need of the files they review. */
export interface ReviewFiles {
  read: ReadFile;
  restore: RestoreFile;
  watch: WatchFile;
}

/** The shown review changed: another session's is shown, or a file in it came under review, changed or left it. */
export type ShownReviewListener = () => void;

interface SessionReview {
  identity: SessionIdentity;
  readonly review: Review;
  readonly guards: Map<string, { readonly schema: AcpSchema; readonly guard: V1Guard | V2Guard }>;
  readonly followed: FollowedFiles;
}

const keyOf = ({ configuredName, sessionId }: SessionIdentity): string => JSON.stringify([configuredName, sessionId]);
const identityOf = ({ agentName, sessionId }: SessionRegistration): SessionIdentity => ({ configuredName: agentName, sessionId });

/**
 * Retains each configuration/session's review independently of registration. Each source has its own guards;
 * load attempts suppress only that source/session's replay. Removal preserves admitted evidence and does not retire
 * the source. The selected registration projects its retained review.
 */
export class Reviews {
  private readonly sessions = new Map<string, SessionReview>();
  private readonly loading = new Map<string, SessionLoad>();
  private readonly listeners = new Set<ShownReviewListener>();
  /** Each session's updates so far, settled once all were taken. */
  private readonly taken = new Map<string, Promise<unknown>>();
  private readonly pending = new Set<Promise<void>>();
  private shownSessionId: string | null = null;
  private selected: SessionRegistration | null = null;
  private selectionRevision = 0;
  private disposed = false;
  private disposal: Promise<void> | undefined;

  constructor(private readonly files: ReviewFiles) {}

  configurationRenamed(from: string, to: string): void {
    if (this.selected) { this.shownSessionId = keyOf(identityOf(this.selected)); }
    for (const [key, session] of this.sessions) {
      if (session.identity.configuredName !== from) { continue; }
      this.sessions.delete(key);
      session.identity = { ...session.identity, configuredName: to };
      const renamed = keyOf(session.identity);
      this.sessions.set(renamed, session);
      const taken = this.taken.get(key);
      if (taken) { this.taken.delete(key); this.taken.set(renamed, taken); }
      if (this.shownSessionId === key) { this.shownSessionId = renamed; }
    }
  }

  sourceRetired(sourceId: string): void {
    if (this.selected?.agentId === sourceId) { this.selectionRevision++; }
    for (const session of this.sessions.values()) { session.guards.delete(sourceId); }
    for (const [key, load] of this.loading) {
      if (load.origin.sourceId === sourceId) { this.loading.delete(key); }
    }
  }

  addListener(listener: ShownReviewListener): void {
    if (this.disposed) { return; }
    this.listeners.add(listener);
  }

  removeListener(listener: ShownReviewListener): void {
    this.listeners.delete(listener);
  }

  /** Whether a session is active, even one whose review was not made yet, as it is made on its first update. */
  sessionShown(): boolean {
    return this.shownSessionId !== null;
  }

  shown(): Review | undefined {
    return this.shownSessionId === null ? undefined : this.sessions.get(this.shownSessionId)?.review;
  }

  /** A deletion decision must still belong to the shown review and to an absent disk file. */
  async deletionCurrent(file: ReviewedFile): Promise<boolean> {
    const review = this.shown();
    if (file.current !== null || review?.file(file.path) !== file) { return false; }
    const content = await this.files.read(file.path);
    return content === null && this.shown() === review && review.file(file.path) === file;
  }

  /** Settles once the files its evidence names were read. */
  handleSessionUpdate({ origin, update, schema }: QualifiedSessionUpdate): Promise<void> {
    const sessionId = keyOf(origin.identity);
    const sourceKey = JSON.stringify([origin.sourceId, origin.identity.sessionId]);
    if (this.disposed || this.loading.has(sourceKey)) { return Promise.resolve(); }
    const session = this.session(origin.identity);
    let guard = session.guards.get(origin.sourceId);
    if (guard?.schema !== schema) {
      guard = this.guard(schema, session.review);
      session.guards.set(origin.sourceId, guard);
    }
    const handled = guard.guard.handleSessionUpdate(update);
    this.pending.add(handled);
    void handled.then(
      () => this.pending.delete(handled),
      () => this.pending.delete(handled),
    );
    this.taken.set(sessionId, Promise.allSettled([this.taken.get(sessionId), handled]));
    return handled;
  }

  /** Settles once the session's updates so far were taken, as its turn can end before the files they name were read. */
  async afterShownTurn(registration: SessionRegistration, present: (review: Review, stillSelected: () => boolean) => Promise<void>): Promise<void> {
    if (this.disposed || this.selected !== registration) { return; }
    const entry = this.sessions.get(keyOf(identityOf(registration)));
    if (!entry) { return; }
    const revision = this.selectionRevision;
    const taken = this.taken.get(keyOf(entry.identity));
    const current = () => !this.disposed && this.selected === registration && this.selectionRevision === revision
      && this.sessions.get(keyOf(entry.identity)) === entry;
    await taken;
    if (current()) { await present(entry.review, current); }
  }

  loadStarted(load: SessionLoad): void {
    if (this.disposed) { return; }
    this.loading.set(JSON.stringify([load.origin.sourceId, load.origin.identity.sessionId]), load);
  }

  loadEnded(load: SessionLoad): void {
    const key = JSON.stringify([load.origin.sourceId, load.origin.identity.sessionId]);
    if (this.loading.get(key) === load) { this.loading.delete(key); }
  }

  /** A load it started will not end. */
  sessionRemoved(registration: SessionRegistration): void {
    if (this.selected === registration) { this.selectionRevision++; }
    for (const [key, load] of this.loading) {
      if (load.registration === registration) { this.loading.delete(key); }
    }
  }

  activeSessionChanged(registration: SessionRegistration | null): void {
    const sessionId = registration ? keyOf(identityOf(registration)) : null;
    if (this.disposed) { return; }
    if (registration === this.selected) { return; }
    this.selected = registration;
    this.selectionRevision++;
    this.shownSessionId = sessionId;
    this.changed();
  }

  dispose(): Promise<void> {
    if (this.disposal) { return this.disposal; }
    this.disposed = true;
    this.listeners.clear();
    this.shownSessionId = null;
    this.selected = null;
    const followed = [...this.sessions.values()].map((session) => session.followed.dispose());
    this.sessions.clear();
    this.loading.clear();
    this.taken.clear();
    this.disposal = Promise.allSettled([...this.pending, ...followed]).then((results) => {
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length > 0) {
        throw new AggregateError(failures.map((result) => result.reason as unknown), 'Failed to dispose reviews');
      }
    });
    return this.disposal;
  }

  private session(identity: SessionIdentity): SessionReview {
    const sessionId = keyOf(identity);
    let session = this.sessions.get(sessionId);
    if (!session) {
      const review = new Review(this.files.restore);
      review.addListener(() => {
        if (session && keyOf(session.identity) === this.shownSessionId) { this.changed(); }
      });
      session = { identity, review, guards: new Map(), followed: new FollowedFiles(review, this.files.read, this.files.watch) };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private guard(schema: AcpSchema, review: Review): { readonly schema: AcpSchema; readonly guard: V1Guard | V2Guard } {
    return { schema, guard: schema === 'v1' ? new V1Guard(review, this.files.read) : new V2Guard(review, this.files.read) };
  }

  private changed(): void {
    for (const listener of this.listeners) { listener(); }
  }
}
