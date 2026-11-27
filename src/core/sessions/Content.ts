import type { SessionUpdate } from '@/core/acp/AcpDriver';
import type { ShownContent } from '@/core/CommandOutput';
import type { SettledQuestion } from '@/core/sessions/Interactions';

interface Message {
  readonly kind: 'message';
  readonly messageId: string | null;
  readonly text: string;
  readonly markdownRevision?: number;
}

interface Thought {
  readonly kind: 'thought';
  readonly messageId: string | null;
  readonly text: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly markdownRevision?: number;
  readonly image?: { readonly data: string; readonly mimeType: string; readonly reference?: true };
}

interface Prompt {
  readonly kind: 'prompt';
  readonly id: number;
  readonly messageId?: string;
  readonly text: string;
}

interface Turn {
  readonly kind: 'turn';
  readonly id: number;
  readonly parts: readonly ContentPart[];
}

interface ToolCall {
  readonly toolCallId: string;
  readonly title: string;
  readonly status: 'pending' | 'running' | 'completed' | 'failed';
  readonly content: readonly ShownContent[];
  readonly toolKind?: Extract<SessionUpdate, { kind: 'toolCall' }>['toolKind'];
  readonly markdownRevision?: number;
}

interface Image {
  readonly kind: 'image';
  readonly messageId: string | null;
  readonly data: string;
  readonly mimeType: string;
  readonly reference?: true;
}

interface PromptImage {
  readonly kind: 'promptImage';
  readonly id: number;
  readonly messageId: string | null;
  readonly data: string;
  readonly mimeType: string;
  readonly reference?: true;
}

interface Compaction {
  readonly kind: 'compaction';
  readonly compactionId: string;
  readonly status: string;
  readonly summary: readonly Extract<SessionUpdate, { kind: 'compactionSummaryChunk' }>['content'][];
  readonly error: string | null;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly timingAllowed: boolean;
}

interface ChildCompletion {
  readonly kind: 'childCompletion';
  readonly id: number;
  readonly childId: string;
  readonly stopReason: string | null;
}

type ContentPart = Message | Thought | Image | Compaction | ChildCompletion | { readonly kind: 'question'; readonly record: SettledQuestion }
  | { readonly kind: 'toolCalls'; readonly toolCalls: readonly ToolCall[] }
  | { readonly kind: 'plan'; readonly steps: Extract<SessionUpdate, { kind: 'plan' }>['steps'] };

export interface SessionContent {
  readonly entries: readonly (Prompt | PromptImage | Turn | ChildCompletion | (Compaction & { readonly id: number }) | { readonly kind: 'question'; readonly id: number; readonly record: SettledQuestion } | { readonly kind: 'error'; readonly id: number; readonly text: string })[];
  readonly currentTurn: number | null;
  readonly nextId: number;
}

export const initialContent: SessionContent = { entries: [], currentTurn: null, nextId: 1 };

export function withChildCompletion(content: SessionContent, childId: string, stopReason: string | null): SessionContent {
  const entry: ChildCompletion = { kind: 'childCompletion', id: content.nextId, childId, stopReason };
  const next = { ...content, nextId: content.nextId + 1 };
  return content.currentTurn === null ? { ...next, entries: [...content.entries, entry] }
    : withTurn(next, content.currentTurn, (turn) => ({ ...turn, parts: [...turn.parts, entry] }));
}

export function withSettledQuestion(content: SessionContent, record: SettledQuestion, now: number): SessionContent {
  const question = { kind: 'question' as const, record };
  return content.currentTurn !== null ? inCurrentTurn(content, (turn) => withLastPart(turn, question, 'adding', now))
    : { ...content, nextId: content.nextId + 1, entries: [...content.entries, { ...question, id: content.nextId }] };
}

export function withSubmittedPrompt(content: SessionContent, text: string): SessionContent {
  return { ...content, currentTurn: null, nextId: content.nextId + 1, entries: [...content.entries, { kind: 'prompt', id: content.nextId, text }] };
}

export function withPromptError(content: SessionContent, text: string): SessionContent {
  return { ...content, nextId: content.nextId + 1, entries: [...content.entries, { kind: 'error', id: content.nextId, text }] };
}

