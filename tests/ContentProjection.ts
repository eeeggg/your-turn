import { endContentTurn, initialContent, updateContent, withPromptError, type SessionContent } from '@/core/sessions/Content';
import type { SessionUpdate } from '@/core/acp/AcpDriver';
import type { ExtensionToWebviewMessage, ImagePresentation, ToolCallContent, ToolCallStatus } from '@/shared/WebviewMessages';
import type { Action } from '@/webview/state/RootState';
import type { TranscriptState } from '@/webview/state/Transcript';

type Blocks = ({ kind: 'text'; text: string } | ({ kind: 'image' } & ImagePresentation))[];
export type ContentReport =
  | { type: 'agentText'; messageId: string | null; text: string }
  | { type: 'thoughtText'; messageId: string | null; text: string }
  | { type: 'promptText'; messageId: string | null; text: string }
  | { type: 'agentMessage' | 'thoughtMessage' | 'promptMessage'; messageId: string; text: string }
  | { type: 'agentRichMessage' | 'thoughtRichMessage' | 'promptRichMessage'; messageId: string; content: Blocks }
  | ({ type: 'agentImage' | 'thoughtImage' | 'promptImage'; messageId: string | null } & ImagePresentation)
  | { type: 'toolCall'; toolCallId: string; title?: string; status?: ToolCallStatus; content?: ToolCallContent[] }
  | { type: 'terminal'; terminalId: string; text: string; truncated: boolean; exitStatus: { exitCode: number | null; signal: string | null } | null }
  | { type: 'plan'; steps: Extract<SessionUpdate, { kind: 'plan' }>['steps'] }
  | { type: 'usage'; usage: NonNullable<Extract<ExtensionToWebviewMessage, { type: 'contentSnapshot' }>['usage']> }
  | ({ type: 'compactionUpdate' } & Omit<Extract<SessionUpdate, { kind: 'compactionUpdate' }>, 'kind'>)
  | ({ type: 'compactionSummaryChunk' } & Omit<Extract<SessionUpdate, { kind: 'compactionSummaryChunk' }>, 'kind'>);

export type FixtureAction = Action | ContentReport;
export type FixtureMessage = ExtensionToWebviewMessage | ContentReport;

export function isContentReport(action: FixtureAction): action is ContentReport {
  return ['agentText', 'thoughtText', 'promptText', 'agentMessage', 'thoughtMessage', 'promptMessage', 'agentRichMessage', 'thoughtRichMessage', 'promptRichMessage',
    'agentImage', 'thoughtImage', 'promptImage', 'toolCall', 'terminal', 'plan', 'usage', 'compactionUpdate', 'compactionSummaryChunk'].includes(action.type);
}

/** Renderer fixtures supply already-validated images and diffs. Core still decides all content placement. */
export class ContentProjection {
  private content: SessionContent = initialContent;
  private readonly images = new Map<string, ImagePresentation>();
  private readonly tools = new Map<string, readonly ToolCallContent[]>();
  private readonly toolVersions = new Map<string, number>();
  private serial = 0;

  project(action: FixtureAction, transcript: TranscriptState, now: number, running = false, loading = false): ExtensionToWebviewMessage | undefined {
    if (transcript.entries.length === 0 && this.content.entries.length > 0) {
      this.content = { ...initialContent, nextId: transcript.nextId };
    }
    if (action.type === 'promptEnd' || action.type === 'foregroundActivity' && !action.running || action.type === 'loadSessionEnd') {
      this.content = endContentTurn(this.content, now);
    } else if (action.type === 'sessionEnded') {
      this.content = withPromptError(endContentTurn(this.content, now), action.message);
    } else {
      const update = this.normalized(action);
      if (!update) { return; }
      if ((update.kind === 'compactionUpdate' || update.kind === 'compactionSummaryChunk') && running && this.content.currentTurn === null) {
        const id = this.content.nextId;
        this.content = { ...this.content, currentTurn: id, nextId: id + 1, entries: [...this.content.entries, { kind: 'turn', id, parts: [] }] };
      }
      this.content = updateContent(this.content, update, now, loading);
    }
    const entries = this.present();
    const projection = transcript.projection;
    const usage = action.type === 'usage' ? action.usage : transcript.usage;
    const terminals = action.type === 'terminal' ? new Map(transcript.terminals).set(action.terminalId, action) : transcript.terminals;
    if (!projection) {
      return { type: 'contentSnapshot', target: { configuredName: 'fixture', sessionId: transcript.sessionId ?? 'fixture', generation: 1, projection: ++this.serial },
        revision: 0, entries, currentTurn: this.content.currentTurn, nextId: this.content.nextId, usage,
        queue: transcript.queued, composer: { text: '', revision: 0 }, terminals: [...terminals].map(([terminalId, terminal]) => ({ ...terminal, terminalId })) };
    }
    const patches: Extract<ExtensionToWebviewMessage, { type: 'contentPatch' }>['patches'][number][] = [];
    let structural = false;
    for (let index = 0; index < entries.length; index++) {
      const next = entries[index];
      const previous = transcript.entries[index];
      if (!next) { continue; }
      if (next.id !== previous?.id) { structural = true; break; }
      if (next.kind === 'turn' && previous.kind === 'turn') {
        patches.push({ kind: 'spliceParts', turnId: next.id, index: 0, remove: previous.parts.length, parts: next.parts });
      } else { patches.push({ kind: 'replace', id: next.id, entry: next }); }
    }
    if (structural || entries.length !== transcript.entries.length) {
      patches.splice(0, patches.length, { kind: 'spliceEntries', index: 0, remove: transcript.entries.length, entries });
    }
    if (action.type === 'terminal') { patches.push({ kind: 'terminal', terminalId: action.terminalId, text: action.text, truncated: action.truncated, exitStatus: action.exitStatus }); }
    return { type: 'contentPatch', target: projection.target, base: projection.revision, revision: projection.revision + 1, patches,
      currentTurn: this.content.currentTurn, nextId: this.content.nextId, usage };
  }

