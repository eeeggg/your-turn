import type { ContentBlock, PlanEntry, PlanEntryStatus, SessionUpdate, ToolCallContent, ToolCallStatus } from '@agentclientprotocol/sdk';
import type { WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import type { ActiveSession } from '@/webview/state/ActiveSession';
import type { Action } from '@/webview/state/RootState';
import type { Transition } from '@/webview/state/Store';

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
  /** What the agent sent, in the order it arrived. */
  readonly parts: readonly TurnPart[];
}

export type TurnPart = AgentMessage | Thought | ToolCallGroup | Plan;

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
  /** The text of its content; diffs and terminals are not shown yet. */
  readonly texts: readonly string[];
  readonly open: boolean;
}

/** The agent's latest plan in a turn, which replaces the earlier ones of that turn where the first one was. */
export interface Plan {
  readonly kind: 'plan';
  readonly entries: readonly PlanEntry[];
}

export interface TranscriptError {
  readonly kind: 'error';
  readonly id: EntryId;
  readonly text: string;
}

export type TranscriptEntry = Prompt | Turn | TranscriptError;

export interface TranscriptState {
  /** The session the entries belong to; a `state` for any other session clears them. */
  readonly sessionId: string | null;
  readonly entries: readonly TranscriptEntry[];
  readonly nextId: EntryId;
  /** The turn the agent's work goes into, until the turn ends. */
  readonly currentTurn: EntryId | null;
}

export type WelcomeCommand = 'acp.connectAgent' | 'acp.addAgent';

export type TranscriptAction =
  | { type: 'thoughtToggled'; turnId: EntryId; part: PartIndex; open: boolean }
  | { type: 'toolCallToggled'; turnId: EntryId; toolCallId: string; open: boolean }
  | { type: 'toolCallsToggled'; turnId: EntryId; part: PartIndex }
  | { type: 'welcomeCommandChosen'; command: WelcomeCommand };

export const initialTranscript: TranscriptState = {
  sessionId: null,
  entries: [],
  nextId: 1,
  currentTurn: null,
};

export const TOOL_CALL_CONTENT_LIMIT = 20_000;

/** A group of tool calls is collapsed when its turn ends with more than this many in it. */
const TOOL_CALLS_SHOWN_EXPANDED = 3;

/** Without a session, an empty transcript leaves room for the welcome card. */
export function showsWelcome(transcript: TranscriptState, session: ActiveSession | null): boolean {
  return session === null && transcript.entries.length === 0;
}

/** A part is drawn only once it has something to show, so whitespace before the answer leaves no trace. */
export function partShown(part: TurnPart): boolean {
  return part.kind !== 'message' || part.text.trim() !== '';
}

export function turnShown(turn: Turn): boolean {
  return turn.parts.some(partShown);
}

export function thoughtSummary(thought: Pick<Thought, 'startedAt' | 'endedAt'>): string {
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
      return stateOnly(withCurrent(transcript, null));
    case 'promptEnd':
      return stateOnly(endTurn(transcript, now));
    case 'loadSessionEnd': {
      const ended = endTurn(transcript, now);
      return stateOnly(action.ok ? ended : appended(ended, (id) => ({ kind: 'error', id, text: 'Failed to load session.' })));
    }
    case 'error':
      return stateOnly(appended(transcript, (id) => ({ kind: 'error', id, text: action.message || 'An error occurred' })));
    case 'sessionUpdate':
      return stateOnly(applySessionUpdate(transcript, action.update, now));
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

/** A chunk's text, unless its `audience` leaves out the user, as an agent marks what it adds for the model alone. */
function textForUser(content: ContentBlock): string | null {
  if (content.type !== 'text') {
    return null;
  }
  const audience = content.annotations?.audience;
  return audience && !audience.includes('user') ? null : content.text;
}

function applySessionUpdate(transcript: TranscriptState, update: SessionUpdate, now: number): TranscriptState {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = textForUser(update.content);
      if (!text) {
        return transcript;
      }
      const messageId = update.messageId ?? null;
      return inCurrentTurn(transcript, (turn) => {
        const last = turn.parts.at(-1);
        return last?.kind === 'message' && sameMessage(last.messageId, messageId)
          ? withLastPart(turn, { ...last, text: last.text + text }, 'replacing', now)
          : withLastPart(turn, { kind: 'message', messageId, text }, 'adding', now);
      });
    }
    case 'agent_thought_chunk': {
      const text = textForUser(update.content);
      if (text === null) {
        return transcript;
      }
      const messageId = update.messageId ?? null;
      return inCurrentTurn(transcript, (turn) => {
        const last = turn.parts.at(-1);
        return last?.kind === 'thought' && sameMessage(last.messageId, messageId)
          ? withLastPart(turn, { ...last, text: last.text + text }, 'replacing', now)
          : withLastPart(turn, { kind: 'thought', messageId, text, startedAt: now, endedAt: null, open: true }, 'adding', now);
      });
    }
    case 'user_message_chunk': {
      // Only a load replays prompts; each one ends the turn before it.
      const text = textForUser(update.content);
      if (text === null) {
        return transcript;
      }
      const ended = endTurn(transcript, now);
      const last = ended.entries.at(-1);
      return last?.kind === 'prompt'
        ? replaced(ended, { ...last, text: last.text + text })
        : appended(ended, (id) => ({ kind: 'prompt', id, text }));
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
      const call = { toolCallId: update.toolCallId, title: update.title, status, texts: reported.texts ?? [], open: status === 'failed' };
      return inCurrentTurn(transcript, (turn) => {
        const last = turn.parts.at(-1);
        return last?.kind === 'toolCalls'
          ? withLastPart(turn, { ...last, toolCalls: [...last.toolCalls, call] }, 'replacing', now)
          : withLastPart(turn, { kind: 'toolCalls', toolCalls: [call], collapsed: false }, 'adding', now);
      });
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
      const plan: Plan = { kind: 'plan', entries: update.entries };
      return inCurrentTurn(transcript, (turn) => {
        const index = turn.parts.findIndex((part) => part.kind === 'plan');
        return index === -1 ? withLastPart(turn, plan, 'adding', now) : withPart(turn, index, () => plan);
      });
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
  const empty = transcript.entries.length === 0 && transcript.currentTurn === null;
  return empty && transcript.sessionId === sessionId ? transcript : { ...transcript, sessionId, entries: [], currentTurn: null };
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

/** Updates go wherever the tool call is, not only to the current turn; a repeated `tool_call` revises it there, so there is one. */
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
