import type {
  ExtensionToWebviewMessage,
  ContentVersions,
  DiffFile,
  ExitStatus,
  ImagePresentation,
  PlanStep,
  QuestionRecord,
  SessionUsage,
  ToolCallContent,
  ToolCallStatus,
  WebviewToExtensionMessage,
  PresentationTarget,
} from '@/shared/WebviewMessages';
import type { ActiveSession } from '@/webview/state/ActiveSession';
import type { Action } from '@/webview/state/RootState';
import type { Transition } from '@/webview/state/Store';

/** Entry identity within projected content; the presentation target scopes actions and patches. */
export type EntryId = number;

interface Prompt {
  readonly kind: 'prompt';
  readonly id: EntryId;
  /** The replayed prompt's agent-supplied ID; core resolves content replacement. */
  readonly messageId?: string;
  readonly text: string;
}

interface PromptImage extends Readonly<ImagePresentation> {
  readonly kind: 'promptImage';
  readonly id: EntryId;
  readonly messageId: string | null;
  readonly src: string | null;
  readonly text: '';
  readonly reference?: true;
}

/** Projected agent work, including autonomous work without a preceding prompt. */
export interface Turn {
  readonly kind: 'turn';
  readonly id: EntryId;
  /** What the agent sent, in the order it arrived. */
  readonly parts: readonly TurnPart[];
}

export type ChildCompletion = Extract<Extract<ExtensionToWebviewMessage, { type: 'contentSnapshot' }>['entries'][number], { kind: 'childCompletion' }>;

export type TurnPart = AgentMessage | AgentImage | Thought | ToolCallGroup | Plan | Compaction | SettledQuestion | ChildCompletion;

interface AgentImage extends Readonly<ImagePresentation> {
  readonly kind: 'image';
  readonly messageId: string | null;
  readonly src: string | null;
  readonly reference?: true;
}

interface SettledQuestion {
  readonly kind: 'question';
  readonly record: QuestionRecord;
  readonly open: boolean;
}

type CompactionValue = null | boolean | number | string | CompactionValue[] | { [key: string]: CompactionValue };

export interface Compaction {
  readonly kind: 'compaction';
  readonly compactionId: string;
  readonly status: string;
  readonly summary: readonly CompactionValue[];
  readonly error: string | null;
  readonly open: boolean;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  /** Replay and a terminal report without a live start cannot establish a later live duration. */
  readonly timingAllowed: boolean;
}

/** A part's current position in its turn; part-range replacements can change it. */
export type PartIndex = number;

export interface AgentMessage {
  readonly markdownRevision?: number;
  readonly kind: 'message';
  /** The agent-supplied message ID, or null; core resolves message grouping. */
  readonly messageId: string | null;
  /** Everything streamed so far, as markdown; shown once it has more than whitespace. */
  readonly text: string;
}

export interface Thought {
  readonly markdownRevision?: number;
  readonly kind: 'thought';
  /** As for an agent message. */
  readonly messageId: string | null;
  readonly text: string;
  readonly imageSrc?: string | null;
  readonly imageReference?: true;
  readonly imageFallback?: string;
  readonly startedAt: number;
  /** Null while the agent is still thinking. */
  readonly endedAt: number | null;
  readonly open: boolean;
}

/** Tool calls reported one after another, with nothing between them. */
export interface ToolCallGroup {
  readonly kind: 'toolCalls';
  readonly toolCalls: readonly ToolCall[];
  readonly collapsed: boolean;
}

export interface ToolCall {
  readonly markdownRevision?: number;
  readonly toolCallId: string;
  readonly title: string;
  readonly status: ToolCallStatus;
  readonly content: readonly ToolCallContent[];
  readonly open: boolean;
}

/** The plan projected at the position chosen by core. */
export interface Plan {
  readonly kind: 'plan';
  readonly steps: readonly PlanStep[];
}

interface TranscriptError {
  readonly kind: 'error';
  readonly id: EntryId;
  readonly text: string;
}

export type TranscriptEntry = Prompt | PromptImage | Turn | TranscriptError | ChildCompletion | ((Compaction | SettledQuestion) & { readonly id: EntryId });

