import type { PlanEntry, PlanEntryStatus, SessionUpdate, ToolCallContent, ToolCallStatus } from '@agentclientprotocol/sdk';
import type { WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import type { ActiveSession } from '@/webview/ActiveSession';
import type { Action } from '@/webview/RootState';
import type { Transition } from '@/webview/Store';

/** Unique for the life of the page, even across clears, so a late reply about a cleared entry matches nothing. */
export type EntryId = number;

export interface Prompt {
  readonly kind: 'prompt';
  readonly id: EntryId;
  readonly text: string;
}

/** The agent's side of a turn. Its prompt is an entry of its own, since a mid-turn prompt lands below the turn it joins. */
export interface Turn {
  readonly kind: 'turn';
  readonly id: EntryId;
  readonly thought: Thought | null;
  readonly message: AgentMessage;
  readonly toolCalls: readonly ToolCall[];
  readonly toolCallsCollapsed: boolean;
}

export interface Thought {
  readonly text: string;
  readonly startedAt: number;
  /** Null while the agent is still thinking. */
  readonly endedAt: number | null;
  readonly open: boolean;
}

export interface AgentMessage {
  /** Everything streamed so far; shown once it has more than whitespace. */
  readonly text: string;
  /** The extension's rendering of `text` as markdown, asked for once the turn ends. */
  readonly html: string | null;
}

export interface ToolCall {
  readonly toolCallId: string;
  readonly title: string;
  readonly status: ToolCallStatus;
  /** The text of its content; diffs and terminals are not shown yet. */
  readonly texts: readonly string[];
  readonly open: boolean;
}

/** The agent's latest plan in a turn, which replaces the earlier ones of that turn. */
export interface Plan {
  readonly kind: 'plan';
  readonly id: EntryId;
  readonly entries: readonly PlanEntry[];
}

export interface TranscriptError {
  readonly kind: 'error';
  readonly id: EntryId;
  readonly text: string;
}

export type TranscriptEntry = Prompt | Turn | Plan | TranscriptError;

export interface TranscriptState {
  /** The session the entries belong to; a `state` for any other session clears them. */
  readonly sessionId: string | null;
  readonly entries: readonly TranscriptEntry[];
  readonly nextId: EntryId;
  /** The turn the agent's work goes into, and that turn's plan, until the turn ends. */
  readonly currentTurn: EntryId | null;
  readonly currentPlan: EntryId | null;
}

export type WelcomeCommand = 'acp.connectAgent' | 'acp.addAgent';

export type TranscriptAction =
  | { type: 'thoughtToggled'; turnId: EntryId; open: boolean }
  | { type: 'toolCallToggled'; turnId: EntryId; toolCallId: string; open: boolean }
  | { type: 'toolCallsToggled'; turnId: EntryId }
  | { type: 'welcomeCommandChosen'; command: WelcomeCommand };

export const initialTranscript: TranscriptState = {
  sessionId: null,
  entries: [],
  nextId: 1,
  currentTurn: null,
  currentPlan: null,
};

export const TOOL_CALL_CONTENT_LIMIT = 20_000;

/** A turn's tool calls are collapsed when it ends with more than this many. */
const TOOL_CALLS_SHOWN_EXPANDED = 3;

/** Without a session, an empty transcript leaves room for the welcome card. */
export function showsWelcome(transcript: TranscriptState, session: ActiveSession | null): boolean {
  return session === null && transcript.entries.length === 0;
}

export function messageShown(message: AgentMessage): boolean {
  return message.text.trim() !== '';
}

/** A turn is drawn only once it has something to show, so whitespace before the answer leaves no trace. */
export function turnShown(turn: Turn): boolean {
  return turn.thought !== null || messageShown(turn.message) || turn.toolCalls.length > 0;
}

export function thoughtSummary(thought: Thought): string {
  const seconds = thought.endedAt === null ? 0 : Math.round((thought.endedAt - thought.startedAt) / 1000);
  return seconds > 0 ? `Thought for ${seconds}s` : 'Thought';
}

export function statusGlyph(status: ToolCallStatus): string {
  switch (status) {
    case 'in_progress':
      return '⟳';
    case 'completed':
      return '✓';
    case 'failed':
      return '✗';
    default:
      return '…';
  }
}

export function statusClass(status: ToolCallStatus): string {
  return status === 'in_progress' ? 'running' : status;
}

export function planEntryIcon(status: PlanEntryStatus): string {
  switch (status) {
    case 'completed':
      return '✅';
    case 'in_progress':
      return '🔄';
    default:
      return '⬜';
  }
}

/** The tool call's text as shown: at most `TOOL_CALL_CONTENT_LIMIT` characters across its blocks. */
export function shownContent(texts: readonly string[]): { blocks: string[]; truncated: boolean } {
  const blocks: string[] = [];
  let room = TOOL_CALL_CONTENT_LIMIT;
  for (const text of texts) {
    if (room === 0) {
      return { blocks, truncated: true };
    }
    const shown = text.slice(0, room);
    blocks.push(shown);
    room -= shown.length;
    if (shown.length < text.length) {
      return { blocks, truncated: true };
    }
  }
  return { blocks, truncated: false };
}

/** The non-empty text blocks of a tool call's content. */
export function contentTexts(content: readonly ToolCallContent[]): string[] {
  return content.flatMap((block) => (block.type === 'content' && block.content.type === 'text' && block.content.text ? [block.content.text] : []));
}

export function updateTranscript(
  transcript: TranscriptState,
  action: Action,
  now: number,
): Transition<TranscriptState, WebviewToExtensionMessage> {
  switch (action.type) {
    case 'state': {
      const sessionId = action.session?.sessionId ?? null;
      return stateOnly(sessionId !== null && sessionId === transcript.sessionId ? transcript : cleared(transcript, sessionId));
    }
    case 'clearTranscript':
      return stateOnly(cleared(transcript, null));
    case 'loadSessionStart':
      return stateOnly(cleared(transcript, transcript.sessionId));
    case 'promptStart':
      return stateOnly(withCurrent(transcript, null, null));
    case 'promptEnd': {
      const ended = endTurn(transcript, now);
      const turn = transcript.currentTurn === null ? undefined : findTurn(ended, transcript.currentTurn);
      return { state: ended, outgoing: markdownRequest(turn ? [turn] : []) };
    }
    case 'loadSessionEnd': {
      const ended = endTurn(transcript, now);
      const turns = ended.entries.filter((entry) => entry.kind === 'turn');
      return {
        state: action.ok ? ended : appended(ended, (id) => ({ kind: 'error', id, text: 'Failed to load session.' })),
        outgoing: markdownRequest(turns),
      };
    }
    case 'error':
      return stateOnly(appended(transcript, (id) => ({ kind: 'error', id, text: action.message || 'An error occurred' })));
    case 'markdownRendered':
      return stateOnly(
        action.items.reduce(
          (current, item) => withTurn(current, item.id, (turn) => ({ ...turn, message: { ...turn.message, html: item.html } })),
          transcript,
        ),
      );
    case 'sessionUpdate':
      return stateOnly(applySessionUpdate(transcript, action.update, now));
    case 'thoughtToggled':
      return stateOnly(
        withTurn(transcript, action.turnId, (turn) =>
          turn.thought && turn.thought.open !== action.open ? { ...turn, thought: { ...turn.thought, open: action.open } } : turn,
        ),
      );
    case 'toolCallToggled':
      return stateOnly(
        withTurn(transcript, action.turnId, (turn) =>
          withToolCall(turn, action.toolCallId, (call) => (call.open === action.open ? call : { ...call, open: action.open })),
        ),
      );
    case 'toolCallsToggled':
      return stateOnly(withTurn(transcript, action.turnId, (turn) => ({ ...turn, toolCallsCollapsed: !turn.toolCallsCollapsed })));
    case 'welcomeCommandChosen':
      return { state: transcript, outgoing: [{ type: 'executeCommand', command: action.command }] };
    default:
      return stateOnly(transcript);
  }
}

/** Adds each prompt the prompt box sent, so the transcript shows exactly what went to the agent. */
export function withSentPrompts(
  transcript: TranscriptState,
  outgoing: readonly WebviewToExtensionMessage[],
): TranscriptState {
  return outgoing.reduce(
    (current, message) =>
      message.type === 'sendPrompt' ? appended(current, (id) => ({ kind: 'prompt', id, text: message.text })) : current,
    transcript,
  );
}

function applySessionUpdate(transcript: TranscriptState, update: SessionUpdate, now: number): TranscriptState {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const { content } = update;
      if (content.type !== 'text' || !content.text) {
        return transcript;
      }
      return inCurrentTurn(transcript, (turn) => {
        const message = { ...turn.message, text: turn.message.text + content.text };
        const answerStarts = !messageShown(turn.message) && messageShown(message);
        return {
          ...turn,
          message,
          thought: answerStarts && turn.thought ? { ...finished(turn.thought, now), open: false } : turn.thought,
        };
      });
    }
    case 'agent_thought_chunk': {
      const { content } = update;
      if (content.type !== 'text') {
        return transcript;
      }
      return inCurrentTurn(transcript, (turn) => {
        const thought = turn.thought ?? { text: '', startedAt: now, endedAt: null, open: true };
        return { ...turn, thought: { ...thought, text: thought.text + content.text } };
      });
    }
    case 'user_message_chunk': {
      // Only a load replays prompts; each one ends the turn before it.
      const { content } = update;
      if (content.type !== 'text') {
        return transcript;
      }
      const ended = endTurn(transcript, now);
      const last = ended.entries.at(-1);
      return last?.kind === 'prompt'
        ? replaced(ended, { ...last, text: last.text + content.text })
        : appended(ended, (id) => ({ kind: 'prompt', id, text: content.text }));
    }
    case 'tool_call': {
      const reported = {
        title: update.title,
        status: update.status ?? null,
        texts: update.content ? contentTexts(update.content) : null,
      };
      const holder = turnWithToolCall(transcript, update.toolCallId);
      if (holder) {
        return withTurn(transcript, holder.id, (turn) => withToolCall(turn, update.toolCallId, (call) => revised(call, reported)));
      }
      const status = reported.status ?? 'pending';
      return inCurrentTurn(transcript, (turn) => ({
        ...turn,
        toolCalls: [
          ...turn.toolCalls,
          { toolCallId: update.toolCallId, title: update.title, status, texts: reported.texts ?? [], open: status === 'failed' },
        ],
      }));
    }
    case 'tool_call_update': {
      const holder = turnWithToolCall(transcript, update.toolCallId);
      if (!holder) {
        return transcript;
      }
      const reported = {
        title: update.title ?? '',
        status: update.status ?? null,
        texts: update.content ? contentTexts(update.content) : null,
      };
      return withTurn(transcript, holder.id, (turn) => withToolCall(turn, update.toolCallId, (call) => revised(call, reported)));
    }
    case 'plan': {
      const { entries } = update;
      const current = transcript.currentPlan === null ? undefined : findEntry(transcript, transcript.currentPlan);
      if (current?.kind === 'plan') {
        return replaced(transcript, { ...current, entries });
      }
      const added = appended(transcript, (id) => ({ kind: 'plan', id, entries }));
      return { ...added, currentPlan: added.nextId - 1 };
    }
    default:
      return transcript;
  }
}

