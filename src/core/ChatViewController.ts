import { imageSize } from 'image-size';
import { readMarkdownImage } from '@/core/MarkdownImageFiles';
import { ImageLoads } from '@/core/ImageLoads';
import { fetchMarkdownImage, type ImageNetwork } from '@/core/MarkdownImageNetwork';
import type {
  ConfigOption,
  ConfigValueGroup,
  ElicitationInteraction,
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
import type { SessionEnvironment, SessionInfo, SessionManager } from '@/core/SessionManager';
import type { AgentTerminals } from '@/core/AgentTerminals';
import { CommandOutputFeed, type ShownContent } from '@/core/CommandOutputFeed';
import { logDebug, logError, logInfo, messageOf } from '@/core/Log';
import { openReportedChanges, openReportedFile, type FileEditor } from '@/core/ReportedFiles';
import { ToolCallDiffs, type DiffFile } from '@/core/ToolCallDiffs';
import type { Commands, Window } from '@/core/VsCodeApi';
import type { ElicitationInteractions } from '@/core/ClientHandlers';
import { SessionTabs } from '@/core/SessionTabs';
import type { SessionCommands } from '@/core/SessionCommands';

/** The session operations the chat view uses. */
export type ChatSessions = Pick<
  SessionManager,
  | 'getActiveSessionId'
  | 'getSession'
  | 'sendPrompt'
  | 'cancelTurn'
  | 'setMode'
  | 'setConfigOption'
  | 'recordTurnEnded'
  | 'applyAvailableCommands'
  | 'applyConfigOptions'
  | 'applyCurrentMode'
  | 'applySessionInfoUpdate'
  | 'applyForegroundState'
  | 'beginPrompt'
  | 'endPrompt'
  | 'clearActivity'
  | 'hasForegroundWork'
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
  readonly visible: boolean;
  showInformationMessage: Window['showInformationMessage'];
  reveal(): PromiseLike<void>;
  /** Deliver a webview message; dropped while the chat view is not open. */
  post(message: ExtensionToWebviewMessage): void;
  /** The `your-turn.showToolCallDiffs` setting, read for each tool call update. */
  showsToolCallDiffs(): boolean;
  imageRequestOrigin?(): string;
}

/**
 * The extension's side of the chat view: answers webview messages, runs turns
 * against the active session, and tells the webview what to show, translating
 * the ACP drivers' session updates into the webview's contract. What the contract has no place for is dropped here.
 * The webview sends one prompt at a time and queues the rest.
 */
export class ChatViewController {
  private readonly elicitationSources = new Map<ElicitationInteractions, { agentName: string; agentId: string; unsubscribe: () => void }>();
  private readonly questionDrafts = new Map<string, Extract<WebviewToExtensionMessage, { type: 'questionDraft' }>['draft']>();
  private readonly questionOrder = new Map<string, number>();
  private nextQuestionOrder = 0;

  attachElicitations(agentName: string, interactions: ElicitationInteractions, agentId: string): () => void {
    const unsubscribe = interactions.subscribe((change) => {
      const { interaction, response } = change;
      if (change.kind === 'created') { this.questionOrder.set(interaction.interactionId, this.nextQuestionOrder++); }
      if (change.kind === 'responded' && interaction.mode === 'form' && interaction.scope.sessionId !== undefined && response
        && this.ownsQuestion(interaction, agentId)) {
        this.postAbout(interaction.scope.sessionId, {
          type: 'questionSettled',
          record: {
            ...this.question(interaction, agentName), sessionId: interaction.scope.sessionId,
            response: response.action === 'accept' ? { action: 'accept', content: structuredClone(response.content ?? {}) } : { action: response.action },
          },
        });
      }
      if (change.kind === 'responded' || change.kind === 'withdrawn' || change.kind === 'closed') {
        this.questionDrafts.delete(change.interaction.interactionId);
        this.questionOrder.delete(change.interaction.interactionId);
      }
      this.sendQuestions();
      if (change.kind === 'created' && interaction.mode === 'form' && !this.environment.visible
        && this.questionSource(interaction.interactionId)) {
        void this.discoverQuestion(interaction, agentName);
      }
    });
    this.elicitationSources.set(interactions, { agentName, agentId, unsubscribe });
    for (const interaction of interactions.snapshot()) { this.questionOrder.set(interaction.interactionId, this.nextQuestionOrder++); }
    this.sendQuestions();
    return () => {
      unsubscribe();
      this.elicitationSources.delete(interactions);
      for (const interaction of interactions.snapshot()) {
        this.questionDrafts.delete(interaction.interactionId);
        this.questionOrder.delete(interaction.interactionId);
      }
      if (this.elicitationSources.size === 0) { this.post({ type: 'questions', questions: [] }); }
      else { this.sendQuestions(); }
    };
  }

