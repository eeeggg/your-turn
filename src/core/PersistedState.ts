import { EventEmitter } from 'node:events';
import { logError } from './Log';

/** Persistent key-value storage; VS Code's `workspaceState` and `globalState` satisfy it. */
export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** Where a session lives and how the extension reaches it. */
export interface SessionAddress {
  /** The `acp.agents` name the session was last used through. */
  readonly configuredName: string;
  readonly sessionId: string;
  /** The session's absolute agent cwd, immutable for the session. */
  readonly cwd: string;
  /** Scheme and authority, as the client sees them, of the machine the workspace's folders and agents are on. */
  readonly host: string;
  /** Full serialized VS Code workspace URI, as the client sees it; it may be on another machine than `host`. */
  readonly workspaceUri: string;
}

/** A session's options as last displayed, reapplied when it is loaded. */
export interface Selections {
  /** Only for agents using the separate modes API; a mode config option belongs in `options`. */
  readonly modeId?: string;
  readonly options: Readonly<Record<string, string | boolean>>;
}

/**
 * The extension's link between a session and the workspace and agent configuration it was used through. The session
 * itself stays the agent's; the title is only a cached label and the selections a deliberate exception.
 */
export interface SessionReference extends SessionAddress {
  /** When the user last used the session. */
  readonly lastActiveAt: string;
  /** Display-only cache of the last title the agent reported. */
  readonly title?: string;
  readonly selections: Selections;
}

/** The same session ID on another host or through another configuration is another reference. */
export interface ReferenceId {
  readonly host: string;
  readonly configuredName: string;
  readonly sessionId: string;
}

/** A session list one configuration's agent gave on one host. */
export interface ObservedListing {
  readonly host: string;
  readonly configuredName: string;
  readonly sessions: readonly { readonly sessionId: string; readonly title?: string | null | undefined }[];
  /**
   * Only for a listing filtered by `cwd` with no cursor sent or returned, which is everything the agent keeps there.
   * Sessions open in this window stay even when it omits them, as an agent may not store a session never prompted.
   */
  readonly complete?: { readonly cwd: string; readonly openInThisWindow: ReadonlySet<string> };
}

const REFERENCES_VERSION = 3;
const WORKSPACE_VERSION = 2;
const REFERENCES_KEY = 'acp.sessionReferences';
const WORKSPACE_KEY = 'acp.workspace';
const RETIRED_WORKSPACE_KEYS = ['acp.sessionHistory.v1'];
const CAPACITY = 500;
const DAY = 24 * 60 * 60 * 1000;
/** How long an instance keeps its own changes, as a read can never confirm them stored. */
const CHANGES_KEPT_FOR = DAY;
/** Well past `CHANGES_KEPT_FOR` on any machine's clock, so no kept change can bring back what was removed. */
const REMOVALS_KEPT_FOR = 30 * DAY;

/** A workspace a window can open again: a single folder, or a saved `.code-workspace` file. */
export interface WorkspaceTarget {
  /** Its full serialized URI, as the client sees it. */
  readonly uri: string;
  /** Scheme and authority, as the client sees them, of the machine its folders are on, which may not be the URI's. */
  readonly host: string;
}

/**
 * The session references, in global state so every workspace on every host of this VS Code application shares them.
 *
 * VS Code can serve an earlier global-state value after a write has finished, and windows write from overlapping
 * reads, so a read is never trusted on its own. Each reference and removal carries a revision, and each instance keeps
 * its own changes for a day and merges them with what it reads, the highest revision winning. A reset raises the
 * epoch, and a value from an earlier epoch is read as empty. Emits `'changed'` whenever a change is written.
 */
export class SessionReferences extends EventEmitter<{ changed: [] }> {
  private readonly writes = new Writes();
  /** The highest epoch this instance has read or written. */
  private epoch = 0;
  /** This instance's own changes, by reference identity, and when it made them. */
  private readonly kept = new Map<string, { readonly entry: Entry; readonly at: number }>();

  constructor(
    private readonly globalState: KeyValueStore,
    private readonly now: () => number = Date.now,
    private readonly capacity: number = CAPACITY,
  ) {
    super();
  }

  /** The references of one configuration in one cwd on one host, the most recently active first. */
  list(host: string, configuredName: string, cwd: string): SessionReference[] {
    return referencesIn(this.read().entries)
      .filter((reference) => reference.host === host && reference.configuredName === configuredName && reference.cwd === cwd)
      .map(withoutRevision);
  }

