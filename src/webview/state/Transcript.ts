import type {
  DiffFile,
  ExitStatus,
  ExtensionToWebviewMessage,
  PlanStep,
  PlanStepStatus,
  QuestionRecord,
  SessionUsage,
  ToolCallContent,
  ToolCallStatus,
  WebviewToExtensionMessage,
} from '@/shared/WebviewMessages';
import type { ActiveSession } from '@/webview/state/ActiveSession';
import type { Action } from '@/webview/state/RootState';
import type { Transition } from '@/webview/state/Store';

/** Unique for the life of the page, even across clears, so a late reply about a cleared entry matches nothing. */
export type EntryId = number;

interface Prompt {
  readonly kind: 'prompt';
  readonly id: EntryId;
  /** The agent's ID for a prompt a load replays; text with another ID is another prompt, and a whole one with this ID replaces its text. */
  readonly messageId?: string;
  readonly text: string;
}

/** The agent's side of a turn, an entry of its own after the prompt that started it. */
export interface Turn {
  readonly kind: 'turn';
  readonly id: EntryId;
  /** What the agent sent, in the order it arrived. */
  readonly parts: readonly TurnPart[];
}

export type TurnPart = AgentMessage | Thought | ToolCallGroup | Plan | Compaction | SettledQuestion;

interface SettledQuestion {
  readonly kind: 'question';
  readonly record: QuestionRecord;
  readonly open: boolean;
}

type CompactionReport = Extract<ExtensionToWebviewMessage, { type: 'compactionUpdate' | 'compactionSummaryChunk' }>;
type SummaryChunk = Extract<CompactionReport, { type: 'compactionSummaryChunk' }>;

export interface Compaction {
  readonly kind: 'compaction';
  readonly compactionId: string;
  readonly status: string;
  readonly summary: readonly SummaryChunk['content'][];
  readonly error: string | null;
  readonly open: boolean;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  /** Replay and a terminal report without a live start cannot establish a later live duration. */
  readonly timingAllowed: boolean;
}

/** A part's place in its turn, which never changes: parts are only ever added at the end. */
export type PartIndex = number;

export interface AgentMessage {
  readonly kind: 'message';
  /** The agent's ID for the message, when it sends one; text with another ID is another message. */
  readonly messageId: string | null;
  /** Everything streamed so far, as markdown; shown once it has more than whitespace. */
  readonly text: string;
}

export interface Thought {
  readonly kind: 'thought';
  /** As for an agent message. */
  readonly messageId: string | null;
  readonly text: string;
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
  readonly toolCallId: string;
  readonly title: string;
  readonly status: ToolCallStatus;
  readonly content: readonly ToolCallContent[];
  readonly open: boolean;
}

/** The agent's latest plan in a turn, which replaces the earlier ones of that turn where the first one was. */
export interface Plan {
  readonly kind: 'plan';
  readonly steps: readonly PlanStep[];
}

interface TranscriptError {
  readonly kind: 'error';
  readonly id: EntryId;
  readonly text: string;
}

export type TranscriptEntry = Prompt | Turn | TranscriptError | ((Compaction | SettledQuestion) & { readonly id: EntryId });

/** An agent's terminal as last reported; its command runs while `exitStatus` is null. */
interface Terminal {
  readonly text: string;
  readonly truncated: boolean;
  readonly exitStatus: ExitStatus | null;
}

export interface TranscriptState {
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
  /** The turn the agent's work goes into, until the turn ends. */
  readonly currentTurn: EntryId | null;
  /** Prompts the user sent while a turn ran, oldest first; each goes to the agent when the turn before it ends. */
  readonly queued: readonly string[];
  /** Rises each time the view must follow the stream again: for each prompt the user sends, and on each clear. */
  readonly followRequests: number;
}

export type TranscriptAction =
  | { type: 'questionRecordToggled'; interactionId: string; open: boolean }
  | { type: 'thoughtToggled'; turnId: EntryId; part: PartIndex; open: boolean }
  | { type: 'compactionToggled'; compactionId: string; open: boolean }
  | { type: 'toolCallToggled'; turnId: EntryId; toolCallId: string; open: boolean }
  | { type: 'toolCallsToggled'; turnId: EntryId; part: PartIndex }
  /** A diff's file link, the `file`th file across the tool call's diffs. */
  | { type: 'diffFileClicked'; toolCallId: string; file: number }
  | { type: 'sendNowChosen' };