/** What a repeated `tool_call` or a `tool_call_update` reports; null and empty fields leave the tool call as it was. */
interface ReportedToolCall {
  title: string;
  status: ToolCallStatus | null;
  texts: string[] | null;
}

/** A tool call opens when it fails, once; closing it again is up to the user. */
function revised(call: ToolCall, reported: ReportedToolCall): ToolCall {
  const status = reported.status ?? call.status;
  return {
    ...call,
    title: reported.title || call.title,
    status,
    texts: reported.texts ?? call.texts,
    open: call.open || (status === 'failed' && call.status !== 'failed'),
  };
}

function finished(thought: Thought, now: number): Thought {
  return thought.endedAt === null ? { ...thought, endedAt: now } : thought;
}

/** Finishes the current turn's thought and collapses a long list of tool calls; the next work starts a new turn. */
function endTurn(transcript: TranscriptState, now: number): TranscriptState {
  const { currentTurn } = transcript;
  const ended =
    currentTurn === null
      ? transcript
      : withTurn(transcript, currentTurn, (turn) => ({
          ...turn,
          thought: turn.thought && finished(turn.thought, now),
          toolCallsCollapsed: turn.toolCallsCollapsed || turn.toolCalls.length > TOOL_CALLS_SHOWN_EXPANDED,
        }));
  return withCurrent(ended, null, null);
}

