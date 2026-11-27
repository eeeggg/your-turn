import {
  memo,
  createContext,
  use,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react';
import ArrowDown from 'lucide-react/icons/arrow-down';
import ArrowRight from 'lucide-react/icons/arrow-right';
import Check from 'lucide-react/icons/check';
import CircleDashed from 'lucide-react/icons/circle-dashed';
import CircleDot from 'lucide-react/icons/circle-dot';
import Copy from 'lucide-react/icons/copy';
import Square from 'lucide-react/icons/square';
import SquareCheck from 'lucide-react/icons/square-check';
import X from 'lucide-react/icons/x';
import type { LucideIcon } from 'lucide-react';
import { useStickToBottom } from 'use-stick-to-bottom';
import { Chevron } from '@/webview/views/elements/Chevron';
import type { PlanStepStatus, PresentationTarget, QuestionRecord, ToolCallStatus } from '@/shared/WebviewMessages';
import { copyFeedbackDuration, Markdown } from '@/webview/views/Markdown';
import { ToolCallDiffView } from '@/webview/views/ToolCallDiffView';
import { ChildTranscriptContext, useDispatch, useSelector } from '@/webview/views/StoreContext';
import {
  compactionBlocks,
  compactionSummary,
  partShown,
  showsEmptyState,
  shownContent,
  thoughtSummary,
  turnShown,
  type AgentMessage,
  type Compaction,
  type EntryId,
  type PartIndex,
  type Plan,
  type ShownBlock,
  type Thought,
  type ToolCall,
  type ToolCallGroup,
  type TranscriptEntry,
  type TranscriptAction,
  type ChildCompletion,
  type TranscriptState,
  type Turn,
  type TurnPart,
} from '@/webview/state/Transcript';

export const OpenChildTranscript = createContext<((id: string, completionId: number) => void) | null>(null);

function ChildCompletionEntry({ completion }: { completion: ChildCompletion }) {
  const open = use(OpenChildTranscript);
  const label = useSelector((state) => state.children?.find(({ id }) => id === completion.childId)?.label);
  const reason = completion.stopReason;
  const status = reason === 'end_turn' ? 'Finished' : reason === 'cancelled' ? 'Cancelled' : reason === 'error' ? 'Failed'
    : reason === 'max_tokens' ? 'Token limit reached' : reason === 'max_turn_requests' ? 'Turn request limit reached'
      : reason === 'refusal' ? 'Refused' : reason === null ? 'Stopped (no reason reported)' : `Stopped (${reason})`;
  return <button type="button" data-child-completion={completion.id} disabled={!open || label === undefined}
    className="self-start rounded-sm border border-border px-2 py-1 text-left text-sm text-link focus-visible:outline-1 focus-visible:outline-ring enabled:cursor-pointer enabled:hover:underline"
    onClick={() => open?.(completion.childId, completion.id)}>{label ?? completion.childId} — {status}</button>;
}

function useTranscript<T>(select: (state: TranscriptState) => T): T {
  const child = use(ChildTranscriptContext);
  return useSelector((state) => select(child && state.inspection ? state.inspection.transcript : state.transcript));
}

function useTranscriptDispatch() {
  const child = use(ChildTranscriptContext);
  const dispatch = useDispatch();
  return (action: TranscriptAction) => dispatch(child ? { type: 'childTranscriptAction', action } : action);
}

export function ChildTranscript() {
  const entries = useTranscript((state) => state.entries);
  const received = useSelector((state) => state.inspection?.received);
  return <div className="messages flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
    {!received ? <p role="status">Opening child transcript…</p> : entries.length === 0 && <p>No child transcript has been reported.</p>}
    {entries.map((entry) => <Entry key={entry.id} entry={entry} />)}
  </div>;
}

/**
 * The scrolling transcript, following the stream until the user scrolls up to read, with the empty state at its top
 * while there is neither a session nor a transcript, and a jump to the end while the user reads during a turn.
 */
export function TranscriptView() {
  const entries = useSelector((state) => state.transcript.entries);
  const empty = useSelector((state) => showsEmptyState(state.transcript, state.activeSession));
  const followRequests = useSelector((state) => state.transcript.followRequests);
  const turnRunning = useSelector((state) => state.activeSession?.turnRunning ?? false);
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom();
  // Offered while the user reads during a turn, and kept after the turn ends until they are back at the bottom.
  const [jumpOffered, setJumpOffered] = useState(false);
  if (jumpOffered ? isAtBottom : !isAtBottom && turnRunning) {
    setJumpOffered(!jumpOffered);
  }

  useLayoutEffect(() => {
    void scrollToBottom();
  }, [followRequests, scrollToBottom]);

  return (
    <div className="transcript relative flex min-h-0 flex-1 flex-col" id="transcript">
      <div
        className="transcript-scroll flex-1 overflow-y-auto"
        id="transcriptScroll"
        ref={scrollRef}
        data-vscode-context='{"preventDefaultContextMenuItems":true}'
      >
        <div className="messages flex min-h-full flex-col gap-2 p-3" id="messages" ref={contentRef}>
          <EmptyState shown={empty} />
          {entries.map((entry) => (
            <Entry key={entry.id} entry={entry} />
          ))}
        </div>
      </div>
      {jumpOffered && <JumpToEnd onClick={() => void scrollToBottom()} />}
    </div>
  );
}

function JumpToEnd({ onClick }: { onClick: () => void }) {
  // The hover color can be translucent, so it is laid over the opaque background instead of replacing it.
  return (
    <button
      type="button"
      aria-label="Jump to the end"
      title="Jump to the end"
      className="jump-to-end absolute bottom-3 left-1/2 flex size-8 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full border border-popover-border bg-popover text-popover-foreground shadow-popover hover:bg-linear-to-b hover:from-hover hover:to-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
      id="jumpToEnd"
      onClick={onClick}
    >
      <ArrowDown size={16} aria-hidden="true" />
    </button>
  );
}

/** The agent actions live in the Agents view alone, so this only points there. */
function EmptyState({ shown }: { shown: boolean }) {
  return (
    <div
      className="empty-state flex flex-1 items-center justify-center px-5 py-6 text-center text-sm text-muted-foreground"
      id="emptyState"
      style={shown ? undefined : { display: 'none' }}
    >
      Add or pick an agent in the Agents view to start a session.
    </div>
  );
}

const messageBox = 'max-w-[95%] rounded-lg px-3 py-2 leading-normal';
const plainText = 'whitespace-pre-wrap wrap-anywhere';

const Entry = memo(function Entry({ entry }: { entry: TranscriptEntry }) {
  switch (entry.kind) {
    case 'childCompletion':
      return <ChildCompletionEntry completion={entry} />;
    case 'prompt':
      return (
        <CopyableMessage
          author="user"
          markdown={entry.text}
          className={`${messageBox} ${plainText} self-end bg-primary text-primary-foreground`}
        >
          {entry.text}
        </CopyableMessage>
      );
    case 'promptImage':
      return <AgentImageView src={entry.src} alt="Image in user prompt" reference={entry.reference} fallback={entry.fallback} />;
    case 'turn':
      return <TurnView turn={entry} />;
    case 'compaction':
      return <CompactionBlock compaction={entry} />;
    case 'question':
      return <QuestionRecordBlock record={entry.record} open={entry.open} />;
    case 'error':
      return (
        <div
          className={`message error ${messageBox} ${plainText} self-center border border-destructive-border bg-destructive text-destructive-foreground`}
        >
          {entry.text}
        </div>
      );
  }
});

function TurnView({ turn }: { turn: Turn }) {
  const current = useTranscript((state) => state.currentTurn === turn.id);
  if (!turnShown(turn)) {
    return null;
  }
  const last = turn.parts.length - 1;
  return (
    <div className="turn flex max-w-[95%] flex-col gap-1 self-start">
      {turn.parts.map((part, index) => (
        <PartView key={index} turnId={turn.id} index={index} part={part} streaming={current && index === last} />
      ))}
    </div>
  );
}

const PartView = memo(function PartView({
  turnId,
  index,
  part,
  streaming,
}: {
  turnId: EntryId;
  index: PartIndex;
  part: TurnPart;
  streaming: boolean;
}) {
  if (!partShown(part)) {
    return null;
  }
  switch (part.kind) {
    case 'childCompletion':
      return <ChildCompletionEntry completion={part} />;
    case 'message':
      return <AgentMessageView message={part} streaming={streaming} />;
    case 'image':
      return <AgentImageView src={part.src} reference={part.reference} fallback={part.fallback} />;
    case 'thought':
      return <ThoughtBlock turnId={turnId} index={index} thought={part} />;
    case 'toolCalls':
      return <ToolCallList turnId={turnId} index={index} group={part} />;
    case 'plan':
      return <PlanView plan={part} />;
    case 'compaction':
      return <CompactionBlock compaction={part} />;
    case 'question':
      return <QuestionRecordBlock record={part.record} open={part.open} />;
  }
});

function AgentImageView({ src, alt = 'Image from agent', reference, fallback }: { src: string | null; alt?: string; reference?: true | undefined; fallback?: string | undefined }) {
  const [image, setImage] = useState({ src, failed: false });
  if (image.src !== src) {
    setImage({ src, failed: false });
  }
  const failed = image.src === src && image.failed;
  return src && !failed
    ? <img src={src} alt={alt} className="h-auto w-auto max-h-96 max-w-full self-start object-contain" onError={() => setImage({ src, failed: true })} />
    : <span role="img" aria-label={`${alt}: ${reference ? 'Image reference not displayed' : failed ? 'Image not displayed: browser could not render it' : `Image not displayed${fallback ? `: ${fallback}` : ''}`}`}>
      {reference ? 'Image reference not displayed' : failed ? 'Image not displayed: browser could not render it' : `Image not displayed${fallback ? `: ${fallback}` : ''}`}
    </span>;
}

const QuestionRecordBlock = memo(function QuestionRecordBlock({ record, open }: { record: QuestionRecord; open: boolean }) {
  const dispatch = useTranscriptDispatch();
  const outcome = record.response.action === 'accept' ? 'Submitted' : record.response.action === 'decline' ? 'Declined' : 'Cancelled';
  return <details className="question-record mb-1 w-full max-w-full" open={open} onToggle={(event) => {
    if (event.target === event.currentTarget && event.currentTarget.open !== open) {
      dispatch({ type: 'questionRecordToggled', interactionId: record.interactionId, open: event.currentTarget.open });
    }
  }}>
    <summary className="flex cursor-pointer items-center gap-1.5 rounded-sm px-2 py-1 text-sm text-muted-foreground focus-visible:outline-1 focus-visible:outline-ring list-none">
      <Chevron direction={open ? 'down' : 'right'} />
      Elicitation — {outcome}{record.title === null ? '' : `: ${record.title}`}
    </summary>
    <div className="mt-1 space-y-2 rounded-md border border-border bg-muted px-3 py-2 text-sm whitespace-pre-wrap wrap-anywhere">
      <p className="text-muted-foreground">{record.agentName}</p>
      <p>{record.message}</p>
      {record.description !== null && <p>{record.description}</p>}
      {record.fields.map((field) => <div key={field.name} className="space-y-1">
        <p className="font-semibold">{field.title ?? field.name}{field.required ? ' *' : ''}</p>
        {field.description !== null && <p>{field.description}</p>}
        {field.choices?.map((choice) => <p key={choice.value}>{choice.title} ({JSON.stringify(choice.value)}){choice.description === null ? '' : ` — ${choice.description}`}</p>)}
      </div>)}
      {record.response.action === 'accept' ? <dl className="space-y-2">
        {Object.entries(record.response.content).map(([name, value]) => {
          const field = record.fields.find((field) => field.name === name);
          return <div key={name}><dt className="font-semibold">{field?.title ?? name}</dt><dd>{JSON.stringify(value)}</dd></div>;
        })}
      </dl> : <p>No answers sent.</p>}
    </div>
  </details>;
});

const CompactionBlock = memo(function CompactionBlock({ compaction }: { compaction: Compaction }) {
  const dispatch = useTranscriptDispatch();
  const blocks = useMemo(() => compactionBlocks(compaction.summary), [compaction.summary]);
  const progressing = compaction.status === 'in_progress';
  const header = <>
    {progressing && <span aria-hidden="true" className="compaction-indicator inline-block size-1.5 flex-none animate-pulse motion-reduce:animate-none rounded-full bg-progress forced-colors:border forced-colors:border-current" />}
    {compactionSummary(compaction)}
  </>;
      const error = compaction.error !== null && compaction.error !== '' ? <CompactionError error={compaction.error} /> : null;
  if (blocks.length === 0) {
    return <div className="compaction-block mb-1 w-full max-w-full"><div className="compaction-header flex items-center gap-1.5 rounded-sm px-2 py-1 text-sm text-muted-foreground">{header}</div>{error}</div>;
  }
  return <><details
    className="compaction-block group mb-1 w-full max-w-full"
    open={compaction.open}
    onToggle={(event) => {
      if (event.target === event.currentTarget) {
        dispatch({ type: 'compactionToggled', compactionId: compaction.compactionId, open: event.currentTarget.open });
      }
    }}
  >
    <summary className="compaction-header flex cursor-pointer items-center gap-1.5 rounded-sm px-2 py-1 text-sm text-muted-foreground select-none hover:text-foreground focus-visible:outline-1 focus-visible:outline-ring list-none">
      <Chevron direction={compaction.open ? 'down' : 'right'} />
      {header}
    </summary>
    {compaction.open && (
      <div className="compaction-content mt-1 rounded-md border border-border bg-muted px-3 py-2 text-[0.88em] leading-normal wrap-anywhere">
        {blocks.map((block, index) => block.kind === 'text'
          ? <div key={index}><Markdown text={block.text} streaming={progressing} /></div>
          : <div key={index} className="text-muted-foreground italic">Unsupported {block.type} content</div>)}
      </div>
    )}
  </details>{error}</>;
});

function CompactionError({ error }: { error: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="compaction-error mt-1 text-sm text-muted-foreground"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer items-center gap-1.5 rounded-sm px-2 py-1 focus-visible:outline-1 focus-visible:outline-ring list-none">
        <Chevron direction={open ? 'down' : 'right'} />
        Reported error
      </summary>
      <pre className={`rounded-md border border-border bg-muted px-3 py-2 ${plainText}`}>{error}</pre>
    </details>
  );
}

const ThoughtBlock = memo(function ThoughtBlock({ turnId, index, thought }: { turnId: EntryId; index: PartIndex; thought: Thought }) {
  const dispatch = useTranscriptDispatch();
  const thinking = thought.endedAt === null;
  return (
    <details
      className={`thought-block ${thinking ? 'streaming ' : ''}group mb-1 w-full`}
      open={thought.open}
      onToggle={(event) => dispatch({ type: 'thoughtToggled', turnId, part: index, open: event.currentTarget.open })}
    >
      <summary className="flex cursor-pointer items-center gap-1.5 rounded-sm px-2 py-1 text-sm text-muted-foreground select-none hover:text-foreground focus-visible:outline-1 focus-visible:outline-ring list-none">
        <Chevron direction={thought.open ? 'down' : 'right'} />
        {thinking ? (
          <>
            <span aria-hidden="true" className="thought-indicator inline-block size-1.5 flex-none animate-pulse motion-reduce:animate-none rounded-full bg-progress forced-colors:border forced-colors:border-current" />{' '}
            Thinking…
          </>
        ) : (
          thoughtSummary(thought)
        )}
      </summary>
      {thought.open && (
        <div
          className={`thought-content mt-1 rounded-md border border-border bg-muted px-3 py-2 text-[0.88em] leading-normal text-muted-foreground italic ${plainText}`}
        >
          {thought.imageSrc === undefined ? <Markdown key={thought.markdownRevision ?? 0} text={thought.text} streaming={thinking} /> : <AgentImageView src={thought.imageSrc} alt="Image in agent thought" reference={thought.imageReference} fallback={thought.imageFallback} />}
        </div>
      )}
    </details>
  );
});

const AgentMessageView = memo(function AgentMessageView({ message, streaming }: { message: AgentMessage; streaming: boolean }) {
  return (
    <CopyableMessage author="agent" markdown={message.text} className={`${messageBox} self-start border border-border bg-card wrap-anywhere`}>
      <Markdown key={message.markdownRevision ?? 0} text={message.text} streaming={streaming} />
    </CopyableMessage>
  );
});

function CopyableMessage({
  author,
  markdown,
  className,
  children,
}: {
  author: 'agent' | 'user';
  markdown: string;
  className: string;
  children: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  return (
    <div
      className={`message ${author} group relative pr-8 ${className}`}
    >
      <div ref={contentRef} className="message-content">{children}</div>
      <CopyMessageButton author={author} markdown={markdown} contentRef={contentRef} />
    </div>
  );
}

function CopyMessageButton({
  author,
  markdown,
  contentRef,
}: {
  author: 'agent' | 'user';
  markdown: string;
  contentRef: RefObject<HTMLDivElement | null>;
}) {
  const [copied, setCopied] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
    }
  }, []);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [menuOpen]);

  const copy = async (text: string, format: 'text' | 'Markdown') => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setAnnouncement(`Copied ${format}`);
      timer.current = setTimeout(() => {
        setCopied(false);
        timer.current = null;
      }, copyFeedbackDuration);
    } catch {
      setCopied(false);
      setAnnouncement('Could not copy message');
    }
  };

  const copyText = () => copy(contentRef.current?.innerText || contentRef.current?.textContent || '', 'text');
  const copyMarkdown = () => copy(markdown, 'Markdown');

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={author === 'agent' ? 'Copy options' : 'Copy message'}
        aria-expanded={author === 'agent' ? menuOpen : undefined}
        aria-controls={author === 'agent' ? menuId : undefined}
        title={author === 'agent' ? 'Copy options' : 'Copy message'}
        className="message-copy absolute top-1 right-1 z-10 inline-flex size-6 cursor-pointer items-center justify-center rounded-sm bg-transparent text-current opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-hover:pointer-events-auto pointer-events-none hover:bg-transparent focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring motion-reduce:transition-none"
        onClick={() => author === 'agent' ? setMenuOpen((open) => !open) : void copyText()}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && menuOpen) {
            event.preventDefault();
            setMenuOpen(false);
          }
        }}
      >
        <span className={`inline-flex transition-transform duration-150 motion-reduce:transition-none ${copied ? 'scale-100' : 'scale-90'}`}>
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        </span>
      </button>
      {author === 'agent' && <div
        ref={menuRef}
        id={menuId}
        role="group"
        aria-label="Copy options"
        className={`${menuOpen ? 'flex' : 'hidden'} absolute top-8 right-1 z-20 min-w-32 flex-col rounded-sm border border-popover-border bg-popover p-1 text-control text-popover-foreground shadow-popover`}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            setMenuOpen(false);
            triggerRef.current?.focus();
          }
        }}
      >
        <button
          type="button"
          className="cursor-pointer rounded-sm px-2 py-1 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => {
            setMenuOpen(false);
            triggerRef.current?.focus();
            void copyText();
          }}
        >
          Copy
        </button>
        <button
          type="button"
          className="cursor-pointer rounded-sm px-2 py-1 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => {
            setMenuOpen(false);
            triggerRef.current?.focus();
            void copyMarkdown();
          }}
        >
          Copy Markdown
        </button>
      </div>}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    </>
  );
}