/** Pure content transitions extracted from Transcript; expansion remains presentation-owned. */
export function updateContent(content: SessionContent, update: SessionUpdate, now: number, loading = false): SessionContent {
  switch (update.kind) {
    case 'promptImage': {
      const ended = endContentTurn(content, now);
      return { ...ended, nextId: ended.nextId + 1, entries: [...ended.entries, { ...update, id: ended.nextId }] };
    }
    case 'promptRichMessage':
      return withPromptReplaced(content, update.messageId, update.content, now);
    case 'thoughtRichMessage':
      return withThoughtReplaced(content, update.messageId, update.content, now);
    case 'agentImage':
      return inCurrentTurn(content, (turn) => withLastPart(turn, { ...update, kind: 'image' }, 'adding', now));
    case 'thoughtImage':
      return inCurrentTurn(content, (turn) => withLastPart(turn, {
        kind: 'thought', messageId: update.messageId, text: '', startedAt: now, endedAt: null,
        image: { data: update.data, mimeType: update.mimeType, ...(update.reference ? { reference: true } : {}) },
      }, 'adding', now));
    case 'agentRichMessage':
      return withAgentReplaced(content, update.messageId, update.content, now);
    case 'compactionUpdate':
    case 'compactionSummaryChunk': {
      const revise = (previous: Compaction): Compaction => {
        const reported = update.kind === 'compactionUpdate' ? update.status : undefined;
        const resetTiming = reported === null && previous.status !== 'in_progress';
        const status = reported === undefined ? previous.status : reported ?? 'in_progress';
        const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
        const timingAllowed = (resetTiming || previous.timingAllowed) && !loading && !terminal;
        const startedAt = (resetTiming ? null : previous.startedAt) ?? (timingAllowed && status === 'in_progress' ? now : null);
        const endedAt = (resetTiming ? null : previous.endedAt) ?? (!loading && startedAt !== null && terminal ? now : null);
        const revised = { ...previous, status, startedAt, endedAt, timingAllowed };
        return update.kind === 'compactionSummaryChunk'
          ? { ...revised, summary: [...previous.summary, update.content] }
          : { ...revised, summary: update.summary.present ? update.summary.value ?? [] : previous.summary,
            error: update.error.present ? update.error.value : previous.error };
      };
      for (const entry of content.entries) {
        if (entry.kind === 'compaction' && entry.compactionId === update.compactionId) {
          return { ...content, entries: content.entries.map((candidate) => candidate === entry ? { ...revise(entry), id: entry.id } : candidate) };
        }
        if (entry.kind !== 'turn') { continue; }
        const part = entry.parts.find((candidate) => candidate.kind === 'compaction' && candidate.compactionId === update.compactionId);
        if (part?.kind === 'compaction') {
          return withTurn(content, entry.id, (turn) => ({ ...turn, parts: turn.parts.map((candidate) => candidate === part ? revise(part) : candidate) }));
        }
      }
      const part = revise({ kind: 'compaction', compactionId: update.compactionId, status: 'in_progress', summary: [], error: null,
        startedAt: null, endedAt: null, timingAllowed: !loading });
      return content.currentTurn !== null ? inCurrentTurn(content, (turn) => withLastPart(turn, part, 'adding', now))
        : { ...content, nextId: content.nextId + 1, entries: [...content.entries, { ...part, id: content.nextId }] };
    }
    case 'agentText':
    case 'thoughtText':
      return withText(content, update, now);
    case 'toolCall': {
      for (const entry of content.entries) {
        if (entry.kind !== 'turn') { continue; }
        const group = entry.parts.find((part) => part.kind === 'toolCalls' && part.toolCalls.some((call) => call.toolCallId === update.toolCallId));
        if (group?.kind !== 'toolCalls') { continue; }
        return withTurn(content, entry.id, (turn) => ({ ...turn, parts: turn.parts.map((part) => part === group ? {
          ...group, toolCalls: group.toolCalls.map((call) => call.toolCallId === update.toolCallId ? {
            ...call, title: update.title || call.title, status: update.status ?? call.status, content: update.content ?? call.content,
            ...(update.toolKind !== undefined ? { toolKind: update.toolKind } : {}),
            ...(update.content ? { markdownRevision: (call.markdownRevision ?? 0) + 1 } : {}),
          } : call),
        } : part) }));
      }
      const call: ToolCall = { toolCallId: update.toolCallId, title: update.title ?? '', status: update.status ?? 'pending', content: update.content ?? [],
        ...(update.toolKind !== undefined ? { toolKind: update.toolKind } : {}) };
      return inCurrentTurn(content, (turn) => {
        const last = turn.parts.at(-1);
        return last?.kind === 'toolCalls'
          ? withLastPart(turn, { ...last, toolCalls: [...last.toolCalls, call] }, 'replacing', now)
          : withLastPart(turn, { kind: 'toolCalls', toolCalls: [call] }, 'adding', now);
      });
    }
    case 'plan':
      return inCurrentTurn(content, (turn) => {
        const index = turn.parts.findIndex((part) => part.kind === 'plan');
        const plan: ContentPart = { kind: 'plan', steps: update.steps };
        return index < 0 ? withLastPart(turn, plan, 'adding', now)
          : { ...turn, parts: turn.parts.map((part, position) => position === index ? plan : part) };
      });
    case 'agentMessage':
    case 'thoughtMessage': {
      if (update.kind === 'agentMessage' && content.entries.some((entry) => entry.kind === 'turn' && entry.parts.some((part) => part.kind === 'image' && part.messageId === update.messageId))) {
        return withAgentReplaced(content, update.messageId, update.text ? [{ kind: 'text', text: update.text }] : [], now);
      }
      if (update.kind === 'thoughtMessage' && content.entries.some((entry) => entry.kind === 'turn' && entry.parts.some((part) => part.kind === 'thought' && part.image && part.messageId === update.messageId))) {
        return withThoughtReplaced(content, update.messageId, update.text ? [{ kind: 'text', text: update.text }] : [], now);
      }
      const kind = update.kind === 'agentMessage' ? 'message' : 'thought';
      for (let at = content.entries.length - 1; at >= 0; at--) {
        const entry = content.entries[at];
        if (entry?.kind !== 'turn') { continue; }
        let index = -1;
        for (let position = entry.parts.length - 1; position >= 0; position--) {
          const part = entry.parts[position];
          if (part?.kind === kind && part.messageId === update.messageId) { index = position; break; }
        }
        if (index < 0) { continue; }
        return withTurn(content, entry.id, (turn) => ({ ...turn, parts: turn.parts.map((part, position) => position === index
          && (part.kind === 'message' || part.kind === 'thought')
          ? { ...part, text: update.text, ...(update.text ? { markdownRevision: (part.markdownRevision ?? 0) + 1 } : {}) } : part) }));
      }
      return update.text ? withText(content, { kind: kind === 'message' ? 'agentText' : 'thoughtText', messageId: update.messageId, text: update.text }, now) : content;
    }
    case 'promptText': {
      const ended = endContentTurn(content, now);
      const last = ended.entries.at(-1);
      return last?.kind === 'prompt' && sameMessage(last.messageId ?? null, update.messageId)
        ? { ...ended, entries: ended.entries.map((entry) => entry === last ? { ...last, text: last.text + update.text } : entry) }
        : { ...ended, nextId: ended.nextId + 1, entries: [...ended.entries, {
          kind: 'prompt', id: ended.nextId, ...(update.messageId !== null ? { messageId: update.messageId } : {}), text: update.text,
        }] };
    }
    case 'promptMessage': {
      if (content.entries.some((entry) => entry.kind === 'promptImage' && entry.messageId === update.messageId)) {
        return withPromptReplaced(content, update.messageId, update.text ? [{ kind: 'text', text: update.text }] : [], now);
      }
      for (let at = content.entries.length - 1; at >= 0; at--) {
        const entry = content.entries[at];
        if (entry?.kind !== 'prompt' || entry.messageId !== update.messageId) { continue; }
        return entry.text === update.text ? content : { ...content, entries: content.entries.map((candidate) => candidate === entry ? { ...entry, text: update.text } : candidate) };
      }
      return update.text ? updateContent(content, { kind: 'promptText', messageId: update.messageId, text: update.text }, now) : content;
    }
    case 'foreground':
      return update.state === 'idle' ? endContentTurn(content, now) : content;
    default:
      return content;
  }
}

