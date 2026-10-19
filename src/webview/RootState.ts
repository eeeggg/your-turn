import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import { updateActiveSession, type ActiveSession } from '@/webview/ActiveSession';
import { initialPickers, updatePickers, type PickerAction, type PickersState } from '@/webview/Pickers';
import { initialPromptBox, updatePromptBox, type PromptBoxAction, type PromptBoxState } from '@/webview/PromptBox';
import type { Transition } from '@/webview/Store';

/** Every area of the chat view that has moved from chat.ts to the store. */
export interface RootState {
  readonly activeSession: ActiveSession | null;
  readonly pickers: PickersState;
  readonly promptBox: PromptBoxState;
}

/** What the store is dispatched: webview messages from the extension, and user actions. */
export type Action = ExtensionToWebviewMessage | PickerAction | PromptBoxAction;

export const initialState: RootState = { activeSession: null, pickers: initialPickers, promptBox: initialPromptBox };

export function update(state: RootState, action: Action): Transition<RootState, WebviewToExtensionMessage> {
  const activeSession = updateActiveSession(state.activeSession, action);
  const pickers = updatePickers(state.pickers, action);
  const promptBox = updatePromptBox(state.promptBox, action, activeSession);
  const changed =
    activeSession !== state.activeSession || pickers.state !== state.pickers || promptBox.state !== state.promptBox;
  return {
    state: changed ? { activeSession, pickers: pickers.state, promptBox: promptBox.state } : state,
    outgoing: [...pickers.outgoing, ...promptBox.outgoing],
  };
}