  private questionSource(interactionId: string): ElicitationInteractions | undefined {
    if (this.disposed) { return undefined; }
    for (const [source, { agentId }] of this.elicitationSources) {
      if (source.snapshot().some((interaction) => interaction.interactionId === interactionId && interaction.mode === 'form'
        && interaction.status === 'pending' && this.ownsQuestion(interaction, agentId))) {
        return source;
      }
    }
    return undefined;
  }

  private ownsQuestion(interaction: ElicitationInteraction, agentId: string): boolean {
    const sessionId = interaction.scope.sessionId;
    return sessionId === undefined || (sessionId === this.sessions.getActiveSessionId()
      && this.sessions.getSession(sessionId)?.agentId === agentId);
  }

  private async discoverQuestion(interaction: Extract<ElicitationInteraction, { mode: 'form' }>, agentName: string): Promise<void> {
    const sessionId = interaction.scope.sessionId;
    const session = sessionId === undefined ? undefined : this.sessions.getSession(sessionId);
    const label = sessionId === undefined ? '' : ` for ${session?.title ?? sessionId}`;
    try {
      const choice = await this.environment.showInformationMessage(`${agentName} has a question${label}.`, 'Open');
      if (choice !== 'Open' || !this.questionSource(interaction.interactionId)) { return; }
      await this.environment.reveal();
      if (!this.questionSource(interaction.interactionId)) { return; }
      this.sendQuestions();
      this.post({ type: 'questionOpen', interactionId: interaction.interactionId });
    } catch (error) {
      logError('Failed to open question', error);
    }
  }

  private sendQuestions(): void {
    if (this.elicitationSources.size === 0) { return; }
    const questions: Extract<ExtensionToWebviewMessage, { type: 'questions' }>['questions'] = [];
    for (const [source, { agentName, agentId }] of this.elicitationSources) {
      for (const interaction of source.snapshot()) {
        if (interaction.mode !== 'form' || interaction.status !== 'pending'
          || !this.ownsQuestion(interaction, agentId)) { continue; }
        questions.push({ ...this.question(interaction, agentName), draft: this.questionDrafts.get(interaction.interactionId) ?? null });
      }
    }
    questions.sort((a, b) => (this.questionOrder.get(a.interactionId) ?? 0) - (this.questionOrder.get(b.interactionId) ?? 0));
    this.post({ type: 'questions', questions });
  }

