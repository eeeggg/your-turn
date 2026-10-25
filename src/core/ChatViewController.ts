import type {
  ConfigOption,
  ConfigValueGroup,
  PlanStep,
  SessionUpdate,
  SlashCommand,
} from '@/core/acp/AcpDriver';
import type {
  DiffFile as WebviewDiffFile,
  ExtensionToWebviewMessage,
  Picker,
  PickerValueGroup,
  PlanStep as WebviewPlanStep,
  SlashCommand as WebviewSlashCommand,
  ToolCallContent as WebviewToolCallContent,
  WebviewToExtensionMessage,
} from '@/shared/WebviewMessages';
import type { SessionInfo, SessionManager } from './SessionManager';
import type { AgentTerminals } from './AgentTerminals';
import { CommandOutputFeed, type ShownContent } from './CommandOutputFeed';
import { logError, messageOf } from './Log';
import { openReportedChanges, openReportedFile, type FileEditor } from './ReportedFiles';
import { ToolCallDiffs, type DiffFile } from './ToolCallDiffs';
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
  | 'recordTurnEnded'
  | 'applyAvailableCommands'
  | 'applyConfigOptions'
  | 'applyCurrentMode'
  | 'applySessionInfoUpdate'
>;

/** Text arriving within this many milliseconds reaches the webview as one message, so it renders about once a frame at most. */
const TEXT_CHUNK_WINDOW_MS = 16;

type TextMessage = Extract<ExtensionToWebviewMessage, { type: 'agentText' | 'thoughtText' | 'promptText' }>;

/** The user chose to open a file of a tool call's diffs: the `file`th across them, in the order they were reported. */
export interface DiffFileChoice {
  toolCallId: string;
  file: number;
  /** Open File, or Open Changes in VS Code's diff editor. */
  open: 'file' | 'changes';
}

type TurnListener = (inProgress: boolean) => void;

/** What the chat view needs from the editor it runs in. */
export interface ChatViewEnvironment extends Commands {
  /** Deliver a webview message; dropped while the chat view is not open. */
  post(message: ExtensionToWebviewMessage): void;
  /** The `acp.showToolCallDiffs` setting, read for each tool call update. */
  showsToolCallDiffs(): boolean;
}

/**
 * The extension's side of the chat view: answers webview messages, runs turns
 * against the active session, and tells the webview what to show, translating
 * the ACP drivers' session updates into the webview's contract. What the contract has no place for is dropped here.
 * The webview sends one prompt at a time and queues the rest.
 */
