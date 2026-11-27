import { useCallback, useLayoutEffect, useRef } from 'react';
import { InputArea } from '@/webview/views/InputArea';
import { SessionTabs } from '@/webview/views/SessionTabs';
import { ChildTranscriptContext, useDispatch, useSelector } from '@/webview/views/StoreContext';
import { ChildTranscript, OpenChildTranscript, TranscriptView } from '@/webview/views/TranscriptView';
import { Questions } from '@/webview/views/Questions';
import type { QueuedPrompt } from '@/webview/state/Transcript';
import { Chevron } from '@/webview/views/elements/Chevron';

/** The whole page of the chat view. */
export function ChatView() {
  const rootId = useSelector((state) => state.transcript.projection?.target.sessionId);
  const children = useSelector((state) => state.children);
  const path = useSelector((state) => state.inspection?.path);
  const received = useSelector((state) => state.inspection?.received);
  const childId = path?.at(-1);
  const dispatch = useDispatch();
  const parent = useRef<HTMLDivElement>(null);
  const focused = useRef<HTMLElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const positions = useRef<{ id: string; completionId?: number; scrollTop: number }[]>([]);
  const returning = useRef(false);
  const pendingReturn = useRef<(typeof positions.current)[number] | undefined>(undefined);
  const scrollPane = useCallback((child: boolean) => {
    return child ? focused.current?.querySelector<HTMLElement>('.messages') : parent.current?.querySelector<HTMLElement>('#transcriptScroll');
  }, []);
  const open = useCallback((id: string, completionId?: number) => {
    positions.current.push({ id, ...(completionId === undefined ? {} : { completionId }), scrollTop: scrollPane(childId !== undefined)?.scrollTop ?? 0 });
    dispatch({ type: 'childOpened', id });
  }, [childId, dispatch, scrollPane]);
  const restore = useCallback((position: (typeof positions.current)[number], child: boolean) => {
    const pane = scrollPane(child);
    if (pane) { pane.scrollTop = position.scrollTop; }
    const container = child ? focused.current : parent.current;
    const completion = position.completionId === undefined ? undefined
      : container?.querySelector<HTMLButtonElement>(`[data-child-completion="${position.completionId}"]`);
    const opener = Array.from(container?.querySelectorAll<HTMLButtonElement>('[data-child-session]') ?? [])
      .find((button) => button.dataset['childSession'] === position.id);
    (completion ?? opener ?? back.current)?.focus({ preventScroll: true });
  }, [scrollPane]);
  useLayoutEffect(() => {
    if (!returning.current) {
      pendingReturn.current = undefined;
      if (childId === undefined) { positions.current = []; }
      else { back.current?.focus({ preventScroll: true }); }
      return;
    }
    returning.current = false;
    const position = positions.current.pop();
    if (!position) { return; }
    if (childId === undefined) { restore(position, false); }
    else { pendingReturn.current = position; }
  }, [childId, restore]);
  useLayoutEffect(() => {
    if (received && pendingReturn.current) {
      restore(pendingReturn.current, true);
      pendingReturn.current = undefined;
    }
  }, [childId, received, restore]);

  const list = (id: string | undefined) => {
    const immediate = children?.filter((child) => child.parentId === id);
    return immediate?.length ? <nav aria-label="Child sessions" className="shrink-0 border-b border-border px-3 py-1 text-sm">
      <p className="text-muted-foreground">Child sessions</p>
      <ul className="flex max-h-24 flex-wrap gap-x-3 overflow-y-auto">
        {immediate.map((child) => <li key={child.id} className="min-w-0"><button type="button" data-child-session={child.id}
          className="cursor-pointer wrap-anywhere text-left text-link underline focus-visible:outline-1 focus-visible:outline-ring"
          onClick={() => open(child.id)}>{child.label}</button></li>)}
      </ul>
    </nav> : null;
  };
  return (
    <OpenChildTranscript value={open}>
    <div id="chatLayers" className="relative flex min-h-0 flex-1 flex-col">
      <div id="parentChat" ref={parent} className="relative z-0 flex min-h-0 flex-1 flex-col" inert={childId !== undefined} aria-hidden={childId === undefined ? undefined : true}>
        <SessionTabs />
        {list(rootId)}
        <TranscriptView />
        <Questions>
          <QueuedPrompts />
          <InputArea />
        </Questions>
      </div>
      {childId !== undefined && <section ref={focused} aria-label="Child transcript" className="absolute inset-0 z-10 flex min-h-0 flex-col bg-background">
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-2 text-sm">
          <button type="button" ref={back} className="cursor-pointer text-link underline focus-visible:outline-1 focus-visible:outline-ring"
            onClick={() => { returning.current = true; dispatch({ type: 'childBack' }); }}>Back</button>
          <h2 className="min-w-0 wrap-anywhere font-semibold">{children?.find((child) => child.id === childId)?.label ?? childId}</h2>
        </header>
        {list(childId)}
        <ChildTranscriptContext value={true}>
          <ChildTranscript key={childId} />
        </ChildTranscriptContext>
      </section>}
      <LoadOverlay />
    </div>
    </OpenChildTranscript>
  );
}

/** Runtime queue projection, oldest first; pinned outside the scrolling transcript. */
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

/** Covers replay and transcript delivery until the extension ends loading. */
function LoadOverlay() {
  const loading = useSelector((state) => state.activeSession?.loading ?? false);
  return (
    <div
      className={`load-overlay ${loading ? 'visible flex' : 'hidden'} fixed inset-0 z-400 flex-col items-center justify-center gap-2.5 bg-background/88 text-md text-foreground backdrop-blur-[2px]`}
      id="loadOverlay"
      role="status"
      aria-live="polite"
    >
      <div className="label animate-pulse opacity-85 motion-reduce:animate-none">Loading transcript…</div>
    </div>
  );
}