const ToolCallList = memo(function ToolCallList({ turnId, index, group }: { turnId: EntryId; index: PartIndex; group: ToolCallGroup }) {
  const dispatch = useTranscriptDispatch();
  const child = use(ChildTranscriptContext);
  const instance = useId();
  const listId = child ? instance : `tc-list-${turnId}-${index}`;
  const { toolCalls, collapsed } = group;
  const count = toolCalls.length;
  return (
    <div className="turn-tools my-0.5 flex flex-col gap-0.5 border-l-2 border-border pl-2.5">
      <button
        type="button"
        className="turn-tools-summary flex cursor-pointer items-center gap-1.5 py-0.5 text-xs text-muted-foreground select-none hover:text-foreground focus-visible:outline-1 focus-visible:outline-ring"
        aria-expanded={!collapsed}
        aria-controls={listId}
        onClick={() => dispatch({ type: 'toolCallsToggled', turnId, part: index })}
      >
        <Chevron direction={collapsed ? 'right' : 'down'} />
        {`${count} tool call${count === 1 ? '' : 's'}`}
      </button>
      <div id={listId} className={collapsed ? 'turn-tools-list collapsed hidden' : 'turn-tools-list'}>
        {!collapsed && toolCalls.map((call) => (
          <ToolCallView key={call.toolCallId} turnId={turnId} call={call} />
        ))}
      </div>
    </div>
  );
});