/** An agent's terminal as last reported; its command runs while `exitStatus` is null. */
interface Terminal {
  readonly text: string;
  readonly truncated: boolean;
  readonly exitStatus: ExitStatus | null;
}

export interface QueuedPrompt {
  readonly revision?: number;
  readonly id: EntryId;
  readonly text: string;
  readonly open: boolean;
  readonly draft: string | null;
}

export interface TranscriptState {
  readonly toolGroupOverrides: ReadonlyMap<string, boolean>;
  readonly thoughtOverrides: ReadonlyMap<string, boolean>;
  readonly projection: { readonly target: PresentationTarget; readonly revision: number; readonly versions?: ContentVersions } | null;
  readonly markdownContext: number | null;
  readonly markdownImageEpoch: number | undefined;
  readonly markdownContextRequested: boolean;
  readonly markdownOrigin: string | null;
  readonly markdownImages: ReadonlyMap<number, { source: string; presentation: (ImagePresentation & { status?: 'consent' | 'loading' | 'retry' }) | null }>;
  /** The session the entries belong to; a `state` for any other session clears them, unless {@link sessionEnded}. */
  readonly sessionId: string | null;
  /** Its agent exited, ending the session; the entries stay through the sessionless `state` that follows, until another session replaces them. */
  readonly sessionEnded: boolean;
  readonly entries: readonly TranscriptEntry[];
  /** The session's terminals by ID, which its tool calls show, whichever was reported first. */
  readonly terminals: ReadonlyMap<string, Terminal>;
  /** The latest reported context and session cost; null until reported, retained with an ended session's transcript. */
  readonly usage: SessionUsage | null;
  readonly nextId: EntryId;
  /** The current turn selected by core, or null when no turn is open. */
  readonly currentTurn: EntryId | null;
  /** Runtime-owned queue projection, oldest first, with immediate local editing and expansion. */
  readonly queued: readonly QueuedPrompt[];
  /** Rises each time the view must follow the stream again: for each prompt the user sends, and on each clear. */
  readonly followRequests: number;
}

export type TranscriptAction =
  | { type: 'transcriptFileClicked'; target: PresentationTarget; destination: string }
  | { type: 'markdownImageLoad'; occurrence: number }
  | { type: 'markdownImageMounted'; occurrence: number; source: string }
  | { type: 'markdownImageUnmounted'; occurrence: number }
  | { type: 'questionRecordToggled'; interactionId: string; open: boolean }
  | { type: 'thoughtToggled'; turnId: EntryId; part: PartIndex; open: boolean }
  | { type: 'compactionToggled'; compactionId: string; open: boolean }
  | { type: 'toolCallToggled'; turnId: EntryId; toolCallId: string; open: boolean }
  | { type: 'toolCallsToggled'; turnId: EntryId; part: PartIndex }
  /** A diff's file link, the `file`th file across the tool call's diffs. */
  | { type: 'diffFileClicked'; toolCallId: string; file: number }
  | { type: 'sendNowChosen'; id: EntryId }
  | { type: 'steerNowChosen'; id: EntryId }
  | { type: 'queuedPromptToggled'; id: EntryId }
  | { type: 'queuedPromptEditStarted'; id: EntryId }
  | { type: 'queuedPromptEdited'; id: EntryId; text: string }
  | { type: 'queuedPromptEditSaved'; id: EntryId }
  | { type: 'queuedPromptEditDiscarded'; id: EntryId }
  | { type: 'queuedPromptCancelled'; id: EntryId };

export const initialTranscript: TranscriptState = {
  toolGroupOverrides: new Map(),
  thoughtOverrides: new Map(),
  projection: null,
  markdownContext: null,
  markdownImageEpoch: undefined,
  markdownContextRequested: false,
  markdownOrigin: null,
  markdownImages: new Map(),
  sessionId: null,
  sessionEnded: false,
  entries: [],
  terminals: new Map(),
  usage: null,
  nextId: 1,
  currentTurn: null,
  queued: [],
  followRequests: 0,
};

export const TOOL_CALL_CONTENT_LIMIT = 20_000;

/** A group of tool calls is collapsed when its turn ends with more than this many in it. */
const TOOL_CALLS_SHOWN_EXPANDED = 3;