  get(id: ReferenceId): SessionReference | undefined {
    const entry = this.read().entries.get(keyOf(id));
    return entry && 'reference' in entry ? withoutRevision(entry.reference) : undefined;
  }

  /** The session was created, loaded or resumed, or a turn of it ended. */
  used(address: SessionAddress): Promise<void> {
    return this.upsert(address, (reference) => ({ ...reference, lastActiveAt: this.timestamp() }));
  }

  /** The agent reported the session's title, or that it has none. */
  setTitle(address: SessionAddress, title: string | null): Promise<void> {
    return this.upsert(address, (reference) => withTitle(reference, title));
  }

  /** The session's displayed options changed; they replace those saved. */
  saveSelections(address: SessionAddress, selections: Selections): Promise<void> {
    return this.upsert(address, (reference) => ({ ...reference, selections }));
  }

  /** Refresh the cached titles of referenced sessions the agent listed, and prune by a complete listing. */
  observeListing(listing: ObservedListing): Promise<void> {
    return this.change((references) => {
      const listed = new Map(listing.sessions.map((session) => [session.sessionId, session.title ?? null]));
      const inScope = (reference: SessionReference) =>
        reference.host === listing.host && reference.configuredName === listing.configuredName;
      const { complete } = listing;
      let changed = false;
      const next: SessionReference[] = [];
      for (const reference of references) {
        if (!inScope(reference)) {
          next.push(reference);
          continue;
        }
        const title = listed.get(reference.sessionId);
        if (title === undefined) {
          const pruned = complete?.cwd === reference.cwd && !complete.openInThisWindow.has(reference.sessionId);
          changed ||= pruned;
          if (!pruned) {
            next.push(reference);
          }
          continue;
        }
        const refreshed = withTitle(reference, title);
        changed ||= refreshed.title !== reference.title;
        next.push(refreshed);
      }
      return changed ? next : undefined;
    });
  }

  /** Settles once every write it started has, as its callers do not wait for them. */
  settled(): Promise<void> {
    return this.writes.settled();
  }

  /** Settles once every write it started has; it makes no more. */
  dispose(): Promise<void> {
    return this.writes.dispose();
  }

  /** Leave no references, at a new epoch so none from before can come back. */
  reset(): Promise<void> {
    if (this.writes.disposed) {
      return Promise.resolve();
    }
    const { value, writable } = readEnvelope(this.globalState, REFERENCES_KEY, REFERENCES_VERSION);
    if (!writable) {
      return Promise.resolve();
    }
    this.epoch = Math.max(this.epoch, epochFrom(value?.['epoch'])) + 1;
    this.kept.clear();
    return this.store({ schemaVersion: REFERENCES_VERSION, epoch: this.epoch, references: [], removed: [] });
  }

  /**
   * A configuration was renamed, or with `sessionId`, that session was loaded through another: the references on `host`
   * move to the new name. One that is already referenced under the new name keeps whichever of the two was active more
   * recently, with its title and selections.
   */
  rebind(host: string, from: string, to: string, sessionId?: string): Promise<void> {
    return this.change((references) => {
      const moving = references.filter((reference) => reference.host === host && reference.configuredName === from
        && (sessionId === undefined || reference.sessionId === sessionId));
      if (moving.length === 0) {
        return undefined;
      }
      const next = references.filter((reference) => !moving.includes(reference));
      for (const reference of moving) {
        const rebound = { ...reference, configuredName: to };
        const index = next.findIndex((other) => identifies(idOf(rebound), other));
        const existing = next[index];
        if (!existing) {
          next.push(rebound);
        } else if (Date.parse(rebound.lastActiveAt) > Date.parse(existing.lastActiveAt)) {
          next[index] = rebound;
        }
      }
      return next;
    });
  }

  remove(id: ReferenceId): Promise<void> {
    return this.change((references) => {
      const next = references.filter((reference) => !identifies(id, reference));
      return next.length === references.length ? undefined : next;
    });
  }

  /** Write or create the reference to `address`, which also brings its workspace URI up to date. */
  private upsert(address: SessionAddress, edit: (reference: SessionReference) => SessionReference): Promise<void> {
    return this.change((references) => {
      const existing = references.find((reference) => identifies(idOf(address), reference));
      const base: SessionReference = existing
        ? { ...existing, cwd: address.cwd, workspaceUri: address.workspaceUri }
        : { ...addressOf(address), lastActiveAt: this.timestamp(), selections: { options: {} } };
      const edited = edit(base);
      const others = references.filter((reference) => reference !== existing);
      return [...others, edited];
    });
  }

