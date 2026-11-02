import { useLayoutEffect, useRef } from 'react';
import { InputArea } from '@/webview/views/InputArea';
import { SessionBanner } from '@/webview/views/SessionBanner';
import { useDispatch, useSelector } from '@/webview/views/StoreContext';
import { TranscriptView } from '@/webview/views/TranscriptView';
import { Questions } from '@/webview/views/Questions';
import type { QueuedPrompt } from '@/webview/state/Transcript';
import { Chevron } from '@/webview/views/elements/Chevron';

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
  const running = useSelector((state) => state.activeSession?.turnRunning ?? false);
  if (queued.length === 0) {
    return null;
  }
  return (
    <ul
      className="queued-prompts mx-3 mb-2 flex max-h-40 flex-none flex-col gap-1.5 overflow-y-auto rounded-md border border-border bg-muted p-2"
      id="queuedPrompts"
      aria-label="Queued prompts"
    >
      {queued.map((prompt, index) => <QueuedPromptRow key={prompt.id} prompt={prompt} sendNow={index === 0 && running} />)}
    </ul>
  );
}

function QueuedPromptRow({ prompt, sendNow }: { prompt: QueuedPrompt; sendNow: boolean }) {
  const dispatch = useDispatch();
  const editor = useRef<HTMLTextAreaElement>(null);
  const promptButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const editing = prompt.draft !== null;
  useLayoutEffect(() => {
    if (editing) { editor.current?.focus(); }
    else if (wasEditing.current) { promptButton.current?.focus(); }
    wasEditing.current = editing;
  }, [editing]);
  const button = 'cursor-pointer rounded-sm px-1.5 py-0.5 text-xs hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring';
  const contentId = `queued-prompt-${prompt.id}`;
  return <li className="queued-prompt flex w-full min-w-0 flex-col gap-1 rounded-md border border-border bg-input px-3 py-1.5 text-foreground" title={prompt.text}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-1">
        <button type="button" className={button} aria-label={prompt.open ? 'Collapse queued prompt' : 'Expand queued prompt'} aria-expanded={prompt.open} aria-controls={contentId}
          onClick={() => dispatch({ type: 'queuedPromptToggled', id: prompt.id })}>
          <Chevron direction={prompt.open ? 'up' : 'down'} />
        </button>
        <span className="queued-label text-xs font-semibold tracking-[0.5px] uppercase">Queued</span>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <button type="button" className={button} aria-label="Cancel queued prompt"
          onClick={() => dispatch({ type: 'queuedPromptCancelled', id: prompt.id })}>Cancel</button>
        {sendNow && <>
          <button type="button" className={button + ' steer-now'} disabled={editing}
            title="Send this prompt without stopping foreground work" onClick={() => dispatch({ type: 'steerNowChosen', id: prompt.id })}>Steer now</button>
          <button type="button" className="send-now cursor-pointer rounded-sm bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground hover:bg-secondary-hover focus-visible:outline-2 focus-visible:outline-ring"
            title="Stop the running turn and send this prompt" onClick={() => dispatch({ type: 'sendNowChosen', id: prompt.id })}>Stop and send now</button>
        </>}
      </div>
    </div>
    {editing ? <textarea ref={editor} id={contentId} aria-label="Queued prompt text" rows={3}
      className="w-full min-w-0 resize-y rounded-sm border border-control-border bg-input px-2 py-1 text-input-foreground outline-none focus:border-ring"
      value={prompt.draft} onChange={(event) => dispatch({ type: 'queuedPromptEdited', id: prompt.id, text: event.target.value })}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) { return; }
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          dispatch({ type: 'queuedPromptEditSaved', id: prompt.id });
        } else if (event.key === 'Escape') {
          event.preventDefault();
          dispatch({ type: 'queuedPromptEditDiscarded', id: prompt.id });
        }
      }} />
      : <button type="button" ref={promptButton} id={contentId} aria-label="Edit queued prompt"
        onClick={() => dispatch({ type: 'queuedPromptEditStarted', id: prompt.id })}
        className={`queued-text w-full cursor-text rounded-sm text-left ${prompt.open ? '' : 'line-clamp-3'} leading-normal whitespace-pre-wrap wrap-anywhere focus-visible:outline-2 focus-visible:outline-ring`}>{prompt.text}</button>}
  </li>;
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