function withPromptReplaced(content: SessionContent, messageId: string, blocks: Extract<SessionUpdate, { kind: 'promptRichMessage' }>['content'], now: number): SessionContent {
  const matches = (entry: SessionContent['entries'][number]) => (entry.kind === 'prompt' || entry.kind === 'promptImage') && entry.messageId === messageId;
  const first = content.entries.findIndex(matches);
  let state = first < 0 ? endContentTurn(content, now) : { ...content, entries: content.entries.slice(0, first) };
  for (const block of joinedText(blocks)) {
    const entry: Prompt | PromptImage = block.kind === 'text'
      ? { kind: 'prompt', id: state.nextId, messageId, text: block.text }
      : { ...block, kind: 'promptImage', id: state.nextId, messageId };
    state = { ...state, nextId: state.nextId + 1, entries: [...state.entries, entry] };
  }
  return first < 0 ? state : { ...state, entries: [...state.entries, ...content.entries.slice(first).filter((entry) => !matches(entry))] };
}

function withThoughtReplaced(content: SessionContent, messageId: string, blocks: Extract<SessionUpdate, { kind: 'thoughtRichMessage' }>['content'], now: number): SessionContent {
  const parts: Thought[] = joinedText(blocks).flatMap((block): Thought[] => block.kind === 'image'
    ? [{ kind: 'thought', messageId, text: '', image: { data: block.data, mimeType: block.mimeType, ...(block.reference ? { reference: true } : {}) }, startedAt: now, endedAt: null }]
    : block.text ? [{ kind: 'thought', messageId, text: block.text, startedAt: now, endedAt: null }] : []);
  const matches = (part: ContentPart) => part.kind === 'thought' && part.messageId === messageId;
  for (let at = content.entries.length - 1; at >= 0; at--) {
    const entry = content.entries[at];
    if (entry?.kind !== 'turn') { continue; }
    const first = entry.parts.findIndex(matches);
    if (first < 0) { continue; }
    const revision = Math.max(0, ...entry.parts.filter(matches).map((part) => part.kind === 'thought' ? part.markdownRevision ?? 0 : 0)) + 1;
    return withTurn(content, entry.id, (turn) => ({ ...turn, parts: [
      ...turn.parts.slice(0, first), ...parts.map((part) => ({ ...part, markdownRevision: revision })), ...turn.parts.slice(first).filter((part) => !matches(part)),
    ] }));
  }
  return parts.length ? inCurrentTurn(content, (turn) => parts.reduce((current, part) => withLastPart(current, part, 'adding', now), turn)) : content;
}

