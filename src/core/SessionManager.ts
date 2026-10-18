import { EventEmitter } from 'node:events';

import type {
  NewSessionResponse,
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
} from '@agentclientprotocol/sdk';
import { methods, RequestError } from '@agentclientprotocol/sdk';

import { AgentManager, type AgentConfigEntry } from './AgentManager';
import { ConnectionManager, ConnectionInfo } from './ConnectionManager';
import { SessionHistoryStore } from './SessionHistoryStore';
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
 * Populated lazily when {@link SessionManager.ensureConnected} runs.
 */
export interface AgentCapabilitySummary {
  list: boolean;
  load: boolean;
  resume: boolean;
}

/**
 * Why an agent expansion failed (used to surface a useful tree placeholder).
 */
export type AgentConnectionError =
  | { kind: 'auth-cancelled' }
  | { kind: 'connect-failed'; message: string };

/**
 * Manages agents, their connections, and their sessions.
 *
 * One session is active at a time; connecting to, loading, or resuming with
 * another agent disconnects the agent that owned the previous one.
 */
export class SessionManager extends EventEmitter {
  private sessions: Map<string, SessionInfo> = new Map();
  private activeSessionId: string | null = null;

  /** Maps agentName → activeSessionId for the one-session-per-agent model. */
  private agentSessions: Map<string, string> = new Map();

  /**
   * Buffers session/update payloads that arrive before the corresponding
   * session is registered in `this.sessions`. Drained by createAcpSession
   * once the session is set up. This closes a microtask race between the
   * resolution of `newSession` and the SDK's async notification dispatch.
   */
  private pendingAvailableCommands: Map<string, AvailableCommand[]> = new Map();
  private pendingConfigOptions: Map<string, SessionConfigOption[]> = new Map();
  private pendingTitles: Map<string, string> = new Map();

  /**
   * Cache of `initialize.agentCapabilities` per agent so the tree can render
   * without paying the connect cost on every render.
   */
  private capabilities: Map<string, AgentCapabilitySummary> = new Map();

  /** Set of session IDs that are currently being replayed via `session/load`. */
  private loadingSessionIds: Set<string> = new Set();

  /** Client-side session history (optional — only used for tier-2 tree). */
  private historyStore: SessionHistoryStore | null = null;