  private image(image: ImagePresentation): { kind: 'image'; data: string; mimeType: string } {
    const data = String(++this.serial);
    this.images.set(data, { src: image.src, ...(image.reference ? { reference: true } : {}), ...(image.fallback ? { fallback: image.fallback } : {}) });
    return { kind: 'image', data, mimeType: 'image/fixture' };
  }

  private normalized(action: FixtureAction): SessionUpdate | undefined {
    switch (action.type) {
      case 'agentText': case 'thoughtText': case 'promptText':
      case 'agentMessage': case 'thoughtMessage': case 'promptMessage':
      case 'plan': case 'compactionUpdate': case 'compactionSummaryChunk': {
        const { type, ...fields } = action;
        return { ...fields, kind: type } as SessionUpdate;
      }
      case 'agentRichMessage': case 'thoughtRichMessage': case 'promptRichMessage':
        return { kind: action.type, messageId: action.messageId, content: action.content.map((block) => block.kind === 'image' ? this.image(block) : block) };
      case 'agentImage': case 'thoughtImage': case 'promptImage':
        return { ...this.image(action), kind: action.type, messageId: action.messageId };
      case 'toolCall': {
        if (action.content) {
          this.tools.set(action.toolCallId, action.content);
          const existing = this.content.entries.some((entry) => entry.kind === 'turn' && entry.parts.some((part) => part.kind === 'toolCalls' && part.toolCalls.some((call) => call.toolCallId === action.toolCallId)));
          this.toolVersions.set(action.toolCallId, existing ? (this.toolVersions.get(action.toolCallId) ?? 0) + 1 : 0);
        }
        return { kind: 'toolCall', toolCallId: action.toolCallId, ...(action.title !== undefined ? { title: action.title } : {}), ...(action.status !== undefined ? { status: action.status } : {}) };
      }
      case 'terminal': case 'usage': return { kind: 'commands', commands: [] };
      default: return;
    }
  }

  private present(): Extract<ExtensionToWebviewMessage, { type: 'contentSnapshot' }>['entries'] {
    type Entry = Extract<ExtensionToWebviewMessage, { type: 'contentSnapshot' }>['entries'][number];
    type Part = Extract<Entry, { kind: 'turn' }>['parts'][number];
    const part = (value: Extract<SessionContent['entries'][number], { kind: 'turn' }>['parts'][number], ended: boolean): Part => {
      switch (value.kind) {
        case 'message': case 'childCompletion': return value;
        case 'thought': {
          const image = value.image && this.images.get(value.image.data);
          return { kind: 'thought', messageId: value.messageId, text: value.text, startedAt: value.startedAt, endedAt: value.endedAt, open: value.endedAt === null,
          ...(value.markdownRevision === undefined ? {} : { markdownRevision: value.markdownRevision }),
          ...(image ? { imageSrc: image.src, ...(image.reference ? { imageReference: true as const } : {}), ...(image.fallback ? { imageFallback: image.fallback } : {}) } : {}) };
        }
        case 'image': return { kind: 'image', messageId: value.messageId, src: null, ...this.images.get(value.data) };
        case 'plan': return value;
        case 'compaction': return { ...value, open: value.status !== 'completed' };
        case 'toolCalls': return { kind: 'toolCalls', collapsed: ended && value.toolCalls.length > 3, toolCalls: value.toolCalls.map((call) => ({
          toolCallId: call.toolCallId, title: call.title, status: call.status, content: this.tools.get(call.toolCallId) ?? [], open: call.status === 'failed',
          ...((this.toolVersions.get(call.toolCallId) ?? 0) > 0 ? { markdownRevision: this.toolVersions.get(call.toolCallId) ?? 0 } : {}),
        })) };
        case 'question': throw new Error('Supply settled questions as presentation patches');
      }
    };
    return this.content.entries.map((entry): Entry => {
      switch (entry.kind) {
        case 'turn': return { kind: 'turn', id: entry.id, parts: entry.parts.map((value) => part(value, entry.id !== this.content.currentTurn)) };
        case 'prompt': case 'error': case 'childCompletion': return entry;
        case 'promptImage': return { kind: 'promptImage', id: entry.id, messageId: entry.messageId, text: '', src: null, ...this.images.get(entry.data) };
        case 'compaction': return { ...entry, open: entry.status !== 'completed' };
        case 'question': throw new Error('Supply settled questions as presentation patches');
      }
    });
  }
}
