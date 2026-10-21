import { EventEmitter } from 'node:events';

import {
  AuthRequired,
  UnknownSession,
  type AcpDriver,
  type AgentCapabilities,
  type AuthMethod,
  type ConfigOption,
  type FileLink,
  type Modes,
  type NewSession,
  type PromptPart,
  type SessionPage,
  type SessionState,
  type SlashCommand,
} from '@/core/acp/AcpDriver';
import type { ConnectionManager } from '@/core/acp/ConnectionManager';
import { commandNotFound, type AgentConfigEntry, type AgentLauncher, type AgentProcess, type LaunchError } from './AgentManager';
import type { SessionHistoryStore } from './SessionHistoryStore';
import { log, logError, messageOf } from './Log';

/** What sessions need from the workspace the extension runs in. */
export interface SessionEnvironment {
  /** Working directory for agents and their sessions. */
  workspaceCwd(): string;
  agentConfigs(): Record<string, AgentConfigEntry>;
  /** The file to link at the start of each prompt, or undefined when none applies. */
  activeFileLink(): FileLink | undefined;
}

export interface AuthPrompt {
  /** Resolves to undefined when the user cancels. */
  chooseAuthMethod(agentName: string, methods: AuthMethod[]): Promise<AuthMethod | undefined>;
}

export interface SessionInfo {
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
  name: string;
  process: AgentProcess;
  driver: AcpDriver;
  /** Settles once the process's exit has been handled. */
  exited: Promise<void>;
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

/** The events a {@link SessionManager} emits, with the arguments each passes its listeners. */
export interface SessionManagerEvents {
  'session-added': [sessionId: string, agentName: string];
  'session-removed': [sessionId: string, agentName: string];
  'active-session-changed': [sessionId: string | null];
  'clear-transcript': [];
  'mode-changed': [sessionId: string, modeId: string];
  'session-info-changed': [sessionId: string, update: { title?: string | null; updatedAt?: string | null }];
  'session-load-start': [sessionId: string, agentName: string];
  'session-load-end': [sessionId: string, agentName: string, ok: boolean];
  'session-ended': [sessionId: string, reason: string];
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
export class SessionManager extends EventEmitter<SessionManagerEvents> {
  /** Running agents by agent name. */
  private agents = new Map<string, RunningAgent>();
  /** Launches in progress by agent name, so concurrent callers share one process. */
  private launching = new Map<string, Promise<RunningAgent>>();
  /** Session titles from each agent's `session/list` pages, by agent name then session ID. */
  private listedTitles = new Map<string, Map<string, string>>();

  private sessions = new Map<string, SessionInfo>();
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
  private pendingTitles = new Map<string, string>();

  /**
   * Cache of each agent's capabilities, so the tree can render
   * without paying the connect cost on every render.
   */
  private capabilities = new Map<string, AgentCapabilities>();

  /** Client-side session history (optional — only used for tier-2 tree). */
  private historyStore: SessionHistoryStore | null = null;

  constructor(
    private readonly launcher: AgentLauncher,
    private readonly connectionManager: ConnectionManager,
    private readonly environment: SessionEnvironment,
    private readonly authPrompt: AuthPrompt,
  ) {
    super();
  }

  /** Wire in the persistent session-history store (called once at startup). */
  setHistoryStore(store: SessionHistoryStore): void {
    this.historyStore = store;
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
      this.emit('active-session-changed', existing.sessionId);
      return existing;
    }

    const currentAgent = this.getActiveAgentName();
    if (currentAgent) {
      await this.disconnectAgent(currentAgent);
    }

    log(`SessionManager: connecting to agent "${agentName}"`);

    const agent = await this.ensureAgent(agentName);
    const sessionInfo = await this.createAcpSession(agent, this.environment.workspaceCwd());

    this.agentSessions.set(agentName, sessionInfo.sessionId);
    this.activeSessionId = sessionInfo.sessionId;

    this.emit('session-added', sessionInfo.sessionId, agentName);
    this.emit('active-session-changed', sessionInfo.sessionId);