/** Its body is mounted only while it is open, keeping closed tool calls lightweight. */
const ToolCallView = memo(function ToolCallView({ turnId, call }: { turnId: EntryId; call: ToolCall }) {
  const dispatch = useTranscriptDispatch();
  const commandSource = useTranscript((state) => firstCommandSource(call.content, state.terminals));
  const child = use(ChildTranscriptContext);
  const identity = useTranscript((state) => child ? undefined : state.projection?.target);
  const title = call.title || 'Tool Call';
  const StatusIcon = statusIcon[call.status];
  return (
    <details
      className="tool-call-inline rounded-sm bg-muted px-1.5 py-0.75 text-sm opacity-85 open:opacity-100"
      id={child ? undefined : `tc-${call.toolCallId}`}
      open={call.open}
      onToggle={(event) =>
        dispatch({ type: 'toolCallToggled', turnId, toolCallId: call.toolCallId, open: event.currentTarget.open })
      }
    >
      <summary
        className="tc-summary flex cursor-pointer items-center gap-1.5 rounded-sm select-none focus-visible:outline-1 focus-visible:outline-ring list-none"
        data-vscode-context={!child && commandSource !== undefined ? commandOutputContext(commandSource, identity, call.toolCallId, title) : undefined}
      >
        <span
          className={`tc-icon ${call.status} inline-flex size-3.5 flex-none items-center justify-center ${statusColor[call.status]}`}
          aria-hidden="true"
        >
          <StatusIcon
            size={14}
            className={call.status === 'running' ? 'animate-pulse motion-reduce:animate-none' : undefined}
          />
        </span>
        <span className="sr-only">{`${statusLabel[call.status]}: `}</span>
        <span className={`tc-title min-w-0 flex-1 ${call.open ? 'whitespace-pre-wrap wrap-anywhere' : 'truncate'}`}>{title}</span>
      </summary>
      {call.open && <ToolCallBody call={call} identity={identity} title={title} />}
    </details>
  );
});

