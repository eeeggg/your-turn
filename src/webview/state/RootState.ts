import type {
  ExtensionToWebviewMessage,
  PresentationTarget,
  SessionTabsSnapshot,
  WebviewToExtensionMessage
} from '@/shared/WebviewMessages';
import {
  updateActiveSession,
  withPromptsPosted,
  type ActiveSession
} from '@/webview/state/ActiveSession';
import {
  initialPickers,
  updatePickers,
  type PickerAction,
  type PickersState
} from '@/webview/state/Pickers';
import {
  initialPromptBox,
  projectedComposer,
  updatePromptBox,
  type PromptBoxAction,
  type PromptBoxState
} from '@/webview/state/PromptBox';
import type { Transition } from '@/webview/state/Store';
import {
  initialQuestions,
  updateQuestions,
  type QuestionAction,
  type QuestionsState
} from '@/webview/state/Questions';
import {
  initialTranscript,
  updateTranscript,
  type TranscriptAction,
  type TranscriptState,
} from '@/webview/state/Transcript';

/** Everything the chat view shows. */
export interface RootState {
  readonly activeSession: ActiveSession | null;
  readonly sessionTabs: SessionTabsSnapshot;
  readonly tabAnnouncement: Extract<ExtensionToWebviewMessage, { type: 'sessionTabAnnouncement' }> | null;
  readonly pickers: PickersState;
  readonly promptBox: PromptBoxState;
  readonly transcript: TranscriptState;
  readonly questions: QuestionsState;
}

/** What the store is dispatched: webview messages from the extension, and user actions. */
export type Action = ExtensionToWebviewMessage | PickerAction | PromptBoxAction | TranscriptAction | QuestionAction
  | { type: 'cancelTurnRequested' }
  | { type: 'sessionTabSelected' | 'sessionTabClosed'; tabId: string };

export const initialState: RootState = {
  activeSession: null,
  sessionTabs: { tabs: [], selectedTabId: null },
  tabAnnouncement: null,
  pickers: initialPickers,
  promptBox: initialPromptBox,
  transcript: initialTranscript,
  questions: initialQuestions,
};

/** Confirm duplicate deliveries too, in case the previous acknowledgment was lost. */
export function contentApplied(state: RootState, message: ExtensionToWebviewMessage): Extract<WebviewToExtensionMessage, { type: 'contentApplied' }> | undefined {
  const content = message.type === 'viewSnapshot' ? message.content
    : message.type === 'contentSnapshot' || message.type === 'contentPatch' ? message : null;
  const applied = state.transcript.projection;
  if (!content || !applied || applied.revision < content.revision) { return; }
  const { target } = applied;
  if (target.configuredName === content.target.configuredName && target.sessionId === content.target.sessionId
    && target.generation === content.target.generation && target.projection === content.target.projection) {
    return { type: 'contentApplied', target, revision: applied.revision };
  }
  return;
}

function contentManifest(transcript: TranscriptState, target: PresentationTarget, invalidBase?: true): WebviewToExtensionMessage[] {
  const projection = transcript.projection;
  if (projection?.target.configuredName !== target.configuredName || projection.target.sessionId !== target.sessionId
    || projection.target.generation !== target.generation || projection.target.projection > target.projection) { return []; }
  const entryVersions = new Map(projection.versions?.entries);
  const terminalVersions = new Map(projection.versions?.terminals);
  return [{ type: 'contentManifest', target, revision: projection.revision, versions: {
    entries: transcript.entries.map(({ id }) => [id, entryVersions.get(id) ?? 0]),
    terminals: [...transcript.terminals.keys()].map((id) => [id, terminalVersions.get(id) ?? 0]),
  }, ...(projection.target.projection === target.projection ? {} : { baseTarget: projection.target }),
  ...(invalidBase ? { invalidBase } : {}) }];
}

