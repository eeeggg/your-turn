import { EventEmitter } from 'node:events';
import type { SessionInfo as ListedSession } from '@agentclientprotocol/sdk';
import { logError, messageOf } from './Log';
import type { SessionHistoryStore } from './SessionHistoryStore';
import { AuthenticationCancelled, type AgentCapabilitySummary, type SessionManager } from './SessionManager';

export interface AgentEntry {
  readonly name: string;
  readonly hasSession: boolean;
  /** False only when the agent is known to keep no past sessions and session history has none. */
  readonly expandable: boolean;
}

export interface SessionRow {
  readonly sessionId: string;
  readonly label: string;
  /** How long ago the session was last active, such as `3h ago`. */
  readonly age?: string;
  readonly tooltip: string;
  readonly isActive: boolean;
}

export type MoreSessions =
  | { readonly kind: 'none' }
  | { readonly kind: 'available' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string };

type Failure =
  | { readonly kind: 'auth-required' }
  | { readonly kind: 'failed'; readonly message: string };

export type AgentSessions =
  | { readonly kind: 'loading' }
  | Failure
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'listed'; readonly source: 'agent' | 'history'; readonly rows: readonly SessionRow[]; readonly more: MoreSessions };

type Listing =
  | { readonly kind: 'loading' }
  | Failure
  | { readonly kind: 'listed'; readonly sessions: readonly ListedSession[]; readonly nextCursor: string | undefined; readonly more: MoreSessions };

const NO_MORE: MoreSessions = { kind: 'none' };
const SESSION_EVENTS = ['session-added', 'session-removed', 'active-session-changed', 'session-info-changed'] as const;

/**
 * The past sessions shown under each agent. An agent that can list its
 * sessions is the source of truth; otherwise session history is, for an agent
 * that can load or resume them.
 *
 * An agent's list is requested once and kept, including a failure, until
 * {@link invalidate}. Emits `'changed'` whenever what it would show changes.
 */
export class SessionList extends EventEmitter {
  private readonly listings = new Map<string, Listing>();
  private readonly announce = () => this.emit('changed');

  constructor(
    private readonly sessions: SessionManager,
    private readonly history: SessionHistoryStore,
    private readonly agentNames: () => string[],
    private readonly workspaceCwd: () => string | undefined,
    private readonly now: () => number = Date.now,
  ) {
    super();
    for (const event of SESSION_EVENTS) {
      sessions.on(event, this.announce);
    }
    history.on('changed', this.announce);
  }

  agents(): AgentEntry[] {
    return this.agentNames().map((name) => {
      const caps = this.sessions.getCachedCapabilities(name);
      const keepsNone = caps !== undefined && !caps.list && !caps.load && !caps.resume;
      return {
        name,
        hasSession: this.sessions.hasSession(name),
        expandable: !keepsNone || this.historyOf(name).length > 0,
      };
    });
  }

  /** Starts the agent first if its capabilities are not known yet. */
  async sessionsOf(agentName: string): Promise<AgentSessions> {
    let caps: AgentCapabilitySummary;
    try {
      caps = this.sessions.getCachedCapabilities(agentName) ?? await this.sessions.ensureConnected(agentName);
    } catch (e) {
      logError(`Failed to start agent ${agentName} to show its sessions`, e);
      return failure(e);
    }

    if (caps.list) {
      return this.listedByAgent(agentName);
    }
    if (caps.load || caps.resume) {
      const activeId = this.sessions.getActiveSessionId();
      const rows = this.historyOf(agentName).map((entry) => this.row(agentName, {
        sessionId: entry.sessionId,
        label: entry.title?.trim() || truncate(entry.firstPrompt?.trim() ?? '', 60) || shortSessionId(entry.sessionId),
        cwd: entry.cwd,
        lastActiveAt: entry.lastActiveAt,
      }, 'history', activeId));
      return { kind: 'listed', source: 'history', rows, more: NO_MORE };
    }
    return { kind: 'unsupported' };
  }

