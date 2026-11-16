import type { AcpSchema } from '@/core/acp/AcpDriver';
import { logWarning, messageOf } from '@/core/Log';
import type { QualifiedSessionUpdate, SessionIdentity, SessionRegistration, SessionLoad } from '@/core/SessionUpdateHandler';
import { FollowedFiles, type WatchFile } from '@/core/review/FollowedFiles';
import { Review, type ExamineEvidence, type ReadFile, type RestoreFile, type ReviewedFile } from '@/core/review/Review';
import { V1Guard } from '@/core/review/V1Guard';
import { V2Guard } from '@/core/review/V2Guard';
import { keptChange, undoneChange, type Change, type TextEdit } from '@/core/review/Hunks';
import { lineChanges, splitLines } from '@/core/diff/LineChanges';
import { Takeovers, type DocumentEdit, type EditSource } from '@/core/review/Takeovers';

/** What reviews need of the files they review. */
export interface ReviewFiles {
  read: ReadFile;
  restore: RestoreFile;
  watch: WatchFile;
  snapshot(path: string): ReviewDocument | undefined;
  applyEdit(path: string, edit: TextEdit, stillCurrent: () => boolean): Promise<boolean>;
  save(path: string): Promise<void>;
}

interface ReviewDocument {
  readonly instance: object;
  readonly version: number;
  readonly dirty: boolean;
  readonly text: string;
}

/** The shown review changed: another session's is shown, or a file in it came under review, changed or left it. */
export type ShownReviewListener = () => void;

export interface ReviewAdmission {
  resolutionBlocked(): boolean;
  onChanged(listener: () => void): () => void;
  runDecision<T>(action: (stillAdmitted: () => boolean) => Promise<T>): Promise<
    { kind: 'blocked' } | { kind: 'completed'; value: T }
  >;
}

export interface ReviewDecisionRequest {
  readonly action: 'keep-file' | 'keep-all' | 'undo-file' | 'keep-change' | 'undo-change';
  readonly path?: string;
  readonly change?: Change;
}

export interface ReviewDecision {
  readonly action: ReviewDecisionRequest['action'];
}

export interface ReviewDocumentObservation {
  readonly path: string;
  readonly source: EditSource;
  readonly before: string;
  readonly after: string;
  readonly edits: readonly DocumentEdit[];
}

export type ReviewDecisionResult =
  | { readonly kind: 'applied'; readonly saved: boolean; readonly resolved: readonly string[] }
  | { readonly kind: 'blocked' | 'stale'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string; readonly applied: readonly string[]; readonly unsaved: readonly string[] };

interface SessionReview {
  identity: SessionIdentity;
  readonly view: ReviewView;
  readonly guards: Map<string, { readonly schema: AcpSchema; readonly guard: V1Guard | V2Guard }>;
  readonly order: Map<string, number>;
}

interface ReviewView {
  files(): readonly ReviewedFile[];
  file(path: string): ReviewedFile | undefined;
}

class CapturedDecision implements ReviewDecision {
  constructor(
    readonly action: ReviewDecisionRequest['action'],
    readonly owner: Reviews,
    readonly entry: SessionReview,
    readonly registration: SessionRegistration,
    readonly revision: number,
    readonly files: readonly ReviewedFile[],
    readonly documents: readonly (ReviewDocument | undefined)[],
    readonly change: Change | undefined,
  ) {}
}

const keyOf = ({ configuredName, sessionId }: SessionIdentity): string => JSON.stringify([configuredName, sessionId]);
const identityOf = ({ agentName, sessionId }: SessionRegistration): SessionIdentity => ({ configuredName: agentName, sessionId });

/**
 * Retains shared pending files and each configuration/session's associations independently of registration. Each source has its own guards;
 * load attempts suppress only that source/session's replay. Removal preserves admitted evidence and does not retire
 * the source. The selected registration projects its associated shared files.
 */
export class Reviews {
  private readonly sessions = new Map<string, SessionReview>();
  private readonly loading = new Map<string, SessionLoad>();
  private readonly listeners = new Set<ShownReviewListener>();
  /** Each session's updates so far, settled once all were taken. */
  private readonly taken = new Map<string, Promise<unknown>>();
  private readonly pending = new Set<Promise<void>>();
  private readonly decisions = new Set<Promise<ReviewDecisionResult>>();
  private shownSessionId: string | null = null;
  private selected: SessionRegistration | null = null;
  private selectionRevision = 0;
  private disposed = false;
  private disposal: Promise<void> | undefined;
  private readonly detachAdmission: () => void;
  private readonly review: Review;
  private readonly followed: FollowedFiles;
  private readonly takeovers: Takeovers;
  private readonly ingress = new Map<string, Promise<boolean>>();
  private readonly lifetimes = new Map<string, { evidence: number }>();
  private readonly observations = new Map<string, Set<{ lifetime: object | undefined; retired: boolean }>>();
  private receipt = 0;