/** Without a session, an empty transcript leaves room for the empty state, which points to the Agents view. */
export function showsEmptyState(transcript: TranscriptState, session: ActiveSession | null): boolean {
  return session === null && transcript.entries.length === 0;
}

/** Sent and replayed prompts, oldest first. Unsent queue entries are not history. */
export function promptHistory(transcript: TranscriptState): string[] {
  return transcript.entries.flatMap((entry) => entry.kind === 'prompt' && entry.text.trim() !== '' ? [entry.text] : []);
}

/** A part is drawn only once it has something to show, so whitespace before the answer leaves no trace. */
export function partShown(part: TurnPart): boolean {
  return part.kind !== 'message' || part.text.trim() !== '';
}

export function turnShown(turn: Turn): boolean {
  return turn.parts.some(partShown);
}

export function thoughtSummary(thought: Pick<Thought, 'startedAt' | 'endedAt'>): string {
  const seconds = elapsedSeconds(thought.startedAt, thought.endedAt);
  return seconds > 0 ? `Thought for ${seconds}s` : 'Thought';
}

function elapsedSeconds(start: number | null, end: number | null): number {
  return start === null || end === null ? 0 : Math.round((end - start) / 1000);
}

export function compactionSummary(compaction: Compaction): string {
  const { status, startedAt, endedAt } = compaction;
  if (status === 'in_progress') { return 'Compacting…'; }
  if (!['completed', 'failed', 'cancelled'].includes(status)) { return `Compaction — unknown status: ${status}`; }
  const seconds = elapsedSeconds(startedAt, endedAt);
  return `Compaction ${status}${seconds > 0 ? ` in ${seconds}s` : ''}`;
}

/** Adjacent text chunks are one Markdown document; non-text content retains its reported position. */
export function compactionBlocks(summary: Compaction['summary']): ({ kind: 'text'; text: string } | { kind: 'unsupported'; type: string })[] {
  const blocks: ReturnType<typeof compactionBlocks> = [];
  for (const content of summary) {
    if (content !== null && typeof content === 'object' && !Array.isArray(content) && content['type'] === 'text' && typeof content['text'] === 'string') {
      const previous = blocks.at(-1);
      if (previous?.kind === 'text') { previous.text += content['text']; }
      else { blocks.push({ kind: 'text', text: content['text'] }); }
    } else {
      const type = content !== null && typeof content === 'object' && !Array.isArray(content) && typeof content['type'] === 'string' ? content['type'] : 'unknown';
      blocks.push({ kind: 'unsupported', type });
    }
  }
  return blocks.filter((block) => block.kind !== 'text' || block.text.trim() !== '');
}

/** A command runs until its terminal says how it ended, or until its session ends first. */
type CommandStatus = 'running' | 'disconnected' | 'ended';

export type ShownBlock =
  | { readonly kind: 'text'; readonly text: string }
  | ({ readonly kind: 'image' } & Readonly<ImagePresentation>)
  /** `firstFile` is the place of its first file across the tool call's diffs, by which the extension opens a file. */
  | { readonly kind: 'diff'; readonly files: readonly DiffFile[]; readonly firstFile: number }
  /**
   * The end of a command's output, `truncated` when earlier output is not in it; `failure` says how it failed. Its
   * terminal, or null for the tool call's own text, is what Open in Terminal opens.
   */
  | {
    readonly kind: 'command';
    readonly text: string;
    readonly truncated: boolean;
    readonly status: CommandStatus;
    readonly failure: string | null;
    readonly terminalId: string | null;
  };

/** Where a tool call's content is shown: the session's terminals, and whether the session ended. */
export interface ContentContext {
  readonly terminals: ReadonlyMap<string, Terminal>;
  readonly sessionEnded: boolean;
}

/**
 * The tool call's content as shown, in the order reported: at most `TOOL_CALL_CONTENT_LIMIT` characters of text across
 * its blocks, `truncated` when there was more; commands' output, each cut already, and its terminals once reported;
 * and, only `withDiffs`, its diffs' files, cut already.
 */
