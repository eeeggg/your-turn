import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import { updateActiveSession, type ActiveSession } from '@/webview/ActiveSession';
import { initialPickers, updatePickers, type PickerAction, type PickersState } from '@/webview/Pickers';
import type { Transition } from '@/webview/Store';

/** Every area of the chat view that has moved from chat.ts to the store. */
export interface RootState {
  readonly activeSession: ActiveSession | null;
  readonly pickers: PickersState;
}

/** What the store is dispatched: webview messages from the extension, and user actions. */
export type Action = ExtensionToWebviewMessage | PickerAction;

export const initialState: RootState = { activeSession: null, pickers: initialPickers };

export function update(state: RootState, action: Action): Transition<RootState, WebviewToExtensionMessage> {
  const activeSession = updateActiveSession(state.activeSession, action);
  const pickers = updatePickers(state.pickers, action);
  const changed = activeSession !== state.activeSession || pickers.state !== state.pickers;
  return {
    state: changed ? { activeSession, pickers: pickers.state } : state,
    outgoing: pickers.outgoing,
  };
}
