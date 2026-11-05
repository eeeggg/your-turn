import type { ReviewControls } from '@/core/review/ReviewControls';
import type { ChatViewController } from '@/core/ChatViewController';
import { logError, messageOf } from '@/core/Log';
import type { SessionManager } from '@/core/SessionManager';
import {
  openingFailure,
  type OpeningFailure,
  type SessionStartup,
  type StartupOutcome
} from '@/core/SessionStartup';
import { ProgressLocation, type Commands, type Window } from '@/core/VsCodeApi';

/** What commands need from the chat view. */
export type ChatView = Pick<ChatViewController, 'hasRunningTurn' | 'queuedPrompts' | 'clearTranscript' | 'sessionTabs' | 'notifyTabsChanged'>;

/** What commands need of the shown review. */
export type ShownReview = Pick<ReviewControls, 'reviewedPaths' | 'keepAll'>;

/** A switch of session: what it asks, its choices, and whether it stops the agent. */
interface Switch {
  question: string;
  action: string;
  keepAllAction: string;
  stopsAgent: boolean;
}

const counted = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const REMOVE_FROM_HISTORY = 'Remove from History';
const RETRY = 'Retry';
const CHOOSE_SESSION = 'Choose Session';
const CHOOSE_AGENT = 'Choose Agent';

/** The commands that start, switch, open, and control sessions. */
export class SessionCommands {
  private navigation = Promise.resolve();

  private serial(action: () => Promise<void>): Promise<void> {
    const result = this.navigation.then(action);
    this.navigation = result.catch(() => {});
    return result;
  }

  selectTab(tabId: string): Promise<void> {
    return this.serial(async () => {
      const tab = this.chatView.sessionTabs.snapshot().tabs.find((tab) => tab.tabId === tabId);
      if (tab) { await this.openSession(tab.agentName, tab.sessionId); }
    });
  }