export function shownContent(
  content: readonly ToolCallContent[],
  { terminals, sessionEnded }: ContentContext,
  withDiffs: boolean,
): { blocks: ShownBlock[]; truncated: boolean } {
  const blocks: ShownBlock[] = [];
  let textRoom = TOOL_CALL_CONTENT_LIMIT;
  let fileCount = 0;
  let truncated = false;
  for (const item of content) {
    if (item.kind === 'image') {
      blocks.push({ ...item });
      continue;
    }
    if (item.kind === 'commandOutput') {
      blocks.push({ kind: 'command', text: item.text, truncated: item.truncated, status: 'ended', failure: null, terminalId: null });
      continue;
    }
    if (item.kind === 'terminal') {
      const terminal = terminals.get(item.terminalId);
      if (terminal) {
        const status = commandStatus(terminal, sessionEnded);
        blocks.push({
          kind: 'command',
          text: terminal.text,
          truncated: terminal.truncated,
          status,
          failure: failure(terminal.exitStatus),
          terminalId: item.terminalId,
        });
      }
      continue;
    }
    if (item.kind === 'diff') {
      if (withDiffs) {
        blocks.push({ kind: 'diff', files: item.files, firstFile: fileCount });
        fileCount += item.files.length;
      }
      continue;
    }
    if (textRoom === 0) {
      truncated = true;
      continue;
    }
    const text = item.text.slice(0, textRoom);
    blocks.push({ kind: 'text', text });
    textRoom -= text.length;
    truncated ||= text.length < item.text.length;
  }
  return { blocks, truncated };
}

function commandStatus(terminal: Terminal, sessionEnded: boolean): CommandStatus {
  if (terminal.exitStatus !== null) {
    return 'ended';
  }
  return sessionEnded ? 'disconnected' : 'running';
}

/** Only a failure is worth saying; a command that exited 0, or whose end the agent did not explain, says nothing. */
function failure(exitStatus: ExitStatus | null): string | null {
  if (exitStatus?.signal) {
    return `Ended by ${exitStatus.signal}`;
  }
  const code = exitStatus?.exitCode ?? 0;
  return code === 0 ? null : `Exit code ${code}`;
}