function markdownRequest(turns: readonly Turn[]): WebviewToExtensionMessage[] {
  const items = turns.filter((turn) => messageShown(turn.message)).map((turn) => ({ id: turn.id, text: turn.message.text }));
  return items.length > 0 ? [{ type: 'renderMarkdown', items }] : [];
}

function cleared(transcript: TranscriptState, sessionId: string | null): TranscriptState {
  const empty = transcript.entries.length === 0 && transcript.currentTurn === null && transcript.currentPlan === null;
  return empty && transcript.sessionId === sessionId
    ? transcript
    : { ...transcript, sessionId, entries: [], currentTurn: null, currentPlan: null };
}

function withCurrent(transcript: TranscriptState, currentTurn: EntryId | null, currentPlan: EntryId | null): TranscriptState {
  return transcript.currentTurn === currentTurn && transcript.currentPlan === currentPlan
    ? transcript
    : { ...transcript, currentTurn, currentPlan };
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

/** Updates go wherever the tool call is, not only to the current turn; a repeated `tool_call` revises it there, so there is one. */
function turnWithToolCall(transcript: TranscriptState, toolCallId: string): Turn | undefined {
  return transcript.entries.find(
    (entry): entry is Turn => entry.kind === 'turn' && entry.toolCalls.some((call) => call.toolCallId === toolCallId),
  );
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

function withToolCall(turn: Turn, toolCallId: string, change: (call: ToolCall) => ToolCall): Turn {
  const call = turn.toolCalls.find((candidate) => candidate.toolCallId === toolCallId);
  if (!call) {
    return turn;
  }
  const next = change(call);
  return next === call ? turn : { ...turn, toolCalls: turn.toolCalls.map((candidate) => (candidate === call ? next : candidate)) };
}

/** Applies `change` to the current turn, starting one if the agent's work has none to go into yet. */
function inCurrentTurn(transcript: TranscriptState, change: (turn: Turn) => Turn): TranscriptState {
  if (transcript.currentTurn !== null) {
    return withTurn(transcript, transcript.currentTurn, change);
  }
  const started = appended(transcript, (id) => ({
    kind: 'turn',
    id,
    thought: null,
    message: { text: '', html: null },
    toolCalls: [],
    toolCallsCollapsed: false,
  }));
  const id = started.nextId - 1;
  return withTurn({ ...started, currentTurn: id }, id, change);
}

function stateOnly(transcript: TranscriptState): Transition<TranscriptState, WebviewToExtensionMessage> {
  return { state: transcript, outgoing: [] };
}
