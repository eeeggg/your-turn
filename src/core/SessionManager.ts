import { EventEmitter } from 'node:events';

import type {
  ClientConnection,
  PromptResponse,
  InitializeResponse,
  ContentBlock,
  SessionModeState,
  AvailableCommand,
  SessionConfigOption,
  SessionInfo as ProtocolSessionInfo,
  AgentCapabilities,
  AuthMethod,
  ResourceLink,
  NewSessionResponse,
  ListSessionsRequest,
  ListSessionsResponse,
} from '@agentclientprotocol/sdk';
import { methods, RequestError } from '@agentclientprotocol/sdk';

import type { AgentConfigEntry, AgentLauncher, AgentProcess } from './AgentManager';
import type { ConnectionManager } from './ConnectionManager';
import type { SessionHistoryStore } from './SessionHistoryStore';
import { log, logError } from './Log';

/** What sessions need from the workspace the extension runs in. */
export interface SessionEnvironment {
  /** Working directory for agents and their sessions. */
  workspaceCwd(): string;
  agentConfigs(): Record<string, AgentConfigEntry>;
  /** The file to link at the start of each prompt, or undefined when none applies. */
  activeFileLink(): ResourceLink | undefined;
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
  initResponse: InitializeResponse;
  modes: SessionModeState | null;
  /**
   * Generic session config options (ACP "Session Config Options" — supersedes
   * `modes`, and is the only source of model selection). `null` means the
   * agent did not provide this field.
   * Per spec, when both `configOptions` and `modes` are present, clients
   * should use `configOptions` exclusively.
   */
  configOptions: SessionConfigOption[] | null;
  availableCommands: AvailableCommand[];
  /** Latest title supplied via `session_info_update`, if any. */
  title?: string;
}

/**
 * Discovery flags for an agent, derived from `initialize.agentCapabilities`.
 * Populated when the agent is first launched.
 */
export interface AgentCapabilitySummary {
  list: boolean;
  load: boolean;
  resume: boolean;
}

/** An agent process this manager launched, and its initialized ACP connection. */
interface RunningAgent {
  name: string;
  process: AgentProcess;
  connection: ClientConnection;
  initResponse: InitializeResponse;
}

interface SessionState {
  modes?: SessionModeState | null | undefined;
  configOptions?: SessionConfigOption[] | null | undefined;
}

function summarizeCapabilities(caps: AgentCapabilities | undefined): AgentCapabilitySummary {
  return {
    list: !!caps?.sessionCapabilities?.list,
    load: !!caps?.loadSession,
    resume: !!caps?.sessionCapabilities?.resume,
  };
}

/** True if a thrown error denotes ACP "auth required" (-32000). */
function isAuthRequiredError(e: any): boolean {
  return (e instanceof RequestError && e.code === -32000)
    || (e?.code === -32000)
    || (typeof e?.message === 'string' && /auth.?required/i.test(e.message));
}

/** True if the agent rejected a session because it no longer knows it. */
function isUnknownSessionError(e: any): boolean {
  return /not found|no such|unknown session/i.test(String(e?.message || ''));
}

/**
 * Manages agents, their connections, and their sessions.
 *
 * One session is active at a time; connecting to, loading, or resuming with
 * another agent disconnects the agent that owned the previous one. At most one
 * agent process runs per agent name; it is launched on first use, either for a
 * session or to list an agent's sessions, and reused after that.
 */
export class SessionManager extends EventEmitter {
  /** Running agents by agent name. */
  private agents: Map<string, RunningAgent> = new Map();
  /** Launches in progress by agent name, so concurrent callers share one process. */
  private launching: Map<string, Promise<RunningAgent>> = new Map();

  private sessions: Map<string, SessionInfo> = new Map();
  private activeSessionId: string | null = null;

  /** Maps agentName → sessionId for the one-session-per-agent model. */
  private agentSessions: Map<string, string> = new Map();

  /**
   * Buffers session/update payloads that arrive before the corresponding
   * session is registered in `this.sessions`. Drained when the session is
   * registered. This closes a microtask race between the resolution of
   * `newSession` and the SDK's async notification dispatch.
   */
  private pendingAvailableCommands: Map<string, AvailableCommand[]> = new Map();
  private pendingConfigOptions: Map<string, SessionConfigOption[]> = new Map();
  private pendingTitles: Map<string, string> = new Map();

