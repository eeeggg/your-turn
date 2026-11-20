import type { ReviewControls } from '@/core/review/ReviewControls';
import type { ChatViewController } from '@/core/ChatViewController';
import { logError, messageOf } from '@/core/Log';
import type { SessionManager } from '@/core/sessions/Manager';
import type { SessionAddress } from '@/core/PersistedState';
import {
  openingFailure,
  type OpeningFailure,
  type SessionStartup,
  type StartupOutcome
} from '@/core/sessions/Startup';
import { ProgressLocation, QuickPickItemKind, type Commands, type QuickPickItem, type Window } from '@/core/VsCodeApi';

/** What commands need from the chat view. */
export type ChatView = Pick<ChatViewController, 'sessionTabs' | 'notifyTabsChanged'>;

/** What commands need of the shown review. */
export type ShownReview = Pick<ReviewControls, 'unresolvedFileCount'>;

const counted = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const REMOVE_FROM_HISTORY = 'Remove from History';
const RETRY = 'Retry';
const CHOOSE_SESSION = 'Choose Session';
const CHOOSE_AGENT = 'Choose Agent';

/** The commands that start, switch, open, and control sessions. */
export class SessionCommands {
  private navigation = Promise.resolve();
  private readonly closingTabs = new Map<string, Promise<void>>();

  private serial(action: () => Promise<void>): Promise<void> {
    const result = this.navigation.then(action);
    this.navigation = result.catch(() => {});
    return result;
  }

  selectTab(tabId: string): Promise<void> {
    return this.serial(async () => {
      const tab = this.chatView.sessionTabs.snapshot().tabs.find((tab) => tab.tabId === tabId);
      if (tab) { await this.openSession(tab.agentName, tab.sessionId, 'keep-focus', this.chatView.sessionTabs.address(tabId)); }
    });
  }

  closeTab(tabId: string): Promise<void> {
    const existing = this.closingTabs.get(tabId);
    if (existing) { return existing; }
    const operation = this.closeCapturedTab(tabId).finally(() => { this.closingTabs.delete(tabId); });
    this.closingTabs.set(tabId, operation);
    return operation;
  }

  private async closeCapturedTab(tabId: string): Promise<void> {
    const current = () => this.chatView.sessionTabs.snapshot().tabs.find((tab) => tab.tabId === tabId);
    const tab = current();
    if (!tab) { return; }
    const identity = () => ({ configuredName: registration?.agentName ?? tab.agentName, sessionId: tab.sessionId });
    const registration = this.sessions.getSession({ configuredName: tab.agentName, sessionId: tab.sessionId });
    await this.startup.forgo();
    if (this.sessions.sessionReloading(identity())) { return; }
    for (;;) {
      const next = current();
      if (next?.agentName !== identity().configuredName || this.sessions.getSession(identity()) !== registration) { return; }
      const busy = registration !== undefined && this.sessions.sessionNeedsStop(registration);
      const reviewed = this.review.unresolvedFileCount(identity());
      if (!busy && reviewed === 0) { break; }
      const action = busy ? 'Stop Turn and Close Tab' : 'Close Tab';
      const detail = [busy ? 'This stops the turn or cancels pending requests.' : '',
        reviewed ? `${counted(reviewed, 'file is', 'files are')} still under review. Review stays available when you reopen this session.` : '']
        .filter(Boolean).join(' ');
      const choice = await this.window.showQuickPick([{ label: action, detail }, { label: 'Keep Tab Open' }], { title: action, placeHolder: 'Close this session tab?' });
      if (choice?.label !== action) { return; }
      const currentRegistration = this.sessions.getSession(identity());
      if (currentRegistration !== registration || !current()) { return; }
      if (busy || !registration || !this.sessions.sessionNeedsStop(registration)) { break; }
    }
    if (registration) {
      const outcome = await this.sessions.closeSession(registration);
      if (outcome.kind === 'not-stopped') { this.report('Failed to close tab', outcome.reason); }
      if (outcome.kind !== 'closed') { return; }
    }
    await this.serial(async () => {
      if (!current() || this.sessions.getSession(identity())) { return; }
      const next = this.chatView.sessionTabs.close(tabId);
      this.sessions.releaseSessionState(identity());
      this.chatView.notifyTabsChanged();
      if (next) { await this.openSession(next.agentName, next.sessionId, 'focus-chat', this.chatView.sessionTabs.address(next.tabId)); }
    });
  }
  constructor(
    private readonly sessions: SessionManager,
    private readonly chatView: ChatView,
    private readonly review: ShownReview,
    private readonly window: Window,
    private readonly commands: Commands,
    private readonly agentNames: () => string[],
    private readonly startup: SessionStartup,
  ) {}

