// @vitest-environment jsdom
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';
import type { WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import { ChatView } from '@/webview/views/ChatView';
import { initialState, update, type Action } from '@/webview/state/RootState';
import { createStore } from '@/webview/state/Store';
import { StoreContext } from '@/webview/views/StoreContext';
import { hookClasses } from '@tests/hookClasses';

afterEach(cleanup);

// jsdom has no layout to scroll, so the library's part is checked live; this records what the view hands it.
const stickToBottom = vi.hoisted(() => ({
  scrollElement: null as HTMLElement | null,
  contentElement: null as HTMLElement | null,
  scrollToBottom: vi.fn(),
  /** Whether the user is at the bottom, which the library decides from their scrolling. */
  setAtBottom: (_atBottom: boolean): void => {
    throw new Error('the transcript is not rendered');
  },
}));
vi.mock('use-stick-to-bottom', async () => {
  const { useState } = await import('react');
  return {
    useStickToBottom: () => {
      const [isAtBottom, setIsAtBottom] = useState(true);
      stickToBottom.setAtBottom = setIsAtBottom;
      return {
        scrollRef: (element: HTMLElement | null) => {
          stickToBottom.scrollElement = element;
        },
        contentRef: (element: HTMLElement | null) => {
          stickToBottom.contentElement = element;
        },
        isAtBottom,
        scrollToBottom: stickToBottom.scrollToBottom,
      };
    },
  };
});

type SessionUpdateKind = SessionUpdate['sessionUpdate'];

function renderChatView() {
  const posted: WebviewToExtensionMessage[] = [];
  let time = 0;
  const store = createStore(initialState, update, (message: WebviewToExtensionMessage) => posted.push(message), () => time);
  const send = (...actions: Action[]) => act(() => actions.forEach((action) => store.dispatch(action)));
  const { container } = render(
    <StoreContext value={store}>
      <ChatView />
    </StoreContext>,
  );
  const part = <T extends HTMLElement = HTMLElement>(selector: string): T => {
    const found = container.querySelector<T>(selector);
    if (!found) {
      throw new Error(`nothing matches ${selector}`);
    }
    return found;
  };
  return {
    container,
    store,
    send,
    part,
    all: (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)],
    at: (now: number) => {
      time = now;
    },
    connect: () =>
      send({
        type: 'state',
        activeSessionId: 's1',
        session: { sessionId: 's1', agentName: 'Fake', cwd: '/work', modes: null, configOptions: null, availableCommands: [] },
      }),
    update: <K extends SessionUpdateKind>(sessionUpdate: K, fields: Omit<Extract<SessionUpdate, { sessionUpdate: K }>, 'sessionUpdate'>) =>
      send({ type: 'sessionUpdate', sessionId: 's1', update: { sessionUpdate, ...fields } as SessionUpdate }),
    takePosted: () => posted.splice(0),
  };
}

const text = (value: string) => ({ content: { type: 'text' as const, text: value } });

/** Click the summary, as the user does, and wait for the `toggle` event the browser queues. */
async function toggle(details: HTMLDetailsElement): Promise<void> {
  const toggled = new Promise((resolve) => details.addEventListener('toggle', resolve, { once: true }));
  const summary = details.querySelector('summary');
  assert.exists(summary);
  fireEvent.click(summary);
  await act(() => toggled);
}

describe('the chat view', () => {
  it('lays out the banner, the transcript, the input area and the load overlay in that order', () => {
    const { container } = renderChatView();

    expect([...container.children].map((child) => child.id)).toEqual(['sessionBanner', 'transcript', 'inputArea', 'loadOverlay']);
  });

  it('gives the library that follows the stream the transcript to scroll and the entries inside it to watch', () => {
    const view = renderChatView();

    expect(stickToBottom.scrollElement).toBe(view.part('#transcript > #transcriptScroll'));
    expect(stickToBottom.contentElement).toBe(view.part('#transcriptScroll > #messages'));
  });

  it('follows the stream again when the user sends a prompt, and not as the agent streams', () => {
    const view = renderChatView();
    view.connect();
    stickToBottom.scrollToBottom.mockClear();

    view.update('agent_message_chunk', text('streaming'));
    expect(stickToBottom.scrollToBottom).not.toHaveBeenCalled();

    view.send({ type: 'promptEdited', text: 'question' }, { type: 'promptSent' });
    expect(stickToBottom.scrollToBottom).toHaveBeenCalledOnce();
  });

  it('covers the view only while a session loads', () => {
    const view = renderChatView();
    const overlay = view.part('#loadOverlay');
    expect(hookClasses(overlay)).toBe('load-overlay');

    view.connect();
    view.send({ type: 'loadSessionStart' });
    expect(hookClasses(overlay)).toBe('load-overlay visible');

    view.send({ type: 'loadSessionEnd', ok: true });
    expect(hookClasses(overlay)).toBe('load-overlay');
  });
});