    log(`Connected to agent ${agentName}, session ${sessionInfo.sessionId}`);
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
    const agent = this.agents.get(agentName);
    if (agent) {
      log(`Disconnecting agent ${agentName}`);
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
    const running = this.agents.get(agentName);
    if (running) {
      return Promise.resolve(running);
    }
    let launching = this.launching.get(agentName);
    if (!launching) {
      launching = this.launchAgent(agentName).finally(() => this.launching.delete(agentName));
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
    const agentProcess = this.launcher.launch(agentName, config, this.environment.workspaceCwd(), {
      error: (error) => { outcome.launchError = error; },
      exit: (code) => {
        outcome.exitCode = code;
        this.handleAgentExit(agentName, agentProcess, code);
        exitHandled();
      },
    });

    let driver: AcpDriver;
    try {
      driver = await this.connectionManager.connect(agentName, agentProcess);
    } catch (e) {
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
        throw new Error(`Agent "${agentName}" exited with code ${outcome.exitCode} before connecting; its output is in the ACP log (ACP: Show Log).`);
      }
      throw e;
    }

    const agent: RunningAgent = { name: agentName, process: agentProcess, driver, exited };
    this.agents.set(agentName, agent);
    this.capabilities.set(agentName, driver.agent.capabilities);
    return agent;
  }

  /** Stop an agent's process and forget it; its session, if any, is the caller's to drop. */
  private stopAgent(agent: RunningAgent): void {
    if (this.agents.get(agent.name) === agent) {
      this.agents.delete(agent.name);
    }
    agent.process.kill();
  }

  private handleAgentExit(agentName: string, agentProcess: AgentProcess, code: number | null): void {
    log(`Agent ${agentName} closed with code ${String(code)}`);
    // Still registered means nothing here stopped it.
    const unexpected = this.agents.get(agentName)?.process === agentProcess;
    if (unexpected) {
      this.agents.delete(agentName);
    }

    // Only the session running on this process goes; a newer one for the same agent stays.
    const session = this.sessionOf(agentName);
    if (session?.agentId === agentProcess.id) {
      if (unexpected) {
        this.emit('session-ended', session.sessionId, exitReason(session.agentDisplayName, code));
      }
      this.removeSession(session);
      this.emit('active-session-changed', null);
    }
    this.emit('agent-closed', agentProcess.id, code);
  }

  /** Create the ACP session, authenticating first if the agent requires it. */
  private async createAcpSession(agent: RunningAgent, cwd: string): Promise<SessionInfo> {
    const requestSession = () => agent.driver.newSession(cwd);

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

    const sessionInfo = this.registerSession(agent, response.sessionId, cwd, response);
    this.historyStore?.upsertNew(agent.name, cwd, sessionInfo.sessionId);
    return sessionInfo;
  }

  /**
   * Register a session as soon as the agent names it, so session/update
   * notifications that arrive before the caller's continuation runs can be
   * applied to it instead of dropped.
   */
  private registerSession(agent: RunningAgent, sessionId: string, cwd: string, state: SessionState = NO_SESSION_STATE): SessionInfo {
    // Known for a session reopened from the tree; updates drained below override it.
    const title = this.listedTitles.get(agent.name)?.get(sessionId) ?? this.historyStore?.get(agent.name, sessionId)?.title;
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

    log(`Agent requires authentication. Methods: ${authMethods.map(m => m.name).join(', ')}`);

    const selectedMethod = await this.authPrompt.chooseAuthMethod(agent.name, authMethods);
    if (!selectedMethod) {
      this.stopAgent(agent);
      throw new AuthenticationCancelled();
    }

    try {
      log(`Authenticating with method: ${selectedMethod.name} (${selectedMethod.id})`);
      await agent.driver.authenticate(selectedMethod.id);
      log('Authentication successful');
    } catch (authErr) {
      logError('Authentication failed', authErr);
      this.stopAgent(agent);
      throw new Error(`Authentication failed: ${messageOf(authErr)}`);
    }
  }

  /** Apply any state buffered before the session was registered. */
  private drainPending(sessionInfo: SessionInfo): void {
    const pendingCmds = this.pendingAvailableCommands.get(sessionInfo.sessionId);
    if (pendingCmds) {
      sessionInfo.availableCommands = pendingCmds;
      this.pendingAvailableCommands.delete(sessionInfo.sessionId);
    }
    const pendingCfg = this.pendingConfigOptions.get(sessionInfo.sessionId);
    if (pendingCfg !== undefined) {
      sessionInfo.configOptions = pendingCfg;
      this.pendingConfigOptions.delete(sessionInfo.sessionId);
    }
    const pendingTitle = this.pendingTitles.get(sessionInfo.sessionId);
    if (pendingTitle !== undefined) {
      sessionInfo.title = pendingTitle;
      this.pendingTitles.delete(sessionInfo.sessionId);
    }
  }

