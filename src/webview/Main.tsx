import { showSentPrompt } from '@/webview/chat';
import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import { InputArea } from '@/webview/InputArea';
import { initialState, update, type Action, type RootState } from '@/webview/RootState';
import { SessionBanner } from '@/webview/SessionBanner';
import { createStore, type Store } from '@/webview/Store';
import { StoreContext } from '@/webview/StoreContext';
import { postMessage } from '@/webview/VsCodeApi';

// Until the transcript moves to the store and handles promptSent itself,
// chat.ts shows each prompt as it is sent.
function post(message: WebviewToExtensionMessage): void {
  if (message.type === 'sendPrompt') {
    showSentPrompt(message.text);
  }
  postMessage(message);
}

const posting = createStore(initialState, update, post);
// chat.ts and the webview suite read the DOM as soon as a webview message or
// user action is handled, so each dispatch renders before it returns.
const store: Store<RootState, Action> = {
  ...posting,
  dispatch: (action) => flushSync(() => posting.dispatch(action)),
};

window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => store.dispatch(event.data));
document.addEventListener('click', () => store.dispatch({ type: 'pickersClosed' }));

function mount(containerId: string, view: ReactNode): void {
  const container = document.getElementById(containerId);
  if (!container) {
    throw new Error(`The webview page has no #${containerId}.`);
  }
  const root = createRoot(container);
  flushSync(() => root.render(<StoreContext value={store}>{view}</StoreContext>));
}

mount('sessionBannerRoot', <SessionBanner />);
mount('inputAreaRoot', <InputArea />);

postMessage({ type: 'ready' });
