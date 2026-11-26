import { EventEmitter } from 'node:events';
import { SessionStates, type SessionStateView, type QueueChange } from '@/core/sessions/States';
import { SessionInteractions } from '@/core/sessions/Interactions';
import type { ShownDiffs } from '@/core/ToolCallDiffs';
import type { TerminalDisplays, CommandSource } from '@/core/AgentTerminals';

import {
  AuthRequired,
  type AcpDriver,
  type AcpSchema,
  type AgentCapabilities,
  type AuthMethod,
  type ConfigOption,
  type FileLink,
  type ForegroundState,
  type Modes,
  type PromptPart,
  type SessionPage,
  type SessionRoots,
  type SessionState,
  type SessionUpdate,
  type SlashCommand,
} from '@/core/acp/AcpDriver';
import type { ConnectionManager } from '@/core/acp/ConnectionManager';
import type { SessionUpdateHandler, QualifiedSessionUpdate, SessionIdentity, SessionOrigin, SessionRegistration, SessionLoad } from '@/core/sessions/UpdateHandler';
import {
  commandNotFound,
  renamesBetween,
  type AgentConfigEntry,
  type AgentLauncher,
  type AgentProcess,
  type LaunchError,
} from '@/core/AgentManager';
import { 
  Writes,
  type Selections,
  type SessionAddress,
  type SessionReference,
  type SessionReferences,
  type WorkspaceState,
  type WorkspaceTarget,
} from '@/core/PersistedState';
import {
  logDebug,
  logError,
  logInfo,
  logWarning,
  messageOf,
  type LogContext
} from '@/core/Log';

/** What sessions need from the workspace the extension runs in. */
export interface SessionEnvironment {
  /** The directories agents run in and their sessions work in: the workspace's first folder as `cwd`, and its others. */
  workspaceRoots(): SessionRoots;
  /**
   * The workspace sessions are recorded against, as the window holds it; undefined when this window has none it could
   * open again, or is a remote window that has not yet learned it.
   */
  workspaceTarget(): WorkspaceTarget | undefined;
  /**
   * Settles with the workspace target once it is known: at once, unless this is a remote window that has yet to learn
   * it. Settles with undefined when this window has none.
   */
  workspaceTargetKnown(): Promise<WorkspaceTarget | undefined>;
  agentConfigs(): Record<string, AgentConfigEntry>;
  /** The file to link at the start of each prompt, or undefined when none applies. */
  activeFileLink(): FileLink | undefined;
}

export interface AuthPrompt {
  /** Resolves to undefined when the user cancels. */
  chooseAuthMethod(agentName: string, methods: AuthMethod[]): Promise<AuthMethod | undefined>;
}

export interface SessionInfo extends SessionRegistration {
  sessionId: string;
  /** The agent process the session runs on. */
  agentId: string;
  agentName: string;
  agentDisplayName: string;
  cwd: string;
  createdAt: string;
  modes: Modes | null;
  /**
   * Supersede `modes`, and are the only source of model selection. `null` means the agent did not provide them.
   * Per spec, when both `configOptions` and `modes` are present, clients should use `configOptions` exclusively.
   */
  configOptions: ConfigOption[] | null;
  availableCommands: SlashCommand[];
  /** Latest known title, if any. */
  title?: string;
}

/** An agent process this manager launched, and the ACP driver of its initialized connection. */
interface RunningAgent {
  readonly name: string;
  process: AgentProcess;
  driver: AcpDriver;
  /** Settles once the process's exit has been handled. */
  exited: Promise<void>;
}

/** Where the sessions used in this window are recorded. */
interface PersistedState {
  references: SessionReferences;
  workspace: WorkspaceState;
}

const NO_SESSION_STATE: SessionState = { modes: null, configOptions: null, commands: null };

/** The user dismissed the choice of authentication method; the agent has been stopped. */
export class AuthenticationCancelled extends Error {
  constructor() {
    super('Authentication cancelled by user.');
    this.name = 'AuthenticationCancelled';
  }
}

function exitReason(agentDisplayName: string, code: number | null): string {
  return code === null ? `${agentDisplayName} exited unexpectedly.` : `${agentDisplayName} exited unexpectedly (code ${code}).`;
}

/** `options` with option `id` set to `value`, when `value` is of its kind. */
function withCurrent(options: ConfigOption[] | null, id: string, value: string | boolean): ConfigOption[] | null {
  return options?.map((option) => {
    if (option.id !== id) { return option; }
    if (option.kind === 'select' && typeof value === 'string') { return { ...option, current: value }; }
    if (option.kind === 'boolean' && typeof value === 'boolean') { return { ...option, current: value }; }
    return option;
  }) ?? null;
}

/** Where an option comes in the order saved values are reapplied: the mode, then the model, then the rest. */
function reapplyRank(option: ConfigOption): number {
  if (option.category === 'mode') { return 0; }
  return option.category === 'model' ? 1 : 2;
}

function offers(option: ConfigOption, value: string | boolean): boolean {
  if (option.kind === 'boolean') { return typeof value === 'boolean'; }
  return option.groups.some((group) => group.values.some((offered) => offered.id === value));
}

/** Config options replace modes, as the ACP spec says, so the mode is displayed only for a session without them. */
function displayedSelections(session: SessionInfo): Selections {
  const options = session.configOptions ?? [];
  if (options.length > 0) {
    return { options: Object.fromEntries(options.map((option) => [option.id, option.current])) };
  }
  return session.modes ? { modeId: session.modes.current, options: {} } : { options: {} };
}

export type SessionOpening = 'created' | 'loaded' | 'resumed';

/** Runtime admission for review decisions; waiting prompts do not revoke an admitted decision. */
interface ReviewAdmission {
  resolutionBlocked(): boolean;
  onChanged(listener: (retiredSource?: string) => void): () => void;
  runDecision<T>(action: (stillAdmitted: () => boolean) => Promise<T>): Promise<
    { kind: 'blocked' } | { kind: 'completed'; value: T }
  >;
}

/** The configuration a session was last used through, and the host, when not this window's. */
interface UsedThrough {
  readonly configuredName: string;
  readonly host?: string;
}

/** The events a {@link SessionManager} emits, with the arguments each passes its listeners. */
export interface SessionManagerEvents {
  'activity-changed': [retiredSource?: string, promptOwner?: SessionInfo, foregroundOrigin?: SessionOrigin];
  'connection-changed': [agentName: string];
  'source-retired': [sourceId: string];
  'configuration-renamed': [from: string, to: string];
  'session-added': [registration: SessionRegistration];
  /** The session was created, loaded or resumed successfully. */
  'session-opened': [registration: SessionRegistration, how: SessionOpening];
  'session-removed': [registration: SessionRegistration];
  'active-session-changed': [registration: SessionRegistration | null];
  'clear-transcript': [];
  'mode-changed': [registration: SessionRegistration, modeId: string];
  'session-info-changed': [origin: SessionOrigin, update: { title?: string | null; updatedAt?: string | null }];
  'turn-ended': [registration: SessionRegistration];
  'session-load-start': [load: SessionLoad];
  'session-load-end': [load: SessionLoad, ok: boolean];
  'session-ended': [registration: SessionRegistration, reason: string];
  'agent-closed': [agentId: string, code: number | null];
}

export type SessionStatus = 'quiet' | 'working' | 'needsInput' | 'failed' | 'completed';
type CloseOutcome = { kind: 'closed' | 'stale' } | { kind: 'not-stopped'; reason: string };

/**
 * Manages agents, their connections, and their sessions.
 *
 * Selection is independent of connection and session lifetime. Each agent
 * configuration reuses one accepting process for its live sessions.
 */
export class SessionManager extends EventEmitter<SessionManagerEvents> implements ReviewAdmission {
  private readonly retained: SessionStates;
  readonly interactions = new SessionInteractions((identity, agentId) => {
    const registration = this.getSession(identity);
    return registration?.agentId === agentId ? this.retained.view(identity)?.generation : undefined;
  }, (identity, agentId, question) => {
    const registration = this.getSession(identity) ?? this.restarting.get(JSON.stringify([agentId, identity.sessionId]));
    if (registration?.agentId === agentId) { this.retained.questionSettled(registration, question); }
    else if (this.acceptsOpening(agentId, identity.sessionId)) {
      this.retained.questionSettledOpening({ identity, sourceId: agentId }, question);
    }
  });

  sessionState(identity: SessionIdentity): SessionStateView | undefined {
    return this.retained.view(identity);
  }

