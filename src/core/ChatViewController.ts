import type { ConfigOption, ConfigValueGroup, PlanStep, SessionUpdate, SlashCommand } from '@/core/acp/AcpDriver';
import type {
  ExtensionToWebviewMessage,
  Picker,
  PickerValueGroup,
  PlanStep as WebviewPlanStep,
  SlashCommand as WebviewSlashCommand,
  WebviewToExtensionMessage,
} from '@/shared/WebviewMessages';
import type { SessionInfo, SessionManager } from './SessionManager';
import { logError, messageOf } from './Log';
import type { Commands } from './VsCodeApi';

/** The session operations the chat view uses. */
export type ChatSessions = Pick<
  SessionManager,
  | 'getActiveSessionId'
  | 'getSession'
  | 'sendPrompt'
  | 'cancelTurn'
  | 'setMode'
  | 'setConfigOption'
  | 'recordFirstPrompt'
  | 'touchHistory'
  | 'applyAvailableCommands'
  | 'applyConfigOptions'
  | 'applyCurrentMode'
  | 'applySessionInfoUpdate'
>;

/** Text arriving within this many milliseconds reaches the webview as one message, so it renders about once a frame at most. */
const TEXT_CHUNK_WINDOW_MS = 16;

type TextMessage = Extract<ExtensionToWebviewMessage, { type: 'agentText' | 'thoughtText' | 'promptText' }>;

/** What the chat view needs from the editor it runs in. */
export interface ChatViewEnvironment extends Commands {
  /** Deliver a webview message; dropped while the chat view is not open. */
  post(message: ExtensionToWebviewMessage): void;
}

/**
 * The extension's side of the chat view: answers webview messages, runs turns
 * against the active session, and tells the webview what to show, translating
 * the ACP drivers' session updates into the webview's contract. What the contract has no place for is dropped here.
 * The webview sends one prompt at a time and queues the rest.
 */
