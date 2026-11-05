import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react';
import { useStickToBottom } from 'use-stick-to-bottom';
import type { QuestionRecord, ToolCallStatus } from '@/shared/WebviewMessages';
import { copyFeedbackDuration, Markdown } from '@/webview/views/Markdown';
import { ToolCallDiffView } from '@/webview/views/ToolCallDiffView';
import { useDispatch, useSelector } from '@/webview/views/StoreContext';
import {
  compactionBlocks,
  compactionSummary,
  partShown,
  planStepIcon,
  showsEmptyState,
  shownContent,
  statusGlyph,
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
  type Turn,
  type TurnPart,
} from '@/webview/state/Transcript';

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
      className="jump-to-end absolute bottom-3 left-1/2 flex size-8 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full border border-popover-border bg-popover text-popover-foreground shadow-popover hover:bg-linear-to-b hover:from-hover hover:to-hover"
      id="jumpToEnd"
      onClick={onClick}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 5v14" />
        <path d="m19 12-7 7-7-7" />
      </svg>
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
  const current = useSelector((state) => state.transcript.currentTurn === turn.id);
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
  const dispatch = useDispatch();
  const outcome = record.response.action === 'accept' ? 'Submitted' : record.response.action === 'decline' ? 'Declined' : 'Cancelled';
  return <details className="question-record mb-1 w-full max-w-full" open={open} onToggle={(event) => {
    if (event.target === event.currentTarget && event.currentTarget.open !== open) {
      dispatch({ type: 'questionRecordToggled', interactionId: record.interactionId, open: event.currentTarget.open });
    }
  }}>
    <summary className="cursor-pointer rounded-sm px-2 py-1 text-sm text-muted-foreground focus-visible:outline-1 focus-visible:outline-ring">Elicitation — {outcome}{record.title === null ? '' : `: ${record.title}`}</summary>
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
  const dispatch = useDispatch();
  const blocks = useMemo(() => compactionBlocks(compaction.summary), [compaction.summary]);
  const progressing = compaction.status === 'in_progress';
  const header = <>
    {progressing && <span aria-hidden="true" className="compaction-indicator inline-block size-1.5 flex-none animate-thought-pulse rounded-full bg-progress" />}
    {compactionSummary(compaction)}
  </>;
  const headerClass = 'compaction-header flex items-center gap-1.5 rounded-sm px-2 py-1 text-sm text-muted-foreground';
  const error = compaction.error !== null && compaction.error !== '' ? <details className="compaction-error mt-1 text-sm text-muted-foreground">
    <summary className="cursor-pointer px-2 py-1">Reported error</summary>
    <pre className={`rounded-md border border-border bg-muted px-3 py-2 ${plainText}`}>{compaction.error}</pre>
  </details> : null;
  if (blocks.length === 0) {
    return <div className="compaction-block mb-1 w-full max-w-full"><div className={headerClass}>{header}</div>{error}</div>;
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
    <summary className={`${headerClass} cursor-pointer select-none before:text-[0.9em] before:content-['▸'] group-open:before:content-['▾'] hover:text-foreground`}>{header}</summary>
    <div className="compaction-content mt-1 rounded-md border border-border bg-muted px-3 py-2 text-[0.88em] leading-normal wrap-anywhere">
      {blocks.map((block, index) => block.kind === 'text'
        ? <div key={index}><Markdown text={block.text} streaming={progressing} /></div>
        : <div key={index} className="text-muted-foreground italic">Unsupported {block.type} content</div>)}
    </div>
  </details>{error}</>;
});

