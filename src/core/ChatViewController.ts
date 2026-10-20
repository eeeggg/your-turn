import type { ContentBlock, SessionModeState, SessionNotification, SessionUpdate } from '@agentclientprotocol/sdk';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import type { SessionManager } from './SessionManager';
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
  | 'applySessionInfoUpdate'
>;

/** Text chunks arriving within this many milliseconds reach the webview as one, so it renders about once a frame at most. */
const TEXT_CHUNK_WINDOW_MS = 16;

/** A plain text chunk, which can be joined with the next one of the same message. */
type TextChunk = Extract<SessionUpdate, { sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk' | 'user_message_chunk' }> & {
  content: Extract<ContentBlock, { type: 'text' }>;
};

/** What the chat view needs from the editor it runs in. */
export interface ChatViewEnvironment extends Commands {
  /** Deliver a webview message; dropped while the chat view is not open. */
  post(message: ExtensionToWebviewMessage): void;
}

/**
 * The extension's side of the chat view: answers webview messages, runs turns
 * against the active session, and tells the webview what to show.
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
  private pendingText: { sessionId: string; update: TextChunk; timer: ReturnType<typeof setTimeout> } | null = null;

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
      case 'setMode':
        await this.setMode(message.modeId);
        break;
      case 'setConfigOption':
        await this.setConfigOption(message.configId, message.value);
        break;
      case 'ready':
        this.sendCurrentState();
        this.sendRunningTurn();
        break;
    }
  }

  handleSessionUpdate(notification: SessionNotification): void {
    const { sessionId, update } = notification;

    // Applied before the active-session check: an agent can send these while
    // a session is still being created, before it becomes the active session.
    switch (update.sessionUpdate) {
      case 'available_commands_update':
        this.sessions.applyAvailableCommands(sessionId, update.availableCommands);
        break;
      case 'config_option_update':
        this.sessions.applyConfigOptions(sessionId, update.configOptions);
        break;
      case 'session_info_update':
        this.sessions.applySessionInfoUpdate(sessionId, update);
        this.sendTitle(sessionId);
        break;
      default:
        break;
    }

    if (sessionId !== this.sessions.getActiveSessionId()) { return; }
    if (!isTextChunk(update)) {
      this.post({ type: 'sessionUpdate', update, sessionId });
      return;
    }
    const pending = this.pendingText;
    if (pending?.sessionId === sessionId && sameMessage(pending.update, update)) {
      pending.update = { ...pending.update, content: { ...pending.update.content, text: pending.update.content.text + update.content.text } };
      return;
    }
    this.sendPendingText();
    this.pendingText = { sessionId, update, timer: setTimeout(() => this.sendPendingText(), TEXT_CHUNK_WINDOW_MS) };
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

  notifyModesUpdate(modes: SessionModeState | null): void {
    this.post({ type: 'modesUpdate', modes });
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
      const response = await this.sessions.sendPrompt(activeId, text);
      this.sessions.touchHistory(activeId);
      this.endTurn(activeId, { type: 'promptEnd', stopReason: response.stopReason });
    } catch (e) {
      logError('Prompt failed', e);
      if (activeId === this.sessions.getActiveSessionId()) {
        this.post({ type: 'error', message: messageOf(e) || 'Prompt failed' });
      }
      this.endTurn(activeId, { type: 'promptEnd', stopReason: 'error' });
    }
  }

  private endTurn(sessionId: string, endMessage: Extract<ExtensionToWebviewMessage, { type: 'promptEnd' }>): void {
    this.runningTurns.delete(sessionId);
    if (sessionId !== this.sessions.getActiveSessionId()) { return; }
    this.post(endMessage);
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

  private async setMode(modeId: string): Promise<void> {
    const activeId = this.sessions.getActiveSessionId();
    if (!activeId || !modeId) { return; }
    try {
      await this.sessions.setMode(activeId, modeId);
    } catch (e) {
      logError('Failed to set mode', e);
      this.post({ type: 'error', message: `Failed to set mode: ${messageOf(e)}` });
    }
  }

  /**
   * The agent answers with every config option, which is re-sent so that
   * changes cascading from this one reach the pickers too.
   */
  private async setConfigOption(configId: string, value: string): Promise<void> {
    const activeId = this.sessions.getActiveSessionId();
    if (!activeId || !configId) { return; }
    try {
      const configOptions = await this.sessions.setConfigOption(activeId, configId, value);
      this.post({ type: 'configOptionsUpdate', configOptions });
    } catch (e) {
      logError('Failed to set config option', e);
      this.post({ type: 'error', message: `Failed to set ${configId}: ${messageOf(e)}` });
      // The webview already shows the new value; replaying the session's options rolls it back.
      this.post({
        type: 'configOptionsUpdate',
        configOptions: this.sessions.getSession(activeId)?.configOptions ?? null,
      });
    }
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
        modes: session.modes,
        configOptions: session.configOptions,
        availableCommands: session.availableCommands,
      } : null,
    });
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
    this.environment.post({ type: 'sessionUpdate', sessionId: pending.sessionId, update: pending.update });
  }
}

/** Annotations and metadata belong to their own chunk, so a chunk carrying either is never joined. */
function isTextChunk(update: SessionUpdate): update is TextChunk {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
    case 'user_message_chunk':
      return update.content.type === 'text' && !update.content.annotations && !update.content._meta && !update._meta;
    default:
      return false;
  }
}

function sameMessage(a: TextChunk, b: TextChunk): boolean {
  return a.sessionUpdate === b.sessionUpdate && (a.messageId ?? null) === (b.messageId ?? null);
}
