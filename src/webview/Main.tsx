import '@/webview/chat';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { ExtensionToWebviewMessage } from '@/shared/WebviewMessages';
import { initialChatState, update, type ChatEvent, type ChatState } from '@/webview/ChatState';
import { InputToolbar } from '@/webview/InputToolbar';
import { createStore, type Store } from '@/webview/Store';
import { StoreContext } from '@/webview/StoreContext';
import { postMessage } from '@/webview/VsCodeApi';

const posting = createStore(initialChatState, update, postMessage);
// chat.ts and the webview suite read the DOM as soon as an event is handled,
// so each dispatch renders before it returns.
const store: Store<ChatState, ChatEvent> = {
  ...posting,
  dispatch: (event) => flushSync(() => posting.dispatch(event)),
};

window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => store.dispatch(event.data));
document.addEventListener('click', () => store.dispatch({ type: 'pickersClosed' }));

const toolbar = document.getElementById('inputToolbar');
if (!toolbar) {
  throw new Error('The chat page has no #inputToolbar.');
}
const root = createRoot(toolbar);
flushSync(() =>
  root.render(
    <StoreContext value={store}>
      <InputToolbar />
    </StoreContext>,
  ),
);

postMessage({ type: 'ready' });