  /** The driver of the connection a session runs on, or undefined once its agent has stopped. */
  private driverFor(session: SessionInfo): AcpDriver | undefined {
    return this.agents.get(session.agentName)?.driver;
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

    log(`sendPrompt: session=${sessionId}, text="${text.substring(0, 50)}..."`);

    const prompt: PromptPart[] = [
      { kind: 'text', text },
    ];

    const fileLink = this.environment.activeFileLink();
    if (fileLink) {
      log(`sendPrompt: attaching active file context: ${fileLink.name}`);
      prompt.unshift({ kind: 'fileLink', ...fileLink });
    }

    try {
      await agent.driver.prompt(sessionId, prompt);
    } catch (e) {
      // The connection can close before the process's exit is reported; the exit ends the session and says why,
      // so the prompt fails after it.
      if (agent.driver.closed) {
        await agent.exited;
      }
      throw e;
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

    log(`Cancelling turn for session ${sessionId}`);
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

    // Prefer configOptions if available (spec: clients that support
    // configOptions MUST use it exclusively when both are present)
    const modeOpt = session.configOptions?.find(o => o.category === 'mode');
    if (modeOpt) {
      await this.setConfigOption(sessionId, modeOpt.id, modeId);
      return;
    }

    const driver = this.driverFor(session);
    if (!driver) { return; }

    await driver.setMode(sessionId, modeId);

    this.applyCurrentMode(sessionId, modeId);
    this.emit('mode-changed', sessionId, modeId);
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
    await this.setConfigOption(sessionId, modelOpt.id, modelId);
  }

  /**
   * Set a session config option. The agent answers with the full set of
   * config options, which replaces ours so that cascading changes (e.g.
   * changing the model adjusts thought-level options) are reflected.
   */
  async setConfigOption(sessionId: string, configId: string, value: string): Promise<ConfigOption[] | null> {
    const session = this.sessions.get(sessionId);
    if (!session) { return null; }

    const driver = this.driverFor(session);
    if (!driver) { return null; }

    const options = await driver.setConfigOption(sessionId, configId, value);
    this.applyConfigOptions(sessionId, options);
    return options;
  }

  /**
   * Replace a session's configOptions in place. Used by both the setter
   * response and the session update.
   */
  applyConfigOptions(sessionId: string, options: ConfigOption[] | null): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      // Buffer until the session is registered (handles the race where a
      // notification is dispatched before session/new resolves).
      this.pendingConfigOptions.set(sessionId, options ?? []);
      return;
    }
    session.configOptions = options;
  }

  /** Record the session's mode, as set here or switched by the agent itself. */
  applyCurrentMode(sessionId: string, modeId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.modes) {
      session.modes = { ...session.modes, current: modeId };
    }
  }