describe('the jump to the end', () => {
  const jumpToEnd = (view: ReturnType<typeof renderChatView>) => view.container.querySelector<HTMLButtonElement>('#transcript > #jumpToEnd');

  it('is offered while the user reads during a turn, and follows the stream again', () => {
    const view = renderChatView();
    view.connect();
    view.send({ type: 'promptStart' });
    expect(jumpToEnd(view)).toBeNull();

    act(() => stickToBottom.setAtBottom(false));
    const button = jumpToEnd(view);
    assert.exists(button);
    expect(button.getAttribute('aria-label')).toBe('Jump to the end');
    stickToBottom.scrollToBottom.mockClear();
    fireEvent.click(button);
    expect(stickToBottom.scrollToBottom).toHaveBeenCalledOnce();

    act(() => stickToBottom.setAtBottom(true));
    expect(jumpToEnd(view)).toBeNull();
  });

  it('stays offered after the turn ends until the user is back at the bottom, and not after that', () => {
    const view = renderChatView();
    view.connect();
    view.send({ type: 'promptStart' });
    act(() => stickToBottom.setAtBottom(false));

    view.send({ type: 'promptEnd', stopReason: 'end_turn' });
    expect(jumpToEnd(view)).not.toBeNull();

    act(() => stickToBottom.setAtBottom(true));
    act(() => stickToBottom.setAtBottom(false));
    expect(jumpToEnd(view)).toBeNull();
  });

  it('is not offered when the user scrolls up with no turn running', () => {
    const view = renderChatView();
    view.connect();

    act(() => stickToBottom.setAtBottom(false));

    expect(jumpToEnd(view)).toBeNull();
  });
});

describe('the welcome card', () => {
  it('is shown at the top of the transcript until a session connects', () => {
    const view = renderChatView();
    const card = view.part('#emptyState');
    expect(view.part('#messages').firstElementChild).toBe(card);
    expect(card.style.display).toBe('');

    view.connect();

    expect(card.style.display).toBe('none');
  });

  it('runs the connect and add-agent commands', () => {
    const view = renderChatView();

    fireEvent.click(view.part('#welcomeConnectAgent'));
    fireEvent.click(view.part('#welcomeAddAgent'));

    expect(view.takePosted()).toEqual([
      { type: 'executeCommand', command: 'acp.connectAgent' },
      { type: 'executeCommand', command: 'acp.addAgent' },
    ]);
  });
});

describe('transcript entries', () => {
  it('draws prompts, turns and errors in order, with their classes, and a plan inside its turn', () => {
    const view = renderChatView();
    view.connect();
    view.send({ type: 'promptEdited', text: 'question' }, { type: 'promptSent' }, { type: 'promptStart' });
    view.update('agent_message_chunk', text('answer'));
    view.update('plan', {
      entries: [
        { content: 'done', status: 'completed', priority: 'high' },
        { content: '<b>next</b>', status: 'pending', priority: 'low' },
      ],
    });
    view.send({ type: 'error', message: 'boom' });

    const entries = [...view.part('#messages').children].filter((child) => child.id !== 'emptyState');
    expect(entries.map((entry) => `${hookClasses(entry)}: ${entry.textContent}`)).toEqual([
      'message user: question',
      'turn: answerPlan✅ done⬜ <b>next</b>',
      'message error: boom',
    ]);
    expect(view.container.querySelector('.turn > .plan')).not.toBeNull();
    expect(view.all('.plan-entry').map((entry) => hookClasses(entry))).toEqual(['plan-entry completed', 'plan-entry']);
    expect(view.container.querySelector('.plan b')).toBeNull();
  });

  it('draws no turn for whitespace before the answer', () => {
    const view = renderChatView();
    view.connect();

    view.update('agent_message_chunk', text('\n '));

    expect(view.all('.turn')).toEqual([]);
  });
});

describe('a turn', () => {
  it('shows its parts in the order they arrived', () => {
    const view = renderChatView();
    view.connect();
    view.update('tool_call', { toolCallId: 't1', title: 'Read' });
    view.update('agent_message_chunk', text('answer'));
    view.update('agent_thought_chunk', text('hmm'));

    expect([...view.part('.turn').children].map((child) => hookClasses(child))).toEqual([
      'turn-tools',
      'message agent',
      'thought-block streaming',
    ]);
  });

  it('renders the answer as markdown while it streams', () => {
    const view = renderChatView();
    view.connect();
    view.send({ type: 'promptStart' });
    view.update('agent_message_chunk', text('*x* and '));
    view.update('agent_message_chunk', text('**y**'));

    const message = view.part('.message.agent');
    expect(hookClasses(message)).toBe('message agent');
    expect([message.querySelector('em')?.textContent, message.querySelector('[data-streamdown="strong"]')?.textContent]).toEqual(['x', 'y']);
  });
});

