import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { ExtensionToWebviewMessage } from '@/shared/WebviewMessages';
import { ChatView } from '@/webview/views/ChatView';
import { initialState, update, type Action, type RootState } from '@/webview/state/RootState';
import { createStore, type Store } from '@/webview/state/Store';
import { StoreContext } from '@/webview/views/StoreContext';
import { postMessage } from '@/webview/VsCodeApi';

const posting = createStore(initialState, update, postMessage);
// The webview suite reads the DOM as soon as a webview message or user action
// is handled, so each dispatch renders before it returns.
const store: Store<RootState, Action> = {
  ...posting,
  dispatch: (action) => flushSync(() => posting.dispatch(action)),
};

window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => store.dispatch(event.data));
document.addEventListener('click', () => store.dispatch({ type: 'pickersClosed' }));

const container = document.getElementById('chatView');
if (!container) {
  throw new Error('The webview page has no #chatView.');
}
const root = createRoot(container);
flushSync(() =>
  root.render(
    <StoreContext value={store}>
      <ChatView />
    </StoreContext>,
  ),
);

postMessage({ type: 'ready' });