  constructor(private readonly files: ReviewFiles, private readonly admission: ReviewAdmission) {
    this.review = new Review();
    this.takeovers = new Takeovers(this.review);
    this.followed = new FollowedFiles(this.review, files.read, files.watch,
      (path, read) => this.enqueue(path, async () => { await read(); return true; }).then(() => {}));
    this.review.addListener((path) => {
      const shown = this.shownSessionId !== null && this.sessions.get(this.shownSessionId)?.order.has(path);
      if (!this.review.file(path)) {
        for (const observation of this.observations.get(path) ?? []) { observation.retired = true; }
        this.lifetimes.delete(path);
        for (const session of this.sessions.values()) { session.order.delete(path); }
      } else if (!this.lifetimes.has(path)) {
        const lifetime = { evidence: 0 };
        this.lifetimes.set(path, lifetime);
        for (const observation of this.observations.get(path) ?? []) {
          if (observation.lifetime === undefined && !observation.retired) { observation.lifetime = lifetime; }
        }
      }
      if (shown) { this.changed(); }
    });
    this.detachAdmission = admission.onChanged(() => this.changed());
  }

  resolutionBlocked(): boolean { return this.admission.resolutionBlocked(); }

  captureSelection(): () => boolean {
    const registration = this.selected;
    const revision = this.selectionRevision;
    return () => !this.disposed && this.selected === registration && this.selectionRevision === revision;
  }

  observeDocument({ path, source, before, after, edits }: ReviewDocumentObservation): Promise<void> {
    if (this.disposed) { return Promise.resolve(); }
    const observation = { lifetime: this.lifetimes.get(path), retired: false };
    const observations = this.observations.get(path) ?? new Set();
    this.observations.set(path, observations);
    observations.add(observation);
    const observing = this.enqueue(path, () => {
      if (this.disposed || observation.retired || this.lifetimes.get(path) !== observation.lifetime) { return Promise.resolve(false); }
      this.takeovers.edited(path, source, before, after, edits);
      return Promise.resolve(true);
    }).then(() => {}).finally(() => {
      observations.delete(observation);
      if (observations.size === 0) { this.observations.delete(path); }
    });
    this.pending.add(observing);
    void observing.then(() => this.pending.delete(observing), () => this.pending.delete(observing));
    return observing;
  }

  captureDecision(request: ReviewDecisionRequest): ReviewDecision | undefined {
    const registration = this.selected;
    const entry = this.shownSessionId === null ? undefined : this.sessions.get(this.shownSessionId);
    if (this.disposed || !registration || !entry) { return undefined; }
    const files = request.action === 'keep-all' ? entry.view.files()
      : request.path === undefined ? [] : [entry.view.file(request.path)].filter((file) => file !== undefined);
    if (files.length === 0) { return undefined; }
    const documents = files.map((file) => this.files.snapshot(file.path));
    if (request.action === 'keep-change' || request.action === 'undo-change') {
      const file = files[0];
      const document = documents[0];
      const change = request.change;
      if (file?.current == null || !document || !change
        || !lineChanges(splitLines(file.baseline ?? ''), splitLines(document.text)).some((candidate) =>
          candidate.original.start === change.original.start && candidate.original.end === change.original.end
          && candidate.modified.start === change.modified.start && candidate.modified.end === change.modified.end)) { return undefined; }
    }
    return new CapturedDecision(request.action, this, entry, registration, this.selectionRevision, files,
      documents, request.change && { original: { ...request.change.original }, modified: { ...request.change.modified } });
  }

  decide(decision: ReviewDecision): Promise<ReviewDecisionResult> {
    const deciding = this.applyDecision(decision);
    this.decisions.add(deciding);
    void deciding.then(() => this.decisions.delete(deciding), () => this.decisions.delete(deciding));
    return deciding;
  }