const ThoughtBlock = memo(function ThoughtBlock({ turnId, index, thought }: { turnId: EntryId; index: PartIndex; thought: Thought }) {
  const dispatch = useDispatch();
  const thinking = thought.endedAt === null;
  return (
    <details
      className={`thought-block ${thinking ? 'streaming ' : ''}group mb-1 w-full`}
      open={thought.open}
      onToggle={(event) => dispatch({ type: 'thoughtToggled', turnId, part: index, open: event.currentTarget.open })}
    >
      <summary className="flex cursor-pointer items-center gap-1.5 rounded-sm px-2 py-1 text-sm text-muted-foreground select-none before:text-[0.9em] before:content-['▸'] group-open:before:content-['▾'] hover:text-foreground">
        {thinking ? (
          <>
            <span className="thought-indicator inline-block size-1.5 flex-none animate-thought-pulse rounded-full bg-progress" />{' '}
            Thinking…
          </>
        ) : (
          thoughtSummary(thought)
        )}
      </summary>
      <div
        className={`thought-content mt-1 rounded-md border border-border bg-muted px-3 py-2 text-[0.88em] leading-normal text-muted-foreground italic ${plainText}`}
      >
        {thought.imageSrc === undefined ? <Markdown key={thought.markdownRevision ?? 0} text={thought.text} streaming={thinking} /> : <AgentImageView src={thought.imageSrc} alt="Image in agent thought" reference={thought.imageReference} fallback={thought.imageFallback} />}
      </div>
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
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={`transition-transform duration-150 motion-reduce:transition-none ${copied ? 'scale-100' : 'scale-90'}`}
        >
          {copied ? (
            <path d="M20 6 9 17l-5-5" />
          ) : (
            <>
              <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
              <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 0.9 2 2" />
            </>
          )}
        </svg>
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
  const dispatch = useDispatch();
  const { toolCalls, collapsed } = group;
  const count = toolCalls.length;
  return (
    <div className="turn-tools my-0.5 flex flex-col gap-0.5 border-l-2 border-border pl-2.5">
      <div
        className="turn-tools-summary cursor-pointer py-0.5 text-xs text-muted-foreground select-none hover:text-foreground"
        onClick={() => dispatch({ type: 'toolCallsToggled', turnId, part: index })}
      >
        {`${collapsed ? '▸' : '▾'} ${count} tool call${count === 1 ? '' : 's'}`}
      </div>
      <div className={collapsed ? 'turn-tools-list collapsed hidden' : 'turn-tools-list'}>
        {toolCalls.map((call) => (
          <ToolCallView key={call.toolCallId} turnId={turnId} call={call} />
        ))}
      </div>
    </div>
  );
});

/** Its diffs are drawn only while it is open, as a closed one shows none. */
const ToolCallView = memo(function ToolCallView({ turnId, call }: { turnId: EntryId; call: ToolCall }) {
  const dispatch = useDispatch();
  const terminals = useSelector((state) => state.transcript.terminals);
  const sessionEnded = useSelector((state) => state.transcript.sessionEnded);
  const sessionId = useSelector((state) => state.transcript.sessionId);
  const title = call.title || 'Tool Call';
  const { blocks, truncated, running } = useMemo(
    () => shownContent(call.content, { terminals, sessionEnded }, call.open),
    [call.content, terminals, sessionEnded, call.open],
  );
  const { scrollRef, contentRef } = useStickToBottom({ initial: 'instant', resize: 'instant' });
  const command = blocks.find((block): block is CommandBlock => block.kind === 'command');
  return (
    <details
      className="tool-call-inline rounded-sm bg-muted px-1.5 py-0.75 text-sm opacity-85 open:opacity-100"
      id={`tc-${call.toolCallId}`}
      open={call.open}
      onToggle={(event) =>
        dispatch({ type: 'toolCallToggled', turnId, toolCallId: call.toolCallId, open: event.currentTarget.open })
      }
    >
      <summary
        className="tc-summary flex cursor-pointer items-center gap-1.5 select-none"
        data-vscode-context={command && commandOutputContext(command, sessionId, call.toolCallId, title)}
      >
        <span className={`tc-icon ${call.status} w-3.5 flex-none text-center ${statusColor[call.status]}`}>
          {statusGlyph(call.status)}
        </span>
        <span className="tc-title flex-1 truncate">{title}</span>
        {running && (
          <span
            className="tc-running spinner inline-block size-3 flex-none animate-spin rounded-full border-2 border-foreground border-t-transparent opacity-60"
            title="Command running"
          />
        )}
      </summary>
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
                  return <CommandOutputView key={index} block={block} sessionId={sessionId} toolCallId={call.toolCallId} title={title} />;
                case 'diff':
                  return <ToolCallDiffView key={index} files={block.files} toolCallId={call.toolCallId} firstFile={block.firstFile} />;
              }
            })}
            {truncated && <div className="tc-body-truncated mt-1 text-muted-foreground italic">... (output truncated)</div>}
          </div>
        </div>
      </div>
    </details>
  );
});

type CommandBlock = Extract<ShownBlock, { kind: 'command' }>;

/**
 * What Open in Terminal reads, which `package.json` contributes to `webview/context` for a right-click on the command's
 * output or its tool call's title; VS Code's own items stay, so the output can be copied.
 */
function commandOutputContext(block: CommandBlock, sessionId: string | null, toolCallId: string, title: string): string | undefined {
  if (sessionId === null) {
    return undefined;
  }
  const source = block.terminalId !== null ? { yourTurnTerminalId: block.terminalId } : { yourTurnToolCallId: toolCallId };
  return JSON.stringify({ webviewSection: 'commandOutput', yourTurnSessionId: sessionId, yourTurnTitle: title, ...source });
}

function CommandOutputView({ block, sessionId, toolCallId, title }: {
  block: CommandBlock;
  sessionId: string | null;
  toolCallId: string;
  title: string;
}) {
  return (
    <div className="tc-command mb-1 last:mb-0" data-vscode-context={commandOutputContext(block, sessionId, toolCallId, title)}>
      {block.truncated && <div className="tc-command-cut mb-1 text-muted-foreground italic">Earlier output not shown</div>}
      {block.text && <div className={`tc-command-text ${plainText}`}>{block.text}</div>}
      {block.status === 'disconnected' && (
        <div className="tc-command-disconnected mt-1 text-muted-foreground italic">The agent disconnected before the command finished.</div>
      )}
      {block.failure && <div className="tc-command-failure mt-1 text-failure">{block.failure}</div>}
    </div>
  );
}

const statusColor: Record<ToolCallStatus, string> = {
  pending: 'text-pending',
  running: 'text-progress',
  completed: 'text-success',
  failed: 'text-failure',
};

function PlanView({ plan }: { plan: Plan }) {
  return (
    <div className="plan rounded-lg border border-border bg-muted px-3 py-2">
      <div className="plan-title mb-1.5 font-semibold">Plan</div>
      {plan.steps.map((step, index) => (
        <div
          key={index}
          className={`plan-entry flex items-center gap-1.5 py-0.5 ${step.status === 'completed' ? 'completed text-muted-foreground line-through' : ''}`}
        >
          {`${planStepIcon(step.status)} ${step.text}`}
        </div>
      ))}
    </div>
  );
}
