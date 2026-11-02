import type { ExtensionToWebviewMessage, SessionTabsSnapshot, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import { updateActiveSession, withPromptsPosted, type ActiveSession } from '@/webview/state/ActiveSession';
import { initialPickers, updatePickers, type PickerAction, type PickersState } from '@/webview/state/Pickers';
import { initialPromptBox, updatePromptBox, type PromptBoxAction, type PromptBoxState } from '@/webview/state/PromptBox';
import type { Transition } from '@/webview/state/Store';
import { initialQuestions, updateQuestions, type QuestionAction, type QuestionsState } from './Questions';
import {
  initialTranscript,
  updateTranscript,
  withSentPrompts,
  type TranscriptAction,
  type TranscriptState,
} from '@/webview/state/Transcript';

/** Everything the chat view shows. */
export interface RootState {
  readonly activeSession: ActiveSession | null;
  readonly sessionTabs: SessionTabsSnapshot;
  readonly pickers: PickersState;
  readonly promptBox: PromptBoxState;
  readonly transcript: TranscriptState;
  readonly questions: QuestionsState;
}

/** What the store is dispatched: webview messages from the extension, and user actions. */
export type Action = ExtensionToWebviewMessage | PickerAction | PromptBoxAction | TranscriptAction | QuestionAction
  | { type: 'sessionTabSelected' | 'sessionTabClosed'; tabId: string };

export const initialState: RootState = {
  activeSession: null,
  sessionTabs: { tabs: [], selectedTabId: null },
  pickers: initialPickers,
  promptBox: initialPromptBox,
  transcript: initialTranscript,
  questions: initialQuestions,
};

export function update(state: RootState, action: Action, now: number): Transition<RootState, WebviewToExtensionMessage> {
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
  const updatedSession = updateActiveSession(state.activeSession, action);
  const questions = updateQuestions(state.questions, action);
  const pickers = updatePickers(state.pickers, action);
  const promptBox = updatePromptBox(state.promptBox, action, updatedSession, state.transcript);
  const transcript = updateTranscript(state.transcript, action, now, updatedSession?.turnRunning ?? false, updatedSession?.loading ?? false);
  const sent = withSentPrompts(transcript.state, promptBox.outgoing, updatedSession?.turnRunning ?? false);
  const queued = sent.state.queued.length;
  const outgoing: WebviewToExtensionMessage[] = [...pickers.outgoing, ...sent.outgoing, ...transcript.outgoing, ...questions.outgoing];
  if (queued !== state.transcript.queued.length) { outgoing.push({ type: 'queuedPrompts', count: queued }); }
  const activeSession = withPromptsPosted(updatedSession, outgoing);
  const changed =
    activeSession !== state.activeSession ||
    pickers.state !== state.pickers ||
    promptBox.state !== state.promptBox ||
    sent.state !== state.transcript || questions.state !== state.questions;
  return {
    state: changed
      ? { activeSession, sessionTabs: state.sessionTabs, pickers: pickers.state, promptBox: promptBox.state, transcript: sent.state, questions: questions.state }
      : state,
    outgoing,
  };
}
