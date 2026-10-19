import { InputArea } from '@/webview/views/InputArea';
import { SessionBanner } from '@/webview/views/SessionBanner';
import { useSelector } from '@/webview/views/StoreContext';
import { TranscriptView } from '@/webview/views/TranscriptView';

/** The whole page of the chat view. */
export function ChatView() {
  return (
    <>
      <SessionBanner />
      <TranscriptView />
      <InputArea />
      <LoadOverlay />
    </>
  );
}

/** Covers the chat view while the agent replays a session's transcript. */
function LoadOverlay() {
  const loading = useSelector((state) => state.activeSession?.loading ?? false);
  return (
    <div className={loading ? 'load-overlay visible' : 'load-overlay'} id="loadOverlay" role="status" aria-live="polite">
      <div className="spinner" />
      <div className="label">Loading transcript…</div>
    </div>
  );
}
