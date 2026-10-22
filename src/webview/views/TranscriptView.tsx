import { memo, useLayoutEffect, useMemo, useState } from 'react';
import { useStickToBottom } from 'use-stick-to-bottom';
import type { ToolCallStatus } from '@/shared/WebviewMessages';
import { Markdown } from '@/webview/views/Markdown';
import { ToolCallDiffView } from '@/webview/views/ToolCallDiffView';
import { useDispatch, useSelector } from '@/webview/views/StoreContext';
import {
  partShown,
  planStepIcon,
  showsEmptyState,
  shownContent,
  statusGlyph,
  thoughtSummary,
  turnShown,
  type AgentMessage,
  type EntryId,
  type PartIndex,
  type Plan,
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
      <div className="transcript-scroll flex-1 overflow-y-auto" id="transcriptScroll" ref={scrollRef}>
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
      return <div className={`message user ${messageBox} ${plainText} self-end bg-primary text-primary-foreground`}>{entry.text}</div>;
    case 'turn':
      return <TurnView turn={entry} />;
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
    case 'thought':
      return <ThoughtBlock turnId={turnId} index={index} thought={part} />;
    case 'toolCalls':
      return <ToolCallList turnId={turnId} index={index} group={part} />;
    case 'plan':
      return <PlanView plan={part} />;
  }
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
        {thought.text}
      </div>
    </details>
  );
});

const AgentMessageView = memo(function AgentMessageView({ message, streaming }: { message: AgentMessage; streaming: boolean }) {
  return (
    <div className={`message agent ${messageBox} self-start border border-border bg-card wrap-anywhere`}>
      <Markdown text={message.text} streaming={streaming} />
    </div>
  );
});

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

/** Its diffs are worked out only while it is open, as a closed one shows none and a whole file can take a while. */
const ToolCallView = memo(function ToolCallView({ turnId, call }: { turnId: EntryId; call: ToolCall }) {
  const dispatch = useDispatch();
  const cwd = useSelector((state) => state.activeSession?.cwd ?? null);
  const { blocks, truncated } = useMemo(() => shownContent(call.content, cwd, call.open), [call.content, cwd, call.open]);  return (
    <details
      className="tool-call-inline rounded-sm bg-muted px-1.5 py-0.75 text-sm opacity-85 open:opacity-100"
      id={`tc-${call.toolCallId}`}
      open={call.open}
      onToggle={(event) =>
        dispatch({ type: 'toolCallToggled', turnId, toolCallId: call.toolCallId, open: event.currentTarget.open })
      }
    >
      <summary className="tc-summary flex cursor-pointer items-center gap-1.5 select-none">
        <span className={`tc-icon ${call.status} w-3.5 flex-none text-center ${statusColor[call.status]}`}>
          {statusGlyph(call.status)}
        </span>
        <span className="tc-title flex-1 truncate">{call.title || 'Tool Call'}</span>
      </summary>
      <div className="tc-body mt-1 border-t border-border pt-1" style={blocks.length === 0 ? { display: 'none' } : undefined}>
        <div className="tc-body-content max-h-80 overflow-y-auto font-mono text-[0.95em] leading-[1.45] opacity-90">
          {blocks.map((block, index) =>
            block.kind === 'text' ? (
              <div key={index} className={`tc-body-block mb-1 last:mb-0 ${plainText}`}>
                {block.text}
              </div>
            ) : (
              <ToolCallDiffView key={index} files={block.files} toolCallId={call.toolCallId} firstFile={block.firstFile} />
            ),
          )}
          {truncated && <div className="tc-body-truncated mt-1 text-muted-foreground italic">... (output truncated)</div>}
        </div>
      </div>
    </details>
  );
});

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
