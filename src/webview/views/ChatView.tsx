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
    <div
      className={`load-overlay ${loading ? 'visible flex' : 'hidden'} fixed inset-0 z-400 flex-col items-center justify-center gap-2.5 bg-background/88 text-md text-foreground backdrop-blur-[2px]`}
      id="loadOverlay"
      role="status"
      aria-live="polite"
    >
      <div className="spinner inline-block size-5.5 animate-spin rounded-full border-3 border-foreground border-t-transparent opacity-90" />
      <div className="label opacity-85">Loading transcript…</div>
    </div>
  );
}
