import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import { ChatView } from '@/webview/views/ChatView';
import { contentApplied, initialState, update, type Action, type RootState } from '@/webview/state/RootState';
import { createStore, type Store } from '@/webview/state/Store';
import { StoreContext } from '@/webview/views/StoreContext';
import { postMessage } from '@/webview/VsCodeApi';

let pendingComposer: Extract<WebviewToExtensionMessage, { type: 'composerEdited' }> | undefined;
let composerTimer: ReturnType<typeof setTimeout> | undefined;
let editingComposer = false;

function flushComposer(): void {
  if (composerTimer !== undefined) { clearTimeout(composerTimer); composerTimer = undefined; }
  const pending = pendingComposer;
  pendingComposer = undefined;
  if (pending) { postMessage(pending); }
}

const posting = createStore(initialState, update, (message) => {
  if (message.type === 'composerEdited' && editingComposer) {
    if (composerTimer !== undefined) { clearTimeout(composerTimer); }
    pendingComposer = message;
    composerTimer = setTimeout(flushComposer, 200);
    return;
  }
  if (message.type === 'composerEdited' || message.type === 'sendPrompt'
    || message.type === 'selectSessionTab' || message.type === 'closeSessionTab') { flushComposer(); }
  postMessage(message);
});
window.addEventListener('pagehide', flushComposer);

const store: Store<RootState, Action> = {
  ...posting,
  dispatch: (action) => {
    if (action.type === 'promptSent' || action.type === 'slashCommandChosen') { flushComposer(); }
    editingComposer = action.type === 'promptEdited';
    try {
      if (action.type === 'markdownImageMounted' || action.type === 'markdownImageUnmounted') {
        posting.dispatch(action);
      } else {
        flushSync(() => posting.dispatch(action));
      }
    } finally { editingComposer = false; }
  },
};

let pendingApplied: ReturnType<typeof contentApplied>;
let appliedTimer: ReturnType<typeof setTimeout> | undefined;

window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
  const message = event.data;
  if (message.type === 'viewSnapshot' || message.type === 'contentSnapshot') { flushComposer(); }
  const previousProjection = store.getSnapshot().transcript.projection?.target.projection;
  store.dispatch(message);
  const applied = contentApplied(store.getSnapshot(), message);
  if (applied) {
    if (message.type === 'contentPatch' && message.baseTarget && applied.target.projection !== previousProjection) { flushComposer(); }
    pendingApplied = applied;
    appliedTimer ??= setTimeout(() => {
      const message = pendingApplied;
      pendingApplied = undefined;
      appliedTimer = undefined;
      if (message) { postMessage(message); }
    }, 50);
  }
});
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