  /**
   * Cache of `initialize.agentCapabilities` per agent so the tree can render
   * without paying the connect cost on every render.
   */
  private capabilities: Map<string, AgentCapabilitySummary> = new Map();

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
  getCachedCapabilities(agentName: string): AgentCapabilitySummary | undefined {
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
   * fresh agent process, and clear the chat view.
   */
  async newSession(): Promise<SessionInfo | null> {
    const activeSession = this.getActiveSession();
    if (!activeSession) {
      return null;
    }

    const agentName = activeSession.agentName;
    await this.disconnectAgent(agentName);
    this.emit('clear-chat');
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
   * Launch and initialize an agent without creating a session, so the tree
   * can read its capabilities or list its sessions. Reuses the agent's
   * process if it is already running.
   *
   * This never disconnects the agent that owns the active session.
   */
  async ensureConnected(agentName: string): Promise<void> {
    await this.ensureAgent(agentName);
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

    const agentProcess = this.launcher.launch(agentName, config, this.environment.workspaceCwd(), {
      error: (error) => {
        logError(`Agent ${agentName} error`, error);
        this.emit('agent-error', agentProcess.id, error);
      },
      exit: (code) => this.handleAgentExit(agentName, agentProcess, code),
    });

    let connection: ClientConnection;
    let initResponse: InitializeResponse;
    try {
      ({ connection, initResponse } = await this.connectionManager.connect(agentName, agentProcess));
    } catch (e) {
      agentProcess.kill();
      throw e;
    }

    const agent: RunningAgent = { name: agentName, process: agentProcess, connection, initResponse };
    this.agents.set(agentName, agent);
    this.capabilities.set(agentName, summarizeCapabilities(initResponse.agentCapabilities));
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
    log(`Agent ${agentName} closed with code ${code}`);
    if (this.agents.get(agentName)?.process === agentProcess) {
      this.agents.delete(agentName);
    }

    // Only the session running on this process goes; a newer one for the same agent stays.
    const session = this.sessionOf(agentName);
    if (session && session.agentId === agentProcess.id) {
      this.removeSession(session);
      this.emit('active-session-changed', null);
    }
    this.emit('agent-closed', agentProcess.id, code);
  }

  /** Create the ACP session, authenticating first if the agent requires it. */
  private async createAcpSession(agent: RunningAgent, cwd: string): Promise<SessionInfo> {
    const requestSession = () => agent.connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] });

    let response: NewSessionResponse;
    try {
      response = await requestSession();
    } catch (e) {
      if (!isAuthRequiredError(e)) {
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
  private registerSession(agent: RunningAgent, sessionId: string, cwd: string, state: SessionState = {}): SessionInfo {
    const sessionInfo: SessionInfo = {
      sessionId,
      agentId: agent.process.id,
      agentName: agent.name,
      agentDisplayName: agent.initResponse.agentInfo?.title || agent.initResponse.agentInfo?.name || agent.name,
      cwd,
      createdAt: new Date().toISOString(),
      initResponse: agent.initResponse,
      modes: state.modes ?? null,
      configOptions: state.configOptions ?? null,
      availableCommands: [],
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
    const authMethods = agent.initResponse.authMethods;
    if (!authMethods || authMethods.length === 0) {
      this.stopAgent(agent);
      throw new Error(
        `Agent "${agent.name}" requires authentication but did not advertise any auth methods.`,
      );
    }

    log(`Agent requires authentication. Methods: ${authMethods.map(m => m.name).join(', ')}`);

    const selectedMethod = await this.authPrompt.chooseAuthMethod(agent.name, authMethods);
    if (!selectedMethod) {
      this.stopAgent(agent);
      throw new Error('Authentication cancelled by user.');
    }

    try {
      log(`Authenticating with method: ${selectedMethod.name} (${selectedMethod.id})`);
      await agent.connection.agent.request(methods.agent.authenticate, { methodId: selectedMethod.id });
      log('Authentication successful');
    } catch (authErr: any) {
      logError('Authentication failed', authErr);
      this.stopAgent(agent);
      throw new Error(`Authentication failed: ${authErr.message}`);
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

  /** The connection a session runs on, or undefined once its agent has stopped. */
  private connectionFor(session: SessionInfo): ClientConnection | undefined {
    return this.agents.get(session.agentName)?.connection;
  }

  /**
   * Send a prompt to the active session.
   */
  async sendPrompt(sessionId: string, text: string): Promise<PromptResponse> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const connection = this.connectionFor(session);
    if (!connection) {
      throw new Error(`No connection for agent: ${session.agentName}`);
    }

    log(`sendPrompt: session=${sessionId}, text="${text.substring(0, 50)}..."`);

    const prompt: ContentBlock[] = [
      { type: 'text', text },
    ];

    const fileLink = this.environment.activeFileLink();
    if (fileLink) {
      log(`sendPrompt: attaching active file context: ${fileLink.name}`);
      prompt.unshift({ type: 'resource_link', ...fileLink });
    }

    const response = await connection.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt,
    });

    log(`Prompt response: stopReason=${response.stopReason}`);
    return response;
  }

  /**
   * Cancel an active prompt turn.
   */
  async cancelTurn(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) { return; }

    const connection = this.connectionFor(session);
    if (!connection) { return; }

    log(`Cancelling turn for session ${sessionId}`);
    await connection.agent.notify(methods.agent.session.cancel, { sessionId });
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

    const connection = this.connectionFor(session);
    if (!connection) { return; }

    await connection.agent.request(methods.agent.session.setMode, { sessionId, modeId });

    // Update local state
    if (session.modes) {
      session.modes.currentModeId = modeId;
    }
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
   * Set a generic session config option (ACP "Session Config Options").
   * The agent's response contains the full configOptions array — we
   * replace our local copy so that cascading changes (e.g. changing the
   * model adjusts thought-level options) are reflected.
   */
  async setConfigOption(sessionId: string, configId: string, value: string): Promise<SessionConfigOption[] | null> {
    const session = this.sessions.get(sessionId);
    if (!session) { return null; }

    const connection = this.connectionFor(session);
    if (!connection) { return null; }

    const response = await connection.agent.request(methods.agent.session.setConfigOption, {
      sessionId,
      configId,
      value,
    });

    // The SDK's validation lets `configOptions: null` through despite its types.
    const options = response.configOptions ?? null;
    this.applyConfigOptions(sessionId, options);
    return options;
  }

  /**
   * Replace a session's configOptions in place. Used by both the setter
   * response and the `config_option_update` notification.
   */
  applyConfigOptions(sessionId: string, options: SessionConfigOption[] | null): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      // Buffer until the session is registered (handles the race where a
      // notification is dispatched before session/new resolves).
      this.pendingConfigOptions.set(sessionId, options ?? []);
      return;
    }
    session.configOptions = options ?? null;
  }

