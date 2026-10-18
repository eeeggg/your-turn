import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import { initialPickers, updatePickers, type PickerAction, type PickersState } from '@/webview/Pickers';
import type { Transition } from '@/webview/Store';

/** The parts of the chat view that have moved from chat.ts to the store. */
export interface ChatState {
  readonly pickers: PickersState;
}

/** Messages from the extension, and what the user did in the views. */
export type ChatEvent = ExtensionToWebviewMessage | PickerAction;

export const initialChatState: ChatState = { pickers: initialPickers };

export function update(state: ChatState, event: ChatEvent): Transition<ChatState, WebviewToExtensionMessage> {
  const pickers = updatePickers(state.pickers, event);
  return {
    state: pickers.state === state.pickers ? state : { ...state, pickers: pickers.state },
    outgoing: pickers.outgoing,
  };
}