export class ChatViewController {
  /**
   * Sessions with a prompt in flight. The chat view hears of a turn only while its session is shown, and is told
   * it is running when it opens or shows that session again, so it holds its next prompt.
   */
  private readonly runningTurns = new Set<string>();
  /** The session the chat view was last told about; reporting the same one again would split its running turn. */
  private shownSessionId: string | null = null;
  /** The shown session's agent exited on its own, so the chat view keeps its transcript until another is shown. */
  private shownSessionEnded = false;
  private _queuedPrompts = 0;
  /** Text not yet posted, sent when its window closes or before anything else is posted. */
  private pendingText: { message: TextMessage; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly commandOutput: CommandOutputFeed;
  private readonly diffs = new ToolCallDiffs();
  private readonly turnListeners = new Set<TurnListener>();

  constructor(
    private readonly sessions: ChatSessions,
    private readonly environment: ChatViewEnvironment,
    private readonly editor: FileEditor,
    private readonly terminals: AgentTerminals,
  ) {
    this.commandOutput = new CommandOutputFeed(terminals, {
      toolCallContent: (sessionId, toolCallId, content) =>
        this.postAbout(sessionId, { type: 'toolCall', toolCallId, content: this.toolCallContent(sessionId, toolCallId, content) }),
      terminal: (sessionId, terminalId, { text, truncated }, exitStatus) =>
        this.postAbout(sessionId, {
          type: 'terminal',
          terminalId,
          text,
          truncated,
          exitStatus: exitStatus && { exitCode: exitStatus.exitCode, signal: exitStatus.signal },
        }),
    });
  }

  /** Hears whether the shown session's turn is running each time that is set: a turn starting or ending, or a switch. */
  addTurnListener(listener: TurnListener): void {
    this.turnListeners.add(listener);
  }

  /** Whether the active session has a prompt in flight. */
  get hasRunningTurn(): boolean {
    return this.isRunning(this.sessions.getActiveSessionId());
  }

  /** The prompts the chat view holds until the turn ends, which a switch of session discards. */
  get queuedPrompts(): number {
    return this._queuedPrompts;
  }

  async handleMessage(message: WebviewToExtensionMessage): Promise<void> {
    switch (message.type) {
      case 'sendPrompt':
        await this.sendPrompt(message.text);
        break;
      case 'cancelTurn':
        await this.cancelTurn();
        break;
      case 'queuedPrompts':
        this._queuedPrompts = message.count;
        break;
      case 'pickerValueChosen':
        await this.choosePickerValue(message.pickerId, message.value);
        break;
      case 'ready':
        this._queuedPrompts = 0;
        this.sendCurrentState();
        this.sendRunningTurn();
        break;
      case 'openFile':
        await this.chooseDiffFile({ toolCallId: message.toolCallId, file: message.file, open: 'file' });
        break;
      case 'openChanges':
        await this.chooseDiffFile({ toolCallId: message.toolCallId, file: message.file, open: 'changes' });
        break;
    }
  }

  /** Open File or Open Changes of a file of the shown session's tool call, chosen in the chat view or its context menu. */
  async chooseDiffFile(choice: DiffFileChoice): Promise<void> {
    const sessionId = this.sessions.getActiveSessionId();
    const reported = sessionId === null ? undefined : this.diffs.file(sessionId, choice.toolCallId, choice.file)?.reported;
    if (!reported || (choice.open === 'changes' && reported.lines === null)) { return; }
    try {
      await (choice.open === 'file' ? openReportedFile : openReportedChanges)(reported, this.editor);
    } catch (e) {
      logError(`Failed to open ${reported.path}`, e);
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
      // The chat view clears the transcript, unless it has no session to show and keeps the one whose agent exited.
      if (this.shownSessionId !== null || !this.shownSessionEnded) {
        this.shownSessionEnded = false;
        this.terminals.forgetEndedSessions();
      }
    }
  }

  /** The session is gone, whether its agent exited or the user disconnected it. */
  notifySessionRemoved(sessionId: string): void {
    this.commandOutput.forgetSession(sessionId);
    this.diffs.forgetSession(sessionId);
  }

  /**
   * The session's agent exited on its own, ending any turn in it. Called before the session is dropped, so the chat
   * view keeps the transcript and shows why.
   */
  notifySessionEnded(sessionId: string, reason: string): void {
    this.runningTurns.delete(sessionId);
    if (sessionId === this.shownSessionId) {
      this.shownSessionEnded = true;
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
   * A `session/load` replay is starting, which reports the session's tool calls again. The webview wipes the transcript,
   * disables input, and shows a loading overlay until {@link notifyLoadSessionEnd}.
   */
  notifyLoadSessionStart(sessionId: string): void {
    this.diffs.forgetSession(sessionId);
    this.post({ type: 'loadSessionStart' });
  }

  /** The replay finished, successfully or not. */
  notifyLoadSessionEnd(ok: boolean): void {
    this.post({ type: 'loadSessionEnd', ok });
  }

  /** Clear the transcript, as when a new session starts. */
  clearTranscript(): void {
    this.terminals.forgetEndedSessions();
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
      this.sessions.recordTurnEnded(activeId);
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
        return { type: 'promptText', messageId: update.messageId, text: update.text };
      case 'agentMessage':
        return { type: 'agentMessage', messageId: update.messageId, text: update.text };
      case 'thoughtMessage':
        return { type: 'thoughtMessage', messageId: update.messageId, text: update.text };
      case 'promptMessage':
        return { type: 'promptMessage', messageId: update.messageId, text: update.text };
      case 'toolCall': {
        const content = this.commandOutput.toolCallContent(sessionId, update.toolCallId, update.toolKind, update.content);
        return {
          type: 'toolCall',
          toolCallId: update.toolCallId,
          ...(update.title !== undefined ? { title: update.title } : {}),
          ...(update.status !== undefined ? { status: update.status } : {}),
          ...(content !== undefined ? { content: this.toolCallContent(sessionId, update.toolCallId, content) } : {}),
        };
      }
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
      case 'terminal':
      case 'terminalOutput':
        return null;
    }
  }

  /** The tool call's content as the contract has it; its diffs' files as shown, only while `acp.showToolCallDiffs` is on. */
  private toolCallContent(sessionId: string, toolCallId: string, content: readonly ShownContent[]): WebviewToolCallContent[] {
    const showsDiffs = this.environment.showsToolCallDiffs();
    const diffs = showsDiffs ? content.flatMap((item) => (item.kind === 'diff' ? [item.diff] : [])) : [];
    const shown = this.diffs.shown(sessionId, toolCallId, diffs, this.sessions.getSession(sessionId)?.cwd ?? null);
    let next = 0;
    return content.flatMap((item): WebviewToolCallContent[] => {
      switch (item.kind) {
        case 'text':
          return [{ kind: 'text', text: item.text }];
        case 'commandOutput':
          return [{ kind: 'commandOutput', text: item.output.text, truncated: item.output.truncated }];
        case 'diff':
          return showsDiffs ? [{ kind: 'diff', files: (shown[next++] ?? []).map(diffFile) }] : [];
        case 'terminal':
          return [{ kind: 'terminal', terminalId: item.terminalId }];
      }
    });
  }

  /**
   * Shows the Cancel button in the chat view's title bar and disables the review's buttons (`acp.turnInProgress` in
   * package.json), and tells the listeners.
   */
  private setTurnInProgress(inProgress: boolean): void {
    void this.environment.executeCommand('setContext', 'acp.turnInProgress', inProgress);
    for (const listener of this.turnListeners) { listener(inProgress); }
  }

  /** Posts what came late about a session, which matters only while the chat view shows it. */
  private postAbout(sessionId: string, message: ExtensionToWebviewMessage): void {
    if (sessionId === this.sessions.getActiveSessionId()) {
      this.post(message);
    }
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
  return a.type === b.type && a.messageId === b.messageId;
}

function planStep(step: PlanStep): WebviewPlanStep {
  return { text: step.text, status: step.status };
}

function diffFile(file: DiffFile): WebviewDiffFile {
  return {
    operation: file.operation,
    path: file.path,
    oldPath: file.oldPath,
    added: file.added,
    removed: file.removed,
    hunks: file.hunks.map((hunk) => ({
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines: [...hunk.lines],
    })),
    note: file.note,
    opens: file.reported === null ? null : file.reported.lines === null ? 'file' : 'fileAndChanges',
  };
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
