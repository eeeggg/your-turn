import { marked } from 'marked';
import type { SessionModeState, SessionNotification } from '@agentclientprotocol/sdk';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import type { SessionManager } from './SessionManager';
import { logError } from './Log';
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

/** What a mid-turn prompt does: wait for the running turn, or go straight to the agent. */
export type MidTurnPrompt = 'queue' | 'send';

/** What the chat view needs from the editor it runs in. */
export interface ChatViewEnvironment extends Commands {
  /** Deliver a webview message; dropped while the chat view is not open. */
  post(message: ExtensionToWebviewMessage): void;
  midTurnPrompt(): MidTurnPrompt;
}

/**
 * The extension's side of the chat view: answers webview messages, runs turns
 * against the active session, and tells the webview what to show.
 */
export class ChatViewController {
  private _hasTranscript = false;
  /** Prompts sent to the agent that have not returned yet. */
  private inFlightPrompts = 0;
  /** Prompts typed during a turn that wait for that turn to finish. */
  private pendingPrompts: string[] = [];

  constructor(
    private readonly sessions: ChatSessions,
    private readonly environment: ChatViewEnvironment,
  ) {
    marked.setOptions({
      breaks: true,
      gfm: true,
    });
  }

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
      case 'executeCommand':
        if (message.command) {
          await this.environment.executeCommand(message.command);
        }
        break;
      case 'ready':
        this.sendCurrentState();
        break;
      case 'renderMarkdown':
        this.post({
          type: 'markdownRendered',
          items: message.items.map((item) => ({ id: item.id, html: this.renderMarkdown(item.text) })),
        });
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
        // The SDK's validation lets `configOptions: null` through despite its types.
        this.sessions.applyConfigOptions(sessionId, update.configOptions ?? []);
        break;
      case 'session_info_update':
        this.sessions.applySessionInfoUpdate(sessionId, update);
        this.sendTitle(sessionId);
        break;
    }

    if (sessionId !== this.sessions.getActiveSessionId()) { return; }
    this.post({ type: 'sessionUpdate', update, sessionId });
  }

  /** Tell the webview the active session changed. */
  notifyActiveSessionChanged(): void {
    this.sendCurrentState();
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

  /** Clear the transcript and drop queued prompts, as when a new session starts. */
  clearTranscript(): void {
    this.pendingPrompts = [];
    this._hasTranscript = false;
    this.post({ type: 'clearTranscript' });
  }

  private async sendPrompt(text: string): Promise<void> {
    const activeId = this.sessions.getActiveSessionId();
    if (!activeId) {
      this.post({ type: 'error', message: 'No active session. Create a session first.' });
      return;
    }

    if (this.inFlightPrompts > 0 && this.environment.midTurnPrompt() === 'queue') {
      this.pendingPrompts.push(text);
      return;
    }

    // The history store uses the first prompt as a label until the agent supplies a title.
    this.sessions.recordFirstPrompt(activeId, text);

    if (this.inFlightPrompts++ === 0) {
      this.post({ type: 'promptStart' });
      this.setTurnInProgress(true);
    }

    try {
      const response = await this.sessions.sendPrompt(activeId, text);
      this.sessions.touchHistory(activeId);
      this.finishPrompt({
        type: 'promptEnd',
        stopReason: response.stopReason,
        ...(response.usage !== undefined ? { usage: response.usage } : {}),
      });
    } catch (e: any) {
      logError('Prompt failed', e);
      this.post({ type: 'error', message: e.message || 'Prompt failed' });
      this.finishPrompt({ type: 'promptEnd', stopReason: 'error' });
    }
  }

  /**
   * End one prompt request. The webview leaves its processing state only once
   * every in-flight prompt has returned, so the quick reply to a prompt sent
   * mid-turn does not clear the spinner of the turn that is still running.
   */
  private finishPrompt(endMessage: Extract<ExtensionToWebviewMessage, { type: 'promptEnd' }>): void {
    this.inFlightPrompts = Math.max(0, this.inFlightPrompts - 1);
    if (this.inFlightPrompts > 0) {
      return;
    }
    this.post(endMessage);
    this.setTurnInProgress(false);
    const next = this.pendingPrompts.shift();
    if (next !== undefined) {
      void this.sendPrompt(next);
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
    } catch (e: any) {
      logError('Failed to set mode', e);
      this.post({ type: 'error', message: `Failed to set mode: ${e.message}` });
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
    } catch (e: any) {
      logError('Failed to set config option', e);
      this.post({ type: 'error', message: `Failed to set ${configId}: ${e.message}` });
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

  private renderMarkdown(text: string): string {
    try {
      return marked.parse(text) as string;
    } catch {
      return escapeHtml(text);
    }
  }

  private post(message: ExtensionToWebviewMessage): void {
    this.environment.post(message);
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