export function updateTranscript(
  transcript: TranscriptState,
  action: Action,
  now: number,
  turnRunning = false,
): Transition<TranscriptState, WebviewToExtensionMessage> {
  switch (action.type) {
    case 'markdownImageLoad': {
      const image = transcript.markdownImages.get(action.occurrence);
      if (transcript.markdownContext === null || !image || !['consent', 'retry'].includes(image.presentation?.status ?? '')) { return stateOnly(transcript); }
      return { state: { ...transcript, markdownImages: new Map(transcript.markdownImages).set(action.occurrence, {
        ...image, presentation: { src: null, status: 'loading' },
      }) }, outgoing: [{ type: 'loadMarkdownImage', context: transcript.markdownContext, occurrence: action.occurrence }] };
    }
    case 'markdownImageMounted': {
      if (transcript.sessionId === null || !transcript.projection || transcript.markdownImages.has(action.occurrence)) { return stateOnly(transcript); }
      const images = new Map(transcript.markdownImages).set(action.occurrence, { source: action.source, presentation: null });
      return {
        state: { ...transcript, markdownImages: images, markdownContextRequested: true },
        outgoing: transcript.markdownContext !== null
          ? [{ type: 'resolveMarkdownImage', context: transcript.markdownContext, occurrence: action.occurrence, source: action.source }]
          : transcript.markdownContextRequested ? [] : [{ type: 'markdownImageContext', target: transcript.projection.target }],
      };
    }
    case 'markdownImageUnmounted': {
      if (!transcript.markdownImages.has(action.occurrence)) { return stateOnly(transcript); }
      const images = new Map(transcript.markdownImages);
      images.delete(action.occurrence);
      return { state: { ...transcript, markdownImages: images }, outgoing: transcript.markdownContext === null ? []
        : [{ type: 'releaseMarkdownImage', context: transcript.markdownContext, occurrence: action.occurrence }] };
    }
    case 'markdownImageContext': {
      const target = transcript.projection?.target;
      if (action.target.projection !== target?.projection || action.target.generation !== target.generation
        || action.target.sessionId !== target.sessionId || action.target.configuredName !== target.configuredName
        || !transcript.markdownContextRequested || transcript.markdownContext !== null) { return stateOnly(transcript); }
      return { state: { ...transcript, markdownContext: action.context, markdownOrigin: action.origin ?? null }, outgoing: [...transcript.markdownImages].map(([occurrence, image]) => ({
        type: 'resolveMarkdownImage', context: action.context, occurrence, source: image.source,
      })) };
    }
    case 'markdownImage': {
      const image = transcript.markdownImages.get(action.occurrence);
      if (action.context !== transcript.markdownContext || !image) { return stateOnly(transcript); }
      return stateOnly({ ...transcript, markdownImages: new Map(transcript.markdownImages).set(action.occurrence, {
        source: image.source, presentation: { src: action.src, ...(action.fallback ? { fallback: action.fallback } : {}), ...(action.status ? { status: action.status } : {}) },
      }) });
    }
    case 'questionRecordToggled': {
      const revise = <T extends SettledQuestion>(question: T): T => question.record.interactionId === action.interactionId && question.open !== action.open ? { ...question, open: action.open } : question;
      return stateOnly({ ...transcript, entries: transcript.entries.map((entry) => entry.kind === 'question' ? revise(entry)
        : entry.kind === 'turn' ? { ...entry, parts: entry.parts.map((part) => part.kind === 'question' ? revise(part) : part) } : entry) });
    }
    case 'state': {
      const sessionId = action.session?.sessionId ?? null;
      if (sessionId === null) {
        return stateOnly(transcript.sessionEnded ? transcript : cleared(transcript, null));
      }
      if (sessionId !== transcript.sessionId) {
        return stateOnly(cleared(transcript, sessionId));
      }
      return stateOnly(transcript.sessionEnded ? { ...transcript, sessionEnded: false } : transcript);
    }
    case 'sessionEnded':
      // Nothing can send the queued prompts now, and the transcript shows only what happened.
      return stateOnly({
        ...(transcript.projection ? endTurn(transcript, now) : appended(endTurn(transcript, now), (id) => ({ kind: 'error', id, text: action.message }))),
        queued: [],
        sessionEnded: true,
      });
    case 'clearTranscript':
      return stateOnly(cleared(transcript, null));
    case 'loadSessionStart':
      return stateOnly(cleared(transcript, transcript.sessionId));
    case 'promptStart':
      return stateOnly(transcript);
    case 'promptEnd':
      return stateOnly(endTurn(transcript, now));
    case 'foregroundActivity':
      return action.running ? stateOnly(transcript) : stateOnly(endTurn(transcript, now));
    case 'loadSessionEnd': {
      const ended = endTurn(transcript, now);
      return stateOnly(action.ok ? ended : appended(ended, (id) => ({ kind: 'error', id, text: 'Failed to load session.' })));
    }
    case 'error':
      return stateOnly(appended(transcript, (id) => ({ kind: 'error', id, text: action.message || 'An error occurred' })));
    case 'compactionToggled':
      return stateOnly(withCompaction(transcript, action.compactionId, (compaction) => compaction.open === action.open ? compaction : { ...compaction, open: action.open }) ?? transcript);
    case 'thoughtToggled':
      return stateOnly(
        withTurn(transcript, action.turnId, (turn) =>
          withPart(turn, action.part, (part) => (part.kind === 'thought' && part.open !== action.open ? { ...part, open: action.open } : part)),
        ),
      );
    case 'toolCallToggled':
      return stateOnly(
        withTurn(transcript, action.turnId, (turn) =>
          withToolCall(turn, action.toolCallId, (call) => (call.open === action.open ? call : { ...call, open: action.open })),
        ),
      );
    case 'toolCallsToggled':
      return stateOnly(
        withTurn(transcript, action.turnId, (turn) =>
          withPart(turn, action.part, (part) => (part.kind === 'toolCalls' ? { ...part, collapsed: !part.collapsed } : part)),
        ),
      );
    case 'diffFileClicked':
      return { state: transcript, outgoing: transcript.projection
        ? [{ type: 'openFile', target: transcript.projection.target, toolCallId: action.toolCallId, file: action.file }] : [] };
    case 'transcriptFileClicked':
      return { state: transcript, outgoing: [{ type: 'openTranscriptFile', target: action.target, destination: action.destination }] };
    case 'sendNowChosen':
      // Runtime handles Stop and queue release; keep the queue projection until it responds.
      return !turnRunning || transcript.queued[0]?.id !== action.id || !transcript.projection
        ? stateOnly(transcript)
        : { state: { ...transcript, followRequests: transcript.followRequests + 1 }, outgoing: [{ type: 'queueChanged', target: transcript.projection.target, change: { kind: 'stop', id: action.id } }] };
    case 'steerNowChosen':
      return !turnRunning || transcript.queued[0]?.id !== action.id || transcript.queued[0].draft !== null
        ? stateOnly(transcript)
        : { state: { ...transcript, followRequests: transcript.followRequests + 1 },
          outgoing: transcript.projection ? [{ type: 'queueChanged', target: transcript.projection.target, change: { kind: 'steer', id: action.id } }] : [] };
    case 'queuedPromptToggled':
    case 'queuedPromptEditStarted':
    case 'queuedPromptEdited':
    case 'queuedPromptEditSaved':
    case 'queuedPromptEditDiscarded':
    case 'queuedPromptCancelled': {
      const prompt = transcript.queued.find((item) => item.id === action.id);
      if (!prompt) { return stateOnly(transcript); }
      if (!transcript.projection) { return stateOnly(transcript); }
      if (action.type === 'queuedPromptCancelled') {
        return { state: transcript, outgoing: [{ type: 'queueChanged', target: transcript.projection.target, change: { kind: 'cancelled', id: action.id } }] };
      }
      if (action.type === 'queuedPromptEditSaved') {
        return prompt.draft === null ? stateOnly(transcript) : { state: transcript, outgoing: [{ type: 'queueChanged', target: transcript.projection.target,
          change: { kind: 'editSaved', id: action.id, revision: (prompt.revision ?? 0) + 1 } }] };
      }
      let revised: QueuedPrompt;
      switch (action.type) {
        case 'queuedPromptToggled': revised = { ...prompt, open: !prompt.open }; break;
        case 'queuedPromptEditStarted': revised = prompt.draft === null ? { ...prompt, draft: prompt.text } : prompt; break;
        case 'queuedPromptEdited': revised = prompt.draft !== null ? { ...prompt, draft: action.text } : prompt; break;
        case 'queuedPromptEditDiscarded': revised = { ...prompt, draft: null }; break;
      }
      if (revised === prompt) { return stateOnly(transcript); }
      if (action.type === 'queuedPromptToggled') { return stateOnly({ ...transcript, queued: transcript.queued.map((item) => item.id === action.id ? revised : item) }); }
      const revision = (prompt.revision ?? 0) + 1;
      revised = { ...revised, revision };
      const changed = { ...transcript, queued: transcript.queued.map((item) => item.id === action.id ? revised : item) };
      const kind = { queuedPromptEditStarted: 'editStarted', queuedPromptEdited: 'edited', queuedPromptEditDiscarded: 'editDiscarded' } as const;
      return { state: changed, outgoing: [{ type: 'queueChanged', target: transcript.projection.target,
        change: action.type === 'queuedPromptEdited' ? { kind: 'edited', id: action.id, text: action.text, revision } : { kind: kind[action.type], id: action.id, revision } }] };
    }
    default:
      return stateOnly(transcript);
  }
}