  closeTab(tabId: string): Promise<void> {
    return this.serial(async () => {
      const snapshot = this.chatView.sessionTabs.snapshot();
      const tab = snapshot.tabs.find((tab) => tab.tabId === tabId);
      if (!tab) { return; }
      if (snapshot.selectedTabId !== tabId) {
        this.chatView.sessionTabs.close(tabId);
        this.chatView.notifyTabsChanged();
        return;
      }
      const closing = { question: 'Close this session tab?', action: 'Close Tab', keepAllAction: 'Keep All and Close', stopsAgent: true };
      if (!await this.confirmLeaving(closing)) { return; }
      await this.startup.forgo();
      const activeAgent = this.sessions.getActiveAgentName();
      if (activeAgent) { await this.sessions.disconnectAgent(activeAgent); }
      const next = this.chatView.sessionTabs.close(tabId);
      this.chatView.notifyTabsChanged();
      if (next) { await this.openThrough(next.agentName, next.sessionId); }
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
    const loadThrough = async (name: string) =>
      this.settleStartup(await this.withProgress('Loading session…', () => this.startup.loadThrough(address, name)));
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

  /** Make a session with an agent the active session, asking which agent when none is given. */
  connect(agentName?: string): Promise<void> {
    return this.serial(() => this.connectAgent(agentName));
  }

  private async connectAgent(agentName?: string): Promise<void> {
    const name = agentName ?? await this.pickAgent();
    if (!name) { return; }
    await this.startup.forgo();

    const currentAgent = this.sessions.getActiveAgentName();
    if (currentAgent && currentAgent !== name) {
      const switching = { question: `Switch to ${name}?`, action: 'Switch Agent', keepAllAction: 'Keep All and Switch', stopsAgent: true };
      if (!await this.confirmLeaving(switching)) { return; }
      this.chatView.clearTranscript();
    }

    try {
      await this.withProgress(`Connecting to ${name}...`, () => this.sessions.connectToAgent(name));
      this.selectActiveTab();
    } catch (e) {
      this.report('Failed to connect', e);
    }
  }

  /** Replace the active session with a new one from the same agent; connect when there is none. */
  newSession(agentName?: string): Promise<void> {
    return this.serial(() => this.createSession(agentName));
  }

  private async createSession(agentName?: string): Promise<void> {
    await this.startup.forgo();
    const activeSession = this.sessions.getActiveSession();
    if (agentName && agentName !== activeSession?.agentName) {
      const starting = { question: `Start a new session with ${agentName}?`, action: 'New Session', keepAllAction: 'Keep All and Start', stopsAgent: true };
      if (!await this.confirmLeaving(starting)) { return; }
      try {
        // A listed agent can already have a session even when it is not the active agent.
        if (this.sessions.hasSession(agentName)) { await this.sessions.disconnectAgent(agentName); }
        this.chatView.clearTranscript();
        await this.withProgress(`Starting new session with ${agentName}...`, () => this.sessions.connectToAgent(agentName));
      } catch (e) {
        this.report('Failed to start new session', e);
      }
      return;
    }
    if (!activeSession) {
      await this.connectAgent();
      return;
    }

    const starting = { question: 'Start a new session?', action: 'New Session', keepAllAction: 'Keep All and Start', stopsAgent: true };
    if (!await this.confirmLeaving(starting)) { return; }

    try {
      await this.withProgress(`Starting new session with ${activeSession.agentDisplayName}...`, () => this.sessions.newSession());
    } catch (e) {
      this.report('Failed to start new session', e);
    }
  }

  /** Stop an agent, by default the active session's. */
  disconnect(agentName?: string): Promise<void> {
    return this.serial(() => this.disconnectAgent(agentName));
  }

  private async disconnectAgent(agentName?: string): Promise<void> {
    const name = agentName ?? this.sessions.getActiveAgentName();
    if (!name) {
      void this.window.showInformationMessage('No active session.');
      return;
    }
    await this.sessions.disconnectAgent(name);
    void this.window.showInformationMessage(`Disconnected from ${name}.`);
  }

  /** Stop an agent, by default the active session's, and connect it again with a new session. */
  restart(agentName?: string): Promise<void> {
    return this.serial(() => this.restartAgent(agentName));
  }

  private async restartAgent(agentName?: string): Promise<void> {
    await this.startup.forgo();
    const activeSession = this.sessions.getActiveSession();
    const name = agentName ?? activeSession?.agentName;
    if (!name) { return; }
    const label = activeSession?.agentName === name ? activeSession.agentDisplayName : name;

    try {
      await this.withProgress(`Restarting ${label}...`, async () => {
        await this.sessions.disconnectAgent(name);
        await this.sessions.connectToAgent(name);
      });
      void this.window.showInformationMessage(`Restarted ${name}`);
    } catch (e) {
      this.report('Failed to restart', e);
    }
  }

  async cancelTurn(): Promise<void> {
    const activeId = this.sessions.getActiveSessionId();
    if (!activeId) { return; }
    try {
      await this.sessions.cancelTurn(activeId);
    } catch (e) {
      logError('Cancel failed', e);
    }
  }

  async setMode(modeId?: string): Promise<void> {
    const activeId = this.sessions.getActiveSessionId();
    if (!activeId) { return; }
    const mode = modeId || await this.window.showInputBox({
      placeHolder: 'Enter mode ID (e.g., "plan", "code")',
      title: 'Set Agent Mode',
    });
    if (!mode) { return; }
    try {
      await this.sessions.setMode(activeId, mode);
    } catch (e) {
      this.report('Failed to set mode', e);
    }
  }

  async setModel(modelId?: string): Promise<void> {
    const activeId = this.sessions.getActiveSessionId();
    if (!activeId) { return; }
    const model = modelId || await this.window.showInputBox({
      placeHolder: 'Enter model ID',
      title: 'Set Agent Model',
    });
    if (!model) { return; }
    try {
      await this.sessions.setModel(activeId, model);
    } catch (e) {
      this.report('Failed to set model', e);
    }
  }

  /** Show a past session in the chat view, loading it when the agent can, otherwise resuming it. */
  open(agentName: string | undefined, sessionId: string | undefined): Promise<void> {
    return this.serial(() => this.openSession(agentName, sessionId));
  }

  private async openSession(agentName: string | undefined, sessionId: string | undefined): Promise<void> {
    if (!agentName || !sessionId) {
      void this.window.showErrorMessage('Open Session: missing agentName/sessionId.');
      return;
    }
    await this.startup.forgo();

    if (this.sessions.getActiveSessionId() === sessionId && this.sessions.getActiveAgentName() === agentName) {
      this.selectActiveTab();
      await this.focusChatView();
      return;
    }

    const currentAgent = this.sessions.getActiveAgentName();
    const opening = {
      question: 'Open a different session?',
      action: 'Open Session',
      keepAllAction: 'Keep All and Open',
      stopsAgent: currentAgent !== null && currentAgent !== agentName,
    };
    if (!await this.confirmLeaving(opening)) { return; }

    await this.focusChatView();
    await this.openThrough(agentName, sessionId);
  }

  /**
   * Open a session through `agentName`, loading it when the agent can, otherwise resuming it; `usedThrough` is the
   * configuration it was last used through, where its reference moves from once it opens, when not `agentName`.
   */
  private async openThrough(agentName: string, sessionId: string, usedThrough?: string): Promise<void> {
    const referencedAs = usedThrough ?? agentName;
    const from = usedThrough === undefined ? undefined : { configuredName: usedThrough };
    let failure: OpeningFailure;
    try {
      // Load replays the transcript, so it is preferred over resume.
      const capabilities = await this.sessions.ensureConnected(agentName);
      if (capabilities.load) {
        await this.withProgress('Loading session…', () => this.sessions.loadSession(agentName, sessionId, from));
        return;
      }
      if (capabilities.resume) {
        await this.sessions.resumeSession(agentName, sessionId, from);
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
      chooseAgent: (configuredName) => this.openThrough(configuredName, sessionId, referencedAs),
    });
  }

  /**
   * Whether to leave the shown session, asking first when that loses something: the turn in progress, when the agent
   * is stopped; the prompts queued, which the chat view drops with the transcript; or files still under review, whose
   * review is kept but no longer shown. A turn left on a running agent goes on, so it is not asked about.
   */
  private async confirmLeaving({ question, action, keepAllAction, stopsAgent }: Switch): Promise<boolean> {
    const stopsTurn = stopsAgent && this.chatView.hasRunningTurn;
    const queued = this.chatView.queuedPrompts;
    const reviewed = this.review.reviewedPaths().length;
    if (!stopsTurn && queued === 0 && reviewed === 0) { return true; }

    const losses = [
      ...(stopsTurn ? ['stops the turn in progress'] : []),
      ...(queued > 0 ? [`discards ${counted(queued, 'queued prompt', 'queued prompts')}`] : []),
    ];
    const consequences = losses.length > 0 ? [`This ${losses.join(' and ')}.`] : [];
    const choice = await this.window.showQuickPick([
      {
        label: action,
        detail: [
          ...consequences,
          ...(reviewed > 0 ? [`${counted(reviewed, 'file is', 'files are')} still under review, kept until this session is opened again in this window.`] : []),
        ].join(' '),
      },
      ...(reviewed > 0 ? [{
        label: keepAllAction,
        detail: [...consequences, `Keep ${counted(reviewed, 'file', 'files')} under review before continuing.`].join(' '),
      }] : []),
      { label: 'Cancel' },
    ], { title: action, placeHolder: question });
    if (choice?.label === keepAllAction) {
      this.review.keepAll();
      return true;
    }
    return choice?.label === action;
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
