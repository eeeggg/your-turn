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
  PresentationTarget,
  QuestionRecord,
  SessionTabsSnapshot,
  Picker,
  PickerValueGroup,
  PlanStep as WebviewPlanStep,
  SlashCommand as WebviewSlashCommand,
  ToolCallContent as WebviewToolCallContent,
  WebviewToExtensionMessage,
} from '@/shared/WebviewMessages';
import type { SessionEnvironment, SessionInfo, SessionManager } from '@/core/sessions/Manager';
import type { SessionStateView } from '@/core/sessions/States';
import type { SessionDelivery, SessionLoad, SessionIdentity, SessionRegistration } from '@/core/sessions/UpdateHandler';
import type { CommandSource } from '@/core/AgentTerminals';
import type { ShownContent } from '@/core/CommandOutput';
import { logDebug, logError, logInfo, messageOf } from '@/core/Log';
import { openReportedChanges, openReportedFile, type FileEditor } from '@/core/ReportedFiles';
import type { DiffFile } from '@/core/ToolCallDiffs';
import type { Commands, Window } from '@/core/VsCodeApi';
import type { RetainedQuestion, SettledQuestion } from '@/core/sessions/Interactions';
import { SessionTabs } from '@/core/sessions/Tabs';
import type { SessionCommands } from '@/core/sessions/Commands';
import type { ReviewControls } from '@/core/review/ReviewControls';
import type { Reviews } from '@/core/review/Reviews';
import { resolveTranscriptFile, type FileLanding } from '@/core/TranscriptFileLinks';

/** The session operations the chat view uses. */
export type ChatSessions = Pick<
  SessionManager,
  | 'getActiveSessionId'
  | 'getActiveSession'
  | 'getSession'
  | 'sessionState'
  | 'sessionLoad'
  | 'sessionReloading'
  | 'consumeReviewOpportunity'
  | 'editComposer'
  | 'changeQueuedPrompt'
  | 'submitPrompt'
  | 'sessionToolCallDiffs'
  | 'openCommandOutput'
  | 'cancelTurn'
  | 'setMode'
  | 'setConfigOption'
  | 'hasForegroundWork'
  | 'sessionStatus'
  | 'acknowledgeCompletion'
  | 'onChanged'
  | 'interactions'
>;

/** Text arriving within this many milliseconds reaches the webview as one message, so it renders about once a frame at most. */
const TEXT_CHUNK_WINDOW_MS = 16;

type PresentedCall = Extract<Extract<Extract<ExtensionToWebviewMessage, { type: 'contentSnapshot' }>['entries'][number], { kind: 'turn' }>['parts'][number], { kind: 'toolCalls' }>['toolCalls'][number];

/** The user chose to open a file of a tool call's diffs: the `file`th across them, in the order they were reported. */
export interface DiffFileChoice {
  target: PresentationTarget;
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
  private readonly stopQuestions: () => void;

  private questionSource(interactionId: string): RetainedQuestion | undefined {
    const selected = this.sessions.getActiveSession();
    return this.disposed ? undefined : this.sessions.interactions.snapshot(selected
      ? { configuredName: selected.agentName, sessionId: selected.sessionId } : null)
      .find((question) => question.interaction.interactionId === interactionId);
  }

  private async discoverQuestion(interaction: Extract<ElicitationInteraction, { mode: 'form' }>, agentName: string, agentId: string): Promise<void> {
    const sessionId = interaction.scope.sessionId;
    const selected = this.sessions.getActiveSession();
    const session = selected?.agentId === agentId && selected.sessionId === sessionId ? selected : undefined;
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
    this.post({ type: 'questions', questions: this.presentQuestions() });
  }

  private presentQuestions(): Extract<ExtensionToWebviewMessage, { type: 'questions' }>['questions'] {
    const selected = this.sessions.getActiveSession();
    return this.sessions.interactions.snapshot(selected ? { configuredName: selected.agentName, sessionId: selected.sessionId } : null)
      .map(({ interaction, agentName, draft }) => ({ ...this.question(interaction, agentName), draft }));
  }