  sessionStatus(identity: SessionIdentity): SessionStatus {
    const registration = this.getSession(identity);
    if (registration && this.driverFor(registration)) {
      const pending = this.interactions.pending(identity, registration.agentId);
      const foreground = this.activity.get(JSON.stringify([registration.agentId, identity.sessionId]))?.foreground;
      if (foreground === 'requiresAction' || pending.permissions.length > 0
        || pending.elicitations.some(({ status }) => status === 'pending')) { return 'needsInput'; }
      if (this.hasForegroundWork(identity)) { return 'working'; }
    }
    return this.retained.view(identity)?.turnOutcome ?? 'quiet';
  }

  acknowledgeCompletion(identity: SessionIdentity): void {
    if (this.retained.view(identity)?.turnOutcome === 'completed') { this.retained.setTurnOutcome(identity, null); }
  }

  sessionLoad(identity: SessionIdentity): SessionLoad | undefined {
    const registration = this.getSession(identity);
    return registration && this.loading.get(registration);
  }

  consumeReviewOpportunity(identity: SessionIdentity, revision: number): void {
    this.retained.consumeReviewOpportunity(identity, revision);
  }

  editComposer(identity: SessionIdentity, generation: number, revision: number, text: string): void {
    this.retained.editComposer(identity, generation, revision, text);
  }

  submitPrompt(identity: SessionIdentity, generation: number, text: string): Promise<void> | undefined {
    const session = this.getSession(identity);
    if (!session || session !== this.getActiveSession() || !this.driverFor(session) || this.closing.has(session)
      || this.retained.view(identity)?.generation !== generation || !text.trim()) { return; }
    if (this.hasForegroundWork(identity) || this.awaitingIdle.has(session) || (this.retained.view(identity)?.queue.length ?? 0) > 0) {
      this.retained.enqueue(identity, generation, text);
      return;
    } else { return this.sendPrompt(identity, text); }
  }

  changeQueuedPrompt(identity: SessionIdentity, generation: number, change: QueueChange | { readonly kind: 'steer'; readonly id: number } | { readonly kind: 'stop'; readonly id: number }): void {
    const session = this.getSession(identity);
    if (!session || session !== this.getActiveSession() || !this.driverFor(session) || this.closing.has(session)
      || this.retained.view(identity)?.generation !== generation) { return; }
    if (change.kind === 'steer' || change.kind === 'stop') {
      const head = this.retained.view(identity)?.queue[0];
      if (head?.id !== change.id || !this.hasForegroundWork(identity)) { return; }
      if (change.kind === 'stop') {
        void this.cancelTurn(identity).catch((error: unknown) => { logError('Cancel failed', error); });
      } else if (head.draft === null) {
        const next = this.retained.takeQueued(identity, generation);
        if (next) { this.retained.turnEnded(session, Date.now()); this.dispatchQueued(session, next.text); }
      }
      return;
    }
    this.retained.changeQueue(identity, generation, change);
    this.releaseQueued(session);
  }

  private dispatchQueued(session: SessionInfo, text: string): void {
    void this.sendPrompt({ configuredName: session.agentName, sessionId: session.sessionId }, text)
      .catch((error: unknown) => { logError('Queued prompt failed', error); });
  }

  private releaseQueued(session: SessionInfo): void {
    const identity = { configuredName: session.agentName, sessionId: session.sessionId };
    const state = this.retained.view(identity);
    if (!state || this.loading.has(session) || this.closing.has(session) || !this.driverFor(session) || this.hasForegroundWork(identity)) { return; }
    if (this.awaitingIdle.has(session) && this.activity.get(JSON.stringify([session.agentId, session.sessionId]))?.foreground !== 'idle') { return; }
    this.awaitingIdle.delete(session);
    const head = this.retained.takeQueued(identity, state.generation);
    if (head) { this.dispatchQueued(session, head.text); }
  }

  releaseSessionState(identity: SessionIdentity): void {
    this.retained.release(identity);
  }

  openCommandOutput(identity: SessionIdentity, source: CommandSource, name: string): boolean {
    return this.retained.openCommandOutput(identity, source, name);
  }

  endSessionOutput(registration: SessionRegistration): void {
    this.retained.endOutput(registration);
  }


  sessionToolCallDiffs(identity: SessionIdentity, toolCallId: string, cwd: string | null): ShownDiffs | undefined {
    return this.retained.toolCallDiffs(identity, toolCallId, cwd);
  }

  /** Running agents by agent name. */
  private agents = new Map<string, RunningAgent>();
  /** Launches in progress by agent name, so concurrent callers share one process. */
  private launching = new Map<string, Promise<RunningAgent>>();
  /** Ownership outlives initialization and removal from the reusable agents. */
  private processes = new Map<AgentProcess, { name: string; accepting: boolean; exited: Promise<void> }>();
  private disposed = false;
  private disposal: Promise<void> | undefined;
  /** Session titles from each agent's `session/list` pages, by agent name then session ID. */
  private listedTitles = new Map<string, Map<string, string>>();

  private sessions = new Map<string, SessionInfo>();
  private readonly activity = new Map<string, { foreground: ForegroundState | null; submissions: Set<symbol>; agentId: string | undefined }>();
  private decisions: Promise<void> | undefined;
  private activityRevision = 0;
  private activeSessionId: string | null = null;

  /**
   * Buffers session/update payloads that arrive before the corresponding
   * session is registered in `this.sessions`. Drained when the session is
   * registered. This closes a microtask race between the resolution of
   * `newSession` and the SDK's async notification dispatch.
   */
  private pendingAvailableCommands = new Map<string, SlashCommand[]>();
  private pendingConfigOptions = new Map<string, ConfigOption[]>();
  private pendingTitles = new Map<string, string | null>();
  private pendingModes = new Map<string, string>();
  private pendingForeground = new Map<string, ForegroundState>();
  /**
   * Sessions being loaded or resumed, whose replayed or reported options must not overwrite those saved before they are
   * reapplied.
   */
  private readonly loading = new Map<SessionInfo, SessionLoad>();
  private readonly creating = new Map<string, number>();
  private readonly resuming = new Set<string>();
  private readonly authFlows = new WeakMap<RunningAgent, Promise<void>>();
  private readonly restarting = new Map<string, SessionInfo>();
  private readonly reloading = new Set<SessionInfo>();
  private readonly awaitingIdle = new WeakSet<SessionInfo>();
  private readonly sessionRoots = new WeakMap<SessionInfo, SessionRoots>();
  private selectionRevision = 0;
  private readonly closing = new Map<SessionInfo, Promise<CloseOutcome>>();

  /**
   * Cache of each agent's capabilities, so the tree can render
   * without paying the connect cost on every render.
   */
  private capabilities = new Map<string, AgentCapabilities>();

  private persisted: PersistedState | null = null;
  /** Changes waiting for a workspace target this window has yet to learn. */
  private readonly waitingForTarget = new Writes();
  private endWaits: () => void = () => {};
  private readonly waitsEnded = new Promise<undefined>((resolve) => { this.endWaits = () => resolve(undefined); });

  constructor(
    private readonly launcher: AgentLauncher,
    private readonly connectionManager: ConnectionManager,
    private readonly environment: SessionEnvironment,
    private readonly authPrompt: AuthPrompt,
    private readonly updates: SessionUpdateHandler,
    terminalDisplays?: TerminalDisplays,
  ) {
    super();
    this.retained = new SessionStates(() => this.emit('activity-changed'), terminalDisplays);
  }

  /**
   * Wire in where the sessions used in this window are recorded (called once at startup). The manager is their writer,
   * so it disposes them with itself.
   */
  setPersistedState(references: SessionReferences, workspace: WorkspaceState): void {
    this.persisted = { references, workspace };
  }

  /**
   * `your-turn.agents` changed from `before` to `after`. Each configuration renamed has its references on this host, and
   * this workspace's last active session, rebound to its new name; anything else rebinds nothing.
   */
  agentsChanged(before: Readonly<Record<string, AgentConfigEntry>>, after: Readonly<Record<string, AgentConfigEntry>>): void {
    for (const { from, to } of renamesBetween(before, after)) {
      for (const lifetime of this.processes.values()) {
        if (lifetime.name === from) { lifetime.name = to; }
      }
      const launching = this.launching.get(from);
      if (launching) {
        this.launching.delete(from);
        this.launching.set(to, launching);
      }
      const agent = this.agents.get(from);
      if (agent) {
        this.agents.delete(from);
        this.agents.set(to, agent);
      }
      for (const [key, session] of this.sessions) {
        if (session.agentName !== from) { continue; }
        this.sessions.delete(key);
        session.agentName = to;
        const renamed = JSON.stringify([to, session.sessionId]);
        this.sessions.set(renamed, session);
        if (this.activeSessionId === key) { this.activeSessionId = renamed; }
      }
      const capabilities = this.capabilities.get(from);
      if (capabilities) {
        this.capabilities.delete(from);
        this.capabilities.set(to, capabilities);
      }
      const titles = this.listedTitles.get(from);
      if (titles) {
        this.listedTitles.delete(from);
        this.listedTitles.set(to, titles);
      }
      const persisted = this.persisted;
      if (persisted) {
        this.withTarget((target) => void persisted.references.rebind(target.host, from, to));
        void persisted.workspace.rebind(from, to);
      }
      this.retained.rename(from, to);
      this.interactions.rename(from, to);
      this.emit('configuration-renamed', from, to);
    }
  }