function joinedText(blocks: Extract<SessionUpdate, { kind: 'agentRichMessage' }>['content']): typeof blocks {
  const joined: typeof blocks = [];
  for (const block of blocks) {
    const last = joined.at(-1);
    if (block.kind === 'text' && last?.kind === 'text') { joined[joined.length - 1] = { kind: 'text', text: last.text + block.text }; }
    else { joined.push(block); }
  }
  return joined;
}

export function endContentTurn(content: SessionContent, now: number): SessionContent {
  if (content.currentTurn === null) { return content; }
  const ended = withTurn(content, content.currentTurn, (turn) => ({ ...turn, parts: turn.parts.map((part) =>
    part.kind === 'thought' && part.endedAt === null ? { ...part, endedAt: now } : part) }));
  return { ...ended, currentTurn: null };
}

function withText(content: SessionContent, update: Extract<SessionUpdate, { kind: 'agentText' | 'thoughtText' }>, now: number): SessionContent {
  if (update.kind === 'agentText' && !update.text) { return content; }
  const kind = update.kind === 'agentText' ? 'message' : 'thought';
  return inCurrentTurn(content, (turn) => {
    const last = turn.parts.at(-1);
    if (last?.kind === kind && !(last.kind === 'thought' && last.image) && sameMessage(last.messageId, update.messageId)) {
      const part = { ...last, text: last.text + update.text };
      return withLastPart(turn, part, 'replacing', now);
    }
    const part: Message | Thought = kind === 'message'
      ? { kind, messageId: update.messageId, text: update.text }
      : { kind, messageId: update.messageId, text: update.text, startedAt: now, endedAt: null };
    return withLastPart(turn, part, 'adding', now);
  });
}