  /** Append the agent's next page of sessions, if it has one. */
  async loadMore(agentName: string): Promise<void> {
    const listing = this.listings.get(agentName);
    if (listing?.kind !== 'listed' || listing.nextCursor === undefined || listing.more.kind === 'loading') {
      return;
    }
    const loading: Listing = { ...listing, more: { kind: 'loading' } };
    this.listings.set(agentName, loading);
    this.announce();
    try {
      const page = await this.sessions.listSessions(agentName, { cwd: this.workspaceCwd(), cursor: listing.nextCursor });
      this.settle(agentName, loading, listed([...listing.sessions, ...page.sessions], page.nextCursor));
    } catch (e) {
      logError(`Failed to load more sessions for ${agentName}`, e);
      this.settle(agentName, loading, { ...listing, more: { kind: 'failed', message: messageOf(e) } });
    }
  }

  /** Forget the lists of one agent, or of all, so they are requested again. */
  invalidate(agentName?: string): void {
    if (agentName) {
      this.listings.delete(agentName);
    } else {
      this.listings.clear();
    }
    this.announce();
  }

  dispose(): void {
    for (const event of SESSION_EVENTS) {
      this.sessions.off(event, this.announce);
    }
    this.history.off('changed', this.announce);
    this.removeAllListeners();
  }

  private listedByAgent(agentName: string): AgentSessions {
    const listing = this.listings.get(agentName) ?? this.requestList(agentName);
    if (listing.kind !== 'listed') {
      return listing;
    }
    const activeId = this.sessions.getActiveSessionId();
    const rows = listing.sessions.map((info) => this.row(agentName, {
      sessionId: info.sessionId,
      label: info.title?.trim() || shortSessionId(info.sessionId),
      cwd: info.cwd,
      lastActiveAt: info.updatedAt ?? undefined,
    }, 'agent', activeId));
    return { kind: 'listed', source: 'agent', rows, more: listing.more };
  }

  private requestList(agentName: string): Listing {
    const loading: Listing = { kind: 'loading' };
    this.listings.set(agentName, loading);
    void this.sessions.listSessions(agentName, { cwd: this.workspaceCwd() }).then(
      (page) => this.settle(agentName, loading, listed(page.sessions, page.nextCursor)),
      (e: unknown) => {
        logError(`Failed to list sessions for ${agentName}`, e);
        this.settle(agentName, loading, failure(e));
      },
    );
    return loading;
  }

  /** Replace the listing that was pending, unless it was invalidated meanwhile. */
  private settle(agentName: string, pending: Listing, next: Listing): void {
    if (this.listings.get(agentName) !== pending) {
      return;
    }
    this.listings.set(agentName, next);
    this.announce();
  }

  private historyOf(agentName: string) {
    return this.history.list(agentName, this.workspaceCwd());
  }

  private row(
    agentName: string,
    session: { sessionId: string; label: string; cwd: string; lastActiveAt: string | undefined },
    source: 'agent' | 'history',
    activeId: string | null,
  ): SessionRow {
    const lines = [`Agent: ${agentName}`, `Session: ${session.sessionId}`, `cwd: ${session.cwd}`];
    if (session.lastActiveAt) {
      lines.push(`Last active: ${session.lastActiveAt}`);
    }
    lines.push(source === 'history' ? 'Stored locally — agent does not list sessions' : 'Listed by agent');
    const age = relativeTime(session.lastActiveAt, this.now());
    return {
      sessionId: session.sessionId,
      label: session.label,
      ...(age ? { age } : {}),
      tooltip: lines.join('\n'),
      isActive: session.sessionId === activeId,
    };
  }
}

function listed(sessions: readonly ListedSession[], nextCursor: string | undefined): Listing {
  return { kind: 'listed', sessions, nextCursor, more: nextCursor === undefined ? NO_MORE : { kind: 'available' } };
}

function failure(e: unknown): Failure {
  return e instanceof AuthenticationCancelled ? { kind: 'auth-required' } : { kind: 'failed', message: messageOf(e) };
}

function shortSessionId(id: string): string {
  return id.length <= 14 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function relativeTime(iso: string | undefined, now: number): string | undefined {
  const time = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(time)) {
    return undefined;
  }
  const seconds = Math.floor((now - time) / 1000);
  if (seconds < 0) {
    return 'just now';
  }
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  if (hours < 24) {
    return `${hours}h ago`;
  }
  if (days < 7) {
    return `${days}d ago`;
  }
  if (days < 35) {
    return `${Math.floor(days / 7)}w ago`;
  }
  if (days < 360) {
    return `${Math.floor(days / 30)}mo ago`;
  }
  return `${Math.floor(days / 365)}y ago`;
}