  constructor(
    private readonly agentManager: AgentManager,
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

  /** Public accessor for downstream UI. */
  getHistoryStore(): SessionHistoryStore | null {
    return this.historyStore;
  }

  /**
   * Read cached capabilities for an agent. Returns `undefined` if the agent
   * has never been initialized — callers can call {@link ensureConnected}
   * first to populate.
   */
  getCachedCapabilities(agentName: string): AgentCapabilitySummary | undefined {
    return this.capabilities.get(agentName);
  }

  private summarizeCapabilities(caps: AgentCapabilities | undefined | null): AgentCapabilitySummary {
    const sc: any = (caps as any)?.sessionCapabilities;
    return {
      list: !!sc?.list,
      load: !!(caps as any)?.loadSession,
      resume: !!sc?.resume,
    };
  }

  /**
   * Connect to an agent and start chatting.
   * Only one agent can be connected at a time — automatically disconnects
   * any previously connected agent.
   * Internally creates a session via ACP protocol.
   */
  async connectToAgent(agentName: string): Promise<SessionInfo> {
    // If we already have a live session with this agent, reuse it
    const existingSessionId = this.agentSessions.get(agentName);
    if (existingSessionId && this.sessions.has(existingSessionId)) {
      this.activeSessionId = existingSessionId;
      this.emit('active-session-changed', existingSessionId);
      return this.sessions.get(existingSessionId)!;
    }

    // Disconnect any currently connected agent first (single-agent model)
    const currentAgent = this.getActiveAgentName();
    if (currentAgent) {
      await this.disconnectAgent(currentAgent);
    }

    const configs = this.environment.agentConfigs();
    const config = configs[agentName];
    if (!config) {
      throw new Error(`Unknown agent: ${agentName}. Available: ${Object.keys(configs).join(', ')}`);
    }

    log(`SessionManager: connecting to agent "${agentName}"`);

    const workspaceCwd = this.environment.workspaceCwd();

    // Spawn the agent process in workspace cwd
    const agentInstance = this.agentManager.spawnAgent(agentName, config, workspaceCwd);
    const agentId = agentInstance.id;

    // Listen for agent errors/close
    this.agentManager.on('agent-error', (evt: { agentId: string; error: Error }) => {
      if (evt.agentId === agentId) {
        logError(`Agent ${agentName} error`, evt.error);
        this.emit('agent-error', agentId, evt.error);
      }
    });

    this.agentManager.on('agent-closed', (evt: { agentId: string; code: number | null }) => {
      if (evt.agentId === agentId) {
        log(`Agent ${agentName} closed with code ${evt.code}`);
        // Clean up the session for this agent
        const sessionId = this.agentSessions.get(agentName);
        if (sessionId) {
          this.sessions.delete(sessionId);
          this.agentSessions.delete(agentName);
          if (this.activeSessionId === sessionId) {
            this.activeSessionId = null;
          }
          this.emit('agent-disconnected', agentName);
          this.emit('active-session-changed', null);
        }
        this.emit('agent-closed', agentId, evt.code);
      }
    });

    // Connect and initialize
    const agentProcess = this.agentManager.getAgent(agentId);
    if (!agentProcess) {
      throw new Error('Agent process not found after spawn');
    }

    let connInfo: ConnectionInfo;
    try {
      connInfo = await this.connectionManager.connect(agentId, agentProcess.process);
    } catch (e) {
      this.agentManager.killAgent(agentId);
      throw e;
    }

    // Create ACP session (with auth handling). The session is already
    // registered in `this.sessions` by createAcpSession so that any
    // notifications arriving during/after newSession can be persisted.
    const sessionInfo = await this.createAcpSession(agentName, agentId, connInfo, workspaceCwd);

    this.agentSessions.set(agentName, sessionInfo.sessionId);
    this.activeSessionId = sessionInfo.sessionId;

    this.emit('agent-connected', agentName);
    this.emit('active-session-changed', sessionInfo.sessionId);

    log(`Connected to agent ${agentName}, session ${sessionInfo.sessionId}`);
    return sessionInfo;
  }

  /**
   * Start a new session with the currently connected agent.
   * Disconnects current session, reconnects, and signals chat to clear.
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

  /**
   * Disconnect from an agent: kill process and clean up.
   */
  async disconnectAgent(agentName: string): Promise<void> {
    const sessionId = this.agentSessions.get(agentName);
    if (!sessionId) { return; }

    const session = this.sessions.get(sessionId);
    if (!session) { return; }

    log(`Disconnecting agent ${agentName}`);

    this.agentManager.killAgent(session.agentId);
    this.connectionManager.removeConnection(session.agentId);
    this.sessions.delete(sessionId);
    this.agentSessions.delete(agentName);

    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
    }

    this.emit('agent-disconnected', agentName);
    this.emit('active-session-changed', null);
  }

  /**
   * Internal: create the ACP session with auth handling.
   */
  private async createAcpSession(
    agentName: string,
    agentId: string,
    connInfo: ConnectionInfo,
    cwd: string,
  ): Promise<SessionInfo> {
    let sessionResponse: NewSessionResponse;
    try {
      sessionResponse = await connInfo.connection.agent.request(methods.agent.session.new, {
        cwd,
        mcpServers: [],
      });
    } catch (e: any) {
      if (!this.isAuthRequiredError(e)) {
        logError('Failed to create session', e);
        this.agentManager.killAgent(agentId);
        throw e;
      }
      // Auth required — interactively authenticate, then retry.
      await this.runAuthFlow(agentName, agentId, connInfo);
      try {
        sessionResponse = await connInfo.connection.agent.request(methods.agent.session.new, {
          cwd,
          mcpServers: [],
        });
      } catch (retryErr) {
        logError('Failed to create session after authentication', retryErr);
        this.agentManager.killAgent(agentId);
        throw retryErr;
      }
    }

    const sessionInfo: SessionInfo = {
      sessionId: sessionResponse.sessionId,
      agentId,
      agentName,
      agentDisplayName: connInfo.initResponse.agentInfo?.title ||
        connInfo.initResponse.agentInfo?.name ||
        agentName,
      cwd,
      createdAt: new Date().toISOString(),
      initResponse: connInfo.initResponse,
      modes: sessionResponse.modes ?? null,
      configOptions: (sessionResponse as any).configOptions ?? null,
      availableCommands: [],
    };

    // Register the session into the map *synchronously* with newSession's
    // resolution so that any session/update notifications dispatched by the
    // agent (e.g. available_commands_update) can be persisted onto it. If
    // we waited until connectToAgent's continuation, notifications would
    // race and be dropped by handleSessionUpdate.
    this.sessions.set(sessionInfo.sessionId, sessionInfo);
    this.drainPending(sessionInfo);

    // Capture in the local history store so it appears in the tree.
    this.historyStore?.upsertNew(agentName, cwd, sessionInfo.sessionId);

    return sessionInfo;
  }