  private questionRecord(record: SettledQuestion): QuestionRecord {
    return { ...this.question(record.interaction, record.agentName), sessionId: record.interaction.scope.sessionId ?? '',
      response: record.response.action === 'accept' ? { action: 'accept', content: structuredClone(record.response.content ?? {}) } : { action: record.response.action } };
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
  private shownSession: SessionRegistration | undefined;
  /** The shown session's agent exited on its own, so the chat view keeps its transcript until another is shown. */
  private shownSessionEnded = false;
  private reportedRunning = false;
  private shownLoad: SessionLoad | undefined;
  private readonly imageBytes = new Map<string, number>();
  private markdownImageContext = 0;
  private markdownImageOwner: { target: PresentationTarget; registration: SessionInfo | undefined } | undefined;
  private readonly markdownImages = new Set<number>();
  private readonly markdownReads = new Map<number, AbortController>();
  private readonly localImageLoads = new ImageLoads(10000);
  private readonly networkImageLoads = new ImageLoads(30000);
  private readonly markdownSources = new Map<number, { source: string; status: 'consent' | 'loading' | 'retry' | 'done' }>();
  private projectionSequence = 0;
  private presentedCalls = new WeakMap<object, PresentedCall>();
  private projected: { snapshot: Extract<ExtensionToWebviewMessage, { type: 'contentSnapshot' }>; state: SessionStateView; registration: SessionInfo | undefined } | undefined;
  private projectionTimer: ReturnType<typeof setTimeout> | undefined;
  private presented = new WeakMap<object, Extract<ExtensionToWebviewMessage, { type: 'contentSnapshot' }>['entries'][number]
    | Extract<Extract<ExtensionToWebviewMessage, { type: 'contentSnapshot' }>['entries'][number], { kind: 'turn' }>['parts'][number]>();
  private readonly tabs: SessionTabs;
  private lastTabStatuses = new Map<string, SessionTabsSnapshot['tabs'][number]['status']>();
  private tabAnnouncementRevision = 0;
  get sessionTabs(): SessionTabs { return this.tabs; }
  notifyTabsChanged(): void { this.sendTabs(true); }
  private navigation: Pick<SessionCommands, 'selectTab' | 'closeTab'> | undefined;
  private tabReviews: Pick<Reviews, 'summary' | 'onSummaryChanged'> | undefined;
  private stopTabReviews: (() => void) | undefined;
  private reviewOpening: Pick<ReviewControls, 'turnEnded' | 'baseline' | 'deleted' | 'entered'> | undefined;
  private reviewSelection: SessionRegistration | null = null;
  private readonly reviewAttempts = new Set<Promise<void>>();

  setReviewOpening(controls: Pick<ReviewControls, 'turnEnded' | 'baseline' | 'deleted' | 'entered'>): void { this.reviewOpening = controls; }

  setTabReviews(reviews: Pick<Reviews, 'summary' | 'onSummaryChanged'>): void {
    this.stopTabReviews?.();
    this.tabReviews = reviews;
    this.stopTabReviews = reviews.onSummaryChanged(({ configuredName, sessionId }) => {
      if (this.tabs.has(configuredName, sessionId)) { this.sendTabs(); }
    });
    this.sendTabs();
  }

  reviewOpeningSettled(): Promise<void> { return Promise.all(this.reviewAttempts).then(() => {}); }

  notifyTurnEnded(registration: SessionRegistration): void {
    this.tryReviewOpening(registration, false);
  }

  private tryReviewOpening(registration: SessionRegistration, deferred: boolean): void {
    const controls = this.reviewOpening;
    if (!controls || this.disposed || this.sessions.getActiveSession() !== registration) { return; }
    const identity = { configuredName: registration.agentName, sessionId: registration.sessionId };
    if (this.sessions.sessionLoad(identity)) { return; }
    const revision = this.sessions.sessionState(identity)?.reviewOpportunity;
    if (revision == null) { return; }
    const current = () => !this.disposed && this.sessions.getActiveSession() === registration
      && registration.agentName === identity.configuredName && this.sessions.sessionState(identity)?.reviewOpportunity === revision;
    const attempt = controls.turnEnded(registration, current, deferred).then((outcome) => {
      if (outcome !== 'invalidated' && current()) { this.sessions.consumeReviewOpportunity(identity, revision); }
    }).catch((error: unknown) => logError("Showing the turn's change failed", error));
    this.reviewAttempts.add(attempt);
    void attempt.then(() => this.reviewAttempts.delete(attempt));
  }

  setTabNavigation(navigation: Pick<SessionCommands, 'selectTab' | 'closeTab'>): void {
    this.navigation = navigation;
  }
  private readonly turnListeners = new Set<TurnListener>();
  private disposed = false;
  private disposal: Promise<void> | undefined;
  private readonly stopActivity: () => void;

  constructor(
    private readonly sessions: ChatSessions,
    private readonly environment: ChatViewEnvironment,
    private readonly editor: FileEditor & {
      transcriptLanding?(path: string, fragment: string): PromiseLike<FileLanding | undefined>;
      warnFileOpen?(message: string): void;
    },
    private readonly workspace?: Pick<SessionEnvironment, 'workspaceRoots'>,
    private readonly imageNetwork?: ImageNetwork,
    tabs = new SessionTabs(),
  ) {
    this.tabs = tabs;
    this.stopQuestions = sessions.interactions.subscribe((created) => {
      this.sendQuestions();
      this.sendTabs(false, true);
      if (created && !this.environment.visible && this.questionSource(created.interaction.interactionId)) {
        void this.discoverQuestion(created.interaction, created.agentName, created.agentId);
      }
    });
    this.stopActivity = sessions.onChanged((retiredSource, promptOwner, foregroundOrigin) => {
      const activeId = sessions.getActiveSessionId();
      const registration = sessions.getActiveSession();
      if (foregroundOrigin && (registration?.agentId !== foregroundOrigin.sourceId
        || registration.agentName !== foregroundOrigin.identity.configuredName || registration.sessionId !== foregroundOrigin.identity.sessionId)) {
        this.sendTabs();
        return;
      }
      const retired = activeId !== null && retiredSource !== undefined && registration?.agentId === retiredSource;
      if (retiredSource === undefined) { this.sendContentPatch(); }
      const running = this.hasRunningTurn;
      if (running !== this.reportedRunning) {
        this.sendContentPatch();
        this.setTurnInProgress(running);
        if (!retired) {
          this.post(promptOwner && promptOwner === registration
            ? { type: running ? 'promptStart' : 'promptEnd' }
            : { type: 'foregroundActivity', running });
        }
      }
      this.sendTabs();
    });
  }

  /** Hears whether the shown session's turn is running each time that is set: a turn starting or ending, or a switch. */
  addTurnListener(listener: TurnListener): void {
    this.turnListeners.add(listener);
  }

  /** Whether the active session has foreground work. */
  get hasRunningTurn(): boolean {
    const session = this.sessions.getActiveSession();
    return session !== undefined && this.sessions.hasForegroundWork({ configuredName: session.agentName, sessionId: session.sessionId });
  }

  /** Unsent prompts retained by the selected session. */
  get queuedPrompts(): number {
    const selected = this.sessions.getActiveSession();
    return selected ? this.sessions.sessionState({ configuredName: selected.agentName, sessionId: selected.sessionId })?.queue.length ?? 0 : 0;
  }

  async handleMessage(message: WebviewToExtensionMessage): Promise<void> {
    if (this.disposed) { return; }
    switch (message.type) {
      case 'queueChanged':
        if (this.currentTarget(message.target)) {
          this.sessions.changeQueuedPrompt(message.target, message.target.generation, message.change);
          this.sendContentPatch();
        }
        break;
      case 'composerEdited':
        if (this.currentTarget(message.target)) {
          this.sessions.editComposer(message.target, message.target.generation, message.revision, message.text);
        }
        break;
      case 'contentSnapshotRequested':
        if (this.projected && samePresentationTarget(message.target, this.projected.snapshot.target)) { this.sendContentSnapshot(); }
        break;
      case 'loadMarkdownImage':
        if (this.currentMarkdownContext(message.context)) {
          const slot = this.markdownSources.get(message.occurrence);
          if (slot && (slot.status === 'consent' || slot.status === 'retry')) {
            await this.loadMarkdownSource(message.context, message.occurrence, slot);
          }
        }
        break;
      case 'markdownImageContext': {
        const registration = this.sessions.getActiveSession();
        if (registration === this.projected?.registration && this.currentTarget(message.target)) {
          this.markdownImageOwner = { target: message.target, registration };
          this.post({ type: 'markdownImageContext', target: message.target, context: this.markdownImageContext,
            ...(this.environment.imageRequestOrigin ? { origin: this.environment.imageRequestOrigin() } : {}) });
        }
        break;
      }
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
        if (message.target === null || this.currentTarget(message.target)) {
          this.sessions.interactions.edit(message.interactionId, message.target, message.draft);
        }
        break;
      case 'questionResponse':
        {
          if (message.target !== null && !this.currentTarget(message.target)) { break; }
          const result = this.sessions.interactions.respond(message.interactionId, message.target, { action: message.action, ...(message.content === undefined ? {} : { content: message.content }) });
          if (result.kind === 'invalid') { this.post({ type: 'questionErrors', interactionId: message.interactionId, errors: { ...result.errors } }); }
        }
        break;
      case 'sendPrompt':
        if (!this.currentTarget(message.target)) { break; }
        await this.sendPrompt(message.target, message.text);
        break;
      case 'cancelTurn':
        if (!this.currentTarget(message.target)) { break; }
        await this.cancelTurn();
        break;
      case 'pickerValueChosen':
        if (!this.currentTarget(message.target)) { break; }
        logDebug('Picker value selected', { pickerId: message.pickerId, value: message.value });
        await this.choosePickerValue(message.pickerId, message.value);
        break;
      case 'ready':
        this.resetMarkdownImages();
        logInfo('Chat view ready');
        this.setTurnInProgress(this.hasRunningTurn);
        this.rememberTabStatuses(this.presentTabs());
        this.sendContentSnapshot(true);
        break;
      case 'openFile':
        await this.chooseDiffFile({ target: message.target, toolCallId: message.toolCallId, file: message.file, open: 'file' });
        break;
      case 'openTranscriptFile':
        await this.openTranscriptFile(message.target, message.destination);
        break;
      case 'openChanges':
        await this.chooseDiffFile({ target: message.target, toolCallId: message.toolCallId, file: message.file, open: 'changes' });
        break;
    }
  }

  /** Open File or Open Changes of a file of the shown session's tool call, chosen in the chat view or its context menu. */
  async chooseDiffFile(choice: DiffFileChoice): Promise<void> {
    if (!this.currentTarget(choice.target)) { return; }
    await this.openDiffFile(choice);
  }

  openCommandOutput(target: PresentationTarget, source: CommandSource, name: string): boolean {
    return this.currentTarget(target) && this.sessions.openCommandOutput(target, source, name);
  }

  private async openTranscriptFile(target: PresentationTarget | null | undefined, destination: string): Promise<void> {
    if (!target || typeof destination !== 'string' || !this.currentTarget(target)) { return; }
    const registration = this.sessions.getActiveSession();
    if (registration !== this.projected?.registration) { return; }
    const tabs = this.tabs.snapshot();
    const owner = registration ?? tabs.tabs.find((tab) => tab.tabId === tabs.selectedTabId);
    const current = () => this.sessions.getActiveSession() === registration && this.currentTarget(target);
    try {
      const { path, fragment } = resolveTranscriptFile(destination, owner?.cwd);
      const review = registration && this.reviewOpening;
      const deleted = review?.deleted(path);
      if (!deleted && !await this.editor.exists(path)) { throw new Error('File not found or not a file'); }
      if (!current()) { return; }
      const landing = fragment && !deleted ? await this.editor.transcriptLanding?.(path, fragment) : undefined;
      if (!current()) { return; }
      if (review?.baseline(path) !== undefined) {
        await review.entered(path, current, landing);
      } else {
        await this.editor.open(path, landing);
      }
    } catch (error) {
      const reason = messageOf(error);
      if (current()) { this.editor.warnFileOpen?.(`Could not open ${destination}${reason ? `: ${reason}` : ''}`); }
    }
  }

  private currentTarget(target: PresentationTarget): boolean {
    if (this.disposed) { return false; }
    const issued = this.projected?.snapshot.target;
    if (!issued || !samePresentationTarget(target, issued)) { return false; }
    const tabs = this.tabs.snapshot();
    const selected = this.sessions.getActiveSession() ?? tabs.tabs.find((tab) => tab.tabId === tabs.selectedTabId);
    return selected?.agentName === target.configuredName && selected.sessionId === target.sessionId
      && this.sessions.sessionState(target)?.generation === target.generation;
  }

  private async openDiffFile(choice: Omit<DiffFileChoice, 'target'>): Promise<void> {
    const tabs = this.tabs.snapshot();
    const owner = this.sessions.getActiveSession() ?? tabs.tabs.find((tab) => tab.tabId === tabs.selectedTabId);
    const retained = owner && this.sessions.sessionState({ configuredName: owner.agentName, sessionId: owner.sessionId });
    const reported = retained
      ? this.sessions.sessionToolCallDiffs({ configuredName: owner.agentName, sessionId: owner.sessionId }, choice.toolCallId, owner.cwd)?.flat()[choice.file]?.reported
      : undefined;
    if (!reported || (choice.open === 'changes' && reported.lines === null)) { return; }
    try {
      await (choice.open === 'file' ? openReportedFile : openReportedChanges)(reported, this.editor);
    } catch (e) {
      logError(`Failed to open ${reported.path}`, e);
    }
  }

  handleSessionUpdate({ input: { origin, update }, registration }: SessionDelivery): void {
    if (this.disposed) { return; }
    const { sessionId } = origin.identity;
    const session = this.sessions.getSession(origin.identity);
    if (!session || session !== registration) { return; }
    const selected = session === this.sessions.getActiveSession();
    switch (update.kind) {
    case 'foreground': {
        if (selected) {
          this.sendContentPatch();
          const running = this.hasRunningTurn;
          if (this.reportedRunning !== running) {
            this.setTurnInProgress(running);
            this.post({ type: 'foregroundActivity', running });
          }
        }
        this.sendTabs();
        return;
      }
      case 'sessionInfo':
        this.tabs.update(session);
        this.sendTabs();
        if (selected) {
          this.post({ type: 'sessionInfoUpdate', title: session.title ?? null });
        }
        break;
      default:
        break;
    }

    if (!selected) { return; }
    if (this.sessions.sessionState(origin.identity) && contentUpdate(update)) {
      if (this.projected?.snapshot.target.configuredName !== origin.identity.configuredName || this.projected.snapshot.target.sessionId !== sessionId) {
        this.sendContentSnapshot();
        return;
      }
      if (update.kind === 'agentText' || update.kind === 'thoughtText' || update.kind === 'promptText') {
        this.projectionTimer ??= setTimeout(() => { this.projectionTimer = undefined; this.sendContentPatch(); }, TEXT_CHUNK_WINDOW_MS);
      } else { this.sendContentPatch(); }
      return;
    }
    if (update.kind === 'commands') { this.post({ type: 'commands', commands: update.commands.map(slashCommand) }); }
    if (update.kind === 'configOptions' || update.kind === 'currentMode') { this.sendPickers(sessionId); }
  }

  /** Only the successful-open event commits a reference and its selection. */
  notifySessionOpened(registration: SessionRegistration): void {
    const session = this.sessions.getSession({ configuredName: registration.agentName, sessionId: registration.sessionId });
    if (this.disposed || session !== registration) { return; }
    this.tabs.open(session);
    this.sendTabs();
  }

  /** Tell the webview the active session changed. */
  notifyActiveSessionChanged(): void {
    const selected = this.sessions.getActiveSession();
    if (selected !== this.shownSession) {
      this.setTurnInProgress(this.hasRunningTurn);
      // The chat view clears the transcript, unless it has no session to show and keeps the one whose agent exited.
      if (selected || !this.shownSessionEnded) {
        this.imageBytes.clear();
        this.resetMarkdownImages();
        this.shownSessionEnded = false;
      }
    }
    this.sendContentSnapshot(true);
    if ((selected ?? null) !== this.reviewSelection) {
      this.reviewSelection = selected ?? null;
      if (selected) { this.tryReviewOpening(selected, true); }
    }
  }

  /** The session is gone, whether its agent exited or the user disconnected it. */
  notifySessionRemoved(registration: SessionRegistration): void {
    if (registration === this.markdownImageOwner?.registration) {
      for (const read of this.markdownReads.values()) { read.abort(); }
      this.markdownReads.clear();
    }
    if (registration === this.shownSession && this.sessions.sessionReloading({
      configuredName: registration.agentName, sessionId: registration.sessionId,
    })) {
      this.notifyActiveSessionChanged();
    }
    this.sendTabs();
  }

  /**
   * The session's agent exited on its own, ending any turn in it. Called before the session is dropped, so the chat
   * view keeps the transcript and shows why.
   */
  notifySessionEnded(registration: SessionRegistration, reason: string): void {
    this.sendTabs();
    if (registration === this.shownSession && registration === this.sessions.getActiveSession()) {
      this.sendContentPatch();
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
  notifyLoadSessionStart(load: SessionLoad): void {
    if (load.registration !== this.sessions.getActiveSession()) { return; }
    this.shownLoad = load;
    this.imageBytes.clear();
    this.resetMarkdownImages();
    this.post({ type: 'loadSessionStart' });
  }

  /** The replay finished, successfully or not. */
  notifyLoadSessionEnd(load: SessionLoad, ok: boolean): boolean {
    if (this.shownLoad !== load) { return false; }
    this.shownLoad = undefined;
    const current = this.sessions.getSession({ configuredName: load.registration.agentName, sessionId: load.registration.sessionId });
    if (current && current !== load.registration) { return false; }
    const active = this.sessions.getActiveSession();
    if (active && active !== load.registration) { return false; }
    this.sendContentSnapshot();
    this.post({ type: 'loadSessionEnd', ok });
    this.sendActivity();
    if (ok) { this.tryReviewOpening(load.registration, true); }
    return true;
  }

  /** Clear the transcript, as when a new session starts. */
  clearTranscript(): void {
    this.imageBytes.clear();
    this.resetMarkdownImages();
    this.post({ type: 'clearTranscript' });
  }

  dispose(): Promise<void> {
    if (this.disposal) { return this.disposal; }
    this.disposed = true;
    if (this.projectionTimer) { clearTimeout(this.projectionTimer); }
    this.stopActivity();
    this.stopTabReviews?.();
    this.imageBytes.clear();
    this.resetMarkdownImages();
    this.turnListeners.clear();
    this.stopQuestions();
    this.disposal = this.reviewOpeningSettled();
    return this.disposal;
  }

  private async sendPrompt(target: PresentationTarget, text: string): Promise<void> {
    try {
      await this.sessions.submitPrompt({ configuredName: target.configuredName, sessionId: target.sessionId }, target.generation, text);
    } catch (e) {
      logError('Prompt failed', e);
    }
  }

  private sendActivity(): void {
    const running = this.hasRunningTurn;
    if (running) { this.post({ type: 'foregroundActivity', running }); }
    this.setTurnInProgress(running);
  }

  private async cancelTurn(): Promise<void> {
    const session = this.sessions.getActiveSession();
    if (!session) { return; }
    try {
      await this.sessions.cancelTurn({ configuredName: session.agentName, sessionId: session.sessionId });
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
    const session = this.sessions.getActiveSession();
    if (!activeId || !session || !value) { return; }
    const isConfigOption = (session.configOptions?.length ?? 0) > 0;
    try {
      if (isConfigOption) {
        await this.sessions.setConfigOption({ configuredName: session.agentName, sessionId: session.sessionId }, pickerId, value);
        if (this.sessions.getActiveSession() !== session) { return; }
        this.sendPickers(activeId);
      } else {
        // The session reports the new mode, which re-sends the pickers (notifyPickersChanged).
        await this.sessions.setMode({ configuredName: session.agentName, sessionId: session.sessionId }, value);
      }
    } catch (e) {
      if (this.sessions.getActiveSession() !== session) { return; }
      logError(isConfigOption ? 'Failed to set config option' : 'Failed to set mode', e);
      this.post({ type: 'error', message: `Failed to set ${isConfigOption ? pickerId : 'mode'}: ${messageOf(e)}` });
      this.sendPickers(activeId);
    }
  }

  private sendPickers(sessionId: string): void {
    const session = this.sessions.getActiveSession();
    if (sessionId !== this.sessions.getActiveSessionId() || !session) { return; }
    this.post({ type: 'pickers', pickers: pickersOf(session) });
  }

  private currentState(): Extract<ExtensionToWebviewMessage, { type: 'viewSnapshot' }>['state'] {
    const activeId = this.sessions.getActiveSessionId();
    const session = this.sessions.getActiveSession();
    this.shownSession = session;
    return {
      activeSessionId: activeId,
      session: session ? {
        sessionId: session.sessionId,
        agentName: session.agentDisplayName,
        ...(session.title !== undefined ? { title: session.title } : {}),
        cwd: session.cwd,
        pickers: pickersOf(session),
        commands: session.availableCommands.map(slashCommand),
      } : null,
    };
  }

  private sendTabs(includeEmpty = false, statusOnly = false): void {
    const navigation = this.tabs.snapshot();
    const selected = navigation.tabs.find((tab) => tab.tabId === navigation.selectedTabId);
    if (selected) {
      const identity = { configuredName: selected.agentName, sessionId: selected.sessionId };
      if (this.sessions.sessionStatus(identity) === 'completed') { this.sessions.acknowledgeCompletion(identity); }
    }
    const snapshot = this.presentTabs(navigation);
    if (!includeEmpty && snapshot.tabs.length === 0) { return; }
    const previous = this.lastTabStatuses;
    if (statusOnly && snapshot.tabs.every((tab) => previous.get(tab.tabId) === tab.status)) { return; }
    this.rememberTabStatuses(snapshot);
    this.post({ type: 'sessionTabs', ...snapshot });
    const announced = snapshot.tabs.flatMap(({ tabId, title, agentName, status }) => {
      if (previous.get(tabId) === status) { return []; }
      const message = status === 'needsInput' ? 'Needs your input' : status === 'failed' ? 'Interrupted or failed'
        : status === 'completed' ? 'Finished' : undefined;
      return message ? [`${title || agentName}: ${message}.`] : [];
    });
    if (announced.length > 0) {
      this.post({ type: 'sessionTabAnnouncement', revision: ++this.tabAnnouncementRevision, text: announced.join(' ') });
    }
  }

  private rememberTabStatuses(snapshot: SessionTabsSnapshot): void {
    this.lastTabStatuses = new Map(snapshot.tabs.map(({ tabId, status }) => [tabId, status]));
  }

  private presentTabs(snapshot = this.tabs.snapshot()): SessionTabsSnapshot {
    const additionalDirectories = this.workspace?.workspaceRoots().additionalDirectories ?? [];
    return {
      selectedTabId: snapshot.selectedTabId,
      tabs: snapshot.tabs.map((tab) => {
        const identity = { configuredName: tab.agentName, sessionId: tab.sessionId };
        const review = this.tabReviews?.summary(identity);
        const status = this.sessions.sessionStatus(identity);
        return {
          tabId: tab.tabId, title: tab.title ?? null, agentName: tab.agentDisplayName,
          cwd: tab.cwd, additionalDirectories: [...additionalDirectories],
          review: { modified: review?.modified ?? false, created: review?.created ?? false, deleted: review?.deleted ?? false },
          status: status === 'completed' && tab.tabId === snapshot.selectedTabId ? 'quiet' : status,
        };
      }),
    };
  }

  private currentMarkdownContext(context: number): boolean {
    const owner = this.markdownImageOwner;
    if (!owner || context !== this.markdownImageContext) { return false; }
    const active = this.sessions.getActiveSession();
    if (active) { return active === owner.registration && this.sessions.sessionState(owner.target)?.generation === owner.target.generation; }
    const target = this.projected?.snapshot.target;
    return this.shownSessionEnded && target?.configuredName === owner.target.configuredName
      && target.sessionId === owner.target.sessionId && target.generation === owner.target.generation;
  }

  private async loadMarkdownSource(context: number, occurrence: number, slot: { source: string; status: 'consent' | 'loading' | 'retry' | 'done' }, announce = true): Promise<void> {
    slot.status = 'loading';
    const cancellation = new AbortController();
    this.markdownReads.set(occurrence, cancellation);
    if (announce) { this.post({ type: 'markdownImage', context, occurrence, src: null, status: 'loading' }); }
    try {
      const remote = /^https:/i.test(slot.source);
      const registration = this.markdownImageOwner?.registration;
      const root = registration === this.sessions.getActiveSession() ? registration?.cwd : undefined;
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
    this.markdownImageOwner = undefined;
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
  private toolCallContent(sessionId: string, toolCallId: string, content: readonly ShownContent[], retainedOwner?: SessionIdentity & { cwd: string }): WebviewToolCallContent[] {
    const imageBudgetKey = imageKey('tool', toolCallId);
    this.imageBytes.delete(imageBudgetKey);
    const showsDiffs = this.environment.showsToolCallDiffs();
    const registration = this.sessions.getActiveSession();
    const owner = retainedOwner ?? (registration && { configuredName: registration.agentName, sessionId, cwd: registration.cwd });
    const shown = showsDiffs && owner ? this.sessions.sessionToolCallDiffs(owner, toolCallId, owner.cwd) ?? [] : [];
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
    this.reportedRunning = inProgress;
    void this.environment.executeCommand('setContext', 'your-turn.turnInProgress', inProgress);
    for (const listener of this.turnListeners) { listener(inProgress); }
  }

  private post(message: ExtensionToWebviewMessage): void {
    if (this.disposed) { return; }
    this.environment.post(message);
  }

  private sendContentSnapshot(view = false): void {
    const publish = (content: Extract<ExtensionToWebviewMessage, { type: 'contentSnapshot' }> | null) => {
      if (view) {
        const selected = this.sessions.getActiveSession();
        this.shownLoad = selected && this.sessions.sessionLoad({ configuredName: selected.agentName, sessionId: selected.sessionId });
        this.post({ type: 'viewSnapshot', state: this.currentState(), tabs: this.presentTabs(),
          running: this.hasRunningTurn, loading: this.shownLoad !== undefined,
          questions: this.presentQuestions(), content });
      } else if (content) { this.post(content); }
    };
    const tabs = this.tabs.snapshot();
    const registration = this.sessions.getActiveSession();
    const owner = registration ?? tabs.tabs.find((tab) => tab.tabId === tabs.selectedTabId);
    if (!owner) { publish(null); return; }
    const state = this.sessions.sessionState({ configuredName: owner.agentName, sessionId: owner.sessionId });
    if (!state) { publish(null); return; }
    const images = this.markdownImageOwner;
    if (images && (images.target.configuredName !== owner.agentName || images.target.sessionId !== owner.sessionId
      || images.target.generation !== state.generation || (registration && registration !== images.registration))) {
      this.resetMarkdownImages();
    }
    this.presented = new WeakMap();
    this.presentedCalls = new WeakMap();
    for (const key of this.imageBytes.keys()) {
      if (!key.startsWith('["markdown",')) { this.imageBytes.delete(key); }
    }
    if (this.projectionTimer) { clearTimeout(this.projectionTimer); this.projectionTimer = undefined; }
    const snapshot: Extract<ExtensionToWebviewMessage, { type: 'contentSnapshot' }> = {
      type: 'contentSnapshot', target: { configuredName: owner.agentName, sessionId: owner.sessionId, generation: state.generation, projection: ++this.projectionSequence },
      markdownImageEpoch: this.markdownImageContext,
      revision: 0, entries: this.presentContent(state, owner), currentTurn: state.content.currentTurn,
      composer: { ...state.composer },
      queue: state.queue.map((entry) => ({ ...entry })),
      nextId: state.content.nextId, usage: state.usage,
      terminals: [...state.terminals].map(([terminalId, terminal]) => ({ terminalId, ...terminal })),

    };
    this.projected = { state, snapshot, registration };
    publish(snapshot);
  }

  private sendContentPatch(): void {
    if (this.projectionTimer) { clearTimeout(this.projectionTimer); this.projectionTimer = undefined; }
    const previous = this.projected;
    const registration = this.sessions.getActiveSession();
    if (!previous || previous.snapshot.target.sessionId !== registration?.sessionId || previous.snapshot.target.configuredName !== registration.agentName) { return; }
    const state = this.sessions.sessionState({ configuredName: registration.agentName, sessionId: registration.sessionId });
    if (!state || state === previous.state) { return; }
    if (state.generation !== previous.snapshot.target.generation) { this.sendContentSnapshot(); return; }
    const entries = this.presentContent(state, registration);
    const patches = [...contentPatches(previous.snapshot.entries, entries)];
    for (const [terminalId, terminal] of state.terminals) {
      const before = previous.state.terminals.get(terminalId);
      if (before?.text !== terminal.text || before.truncated !== terminal.truncated || before.exitStatus !== terminal.exitStatus) {
        patches.push({ kind: 'terminal', terminalId, ...terminal });
      }
    }
    const revision = previous.snapshot.revision + 1;
    const snapshot = { ...previous.snapshot, composer: { ...state.composer },
      queue: state.queue.map((entry) => ({ ...entry })),
      entries, revision, currentTurn: state.content.currentTurn, nextId: state.content.nextId, usage: state.usage,
      terminals: [...state.terminals].map(([terminalId, terminal]) => ({ terminalId, ...terminal })) };
    this.projected = { ...previous, state, snapshot };
    this.post({ type: 'contentPatch', target: snapshot.target, base: previous.snapshot.revision, revision, patches,
      currentTurn: snapshot.currentTurn, nextId: snapshot.nextId, usage: snapshot.usage,
      ...(state.composer === previous.state.composer ? {} : { composer: snapshot.composer }),
      ...(state.queue === previous.state.queue ? {} : { queue: snapshot.queue }) });
  }

  private presentContent(state: SessionStateView, owner: { agentName: string; sessionId: string; cwd: string }): Extract<ExtensionToWebviewMessage, { type: 'contentSnapshot' }>['entries'] {
    const imageKeys = new Set<string>();
    for (const entry of state.content.entries) {
      if (entry.kind === 'promptImage') { imageKeys.add(imageKey('prompt', entry.messageId)); }
      if (entry.kind !== 'turn') { continue; }
      for (const part of entry.parts) {
        if (part.kind === 'image') { imageKeys.add(imageKey('agent', part.messageId)); }
        if (part.kind === 'thought' && part.image) { imageKeys.add(imageKey('thought', part.messageId)); }
        if (part.kind === 'toolCalls') {
          for (const call of part.toolCalls) {
            if (call.content.some((item) => item.kind === 'image')) { imageKeys.add(imageKey('tool', call.toolCallId)); }
          }
        }
      }
    }
    for (const key of this.imageBytes.keys()) {
      if (!key.startsWith('["markdown",') && !imageKeys.has(key)) { this.imageBytes.delete(key); }
    }
    type Entry = Extract<ExtensionToWebviewMessage, { type: 'contentSnapshot' }>['entries'][number];
    type Part = Extract<Entry, { kind: 'turn' }>['parts'][number];
    const presentPart = (part: Extract<SessionStateView['content']['entries'][number], { kind: 'turn' }>['parts'][number], ended: boolean): Part => {
      const cached = this.presented.get(part);
      if (cached && !('id' in cached) && !(part.kind === 'toolCalls' && cached.kind === 'toolCalls'
        && cached.collapsed !== (ended && part.toolCalls.length > 3))) { return cached; }
      let shown: Part;
      switch (part.kind) {
        case 'question': shown = { kind: 'question', record: this.questionRecord(part.record), open: false }; break;
        case 'message': shown = part; break;
        case 'thought': {
          const image = part.image && this.boundedImage(imageKey('thought', part.messageId), part.image.data, part.image.mimeType, part.image.reference);
          shown = { kind: 'thought', messageId: part.messageId, text: part.text, startedAt: part.startedAt, endedAt: part.endedAt,
          open: part.endedAt === null, ...(part.markdownRevision !== undefined ? { markdownRevision: part.markdownRevision } : {}),
          ...(image ? { imageSrc: image.src, ...(image.reference ? { imageReference: true } : {}), ...(image.fallback ? { imageFallback: image.fallback } : {}) } : {}),
        }; break;
        }
        case 'image': shown = { kind: 'image', messageId: part.messageId, ...this.boundedImage(imageKey('agent', part.messageId), part.data, part.mimeType, part.reference) }; break;
        case 'plan': shown = { kind: 'plan', steps: part.steps.map(planStep) }; break;
        case 'compaction': shown = { ...part, open: part.status !== 'completed' }; break;
        case 'toolCalls': shown = { kind: 'toolCalls', collapsed: ended && part.toolCalls.length > 3, toolCalls: part.toolCalls.map((call) => {
          const cached = this.presentedCalls.get(call);
          if (cached) { return cached; }
          const content = call.toolKind === 'execute' ? call.content.filter((item) => item.kind !== 'text') : call.content;
          const shown = { ...call, open: call.status === 'failed', content: this.toolCallContent(owner.sessionId, call.toolCallId, content,
            { configuredName: owner.agentName, sessionId: owner.sessionId, cwd: owner.cwd }) };
          this.presentedCalls.set(call, shown);
          return shown;
        }) }; break;
      }
      this.presented.set(part, shown);
      return shown;
    };
    return state.content.entries.map((entry): Entry => {
      const cached = this.presented.get(entry);
      if (cached && 'id' in cached) { return cached; }
      let shown: Entry;
      switch (entry.kind) {
        case 'question': shown = { kind: 'question', id: entry.id, record: this.questionRecord(entry.record), open: false }; break;
        case 'error':
        case 'prompt': shown = entry; break;
        case 'promptImage': shown = { kind: 'promptImage', id: entry.id, messageId: entry.messageId, text: '',
          ...this.boundedImage(imageKey('prompt', entry.messageId), entry.data, entry.mimeType, entry.reference) }; break;
        case 'turn': shown = { kind: 'turn', id: entry.id, parts: entry.parts.map((part) => presentPart(part, entry.id !== state.content.currentTurn)) }; break;
        case 'compaction': shown = { ...entry, open: entry.status !== 'completed' }; break;
      }
      this.presented.set(entry, shown);
      return shown;
    });
  }

}

function samePresentationTarget(a: PresentationTarget, b: PresentationTarget): boolean {
  return a.configuredName === b.configuredName && a.sessionId === b.sessionId && a.generation === b.generation && a.projection === b.projection;
}

function contentUpdate(update: SessionUpdate): boolean {
  return ['agentText', 'thoughtText', 'promptText', 'agentMessage', 'thoughtMessage', 'promptMessage', 'agentRichMessage', 'thoughtRichMessage', 'promptRichMessage',
    'agentImage', 'thoughtImage', 'promptImage', 'toolCall', 'plan', 'usage', 'compactionUpdate', 'compactionSummaryChunk'].includes(update.kind);
}

function contentPatches(
  before: Extract<ExtensionToWebviewMessage, { type: 'contentSnapshot' }>['entries'],
  after: Extract<ExtensionToWebviewMessage, { type: 'contentSnapshot' }>['entries'],
): Extract<ExtensionToWebviewMessage, { type: 'contentPatch' }>['patches'] {
  const patches: Extract<ExtensionToWebviewMessage, { type: 'contentPatch' }>['patches'][number][] = [];
  for (let index = 0; index < after.length; index++) {
    const next = after[index];
    const previous = before[index];
    if (!next || next === previous) { continue; }
    if (!previous) { patches.push({ kind: 'insert', index, entries: after.slice(index) }); break; }
    if (next.id !== previous.id) {
      let end = after.length;
      let oldEnd = before.length;
      while (end > index && oldEnd > index && after[end - 1] === before[oldEnd - 1]) { end--; oldEnd--; }
      patches.push({ kind: 'spliceEntries', index, remove: oldEnd - index, entries: after.slice(index, end) });
      return patches;
    }
    if (next.kind !== 'turn' || previous.kind !== 'turn' || next.id !== previous.id) { patches.push({ kind: 'replace', id: previous.id, entry: next }); continue; }
    let start = 0;
    while (start < next.parts.length && next.parts[start] === previous.parts[start]) { start++; }
    if (start === next.parts.length && next.parts.length === previous.parts.length) { continue; }
    const oldPart = previous.parts[start];
    const newPart = next.parts[start];
    if (oldPart?.kind === 'toolCalls' && newPart?.kind === 'toolCalls' && oldPart.collapsed === newPart.collapsed
      && oldPart.toolCalls.length === newPart.toolCalls.length
      && oldPart.toolCalls.every((call, index) => call.toolCallId === newPart.toolCalls[index]?.toolCallId)
      && next.parts.length === previous.parts.length && next.parts.slice(start + 1).every((part, offset) => part === previous.parts[start + 1 + offset])) {
      for (let index = 0; index < newPart.toolCalls.length; index++) {
        const call = newPart.toolCalls[index];
        if (call && call !== oldPart.toolCalls[index]) { patches.push({ kind: 'toolCall', turnId: next.id, part: start, call }); }
      }
      continue;
    }
    if (oldPart && newPart && (oldPart.kind === 'message' || oldPart.kind === 'thought') && newPart.kind === oldPart.kind
      && newPart.messageId === oldPart.messageId && newPart.text.startsWith(oldPart.text)
      && (oldPart.kind !== 'thought' || (newPart.kind === 'thought' && oldPart.startedAt === newPart.startedAt && oldPart.endedAt === newPart.endedAt
        && oldPart.imageSrc === newPart.imageSrc && oldPart.open === newPart.open))
      && newPart.markdownRevision === oldPart.markdownRevision && next.parts.length === previous.parts.length
      && next.parts.slice(start + 1).every((part, offset) => part === previous.parts[start + 1 + offset])) {
      patches.push({ kind: 'appendText', turnId: next.id, part: start, text: newPart.text.slice(oldPart.text.length) });
    } else {
      let end = next.parts.length;
      let oldEnd = previous.parts.length;
      while (end > start && oldEnd > start && next.parts[end - 1] === previous.parts[oldEnd - 1]) { end--; oldEnd--; }
      patches.push({ kind: 'spliceParts', turnId: next.id, index: start, remove: oldEnd - start, parts: next.parts.slice(start, end) });
    }
  }
  if (after.length < before.length) { patches.push({ kind: 'spliceEntries', index: after.length, remove: before.length - after.length, entries: [] }); }
  return patches;
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