/** Changes an existing projected compaction without changing its placement. */
function withCompaction(transcript: TranscriptState, compactionId: string, change: (compaction: Compaction) => Compaction): TranscriptState | null {
  for (const entry of transcript.entries) {
    if (entry.kind === 'compaction' && entry.compactionId === compactionId) {
      const next = change(entry);
      return next === entry ? transcript : replaced(transcript, { ...entry, ...next });
    }
    if (entry.kind === 'turn') {
      const index = entry.parts.findIndex((part) => part.kind === 'compaction' && part.compactionId === compactionId);
      if (index !== -1) {
        return withTurn(transcript, entry.id, (turn) => withPart(turn, index, (part) => part.kind === 'compaction' ? change(part) : part));
      }
    }
  }
  return null;
}

function finished(thought: Thought, now: number): Thought {
  return thought.endedAt === null ? { ...thought, endedAt: now } : thought;
}

/** Settles displayed thought timing and tool-group expansion when turn completion arrives. */
function endTurn(transcript: TranscriptState, now: number): TranscriptState {
  const { currentTurn } = transcript;
  const ended =
    currentTurn === null ? transcript : withTurn(transcript, currentTurn, (turn) => ({ ...turn, parts: turn.parts.map((part) => endedPart(part, now)) }));
  return withCurrent(ended, null);
}