  /**
   * Read cached capabilities for an agent. Returns `undefined` if the agent
   * has never been launched — callers can call {@link ensureConnected}
   * first to populate.
   */
  getCachedCapabilities(agentName: string): AgentCapabilities | undefined {
    return this.capabilities.get(agentName);
  }

  async newSession(agentName: string): Promise<SessionInfo>;
  async newSession(): Promise<SessionInfo | null>;
  /** Create and select a new session without replacing the agent's connection. */
  async newSession(agentName = this.getActiveAgentName()): Promise<SessionInfo | null> {
    if (!agentName) { return null; }
    const agent = await this.ensureAgent(agentName);
    const session = await this.createAcpSession(agent, this.environment.workspaceRoots());
    this.requireRegistration(session);
    this.selectionRevision++;
    this.activeSessionId = JSON.stringify([session.agentName, session.sessionId]);
    this.emit('session-added', session);
    this.emit('active-session-changed', session);
    return session;
  }

  connectionSource(agentName: string): string | undefined {
    return [...this.processes].find(([, lifetime]) => lifetime.name === agentName && lifetime.accepting)?.[0].id;
  }

  connectionNeedsStop(agentId: string): boolean {
    return this.interactions.hasPending(agentId) || [...this.activity.values()].some((activity) => activity.agentId === agentId
      && (activity.submissions.size > 0 || activity.foreground === 'running' || activity.foreground === 'requiresAction'));
  }

  /** Stop the captured connection and wait for its process to exit. */
  async disconnectAgent(agentName: string, expectedSource?: string, preserveSelection = false): Promise<void> {
    if (expectedSource !== undefined && this.connectionSource(agentName) !== expectedSource) { return; }
    this.launching.delete(agentName);
    const waits: Promise<void>[] = [];
    for (const [process, lifetime] of this.processes) {
      if (lifetime.name === agentName && lifetime.accepting && !this.agents.has(agentName)) {
        this.retireSource(process);
        waits.push(lifetime.exited);
        process.kill();
      }
    }
    const agent = this.agents.get(agentName);
    if (agent) {
      const sessions = this.sessionsOn(agent.process);
      for (const session of sessions) {
        this.retained.setTurnOutcome({ configuredName: session.agentName, sessionId: session.sessionId }, null);
      }
      logInfo('Disconnecting agent', { agentName });
      this.stopAgent(agent);
      this.removeSessions(sessions, preserveSelection);
      waits.push(agent.exited);
    }
    await Promise.all(waits);
  }

  /** Replace the captured process and commit each successful replay independently. */
  async restartAgent(agentName: string, expectedSource: string): Promise<void> {
    const current = this.agents.get(agentName);
    if (current?.process.id !== expectedSource || !this.isConnected(agentName)) { return; }
    const sessions = this.sessionsOn(current.process).filter((session) => this.driverFor(session) && !this.loading.has(session) && !this.closing.has(session));
    const selected = this.getActiveSession();
    const selectionRevision = this.selectionRevision;
    for (const session of sessions) { this.reloading.add(session); }
    const stopping = this.disconnectAgent(agentName, expectedSource, true);
    // Reserve the next launch before another operation can reuse this configuration.
    const launching = stopping.then(() => {
      if (this.disposed || this.launching.get(current.name) !== launching) { throw new Error('Agent restart was interrupted.'); }
      return this.launchAgent(current.name);
    }).finally(() => {
      if (this.launching.get(current.name) === launching) { this.launching.delete(current.name); }
    });
    this.launching.set(current.name, launching);
    const failures: string[] = [];
    try {
      const replacement = await launching;
      for (const previous of sessions) {
        try {
          const session = await this.reloadSession(replacement, previous);
          if (previous === selected && this.selectionRevision === selectionRevision && this.driverFor(session)) {
            this.activeSessionId = JSON.stringify([session.agentName, session.sessionId]);
            this.emit('active-session-changed', session);
          }
        } catch (error) {
          failures.push(`${previous.sessionId}: ${messageOf(error)}`);
        } finally {
          this.reloading.delete(previous);
        }
      }
    } finally {
      for (const session of sessions) { this.reloading.delete(session); }
    }
    if (failures.length) { throw new Error(`Could not reload ${failures.join('; ')}`); }
  }

  private async reloadSession(agent: RunningAgent, previous: SessionInfo): Promise<SessionInfo> {
    const { sessionId } = previous;
    if (!agent.driver.agent.capabilities.load) { throw new Error('Full replay is not supported.'); }
    if (!this.processes.get(agent.process)?.accepting) { throw new Error('The replacement connection ended.'); }
    const roots = this.sessionRoots.get(previous);
    if (!roots) { throw new Error('Session directories are not available.'); }
    const session: SessionInfo = { ...previous, agentName: agent.name, agentId: agent.process.id, modes: null, configOptions: null, availableCommands: [] };
    const identity = { configuredName: session.agentName, sessionId };
    const key = JSON.stringify([session.agentId, sessionId]);
    const load: SessionLoad = { registration: session, origin: { identity, sourceId: session.agentId }, attempt: Symbol(sessionId) };
    this.restarting.set(key, session);
    this.loading.set(session, load);
    this.retained.beginLoad(load);
    this.emit('session-load-start', load);
    let committed = false;
    try {
      const state = await agent.driver.loadSession(sessionId, roots);
      const registrationKey = JSON.stringify([agent.name, sessionId]);
      if (!this.processes.get(agent.process)?.accepting || this.sessions.has(registrationKey)) {
        throw new Error('Session reload is no longer current.');
      }
      session.agentName = agent.name;
      session.modes = state.modes;
      session.configOptions = state.configOptions;
      session.availableCommands = state.commands ?? session.availableCommands;
      const keepTurnOpen = agent.driver.schema === 'v2' && this.activity.get(key)?.foreground !== 'idle';
      if (keepTurnOpen) { this.awaitingIdle.add(session); }
      this.sessionRoots.set(session, roots);
      this.retained.endLoad(load, true, keepTurnOpen);
      this.sessions.set(registrationKey, session);
      committed = true;
      this.emit('session-added', session);
      return session;
    } finally {
      if (!committed) { this.retained.endLoad(load, false); }
      this.restarting.delete(key);
      this.loading.delete(session);
      this.emit('session-load-end', load, committed);
    }
  }

  /**
   * Launch and initialize an agent without creating a session, so its
   * capabilities are known and its sessions can be listed; returns the
   * capabilities. Reuses the agent's process if it is already running.
   *
   * This never disconnects the agent that owns the active session.
   */
  async ensureConnected(agentName: string): Promise<AgentCapabilities> {
    const agent = await this.ensureAgent(agentName);
    return agent.driver.agent.capabilities;
  }

  private ensureAgent(agentName: string): Promise<RunningAgent> {
    if (this.disposed) {
      return Promise.reject(new Error('Session manager is disposed.'));
    }
    const running = this.agents.get(agentName);
    if (running) {
      return Promise.resolve(running);
    }
    let launching = this.launching.get(agentName);
    if (!launching) {
      launching = this.launchAgent(agentName).finally(() => {
        for (const [name, pending] of this.launching) {
          if (pending === launching) { this.launching.delete(name); }
        }
      });
      this.launching.set(agentName, launching);
    }
    return launching;
  }

