import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import { updateActiveSession, type ActiveSession } from '@/webview/state/ActiveSession';
import { initialPickers, updatePickers, type PickerAction, type PickersState } from '@/webview/state/Pickers';
import { initialPromptBox, updatePromptBox, type PromptBoxAction, type PromptBoxState } from '@/webview/state/PromptBox';
import type { Transition } from '@/webview/state/Store';
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
  readonly pickers: PickersState;
  readonly promptBox: PromptBoxState;
  readonly transcript: TranscriptState;
}

/** What the store is dispatched: webview messages from the extension, and user actions. */
export type Action = ExtensionToWebviewMessage | PickerAction | PromptBoxAction | TranscriptAction;

export const initialState: RootState = {
  activeSession: null,
  pickers: initialPickers,
  promptBox: initialPromptBox,
  transcript: initialTranscript,
};

export function update(state: RootState, action: Action, now: number): Transition<RootState, WebviewToExtensionMessage> {
  const activeSession = updateActiveSession(state.activeSession, action);
  const pickers = updatePickers(state.pickers, action);
  const promptBox = updatePromptBox(state.promptBox, action, activeSession);
  const transcript = updateTranscript(state.transcript, action, now);
  const shownTranscript = withSentPrompts(transcript.state, promptBox.outgoing);
  const changed =
    activeSession !== state.activeSession ||
    pickers.state !== state.pickers ||
    promptBox.state !== state.promptBox ||
    shownTranscript !== state.transcript;
  return {
    state: changed
      ? { activeSession, pickers: pickers.state, promptBox: promptBox.state, transcript: shownTranscript }
      : state,
    outgoing: [...pickers.outgoing, ...promptBox.outgoing, ...transcript.outgoing],
  };
}