export const initialTranscript: TranscriptState = {
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

/** The session's prompts the agent has, oldest first: those it was sent, a queued one once it goes, and those a load replayed. */
export function promptHistory(transcript: TranscriptState): string[] {
  return transcript.entries.flatMap((entry) => (entry.kind === 'prompt' && entry.text.trim() !== '' ? [entry.text] : []));
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
  if (!terminalCompaction(status)) { return `Compaction — unknown status: ${status}`; }
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

export function statusGlyph(status: ToolCallStatus): string {
  switch (status) {
    case 'running':
      return '⟳';
    case 'completed':
      return '✓';
    case 'failed':
      return '✗';
    default:
      return '…';
  }
}

export function planStepIcon(status: PlanStepStatus): string {
  switch (status) {
    case 'completed':
      return '✅';
    case 'running':
      return '🔄';
    default:
      return '⬜';
  }
}

/** A command runs until its terminal says how it ended, or until its session ends first. */
type CommandStatus = 'running' | 'disconnected' | 'ended';

export type ShownBlock =
  | { readonly kind: 'text'; readonly text: string }
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
 * and, only `withDiffs`, its diffs' files, cut already. `running` while a command of its terminals runs.
 */
export function shownContent(
  content: readonly ToolCallContent[],
  { terminals, sessionEnded }: ContentContext,
  withDiffs: boolean,
): { blocks: ShownBlock[]; truncated: boolean; running: boolean } {
  const blocks: ShownBlock[] = [];
  let textRoom = TOOL_CALL_CONTENT_LIMIT;
  let fileCount = 0;
  let truncated = false;
  let running = false;
  for (const item of content) {
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
        running ||= status === 'running';
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
  return { blocks, truncated, running };
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
  loading = false,
): Transition<TranscriptState, WebviewToExtensionMessage> {
  switch (action.type) {
    case 'questionSettled': {
      if (loading || action.record.sessionId !== transcript.sessionId || transcript.entries.some((entry) => entry.kind === 'question'
        ? entry.record.interactionId === action.record.interactionId
        : entry.kind === 'turn' && entry.parts.some((part) => part.kind === 'question' && part.record.interactionId === action.record.interactionId))) {
        return stateOnly(transcript);
      }
      const question: SettledQuestion = { kind: 'question', record: action.record, open: false };
      return stateOnly(transcript.currentTurn !== null || turnRunning
        ? inCurrentTurn(transcript, (turn) => withLastPart(turn, question, 'adding', now))
        : appended(transcript, (id) => ({ ...question, id })));
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
        ...appended(endTurn(transcript, now), (id) => ({ kind: 'error', id, text: action.message })),
        queued: [],
        sessionEnded: true,
      });
    case 'clearTranscript':
      return stateOnly(cleared(transcript, null));
    case 'loadSessionStart':
      return stateOnly(cleared(transcript, transcript.sessionId));
    case 'promptStart':
      return stateOnly(withCurrent(transcript, null));
    case 'promptEnd':
      return withQueueHeadSent(endTurn(transcript, now));
    case 'loadSessionEnd': {
      const ended = endTurn(transcript, now);
      return stateOnly(action.ok ? ended : appended(ended, (id) => ({ kind: 'error', id, text: 'Failed to load session.' })));
    }
    case 'error':
      return stateOnly(appended(transcript, (id) => ({ kind: 'error', id, text: action.message || 'An error occurred' })));
    case 'agentText':
    case 'thoughtText':
      return stateOnly(withAgentText(transcript, action, now));
    case 'promptText':
      return stateOnly(withReplayedPrompt(transcript, action, now));
    case 'agentMessage':
    case 'thoughtMessage':
      return stateOnly(withMessageReplaced(transcript, action, now));
    case 'promptMessage':
      return stateOnly(withPromptReplaced(transcript, action, now));
    case 'toolCall':
      return stateOnly(withToolCallReported(transcript, action, now));
    case 'terminal': {
      const { text, truncated, exitStatus } = action;
      return stateOnly({ ...transcript, terminals: new Map(transcript.terminals).set(action.terminalId, { text, truncated, exitStatus }) });
    }
    case 'plan':
      return stateOnly(withPlan(transcript, { kind: 'plan', steps: action.steps }, now));
    case 'usage':
      return stateOnly({ ...transcript, usage: action.usage });
    case 'compactionUpdate':
    case 'compactionSummaryChunk':
      return stateOnly(withCompactionReported(transcript, action, now, turnRunning, loading));
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
      return { state: transcript, outgoing: [{ type: 'openFile', toolCallId: action.toolCallId, file: action.file }] };
    case 'sendNowChosen':
      // Cancelling ends the turn, which sends the top of the queue; the queue itself stays as it is until then.
      return transcript.queued.length === 0
        ? stateOnly(transcript)
        : { state: { ...transcript, followRequests: transcript.followRequests + 1 }, outgoing: [{ type: 'cancelTurn' }] };
    default:
      return stateOnly(transcript);
  }
}

/**
 * Routes each prompt the prompt box sent: to the agent and into the transcript, or into the queue while a turn runs,
 * as only one prompt may be in flight. The view follows either way.
 */
export function withSentPrompts(
  transcript: TranscriptState,
  outgoing: readonly WebviewToExtensionMessage[],
  turnRunning: boolean,
): Transition<TranscriptState, WebviewToExtensionMessage> {
  let state = transcript;
  let busy = turnRunning;
  const posted: WebviewToExtensionMessage[] = [];
  for (const message of outgoing) {
    if (message.type !== 'sendPrompt') {
      posted.push(message);
      continue;
    }
    const followed = { ...state, followRequests: state.followRequests + 1 };
    if (busy) {
      state = { ...followed, queued: [...followed.queued, message.text] };
    } else {
      state = withPrompt(followed, message.text);
      posted.push(message);
      busy = true;
    }
  }
  return { state, outgoing: posted };
}

function withQueueHeadSent(transcript: TranscriptState): Transition<TranscriptState, WebviewToExtensionMessage> {
  const [head, ...rest] = transcript.queued;
  if (head === undefined) {
    return stateOnly(transcript);
  }
  return { state: { ...withPrompt(transcript, head), queued: rest }, outgoing: [{ type: 'sendPrompt', text: head }] };
}

function withPrompt(transcript: TranscriptState, text: string): TranscriptState {
  return appended(transcript, (id) => ({ kind: 'prompt', id, text }));
}

function withAgentText(
  transcript: TranscriptState,
  { type, messageId, text }: Extract<ExtensionToWebviewMessage, { type: 'agentText' | 'thoughtText' }>,
  now: number,
): TranscriptState {
  // A thought starts on its first text, even an empty one; a message is drawn only once it has something to show.
  if (type === 'agentText' && !text) {
    return transcript;
  }
  const kind = type === 'agentText' ? 'message' : 'thought';
  return inCurrentTurn(transcript, (turn) => {
    const last = turn.parts.at(-1);
    if ((last?.kind === 'message' || last?.kind === 'thought') && last.kind === kind && sameMessage(last.messageId, messageId)) {
      return withLastPart(turn, { ...last, text: last.text + text }, 'replacing', now);
    }
    const part: TurnPart =
      kind === 'message' ? { kind, messageId, text } : { kind, messageId, text, startedAt: now, endedAt: null, open: true };
    return withLastPart(turn, part, 'adding', now);
  });
}

/** Only a load replays prompts; each one ends the turn before it. */
function withReplayedPrompt(
  transcript: TranscriptState,
  { messageId, text }: Extract<ExtensionToWebviewMessage, { type: 'promptText' }>,
  now: number,
): TranscriptState {
  const ended = endTurn(transcript, now);
  const last = ended.entries.at(-1);
  return last?.kind === 'prompt' && sameMessage(last.messageId ?? null, messageId)
    ? replaced(ended, { ...last, text: last.text + text })
    : appended(ended, (id) => ({ kind: 'prompt', id, ...(messageId !== null ? { messageId } : {}), text }));
}

/**
 * The latest part of the kind with the ID takes the whole text, in whichever turn. Without one, the text goes into the
 * current turn as streamed text would, unless it is empty, as there is nothing to clear.
 */
function withMessageReplaced(
  transcript: TranscriptState,
  { type, messageId, text }: Extract<ExtensionToWebviewMessage, { type: 'agentMessage' | 'thoughtMessage' }>,
  now: number,
): TranscriptState {
  const kind = type === 'agentMessage' ? 'message' : 'thought';
  for (let at = transcript.entries.length - 1; at >= 0; at--) {
    const entry = transcript.entries[at];
    if (entry?.kind !== 'turn') {
      continue;
    }
    const index = lastPartIndex(entry, (part) => (part.kind === 'message' || part.kind === 'thought') && part.kind === kind && part.messageId === messageId);
    if (index !== -1) {
      return withTurn(transcript, entry.id, (turn) =>
        withPart(turn, index, (part) => ((part.kind === 'message' || part.kind === 'thought') && part.text !== text ? { ...part, text } : part)),
      );
    }
  }
  return text ? withAgentText(transcript, { type: kind === 'message' ? 'agentText' : 'thoughtText', messageId, text }, now) : transcript;
}

/** The latest prompt with the ID takes the whole text; without one, the prompt is replayed as a new one, unless it is empty, as for a message. */
function withPromptReplaced(
  transcript: TranscriptState,
  { messageId, text }: Extract<ExtensionToWebviewMessage, { type: 'promptMessage' }>,
  now: number,
): TranscriptState {
  for (let at = transcript.entries.length - 1; at >= 0; at--) {
    const entry = transcript.entries[at];
    if (entry?.kind === 'prompt' && entry.messageId === messageId) {
      return entry.text === text ? transcript : replaced(transcript, { ...entry, text });
    }
  }
  return text ? appended(endTurn(transcript, now), (id) => ({ kind: 'prompt', id, messageId, text })) : transcript;
}

function lastPartIndex(turn: Turn, matches: (part: TurnPart) => boolean): PartIndex {
  for (let at = turn.parts.length - 1; at >= 0; at--) {
    const part = turn.parts[at];
    if (part && matches(part)) {
      return at;
    }
  }
  return -1;
}

/** A tool call already shown is revised where it is, in whichever turn; a new one goes into the current turn. */
function withToolCallReported(
  transcript: TranscriptState,
  reported: Extract<ExtensionToWebviewMessage, { type: 'toolCall' }>,
  now: number,
): TranscriptState {
  const { toolCallId } = reported;
  const holder = turnWithToolCall(transcript, toolCallId);
  if (holder) {
    return withTurn(transcript, holder.id, (turn) => withToolCall(turn, toolCallId, (call) => revised(call, reported)));
  }
  const status = reported.status ?? 'pending';
  const call: ToolCall = { toolCallId, title: reported.title ?? '', status, content: reported.content ?? [], open: status === 'failed' };
  return inCurrentTurn(transcript, (turn) => {
    const last = turn.parts.at(-1);
    return last?.kind === 'toolCalls'
      ? withLastPart(turn, { ...last, toolCalls: [...last.toolCalls, call] }, 'replacing', now)
      : withLastPart(turn, { kind: 'toolCalls', toolCalls: [call], collapsed: false }, 'adding', now);
  });
}

/** The first report fixes placement; reports for that ID revise it across turn boundaries. */
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

function withCompactionReported(transcript: TranscriptState, report: CompactionReport, now: number, turnRunning: boolean, loading: boolean): TranscriptState {
  const revised = withCompaction(transcript, report.compactionId, (compaction) => revisedCompaction(compaction, report, now, loading));
  if (revised) { return revised; }
  const compaction = revisedCompaction({
    kind: 'compaction', compactionId: report.compactionId, status: 'in_progress', summary: [], error: null,
    open: true, startedAt: null, endedAt: null, timingAllowed: !loading,
  }, report, now, loading);
  return transcript.currentTurn !== null || turnRunning
    ? inCurrentTurn(transcript, (turn) => withLastPart(turn, compaction, 'adding', now))
    : appended(transcript, (id) => ({ ...compaction, id }));
}

function terminalCompaction(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function revisedCompaction(compaction: Compaction, report: CompactionReport, now: number, loading: boolean): Compaction {
  const status = report.type === 'compactionUpdate' ? report.status : compaction.status;
  const changedStatus = status !== compaction.status;
  const terminal = terminalCompaction(status);
  const startedAt = compaction.startedAt ?? (!loading && compaction.timingAllowed && status === 'in_progress' ? now : null);
  const endedAt = compaction.endedAt ?? (!loading && startedAt !== null && terminal ? now : null);
  const presentation = {
    status, startedAt, endedAt,
    timingAllowed: compaction.timingAllowed && !loading && !terminal,
    open: changedStatus && status === 'completed' ? false : changedStatus && (status === 'failed' || status === 'cancelled') ? true : compaction.open,
  };
  return report.type === 'compactionSummaryChunk'
    ? { ...compaction, ...presentation, summary: [...compaction.summary, report.content] }
    : {
      ...compaction,
      ...presentation,
      summary: report.summary.present ? report.summary.value ?? [] : compaction.summary,
      error: report.error.present ? report.error.value : compaction.error,
    };
}

function withPlan(transcript: TranscriptState, plan: Plan, now: number): TranscriptState {
  return inCurrentTurn(transcript, (turn) => {
    const index = turn.parts.findIndex((part) => part.kind === 'plan');
    return index === -1 ? withLastPart(turn, plan, 'adding', now) : withPart(turn, index, () => plan);
  });
}

/** What the report leaves out, or gives as empty text, stays as it was. A tool call opens when it fails, once; closing it again is up to the user. */
function revised(call: ToolCall, reported: Extract<ExtensionToWebviewMessage, { type: 'toolCall' }>): ToolCall {
  const status = reported.status ?? call.status;
  return {
    ...call,
    title: reported.title || call.title,
    status,
    content: reported.content ?? call.content,
    open: call.open || (status === 'failed' && call.status !== 'failed'),
  };
}

function sameMessage(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b;
}

function finished(thought: Thought, now: number): Thought {
  return thought.endedAt === null ? { ...thought, endedAt: now } : thought;
}

/**
 * Puts `part` at the end of the turn, replacing the last part it continues or adding it after.
 * Once something shown follows a thought still running, the thought finishes and closes.
 */
function withLastPart(turn: Turn, part: TurnPart, mode: 'replacing' | 'adding', now: number): Turn {
  const before = mode === 'replacing' ? turn.parts.slice(0, -1) : turn.parts;
  const settled = partShown(part)
    ? before.map((earlier) => (earlier.kind === 'thought' && earlier.endedAt === null ? { ...finished(earlier, now), open: false } : earlier))
    : before;
  return { ...turn, parts: [...settled, part] };
}

/** Finishes the current turn's thoughts and collapses its long groups of tool calls; the next work starts a new turn. */
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
    transcript.entries.length === 0 && transcript.terminals.size === 0 && transcript.usage === null && transcript.currentTurn === null && transcript.queued.length === 0;
  return empty && transcript.sessionId === sessionId
    ? transcript
    : {
      ...transcript,
      sessionId,
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

function turnWithToolCall(transcript: TranscriptState, toolCallId: string): Turn | undefined {
  return transcript.entries.find(
    (entry): entry is Turn => entry.kind === 'turn' && groupIndex(entry, toolCallId) !== -1,
  );
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

/** Applies `change` to the current turn, starting one if the agent's work has none to go into yet. */
function inCurrentTurn(transcript: TranscriptState, change: (turn: Turn) => Turn): TranscriptState {
  if (transcript.currentTurn !== null) {
    return withTurn(transcript, transcript.currentTurn, change);
  }
  const started = appended(transcript, (id) => ({ kind: 'turn', id, parts: [] }));
  const id = started.nextId - 1;
  return withTurn({ ...started, currentTurn: id }, id, change);
}

function stateOnly(transcript: TranscriptState): Transition<TranscriptState, WebviewToExtensionMessage> {
  return { state: transcript, outgoing: [] };
}