  private async launchAgent(agentName: string): Promise<RunningAgent> {
    const configs = this.environment.agentConfigs();
    const config = configs[agentName];
    if (!config) {
      throw new Error(`No agent configuration named "${agentName}". Configured: ${Object.keys(configs).join(', ')}`);
    }

    let exitHandled!: () => void;
    const exited = new Promise<void>((resolve) => { exitHandled = resolve; });
    const outcome: { launchError?: LaunchError; exitCode?: number | null } = {};
    const agentProcess = this.launcher.launch(agentName, config, this.environment.workspaceRoots().cwd, {
      error: (error) => { outcome.launchError = error; },
      exit: (code) => {
        outcome.exitCode = code;
        try {
          this.handleAgentExit(agentName, agentProcess, code);
        } finally {
          this.processes.delete(agentProcess);
          exitHandled();
        }
      },
    });
    const lifetime = { name: agentName, accepting: true, exited };
    this.processes.set(agentProcess, lifetime);

    let driver: AcpDriver;
    try {
      driver = await this.connectionManager.connect(agentName, agentProcess, agentProcess.id, {
        handleUpdate: (sessionId, update, schema) => this.acceptUpdate(agentProcess, sessionId, update, schema),
      }, () => {
        this.retireSource(agentProcess);
        if (this.agents.get(lifetime.name)?.process === agentProcess) {
          this.emit('connection-changed', lifetime.name);
        }
      }, { observeRequests: (context) => this.interactions.observe(context) });
      if (this.disposed) {
        throw new Error('Session manager is disposed.');
      }
      if (!lifetime.accepting) {
        throw new Error('Agent connection ended before initialization completed.');
      }
    } catch (e) {
      this.retireSource(agentProcess);
      agentProcess.kill();
      // The connection can fail before the launcher reports why the process ended, which says more than a closed connection.
      await exited;
      if (outcome.launchError?.code === 'ENOENT') {
        throw new Error(commandNotFound(config.command));
      }
      if (outcome.launchError) {
        throw outcome.launchError;
      }
      if (typeof outcome.exitCode === 'number') {
        throw new Error(`Agent "${agentName}" exited with code ${outcome.exitCode} before connecting; its output is in the Your Turn log (Your Turn: Show Log).`);
      }
      throw e;
    }

    const agent: RunningAgent = { get name() { return lifetime.name; }, process: agentProcess, driver, exited };
    this.agents.set(agent.name, agent);
    this.capabilities.set(agent.name, driver.agent.capabilities);
    this.emit('connection-changed', agent.name);
    return agent;
  }

  /** Stop an agent's process and forget it; the caller handles its registrations. */
  private stopAgent(agent: RunningAgent): void {
    this.retireSource(agent.process);
    if (this.agents.get(agent.name) === agent) {
      this.agents.delete(agent.name);
      this.emit('connection-changed', agent.name);
    }
    agent.process.kill();
  }

  private retireSource(process: AgentProcess): void {
    const lifetime = this.processes.get(process);
    if (!lifetime?.accepting) { return; }
    lifetime.accepting = false;
    this.interactions.retire(process.id);
    this.retained.retireSource(process.id);
    for (const pending of [this.pendingAvailableCommands, this.pendingConfigOptions, this.pendingTitles, this.pendingForeground, this.pendingModes]) {
      for (const key of pending.keys()) {
        if (key.startsWith(`[${JSON.stringify(process.id)},`)) { pending.delete(key); }
      }
    }
    for (const [key, activity] of this.activity) {
      if (activity.agentId === process.id) { this.activity.delete(key); }
    }
    this.emit('activity-changed', process.id);
    this.emit('source-retired', process.id);
  }

  private acceptUpdate(process: AgentProcess, sessionId: string, update: SessionUpdate, schema: AcpSchema): void {
    const lifetime = this.processes.get(process);
    if (!lifetime?.accepting || this.disposed) { return; }
    const candidate = this.getSession({ configuredName: lifetime.name, sessionId });
    const key = JSON.stringify([process.id, sessionId]);
    const staging = this.restarting.get(key);
    const registration = staging ?? (candidate?.agentId === process.id && candidate.agentName === lifetime.name ? candidate : undefined);
    const identity: SessionIdentity = { configuredName: lifetime.name, sessionId };
    const origin: SessionOrigin = { identity, sourceId: process.id };
    const now = Date.now();
    if (registration) { this.retained.accept(registration, update, now); }
    else if (this.acceptsOpening(process.id, sessionId)) { this.retained.acceptOpening(origin, update, now); }
    // Early metadata is source-local even when another source currently owns this raw ID.
    switch (update.kind) {
      case 'configOptions':
        if (registration) { registration.configOptions = update.options; this.saveSelections(registration); }
        else { this.pendingConfigOptions.set(key, update.options); }
        break;
      case 'commands':
        if (registration) { registration.availableCommands = update.commands; }
        else { this.pendingAvailableCommands.set(key, update.commands); }
        break;
      case 'sessionInfo':
        if (staging) {
          if (update.title === null) { delete staging.title; }
          else if (update.title !== undefined) { staging.title = update.title; }
        } else if (registration) { this.applySessionInfoUpdate(identity, update); }
        else if (update.title !== undefined) { this.pendingTitles.set(key, update.title); }
        if (!registration) { this.emit('session-info-changed', origin, update); }
        break;
      case 'currentMode':
        if (registration) { this.applyCurrentMode(identity, update.modeId); }
        else { this.pendingModes.set(key, update.modeId); }
        break;
      case 'foreground':
        this.applyForegroundState(identity, update.state, process.id, update.outcome);
        if (!registration) { this.pendingForeground.set(key, update.state); }
        break;
      default:
        break;
    }
    const input: QualifiedSessionUpdate = { origin, update, schema };
    this.updates.handleUpdate({ input, registration });
  }

  private handleAgentExit(agentName: string, agentProcess: AgentProcess, code: number | null): void {
    // Still registered means nothing here stopped it.
    const running = [...this.agents.values()].find((agent) => agent.process === agentProcess);
    const currentName = running?.name ?? agentName;
    const unexpected = running !== undefined;
    const sessions = this.sessionsOn(agentProcess);
    if (unexpected) {
      for (const session of sessions) {
        this.retained.setTurnOutcome({ configuredName: session.agentName, sessionId: session.sessionId }, 'failed');
      }
    }
    this.retireSource(agentProcess);
    if (unexpected) {
      logError('Agent exited unexpectedly', undefined, { agentName, exitCode: code });
    } else {
      logDebug('Agent exited', { agentName, exitCode: code });
    }
    if (unexpected) {
      this.agents.delete(currentName);
      this.emit('connection-changed', currentName);
    }

    // A replacement process for the same configuration does not own these registrations.
    if (unexpected) {
      for (const session of sessions) {
        const reason = exitReason(session.agentDisplayName, code);
        this.retained.turnEnded(session, Date.now());
        this.retained.promptFailed(session, reason);
        this.emit('session-ended', session, reason);
      }
    }
    this.removeSessions(sessions);
    this.emit('agent-closed', agentProcess.id, code);
  }

  /** Create the ACP session, authenticating first if the agent requires it. */
  private async createAcpSession(agent: RunningAgent, roots: SessionRoots): Promise<SessionInfo> {
    const requestSession = async () => {
      const id = agent.process.id;
      this.creating.set(id, (this.creating.get(id) ?? 0) + 1);
      try {
        const response = await agent.driver.newSession(roots);
        return this.registerSession(agent, response.sessionId, roots, response);
      } finally {
        const remaining = (this.creating.get(id) ?? 1) - 1;
        if (remaining) { this.creating.set(id, remaining); }
        else {
          this.creating.delete(id);
          this.retained.discardOpenings(id, (sessionId) => !this.resuming.has(JSON.stringify([id, sessionId])));
        }
      }
    };

    let sessionInfo: SessionInfo;
    try {
      sessionInfo = await requestSession();
    } catch (e) {
      if (!(e instanceof AuthRequired)) {
        logError('Failed to create session', e);
        this.stopAgentWithoutSessions(agent);
        throw e;
      }
      await this.runAuthFlow(agent);
      try {
        sessionInfo = await requestSession();
      } catch (retryErr) {
        logError('Failed to create session after authentication', retryErr);
        this.stopAgentWithoutSessions(agent);
        throw retryErr;
      }
    }

    this.recordOpened(sessionInfo, 'created');
    return sessionInfo;
  }