describe('a thought', () => {
  it('is open with an indicator while the agent thinks, and closes with its duration when the answer starts', () => {
    const view = renderChatView();
    view.connect();
    view.at(1_000);
    view.update('agent_thought_chunk', text('let me think'));
    const thought = view.part<HTMLDetailsElement>('.thought-block');
    expect(hookClasses(thought)).toBe('thought-block streaming');
    expect(thought.open).toBe(true);
    expect(thought.querySelector('summary .thought-indicator')).not.toBeNull();
    expect(thought.querySelector('summary')?.textContent).toBe(' Thinking…');
    expect(thought.querySelector('.thought-content')?.textContent).toBe('let me think');

    view.at(3_000);
    view.update('agent_message_chunk', text('answer'));

    expect(hookClasses(thought)).toBe('thought-block');
    expect(thought.open).toBe(false);
    expect(thought.querySelector('summary')?.textContent).toBe('Thought for 2s');
  });

  it('tells the store when the user opens or closes it', async () => {
    const view = renderChatView();
    view.connect();
    view.update('agent_thought_chunk', text('hmm'));
    const thought = view.part<HTMLDetailsElement>('.thought-block');

    await toggle(thought);

    expect(thought.open).toBe(false);
    expect(view.store.getSnapshot().transcript.entries[0]).toMatchObject({ parts: [{ kind: 'thought', open: false }] });
  });
});

describe('tool calls', () => {
  it('shows the status, the title and the text content of each tool call', () => {
    const view = renderChatView();
    view.connect();
    view.update('tool_call', {
      toolCallId: 't1',
      title: 'Run',
      status: 'in_progress',
      content: [
        { type: 'content', content: { type: 'text', text: 'one' } },
        { type: 'content', content: { type: 'text', text: 'two' } },
      ],
    });
    view.update('tool_call', { toolCallId: 't2', title: '' });

    const [run, untitled] = view.all('.tool-call-inline');
    assert.exists(run);
    assert.exists(untitled);
    expect(run.id).toBe('tc-t1');
    expect(hookClasses(run.querySelector('.tc-icon'))).toBe('tc-icon running');
    expect(run.querySelector('.tc-icon')?.textContent).toBe('⟳');
    expect(run.querySelector('.tc-title')?.textContent).toBe('Run');
    expect([...run.querySelectorAll('.tc-body-block')].map((block) => block.textContent)).toEqual(['one', 'two']);
    expect(run.querySelector<HTMLElement>('.tc-body')?.style.display).toBe('');
    expect(run.querySelector('.tc-body-truncated')).toBeNull();
    expect(untitled.querySelector('.tc-title')?.textContent).toBe('Tool Call');
    expect(untitled.querySelector<HTMLElement>('.tc-body')?.style.display).toBe('none');
  });

  it('notes content cut off at the limit', () => {
    const view = renderChatView();
    view.connect();

    view.update('tool_call', {
      toolCallId: 't1',
      title: 'Run',
      content: [{ type: 'content', content: { type: 'text', text: 'x'.repeat(25_000) } }],
    });

    expect(view.part('.tc-body-block').textContent).toHaveLength(20_000);
    expect(view.part('.tc-body-truncated').textContent).toBe('... (output truncated)');
  });

  it('opens a failed tool call, and tells the store when the user closes it', async () => {
    const view = renderChatView();
    view.connect();
    view.update('tool_call', { toolCallId: 't1', title: 'Run', status: 'failed' });
    const call = view.part<HTMLDetailsElement>('#tc-t1');
    expect(call.open).toBe(true);

    await toggle(call);

    expect(call.open).toBe(false);
    expect(view.store.getSnapshot().transcript.entries[0]).toMatchObject({ parts: [{ kind: 'toolCalls', toolCalls: [{ open: false }] }] });
  });

  it('counts the tool calls and collapses or expands the list on a click of the count', () => {
    const view = renderChatView();
    view.connect();
    view.send({ type: 'promptStart' });
    view.update('tool_call', { toolCallId: 't1', title: 'Read' });
    const summary = view.part('.turn-tools-summary');
    const list = view.part('.turn-tools-list');
    expect(summary.textContent).toBe('▾ 1 tool call');

    for (const id of ['t2', 't3', 't4']) {
      view.update('tool_call', { toolCallId: id, title: 'Read' });
    }
    view.send({ type: 'promptEnd', stopReason: 'end_turn' });
    expect(summary.textContent).toBe('▸ 4 tool calls');
    expect(hookClasses(list)).toBe('turn-tools-list collapsed');

    fireEvent.click(summary);
    expect(summary.textContent).toBe('▾ 4 tool calls');
    expect(hookClasses(list)).toBe('turn-tools-list');
  });
});