function ToolCallBody({ call, identity, title }: { call: ToolCall; identity: PresentationTarget | undefined; title: string }) {
  const terminals = useTranscript((state) => state.terminals);
  const sessionEnded = useTranscript((state) => state.sessionEnded);
  const { blocks, truncated } = useMemo(
    () => shownContent(call.content, { terminals, sessionEnded }, true),
    [call.content, terminals, sessionEnded],
  );
  const { scrollRef, contentRef } = useStickToBottom({ initial: 'instant', resize: 'instant' });
  return (
    <div className="tc-body mt-1 border-t border-border pt-1" style={blocks.length === 0 ? { display: 'none' } : undefined}>
      <div ref={scrollRef} className="tc-body-content max-h-80 overflow-y-auto font-mono text-[0.95em] leading-[1.45] opacity-90">
        <div ref={contentRef} className="tc-body-inner">
          {blocks.map((block, index) => {
            switch (block.kind) {
              case 'text':
                return (
                  <div key={index} className={`tc-body-block mb-1 last:mb-0 ${plainText}`}>
                    <Markdown key={call.markdownRevision ?? 0} text={block.text} streaming={call.status === 'running'} />
                  </div>
                );
              case 'image':
                return <AgentImageView key={index} src={block.src} alt="Image in tool output" reference={block.reference} fallback={block.fallback} />;
              case 'command':
                return <CommandOutputView key={index} block={block} identity={identity} toolCallId={call.toolCallId} title={title} />;
              case 'diff':
                return <ToolCallDiffView key={index} files={block.files} toolCallId={call.toolCallId} firstFile={block.firstFile} />;
            }
          })}
          {truncated && <div className="tc-body-truncated mt-1 text-muted-foreground italic">... (output truncated)</div>}
        </div>
      </div>
    </div>
  );
}