  /** Load the workspace's last active session, once per activation; a failure offers ways on. */
  async restoreLastSession(): Promise<void> {
    await this.serial(async () => this.settleStartup(await this.startup.attempt()));
  }

  /** Show the chat view when another window asked this one, as it opened, to load a session, which startup loads there. */
  async revealRequested(): Promise<void> {
    if (await this.startup.requested()) {
      await this.focusChatView();
    }
  }

  /** Open a session another window has asked this one to since it opened, as Open Session does. */
  async openRequested(): Promise<void> {
    const address = await this.startup.requestedSince();
    if (address) {
      await this.open(address.configuredName, address.sessionId);
    }
  }

  private async settleStartup(outcome: StartupOutcome): Promise<void> {
    if (outcome.kind !== 'failed') { return; }
    const { address, configuredName, failure } = outcome;
    logError('Failed to open session', failure.message, { sessionId: address.sessionId, configuredName, kind: failure.kind });
    const loadThrough = async (name: string) => {
      const retried = await this.withProgress('Loading session…', () => this.startup.loadThrough(address, name));
      if (retried.kind === 'loaded') { this.rebindTab(address.configuredName, name, address.sessionId); }
      await this.settleStartup(retried);
    };
    await this.offerWaysOn(failure, address.configuredName, address.sessionId, {
      retry: () => loadThrough(configuredName),
      chooseAgent: loadThrough,
    });
  }

  /**
   * Tell the user a session did not open, offering to try again through the same configuration or another, to choose
   * another session, and for a session the agent does not know, to remove it from session history. A changed cwd
   * offers only another session, as every configuration would meet it.
   */
  private async offerWaysOn(
    failure: OpeningFailure,
    referencedAs: string,
    sessionId: string,
    again: { retry: () => Promise<void>; chooseAgent: (configuredName: string) => Promise<void> },
  ): Promise<void> {
    const actions = failure.kind === 'cwdChanged'
      ? [CHOOSE_SESSION]
      : [RETRY, CHOOSE_SESSION, CHOOSE_AGENT, ...(failure.kind === 'unknownSession' ? [REMOVE_FROM_HISTORY] : [])];
    const choice = await this.window.showErrorMessage(`Failed to open session: ${failure.message}`, ...actions);
    if (choice === RETRY) {
      await again.retry();
    } else if (choice === CHOOSE_SESSION) {
      await this.commands.executeCommand('your-turn-sessions.focus');
    } else if (choice === CHOOSE_AGENT) {
      const configuredName = await this.pickAgent({ title: 'Choose Agent', placeHolder: 'Open the session through which agent?' });
      if (configuredName) { await again.chooseAgent(configuredName); }
    } else if (choice === REMOVE_FROM_HISTORY) {
      // Removal is the user's choice, as the agent may know the session again, such as once a store it uses is back.
      await this.sessions.removeFromHistory(referencedAs, sessionId);
    }
  }

  /** Offer management actions for the row's agent, retaining its target while the picker is open. */
  async agentActions(agentName?: string, canRefreshSessions = false): Promise<void> {
    if (!agentName) { return; }
    const connected = this.sessions.isConnected(agentName);
    const items: (QuickPickItem & { command?: string })[] = [
      { label: 'New Session', command: 'your-turn.newSession' },
      ...(canRefreshSessions ? [{ label: 'Refresh Sessions', command: 'your-turn.refreshSessions' }] : []),
      { label: '', kind: QuickPickItemKind.Separator },
      connected
        ? { label: 'Disconnect Agent', command: 'your-turn.disconnectAgent' }
        : { label: 'Connect to Agent', command: 'your-turn.connectAgent' },
      ...(connected ? [{ label: 'Restart Agent', command: 'your-turn.restartAgent' }] : []),
      { label: 'Remove Agent', command: 'your-turn.removeAgent' },
    ];
    const choice = await this.window.showQuickPick(items, { title: `Agent Actions: ${agentName}` });
    if (choice?.command) { await this.commands.executeCommand(choice.command, agentName); }
  }

  /** Initialize an agent connection without opening a session. */
  connect(agentName?: string): Promise<void> {
    return this.serial(() => this.connectAgent(agentName));
  }