export class ChatViewController {
  private _hasTranscript = false;
  /**
   * Sessions with a prompt in flight. The chat view hears of a turn only while its session is shown, and is told
   * it is running when it opens or shows that session again, so it holds its next prompt.
   */
  private readonly runningTurns = new Set<string>();
  /** The session the chat view was last told about; reporting the same one again would split its running turn. */
  private shownSessionId: string | null = null;
  /** Text not yet posted, sent when its window closes or before anything else is posted. */
  private pendingText: { message: TextMessage; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(
    private readonly sessions: ChatSessions,
    private readonly environment: ChatViewEnvironment,
  ) {}

  /** Whether a prompt has been sent since the transcript was last cleared. */
  get hasTranscript(): boolean {
    return this._hasTranscript;
  }

  async handleMessage(message: WebviewToExtensionMessage): Promise<void> {
    switch (message.type) {
      case 'sendPrompt':
        this._hasTranscript = true;
        await this.sendPrompt(message.text);
        break;
      case 'cancelTurn':
        await this.cancelTurn();
        break;
      case 'pickerValueChosen':
        await this.choosePickerValue(message.pickerId, message.value);
        break;
      case 'ready':
        this.sendCurrentState();
        this.sendRunningTurn();
        break;
    }
  }

  handleSessionUpdate(sessionId: string, update: SessionUpdate): void {
    // Applied before the active-session check: an agent can send these while
    // a session is still being created, before it becomes the active session.
    switch (update.kind) {
      case 'commands':
        this.sessions.applyAvailableCommands(sessionId, update.commands);
        break;
      case 'configOptions':
        this.sessions.applyConfigOptions(sessionId, update.options);
        break;
      case 'currentMode':
        this.sessions.applyCurrentMode(sessionId, update.modeId);
        break;
      case 'sessionInfo':
        this.sessions.applySessionInfoUpdate(sessionId, update);
        this.sendTitle(sessionId);
        break;
      default:
        break;
    }

    if (sessionId !== this.sessions.getActiveSessionId()) { return; }
    const message = this.translate(sessionId, update);
    if (!message) { return; }
    if (!isText(message)) {
      this.post(message);
      return;
    }
    const pending = this.pendingText;
    if (pending && sameText(pending.message, message)) {
      pending.message = { ...pending.message, text: pending.message.text + message.text };
      return;
    }
    this.sendPendingText();
    this.pendingText = { message, timer: setTimeout(() => this.sendPendingText(), TEXT_CHUNK_WINDOW_MS) };
  }

  /** Tell the webview the active session changed. */
  notifyActiveSessionChanged(): void {
    const changed = this.sessions.getActiveSessionId() !== this.shownSessionId;
    this.sendCurrentState();
    if (changed) {
      this.sendRunningTurn();
      this.setTurnInProgress(this.isRunning(this.shownSessionId));
    }
  }

  /**
   * The session's agent exited on its own, ending any turn in it. Called before the session is dropped, so the chat
   * view keeps the transcript and shows why.
   */
  notifySessionEnded(sessionId: string, reason: string): void {
    this.runningTurns.delete(sessionId);
    if (sessionId === this.shownSessionId) {
      this.post({ type: 'sessionEnded', message: reason });
    }
  }

  /** The active session's mode or config options changed outside the chat view. */
  notifyPickersChanged(): void {
    const activeId = this.sessions.getActiveSessionId();
    if (activeId) {
      this.sendPickers(activeId);
    }
  }

  /**
   * A `session/load` replay is starting. The webview wipes the transcript,
   * disables input, and shows a loading overlay until {@link notifyLoadSessionEnd}.
   */
  notifyLoadSessionStart(): void {
    this.post({ type: 'loadSessionStart' });
  }

  /** The replay finished, successfully or not. */
  notifyLoadSessionEnd(ok: boolean): void {
    this.post({ type: 'loadSessionEnd', ok });
  }

  /** Clear the transcript, as when a new session starts. */
  clearTranscript(): void {
    this._hasTranscript = false;
    this.post({ type: 'clearTranscript' });
  }

  private async sendPrompt(text: string): Promise<void> {
    const activeId = this.sessions.getActiveSessionId();
    if (!activeId) {
      this.post({ type: 'error', message: 'No active session. Create a session first.' });
      return;
    }

    // The history store uses the first prompt as a label until the agent supplies a title.
    this.sessions.recordFirstPrompt(activeId, text);

    this.runningTurns.add(activeId);
    this.post({ type: 'promptStart' });
    this.setTurnInProgress(true);

    try {
      await this.sessions.sendPrompt(activeId, text);
      this.sessions.touchHistory(activeId);
    } catch (e) {
      logError('Prompt failed', e);
      if (activeId === this.sessions.getActiveSessionId()) {
        this.post({ type: 'error', message: messageOf(e) || 'Prompt failed' });
      }
    }
    this.endTurn(activeId);
  }

  private endTurn(sessionId: string): void {
    this.runningTurns.delete(sessionId);
    if (sessionId !== this.sessions.getActiveSessionId()) { return; }
    this.post({ type: 'promptEnd' });
    this.setTurnInProgress(false);
  }

  private isRunning(sessionId: string | null): boolean {
    return sessionId !== null && this.runningTurns.has(sessionId);
  }

  private sendRunningTurn(): void {
    if (this.isRunning(this.shownSessionId)) {
      this.post({ type: 'promptStart' });
    }
  }

  private async cancelTurn(): Promise<void> {
    const activeId = this.sessions.getActiveSessionId();
    if (!activeId) { return; }
    try {
      await this.sessions.cancelTurn(activeId);
    } catch (e) {
      logError('Cancel failed', e);
    }
  }

  /**
   * A picker stands for the session's modes only while it has no config options (see {@link pickersOf}). The webview
   * already shows the chosen value; the session's pickers are re-sent after a change, so that changes cascading from it
   * reach the webview too, and after a failure, which rolls the choice back.
   */
  private async choosePickerValue(pickerId: string, value: string): Promise<void> {
    const activeId = this.sessions.getActiveSessionId();
    const session = activeId ? this.sessions.getSession(activeId) : undefined;
    if (!activeId || !session || !value) { return; }
    const isConfigOption = (session.configOptions?.length ?? 0) > 0;
    try {
      if (isConfigOption) {
        await this.sessions.setConfigOption(activeId, pickerId, value);
        this.sendPickers(activeId);
      } else {
        // The session reports the new mode, which re-sends the pickers (notifyPickersChanged).
        await this.sessions.setMode(activeId, value);
      }
    } catch (e) {
      logError(isConfigOption ? 'Failed to set config option' : 'Failed to set mode', e);
      this.post({ type: 'error', message: `Failed to set ${isConfigOption ? pickerId : 'mode'}: ${messageOf(e)}` });
      this.sendPickers(activeId);
    }
  }

  private sendPickers(sessionId: string): void {
    const session = this.sessions.getSession(sessionId);
    if (sessionId !== this.sessions.getActiveSessionId() || !session) { return; }
    this.post({ type: 'pickers', pickers: pickersOf(session) });
  }

  /** The session's resulting title, not the update: an update without a title leaves it unchanged. */
  private sendTitle(sessionId: string): void {
    if (sessionId !== this.sessions.getActiveSessionId()) { return; }
    this.post({ type: 'sessionInfoUpdate', title: this.sessions.getSession(sessionId)?.title ?? null });
  }

  private sendCurrentState(): void {
    const activeId = this.sessions.getActiveSessionId();
    const session = activeId ? this.sessions.getSession(activeId) : undefined;
    this.shownSessionId = activeId;
    this.post({
      type: 'state',
      activeSessionId: activeId,
      session: session ? {
        sessionId: session.sessionId,
        agentName: session.agentDisplayName,
        ...(session.title !== undefined ? { title: session.title } : {}),
        cwd: session.cwd,
        pickers: pickersOf(session),
        commands: session.availableCommands.map(slashCommand),
      } : null,
    });
  }

  /** The webview message for a session update to the active session, or null when the contract has no place for it. */
  private translate(sessionId: string, update: SessionUpdate): ExtensionToWebviewMessage | null {
    switch (update.kind) {
      case 'agentText':
        return { type: 'agentText', messageId: update.messageId, text: update.text };
      case 'thoughtText':
        return { type: 'thoughtText', messageId: update.messageId, text: update.text };
      case 'promptText':
        return { type: 'promptText', text: update.text };
      case 'agentMessage':
        return { type: 'agentMessage', messageId: update.messageId, text: update.text };
      case 'thoughtMessage':
        return { type: 'thoughtMessage', messageId: update.messageId, text: update.text };
      case 'promptMessage':
        return { type: 'promptMessage', messageId: update.messageId, text: update.text };
      case 'toolCall':
        return {
          type: 'toolCall',
          toolCallId: update.toolCallId,
          ...(update.title !== undefined ? { title: update.title } : {}),
          ...(update.status !== undefined ? { status: update.status } : {}),
          ...(update.texts !== undefined ? { texts: [...update.texts] } : {}),
        };
      case 'plan':
        return { type: 'plan', steps: update.steps.map(planStep) };
      case 'commands':
        return { type: 'commands', commands: update.commands.map(slashCommand) };
      case 'configOptions':
      case 'currentMode': {
        const session = this.sessions.getSession(sessionId);
        return session ? { type: 'pickers', pickers: pickersOf(session) } : null;
      }
      case 'sessionInfo':
        return null;
    }
  }

  /** Shows the Cancel button in the chat view's title bar (the `acp.turnInProgress` `when` clause in package.json). */
  private setTurnInProgress(inProgress: boolean): void {
    void this.environment.executeCommand('setContext', 'acp.turnInProgress', inProgress);
  }

  private post(message: ExtensionToWebviewMessage): void {
    this.sendPendingText();
    this.environment.post(message);
  }

  private sendPendingText(): void {
    const pending = this.pendingText;
    if (!pending) { return; }
    this.pendingText = null;
    clearTimeout(pending.timer);
    this.environment.post(pending.message);
  }
}

function isText(message: ExtensionToWebviewMessage): message is TextMessage {
  return message.type === 'agentText' || message.type === 'thoughtText' || message.type === 'promptText';
}

function sameText(a: TextMessage, b: TextMessage): boolean {
  return a.type === b.type && messageIdOf(a) === messageIdOf(b);
}

function messageIdOf(message: TextMessage): string | null {
  return message.type === 'promptText' ? null : message.messageId;
}

function planStep(step: PlanStep): WebviewPlanStep {
  return { text: step.text, status: step.status };
}

function slashCommand(command: SlashCommand): WebviewSlashCommand {
  return { name: command.name, description: command.description, takesInput: command.takesInput, hint: command.hint };
}

/**
 * The session's pickers. Config options replace modes, as the ACP spec says, so the modes are a picker only for a
 * session without config options; only selects with values to choose from are pickers, as other kinds have none yet.
 */
function pickersOf(session: SessionInfo): Picker[] {
  const options = session.configOptions ?? [];
  if (options.length > 0) {
    return options.flatMap((option) => (option.kind === 'select' && option.groups.length > 0 ? [configPicker(option)] : []));
  }
  const { modes } = session;
  if (!modes || modes.available.length === 0) {
    return [];
  }
  return [{
    id: 'mode',
    category: 'mode',
    name: 'Mode',
    description: null,
    current: modes.current,
    groups: [{
      header: null,
      values: modes.available.map((mode) => ({ id: mode.id, name: mode.name, description: mode.description })),
    }],
  }];
}

function configPicker(option: Extract<ConfigOption, { kind: 'select' }>): Picker {
  return {
    id: option.id,
    category: option.category,
    name: option.name,
    description: option.description,
    current: option.current,
    groups: option.groups.map(valueGroup),
  };
}

function valueGroup(group: ConfigValueGroup): PickerValueGroup {
  return { header: group.header, values: group.values.map((value) => ({ id: value.id, name: value.name, description: value.description })) };
}