type CommandBlock = Extract<ShownBlock, { kind: 'command' }>;

function firstCommandSource(
  content: ToolCall['content'],
  terminals: ReadonlyMap<string, unknown>,
): string | null | undefined {
  for (const item of content) {
    if (item.kind === 'commandOutput') {
      return null;
    }
    if (item.kind === 'terminal' && terminals.has(item.terminalId)) {
      return item.terminalId;
    }
  }
  return undefined;
}

/**
 * What Open in Terminal reads, which `package.json` contributes to `webview/context` for a right-click on the command's
 * output or its tool call's title; VS Code's own items stay, so the output can be copied.
 */
function commandOutputContext(terminalId: string | null, identity: PresentationTarget | undefined, toolCallId: string, title: string): string | undefined {
  if (!identity) {
    return undefined;
  }
  const source = terminalId !== null ? { yourTurnTerminalId: terminalId } : { yourTurnToolCallId: toolCallId };
  return JSON.stringify({ webviewSection: 'commandOutput', yourTurnTarget: identity, yourTurnTitle: title, ...source });
}

function CommandOutputView({ block, identity, toolCallId, title }: {
  block: CommandBlock;
  identity: PresentationTarget | undefined;
  toolCallId: string;
  title: string;
}) {
  return (
    <div className="tc-command mb-1 last:mb-0" data-vscode-context={commandOutputContext(block.terminalId, identity, toolCallId, title)}>
      {block.truncated && <div className="tc-command-cut mb-1 text-muted-foreground italic">Earlier output not shown</div>}
      {block.text && <div className={`tc-command-text ${plainText}`}>{block.text}</div>}
      {block.status === 'disconnected' && (
        <div className="tc-command-disconnected mt-1 text-muted-foreground italic">The agent disconnected before the command finished.</div>
      )}
      {block.failure && <div className="tc-command-failure mt-1 text-failure">{block.failure}</div>}
    </div>
  );
}