function withAgentReplaced(content: SessionContent, messageId: string, blocks: Extract<SessionUpdate, { kind: 'agentRichMessage' }>['content'], now: number): SessionContent {
  const parts: ContentPart[] = [];
  for (const block of blocks) {
    const last = parts.at(-1);
    if (block.kind === 'text') {
      if (!block.text) { continue; }
      if (last?.kind === 'message') { parts[parts.length - 1] = { ...last, text: last.text + block.text }; }
      else { parts.push({ kind: 'message', messageId, text: block.text }); }
    } else { parts.push({ ...block, messageId }); }
  }
  const matches = (part: ContentPart) => (part.kind === 'message' || part.kind === 'image') && part.messageId === messageId;
  for (let at = content.entries.length - 1; at >= 0; at--) {
    const entry = content.entries[at];
    if (entry?.kind !== 'turn') { continue; }
    const first = entry.parts.findIndex(matches);
    if (first < 0) { continue; }
    const revision = Math.max(0, ...entry.parts.filter(matches).map((part) => part.kind === 'message' ? part.markdownRevision ?? 0 : 0)) + 1;
    return withTurn(content, entry.id, (turn) => ({ ...turn, parts: [
      ...turn.parts.slice(0, first), ...parts.map((part) => part.kind === 'message' ? { ...part, markdownRevision: revision } : part),
      ...turn.parts.slice(first).filter((part) => !matches(part)),
    ] }));
  }
  return parts.length ? inCurrentTurn(content, (turn) => parts.reduce((current, part) => withLastPart(current, part, 'adding', now), turn)) : content;
}

function withLastPart(turn: Turn, part: ContentPart, mode: 'replacing' | 'adding', now: number): Turn {
  const before = mode === 'replacing' ? turn.parts.slice(0, -1) : turn.parts;
  const settled = part.kind !== 'message' || part.text.trim() !== ''
    ? before.map((earlier) => earlier.kind === 'thought' && earlier.endedAt === null ? { ...earlier, endedAt: now } : earlier)
    : before;
  return { ...turn, parts: [...settled, part] };
}

function inCurrentTurn(content: SessionContent, change: (turn: Turn) => Turn): SessionContent {
  if (content.currentTurn !== null) { return withTurn(content, content.currentTurn, change); }
  const started: SessionContent = {
    ...content, currentTurn: content.nextId, nextId: content.nextId + 1,
    entries: [...content.entries, { kind: 'turn', id: content.nextId, parts: [] }],
  };
  return withTurn(started, content.nextId, change);
}

function sameMessage(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b;
}

export function withCleanedToolContent(content: SessionContent, toolCallId: string, expected: readonly ShownContent[], shown: readonly ShownContent[]): SessionContent {
  for (const entry of content.entries) {
    if (entry.kind !== 'turn') { continue; }
    const group = entry.parts.find((part) => part.kind === 'toolCalls' && part.toolCalls.some((call) => call.toolCallId === toolCallId && call.content === expected));
    if (group?.kind !== 'toolCalls') { continue; }
    return withTurn(content, entry.id, (turn) => ({ ...turn, parts: turn.parts.map((part) => part === group ? {
      ...group, toolCalls: group.toolCalls.map((call) => call.toolCallId === toolCallId ? { ...call, content: shown } : call),
    } : part) }));
  }
  return content;
}

function withTurn(content: SessionContent, id: number, change: (turn: Turn) => Turn): SessionContent {
  const turn = content.entries.find((entry): entry is Turn => entry.kind === 'turn' && entry.id === id);
  if (!turn) { return content; }
  const next = change(turn);
  return next === turn ? content : { ...content, entries: content.entries.map((entry) => entry === turn ? next : entry) };
}