  private question(interaction: Extract<ElicitationInteraction, { mode: 'form' }>, agentName: string): Omit<Extract<ExtensionToWebviewMessage, { type: 'questions' }>['questions'][number], 'draft'> {
    return {
      interactionId: interaction.interactionId, agentName, sessionId: interaction.scope.sessionId ?? null,
      message: interaction.message, title: interaction.form.title, description: interaction.form.description,
      fields: interaction.form.fields.map((field) => ({
        name: field.name, title: field.title, description: field.description, required: field.required,
        kind: field.type === 'string' ? 'text' : field.type === 'array' ? 'multiple' : field.type,
        choices: field.choices?.map((choice) => ({ ...choice })) ?? null,
        minimum: field.minimum, maximum: field.maximum, minLength: field.minLength, maxLength: field.maxLength,
        minItems: field.minItems, maxItems: field.maxItems, pattern: field.pattern, format: field.format,
        ...(field.default === undefined ? {} : { default: typeof field.default === 'object' ? [...field.default] : field.default }),
      })),
    };
  }
  /** The session the chat view was last told about; reporting the same one again would split its running turn. */
  private shownSessionId: string | null = null;
  /** The shown session's agent exited on its own, so the chat view keeps its transcript until another is shown. */
  private shownSessionEnded = false;
  private readonly imageBytes = new Map<string, number>();
  private markdownImageContext = 0;
  private markdownImageSession: string | null = null;
  private readonly markdownImages = new Set<number>();
  private readonly markdownReads = new Map<number, AbortController>();
  private readonly localImageLoads = new ImageLoads(10000);
  private readonly networkImageLoads = new ImageLoads(30000);
  private readonly markdownSources = new Map<number, { source: string; status: 'consent' | 'loading' | 'retry' | 'done' }>();
  private _queuedPrompts = 0;
  /** Text not yet posted, sent when its window closes or before anything else is posted. */
  private pendingText: { message: TextMessage; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly commandOutput: CommandOutputFeed;
  private readonly diffs = new ToolCallDiffs();
  private readonly tabs = new SessionTabs();
  get sessionTabs(): SessionTabs { return this.tabs; }
  notifyTabsChanged(): void { this.sendTabs(true); }
  private navigation: Pick<SessionCommands, 'selectTab' | 'closeTab'> | undefined;

  setTabNavigation(navigation: Pick<SessionCommands, 'selectTab' | 'closeTab'>): void {
    this.navigation = navigation;
  }
  private readonly turnListeners = new Set<TurnListener>();
  private disposed = false;
  private disposal: Promise<void> | undefined;

  constructor(
    private readonly sessions: ChatSessions,
    private readonly environment: ChatViewEnvironment,
    private readonly editor: FileEditor,
    private readonly terminals: AgentTerminals,
    private readonly workspace?: Pick<SessionEnvironment, 'workspaceRoots'>,
    private readonly imageNetwork?: ImageNetwork,
  ) {
    this.commandOutput = new CommandOutputFeed(terminals, {
      toolCallContent: (sessionId, toolCallId, content) => {
        if (!this.disposed && sessionId === this.sessions.getActiveSessionId()) {
          this.post({ type: 'toolCall', toolCallId, content: this.toolCallContent(sessionId, toolCallId, content) });
        }
      },
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
    if (this.disposed) { return; }
    switch (message.type) {
      case 'loadMarkdownImage':
        if (this.currentMarkdownContext(message.context)) {
          const slot = this.markdownSources.get(message.occurrence);
          if (slot && (slot.status === 'consent' || slot.status === 'retry')) {
            await this.loadMarkdownSource(message.context, message.occurrence, slot);
          }
        }
        break;
      case 'markdownImageContext':
        if (message.sessionId === this.sessions.getActiveSessionId()) {
          if (message.sessionId !== this.markdownImageSession) {
            this.resetMarkdownImages();
            this.markdownImageSession = message.sessionId;
          }
          this.post({ type: 'markdownImageContext', sessionId: message.sessionId, context: this.markdownImageContext,
            ...(this.environment.imageRequestOrigin ? { origin: this.environment.imageRequestOrigin() } : {}) });
        }
        break;
      case 'resolveMarkdownImage':
        if (this.currentMarkdownContext(message.context) && !this.markdownImages.has(message.occurrence)) {
          this.markdownImages.add(message.occurrence);
          if (/^https:/i.test(message.source)) {
            try {
              const url = new URL(message.source);
              if (url.username || url.password) { throw new Error('Image URL credentials are not allowed'); }
              this.markdownSources.set(message.occurrence, { source: message.source, status: 'consent' });
              this.post({ type: 'markdownImage', context: message.context, occurrence: message.occurrence, src: null, status: 'consent' });
            } catch {
              this.post({ type: 'markdownImage', context: message.context, occurrence: message.occurrence, src: null, fallback: 'Invalid image URL or URL credentials' });
            }
            break;
          }
          const source = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(message.source);
          const image = source
            ? this.boundedImage(imageKey('markdown', String(message.occurrence)), source[2] ?? '', (source[1] ?? '').toLowerCase())
            : { src: null, fallback: /^data:/i.test(message.source) ? 'Invalid image data URI' : 'Image source not supported' };
          if (!/^data:|^https?:/i.test(message.source)) {
            const slot = { source: message.source, status: 'loading' as const };
            this.markdownSources.set(message.occurrence, slot);
            await this.loadMarkdownSource(message.context, message.occurrence, slot, false);
            break;
          }
          this.post({ type: 'markdownImage', context: message.context, occurrence: message.occurrence, ...image });
        }
        break;
      case 'releaseMarkdownImage':
        if (this.currentMarkdownContext(message.context)) {
          this.markdownImages.delete(message.occurrence);
          this.markdownSources.delete(message.occurrence);
          this.markdownReads.get(message.occurrence)?.abort();
          this.markdownReads.delete(message.occurrence);
          this.imageBytes.delete(imageKey('markdown', String(message.occurrence)));
        }
        break;
      case 'selectSessionTab':
        await this.navigation?.selectTab(message.tabId);
        break;
      case 'closeSessionTab':
        await this.navigation?.closeTab(message.tabId);
        break;
      case 'questionDraft':
        if (this.questionSource(message.interactionId)) { this.questionDrafts.set(message.interactionId, structuredClone(message.draft)); }
        break;
      case 'questionResponse':
        {
          const source = this.questionSource(message.interactionId);
          if (!source) { break; }
          const result = source.respond(message.interactionId, { action: message.action, ...(message.content === undefined ? {} : { content: message.content }) });
          if (result.kind === 'invalid') { this.post({ type: 'questionErrors', interactionId: message.interactionId, errors: { ...result.errors } }); }
        }
        break;
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
        logDebug('Picker value selected', { pickerId: message.pickerId, value: message.value });
        await this.choosePickerValue(message.pickerId, message.value);
        break;
      case 'ready':
        this.resetMarkdownImages();
        logInfo('Chat view ready');
        this._queuedPrompts = 0;
        this.sendCurrentState();
        this.sendTabs(true);
        this.sendRunningTurn();
        this.setTurnInProgress(this.hasRunningTurn);
        this.sendQuestions();
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

  handleSessionUpdate(sessionId: string, update: SessionUpdate, agentId?: string): void {
    if (this.disposed) { return; }
    // Applied before the active-session check: an agent can send these while
    // a session is still being created, before it becomes the active session.
    switch (update.kind) {
      case 'foreground': {
        const wasRunning = this.isRunning(sessionId);
        this.sessions.applyForegroundState(sessionId, update.state, agentId);
        const running = this.isRunning(sessionId);
        if (sessionId === this.sessions.getActiveSessionId() && wasRunning !== running) {
          this.setTurnInProgress(running);
          this.post({ type: 'foregroundActivity', running });
        }
        this.sendTabs();
        return;
      }
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
        {
          const session = this.sessions.getSession(sessionId);
          if (session) { this.tabs.update(session); }
          this.sendTabs();
        }
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

  /** Only the successful-open event commits a reference and its selection. */
  notifySessionOpened(sessionId: string): void {
    const session = this.sessions.getSession(sessionId);
    if (!session || this.disposed) { return; }
    this.tabs.open(session);
    this.sendTabs();
  }

  /** Tell the webview the active session changed. */
  notifyActiveSessionChanged(): void {
    const changed = this.sessions.getActiveSessionId() !== this.shownSessionId;
    this.sendCurrentState();
    this.sendQuestions();
    if (changed) {
      this.sendRunningTurn();
      this.setTurnInProgress(this.isRunning(this.shownSessionId));
      // The chat view clears the transcript, unless it has no session to show and keeps the one whose agent exited.
      if (this.shownSessionId !== null || !this.shownSessionEnded) {
        this.imageBytes.clear();
        this.resetMarkdownImages();
        this.shownSessionEnded = false;
        this.terminals.forgetEndedSessions();
      }
    }
  }

  /** The session is gone, whether its agent exited or the user disconnected it. */
  notifySessionRemoved(sessionId: string): void {
    if (sessionId === this.markdownImageSession) {
      for (const read of this.markdownReads.values()) { read.abort(); }
      this.markdownReads.clear();
    }
    this.sessions.clearActivity(sessionId);
    this.sendTabs();
    this.commandOutput.forgetSession(sessionId);
    this.diffs.forgetSession(sessionId);
  }

  /**
   * The session's agent exited on its own, ending any turn in it. Called before the session is dropped, so the chat
   * view keeps the transcript and shows why.
   */
  notifySessionEnded(sessionId: string, reason: string): void {
    this.sessions.clearActivity(sessionId);
    this.sendTabs();
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
    if (sessionId !== this.sessions.getActiveSessionId()) { return; }
    this.imageBytes.clear();
    this.resetMarkdownImages();
    this.diffs.forgetSession(sessionId);
    this.post({ type: 'loadSessionStart' });
  }

  /** The replay finished, successfully or not. */
  notifyLoadSessionEnd(ok: boolean): void {
    this.post({ type: 'loadSessionEnd', ok });
    this.sendActivity();
  }

  /** Clear the transcript, as when a new session starts. */
  clearTranscript(): void {
    this.imageBytes.clear();
    this.resetMarkdownImages();
    this.terminals.forgetEndedSessions();
    this.post({ type: 'clearTranscript' });
  }

  dispose(): Promise<void> {
    if (this.disposal) { return this.disposal; }
    this.disposed = true;
    if (this.pendingText) { clearTimeout(this.pendingText.timer); }
    this.pendingText = null;
    this.imageBytes.clear();
    this.resetMarkdownImages();
    this.turnListeners.clear();
    for (const source of this.elicitationSources.values()) { source.unsubscribe(); }
    this.elicitationSources.clear();
    this.questionDrafts.clear();
    this.questionOrder.clear();
    this.disposal = this.commandOutput.dispose();
    return this.disposal;
  }

  private async sendPrompt(text: string): Promise<void> {
    const activeId = this.sessions.getActiveSessionId();
    if (!activeId) {
      this.post({ type: 'error', message: 'No active session. Create a session first.' });
      return;
    }

    const submission = this.sessions.beginPrompt(activeId);
    this.sendTabs();
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
    const wasRunning = this.isRunning(activeId);
    this.sessions.endPrompt(activeId, submission);
    this.sendTabs();
    if (activeId !== this.sessions.getActiveSessionId()) { return; }
    if (wasRunning && !this.isRunning(activeId)) { this.endTurn(activeId); }
  }

  private endTurn(sessionId: string): void {
    if (sessionId !== this.sessions.getActiveSessionId()) { return; }
    this.setTurnInProgress(false);
    this.post({ type: 'promptEnd' });
  }

  private isRunning(sessionId: string | null): boolean {
    return sessionId !== null && this.sessions.hasForegroundWork(sessionId);
  }

  private sendRunningTurn(): void {
    if (this.isRunning(this.shownSessionId)) {
      this.post({ type: 'foregroundActivity', running: true });
    }
  }

  private sendActivity(): void {
    const running = this.hasRunningTurn;
    if (running) { this.post({ type: 'foregroundActivity', running }); }
    this.setTurnInProgress(running);
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

  private sendTabs(includeEmpty = false): void {
    const snapshot = this.tabs.snapshot();
    if (!includeEmpty && snapshot.tabs.length === 0) { return; }
    const additionalDirectories = this.workspace?.workspaceRoots().additionalDirectories ?? [];
    this.post({
      type: 'sessionTabs', selectedTabId: snapshot.selectedTabId,
      tabs: snapshot.tabs.map((tab) => ({
        tabId: tab.tabId, title: tab.title ?? null, agentName: tab.agentDisplayName,
        cwd: tab.cwd, additionalDirectories: [...additionalDirectories],
        running: this.sessions.getSession(tab.sessionId)?.agentName === tab.agentName && this.isRunning(tab.sessionId),
      })),
    });
  }

  /** The webview message for a session update to the active session, or null when the contract has no place for it. */
  private translate(sessionId: string, update: SessionUpdate): ExtensionToWebviewMessage | null {
    switch (update.kind) {
      case 'agentText':
        return { type: 'agentText', messageId: update.messageId, text: update.text };
      case 'agentImage': {
        return { type: 'agentImage', messageId: update.messageId, ...this.boundedImage(imageKey('agent', update.messageId), update.data, update.mimeType, update.reference) };
      }
      case 'thoughtImage':
        return { type: 'thoughtImage', messageId: update.messageId, ...this.boundedImage(imageKey('thought', update.messageId), update.data, update.mimeType, update.reference) };
      case 'promptImage':
        return { type: 'promptImage', messageId: update.messageId, ...this.boundedImage(imageKey('prompt', update.messageId), update.data, update.mimeType, update.reference) };
      case 'thoughtText':
        return { type: 'thoughtText', messageId: update.messageId, text: update.text };
      case 'promptText':
        return { type: 'promptText', messageId: update.messageId, text: update.text };
      case 'agentMessage':
        this.imageBytes.delete(imageKey('agent', update.messageId));
        return { type: 'agentMessage', messageId: update.messageId, text: update.text };
      case 'agentRichMessage':
      case 'thoughtRichMessage':
      case 'promptRichMessage': {
        const key = imageKey(update.kind === 'agentRichMessage' ? 'agent' : update.kind === 'thoughtRichMessage' ? 'thought' : 'prompt', update.messageId);
        this.imageBytes.delete(key);
        return { type: update.kind, messageId: update.messageId, content: update.content.map((block) => block.kind === 'text'
          ? { kind: 'text', text: block.text }
          : { kind: 'image', ...this.boundedImage(key, block.data, block.mimeType, block.reference) }) };
      }
      case 'thoughtMessage':
        this.imageBytes.delete(imageKey('thought', update.messageId));
        return { type: 'thoughtMessage', messageId: update.messageId, text: update.text };
      case 'promptMessage':
        this.imageBytes.delete(imageKey('prompt', update.messageId));
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
      case 'compactionUpdate':
        return {
          type: 'compactionUpdate',
          compactionId: update.compactionId,
          status: update.status,
          summary: update.summary.present ? { present: true, value: update.summary.value } : { present: false },
          error: update.error.present ? { present: true, value: update.error.value } : { present: false },
        };
      case 'compactionSummaryChunk':
        return { type: 'compactionSummaryChunk', compactionId: update.compactionId, content: update.content };
      case 'usage':
        return {
          type: 'usage',
          usage: {
            used: update.used,
            size: update.size,
            cost: update.cost ? { amount: update.cost.amount, currency: update.cost.currency } : null,
          },
        };
      case 'configOptions':
      case 'currentMode': {
        const session = this.sessions.getSession(sessionId);
        return session ? { type: 'pickers', pickers: pickersOf(session) } : null;
      }
      case 'sessionInfo':
      case 'foreground':
      case 'terminal':
      case 'terminalOutput':
        return null;
    }
  }

  private currentMarkdownContext(context: number): boolean {
    return context === this.markdownImageContext && this.markdownImageSession !== null
      && (this.markdownImageSession === this.sessions.getActiveSessionId() || this.shownSessionEnded);
  }

  private async loadMarkdownSource(context: number, occurrence: number, slot: { source: string; status: 'consent' | 'loading' | 'retry' | 'done' }, announce = true): Promise<void> {
    slot.status = 'loading';
    const cancellation = new AbortController();
    this.markdownReads.set(occurrence, cancellation);
    if (announce) { this.post({ type: 'markdownImage', context, occurrence, src: null, status: 'loading' }); }
    try {
      const remote = /^https:/i.test(slot.source);
      const root = this.sessions.getSession(this.markdownImageSession ?? '')?.cwd;
      const result = await (remote ? this.networkImageLoads : this.localImageLoads).run(cancellation.signal, (signal) => remote
        ? fetchMarkdownImage(slot.source, signal, this.imageNetwork) : readMarkdownImage(root, slot.source, signal));
      if (!this.currentMarkdownContext(context) || cancellation.signal.aborted || this.markdownSources.get(occurrence) !== slot) { return; }
      const image = this.boundedImage(imageKey('markdown', String(occurrence)), result.data, result.mimeType);
      slot.status = image.src ? 'done' : 'retry';
      this.post({ type: 'markdownImage', context, occurrence, ...image, ...(image.src ? {} : { status: 'retry' as const }) });
    } catch (error) {
      if (!this.currentMarkdownContext(context) || cancellation.signal.aborted || this.markdownSources.get(occurrence) !== slot) { return; }
      slot.status = 'retry';
      this.post({ type: 'markdownImage', context, occurrence, src: null, fallback: error instanceof Error ? error.message : 'Could not load image', status: 'retry' });
    } finally {
      if (this.markdownReads.get(occurrence) === cancellation) { this.markdownReads.delete(occurrence); }
    }
  }

  private resetMarkdownImages(): void {
    for (const read of this.markdownReads.values()) { read.abort(); }
    this.markdownReads.clear();
    this.markdownSources.clear();
    for (const occurrence of this.markdownImages) {
      this.imageBytes.delete(imageKey('markdown', String(occurrence)));
    }
    this.markdownImages.clear();
    this.markdownImageSession = null;
    this.markdownImageContext++;
  }

  private boundedImage(key: string, data: string, mimeType: string, reference?: true): { src: string | null; fallback?: string; reference?: true } {
    if (reference) { return { src: null, reference: true }; }
    const src = imageSource(data, mimeType);
    if (src.src === null) { return src; }
    const bytes = Buffer.byteLength(data, 'base64');
    const total = [...this.imageBytes.values()].reduce((sum, size) => sum + size, 0);
    if (total + bytes > 50 * 1024 * 1024) { return { src: null, fallback: 'Session image budget exceeded' }; }
    this.imageBytes.set(key, (this.imageBytes.get(key) ?? 0) + bytes);
    return src;
  }

  /** The tool call's content as the contract has it; its diffs' files as shown, only while `your-turn.showToolCallDiffs` is on. */
  private toolCallContent(sessionId: string, toolCallId: string, content: readonly ShownContent[]): WebviewToolCallContent[] {
    const imageBudgetKey = imageKey('tool', toolCallId);
    this.imageBytes.delete(imageBudgetKey);
    const showsDiffs = this.environment.showsToolCallDiffs();
    const diffs = showsDiffs ? content.flatMap((item) => (item.kind === 'diff' ? [item.diff] : [])) : [];
    const shown = this.diffs.shown(sessionId, toolCallId, diffs, this.sessions.getSession(sessionId)?.cwd ?? null);
    let next = 0;
    return content.flatMap((item): WebviewToolCallContent[] => {
      switch (item.kind) {
        case 'text':
          return [{ kind: 'text', text: item.text }];
        case 'image':
          return [{ kind: 'image', ...this.boundedImage(imageBudgetKey, item.data, item.mimeType, item.reference) }];
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
   * Shows the Cancel button in the chat view's title bar and disables the review's buttons (`your-turn.turnInProgress` in
   * package.json), and tells the listeners.
   */
  private setTurnInProgress(inProgress: boolean): void {
    void this.environment.executeCommand('setContext', 'your-turn.turnInProgress', inProgress);
    for (const listener of this.turnListeners) { listener(inProgress); }
  }

  /** Posts what came late about a session, which matters only while the chat view shows it. */
  private postAbout(sessionId: string, message: ExtensionToWebviewMessage): void {
    if (sessionId === this.sessions.getActiveSessionId()) {
      this.post(message);
    }
  }

  private post(message: ExtensionToWebviewMessage): void {
    if (this.disposed) { return; }
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

function imageKey(kind: string, id: string | null): string {
  return JSON.stringify([kind, id]);
}

function imageSource(data: string, mimeType: string): { src: string | null; fallback?: string } {
  const types: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
  const type = types[mimeType];
  if (!type) { return { src: null, fallback: 'Unsupported image format' }; }
  if (data.length > Math.ceil((10 * 1024 * 1024) / 3) * 4) { return { src: null, fallback: 'Image exceeds 10 MiB payload limit' }; }
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) { return { src: null, fallback: 'Invalid image data' }; }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > 10 * 1024 * 1024) { return { src: null, fallback: 'Image exceeds 10 MiB payload limit' }; }
  if (bytes.length === 0 || bytes.toString('base64') !== data) { return { src: null, fallback: 'Invalid image data' }; }
  try {
    const size = imageSize(bytes);
    if (!Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width <= 0 || size.height <= 0) { return { src: null, fallback: 'Invalid image dimensions' }; }
    if (!size.type) { return { src: null, fallback: 'Invalid image data' }; }
    if (size.type !== type) { return { src: null, fallback: 'Image MIME type does not match its bytes' }; }
    if (size.width > 16384 || size.height > 16384 || size.width * size.height > 40_000_000) { return { src: null, fallback: 'Image exceeds dimension or pixel limit' }; }
    return { src: `data:${mimeType};base64,${data}` };
  } catch {
    return { src: null, fallback: 'Invalid image data' };
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