  private async applyDecision(decision: ReviewDecision): Promise<ReviewDecisionResult> {
    const stale = (): ReviewDecisionResult => ({ kind: 'stale', reason: 'The review decision is no longer current.' });
    const blocked = (): ReviewDecisionResult => ({ kind: 'blocked', reason: 'Workspace activity blocks review resolution.' });
    if (!(decision instanceof CapturedDecision) || decision.owner !== this) { return stale(); }
    const admitted = await this.admission.runDecision(async (stillAdmitted): Promise<ReviewDecisionResult> => {
      if (!stillAdmitted()) { return blocked(); }
      const received = decision.files.flatMap((file) => this.ingress.get(file.path) ?? []);
      if (received.length > 0) { await Promise.all(received); }
      if (!stillAdmitted()) { return blocked(); }
      if (!this.decisionCurrent(decision)) { return stale(); }
      if (decision.action === 'keep-change' || decision.action === 'undo-change') {
        const file = decision.files[0];
        const document = decision.documents[0];
        const change = decision.change;
        if (!file || !document || !change) { return stale(); }
        let applied = false;
        let saved = false;
        try {
          const edit = decision.action === 'undo-change' ? undoneChange(file.baseline ?? '', document.text, change) : undefined;
          if (decision.action === 'keep-change') {
            this.review.setBaseline(file.path, keptChange(file.baseline ?? '', document.text, change));
          } else if (edit && !(await this.files.applyEdit(file.path, edit,
            () => stillAdmitted() && this.decisionCurrent(decision)))) {
            if (!stillAdmitted()) { return blocked(); }
            if (!this.decisionCurrent(decision)) { return stale(); }
            throw new Error('The change could not be undone.');
          }
          applied = true;
          await this.settle(file.path);
          if (!stillAdmitted()) { throw new Error('Workspace activity interrupted review resolution after the change was applied.'); }
          const actual = this.files.snapshot(file.path);
          const expected = edit ? document.text.slice(0, edit.start) + edit.text + document.text.slice(edit.end) : document.text;
          const pending = this.review.file(file.path);
          if (!this.decisionOwnerCurrent(decision) || actual?.instance !== document.instance
            || actual.text !== expected || actual.version !== document.version + (edit ? 1 : 0)
            || (edit && pending !== file)) {
            throw new Error('The review target changed after the change was applied.');
          }
          const lifetime = this.lifetimes.get(file.path);
          const evidence = lifetime?.evidence;
          await this.files.save(file.path);
          saved = true;
          await this.settle(file.path);
          if (!this.decisionOwnerCurrent(decision) || !stillAdmitted()
            || (this.lifetimes.has(file.path) && this.lifetimes.get(file.path) !== lifetime) || lifetime?.evidence !== evidence) {
            throw new Error('The review target changed while the file was saved.');
          }
          return { kind: 'applied', saved: true,
            resolved: this.review.file(file.path) ? [] : [file.path] };
        } catch (error) {
          return { kind: 'failed', reason: error instanceof Error ? error.message : String(error),
            applied: applied ? [file.path] : [], unsaved: applied && !saved ? [file.path] : [] };
        }
      }
      try {
        for (const file of decision.files) {
          if (file.current === null && await this.files.read(file.path) !== null) { return stale(); }
          if (!stillAdmitted()) { return blocked(); }
          if (!this.decisionCurrent(decision)) { return stale(); }
        }
      } catch (error) {
        return { kind: 'failed', reason: error instanceof Error ? error.message : String(error), applied: [], unsaved: [] };
      }
      if (decision.action === 'undo-file') {
        const file = decision.files[0];
        if (!file) { return stale(); }
        try {
          if (await this.files.read(file.path) !== file.current) { return stale(); }
          if (!stillAdmitted()) { return blocked(); }
          if (!this.decisionCurrent(decision)) { return stale(); }
          await this.files.restore(file.path, file.baseline, (preparedDocument) =>
            stillAdmitted() && this.decisionCurrent(decision, preparedDocument));
          await this.settle(file.path);
          const saved = !decision.documents[0]?.dirty || file.baseline === null;
          const remaining = this.review.file(file.path);
          if (remaining && remaining !== file) {
            return { kind: 'failed', reason: 'The review target changed after the file was restored.', applied: [file.path], unsaved: [] };
          }
          if (remaining === file) { this.review.read(file.path, file.baseline); }
          return { kind: 'applied', saved, resolved: [file.path] };
        } catch (error) {
          if (!stillAdmitted()) { return blocked(); }
          if (!this.decisionCurrent(decision)) { return stale(); }
          return { kind: 'failed', reason: error instanceof Error ? error.message : String(error), applied: [], unsaved: [] };
        }
      }
      for (const file of decision.files) { this.review.keepFile(file.path); }
      return { kind: 'applied', saved: true, resolved: decision.files.map((file) => file.path) };
    });
    return admitted.kind === 'blocked' ? blocked() : admitted.value;
  }