  /**
   * Register a session as soon as the agent names it, so session/update
   * notifications that arrive before the caller's continuation runs can be
   * applied to it instead of dropped.
   */
  private registerSession(
    agent: RunningAgent,
    sessionId: string,
    roots: SessionRoots,
    state: SessionState = NO_SESSION_STATE,
    reference: SessionReference | undefined = this.referenceOf(agent.name, sessionId),
  ): SessionInfo {
    if (this.disposed) {
      throw new Error('Session manager is disposed.');
    }
    if (!this.processes.get(agent.process)?.accepting) {
      throw new Error('Agent connection ended before the session opened.');
    }
    // Known for a session reopened from the tree; updates drained below override it.
    const title = this.listedTitles.get(agent.name)?.get(sessionId) ?? reference?.title;
    const sessionInfo: SessionInfo = {
      sessionId,
      agentId: agent.process.id,
      agentName: agent.name,
      agentDisplayName: agent.driver.agent.displayName || agent.name,
      cwd: roots.cwd,
      createdAt: new Date().toISOString(),
      modes: state.modes,
      configOptions: state.configOptions,
      availableCommands: state.commands ?? [],
      ...(title ? { title } : {}),
    };
    this.sessions.set(JSON.stringify([agent.name, sessionId]), sessionInfo);
    this.sessionRoots.set(sessionInfo, roots);
    this.retained.attach(sessionInfo);
    this.drainPending(sessionInfo);
    return sessionInfo;
  }

  /**
   * Run the interactive auth flow against an already-initialized connection.
   * On cancellation or failure, stop a connection only if it owns no sessions.
   */
  private runAuthFlow(agent: RunningAgent): Promise<void> {
    const existing = this.authFlows.get(agent);
    if (existing) { return existing; }
    const flow = Promise.resolve().then(() => this.authenticateAgent(agent)).finally(() => { this.authFlows.delete(agent); });
    this.authFlows.set(agent, flow);
    return flow;
  }

  private async authenticateAgent(agent: RunningAgent): Promise<void> {
    const { authMethods } = agent.driver.agent;
    if (authMethods.length === 0) {
      this.stopAgentWithoutSessions(agent);
      throw new Error(
        `Agent "${agent.name}" requires authentication but did not advertise any auth methods.`,
      );
    }

    logDebug('Agent requires authentication', { methods: authMethods.map((method) => method.name) });

    const selectedMethod = await this.authPrompt.chooseAuthMethod(agent.name, authMethods);
    if (!selectedMethod) {
      this.stopAgentWithoutSessions(agent);
      throw new AuthenticationCancelled();
    }

    try {
      logDebug('Authenticating with method', { methodName: selectedMethod.name, methodId: selectedMethod.id });
      await agent.driver.authenticate(selectedMethod.id);
      logInfo('Authentication successful', { agentName: agent.name });
    } catch (authErr) {
      logError('Authentication failed', authErr);
      this.stopAgentWithoutSessions(agent);
      throw new Error(`Authentication failed: ${messageOf(authErr)}`);
    }
  }

  /** Apply any state buffered before the session was registered. */
  private drainPending(sessionInfo: SessionInfo): void {
    const key = JSON.stringify([sessionInfo.agentId, sessionInfo.sessionId]);
    const pendingCmds = this.pendingAvailableCommands.get(key);
    if (pendingCmds) {
      sessionInfo.availableCommands = pendingCmds;
      this.pendingAvailableCommands.delete(key);
    }
    const pendingCfg = this.pendingConfigOptions.get(key);
    if (pendingCfg !== undefined) {
      sessionInfo.configOptions = pendingCfg;
      this.pendingConfigOptions.delete(key);
    }
    const pendingTitle = this.pendingTitles.get(key);
    if (pendingTitle !== undefined) {
      if (pendingTitle === null) { delete sessionInfo.title; }
      else { sessionInfo.title = pendingTitle; }
      this.pendingTitles.delete(key);
    }
    const mode = this.pendingModes.get(key);
    if (mode !== undefined) {
      if (sessionInfo.modes) { sessionInfo.modes = { ...sessionInfo.modes, current: mode }; }
      this.pendingModes.delete(key);
    }
    const foreground = this.pendingForeground.get(key);
    if (foreground !== undefined) {
      this.applyForegroundState({ configuredName: sessionInfo.agentName, sessionId: sessionInfo.sessionId }, foreground, sessionInfo.agentId);
      this.pendingForeground.delete(key);
    }
  }

  /** The driver of the connection a session runs on, or undefined once its agent has stopped. */
  private driverFor(session: SessionInfo): AcpDriver | undefined {
    if (this.getSession({ configuredName: session.agentName, sessionId: session.sessionId }) !== session) { return; }
    const agent = this.agents.get(session.agentName);
    if (agent?.process.id !== session.agentId || !this.processes.get(agent.process)?.accepting) { return; }
    return agent.driver;
  }

  /**
   * Send a prompt to the active session; resolves when the turn ends.
   */
  async sendPrompt(identity: SessionIdentity, text: string): Promise<void> {
    const { sessionId } = identity;
    const session = this.getSession(identity);
    if (!session || this.closing.has(session)) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const agent = this.agents.get(session.agentName);
    if (!agent) {
      throw new Error(`No connection for agent: ${session.agentName}`);
    }

    logDebug('Sending prompt', { sessionId });

    const prompt: PromptPart[] = [
      { kind: 'text', text },
    ];

    const fileLink = this.environment.activeFileLink();
    if (fileLink) {
      logDebug('Attaching active file context', { sessionId });
      prompt.unshift({ kind: 'fileLink', ...fileLink });
    }

    const submission = this.beginPrompt(session);
    this.retained.setTurnOutcome(identity, null);
    this.retained.submitted(session, text);
    this.emit('activity-changed', undefined, session);
    const activity = this.activity.get(JSON.stringify([session.agentId, sessionId]));
    const decisions = this.decisions;
    try {
      if (decisions) { await decisions; }
      if (this.closing.has(session)) { return; }
      if (this.driverFor(session) !== agent.driver) { throw new Error('Prompt session is no longer current.'); }
      const outcome = await agent.driver.prompt(sessionId, prompt);
      if (outcome.stopReason !== 'cancelled' && this.driverFor(session) === agent.driver) {
        this.recordTurnEnded({ configuredName: session.agentName, sessionId });
      }
    } catch (e) {
      // The connection can close before the process's exit is reported; the exit ends the session and says why,
      // so the prompt fails after it.
      if (agent.driver.closed) {
        await agent.exited;
      }
      if (this.driverFor(session) === agent.driver) {
        this.retained.setTurnOutcome({ configuredName: session.agentName, sessionId }, 'failed');
        this.retained.promptFailed(session, messageOf(e) || 'Prompt failed');
      }
      throw e;
    } finally {
      activity?.submissions.delete(submission);
      if (this.driverFor(session) && !this.hasForegroundWork({ configuredName: session.agentName, sessionId })) { this.retained.turnEnded(session, Date.now()); }
      this.emit('activity-changed', undefined, session);
      this.releaseQueued(session);
    }
  }

  /**
   * Cancel an active prompt turn.
   */
  async cancelTurn(identity: SessionIdentity): Promise<void> {
    const { sessionId } = identity;
    const session = this.getSession(identity);
    if (!session) { return; }

    const driver = this.driverFor(session);
    if (!driver) { return; }

    logDebug('Cancelling turn', { sessionId });
    await driver.cancel(sessionId);
  }

  sessionNeedsStop(session: SessionInfo): boolean {
    const identity = { configuredName: session.agentName, sessionId: session.sessionId };
    return this.hasForegroundWork(identity) || this.interactions.hasPending(session.agentId, identity);
  }

  closeSession(session: SessionInfo): Promise<CloseOutcome> {
    const existing = this.closing.get(session);
    if (existing) { return existing; }
    const operation = Promise.resolve().then(() => this.completeClose(session)).finally(() => { this.closing.delete(session); });
    this.closing.set(session, operation);
    return operation;
  }

  private async completeClose(session: SessionInfo): Promise<CloseOutcome> {
    const driver = this.driverFor(session);
    if (!driver || this.loading.has(session)) { return { kind: 'stale' }; }
    const identity = () => ({ configuredName: session.agentName, sessionId: session.sessionId });
    const agent = this.agents.get(session.agentName);
    if (!agent) { return { kind: 'stale' }; }
    if (this.sessionNeedsStop(session)) {
      let check = () => {};
      const settled = new Promise<void>((resolve) => {
        check = () => {
          if (!this.driverFor(session) || !this.hasForegroundWork(identity())) { resolve(); }
        };
        this.on('activity-changed', check);
        check();
      });
      try {
        const cancel = driver.cancel(session.sessionId).then(() => {
          if (this.driverFor(session) === driver) { this.interactions.cancelSession(identity(), session.agentId); }
        });
        await Promise.race([agent.exited, Promise.all([cancel, settled])]);
      } catch (error) {
        if (!driver.closed) { return { kind: 'not-stopped', reason: messageOf(error) }; }
      } finally { this.off('activity-changed', check); }
    }
    if (!this.driverFor(session)) {
      await agent.exited;
      return this.getSession(identity()) ? { kind: 'stale' } : { kind: 'closed' };
    }
    this.removeSessions([session]);
    this.activity.delete(JSON.stringify([session.agentId, session.sessionId]));
    return { kind: 'closed' };
  }