  /**
   * Apply a change to the references, then store them merged with what was read; `apply` answers undefined when
   * nothing changes. Each reference it changes, adds or leaves out takes the next revision and is kept.
   */
  private change(apply: (references: readonly SessionReference[]) => SessionReference[] | undefined): Promise<void> {
    if (this.writes.disposed) {
      return Promise.resolve();
    }
    const { entries, writable } = this.read();
    if (!writable) {
      return Promise.resolve();
    }
    const before = new Map(referencesIn(entries).map((reference) => [keyOf(idOf(reference)), withoutRevision(reference)]));
    const next = apply([...before.values()]);
    if (!next) {
      return Promise.resolve();
    }
    const at = this.now();
    const after = new Map(next.map((reference) => [keyOf(idOf(reference)), reference]));
    const changes = new Map<string, Entry>();
    for (const [key, reference] of after) {
      const previous = before.get(key);
      if (previous !== reference && (!previous || serialized(previous) !== serialized(reference))) {
        changes.set(key, { reference: { ...reference, revision: revisionAfter(entries.get(key)) } });
      }
    }
    for (const [key, previous] of before) {
      if (!after.has(key)) {
        changes.set(key, { removal: { ...idOf(previous), revision: revisionAfter(entries.get(key)), removedAt: new Date(at).toISOString() } });
      }
    }
    if (changes.size === 0) {
      return Promise.resolve();
    }
    for (const [key, entry] of changes) {
      entries.set(key, entry);
      this.kept.set(key, { entry, at });
    }
    const references = referencesIn(entries);
    for (const evicted of references.splice(this.capacity)) {
      this.kept.delete(keyOf(idOf(evicted)));
    }
    const removed = [...entries.values()]
      .flatMap((entry) => ('removal' in entry ? [entry.removal] : []))
      .filter((removal) => at - Date.parse(removal.removedAt) < REMOVALS_KEPT_FOR);
    return this.store({ schemaVersion: REFERENCES_VERSION, epoch: this.epoch, references, removed });
  }

  private store(stored: StoredReferences): Promise<void> {
    const writing = this.writes.track(write(this.globalState, REFERENCES_KEY, stored, 'session references'));
    this.emit('changed');
    return writing;
  }

  /** What is stored, merged with the changes this instance keeps. */
  private read(): { entries: Map<string, Entry>; writable: boolean } {
    const entries = new Map<string, Entry>();
    const { value, writable } = readEnvelope(this.globalState, REFERENCES_KEY, REFERENCES_VERSION);
    if (!writable) {
      return { entries, writable };
    }
    const epoch = epochFrom(value?.['epoch']);
    if (epoch > this.epoch) {
      this.epoch = epoch;
      this.kept.clear();
    }
    if (value && epoch === this.epoch) {
      for (const reference of listOf(value['references'], storedReferenceOf)) {
        merge(entries, keyOf(idOf(reference)), { reference });
      }
      for (const removal of listOf(value['removed'], removalOf)) {
        merge(entries, keyOf(removal), { removal });
      }
    }
    const now = this.now();
    for (const [key, { entry, at }] of this.kept) {
      const read = entries.get(key);
      if (now - at >= CHANGES_KEPT_FOR || (read && revisionOf(read) > revisionOf(entry))) {
        this.kept.delete(key);
      } else {
        merge(entries, key, entry);
      }
    }
    return { entries, writable };
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }
}

interface StoredReference extends SessionReference {
  readonly revision: number;
}

interface Removal extends ReferenceId {
  readonly revision: number;
  readonly removedAt: string;
}

/** What is known of one reference identity: the reference, or its removal. */
type Entry = { readonly reference: StoredReference } | { readonly removal: Removal };

function idOf({ host, configuredName, sessionId }: SessionAddress): ReferenceId {
  return { host, configuredName, sessionId };
}

function identifies(id: ReferenceId, reference: SessionReference): boolean {
  return keyOf(id) === keyOf(idOf(reference));
}

function keyOf({ host, configuredName, sessionId }: ReferenceId): string {
  return JSON.stringify([host, configuredName, sessionId]);
}

function revisionOf(entry: Entry): number {
  return 'reference' in entry ? entry.reference.revision : entry.removal.revision;
}

function revisionAfter(entry: Entry | undefined): number {
  return (entry ? revisionOf(entry) : 0) + 1;
}

