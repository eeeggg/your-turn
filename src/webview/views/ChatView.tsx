import { InputArea } from '@/webview/views/InputArea';
import { SessionBanner } from '@/webview/views/SessionBanner';
import { useDispatch, useSelector } from '@/webview/views/StoreContext';
import { TranscriptView } from '@/webview/views/TranscriptView';
import { Questions } from '@/webview/views/Questions';

/** The whole page of the chat view. */
export function ChatView() {
  return (
    <>
      <SessionBanner />
      <TranscriptView />
      <Questions>
        <QueuedPrompts />
        <InputArea />
      </Questions>
      <LoadOverlay />
    </>
  );
}

/** Prompts sent during a turn, next to go out at the top; pinned outside the transcript, so they stay in view while it scrolls. */
function QueuedPrompts() {
  const queued = useSelector((state) => state.transcript.queued);
  const dispatch = useDispatch();
  if (queued.length === 0) {
    return null;
  }
  return (
    <ul
      className="queued-prompts flex max-h-40 flex-none flex-col gap-1.5 overflow-y-auto border-t border-border px-3 py-2"
      id="queuedPrompts"
      aria-label="Queued prompts"
    >
      {queued.map((text, index) => (
        <li
          key={index}
          className="queued-prompt flex max-w-[95%] flex-col gap-0.5 self-end rounded-lg border border-dashed border-border bg-muted px-3 py-1.5 text-muted-foreground"
          title={text}
        >
          <div className="flex items-center justify-between gap-3">
            <span className="queued-label text-xs font-semibold tracking-[0.5px] uppercase">Queued</span>
            {index === 0 && (
              <button
                type="button"
                className="send-now cursor-pointer rounded-sm bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground hover:bg-secondary-hover"
                title="Stop the running turn and send this prompt"
                onClick={() => dispatch({ type: 'sendNowChosen' })}
              >
                Send now
              </button>
            )}
          </div>
          <span className="queued-text line-clamp-3 leading-normal whitespace-pre-wrap wrap-anywhere">{text}</span>
        </li>
      ))}
    </ul>
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