  /**
   * Set the session mode (e.g., plan mode, code mode).
   *
   * If the active session uses `configOptions`, this is transparently
   * routed to `setConfigOption` against the first option whose category is
   * `mode` — this keeps user keybindings working across agents that have
   * migrated to the new API.
   */
  async setMode(identity: SessionIdentity, modeId: string): Promise<void> {
    const session = this.getSession(identity);
    if (!session) { return; }
    await this.setSessionMode(session, modeId);
  }

  private async setSessionMode(session: SessionInfo, modeId: string): Promise<void> {
    const { sessionId } = session;

    // Prefer configOptions if available (spec: clients that support
    // configOptions MUST use it exclusively when both are present)
    const modeOpt = session.configOptions?.find(o => o.category === 'mode');
    if (modeOpt) {
      await this.setSessionConfigOption(session, modeOpt.id, modeId);
      return;
    }

    const driver = this.driverFor(session);
    if (!driver) { return; }

    await driver.setMode(sessionId, modeId);

    if (this.driverFor(session) !== driver) { return; }
    if (session.modes) {
      session.modes = { ...session.modes, current: modeId };
      this.saveSelections(session);
    }
    this.emit('mode-changed', session, modeId);
  }

  /**
   * Set the session model via the first config option whose category is
   * `model`. Agents that expose no such option cannot have their model set.
   */
  async setModel(identity: SessionIdentity, modelId: string): Promise<void> {
    const session = this.getSession(identity);
    if (!session) { return; }

    const modelOpt = session.configOptions?.find(o => o.category === 'model');
    if (!modelOpt) {
      throw new Error(`${session.agentDisplayName} does not expose a model config option`);
    }
    await this.setSessionConfigOption(session, modelOpt.id, modelId);
  }

  /**
   * Set a session config option. The agent answers with the full set of
   * config options, which replaces ours so that cascading changes (e.g.
   * changing the model adjusts thought-level options) are reflected. An
   * agent answering without them, against the spec, has set the value asked
   * for and nothing else.
   */
  async setConfigOption(identity: SessionIdentity, configId: string, value: string | boolean): Promise<ConfigOption[] | null> {
    const session = this.getSession(identity);
    if (!session) { return null; }
    return this.setSessionConfigOption(session, configId, value);
  }

  private async setSessionConfigOption(session: SessionInfo, configId: string, value: string | boolean): Promise<ConfigOption[] | null> {
    const driver = this.driverFor(session);
    if (!driver) { return null; }

    const options = await driver.setConfigOption(session.sessionId, configId, value);
    if (this.driverFor(session) !== driver) { return options; }
    session.configOptions = options ?? withCurrent(session.configOptions, configId, value);
    this.saveSelections(session);
    return options;
  }

  /**
   * Replace a session's configOptions in place. Used by both the setter
   * response and the session update.
   */
  applyConfigOptions(identity: SessionIdentity, options: ConfigOption[] | null): void {
    const session = this.getSession(identity);
    if (!session) { return; }
    session.configOptions = options;
    this.saveSelections(session);
  }

  /** Record the session's mode, as set here or switched by the agent itself. */
  applyCurrentMode(identity: SessionIdentity, modeId: string): void {
    const session = this.getSession(identity);
    if (session?.modes) {
      session.modes = { ...session.modes, current: modeId };
      this.saveSelections(session);
    }
  }

  /** Save the session's options as displayed, replacing those saved, unless it is loading. */
  private saveSelections(session: SessionInfo): void {
    if (this.loading.has(session)) { return; }
    const selections = displayedSelections(session);
    this.record(session, (address, { references }) => void references.saveSelections(address, selections));
  }

  /**
   * Replace a session's availableCommands. Buffers the value if the session
   * isn't registered yet (race during creation).
   */
  applyAvailableCommands(identity: SessionIdentity, commands: SlashCommand[]): void {
    const session = this.getSession(identity);
    if (!session) { return; }
    session.availableCommands = commands;
  }

  /**
   * Apply a session info update: patches title / updatedAt on
   * the in-memory session and caches the title in its session reference.
   */
  applySessionInfoUpdate(identity: SessionIdentity, update: { title?: string | null; updatedAt?: string | null }): void {
    const { sessionId } = identity;
    const session = this.getSession(identity);
    if (session) {
      if (update.title === null) {
        delete session.title;
      } else if (typeof update.title === 'string') {
        session.title = update.title;
      }
      const { title } = update;
      if (title !== undefined) {
        this.record(session, (address, { references }) => void references.setTitle(address, title));
      }
    }
    if (session) {
      this.emit('session-info-changed', {
        identity: { configuredName: session.agentName, sessionId }, sourceId: session.agentId,
      }, update);
    }
  }

  /** Keep a live session's title when the Agents list accepts a listing for it. */
  acceptListedTitle(identity: SessionIdentity, title: string | null): void {
    const session = this.getSession(identity);
    if (!session) { return; }
    if (title === null) { delete session.title; }
    else { session.title = title; }
  }

  /** A turn of the session ended: record it as used, and tell the session list. */
  recordTurnEnded(identity: SessionIdentity): void {
    const session = this.getSession(identity);
    if (!session || this.loading.has(session)) { return; }
    this.retained.recordReviewOpportunity(identity);
    if (this.retained.view(identity)?.turnOutcome !== 'failed') { this.retained.setTurnOutcome(identity, 'completed'); }
    this.record(session, (address, { references }) => void references.used(address));
    this.emit('turn-ended', session);
  }

  /** Remove a session from session history in this window's host; the agent keeps the session itself. */
  async removeFromHistory(agentName: string, sessionId: string): Promise<void> {
    const host = (this.environment.workspaceTarget() ?? await this.targetKnown())?.host;
    if (host) {
      await this.persisted?.references.remove({ host, configuredName: agentName, sessionId });
    }
  }

  /**
   * List sessions known to an agent.
   * Throws if the agent doesn't advertise the capability.
   */
  async listSessions(agentName: string, opts: { cwd?: string | undefined; cursor?: string | undefined } = {}): Promise<SessionPage> {
    const agent = await this.ensureAgent(agentName);
    if (!this.capabilities.get(agentName)?.list) {
      throw new Error(`Agent "${agentName}" does not support session/list.`);
    }

    const requestList = () => agent.driver.listSessions(opts);

    let response: SessionPage;
    try {
      response = await requestList();
    } catch (e) {
      if (!(e instanceof AuthRequired)) {
        throw e;
      }
      await this.runAuthFlow(agent);
      response = await requestList();
    }

    const sessions = response.sessions;
    const titles = this.listedTitles.get(agentName) ?? new Map<string, string>();
    for (const listed of sessions) {
      if (listed.title) {
        titles.set(listed.sessionId, listed.title);
      } else {
        titles.delete(listed.sessionId);
      }
    }
    this.listedTitles.set(agentName, titles);

    const persisted = this.persisted;
    if (persisted) {
      // Only a complete list of a cwd shows which sessions the agent no longer keeps there.
      const complete = opts.cwd !== undefined && !opts.cursor && !response.nextCursor
        ? { cwd: opts.cwd, openInThisWindow: new Set(this.openSessionsOf(agentName).map((session) => session.sessionId)) }
        : undefined;
      this.withTarget((target) => void persisted.references.observeListing({
        host: target.host,
        configuredName: agentName,
        sessions,
        ...(complete ? { complete } : {}),
      }));
    }
    return response;
  }