const statusIcon: Record<ToolCallStatus, LucideIcon> = {
  pending: CircleDashed,
  running: CircleDot,
  completed: Check,
  failed: X,
};

const statusLabel: Record<ToolCallStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
};

const statusColor: Record<ToolCallStatus, string> = {
  pending: 'text-pending',
  running: 'text-progress',
  completed: 'text-success',
  failed: 'text-failure',
};

const planStepIcon: Record<PlanStepStatus, LucideIcon> = {
  pending: Square,
  running: ArrowRight,
  completed: SquareCheck,
};

const planStepColor: Record<PlanStepStatus, string> = {
  pending: 'text-muted-foreground',
  running: 'text-progress',
  completed: 'text-success',
};

const planStepLabel: Record<PlanStepStatus, string> = {
  pending: 'Pending',
  running: 'In progress',
  completed: 'Completed',
};

function PlanView({ plan }: { plan: Plan }) {
  return (
    <div className="plan rounded-lg border border-border bg-muted px-3 py-2">
      <div className="plan-title mb-1.5 font-semibold">Plan</div>
      <ul className="m-0 list-none p-0">
        {plan.steps.map((step, index) => {
          const StepIcon = planStepIcon[step.status];
          return (
            <li
              key={index}
              className={`plan-entry flex items-start gap-1.5 py-0.5 ${step.status === 'completed' ? 'completed text-muted-foreground line-through' : ''}`}
            >
              <span
                className={`plan-icon mt-0.5 inline-flex size-3.5 flex-none items-center justify-center ${planStepColor[step.status]}`}
                aria-hidden="true"
              >
                <StepIcon size={14} />
              </span>
              <span className="sr-only">{`${planStepLabel[step.status]}: `}</span>
              <span>{step.text}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
