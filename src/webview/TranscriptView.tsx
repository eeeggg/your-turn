import { memo, useLayoutEffect, useRef } from 'react';
import { useDispatch, useSelector } from '@/webview/StoreContext';
import {
  messageShown,
  planEntryIcon,
  showsWelcome,
  shownContent,
  statusClass,
  statusGlyph,
  thoughtSummary,
  turnShown,
  type AgentMessage,
  type EntryId,
  type Plan,
  type Thought,
  type ToolCall,
  type TranscriptEntry,
  type Turn,
} from '@/webview/Transcript';

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
    <div className="messages" id="messages" ref={ref}>
      <WelcomeCard shown={welcome} />
      {entries.map((entry) => (
        <Entry key={entry.id} entry={entry} />
      ))}
    </div>
  );
}

function WelcomeCard({ shown }: { shown: boolean }) {
  const dispatch = useDispatch();
  return (
    <div className="empty-state" id="emptyState" style={shown ? undefined : { display: 'none' }}>
      <div className="icon">🤖</div>
      <div className="title">ACP Chat</div>
      <div className="subtitle">Connect to an AI coding agent to start chatting.</div>
      <div className="actions">
        <button
          className="action-btn primary"
          id="welcomeConnectAgent"
          onClick={() => dispatch({ type: 'welcomeCommandChosen', command: 'acp.connectAgent' })}
        >
          🔌 Connect to Agent
        </button>
        <button
          className="action-btn secondary"
          id="welcomeAddAgent"
          onClick={() => dispatch({ type: 'welcomeCommandChosen', command: 'acp.addAgent' })}
        >
          ⚙ Add Agent
        </button>
      </div>
      <div className="hint">
        or press <kbd>Ctrl+Shift+A</kbd> anytime
      </div>
    </div>
  );
}

const Entry = memo(function Entry({ entry }: { entry: TranscriptEntry }) {
  switch (entry.kind) {
    case 'prompt':
      return <div className="message user">{entry.text}</div>;
    case 'turn':
      return <TurnView turn={entry} />;
    case 'plan':
      return <PlanView plan={entry} />;
    case 'error':
      return <div className="message error">{entry.text}</div>;
  }
});

function TurnView({ turn }: { turn: Turn }) {
  if (!turnShown(turn)) {
    return null;
  }
  return (
    <div className="turn">
      {turn.thought && <ThoughtBlock turnId={turn.id} thought={turn.thought} />}
      {messageShown(turn.message) && <AgentMessageView message={turn.message} />}
      {turn.toolCalls.length > 0 && (
        <ToolCallList turnId={turn.id} toolCalls={turn.toolCalls} collapsed={turn.toolCallsCollapsed} />
      )}
    </div>
  );
}

const ThoughtBlock = memo(function ThoughtBlock({ turnId, thought }: { turnId: EntryId; thought: Thought }) {
  const dispatch = useDispatch();
  const thinking = thought.endedAt === null;
  return (
    <details
      className={thinking ? 'thought-block streaming' : 'thought-block'}
      open={thought.open}
      onToggle={(event) => dispatch({ type: 'thoughtToggled', turnId, open: event.currentTarget.open })}
    >
      <summary>
        {thinking ? (
          <>
            <span className="thought-indicator" /> Thinking…
          </>
        ) : (
          thoughtSummary(thought)
        )}
      </summary>
      <div className="thought-content">{thought.text}</div>
    </details>
  );
});

/** Plain text while it streams; the extension's markdown rendering once it arrives. */
const AgentMessageView = memo(function AgentMessageView({ message }: { message: AgentMessage }) {
  return message.html === null ? (
    <div key="text" className="message agent">
      {message.text}
    </div>
  ) : (
    <div key="html" className="message agent md-rendered" dangerouslySetInnerHTML={{ __html: message.html }} />
  );
});

const ToolCallList = memo(function ToolCallList({
  turnId,
  toolCalls,
  collapsed,
}: {
  turnId: EntryId;
  toolCalls: readonly ToolCall[];
  collapsed: boolean;
}) {
  const dispatch = useDispatch();
  const count = toolCalls.length;
  return (
    <div className="turn-tools">
      <div className="turn-tools-summary" onClick={() => dispatch({ type: 'toolCallsToggled', turnId })}>
        {`${collapsed ? '▸' : '▾'} ${count} tool call${count === 1 ? '' : 's'}`}
      </div>
      <div className={collapsed ? 'turn-tools-list collapsed' : 'turn-tools-list'}>
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
      className="tool-call-inline"
      id={`tc-${call.toolCallId}`}
      open={call.open}
      onToggle={(event) =>
        dispatch({ type: 'toolCallToggled', turnId, toolCallId: call.toolCallId, open: event.currentTarget.open })
      }
    >
      <summary className="tc-summary">
        <span className={`tc-icon ${statusClass(call.status)}`}>{statusGlyph(call.status)}</span>
        <span className="tc-title">{call.title || 'Tool Call'}</span>
      </summary>
      <div className="tc-body" style={blocks.length === 0 ? { display: 'none' } : undefined}>
        <div className="tc-body-content">
          {blocks.map((text, index) => (
            <div key={index} className="tc-body-block">
              {text}
            </div>
          ))}
          {truncated && <div className="tc-body-truncated">... (output truncated)</div>}
        </div>
      </div>
    </details>
  );
});

function PlanView({ plan }: { plan: Plan }) {
  return (
    <div className="plan">
      <div className="plan-title">Plan</div>
      {plan.entries.map((entry, index) => (
        <div key={index} className={entry.status === 'completed' ? 'plan-entry completed' : 'plan-entry'}>
          {`${planEntryIcon(entry.status)} ${entry.content}`}
        </div>
      ))}
    </div>
  );
}