  /** Returns true if a thrown error denotes ACP "auth required" (-32000). */
  private isAuthRequiredError(e: any): boolean {
    return (e instanceof RequestError && e.code === -32000)
      || (e?.code === -32000)
      || (typeof e?.message === 'string' && /auth.?required/i.test(e.message));
  }

  /**
   * Run the interactive auth flow against an already-initialized connection.
   * Throws if the user cancels or auth fails — caller is expected to clean
   * up the agent process.
   */
  private async runAuthFlow(
    agentName: string,
    agentId: string,
    connInfo: ConnectionInfo,
  ): Promise<void> {
    const authMethods = connInfo.initResponse.authMethods;
    if (!authMethods || authMethods.length === 0) {
      this.agentManager.killAgent(agentId);
      throw new Error(
        `Agent "${agentName}" requires authentication but did not advertise any auth methods.`,
      );
    }

    log(`Agent requires authentication. Methods: ${authMethods.map(m => m.name).join(', ')}`);

    const selectedMethod = await this.authPrompt.chooseAuthMethod(agentName, authMethods);
    if (!selectedMethod) {
      this.agentManager.killAgent(agentId);
      throw new Error('Authentication cancelled by user.');
    }

    try {
      log(`Authenticating with method: ${selectedMethod.name} (${selectedMethod.id})`);
      await connInfo.connection.agent.request(methods.agent.authenticate, { methodId: selectedMethod.id });
      log('Authentication successful');
    } catch (authErr: any) {
      logError('Authentication failed', authErr);
      this.agentManager.killAgent(agentId);
      throw new Error(`Authentication failed: ${authErr.message}`);
    }
  }

  /**
   * Drain any buffered state captured before the session was registered.
   * Used by all session-registration paths (new / load / resume).
   */
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

  /**
   * Send a prompt to the active session.
   */
  async sendPrompt(sessionId: string, text: string): Promise<PromptResponse> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const connInfo = this.connectionManager.getConnection(session.agentId);
    if (!connInfo) {
      throw new Error(`No connection for agent: ${session.agentId}`);
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

    const response = await connInfo.connection.agent.request(methods.agent.session.prompt, {
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

    const connInfo = this.connectionManager.getConnection(session.agentId);
    if (!connInfo) { return; }

    log(`Cancelling turn for session ${sessionId}`);
    await connInfo.connection.agent.notify(methods.agent.session.cancel, { sessionId });
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
    if (session.configOptions && session.configOptions.length > 0) {
      const modeOpt = session.configOptions.find(o => o.category === 'mode');
      if (modeOpt) {
        await this.setConfigOption(sessionId, modeOpt.id, modeId);
        return;
      }
    }

    const connInfo = this.connectionManager.getConnection(session.agentId);
    if (!connInfo) { return; }

    await connInfo.connection.agent.request(methods.agent.session.setMode, { sessionId, modeId });

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

    const connInfo = this.connectionManager.getConnection(session.agentId);
    if (!connInfo) { return null; }

    const response = await connInfo.connection.agent.request(methods.agent.session.setConfigOption, {
      sessionId,
      configId,
      value,
    });

    const options = (response as any)?.configOptions ?? null;
    this.applyConfigOptions(sessionId, options);
    return options;
  }

  /**
   * Replace a session's configOptions in place and notify listeners.
   * Used by both the setter response and the `config_option_update`
   * push-notification handler.
   */
  applyConfigOptions(sessionId: string, options: SessionConfigOption[] | null): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      // Buffer until the session is registered (handles the race where a
      // notification is dispatched before createAcpSession finishes).
      this.pendingConfigOptions.set(sessionId, options ?? []);
      return;
    }
    session.configOptions = options ?? null;
    this.emit('config-options-changed', sessionId, session.configOptions);
  }