  /**
   * Replace a session's availableCommands. Buffers the value if the session
   * isn't registered yet (race during creation).
   */
  applyAvailableCommands(sessionId: string, commands: AvailableCommand[]): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.pendingAvailableCommands.set(sessionId, commands);
      return;
    }
    session.availableCommands = commands;
  }

  /**
   * Apply a `session_info_update` notification: patches title / updatedAt on
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
   * List sessions known to an agent (ACP `session/list`).
   * Throws if the agent doesn't advertise the capability.
   */
  async listSessions(agentName: string, opts: { cwd?: string | undefined; cursor?: string | undefined } = {}): Promise<{ sessions: ProtocolSessionInfo[]; nextCursor?: string }> {
    const agent = await this.ensureAgent(agentName);
    if (!this.capabilities.get(agentName)?.list) {
      throw new Error(`Agent "${agentName}" does not support session/list.`);
    }

    const params: ListSessionsRequest = {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.cursor ? { cursor: opts.cursor } : {}),
    };
    const requestList = () => agent.connection.agent.request(methods.agent.session.list, params);

    let response: ListSessionsResponse;
    try {
      response = await requestList();
    } catch (e) {
      if (!isAuthRequiredError(e)) {
        throw e;
      }
      await this.runAuthFlow(agent);
      response = await requestList();
    }

    const sessions = response.sessions;
    // Reconcile the history store — drop any locally-cached entries that
    // the agent no longer knows about.
    if (this.historyStore && !opts.cursor) {
      this.historyStore.reconcileFromAgent(
        agentName,
        new Set(sessions.map(s => s.sessionId)),
      );
    }
    return { sessions, ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}) };
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
      const response = await agent.connection.agent.request(methods.agent.session.load, {
        sessionId,
        cwd,
        mcpServers: [],
      });
      // The response carries the latest modes/configOptions snapshot.
      session.modes = response.modes ?? null;
      session.configOptions = response.configOptions ?? null;
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
    let response;
    try {
      response = await agent.connection.agent.request(methods.agent.session.resume, {
        sessionId,
        cwd,
        mcpServers: [],
      });
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
    if (isUnknownSessionError(e)) {
      this.historyStore?.forget(agentName, sessionId);
    }
  }

  // --- Getters ---

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

  // --- Cleanup ---

  dispose(): void {
    for (const agent of this.agents.values()) {
      agent.process.kill();
    }
    this.agents.clear();
    this.sessions.clear();
    this.agentSessions.clear();
  }
}
