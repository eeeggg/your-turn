// @vitest-environment jsdom
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import { ChatView } from '@/webview/views/ChatView';
import { initialState, update, type Action } from '@/webview/state/RootState';
import { createStore } from '@/webview/state/Store';
import { StoreContext } from '@/webview/views/StoreContext';
import { hookClasses } from '@tests/hookClasses';

afterEach(cleanup);

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
  fireEvent.click(details.querySelector('summary')!);
  await act(() => toggled);
}

describe('the chat view', () => {
  it('lays out the banner, the transcript, the input area and the load overlay in that order', () => {
    const { container } = renderChatView();

    expect([...container.children].map((child) => child.id)).toEqual(['sessionBanner', 'messages', 'inputArea', 'loadOverlay']);
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
  it('draws prompts, turns, plans and errors in order, with their classes', () => {
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
      'turn: answer',
      'plan: Plan✅ done⬜ <b>next</b>',
      'message error: boom',
    ]);
    expect(view.all('.plan-entry').map((entry) => hookClasses(entry))).toEqual(['plan-entry completed', 'plan-entry']);
    expect(view.container.querySelector('.plan b')).toBeNull();
  });

  it('draws no turn for whitespace before the answer', () => {
    const view = renderChatView();
    view.connect();

    view.update('agent_message_chunk', text('\n '));

    expect(view.all('.turn')).toEqual([]);
  });

  it('scrolls to the bottom whenever the transcript changes', () => {
    const view = renderChatView();
    const messages = view.part('#messages');
    Object.defineProperty(messages, 'scrollHeight', { configurable: true, value: 640 });
    view.connect();

    view.update('agent_message_chunk', text('hello'));

    expect(messages.scrollTop).toBe(640);
  });
});

describe('a turn', () => {
  it('shows the thought, then the answer, then the tool calls', () => {
    const view = renderChatView();
    view.connect();
    view.update('tool_call', { toolCallId: 't1', title: 'Read' });
    view.update('agent_message_chunk', text('answer'));
    view.update('agent_thought_chunk', text('hmm'));

    expect([...view.part('.turn').children].map((child) => hookClasses(child))).toEqual([
      'thought-block streaming',
      'message agent',
      'turn-tools',
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
    expect(view.store.getSnapshot().transcript.entries[0]).toMatchObject({ thought: { open: false } });
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
    expect(run!.id).toBe('tc-t1');
    expect(hookClasses(run!.querySelector('.tc-icon'))).toBe('tc-icon running');
    expect(run!.querySelector('.tc-icon')?.textContent).toBe('⟳');
    expect(run!.querySelector('.tc-title')?.textContent).toBe('Run');
    expect([...run!.querySelectorAll('.tc-body-block')].map((block) => block.textContent)).toEqual(['one', 'two']);
    expect(run!.querySelector<HTMLElement>('.tc-body')?.style.display).toBe('');
    expect(run!.querySelector('.tc-body-truncated')).toBeNull();
    expect(untitled!.querySelector('.tc-title')?.textContent).toBe('Tool Call');
    expect(untitled!.querySelector<HTMLElement>('.tc-body')?.style.display).toBe('none');
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
    expect(view.store.getSnapshot().transcript.entries[0]).toMatchObject({ toolCalls: [{ open: false }] });
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