export function update(state: RootState, action: Action, now: number): Transition<RootState, WebviewToExtensionMessage> {
  if (action.type === 'contentManifestRequested') {
    return { state, outgoing: contentManifest(state.transcript, action.target) };
  }
  if (action.type === 'cancelTurnRequested') {
    const target = state.transcript.projection?.target;
    return { state, outgoing: target && state.activeSession?.turnRunning && state.activeSession.sessionId === target.sessionId
      ? [{ type: 'cancelTurn', target }] : [] };
  }
  if (action.type === 'viewSnapshot') {
    if (action.content && state.transcript.projection && action.content.target.projection <= state.transcript.projection.target.projection) {
      return { state, outgoing: [] };
    }
    const controls = { type: 'state' as const, ...action.state };
    const activeSession = updateActiveSession(state.activeSession, controls);
    const selected = { ...state,
      activeSession: activeSession && { ...activeSession, turnRunning: action.running, loading: action.loading },
      sessionTabs: action.tabs,
      pickers: updatePickers(state.pickers, controls, action.content?.target).state,
      questions: updateQuestions(state.questions, { type: 'questions', questions: action.questions }, action.content?.target).state,
      transcript: action.content ? state.transcript : { ...updateTranscript(state.transcript, controls, now).state, projection: null },
    };
    return action.content ? update(selected, { type: 'contentSnapshot', ...action.content }, now)
      : { state: selected, outgoing: [] };
  }
  if (action.type === 'contentSnapshot') {
    const projection = state.transcript.projection;
    if (projection && (action.target.projection < projection.target.projection
      || (action.target.projection === projection.target.projection && action.revision <= projection.revision))) {
      return { state, outgoing: [] };
    }
    const sameSession = projection
      ? projection.target.configuredName === action.target.configuredName && projection.target.sessionId === action.target.sessionId
        && projection.target.generation === action.target.generation
      : state.transcript.sessionId === action.target.sessionId && state.activeSession?.sessionId === action.target.sessionId;
    const initialDraft = !projection && (sameSession || state.transcript.sessionId === null) && state.promptBox.text !== '' && action.composer.text === '' && action.composer.revision === 0;
    const promptBox = initialDraft ? { ...state.promptBox, revision: 1 } : projectedComposer(state.promptBox, action.composer, sameSession);
    const keepImages = sameSession && state.transcript.markdownImageEpoch === action.markdownImageEpoch;
    const outgoing: WebviewToExtensionMessage[] = initialDraft ? [{ type: 'composerEdited', target: action.target, revision: 1, text: promptBox.text }] : [];
    const imageRequest = keepImages && pendingImageContext(state.transcript, action.target);
    if (imageRequest) { outgoing.push(imageRequest); }
    return { state: { ...state, promptBox, transcript: {
      ...(sameSession ? state.transcript : initialTranscript), sessionId: action.target.sessionId,
      markdownImageEpoch: action.markdownImageEpoch,
      ...(!keepImages ? { markdownContext: null, markdownContextRequested: false, markdownOrigin: null, markdownImages: initialTranscript.markdownImages } : {}),
      followRequests: state.transcript.followRequests,
      projection: { target: action.target, revision: action.revision, ...(action.versions ? { versions: action.versions } : {}) },
      queued: projectedQueue(sameSession ? state.transcript.queued : [], action.queue),
      entries: action.entries, currentTurn: action.currentTurn, nextId: sameSession ? Math.max(state.transcript.nextId, action.nextId) : action.nextId, usage: action.usage,
      terminals: new Map(action.terminals.map(({ terminalId, ...terminal }) => [terminalId, terminal])),
    } }, outgoing };
  }
  if (action.type === 'contentPatch') {
    const projection = state.transcript.projection;
    if (projection?.target.configuredName !== action.target.configuredName || projection.target.sessionId !== action.target.sessionId
      || projection.target.generation !== action.target.generation || action.revision <= projection.revision
      || (action.baseTarget
        ? action.target.projection <= projection.target.projection || action.baseTarget.projection !== projection.target.projection
          || action.baseTarget.configuredName !== projection.target.configuredName || action.baseTarget.sessionId !== projection.target.sessionId
          || action.baseTarget.generation !== projection.target.generation
        : projection.target.projection !== action.target.projection)) {
      return { state, outgoing: [] };
    }
    if (action.base !== projection.revision) { return { state, outgoing: [{ type: 'contentSnapshotRequested', target: projection.target }] }; }
    let entries = state.transcript.entries;
    let terminals = state.transcript.terminals;
    const entryVersions = new Map(projection.versions?.entries);
    const terminalVersions = new Map(projection.versions?.terminals);
    for (const change of action.patches) {
      const previous = change.kind === 'replace' && change.entry.kind === 'turn'
        ? entries.find((entry) => entry.id === change.id) : undefined;
      const patch = previous?.kind === 'turn' && change.kind === 'replace' && change.entry.kind === 'turn'
        ? { kind: 'spliceParts' as const, turnId: previous.id, index: 0, remove: previous.parts.length, parts: change.entry.parts }
        : change;
      let valid: boolean;
      if (patch.kind === 'insert') {
        valid = Number.isInteger(patch.index) && patch.index >= 0 && patch.index <= entries.length;
      } else if (patch.kind === 'spliceEntries') {
        valid = Number.isInteger(patch.index) && Number.isInteger(patch.remove) && patch.index >= 0 && patch.remove >= 0
          && patch.index + patch.remove <= entries.length;
      } else if (patch.kind === 'terminal' || patch.kind === 'removeTerminal') {
        valid = typeof patch.terminalId === 'string';
      } else if (patch.kind === 'replace') {
        valid = entries.some((entry) => entry.id === patch.id);
      } else {
        const turn = entries.find((entry) => entry.kind === 'turn' && entry.id === patch.turnId);
        if (turn?.kind !== 'turn') { valid = false; }
        else if (patch.kind === 'spliceParts') {
          valid = Number.isInteger(patch.index) && Number.isInteger(patch.remove) && patch.index >= 0 && patch.remove >= 0
            && patch.index + patch.remove <= turn.parts.length;
        } else {
          const part = turn.parts[patch.part];
          valid = Number.isInteger(patch.part) && (patch.kind === 'appendText' ? part?.kind === 'message' || part?.kind === 'thought'
            : part?.kind === 'toolCalls' && part.toolCalls.some((call) => call.toolCallId === patch.call.toolCallId));
        }
      }
      if (!valid) { return { state, outgoing: contentManifest(state.transcript, action.target, true) }; }
      switch (patch.kind) {
        case 'insert':
        case 'spliceEntries':
          for (const entry of patch.entries) { entryVersions.set(entry.id, action.revision); }
          break;
        case 'replace': entryVersions.set(patch.id, action.revision); break;
        case 'terminal': terminalVersions.set(patch.terminalId, action.revision); break;
        case 'removeTerminal': terminalVersions.delete(patch.terminalId); break;
        default: entryVersions.set(patch.turnId, action.revision); break;
      }
      if (patch.kind === 'removeTerminal') {
        const remaining = new Map(terminals);
        remaining.delete(patch.terminalId);
        terminals = remaining;
        continue;
      }
      if (patch.kind === 'terminal') {
        terminals = new Map(terminals).set(patch.terminalId, { text: patch.text, truncated: patch.truncated, exitStatus: patch.exitStatus });
        continue;
      }
      if (patch.kind === 'spliceEntries') { entries = [...entries.slice(0, patch.index), ...patch.entries, ...entries.slice(patch.index + patch.remove)]; continue; }
      if (patch.kind === 'insert') { entries = [...entries.slice(0, patch.index), ...patch.entries, ...entries.slice(patch.index)]; continue; }
      if (patch.kind === 'replace') {
        entries = entries.map((entry) => {
          if (entry.id !== patch.id) { return entry; }
          if (entry.kind === 'compaction' && patch.entry.kind === 'compaction' && entry.compactionId === patch.entry.compactionId && entry.status === patch.entry.status) {
            return { ...patch.entry, open: entry.open };
          }
          return entry.kind === 'question' && patch.entry.kind === 'question' && entry.record.interactionId === patch.entry.record.interactionId
            ? { ...patch.entry, open: entry.open } : patch.entry;
        });
        continue;
      }
      entries = entries.map((entry) => {
        if (entry.kind !== 'turn' || entry.id !== patch.turnId) { return entry; }
        if (patch.kind === 'spliceParts') {
          const parts = patch.parts.map((part, index) => {
            const previous = entry.parts[patch.index + index];
            if (part.kind === 'question') {
              const previous = entry.parts.find((candidate) => candidate.kind === 'question' && candidate.record.interactionId === part.record.interactionId);
              return previous?.kind === 'question' ? { ...part, open: previous.open } : part;
            }
            if (part.kind === 'toolCalls') {
              const previous = entry.parts.find((candidate) => candidate.kind === 'toolCalls' && candidate.toolCalls[0]?.toolCallId === part.toolCalls[0]?.toolCallId);
              if (previous?.kind === 'toolCalls') {
                const override = state.transcript.toolGroupOverrides.get(`${entry.id}:${part.toolCalls[0]?.toolCallId ?? ''}`);
                return { ...part, collapsed: override ?? part.collapsed, toolCalls: part.toolCalls.map((call) => {
                  const before = previous.toolCalls.find((candidate) => candidate.toolCallId === call.toolCallId);
                  return before && (before.status === 'failed' || call.status !== 'failed') ? { ...call, open: before.open } : call;
                }) };
              }
            }
            if (part.kind === 'compaction') {
              const previous = entry.parts.find((candidate) => candidate.kind === 'compaction' && candidate.compactionId === part.compactionId);
              if (previous?.kind === 'compaction' && previous.status === part.status) { return { ...part, open: previous.open }; }
            }
          const override = state.transcript.thoughtOverrides.get(`${entry.id}:${patch.index + index}`);
          if (part.kind === 'thought' && previous?.kind === 'thought' && part.messageId === previous.messageId
            && part.startedAt === previous.startedAt && previous.endedAt === null && part.endedAt !== null
            && part.text === previous.text && action.currentTurn === null && action.nextId === state.transcript.nextId
            && override === undefined) { return { ...part, open: previous.open }; }
            return part.kind === 'thought' && previous?.kind === 'thought' && part.messageId === previous.messageId
              && part.startedAt === previous.startedAt && override !== undefined ? { ...part, open: override } : part;
          });
          return { ...entry, parts: [...entry.parts.slice(0, patch.index), ...parts, ...entry.parts.slice(patch.index + patch.remove)] };
        }
        return { ...entry, parts: entry.parts.map((part, index) => {
          if (index !== patch.part) { return part; }
          if (patch.kind === 'appendText') { return part.kind === 'message' || part.kind === 'thought' ? { ...part, text: part.text + patch.text } : part; }
          return part.kind === 'toolCalls' ? { ...part, toolCalls: part.toolCalls.map((call) => call.toolCallId === patch.call.toolCallId
            ? { ...patch.call, open: call.status === 'failed' || patch.call.status !== 'failed' ? call.open : patch.call.open } : call) } : part;
        }) };
      });
    }
    const activeSession = action.running === undefined ? state.activeSession
      : updateActiveSession(state.activeSession, { type: 'foregroundActivity', running: action.running });
    const imageRequest = pendingImageContext(state.transcript, action.target);
    return { state: { ...state, activeSession, promptBox: action.composer ? projectedComposer(state.promptBox, action.composer, true) : state.promptBox, transcript: { ...state.transcript, entries,
      queued: action.queue ? projectedQueue(state.transcript.queued, action.queue) : state.transcript.queued,
      projection: { target: action.target, revision: action.revision, versions: action.versions ?? {
        entries: entries.map(({ id }) => [id, entryVersions.get(id) ?? 0]),
        terminals: [...terminals.keys()].map((id) => [id, terminalVersions.get(id) ?? 0]),
      } }, currentTurn: action.currentTurn,
      nextId: Math.max(state.transcript.nextId, action.nextId), usage: action.usage, terminals,
    } }, outgoing: imageRequest ? [imageRequest] : [] };
  }
  if (action.type === 'sessionTabSelected' || action.type === 'sessionTabClosed') {
    return {
      state,
      outgoing: state.sessionTabs.tabs.some((tab) => tab.tabId === action.tabId)
        ? [{ type: action.type === 'sessionTabSelected' ? 'selectSessionTab' : 'closeSessionTab', tabId: action.tabId }] : [],
    };
  }
  if (action.type === 'sessionTabs') {
    return { state: { ...state, sessionTabs: { tabs: action.tabs, selectedTabId: action.selectedTabId } }, outgoing: [] };
  }
  if (action.type === 'sessionTabAnnouncement') {
    return { state: action.revision > (state.tabAnnouncement?.revision ?? 0) ? { ...state, tabAnnouncement: action } : state, outgoing: [] };
  }
  const updatedSession = updateActiveSession(state.activeSession, action);
  const questions = updateQuestions(state.questions, action, state.transcript.projection?.target);
  const pickers = updatePickers(state.pickers, action, state.transcript.projection?.target);
  const promptBox = updatePromptBox(state.promptBox, action, updatedSession, state.transcript);
  const target = state.transcript.projection?.target;
  if (target && promptBox.state.text !== state.promptBox.text) {
    const revision = state.promptBox.revision + 1;
    promptBox.state = { ...promptBox.state, revision };
    promptBox.outgoing = [{ type: 'composerEdited', target, revision, text: promptBox.state.text }, ...promptBox.outgoing];
  }
  const transcript = updateTranscript(state.transcript, action, now, updatedSession?.turnRunning ?? false);
  if (action.type === 'thoughtToggled' && transcript.state !== state.transcript && transcript.state.projection !== null) {
    transcript.state = { ...transcript.state, thoughtOverrides: new Map(transcript.state.thoughtOverrides).set(`${action.turnId}:${action.part}`, action.open) };
  }
  if (action.type === 'toolCallsToggled' && transcript.state !== state.transcript && transcript.state.projection !== null) {
    const entry = transcript.state.entries.find((entry) => entry.id === action.turnId);
    const part = entry?.kind === 'turn' ? entry.parts[action.part] : undefined;
    if (part?.kind === 'toolCalls') {
      transcript.state = { ...transcript.state, toolGroupOverrides: new Map(transcript.state.toolGroupOverrides).set(`${action.turnId}:${part.toolCalls[0]?.toolCallId ?? ''}`, part.collapsed) };
    }
  }
  if (promptBox.outgoing.some((message) => message.type === 'sendPrompt')) {
    transcript.state = { ...transcript.state, followRequests: transcript.state.followRequests + 1 };
  }
  const outgoing: WebviewToExtensionMessage[] = [...pickers.outgoing, ...promptBox.outgoing, ...transcript.outgoing, ...questions.outgoing];
  const activeSession = withPromptsPosted(updatedSession, outgoing);
  const changed =
    activeSession !== state.activeSession ||
    pickers.state !== state.pickers ||
    promptBox.state !== state.promptBox ||
    transcript.state !== state.transcript || questions.state !== state.questions;
  return {
    state: changed
      ? { ...state, activeSession, pickers: pickers.state, promptBox: promptBox.state, transcript: transcript.state, questions: questions.state }
      : state,
    outgoing,
  };
}

function pendingImageContext(transcript: TranscriptState, target: PresentationTarget): WebviewToExtensionMessage | undefined {
  return transcript.projection?.target.projection !== target.projection && transcript.markdownContext === null && transcript.markdownContextRequested
    ? { type: 'markdownImageContext', target } : undefined;
}

function projectedQueue(previous: TranscriptState['queued'], queue: Extract<ExtensionToWebviewMessage, { type: 'contentSnapshot' }>['queue']): TranscriptState['queued'] {
  return queue.map((entry) => {
    const shown = previous.find((item) => item.id === entry.id);
    if (shown && (shown.revision ?? 0) > (entry.revision ?? 0)) { return shown; }
    return shown?.text === entry.text && shown.draft === entry.draft && shown.revision === entry.revision ? shown : { ...entry, open: shown?.open ?? false };
  });
}
