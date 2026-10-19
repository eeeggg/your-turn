import type { ToolCallStatus } from '@agentclientprotocol/sdk';
import { memo, useLayoutEffect, useRef } from 'react';
import { Markdown } from '@/webview/views/Markdown';
import { useDispatch, useSelector } from '@/webview/views/StoreContext';
import {
  partShown,
  planEntryIcon,
  showsWelcome,
  shownContent,
  statusClass,
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

/** The scrolling transcript, with the welcome card at its top while there is neither a session nor a transcript. */
export function TranscriptView() {
  const entries = useSelector((state) => state.transcript.entries);
  const welcome = useSelector((state) => showsWelcome(state.transcript, state.activeSession));
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const messages = ref.current;
    if (messages) {
      messages.scrollTop = messages.scrollHeight;
    }
  }, [entries]);

  return (
    <div className="messages flex flex-1 flex-col gap-2 overflow-y-auto p-3" id="messages" ref={ref}>
      <WelcomeCard shown={welcome} />
      {entries.map((entry) => (
        <Entry key={entry.id} entry={entry} />
      ))}
    </div>
  );
}

const actionButton = 'flex cursor-pointer items-center justify-center gap-1.5 rounded-sm px-4 py-2 font-medium';

function WelcomeCard({ shown }: { shown: boolean }) {
  const dispatch = useDispatch();
  return (
    <div
      className="empty-state flex h-full flex-col items-center justify-center gap-1.5 px-5 py-6 text-center"
      id="emptyState"
      style={shown ? undefined : { display: 'none' }}
    >
      <div className="icon mb-1 text-[2.4em] opacity-85">🤖</div>
      <div className="title mb-0.5 text-lg font-semibold">ACP Chat</div>
      <div className="subtitle mb-3 text-sm leading-[1.4] text-muted-foreground">
        Connect to an AI coding agent to start chatting.
      </div>
      <div className="actions flex w-full max-w-55 flex-col gap-2">
        <button
          className={`action-btn primary ${actionButton} bg-primary text-primary-foreground hover:bg-primary-hover`}
          id="welcomeConnectAgent"
          onClick={() => dispatch({ type: 'welcomeCommandChosen', command: 'acp.connectAgent' })}
        >
          🔌 Connect to Agent
        </button>
        <button
          className={`action-btn secondary ${actionButton} bg-secondary text-secondary-foreground hover:bg-secondary-hover`}
          id="welcomeAddAgent"
          onClick={() => dispatch({ type: 'welcomeCommandChosen', command: 'acp.addAgent' })}
        >
          ⚙ Add Agent
        </button>
      </div>
      <div className="hint mt-2 text-xs text-muted-foreground">
        or press <kbd className="rounded-[3px] border border-border bg-card px-1.25 py-px font-mono text-[0.95em]">Ctrl+Shift+A</kbd>{' '}
        anytime
      </div>
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
        className={`thought-content mt-1 max-h-75 overflow-y-auto rounded-md border border-border bg-muted px-3 py-2 text-[0.88em] leading-normal text-muted-foreground italic ${plainText}`}
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

const ToolCallView = memo(function ToolCallView({ turnId, call }: { turnId: EntryId; call: ToolCall }) {
  const dispatch = useDispatch();
  const { blocks, truncated } = shownContent(call.texts);
  return (
    <details
      className="tool-call-inline rounded-sm bg-muted px-1.5 py-0.75 text-sm opacity-85 open:opacity-100"
      id={`tc-${call.toolCallId}`}
      open={call.open}
      onToggle={(event) =>
        dispatch({ type: 'toolCallToggled', turnId, toolCallId: call.toolCallId, open: event.currentTarget.open })
      }
    >
      <summary className="tc-summary flex cursor-pointer items-center gap-1.5 select-none">
        <span className={`tc-icon ${statusClass(call.status)} w-3.5 flex-none text-center ${statusColor[call.status]}`}>
          {statusGlyph(call.status)}
        </span>
        <span className="tc-title flex-1 truncate">{call.title || 'Tool Call'}</span>
      </summary>
      <div className="tc-body mt-1 border-t border-border pt-1" style={blocks.length === 0 ? { display: 'none' } : undefined}>
        <div className="tc-body-content max-h-80 overflow-y-auto font-mono text-[0.95em] leading-[1.45] opacity-90">
          {blocks.map((text, index) => (
            <div key={index} className={`tc-body-block mb-1 last:mb-0 ${plainText}`}>
              {text}
            </div>
          ))}
          {truncated && <div className="tc-body-truncated mt-1 text-muted-foreground italic">... (output truncated)</div>}
        </div>
      </div>
    </details>
  );
});

const statusColor: Record<ToolCallStatus, string> = {
  pending: 'text-pending',
  in_progress: 'text-progress',
  completed: 'text-success',
  failed: 'text-failure',
};

function PlanView({ plan }: { plan: Plan }) {
  return (
    <div className="plan rounded-lg border border-border bg-muted px-3 py-2">
      <div className="plan-title mb-1.5 font-semibold">Plan</div>
      {plan.entries.map((entry, index) => (
        <div
          key={index}
          className={`plan-entry flex items-center gap-1.5 py-0.5 ${entry.status === 'completed' ? 'completed text-muted-foreground line-through' : ''}`}
        >
          {`${planEntryIcon(entry.status)} ${entry.content}`}
        </div>
      ))}
    </div>
  );
}