  private decisionCurrent(decision: CapturedDecision, preparedDocument?: object): boolean {
    return this.decisionOwnerCurrent(decision)
      && decision.files.every((file, index) => {
        const captured = decision.documents[index];
        const document = this.files.snapshot(file.path);
        return !this.ingress.has(file.path) && decision.entry.view.file(file.path) === file
          && ((!captured && preparedDocument !== undefined && document?.instance === preparedDocument
            && !document.dirty && document.text === file.current)
            || (captured?.instance === document?.instance && captured?.version === document?.version
              && captured?.dirty === document?.dirty && captured?.text === document?.text));
      });
  }

  private decisionOwnerCurrent(decision: CapturedDecision): boolean {
    return !this.disposed && this.selected === decision.registration && this.selectionRevision === decision.revision
      && this.sessions.get(keyOf(decision.entry.identity)) === decision.entry;
  }

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

  shown(): ReviewView | undefined {
    return this.shownSessionId === null ? undefined : this.sessions.get(this.shownSessionId)?.view;
  }

  /** Settles once the files its evidence names were read. */
  handleSessionUpdate({ origin, update, schema }: QualifiedSessionUpdate): Promise<void> {
    const sessionId = keyOf(origin.identity);
    const sourceKey = JSON.stringify([origin.sourceId, origin.identity.sessionId]);
    if (this.disposed || this.loading.has(sourceKey)) { return Promise.resolve(); }
    const session = this.session(origin.identity);
    let guard = session.guards.get(origin.sourceId);
    if (guard?.schema !== schema) {
      guard = this.guard(schema, session);
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
  async afterShownTurn(registration: SessionRegistration, present: (review: ReviewView, stillSelected: () => boolean) => Promise<void>): Promise<void> {
    if (this.disposed || this.selected !== registration) { return; }
    const entry = this.sessions.get(keyOf(identityOf(registration)));
    if (!entry) { return; }
    const revision = this.selectionRevision;
    const taken = this.taken.get(keyOf(entry.identity));
    const received = entry.view.files().flatMap((file) => this.ingress.get(file.path) ?? []);
    const current = () => !this.disposed && this.selected === registration && this.selectionRevision === revision
      && this.sessions.get(keyOf(entry.identity)) === entry;
    await taken;
    if (!current()) { return; }
    const established = entry.view.files().flatMap((file) => this.ingress.get(file.path) ?? []);
    await Promise.all([...received, ...established]);
    if (current()) { await present(entry.view, current); }
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
    this.detachAdmission();
    this.listeners.clear();
    this.shownSessionId = null;
    this.selected = null;
    const followed = this.followed.dispose();
    this.sessions.clear();
    this.loading.clear();
    this.taken.clear();
    this.disposal = Promise.allSettled([...this.pending, ...this.decisions, followed]).then((results) => {
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
      const order = new Map<string, number>();
      const file = (path: string) => order.has(path) ? this.review.file(path) : undefined;
      const view: ReviewView = Object.freeze({
        files: () => [...order].sort((a, b) => a[1] - b[1]).flatMap(([path]) => file(path) ?? []),
        file,
      });
      session = { identity, view, guards: new Map(), order };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private guard(schema: AcpSchema, session: SessionReview): { readonly schema: AcpSchema; readonly guard: V1Guard | V2Guard } {
    const examine: ExamineEvidence = (path, validate) => {
      const receipt = ++this.receipt;
      const take = async (): Promise<boolean> => {
        let content;
        try { content = await this.files.read(path); }
        catch (error) {
          logWarning('Review change not examined because file could not be read', { path, reason: messageOf(error) });
          return false;
        }
        if (this.disposed) { return false; }
        const evidence = validate(content);
        if (!evidence) { return false; }
        const before = this.review.file(path);
        const associated = !session.order.has(path) && (before ? before.baseline !== content : evidence.before !== content);
        if (associated) { session.order.set(path, receipt); }
        this.review.changed(path, evidence.before, content);
        const lifetime = this.lifetimes.get(path);
        if (lifetime) { lifetime.evidence++; }
        if (associated && this.review.file(path) === before && keyOf(session.identity) === this.shownSessionId) { this.changed(); }
        return true;
      };
      return this.enqueue(path, take);
    };
    return { schema, guard: schema === 'v1' ? new V1Guard(examine) : new V2Guard(examine) };
  }

  private enqueue(path: string, take: () => Promise<boolean>): Promise<boolean> {
    const previous = this.ingress.get(path);
    const taken = previous ? previous.then(take, take) : take();
    this.ingress.set(path, taken);
    const finished = () => { if (this.ingress.get(path) === taken) { this.ingress.delete(path); } };
    void taken.then(finished, finished);
    return taken;
  }

  private async settle(path: string): Promise<void> {
    const received = this.ingress.get(path);
    if (received) { await received; }
  }

  private changed(): void {
    for (const listener of this.listeners) { listener(); }
  }
}