  /**
   * Replace a session's availableCommands and notify listeners. Buffers
   * the value if the session isn't registered yet (race during creation).
   */
  applyAvailableCommands(sessionId: string, commands: AvailableCommand[]): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.pendingAvailableCommands.set(sessionId, commands);
      return;
    }
    session.availableCommands = commands;
    this.emit('available-commands-changed', sessionId, commands);
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

  // --- Connection lifecycle (no session) ---

  /**
   * Spawn + initialize + (optionally authenticate) an agent without creating
   * a session. Caches the capability summary. Idempotent.
   *
   * NOTE: this never disconnects the currently-active agent — it is safe to
   * call from the tree view to probe capabilities or list sessions while
   * the user is chatting with a different agent. Callers that want to
   * switch the active session (e.g. loadSession) handle the active-agent
   * teardown themselves.
   */
  async ensureConnected(agentName: string): Promise<ConnectionInfo> {
    // If we already have a live session with this agent, reuse its connection.
    const existingSessionId = this.agentSessions.get(agentName);
    if (existingSessionId) {
      const existing = this.sessions.get(existingSessionId);
      if (existing) {
        const conn = this.connectionManager.getConnection(existing.agentId);
        if (conn) {
          this.capabilities.set(agentName, this.summarizeCapabilities(conn.initResponse.agentCapabilities));
          return conn;
        }
      }
    }

    // If the agent process is already spawned (e.g. from a previous probe),
    // reuse it instead of spawning a new one.
    for (const instance of this.agentManager.getRunningAgents()) {
      if (instance.name === agentName) {
        const conn = this.connectionManager.getConnection(instance.id);
        if (conn) {
          this.capabilities.set(agentName, this.summarizeCapabilities(conn.initResponse.agentCapabilities));
          return conn;
        }
      }
    }

    const configs = this.environment.agentConfigs();
    const config = configs[agentName];
    if (!config) {
      throw new Error(`Unknown agent: ${agentName}.`);
    }

    const workspaceCwd = this.environment.workspaceCwd();
    const agentInstance = this.agentManager.spawnAgent(agentName, config, workspaceCwd);
    const agentId = agentInstance.id;

    const agentProcess = this.agentManager.getAgent(agentId);
    if (!agentProcess) {
      throw new Error('Agent process not found after spawn');
    }

    let connInfo: ConnectionInfo;
    try {
      connInfo = await this.connectionManager.connect(agentId, agentProcess.process);
    } catch (e) {
      this.agentManager.killAgent(agentId);
      throw e;
    }

    this.capabilities.set(agentName, this.summarizeCapabilities(connInfo.initResponse.agentCapabilities));
    return connInfo;
  }

  /**
   * List sessions known to an agent (ACP `session/list`).
   * Throws if the agent doesn't advertise the capability.
   */
  async listSessions(agentName: string, opts: { cwd?: string | undefined; cursor?: string | undefined } = {}): Promise<{ sessions: ProtocolSessionInfo[]; nextCursor?: string }> {
    const conn = await this.ensureConnected(agentName);
    const caps = this.capabilities.get(agentName);
    if (!caps?.list) {
      throw new Error(`Agent "${agentName}" does not support session/list.`);
    }

    const params: any = {};
    if (opts.cwd) { params.cwd = opts.cwd; }
    if (opts.cursor) { params.cursor = opts.cursor; }

    let response: any;
    try {
      response = await conn.connection.agent.request(methods.agent.session.list, params);
    } catch (e: any) {
      if (this.isAuthRequiredError(e)) {
        // Auth then retry.
        const agentInfo = this.findAgentIdForConnection(conn);
        if (agentInfo) {
          await this.runAuthFlow(agentName, agentInfo, conn);
          response = await conn.connection.agent.request(methods.agent.session.list, params);
        } else {
          throw e;
        }
      } else {
        throw e;
      }
    }

    const sessions: ProtocolSessionInfo[] = response?.sessions ?? [];
    // Reconcile the history store — drop any locally-cached entries that
    // the agent no longer knows about.
    if (this.historyStore && !opts.cursor) {
      this.historyStore.reconcileFromAgent(
        agentName,
        new Set(sessions.map(s => s.sessionId)),
      );
    }
    return { sessions, nextCursor: response?.nextCursor ?? undefined };
  }

  /**
   * Load an existing session, replaying its entire transcript via
   * `session/update` notifications. Heavyweight. Active session is switched
   * to the loaded session on success.
   */
  async loadSession(agentName: string, sessionId: string): Promise<SessionInfo> {
    // Honor the single-active-session model: if a different agent currently
    // owns the active session, disconnect it before opening this one.
    const currentAgent = this.getActiveAgentName();
    if (currentAgent && currentAgent !== agentName) {
      await this.disconnectAgent(currentAgent);
    }

    const conn = await this.ensureConnected(agentName);
    const caps = this.capabilities.get(agentName);
    if (!caps?.load) {
      throw new Error(`Agent "${agentName}" does not support session/load.`);
    }

    // If the same agent has a different active session, clear it so the
    // load can take over as the new active session.
    const previouslyActive = this.activeSessionId;
    if (previouslyActive && previouslyActive !== sessionId) {
      const prevSession = this.sessions.get(previouslyActive);
      if (prevSession) {
        this.agentSessions.delete(prevSession.agentName);
      }
      this.sessions.delete(previouslyActive);
      this.activeSessionId = null;
    }

    const cwd = this.environment.workspaceCwd();
    const agentId = this.findAgentIdForConnection(conn);
    if (!agentId) {
      throw new Error(`Unable to locate agent process for "${agentName}".`);
    }

    // Pre-register a placeholder so notifications that arrive during the
    // replay can be associated with the session (closing the same race the
    // pending* buffers handle for session/new).
    const placeholder: SessionInfo = {
      sessionId,
      agentId,
      agentName,
      agentDisplayName: conn.initResponse.agentInfo?.title
        || conn.initResponse.agentInfo?.name
        || agentName,
      cwd,
      createdAt: new Date().toISOString(),
      initResponse: conn.initResponse,
      modes: null,
      configOptions: null,
      availableCommands: [],
    };
    this.sessions.set(sessionId, placeholder);
    this.drainPending(placeholder);
    this.loadingSessionIds.add(sessionId);
    // Mark this session as active up front so handleSessionUpdate forwards
    // the replayed chunks to the webview during the load. Without this,
    // updates arrive before the activeSessionId is set and are dropped.
    this.agentSessions.set(agentName, sessionId);
    this.activeSessionId = sessionId;
    // Emit active-session-changed BEFORE session-load-start so the webview
    // first repaints from the new session state, then immediately enters
    // the loading-overlay state.
    this.emit('agent-connected', agentName);
    this.emit('active-session-changed', sessionId);
    this.emit('session-load-start', sessionId, agentName);

    try {
      const response = await conn.connection.agent.request(methods.agent.session.load, {
        sessionId,
        cwd,
        mcpServers: [],
      });
      // The response carries the latest modes/configOptions snapshot.
      placeholder.modes = (response as any).modes ?? null;
      placeholder.configOptions = (response as any).configOptions ?? null;
    } catch (e: any) {
      this.loadingSessionIds.delete(sessionId);
      this.sessions.delete(sessionId);
      this.agentSessions.delete(agentName);
      if (this.activeSessionId === sessionId) { this.activeSessionId = null; }
      this.emit('session-load-end', sessionId, agentName, /*ok=*/false);
      this.emit('active-session-changed', null);

      // If the agent says the session is gone, prune from local history so
      // it doesn't reappear on next refresh.
      const msg = String(e?.message || '');
      if (/not found|no such|unknown session/i.test(msg)) {
        this.historyStore?.forget(agentName, sessionId);
      }
      throw e;
    }

    this.loadingSessionIds.delete(sessionId);
    this.emit('session-load-end', sessionId, agentName, /*ok=*/true);

    // Touch history-store activity timestamp.
    this.historyStore?.touch(agentName, sessionId);
    return placeholder;
  }

  /**
   * Resume an existing session without replaying history (light path).
   */
  async resumeSession(agentName: string, sessionId: string): Promise<SessionInfo> {
    const currentAgent = this.getActiveAgentName();
    if (currentAgent && currentAgent !== agentName) {
      await this.disconnectAgent(currentAgent);
    }

    const conn = await this.ensureConnected(agentName);
    const caps = this.capabilities.get(agentName);
    if (!caps?.resume) {
      throw new Error(`Agent "${agentName}" does not support session/resume.`);
    }

    // If the same agent has a different active session, clear it.
    const previouslyActive = this.activeSessionId;
    if (previouslyActive && previouslyActive !== sessionId) {
      const prevSession = this.sessions.get(previouslyActive);
      if (prevSession) {
        this.agentSessions.delete(prevSession.agentName);
      }
      this.sessions.delete(previouslyActive);
      this.activeSessionId = null;
    }

    const cwd = this.environment.workspaceCwd();
    const agentId = this.findAgentIdForConnection(conn);
    if (!agentId) {
      throw new Error(`Unable to locate agent process for "${agentName}".`);
    }

    let response: any;
    try {
      response = await conn.connection.agent.request(methods.agent.session.resume, {
        sessionId,
        cwd,
        mcpServers: [],
      });
    } catch (e: any) {
      const msg = String(e?.message || '');
      if (/not found|no such|unknown session/i.test(msg)) {
        this.historyStore?.forget(agentName, sessionId);
      }
      throw e;
    }

    const sessionInfo: SessionInfo = {
      sessionId,
      agentId,
      agentName,
      agentDisplayName: conn.initResponse.agentInfo?.title
        || conn.initResponse.agentInfo?.name
        || agentName,
      cwd,
      createdAt: new Date().toISOString(),
      initResponse: conn.initResponse,
      modes: response?.modes ?? null,
      configOptions: response?.configOptions ?? null,
      availableCommands: [],
    };
    this.sessions.set(sessionId, sessionInfo);
    this.drainPending(sessionInfo);
    this.agentSessions.set(agentName, sessionId);
    this.activeSessionId = sessionId;
    this.emit('agent-connected', agentName);
    this.emit('active-session-changed', sessionId);

    this.historyStore?.touch(agentName, sessionId);
    return sessionInfo;
  }

  /** Return true if a session is currently mid-replay via `session/load`. */
  isLoading(sessionId: string): boolean {
    return this.loadingSessionIds.has(sessionId);
  }

  /** Helper: reverse-lookup agentId for a known ConnectionInfo. */
  private findAgentIdForConnection(conn: ConnectionInfo): string | undefined {
    for (const session of this.sessions.values()) {
      const c = this.connectionManager.getConnection(session.agentId);
      if (c === conn) { return session.agentId; }
    }
    // Connection without a session — search agentManager's spawned set.
    for (const instance of this.agentManager.getRunningAgents()) {
      if (this.connectionManager.getConnection(instance.id) === conn) {
        return instance.id;
      }
    }
    return undefined;
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

  /** Check if a specific agent is currently connected. */
  isAgentConnected(agentName: string): boolean {
    return this.agentSessions.has(agentName);
  }

  /** Get all connected agent names. */
  getConnectedAgentNames(): string[] {
    return Array.from(this.agentSessions.keys());
  }

  getConnectionForSession(sessionId: string): ConnectionInfo | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) { return undefined; }
    return this.connectionManager.getConnection(session.agentId);
  }

  // --- Cleanup ---

  dispose(): void {
    this.agentManager.killAll();
    this.connectionManager.dispose();
    this.sessions.clear();
    this.agentSessions.clear();
  }
}