  /**
   * Load an existing session, replaying its entire transcript via
   * `session/update` notifications, then reapply the options saved for it before the load ends. Heavyweight. Active
   * session is switched to the loaded session on success.
   *
   * `usedThrough` is where the session was last used, when not through `agentName` (on this window's host, unless it
   * names another): the title and options saved there are used, and once the load succeeds, the session's reference
   * moves to `agentName`.
   */
  async loadSession(agentName: string, sessionId: string, usedThrough?: UsedThrough): Promise<SessionInfo> {
    this.requireNotReloading(agentName, sessionId);
    const agent = await this.ensureAgent(agentName);
    if (!agent.driver.agent.capabilities.load) {
      throw new Error(`Agent "${agentName}" does not support session/load.`);
    }

    const roots = this.environment.workspaceRoots();
    const reference = this.referenceUsedThrough(agent.name, sessionId, usedThrough);
    // Registered and made active before the request, so the transcript the
    // agent replays during the load reaches the webview.
    const session = this.registerSession(agent, sessionId, roots, NO_SESSION_STATE, reference);
    this.selectionRevision++;
    this.activeSessionId = JSON.stringify([session.agentName, sessionId]);
    // Emit active-session-changed BEFORE session-load-start so the webview
    // first repaints from the new session state, then immediately enters
    // the loading-overlay state.
    const load: SessionLoad = { registration: session, origin: { identity: { configuredName: session.agentName, sessionId }, sourceId: session.agentId }, attempt: Symbol(sessionId) };
    this.loading.set(session, load);
    this.retained.beginLoad(load);
    this.emit('session-added', session);
    this.emit('active-session-changed', session);
    this.emit('session-load-start', load);
    try {
      // The response carries the latest snapshot of the session's state; a v1
      // response has no commands, which only the replayed updates report.
      const state = await agent.driver.loadSession(sessionId, roots);
      this.requireRegistration(session);
      session.modes = state.modes;
      session.configOptions = state.configOptions;
      if (state.commands) {
        session.availableCommands = state.commands;
      }
      await this.reapplySelections(session, reference?.selections);
      this.requireRegistration(session);
    } catch (e) {
      this.retained.endLoad(load, false);
      const wasActive = this.removeSession(session);
      this.emit('session-load-end', load, /*ok=*/false);
      if (wasActive) { this.emit('active-session-changed', null); }
      throw e;
    } finally {
      this.loading.delete(session);
    }

    this.retained.endLoad(load, true);
    this.emit('session-load-end', load, /*ok=*/true);
    this.moveReference(session, usedThrough);
    this.recordOpened(session, 'loaded');
    return session;
  }

  /**
   * Request each saved value that differs from the opened session's and that its agent offers: the mode first, then a
   * model, then the rest in the agent's order, comparing again after each answer, as one change can bring about
   * others. Each option is requested at most once, so this ends, and what the agent answers is what the session shows.
   * A value not reapplied is logged; an obsolete registration ends the opening.
   */
  private async reapplySelections(session: SessionInfo, saved: Selections | undefined): Promise<void> {
    this.requireRegistration(session);
    if (!saved) { return; }
    const { sessionId } = session;
    const notReapplied = (context: LogContext) => logWarning('Saved option not reapplied', { sessionId, ...context });

    if ((session.configOptions ?? []).length === 0) {
      const { modeId } = saved;
      const { modes } = session;
      if (modeId === undefined || !modes || modes.current === modeId) { return; }
      if (!modes.available.some((mode) => mode.id === modeId)) {
        notReapplied({ modeId, reason: 'not offered' });
        return;
      }
      try {
        await this.setSessionMode(session, modeId);
      } catch (e) {
        notReapplied({ modeId, reason: messageOf(e) });
      }
      this.requireRegistration(session);
      return;
    }

    const requested = new Set<string>();
    const rejected = new Set<string>();
    for (;;) {
      this.requireRegistration(session);
      const [next] = [...(session.configOptions ?? [])]
        .sort((a, b) => reapplyRank(a) - reapplyRank(b))
        .flatMap((option) => {
          const value = saved.options[option.id];
          return value !== undefined && value !== option.current && !requested.has(option.id) && offers(option, value)
            ? [{ configId: option.id, value }]
            : [];
        });
      if (!next) { break; }
      requested.add(next.configId);
      try {
        await this.setSessionConfigOption(session, next.configId, next.value);
      } catch (e) {
        rejected.add(next.configId);
        notReapplied({ ...next, reason: messageOf(e) });
      }
    }

    const shown = new Map((session.configOptions ?? []).map((option) => [option.id, option.current]));
    for (const [configId, value] of Object.entries(saved.options)) {
      if (shown.get(configId) === value || rejected.has(configId)) { continue; }
      notReapplied({ configId, value, reason: requested.has(configId) ? 'the agent answered with another value' : 'not offered' });
    }
  }

  /**
   * Resume an existing session, then reapply the options saved for it before it becomes active; unlike a load, the
   * agent does not replay its transcript. `usedThrough` is as for {@link loadSession}.
   */
  async resumeSession(agentName: string, sessionId: string, usedThrough?: UsedThrough): Promise<SessionInfo> {
    this.requireNotReloading(agentName, sessionId);
    const agent = await this.ensureAgent(agentName);
    if (!agent.driver.agent.capabilities.resume) {
      throw new Error(`Agent "${agentName}" does not support session/resume.`);
    }

    const roots = this.environment.workspaceRoots();
    const reference = this.referenceUsedThrough(agent.name, sessionId, usedThrough);
    const key = JSON.stringify([agent.process.id, sessionId]);
    if (this.resuming.has(key)) { throw new Error('Session resume is already in progress.'); }
    this.resuming.add(key);
    let sessionInfo: SessionInfo;
    try {
      const response = await agent.driver.resumeSession(sessionId, roots);
      sessionInfo = this.registerSession(agent, sessionId, roots, response, reference);
    } finally {
      this.resuming.delete(key);
      this.retained.discardOpening(agent.process.id, sessionId);
    }
    this.loading.set(sessionInfo, { registration: sessionInfo, origin: { identity: { configuredName: sessionInfo.agentName, sessionId }, sourceId: sessionInfo.agentId }, attempt: Symbol(sessionId) });
    try {
      await this.reapplySelections(sessionInfo, reference?.selections);
      this.requireRegistration(sessionInfo);
    } catch (error) {
      if (this.removeSession(sessionInfo)) { this.emit('active-session-changed', null); }
      throw error;
    } finally {
      this.loading.delete(sessionInfo);
    }
    this.selectionRevision++;
    this.activeSessionId = JSON.stringify([sessionInfo.agentName, sessionId]);
    this.emit('session-added', sessionInfo);
    this.emit('active-session-changed', sessionInfo);

    this.moveReference(sessionInfo, usedThrough);
    this.recordOpened(sessionInfo, 'resumed');
    return sessionInfo;
  }

  /** The reference of a session about to be opened through `agentName`, as {@link loadSession} takes `usedThrough`. */
  private referenceUsedThrough(agentName: string, sessionId: string, usedThrough: UsedThrough | undefined): SessionReference | undefined {
    if (!usedThrough) { return this.referenceOf(agentName, sessionId); }
    const host = usedThrough.host ?? this.environment.workspaceTarget()?.host;
    return host ? this.persisted?.references.get({ host, configuredName: usedThrough.configuredName, sessionId }) : undefined;
  }

  /** A session opened through `agentName` that was last used through another configuration: its reference moves. */
  private moveReference(session: SessionInfo, usedThrough: UsedThrough | undefined): void {
    const persisted = this.persisted;
    if (!persisted || !usedThrough) { return; }
    const move = (host: string) => {
      if (!this.driverFor(session) || usedThrough.configuredName === session.agentName) { return; }
      void persisted.references.rebind(host, usedThrough.configuredName, session.agentName, session.sessionId);
    };
    if (usedThrough.host) {
      move(usedThrough.host);
    } else {
      this.withTarget((target) => move(target.host));
    }
  }

  /** Select the captured live registration without opening it again. */
  selectSession(session: SessionInfo): boolean {
    if (!this.driverFor(session) || this.loading.has(session)) { return false; }
    this.selectionRevision++;
    if (this.getActiveSession() !== session) {
      this.activeSessionId = JSON.stringify([session.agentName, session.sessionId]);
      this.record(session, (address, { workspace }) => {
        if (this.getActiveSession() === session) { void workspace.setLastActiveSession(address); }
      });
      this.emit('active-session-changed', session);
    }
    return true;
  }

  private requireNotReloading(agentName: string, sessionId: string): void {
    if (this.sessionReloading({ configuredName: agentName, sessionId })) {
      throw new Error('This session is being reloaded by Restart Agent.');
    }
  }

  private acceptsOpening(agentId: string, sessionId: string): boolean {
    return [...this.processes].some(([process, lifetime]) => process.id === agentId && lifetime.accepting)
      && (this.creating.has(agentId) || this.resuming.has(JSON.stringify([agentId, sessionId])));
  }

  sessionReloading(identity: SessionIdentity): boolean {
    return [...this.reloading].some((session) => session.agentName === identity.configuredName && session.sessionId === identity.sessionId);
  }

  private sessionsOn(process: AgentProcess): SessionInfo[] {
    return [...this.sessions.values()].filter((session) => session.agentId === process.id);
  }

  private stopAgentWithoutSessions(agent: RunningAgent): void {
    if (this.sessionsOn(agent.process).length === 0) { this.stopAgent(agent); }
  }

