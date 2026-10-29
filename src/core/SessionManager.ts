import { EventEmitter } from 'node:events';

import {
  AuthRequired,
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
import { Writes, type SessionAddress, type SessionReferences, type WorkspaceState, type WorkspaceTarget } from './PersistedState';
import { logDebug, logError, logInfo, messageOf } from './Log';

/** What sessions need from the workspace the extension runs in. */
export interface SessionEnvironment {
  /** Working directory for agents and their sessions. */
  workspaceCwd(): string;
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

/** The events a {@link SessionManager} emits, with the arguments each passes its listeners. */
export interface SessionManagerEvents {
  'session-added': [sessionId: string, agentName: string];
  'session-removed': [sessionId: string, agentName: string];
  'active-session-changed': [sessionId: string | null];
  'clear-transcript': [];
  'mode-changed': [sessionId: string, modeId: string];
  'session-info-changed': [sessionId: string, update: { title?: string | null; updatedAt?: string | null }];
  'turn-ended': [sessionId: string, agentName: string];
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
  /** Ownership outlives initialization and removal from the reusable agents. */
  private processes = new Map<AgentProcess, Promise<void>>();
  private disposed = false;
  private disposal: Promise<void> | undefined;
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

    logDebug('Connecting to agent', { agentName });

    const agent = await this.ensureAgent(agentName);
    const sessionInfo = await this.createAcpSession(agent, this.environment.workspaceCwd());

    this.agentSessions.set(agentName, sessionInfo.sessionId);
    this.activeSessionId = sessionInfo.sessionId;

    this.emit('session-added', sessionInfo.sessionId, agentName);
    this.emit('active-session-changed', sessionInfo.sessionId);

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
        try {
          this.handleAgentExit(agentName, agentProcess, code);
        } finally {
          this.processes.delete(agentProcess);
          exitHandled();
        }
      },
    });
    this.processes.set(agentProcess, exited);

    let driver: AcpDriver;
    try {
      driver = await this.connectionManager.connect(agentName, agentProcess);
      if (this.disposed) {
        throw new Error('Session manager is disposed.');
      }
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
    // Still registered means nothing here stopped it.
    const unexpected = this.agents.get(agentName)?.process === agentProcess;
    if (unexpected) {
      logError('Agent exited unexpectedly', undefined, { agentName, exitCode: code });
    } else {
      logDebug('Agent exited', { agentName, exitCode: code });
    }
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
    this.recordOpened(sessionInfo);
    return sessionInfo;
  }

  /**
   * Register a session as soon as the agent names it, so session/update
   * notifications that arrive before the caller's continuation runs can be
   * applied to it instead of dropped.
   */
  private registerSession(agent: RunningAgent, sessionId: string, cwd: string, state: SessionState = NO_SESSION_STATE): SessionInfo {
    if (this.disposed) {
      throw new Error('Session manager is disposed.');
    }
    // Known for a session reopened from the tree; updates drained below override it.
    const title = this.listedTitles.get(agent.name)?.get(sessionId) ?? this.referenceOf(agent.name, sessionId)?.title;
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

    logDebug('Sending prompt', { sessionId });

    const prompt: PromptPart[] = [
      { kind: 'text', text },
    ];

    const fileLink = this.environment.activeFileLink();
    if (fileLink) {
      logDebug('Attaching active file context', { sessionId });
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
    } else if (typeof update.title === 'string') {
      // Session not registered yet — buffer for drain.
      this.pendingTitles.set(sessionId, update.title);
    }
    this.emit('session-info-changed', sessionId, update);
  }

  /** A turn of the session ended: record it as used, and tell the session list. */
  recordTurnEnded(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) { return; }
    this.record(session, (address, { references }) => void references.used(address));
    this.emit('turn-ended', sessionId, session.agentName);
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
      throw e;
    }

    this.emit('session-load-end', sessionId, agentName, /*ok=*/true);
    this.recordOpened(session);
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
    const response = await agent.driver.resumeSession(sessionId, cwd);

    const sessionInfo = this.registerSession(agent, sessionId, cwd, response);
    this.agentSessions.set(agentName, sessionId);
    this.activeSessionId = sessionId;
    this.emit('session-added', sessionId, agentName);
    this.emit('active-session-changed', sessionId);

    this.recordOpened(sessionInfo);
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

  private referenceOf(agentName: string, sessionId: string) {
    const host = this.environment.workspaceTarget()?.host;
    return host ? this.persisted?.references.get({ host, configuredName: agentName, sessionId }) : undefined;
  }

  /** The session was created, loaded or resumed here, which also makes it this workspace's last active session. */
  private recordOpened(session: SessionInfo): void {
    this.record(session, (address, { references, workspace }) => {
      void references.used(address);
      void workspace.setLastActiveSession(address);
    });
  }

  /** Record a change to a session open here, when this window has a workspace target to record it against. */
  private record(session: SessionInfo, change: (address: SessionAddress, persisted: PersistedState) => void): void {
    const persisted = this.persisted;
    if (persisted) {
      this.withTarget((target) =>
        change({ configuredName: session.agentName, sessionId: session.sessionId, cwd: session.cwd, host: target.host, workspaceUri: target.uri }, persisted));
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

  dispose(): Promise<void> {
    if (this.disposal) { return this.disposal; }
    this.disposed = true;
    this.endWaits();
    this.agents.clear();
    this.sessions.clear();
    this.agentSessions.clear();
    this.disposal = (async () => {
      const results = await Promise.allSettled([...this.processes].map(async ([process, exited]) => {
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