function endedPart(part: TurnPart, now: number): TurnPart {
  switch (part.kind) {
    case 'thought':
      return finished(part, now);
    case 'toolCalls':
      return part.collapsed || part.toolCalls.length <= TOOL_CALLS_SHOWN_EXPANDED ? part : { ...part, collapsed: true };
    default:
      return part;
  }
}

function cleared(transcript: TranscriptState, sessionId: string | null): TranscriptState {
  const empty =
    !transcript.markdownContextRequested && transcript.entries.length === 0 && transcript.terminals.size === 0 && transcript.usage === null && transcript.currentTurn === null && transcript.queued.length === 0;
  return empty && transcript.sessionId === sessionId
    ? transcript
    : {
      ...transcript,
      sessionId,
      markdownContext: null,
      markdownContextRequested: false,
      markdownOrigin: null,
      markdownImages: new Map(),
      sessionEnded: false,
      entries: [],
      terminals: new Map(),
      usage: null,
      currentTurn: null,
      queued: [],
      followRequests: transcript.followRequests + 1,
    };
}

function withCurrent(transcript: TranscriptState, currentTurn: EntryId | null): TranscriptState {
  return transcript.currentTurn === currentTurn ? transcript : { ...transcript, currentTurn };
}

function appended(transcript: TranscriptState, entry: (id: EntryId) => TranscriptEntry): TranscriptState {
  return { ...transcript, entries: [...transcript.entries, entry(transcript.nextId)], nextId: transcript.nextId + 1 };
}

function replaced(transcript: TranscriptState, entry: TranscriptEntry): TranscriptState {
  return { ...transcript, entries: transcript.entries.map((candidate) => (candidate.id === entry.id ? entry : candidate)) };
}

function findEntry(transcript: TranscriptState, id: EntryId): TranscriptEntry | undefined {
  return transcript.entries.find((entry) => entry.id === id);
}

function findTurn(transcript: TranscriptState, id: EntryId): Turn | undefined {
  const entry = findEntry(transcript, id);
  return entry?.kind === 'turn' ? entry : undefined;
}

function groupIndex(turn: Turn, toolCallId: string): PartIndex {
  return turn.parts.findIndex((part) => part.kind === 'toolCalls' && part.toolCalls.some((call) => call.toolCallId === toolCallId));
}

/** Applies `change` to the turn; returns the same state when there is no such turn or `change` returns it unchanged. */
function withTurn(transcript: TranscriptState, id: EntryId, change: (turn: Turn) => Turn): TranscriptState {
  const turn = findTurn(transcript, id);
  if (!turn) {
    return transcript;
  }
  const next = change(turn);
  return next === turn ? transcript : replaced(transcript, next);
}

/** Applies `change` to the turn's part at `index`; returns the same turn when there is no such part or `change` returns it unchanged. */
function withPart(turn: Turn, index: PartIndex, change: (part: TurnPart) => TurnPart): Turn {
  const part = turn.parts[index];
  if (!part) {
    return turn;
  }
  const next = change(part);
  return next === part ? turn : { ...turn, parts: turn.parts.map((candidate, at) => (at === index ? next : candidate)) };
}

function withToolCall(turn: Turn, toolCallId: string, change: (call: ToolCall) => ToolCall): Turn {
  return withPart(turn, groupIndex(turn, toolCallId), (group) => {
    if (group.kind !== 'toolCalls') {
      return group;
    }
    const call = group.toolCalls.find((candidate) => candidate.toolCallId === toolCallId);
    if (!call) {
      return group;
    }
    const next = change(call);
    return next === call ? group : { ...group, toolCalls: group.toolCalls.map((candidate) => (candidate === call ? next : candidate)) };
  });
}

function stateOnly(transcript: TranscriptState): Transition<TranscriptState, WebviewToExtensionMessage> {
  return { state: transcript, outgoing: [] };
}