  private removeSessions(sessions: readonly SessionInfo[], preserveSelection = false): void {
    let removedActive = false;
    for (const session of sessions) { removedActive = this.removeSession(session, preserveSelection) || removedActive; }
    if (removedActive && !preserveSelection && this.getActiveSession() === undefined) { this.emit('active-session-changed', null); }
  }

  /** Forget a session and report whether it was active. The caller announces the selection change. */
  private removeSession(session: SessionInfo, preserveSelection = false): boolean {
    const key = JSON.stringify([session.agentName, session.sessionId]);
    if (this.sessions.get(key) !== session) { return false; }
    this.sessions.delete(key);
    const wasActive = this.activeSessionId === key;
    if (wasActive && !preserveSelection) {
      this.activeSessionId = null;
    }
    this.emit('session-removed', session);
    return wasActive;
  }

  private requireRegistration(session: SessionInfo): void {
    if (!this.driverFor(session)) { throw new Error('Session opening is no longer current.'); }
  }

  private referenceOf(agentName: string, sessionId: string) {
    const host = this.environment.workspaceTarget()?.host;
    return host ? this.persisted?.references.get({ host, configuredName: agentName, sessionId }) : undefined;
  }

  /** The session was created, loaded or resumed here, which also makes it this workspace's last active session. */
  private recordOpened(session: SessionInfo, how: SessionOpening): void {
    this.record(session, (address, { references, workspace }) => {
      void references.used(address, session.title);
      void workspace.setLastActiveSession(address);
    });
    this.emit('session-opened', session, how);
  }

  /** Record a change to a session open here, when this window has a workspace target to record it against. */
  private record(session: SessionInfo, change: (address: SessionAddress, persisted: PersistedState) => void): void {
    const persisted = this.persisted;
    if (persisted) {
      this.withTarget((target) => {
        if (!this.driverFor(session)) { return; }
        change({ configuredName: session.agentName, sessionId: session.sessionId, cwd: session.cwd, host: target.host, workspaceUri: target.uri }, persisted);
      });
    }
  }

  /** Use the workspace target now when it is known, otherwise once it is, unless disposal begins first. */
  private withTarget(use: (target: WorkspaceTarget) => void): void {
    const target = this.environment.workspaceTarget();
    if (target) {
      use(target);
      return;
    }
    void this.waitingForTarget.track(this.targetKnown().then((known) => { if (known) { use(known); } }));
  }

  /** The workspace target once it is known, or undefined once disposal begins first. */
  private targetKnown(): Promise<WorkspaceTarget | undefined> {
    return Promise.race([this.environment.workspaceTargetKnown(), this.waitsEnded]);
  }

  /** Settles once every change waiting for the workspace target has been recorded, or dropped as disposal began. */
  recordsSettled(): Promise<void> {
    return this.waitingForTarget.settled();
  }

  getSession({ configuredName, sessionId }: SessionIdentity): SessionInfo | undefined {
    return this.sessions.get(JSON.stringify([configuredName, sessionId]));
  }

  resolutionBlocked(): boolean {
    return this.disposed || [...this.activity.values()].some((activity) => activity.submissions.size > 0
      || activity.foreground === 'running' || activity.foreground === 'requiresAction');
  }

  onChanged(listener: (...args: SessionManagerEvents['activity-changed']) => void): () => void {
    this.on('activity-changed', listener);
    return () => { this.off('activity-changed', listener); };
  }

  async runDecision<T>(action: (stillAdmitted: () => boolean) => Promise<T>): Promise<
    { kind: 'blocked' } | { kind: 'completed'; value: T }
  > {
    if (this.resolutionBlocked()) { return { kind: 'blocked' }; }
    const previous = this.decisions;
    let release!: () => void;
    const settled = new Promise<void>((resolve) => { release = resolve; });
    this.decisions = settled;
    try {
      if (previous) { await previous; }
      if (this.resolutionBlocked()) { return { kind: 'blocked' }; }
      const revision = this.activityRevision;
      const stillAdmitted = () => !this.disposed && this.activityRevision === revision;
      return { kind: 'completed', value: await action(stillAdmitted) };
    } finally {
      if (this.decisions === settled) { this.decisions = undefined; }
      release();
    }
  }

  /** Also retains snapshots that arrive before session/new or session/resume answers. */
  applyForegroundState(identity: SessionIdentity, state: ForegroundState, agentId?: string, outcome?: 'cancelled' | 'failed'): void {
    const { sessionId } = identity;
    agentId ??= this.getSession(identity)?.agentId;
    const key = JSON.stringify([agentId, sessionId]);
    const activity = this.activity.get(key) ?? { foreground: null, submissions: new Set<symbol>(), agentId };
    const previous = activity.foreground;
    activity.foreground = state;
    this.activity.set(key, activity);
    if (state === 'running' || state === 'requiresAction') { this.activityRevision++; }
    const session = this.getSession(identity);
    if (session && session.agentId === agentId && !this.loading.has(session)) {
      const wasWorking = previous === 'running' || previous === 'requiresAction';
      if (!wasWorking && state !== 'idle') { this.retained.setTurnOutcome(identity, null); }
      // Prompt responses own their own outcome, even if a foreground update arrives first.
      if (wasWorking && state === 'idle' && activity.submissions.size === 0) {
        this.retained.setTurnOutcome(identity, outcome === 'failed' ? 'failed' : outcome === 'cancelled' ? null : 'completed');
      }
    }
    this.emit('activity-changed', undefined, undefined, agentId === undefined ? undefined : { identity, sourceId: agentId });
    if (session && session.agentId === agentId) { this.releaseQueued(session); }
  }

  private beginPrompt({ sessionId, agentId }: SessionInfo): symbol {
    const key = JSON.stringify([agentId, sessionId]);
    const activity = this.activity.get(key) ?? { foreground: null, submissions: new Set<symbol>(), agentId };
    const submission = Symbol(sessionId);
    activity.submissions.add(submission);
    this.activity.set(key, activity);
    return submission;
  }

  hasForegroundWork(identity: SessionIdentity): boolean {
    const activity = this.activity.get(JSON.stringify([this.getSession(identity)?.agentId, identity.sessionId]));
    return activity !== undefined && (activity.submissions.size > 0 || activity.foreground === 'running' || activity.foreground === 'requiresAction');
  }

  getActiveSession(): SessionInfo | undefined {
    if (!this.activeSessionId) { return undefined; }
    return this.sessions.get(this.activeSessionId);
  }

  getActiveSessionId(): string | null {
    return this.getActiveSession()?.sessionId ?? null;
  }

  /** Get the agent name for the current active session. */
  getActiveAgentName(): string | null {
    const session = this.getActiveSession();
    return session?.agentName ?? null;
  }

  hasSession(agentName: string): boolean {
    return this.openSessionsOf(agentName).length > 0;
  }

  /** An initialized ACP connection, independently of whether it owns a session. */
  isConnected(agentName: string): boolean {
    const agent = this.agents.get(agentName);
    return agent !== undefined && !agent.driver.closed;
  }

  /** Whether the agent's process is running, which asking it anything would otherwise start. */
  isRunning(agentName: string): boolean {
    return this.agents.has(agentName);
  }

  /** Registrations open through this agent configuration in this window. */
  openSessionsOf(agentName: string): SessionInfo[] {
    return [...this.sessions.values()].filter((session) => session.agentName === agentName);
  }

  getAgentNamesWithSessions(): string[] {
    return [...new Set([...this.sessions.values()].map((session) => session.agentName))];
  }

  dispose(): Promise<void> {
    if (this.disposal) { return this.disposal; }
    this.disposed = true;
    for (const process of this.processes.keys()) { this.retireSource(process); }
    this.endWaits();
    this.agents.clear();
    this.sessions.clear();
    const retainedDisposed = this.retained.dispose();
    this.activity.clear();
    this.disposal = (async () => {
      const results = await Promise.allSettled([...this.processes].map(async ([process, { exited }]) => {
        process.kill();
        await exited;
      }));
      await retainedDisposed;
      // Closing the processes also releases initialize requests in flight.
      await Promise.allSettled(this.launching.values());
      this.activeSessionId = null;
      // Requests in flight as shutdown began may still record; once their agents are gone, none can.
      await this.waitingForTarget.dispose();
      await Promise.all([this.persisted?.references.dispose(), this.persisted?.workspace.dispose()]);
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length > 0) {
        throw new AggregateError(failures.map((result) => result.reason as unknown), 'Failed to stop agent processes.');
      }
    })();
    return this.disposal;
  }
}
