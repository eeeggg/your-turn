import { EventEmitter } from 'node:events';

/** Persistent key-value storage; VS Code's `workspaceState` satisfies it. */
export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

/**
 * Persistent client-side cache of past sessions per agent. Used to render the
 * tree-tier-2 (sessions under an agent) for agents that support
 * `session/load` or `session/resume` but do NOT advertise the experimental
 * `session/list` capability.
 *
 * When the agent supports `session/list`, that is the source of truth and
 * this store is NOT consulted (to avoid divergence).
 */
export interface PersistedSessionEntry {
  /** Agent name (as configured by the user). */
  agentName: string;
  /** Working directory the session was created in. */
  cwd: string;
  /** Session ID issued by the agent. */
  sessionId: string;
  /** Title supplied via `session_info_update`, if any. */
  title?: string;
  /** First user prompt of the session, used as a label fallback (truncated). */
  firstPrompt?: string;
  /** ISO timestamp when the session was first observed. */
  createdAt: string;
  /** ISO timestamp of the most recent activity (prompt end / update). */
  lastActiveAt: string;
}

/**
 * Versioned shape of the persisted state, so we can migrate later if needed.
 */
interface PersistedShape {
  version: 1;
  entries: PersistedSessionEntry[];
}

function isPersistedShape(raw: unknown): raw is PersistedShape {
  return typeof raw === 'object' && raw !== null
    && 'version' in raw && raw.version === 1
    && 'entries' in raw && Array.isArray(raw.entries);
}

const REQUIRED_FIELDS = ['agentName', 'cwd', 'sessionId', 'createdAt', 'lastActiveAt'] as const;
const OPTIONAL_FIELDS = ['title', 'firstPrompt'] as const;

/** Saved data outlives the code that wrote it, so each entry is checked before it is trusted. */
function isPersistedEntry(raw: unknown): raw is PersistedSessionEntry {
  if (typeof raw !== 'object' || raw === null) { return false; }
  const fields = raw as Record<string, unknown>;
  return REQUIRED_FIELDS.every((field) => typeof fields[field] === 'string')
    && OPTIONAL_FIELDS.every((field) => fields[field] === undefined || typeof fields[field] === 'string');
}

const STATE_KEY = 'acp.sessionHistory.v1';
const MAX_PROMPT_LEN = 120;
const DEFAULT_CAP_PER_AGENT = 50;

/**
 * Wraps workspace-scoped storage of {@link PersistedSessionEntry}. Entries are
 * scoped to the current workspace because we filter `session/list` (and our
 * own cache) by the workspace `cwd` — sessions from other workspaces aren't
 * relevant in this view.
 *
 * Emits `'changed'` whenever the cache mutates; the tree view subscribes for refresh.
 */
export class SessionHistoryStore extends EventEmitter<{ changed: [] }> {
  private entries: PersistedSessionEntry[] = [];

  constructor(
    private readonly workspaceState: KeyValueStore,
    private readonly capPerAgent: number = DEFAULT_CAP_PER_AGENT,
  ) {
    super();
    const raw = this.workspaceState.get<unknown>(STATE_KEY);
    if (isPersistedShape(raw)) {
      this.entries = raw.entries.filter(isPersistedEntry);
    }
  }

  /**
   * Get entries for a given agent + (optional) workspace cwd, sorted by
   * `lastActiveAt` descending. When `cwd` is omitted all workspace entries
   * for the agent are returned.
   */
  list(agentName: string, cwd?: string): PersistedSessionEntry[] {
    return this.entries
      .filter(e => e.agentName === agentName && (!cwd || e.cwd === cwd))
      .sort((a, b) => (b.lastActiveAt || '').localeCompare(a.lastActiveAt || ''));
  }

  /** Look up a specific entry by agent + session id. */
  get(agentName: string, sessionId: string): PersistedSessionEntry | undefined {
    return this.entries.find(e => e.agentName === agentName && e.sessionId === sessionId);
  }

  /**
   * Insert (or no-op if present) a new session entry. Called when the client
   * successfully creates a session via `session/new`.
   */
  upsertNew(agentName: string, cwd: string, sessionId: string): void {
    const existing = this.get(agentName, sessionId);
    if (existing) {
      // Refresh lastActiveAt so it floats to the top on re-render.
      existing.lastActiveAt = new Date().toISOString();
      this.persist();
      return;
    }
    const now = new Date().toISOString();
    this.entries.push({
      agentName,
      cwd,
      sessionId,
      createdAt: now,
      lastActiveAt: now,
    });
    this.enforceCap(agentName);
    this.persist();
  }

  /** Update title from a `session_info_update` notification. */
  setTitle(agentName: string, sessionId: string, title: string | null | undefined): void {
    const entry = this.get(agentName, sessionId);
    if (!entry) { return; }
    if (title === null) {
      delete entry.title;
    } else if (typeof title === 'string') {
      entry.title = title;
    }
    this.persist();
  }

  /** Record the first user prompt of a session for label fallback. */
  setFirstPromptIfMissing(agentName: string, sessionId: string, prompt: string): void {
    const entry = this.get(agentName, sessionId);
    if (!entry || entry.firstPrompt) { return; }
    entry.firstPrompt = prompt.slice(0, MAX_PROMPT_LEN);
    this.persist();
  }

  /** Bump `lastActiveAt` to now. Called on prompt end / session update. */
  touch(agentName: string, sessionId: string): void {
    const entry = this.get(agentName, sessionId);
    if (!entry) { return; }
    entry.lastActiveAt = new Date().toISOString();
    this.persist();
  }

  /** Remove a single entry (e.g. after a failed `session/load`). */
  forget(agentName: string, sessionId: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter(
      e => !(e.agentName === agentName && e.sessionId === sessionId),
    );
    if (this.entries.length !== before) {
      this.persist();
      return true;
    }
    return false;
  }

  /**
   * Reconcile against an agent-provided list (called only when the agent
   * supports `session/list`). Keeps the local store consistent with the
   * agent for future use, but the tree itself uses the agent's list directly.
   */
  reconcileFromAgent(agentName: string, knownSessionIds: Set<string>): void {
    const kept = this.entries.filter(e => e.agentName !== agentName || knownSessionIds.has(e.sessionId));
    if (kept.length === this.entries.length) { return; }
    this.entries = kept;
    this.persist();
  }

  private enforceCap(agentName: string): void {
    const forAgent = this.list(agentName);
    if (forAgent.length <= this.capPerAgent) { return; }
    const surplus = forAgent.slice(this.capPerAgent);
    const stale = new Set(surplus.map(e => e.sessionId));
    this.entries = this.entries.filter(
      e => !(e.agentName === agentName && stale.has(e.sessionId)),
    );
  }

  private persist(): void {
    const payload: PersistedShape = { version: 1, entries: this.entries };
    void this.workspaceState.update(STATE_KEY, payload);
    this.emit('changed');
  }

  dispose(): void {
    this.removeAllListeners();
  }
}