  private async connectAgent(agentName?: string): Promise<void> {
    const name = agentName ?? await this.pickAgent();
    if (!name) { return; }
    try {
      await this.withProgress(`Connecting to ${name}...`, () => this.sessions.ensureConnected(name));
    } catch (e) {
      this.report('Failed to connect', e);
    }
  }

  /** Create another session on the named or selected agent. */
  newSession(agentName?: string): Promise<void> {
    return this.serial(() => this.createSession(agentName));
  }

  private async createSession(agentName?: string): Promise<void> {
    await this.startup.forgo();
    const active = this.sessions.getActiveSession();
    const name = agentName ?? active?.agentName ?? await this.pickAgent({ placeHolder: 'Select an agent to start a session', title: 'New Session' });
    if (!name) { return; }
    const label = active?.agentName === name ? active.agentDisplayName : name;
    try {
      await this.withProgress(`Starting new session with ${label}...`, () => this.sessions.newSession(name));
    } catch (e) {
      this.report('Failed to start new session', e);
    }
  }

  /** Stop an agent, by default the active session's. */
  disconnect(agentName?: string): Promise<void> {
    return this.disconnectAgent(agentName);
  }

  private async disconnectAgent(agentName?: string): Promise<void> {
    const name = agentName ?? this.sessions.getActiveAgentName();
    if (!name) {
      void this.window.showInformationMessage('No active session.');
      return;
    }
    const source = this.sessions.connectionSource(name);
    if (source === undefined) { return; }
    if (this.sessions.connectionNeedsStop(source)) {
      const choice = await this.window.showQuickPick([
        { label: 'Disconnect Agent', detail: 'This stops its work and cancels its requests. Its tabs and unresolved review stay open.' },
        { label: 'Keep Connected' },
      ], { title: 'Disconnect Agent', placeHolder: `Disconnect ${name}?` });
      if (choice?.label !== 'Disconnect Agent') { return; }
    }
    if (this.sessions.connectionSource(name) !== source) { return; }
    await this.sessions.disconnectAgent(name, source);
    void this.window.showInformationMessage(`Disconnected from ${name}.`);
  }

  /** Restart an agent, preserving whether it had an open session. */
  async restart(agentName?: string): Promise<void> {
    const name = agentName ?? this.sessions.getActiveAgentName();
    const source = name ? this.sessions.connectionSource(name) : undefined;
    if (!name || !source) { return; }
    let restarting: Promise<void> | undefined;
    await this.serial(async () => {
      if (this.sessions.connectionSource(name) === source) { restarting = this.restartAgent(name, source); }
    });
    await restarting;
  }

  private async restartAgent(name: string, source: string): Promise<void> {
    const activeSession = this.sessions.getActiveSession();
    const label = activeSession?.agentName === name ? activeSession.agentDisplayName : name;
    try {
      await this.withProgress(`Restarting ${label}...`, () => this.sessions.restartAgent(name, source));
      void this.window.showInformationMessage(`Restarted ${name}`);
    } catch (e) {
      this.report('Failed to restart', e);
    }
  }

  async cancelTurn(): Promise<void> {
    const session = this.sessions.getActiveSession();
    if (!session) { return; }
    try {
      await this.sessions.cancelTurn({ configuredName: session.agentName, sessionId: session.sessionId });
    } catch (e) {
      logError('Cancel failed', e);
    }
  }

  async setMode(modeId?: string): Promise<void> {
    const session = this.sessions.getActiveSession();
    if (!session) { return; }
    const mode = modeId || await this.window.showInputBox({
      placeHolder: 'Enter mode ID (e.g., "plan", "code")',
      title: 'Set Agent Mode',
    });
    if (!mode) { return; }
    const identity = { configuredName: session.agentName, sessionId: session.sessionId };
    if (this.sessions.getSession(identity) !== session) { return; }
    try {
      await this.sessions.setMode(identity, mode);
    } catch (e) {
      this.report('Failed to set mode', e);
    }
  }

  async setModel(modelId?: string): Promise<void> {
    const session = this.sessions.getActiveSession();
    if (!session) { return; }
    const model = modelId || await this.window.showInputBox({
      placeHolder: 'Enter model ID',
      title: 'Set Agent Model',
    });
    if (!model) { return; }
    const identity = { configuredName: session.agentName, sessionId: session.sessionId };
    if (this.sessions.getSession(identity) !== session) { return; }
    try {
      await this.sessions.setModel(identity, model);
    } catch (e) {
      this.report('Failed to set model', e);
    }
  }

