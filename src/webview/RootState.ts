import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import { initialPickers, updatePickers, type PickerAction, type PickersState } from '@/webview/Pickers';
import type { Transition } from '@/webview/Store';

/** Every area of the chat view that has moved from chat.ts to the store. */
export interface RootState {
  readonly pickers: PickersState;
}

/** What the store is dispatched: webview messages from the extension, and user actions. */
export type Action = ExtensionToWebviewMessage | PickerAction;

export const initialState: RootState = { pickers: initialPickers };

export function update(state: RootState, action: Action): Transition<RootState, WebviewToExtensionMessage> {
  const pickers = updatePickers(state.pickers, action);
  return {
    state: pickers.state === state.pickers ? state : { ...state, pickers: pickers.state },
    outgoing: pickers.outgoing,
  };
}