/** Keep the entry that wins: the higher revision, then a removal, then the greater serialized entry, as every instance would. */
function merge(entries: Map<string, Entry>, key: string, entry: Entry): void {
  const current = entries.get(key);
  if (!current || wins(entry, current)) {
    entries.set(key, entry);
  }
}

function wins(entry: Entry, over: Entry): boolean {
  const revision = revisionOf(entry) - revisionOf(over);
  if (revision !== 0) {
    return revision > 0;
  }
  if (('removal' in entry) !== ('removal' in over)) {
    return 'removal' in entry;
  }
  return serialized(entry) > serialized(over);
}

/** JSON with every object's fields in order, so equal values serialize alike. */
function serialized(value: unknown): string {
  return JSON.stringify(value, (_key, field: unknown) => (isRecord(field)
    ? Object.fromEntries(Object.entries(field).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : field));
}

/** The references among the entries, the most recently active first. */
function referencesIn(entries: Map<string, Entry>): StoredReference[] {
  return [...entries.values()]
    .flatMap((entry) => ('reference' in entry ? [entry.reference] : []))
    .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
}

function withoutRevision({ revision: _revision, ...reference }: StoredReference): SessionReference {
  return reference;
}

/** What the extension keeps for the workspace a window has open, in that workspace's state. */
export class WorkspaceState {
  private readonly writes = new Writes();

  constructor(private readonly workspaceState: KeyValueStore) {}

  /** The session last active in this workspace. */
  lastActiveSession(): SessionAddress | undefined {
    return this.read().stored.lastActiveSession;
  }

  setLastActiveSession(address: SessionAddress): Promise<void> {
    return this.change({ lastActiveSession: addressOf(address) });
  }

  /** This workspace's target as the window holds it, once a remote window has learned it. */
  workspaceTarget(): WorkspaceTarget | undefined {
    return this.read().stored.workspaceTarget;
  }

  setWorkspaceTarget({ uri, host }: WorkspaceTarget): Promise<void> {
    return this.change({ workspaceTarget: { uri, host } });
  }

  /** A configuration was renamed: the last active session moves to the new name if it was used through the old. */
  rebind(from: string, to: string): Promise<void> {
    const last = this.read().stored.lastActiveSession;
    return last?.configuredName === from ? this.change({ lastActiveSession: { ...last, configuredName: to } }) : Promise.resolve();
  }

  /** Delete what earlier versions kept, without reading it. */
  discardRetired(): Promise<void> {
    if (this.writes.disposed) {
      return Promise.resolve();
    }
    const discarding = Promise.all(RETIRED_WORKSPACE_KEYS.map((key) => write(this.workspaceState, key, undefined, 'retired workspace state')));
    return this.writes.track(discarding.then(() => undefined));
  }

  /** Settles once every write it started has, as its callers do not wait for them. */
  settled(): Promise<void> {
    return this.writes.settled();
  }

  /** Settles once every write it started has; it makes no more. */
  dispose(): Promise<void> {
    return this.writes.dispose();
  }

  /** Each field is replaced on its own, keeping the others valid. */
  private change(fields: Omit<StoredWorkspace, 'schemaVersion'>): Promise<void> {
    const { stored, writable } = this.read();
    if (this.writes.disposed || !writable) {
      return Promise.resolve();
    }
    return this.writes.track(write(this.workspaceState, WORKSPACE_KEY, { ...stored, ...fields }, 'workspace state'));
  }

  private read(): { stored: StoredWorkspace; writable: boolean } {
    const { value, writable } = readEnvelope(this.workspaceState, WORKSPACE_KEY, WORKSPACE_VERSION);
    const lastActiveSession = value && addressFrom(value['lastActiveSession']);
    const workspaceTarget = value && targetFrom(value['workspaceTarget']);
    return {
      stored: {
        schemaVersion: WORKSPACE_VERSION,
        ...(lastActiveSession ? { lastActiveSession } : {}),
        ...(workspaceTarget ? { workspaceTarget } : {}),
      },
      writable,
    };
  }
}

/** The writes one owner started and has not seen finish. */
export class Writes {
  private readonly pending = new Set<Promise<void>>();
  private disposal: Promise<void> | undefined;

  get disposed(): boolean {
    return this.disposal !== undefined;
  }

  track(writing: Promise<void>): Promise<void> {
    this.pending.add(writing);
    void writing.then(() => this.pending.delete(writing), () => this.pending.delete(writing));
    return writing;
  }

  settled(): Promise<void> {
    return Promise.allSettled(this.pending).then(() => {});
  }

  /** Failed writes are already logged, so disposal has none to report. */
  dispose(): Promise<void> {
    this.disposal ??= this.settled();
    return this.disposal;
  }
}

interface StoredReferences {
  schemaVersion: typeof REFERENCES_VERSION;
  epoch: number;
  references: StoredReference[];
  removed: Removal[];
}

interface StoredWorkspace {
  schemaVersion: typeof WORKSPACE_VERSION;
  lastActiveSession?: SessionAddress;
  workspaceTarget?: WorkspaceTarget;
}

/**
 * A key's envelope in the version this code writes, or none. A missing, malformed or earlier value may be replaced; a
 * later version is read as empty and never written, so this version cannot destroy what a newer one saved.
 */
function readEnvelope(store: KeyValueStore, key: string, current: number): { value: Record<string, unknown> | undefined; writable: boolean } {
  const raw = store.get<unknown>(key);
  if (!isRecord(raw)) {
    return { value: undefined, writable: true };
  }
  const version = raw['schemaVersion'];
  if (typeof version === 'number' && version > current) {
    return { value: undefined, writable: false };
  }
  return { value: version === current ? raw : undefined, writable: true };
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function epochFrom(raw: unknown): number {
  return isCount(raw) ? raw : 0;
}

/** The valid items of a stored list, or none if it is not one. */
function listOf<T>(raw: unknown, itemOf: (item: unknown) => T | undefined): T[] {
  return Array.isArray(raw) ? raw.map(itemOf).filter((item) => item !== undefined) : [];
}

function storedReferenceOf(raw: unknown): StoredReference | undefined {
  const reference = referenceOf(raw);
  const revision = isRecord(raw) ? raw['revision'] : undefined;
  return reference && isCount(revision) ? { ...reference, revision } : undefined;
}

function removalOf(raw: unknown): Removal | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const { host, configuredName, sessionId, revision, removedAt } = raw;
  return typeof host === 'string' && typeof configuredName === 'string' && typeof sessionId === 'string'
    && isCount(revision) && typeof removedAt === 'string'
    ? { host, configuredName, sessionId, revision, removedAt }
    : undefined;
}

/** A failed write is logged rather than thrown, so a session never fails over what the extension keeps about it. */
function write(store: KeyValueStore, key: string, value: unknown, what: string): Promise<void> {
  return Promise.resolve(store.update(key, value)).then(undefined, (e: unknown) => logError(`Failed to save ${what}`, e, { key }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Only the address's own fields, whatever else the object carries. */
function addressOf({ configuredName, sessionId, cwd, host, workspaceUri }: SessionAddress): SessionAddress {
  return { configuredName, sessionId, cwd, host, workspaceUri };
}

function withTitle(reference: SessionReference, title: string | null): SessionReference {
  const { title: _previous, ...rest } = reference;
  return title === null ? rest : { ...rest, title };
}

function addressFrom(raw: unknown): SessionAddress | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const { configuredName, sessionId, cwd, host, workspaceUri } = raw;
  return typeof configuredName === 'string' && typeof sessionId === 'string' && typeof cwd === 'string'
    && typeof host === 'string' && typeof workspaceUri === 'string'
    ? { configuredName, sessionId, cwd, host, workspaceUri }
    : undefined;
}

function targetFrom(raw: unknown): WorkspaceTarget | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const { uri, host } = raw;
  return typeof uri === 'string' && uri && typeof host === 'string' && host ? { uri, host } : undefined;
}

/** Saved data outlives the code that wrote it, so each reference is checked before it is trusted. */
function referenceOf(raw: unknown): SessionReference | undefined {
  const address = addressFrom(raw);
  if (!address || !isRecord(raw)) {
    return undefined;
  }
  const { lastActiveAt, title } = raw;
  const selections = selectionsFrom(raw['selections']);
  if (typeof lastActiveAt !== 'string' || (title !== undefined && typeof title !== 'string') || !selections) {
    return undefined;
  }
  return { ...address, lastActiveAt, ...(title !== undefined ? { title } : {}), selections };
}

function selectionsFrom(raw: unknown): Selections | undefined {
  if (!isRecord(raw) || !isRecord(raw['options'])) {
    return undefined;
  }
  const { modeId } = raw;
  const options = Object.entries(raw['options']);
  if ((modeId !== undefined && typeof modeId !== 'string') || !options.every(([, value]) => typeof value === 'string' || typeof value === 'boolean')) {
    return undefined;
  }
  return { ...(modeId !== undefined ? { modeId } : {}), options: Object.fromEntries(options) as Record<string, string | boolean> };
}
