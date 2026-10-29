import { EventEmitter } from 'node:events';
import { formatDistanceStrict } from 'date-fns';
import type { AgentCapabilities, ListedSession, SessionPage } from '@/core/acp/AcpDriver';
import { logError, messageOf } from './Log';
import type { SessionReferences, WorkspaceTarget } from './PersistedState';
import { AuthenticationCancelled, type SessionManager, type SessionOpening } from './SessionManager';

export interface AgentEntry {
  readonly name: string;
  readonly hasSession: boolean;
  /** False only when the agent is known to keep no past sessions and session history has none. */
  readonly expandable: boolean;
}

export interface SessionRow {
  readonly sessionId: string;
  readonly label: string;
  readonly age?: string;
  readonly tooltip: string;
  readonly isActive: boolean;
}

type MoreSessions =
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

interface Listed {
  readonly kind: 'listed';
  readonly sessions: readonly ListedSession[];
  /** How many of `sessions` the first page gave, which a refresh replaces. */
  readonly firstPage: number;
  readonly nextCursor: string | undefined;
  readonly more: MoreSessions;
}

type Listing = { readonly kind: 'loading' } | Failure | Listed;

/** What a session update or the end of a turn says about a session. */
interface Reported {
  readonly title?: string | null;
  readonly updatedAt?: string | null;
}

/** A value reported after the agent listed the session, and when, as a count of reports. */
interface Learned {
  readonly value: string | null;
  readonly at: number;
}

/** What became known about a listed session after the agent listed it. */
interface SinceListed {
  readonly title?: Learned;
  readonly updatedAt?: Learned;
}

const NO_MORE: MoreSessions = { kind: 'none' };
/** The label of a session without a title, as titles are never derived from what was said in it. */
const UNTITLED = 'Untitled';
const SESSION_EVENTS = ['session-added', 'active-session-changed'] as const;
/** Where a row's session came from, as its tooltip says. */
const SOURCES = {
  agent: 'Listed by agent',
  open: 'Open in this window, not yet listed by agent',
  history: 'Stored locally — agent does not list sessions',
} as const;

/**
 * The past sessions shown under each agent. An agent that can list its
 * sessions is the source of truth; otherwise session history is, for an agent
 * that can load or resume them.
 *
 * An agent's list is requested once and kept, including a failure, until
 * {@link invalidate}. A {@link refresh} asks for its first page again while it
 * stays shown: after the first turn of a session created here, once a session
 * is loaded or resumed, and whenever the adapter asks. Meanwhile a listed
 * session takes the title and time of last activity its session info updates
 * report, and the end of each turn as its last activity, until a list asked
 * for after them arrives. Emits `'changed'` whenever what it would show changes.
 */
export class SessionList extends EventEmitter<{ changed: [] }> {
  private readonly listings = new Map<string, Listing>();
  /** By agent name, then session ID. */
  private readonly sinceListed = new Map<string, Map<string, SinceListed>>();
  /** How many reports have been learned, so a list knows which came before it was asked for. */
  private reports = 0;
  /** The first page each agent is being asked for again, which every refresh meanwhile shares. */
  private readonly refreshing = new Map<string, Promise<void>>();
  /** Raised each time an agent's list starts over, so what was asked for before is not applied. */
  private readonly generations = new Map<string, number>();
  /** Sessions created here whose first turn has not ended. */
  private readonly awaitingFirstTurn = new Set<string>();
  private readonly announce = () => this.emit('changed');
  private readonly infoChanged = (sessionId: string, update: Reported) => {
    const agentName = this.sessions.getSession(sessionId)?.agentName;
    if (agentName) {
      this.learn(agentName, sessionId, update);
    }
  };
  private readonly turnEnded = (sessionId: string, agentName: string) => {
    this.learn(agentName, sessionId, { updatedAt: new Date(this.now()).toISOString() });
    if (this.awaitingFirstTurn.delete(sessionId)) {
      void this.refresh(agentName);
    }
  };
  private readonly opened = (sessionId: string, agentName: string, how: SessionOpening) => {
    if (how === 'created') {
      this.awaitingFirstTurn.add(sessionId);
    } else {
      void this.refresh(agentName);
    }
  };
  private readonly removed = (sessionId: string) => {
    this.awaitingFirstTurn.delete(sessionId);
    this.announce();
  };