  /** Show a past session in the chat view, loading it when the agent can, otherwise resuming it. */
  open(agentName: string | undefined, sessionId: string | undefined): Promise<void> {
    return this.serial(() => this.openSession(agentName, sessionId, 'focus-chat'));
  }

  private async openSession(agentName: string | undefined, sessionId: string | undefined, focus: 'focus-chat' | 'keep-focus', address?: SessionAddress): Promise<void> {
    if (!agentName || !sessionId) {
      void this.window.showErrorMessage('Open Session: missing agentName/sessionId.');
      return;
    }
    await this.startup.forgo();

    if (focus === 'focus-chat') { await this.focusChatView(); }
    await this.openThrough(agentName, sessionId, address);
  }

  /**
   * Open a session through `agentName`, loading it when the agent can, otherwise resuming it; `usedThrough` is the
   * configuration it was last used through, where its reference moves from once it opens, when not `agentName`.
   */
  private async openThrough(agentName: string, sessionId: string, usedThrough?: string | SessionAddress): Promise<void> {
    const referencedAs = typeof usedThrough === 'string' ? usedThrough : usedThrough?.configuredName ?? agentName;
    const from = typeof usedThrough === 'string' ? { configuredName: usedThrough } : usedThrough;
    let failure: OpeningFailure;
    try {
      const invalid = typeof usedThrough === 'object' ? this.startup.validate(usedThrough, agentName) : undefined;
      if (invalid) {
        await this.offerWaysOn(invalid, referencedAs, sessionId, {
          retry: () => this.openThrough(agentName, sessionId, usedThrough),
          chooseAgent: (configuredName) => this.openThrough(configuredName, sessionId, usedThrough),
        });
        return;
      }
      const live = this.sessions.getSession({ configuredName: agentName, sessionId });
      if (live && this.sessions.selectSession(live)) {
        this.rebindTab(referencedAs, agentName, sessionId);
        this.selectActiveTab();
        return;
      }
      // Load replays the transcript, so it is preferred over resume.
      const capabilities = await this.sessions.ensureConnected(agentName);
      if (capabilities.load) {
        await this.withProgress('Loading session…', () => this.sessions.loadSession(agentName, sessionId, from));
        this.rebindTab(referencedAs, agentName, sessionId);
        return;
      }
      if (capabilities.resume) {
        await this.sessions.resumeSession(agentName, sessionId, from);
        this.rebindTab(referencedAs, agentName, sessionId);
        void this.window.showInformationMessage('Resumed session (history not replayed).');
        return;
      }
      failure = { kind: 'loadUnsupported', message: `Agent "${agentName}" cannot load or resume sessions.` };
    } catch (e) {
      logError('Failed to open session', e);
      failure = openingFailure(e);
    }
    await this.offerWaysOn(failure, referencedAs, sessionId, {
      retry: () => this.openThrough(agentName, sessionId, usedThrough),
      chooseAgent: (configuredName) => this.openThrough(configuredName, sessionId, usedThrough ?? referencedAs),
    });
  }

  private rebindTab(from: string, to: string, sessionId: string): void {
    if (from === to) { return; }
    this.chatView.sessionTabs.rebind(from, to, sessionId);
    this.chatView.notifyTabsChanged();
  }

  private async pickAgent(options = { placeHolder: 'Select an agent to connect', title: 'Connect to Agent' }): Promise<string | undefined> {
    const agentNames = this.agentNames();
    if (agentNames.length === 0) {
      void this.window.showWarningMessage('No ACP agents configured. Add agents in Settings > Your Turn > Agents.');
      return undefined;
    }
    return this.window.showQuickPick(agentNames, options);
  }

  private async focusChatView(): Promise<void> {
    await this.commands.executeCommand('your-turn-chat.focus');
  }

  private selectActiveTab(): void {
    const session = this.sessions.getActiveSession();
    if (!session) { return; }
    this.chatView.sessionTabs.open(session);
    this.chatView.notifyTabsChanged();
  }

  private withProgress<R>(title: string, task: () => PromiseLike<R>): PromiseLike<R> {
    return this.window.withProgress({ location: ProgressLocation.Notification, title, cancellable: false }, task);
  }

  private report(failure: string, e: unknown): void {
    logError(failure, e);
    void this.window.showErrorMessage(`${failure}: ${messageOf(e)}`);
  }
}