  /**
   * Replace a session's availableCommands. Buffers the value if the session
   * isn't registered yet (race during creation).
   */
  applyAvailableCommands(sessionId: string, commands: SlashCommand[]): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.pendingAvailableCommands.set(sessionId, commands);
      return;
    }
    session.availableCommands = commands;
  }

  /**
   * Apply a session info update: patches title / updatedAt on
   * the in-memory session and on the persistent history store.
   */
  applySessionInfoUpdate(sessionId: string, update: { title?: string | null; updatedAt?: string | null }): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (update.title === null) {
        delete session.title;
      } else if (typeof update.title === 'string') {
        session.title = update.title;
      }
    } else if (typeof update.title === 'string') {
      // Session not registered yet — buffer for drain.
      this.pendingTitles.set(sessionId, update.title);
    }
    // Mirror onto the history store regardless of whether session is live.
    if (this.historyStore && session) {
      this.historyStore.setTitle(session.agentName, sessionId, update.title);
    }
    this.emit('session-info-changed', sessionId, update);
  }

  /**
   * Record the first user prompt of a session so the history-store tree can
   * use it as a label fallback when no title arrives.
   */
  recordFirstPrompt(sessionId: string, prompt: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || !this.historyStore) { return; }
    this.historyStore.setFirstPromptIfMissing(session.agentName, sessionId, prompt);
  }

  /** Bump a session's `lastActiveAt` in the history store. */
  touchHistory(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) { return; }
    this.historyStore?.touch(session.agentName, sessionId);
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

    // Only a complete list shows which session history entries the agent no longer knows.
    if (this.historyStore && !opts.cursor && !response.nextCursor) {
      this.historyStore.reconcileFromAgent(
        agentName,
        new Set(sessions.map(s => s.sessionId)),
      );
    }
    return response;
  }

  /**
   * Load an existing session, replaying its entire transcript via
   * `session/update` notifications. Heavyweight. Active session is switched
   * to the loaded session on success.
   */
  async loadSession(agentName: string, sessionId: string): Promise<SessionInfo> {
    await this.disconnectOtherAgent(agentName);

    const agent = await this.ensureAgent(agentName);
    if (!this.capabilities.get(agentName)?.load) {
      throw new Error(`Agent "${agentName}" does not support session/load.`);
    }

    this.dropActiveSessionUnless(sessionId);

    const cwd = this.environment.workspaceCwd();
    // Registered and made active before the request, so the transcript the
    // agent replays during the load reaches the webview.
    const session = this.registerSession(agent, sessionId, cwd);
    this.agentSessions.set(agentName, sessionId);
    this.activeSessionId = sessionId;
    // Emit active-session-changed BEFORE session-load-start so the webview
    // first repaints from the new session state, then immediately enters
    // the loading-overlay state.
    this.emit('session-added', sessionId, agentName);
    this.emit('active-session-changed', sessionId);
    this.emit('session-load-start', sessionId, agentName);

    try {
      // The response carries the latest snapshot of the session's state; a v1
      // response has no commands, which only the replayed updates report.
      const state = await agent.driver.loadSession(sessionId, cwd);
      session.modes = state.modes;
      session.configOptions = state.configOptions;
      if (state.commands) {
        session.availableCommands = state.commands;
      }
    } catch (e) {
      this.removeSession(session);
      this.emit('session-load-end', sessionId, agentName, /*ok=*/false);
      this.emit('active-session-changed', null);
      this.forgetIfUnknown(agentName, sessionId, e);
      throw e;
    }

    this.emit('session-load-end', sessionId, agentName, /*ok=*/true);
    this.historyStore?.touch(agentName, sessionId);
    return session;
  }

  /**
   * Resume an existing session; unlike a load, the agent does not replay its transcript.
   */
  async resumeSession(agentName: string, sessionId: string): Promise<SessionInfo> {
    await this.disconnectOtherAgent(agentName);

    const agent = await this.ensureAgent(agentName);
    if (!this.capabilities.get(agentName)?.resume) {
      throw new Error(`Agent "${agentName}" does not support session/resume.`);
    }

    this.dropActiveSessionUnless(sessionId);

    const cwd = this.environment.workspaceCwd();
    let response: SessionState;
    try {
      response = await agent.driver.resumeSession(sessionId, cwd);
    } catch (e) {
      this.forgetIfUnknown(agentName, sessionId, e);
      throw e;
    }

    const sessionInfo = this.registerSession(agent, sessionId, cwd, response);
    this.agentSessions.set(agentName, sessionId);
    this.activeSessionId = sessionId;
    this.emit('session-added', sessionId, agentName);
    this.emit('active-session-changed', sessionId);

    this.historyStore?.touch(agentName, sessionId);
    return sessionInfo;
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
    this.sessions.delete(session.sessionId);
    if (this.agentSessions.get(session.agentName) === session.sessionId) {
      this.agentSessions.delete(session.agentName);
    }
    if (this.activeSessionId === session.sessionId) {
      this.activeSessionId = null;
    }
    this.emit('session-removed', session.sessionId, session.agentName);
  }

  /** Prune a session the agent no longer knows from local history, so it doesn't reappear. */
  private forgetIfUnknown(agentName: string, sessionId: string, e: unknown): void {
    if (e instanceof UnknownSession) {
      this.historyStore?.forget(agentName, sessionId);
    }
  }

  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
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

  getAgentNamesWithSessions(): string[] {
    return Array.from(this.agentSessions.keys());
  }

  dispose(): void {
    for (const agent of this.agents.values()) {
      agent.process.kill();
    }
    this.agents.clear();
    this.sessions.clear();
    this.agentSessions.clear();
  }
}
