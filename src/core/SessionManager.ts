import { EventEmitter } from 'node:events';

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
  type NewSession,
  type PromptPart,
  type SessionPage,
  type SessionRoots,
  type SessionState,
  type SessionUpdate,
  type SlashCommand,
} from '@/core/acp/AcpDriver';
import type { ConnectionManager } from '@/core/acp/ConnectionManager';
import { SessionUpdateHandler, type QualifiedSessionUpdate, type SessionIdentity, type SessionOrigin, type SessionRegistration, type SessionLoad } from '@/core/SessionUpdateHandler';
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
  /** Latest title supplied by a session update, if any. */
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
  'activity-changed': [retiredSource?: string];
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

/**
 * Manages agents, their connections, and their sessions.
 *
 * One session is active at a time; connecting to, loading, or resuming with
 * another agent disconnects the agent that owned the previous one. At most one
 * agent process runs per agent name; it is launched on first use, either for a
 * session or to list an agent's sessions, and reused after that.
 */
export class SessionManager extends EventEmitter<SessionManagerEvents> implements ReviewAdmission {
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

  /** Maps agentName → sessionId for the one-session-per-agent model. */
  private agentSessions = new Map<string, string>();

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
  ) {
    super();
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
      for (const session of this.sessions.values()) {
        if (session.agentName === from) { session.agentName = to; }
      }
      const sessionId = this.agentSessions.get(from);
      if (sessionId !== undefined) {
        this.agentSessions.delete(from);
        this.agentSessions.set(to, sessionId);
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

  /**
   * Make a session with an agent the active session, creating one unless the
   * agent already has a live session. Disconnects the agent that owns the
   * previous active session.
   */
  async connectToAgent(agentName: string): Promise<SessionInfo> {
    const existing = this.sessionOf(agentName);
    if (existing) {
      this.activeSessionId = existing.sessionId;
      this.emit('active-session-changed', existing);
      return existing;
    }

    const currentAgent = this.getActiveAgentName();
    if (currentAgent) {
      await this.disconnectAgent(currentAgent);
    }

    logDebug('Connecting to agent', { agentName });

    const agent = await this.ensureAgent(agentName);
    const sessionInfo = await this.createAcpSession(agent, this.environment.workspaceRoots());

    this.agentSessions.set(agent.name, sessionInfo.sessionId);
    this.activeSessionId = sessionInfo.sessionId;

    this.emit('session-added', sessionInfo);
    this.emit('active-session-changed', sessionInfo);

    logInfo('Connected to agent', { agentName, sessionId: sessionInfo.sessionId });
    return sessionInfo;
  }

  /**
   * Start a new session with the agent that owns the active session, on a
   * fresh agent process, and clear the transcript.
   */
  async newSession(): Promise<SessionInfo | null> {
    const activeSession = this.getActiveSession();
    if (!activeSession) {
      return null;
    }

    const agentName = activeSession.agentName;
    await this.disconnectAgent(agentName);
    this.emit('clear-transcript');
    return this.connectToAgent(agentName);
  }

  /** Stop an agent, ending its connection, and drop its session if it has one. */
  async disconnectAgent(agentName: string): Promise<void> {
    this.launching.delete(agentName);
    for (const [process, lifetime] of this.processes) {
      if (lifetime.name === agentName && lifetime.accepting && !this.agents.has(agentName)) {
        this.retireSource(process);
        process.kill();
      }
    }
    const agent = this.agents.get(agentName);
    if (agent) {
      logInfo('Disconnecting agent', { agentName });
      this.stopAgent(agent);
    }
    const session = this.sessionOf(agentName);
    if (session) {
      this.removeSession(session);
      this.emit('active-session-changed', null);
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
      });
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

  /** Stop an agent's process and forget it; its session, if any, is the caller's to drop. */
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
    const candidate = this.sessions.get(sessionId);
    const registration = candidate?.agentId === process.id && candidate.agentName === lifetime.name ? candidate : undefined;
    const identity: SessionIdentity = { configuredName: lifetime.name, sessionId };
    const origin: SessionOrigin = { identity, sourceId: process.id };
    // Early metadata is source-local even when another source currently owns this raw ID.
    const key = JSON.stringify([process.id, sessionId]);
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
        if (registration) { this.applySessionInfoUpdate(sessionId, update); }
        else if (update.title !== undefined) { this.pendingTitles.set(key, update.title); }
        if (!registration) { this.emit('session-info-changed', origin, update); }
        break;
      case 'currentMode':
        if (registration) { this.applyCurrentMode(sessionId, update.modeId); }
        else { this.pendingModes.set(key, update.modeId); }
        break;
      case 'foreground':
        this.applyForegroundState(sessionId, update.state, process.id);
        if (!registration) { this.pendingForeground.set(key, update.state); }
        break;
      default:
        break;
    }
    const input: QualifiedSessionUpdate = { origin, update, schema };
    this.updates.handleUpdate({ input, registration });
  }

  private handleAgentExit(agentName: string, agentProcess: AgentProcess, code: number | null): void {
    this.retireSource(agentProcess);
    // Still registered means nothing here stopped it.
    const running = [...this.agents.values()].find((agent) => agent.process === agentProcess);
    const currentName = running?.name ?? agentName;
    const unexpected = running !== undefined;
    if (unexpected) {
      logError('Agent exited unexpectedly', undefined, { agentName, exitCode: code });
    } else {
      logDebug('Agent exited', { agentName, exitCode: code });
    }
    if (unexpected) {
      this.agents.delete(currentName);
      this.emit('connection-changed', currentName);
    }

    // Only the session running on this process goes; a newer one for the same agent stays.
    const session = [...this.sessions.values()].find((session) => session.agentId === agentProcess.id);
    if (session?.agentId === agentProcess.id) {
      if (unexpected) {
        this.emit('session-ended', session, exitReason(session.agentDisplayName, code));
      }
      this.removeSession(session);
      this.emit('active-session-changed', null);
    }
    this.emit('agent-closed', agentProcess.id, code);
  }

  /** Create the ACP session, authenticating first if the agent requires it. */
  private async createAcpSession(agent: RunningAgent, roots: SessionRoots): Promise<SessionInfo> {
    const requestSession = () => agent.driver.newSession(roots);

    let response: NewSession;
    try {
      response = await requestSession();
    } catch (e) {
      if (!(e instanceof AuthRequired)) {
        logError('Failed to create session', e);
        this.stopAgent(agent);
        throw e;
      }
      await this.runAuthFlow(agent);
      try {
        response = await requestSession();
      } catch (retryErr) {
        logError('Failed to create session after authentication', retryErr);
        this.stopAgent(agent);
        throw retryErr;
      }
    }

    const sessionInfo = this.registerSession(agent, response.sessionId, roots.cwd, response);
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
    cwd: string,
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
      cwd,
      createdAt: new Date().toISOString(),
      modes: state.modes,
      configOptions: state.configOptions,
      availableCommands: state.commands ?? [],
      ...(title ? { title } : {}),
    };
    this.sessions.set(sessionId, sessionInfo);
    this.drainPending(sessionInfo);
    return sessionInfo;
  }

  /**
   * Run the interactive auth flow against an already-initialized connection.
   * Stops the agent and throws if the user cancels or auth fails.
   */
  private async runAuthFlow(agent: RunningAgent): Promise<void> {
    const { authMethods } = agent.driver.agent;
    if (authMethods.length === 0) {
      this.stopAgent(agent);
      throw new Error(
        `Agent "${agent.name}" requires authentication but did not advertise any auth methods.`,
      );
    }

    logDebug('Agent requires authentication', { methods: authMethods.map((method) => method.name) });

    const selectedMethod = await this.authPrompt.chooseAuthMethod(agent.name, authMethods);
    if (!selectedMethod) {
      this.stopAgent(agent);
      throw new AuthenticationCancelled();
    }

    try {
      logDebug('Authenticating with method', { methodName: selectedMethod.name, methodId: selectedMethod.id });
      await agent.driver.authenticate(selectedMethod.id);
      logInfo('Authentication successful', { agentName: agent.name });
    } catch (authErr) {
      logError('Authentication failed', authErr);
      this.stopAgent(agent);
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
      this.applyForegroundState(sessionInfo.sessionId, foreground, sessionInfo.agentId);
      this.pendingForeground.delete(key);
    }
  }

  /** The driver of the connection a session runs on, or undefined once its agent has stopped. */
  private driverFor(session: SessionInfo): AcpDriver | undefined {
    if (this.sessions.get(session.sessionId) !== session) { return; }
    const agent = this.agents.get(session.agentName);
    if (agent?.process.id !== session.agentId || !this.processes.get(agent.process)?.accepting) { return; }
    return agent.driver;
  }

  /**
   * Send a prompt to the active session; resolves when the turn ends.
   */
  async sendPrompt(sessionId: string, text: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
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

    const submission = this.beginPrompt(sessionId);
    const activity = this.activity.get(JSON.stringify([session.agentId, sessionId]));
    const decisions = this.decisions;
    try {
      if (decisions) { await decisions; }
      if (this.driverFor(session) !== agent.driver) { throw new Error('Prompt session is no longer current.'); }
      await agent.driver.prompt(sessionId, prompt);
    } catch (e) {
      // The connection can close before the process's exit is reported; the exit ends the session and says why,
      // so the prompt fails after it.
      if (agent.driver.closed) {
        await agent.exited;
      }
      throw e;
    } finally {
      activity?.submissions.delete(submission);
      this.emit('activity-changed');
    }
  }

  /**
   * Cancel an active prompt turn.
   */
  async cancelTurn(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) { return; }

    const driver = this.driverFor(session);
    if (!driver) { return; }

    logDebug('Cancelling turn', { sessionId });
    await driver.cancel(sessionId);
  }

  /**
   * Set the session mode (e.g., plan mode, code mode).
   *
   * If the active session uses `configOptions`, this is transparently
   * routed to `setConfigOption` against the first option whose category is
   * `mode` — this keeps user keybindings working across agents that have
   * migrated to the new API.
   */
  async setMode(sessionId: string, modeId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
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
  async setModel(sessionId: string, modelId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
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
  async setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<ConfigOption[] | null> {
    const session = this.sessions.get(sessionId);
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
  applyConfigOptions(sessionId: string, options: ConfigOption[] | null): void {
    const session = this.sessions.get(sessionId);
    if (!session) { return; }
    session.configOptions = options;
    this.saveSelections(session);
  }

  /** Record the session's mode, as set here or switched by the agent itself. */
  applyCurrentMode(sessionId: string, modeId: string): void {
    const session = this.sessions.get(sessionId);
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
  applyAvailableCommands(sessionId: string, commands: SlashCommand[]): void {
    const session = this.sessions.get(sessionId);
    if (!session) { return; }
    session.availableCommands = commands;
  }

  /**
   * Apply a session info update: patches title / updatedAt on
   * the in-memory session and caches the title in its session reference.
   */
  applySessionInfoUpdate(sessionId: string, update: { title?: string | null; updatedAt?: string | null }): void {
    const session = this.sessions.get(sessionId);
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

  /** A turn of the session ended: record it as used, and tell the session list. */
  recordTurnEnded(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) { return; }
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
        ? { cwd: opts.cwd, openInThisWindow: new Set(this.sessions.keys()) }
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
    await this.disconnectOtherAgent(agentName);

    const agent = await this.ensureAgent(agentName);
    if (!agent.driver.agent.capabilities.load) {
      throw new Error(`Agent "${agentName}" does not support session/load.`);
    }

    this.dropActiveSessionUnless(sessionId);

    const roots = this.environment.workspaceRoots();
    const reference = this.referenceUsedThrough(agent.name, sessionId, usedThrough);
    // Registered and made active before the request, so the transcript the
    // agent replays during the load reaches the webview.
    const session = this.registerSession(agent, sessionId, roots.cwd, NO_SESSION_STATE, reference);
    this.agentSessions.set(agent.name, sessionId);
    this.activeSessionId = sessionId;
    // Emit active-session-changed BEFORE session-load-start so the webview
    // first repaints from the new session state, then immediately enters
    // the loading-overlay state.
    const load: SessionLoad = { registration: session, origin: { identity: { configuredName: session.agentName, sessionId }, sourceId: session.agentId }, attempt: Symbol(sessionId) };
    this.loading.set(session, load);
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
      const wasActive = this.getActiveSession() === session;
      this.removeSession(session);
      this.emit('session-load-end', load, /*ok=*/false);
      if (wasActive) { this.emit('active-session-changed', null); }
      throw e;
    } finally {
      this.loading.delete(session);
    }

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
    await this.disconnectOtherAgent(agentName);

    const agent = await this.ensureAgent(agentName);
    if (!agent.driver.agent.capabilities.resume) {
      throw new Error(`Agent "${agentName}" does not support session/resume.`);
    }

    this.dropActiveSessionUnless(sessionId);

    const roots = this.environment.workspaceRoots();
    const response = await agent.driver.resumeSession(sessionId, roots);

    const reference = this.referenceUsedThrough(agent.name, sessionId, usedThrough);
    const sessionInfo = this.registerSession(agent, sessionId, roots.cwd, response, reference);
    this.agentSessions.set(agent.name, sessionId);
    this.activeSessionId = sessionId;
    this.loading.set(sessionInfo, { registration: sessionInfo, origin: { identity: { configuredName: sessionInfo.agentName, sessionId }, sourceId: sessionInfo.agentId }, attempt: Symbol(sessionId) });
    try {
      await this.reapplySelections(sessionInfo, reference?.selections);
      this.requireRegistration(sessionInfo);
    } finally {
      this.loading.delete(sessionInfo);
    }
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

  /** Honor the single-active-session model when opening a session with `agentName`. */
  private async disconnectOtherAgent(agentName: string): Promise<void> {
    const currentAgent = this.getActiveAgentName();
    if (currentAgent && currentAgent !== agentName) {
      await this.disconnectAgent(currentAgent);
    }
  }

  /** Drop the active session so `sessionId` can take its place. */
  private dropActiveSessionUnless(sessionId: string): void {
    const previous = this.getActiveSession();
    if (previous && previous.sessionId !== sessionId) {
      this.removeSession(previous);
    }
  }

  private sessionOf(agentName: string): SessionInfo | undefined {
    const sessionId = this.agentSessions.get(agentName);
    return sessionId ? this.sessions.get(sessionId) : undefined;
  }

  /** Forget a session; the caller announces any change to the active session. */
  private removeSession(session: SessionInfo): void {
    if (this.sessions.get(session.sessionId) !== session) { return; }
    this.sessions.delete(session.sessionId);
    if (this.agentSessions.get(session.agentName) === session.sessionId) {
      this.agentSessions.delete(session.agentName);
    }
    if (this.activeSessionId === session.sessionId) {
      this.activeSessionId = null;
    }
    this.emit('session-removed', session);
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
      void references.used(address);
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

  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  resolutionBlocked(): boolean {
    return this.disposed || [...this.activity.values()].some((activity) => activity.submissions.size > 0
      || activity.foreground === 'running' || activity.foreground === 'requiresAction');
  }

  onChanged(listener: (retiredSource?: string) => void): () => void {
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
  applyForegroundState(sessionId: string, state: ForegroundState, agentId?: string): void {
    agentId ??= this.sessions.get(sessionId)?.agentId;
    const key = JSON.stringify([agentId, sessionId]);
    const activity = this.activity.get(key) ?? { foreground: null, submissions: new Set<symbol>(), agentId };
    activity.foreground = state;
    this.activity.set(key, activity);
    if (state === 'running' || state === 'requiresAction') { this.activityRevision++; }
    this.emit('activity-changed');
  }

  private beginPrompt(sessionId: string): symbol {
    const agentId = this.sessions.get(sessionId)?.agentId;
    const key = JSON.stringify([agentId, sessionId]);
    const activity = this.activity.get(key) ?? { foreground: null, submissions: new Set<symbol>(), agentId };
    const submission = Symbol(sessionId);
    activity.submissions.add(submission);
    this.activity.set(key, activity);
    this.emit('activity-changed');
    return submission;
  }

  hasForegroundWork(sessionId: string): boolean {
    const activity = this.activity.get(JSON.stringify([this.sessions.get(sessionId)?.agentId, sessionId]));
    return activity !== undefined && (activity.submissions.size > 0 || activity.foreground === 'running' || activity.foreground === 'requiresAction');
  }

  getActiveSession(): SessionInfo | undefined {
    if (!this.activeSessionId) { return undefined; }
    return this.sessions.get(this.activeSessionId);
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  /** Get the agent name for the current active session. */
  getActiveAgentName(): string | null {
    const session = this.getActiveSession();
    return session?.agentName ?? null;
  }

  hasSession(agentName: string): boolean {
    return this.agentSessions.has(agentName);
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

  /** The agent's session open in this window, if it has one. */
  openSessionOf(agentName: string): SessionInfo | undefined {
    const sessionId = this.agentSessions.get(agentName);
    return sessionId === undefined ? undefined : this.sessions.get(sessionId);
  }

  getAgentNamesWithSessions(): string[] {
    return Array.from(this.agentSessions.keys());
  }

  dispose(): Promise<void> {
    if (this.disposal) { return this.disposal; }
    this.disposed = true;
    for (const process of this.processes.keys()) { this.retireSource(process); }
    this.endWaits();
    this.agents.clear();
    this.sessions.clear();
    this.activity.clear();
    this.agentSessions.clear();
    this.disposal = (async () => {
      const results = await Promise.allSettled([...this.processes].map(async ([process, { exited }]) => {
        process.kill();
        await exited;
      }));
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