  constructor(
    private readonly sessions: SessionManager,
    private readonly references: SessionReferences,
    private readonly agentNames: () => string[],
    private readonly workspaceCwd: () => string | undefined,
    private readonly workspaceTarget: () => WorkspaceTarget | undefined,
    private readonly now: () => number = Date.now,
  ) {
    super();
    for (const event of SESSION_EVENTS) {
      sessions.on(event, this.announce);
    }
    sessions.on('session-info-changed', this.infoChanged);
    sessions.on('turn-ended', this.turnEnded);
    sessions.on('session-opened', this.opened);
    sessions.on('session-removed', this.removed);
    references.on('changed', this.announce);
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
    let caps: AgentCapabilities;
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
      const rows = this.historyOf(agentName).map((reference) => this.row(agentName, {
        sessionId: reference.sessionId,
        label: reference.title?.trim() || UNTITLED,
        cwd: reference.cwd,
        lastActiveAt: reference.lastActiveAt,
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
    const generation = this.generationOf(agentName);
    this.listings.set(agentName, { ...listing, more: { kind: 'loading' } });
    this.announce();
    // A refresh meanwhile replaces the first page but keeps this one loading; a start over abandons it.
    const stillLoading = () => {
      const current = this.listings.get(agentName);
      return this.generationOf(agentName) === generation && current?.kind === 'listed' && current.more.kind === 'loading' ? current : undefined;
    };
    try {
      const page = await this.sessions.listSessions(agentName, { cwd: this.workspaceCwd(), cursor: listing.nextCursor });
      const current = stillLoading();
      if (current) {
        const shown = new Set(current.sessions.map((session) => session.sessionId));
        const sessions = [...current.sessions, ...page.sessions.filter((session) => !shown.has(session.sessionId))];
        this.listings.set(agentName, { ...current, sessions, nextCursor: page.nextCursor, more: moreAfter(page.nextCursor) });
        this.announce();
      }
    } catch (e) {
      logError(`Failed to load more sessions for ${agentName}`, e);
      const current = stillLoading();
      if (current) {
        this.listings.set(agentName, { ...current, more: { kind: 'failed', message: messageOf(e) } });
        this.announce();
      }
    }
  }

  /**
   * Ask a running agent whose sessions are shown for its first page again, keeping its later pages; anything else
   * is left as it is, so no automatic refresh starts an agent. Joins a refresh already in progress.
   */
  refresh(agentName: string): Promise<void> {
    if (this.listings.get(agentName)?.kind !== 'listed' || !this.sessions.isRunning(agentName)) {
      return Promise.resolve();
    }
    return this.refreshing.get(agentName) ?? this.requestFirstPage(agentName, false);
  }

  refreshAll(): Promise<void> {
    return Promise.all(this.agentNames().map((name) => this.refresh(name))).then(() => undefined);
  }

  /**
   * What the user asks for: the agent's first page alone, shown in place of the list once it arrives, or the list
   * asked for again when there is none to show. Unlike {@link refresh}, it may start the agent.
   */
  startOver(agentName: string): Promise<void> {
    if (this.listings.get(agentName)?.kind !== 'listed') {
      this.invalidate(agentName);
      return Promise.resolve();
    }
    this.generations.set(agentName, this.generationOf(agentName) + 1);
    return this.requestFirstPage(agentName, true);
  }

  /** Settles once no refresh is in progress. */
  async settled(): Promise<void> {
    while (this.refreshing.size > 0) {
      await Promise.all(this.refreshing.values());
    }
  }

  /** Forget an agent's list, and what became known since, so it is requested again. */
  invalidate(agentName: string): void {
    this.generations.set(agentName, this.generationOf(agentName) + 1);
    this.refreshing.delete(agentName);
    this.listings.delete(agentName);
    this.sinceListed.delete(agentName);
    this.announce();
  }

  dispose(): void {
    for (const event of SESSION_EVENTS) {
      this.sessions.off(event, this.announce);
    }
    this.sessions.off('session-info-changed', this.infoChanged);
    this.sessions.off('turn-ended', this.turnEnded);
    this.sessions.off('session-opened', this.opened);
    this.sessions.off('session-removed', this.removed);
    this.references.off('changed', this.announce);
    this.removeAllListeners();
  }

  private listedByAgent(agentName: string): AgentSessions {
    const listing = this.listings.get(agentName) ?? this.requestList(agentName);
    if (listing.kind !== 'listed') {
      return listing;
    }
    const activeId = this.sessions.getActiveSessionId();
    const known = this.sinceListed.get(agentName);
    const row = (session: ListedSession, source: 'agent' | 'open') => {
      const learned = known?.get(session.sessionId);
      const info = {
        ...session,
        ...(learned?.title ? { title: learned.title.value } : {}),
        ...(learned?.updatedAt ? { updatedAt: learned.updatedAt.value } : {}),
      };
      return this.row(agentName, {
        sessionId: info.sessionId,
        label: info.title?.trim() || UNTITLED,
        cwd: info.cwd,
        lastActiveAt: info.updatedAt ?? undefined,
      }, source, activeId);
    };
    // An agent may not list a session never prompted, and lists one only once it is asked again.
    const open = this.sessions.openSessionOf(agentName);
    const unlisted = open && !listing.sessions.some((listed) => listed.sessionId === open.sessionId)
      ? [row({ sessionId: open.sessionId, cwd: open.cwd, title: open.title ?? null, updatedAt: open.createdAt }, 'open')]
      : [];
    const rows = [...unlisted, ...listing.sessions.map((listed) => row(listed, 'agent'))];
    return { kind: 'listed', source: 'agent', rows, more: listing.more };
  }

  private learn(agentName: string, sessionId: string, { title, updatedAt }: Reported): void {
    const at = ++this.reports;
    const known = this.sinceListed.get(agentName) ?? new Map<string, SinceListed>();
    known.set(sessionId, {
      ...known.get(sessionId),
      ...(title !== undefined ? { title: { value: title, at } } : {}),
      ...(updatedAt !== undefined ? { updatedAt: { value: updatedAt, at } } : {}),
    });
    this.sinceListed.set(agentName, known);
    this.announce();
  }

  /** A list asked for after a report supersedes it, as the agent then knew of it. */
  private forgetReportedBy(agentName: string, at: number): void {
    const known = this.sinceListed.get(agentName);
    for (const [sessionId, { title, updatedAt }] of known ?? []) {
      const kept = { ...(title && title.at > at ? { title } : {}), ...(updatedAt && updatedAt.at > at ? { updatedAt } : {}) };
      if (kept.title || kept.updatedAt) {
        known?.set(sessionId, kept);
      } else {
        known?.delete(sessionId);
      }
    }
  }

  private requestFirstPage(agentName: string, startingOver: boolean): Promise<void> {
    const generation = this.generationOf(agentName);
    const reported = this.reports;
    const current = () => {
      const listing = this.listings.get(agentName);
      return this.generationOf(agentName) === generation && listing?.kind === 'listed' ? listing : undefined;
    };
    const request: Promise<void> = this.sessions.listSessions(agentName, { cwd: this.workspaceCwd() }).then(
      (page) => {
        const shown = current();
        if (shown) {
          this.forgetReportedBy(agentName, reported);
          this.listings.set(agentName, startingOver ? listed(page.sessions, page.nextCursor) : refreshed(shown, page));
          this.announce();
        }
      },
      (e: unknown) => {
        logError(`Failed to refresh sessions for ${agentName}`, e);
        // Only the user's start over reports a failure; an automatic refresh keeps what is shown.
        if (startingOver && current()) {
          this.listings.set(agentName, failure(e));
          this.announce();
        }
      },
    ).finally(() => {
      if (this.refreshing.get(agentName) === request) {
        this.refreshing.delete(agentName);
      }
    });
    this.refreshing.set(agentName, request);
    return request;
  }

  private generationOf(agentName: string): number {
    return this.generations.get(agentName) ?? 0;
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

  /** Session history for this window's host and cwd; a window with no workspace target has none. */
  private historyOf(agentName: string) {
    const target = this.workspaceTarget();
    const cwd = this.workspaceCwd();
    return target && cwd ? this.references.list(target.host, agentName, cwd) : [];
  }

  private row(
    agentName: string,
    session: { sessionId: string; label: string; cwd: string; lastActiveAt: string | undefined },
    source: 'agent' | 'open' | 'history',
    activeId: string | null,
  ): SessionRow {
    const lines = [`Agent: ${agentName}`, `Session: ${session.sessionId}`, `cwd: ${session.cwd}`];
    if (session.lastActiveAt) {
      lines.push(`Last active: ${session.lastActiveAt}`);
    }
    lines.push(SOURCES[source]);
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

function listed(sessions: readonly ListedSession[], nextCursor: string | undefined): Listed {
  return { kind: 'listed', sessions, firstPage: sessions.length, nextCursor, more: moreAfter(nextCursor) };
}

function moreAfter(nextCursor: string | undefined): MoreSessions {
  return nextCursor === undefined ? NO_MORE : { kind: 'available' };
}

/**
 * `shown` with its first page replaced by `page`. Its later pages are kept, without the sessions `page` now lists,
 * unless `page` is everything the agent has. A page still loading carries on.
 */
function refreshed(shown: Listed, page: SessionPage): Listed {
  const later = shown.sessions.slice(shown.firstPage);
  const loading = shown.more.kind === 'loading' && page.nextCursor !== undefined;
  if (page.nextCursor === undefined || later.length === 0) {
    const next = listed(page.sessions, page.nextCursor);
    return loading ? { ...next, more: shown.more } : next;
  }
  const first = new Set(page.sessions.map((session) => session.sessionId));
  return {
    ...shown,
    sessions: [...page.sessions, ...later.filter((session) => !first.has(session.sessionId))],
    firstPage: page.sessions.length,
  };
}

function failure(e: unknown): Failure {
  return e instanceof AuthenticationCancelled ? { kind: 'auth-required' } : { kind: 'failed', message: messageOf(e) };
}

function relativeTime(iso: string | undefined, now: number): string | undefined {
  const time = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(time)) {
    return undefined;
  }
  // Including a time ahead of ours, as an agent's clock can be.
  if (now - time < 60_000) {
    return 'now';
  }
  return formatDistanceStrict(time, now, { addSuffix: true, roundingMethod: 'floor' });
}
