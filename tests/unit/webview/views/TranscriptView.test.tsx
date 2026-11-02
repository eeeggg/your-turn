// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';
import type { DiffFile, ExtensionToWebviewMessage, ToolCallContent, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import { ChatView } from '@/webview/views/ChatView';
import { initialState, update, type Action } from '@/webview/state/RootState';
import { createStore } from '@/webview/state/Store';
import { StoreContext } from '@/webview/views/StoreContext';
import { hookClasses } from '@tests/hookClasses';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A file as the extension sends it; by default one it reported no lines of. */
const diffFile = (file: Partial<DiffFile> & Pick<DiffFile, 'operation' | 'path'>): DiffFile => ({
  oldPath: null,
  added: 0,
  removed: 0,
  hunks: [],
  note: null,
  opens: 'file',
  ...file,
});

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

type ToolCallReport = Omit<Extract<ExtensionToWebviewMessage, { type: 'toolCall' }>, 'type'>;

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
        session: { sessionId: 's1', agentName: 'Fake', cwd: '/work', pickers: [], commands: [] },
      }),
    answer: (text: string) => send({ type: 'agentText', messageId: null, text }),
    thought: (text: string) => send({ type: 'thoughtText', messageId: null, text }),
    toolCall: (report: ToolCallReport) => send({ type: 'toolCall', ...report }),
    takePosted: () => posted.splice(0),
  };
}

/** Click the summary, as the user does, and wait for the `toggle` event the browser queues. */
async function toggle(details: HTMLDetailsElement): Promise<void> {
  const toggled = new Promise((resolve) => details.addEventListener('toggle', resolve, { once: true }));
  const summary = details.querySelector('summary');
  assert.exists(summary);
  fireEvent.click(summary);
  await act(() => toggled);
}

describe('the chat view', () => {
  it.each(['accept', 'decline', 'cancel'] as const)('shows a distinct collapsed %s record with inert question and response details', async (action) => {
    const view = renderChatView();
    view.connect();
    view.send({ type: 'questionSettled', record: {
      interactionId: 'q1', sessionId: 's1', agentName: 'Agent', title: 'Settings', message: 'Visit https://example.com?', description: 'Choose carefully',
      fields: [{ name: 'enabled', kind: 'boolean', title: 'Enabled', description: 'Enable it?', required: false, choices: null, minimum: null, maximum: null, minLength: null, maxLength: null, minItems: null, maxItems: null, pattern: null, format: null }],
      response: action === 'accept' ? { action, content: { enabled: false } } : { action },
    } });
    const record = view.part<HTMLDetailsElement>('details.question-record');
    expect(record.open).toBe(false);
    const outcome = action === 'accept' ? 'Submitted' : action === 'decline' ? 'Declined' : 'Cancelled';
    expect(record.querySelector('summary')?.textContent).toBe(`Elicitation — ${outcome}: Settings`);
    await toggle(record);
    expect(record.open).toBe(true);
    expect(record.textContent).toContain('Visit https://example.com?');
    expect(record.textContent).toContain('Choose carefully');
    expect(record.textContent).toContain('Enable it?');
    expect(record.textContent).toContain('Agent');
    expect(record.querySelector('a')).toBeNull();
    if (action === 'accept') {
      expect([...record.querySelectorAll('dt, dd')].map((element) => element.textContent)).toEqual(['Enabled', 'false']);
    } else {
      expect(record.querySelector('dl')).toBeNull();
      expect(record.textContent).toContain('No answers sent.');
    }
    expect(view.takePosted()).toEqual([]);
    await toggle(record);
    expect(record.open).toBe(false);
  });

  it('lays out the banner, the transcript, the input area and the load overlay in that order', () => {
    const { container } = renderChatView();

    expect([...container.children].map((child) => child.id)).toEqual(['sessionBanner', 'transcript', 'questionAnchor', 'loadOverlay']);
    expect([...container.querySelector('#questionAnchor')?.children ?? []].map((child) => child.id)).toEqual(['inputArea']);
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

    view.answer('streaming');
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

describe('the queue', () => {
  const queue = (view: ReturnType<typeof renderChatView>) => view.container.querySelector('#queuedPrompts');
  const queued = (view: ReturnType<typeof renderChatView>) =>
    view.all('#queuedPrompts > .queued-prompt').map((item) => [item.querySelector('.queued-label')?.textContent, item.querySelector('.queued-text')?.textContent, item.title]);
  const prompt = (view: ReturnType<typeof renderChatView>, value: string) =>
    view.send({ type: 'promptEdited', text: value }, { type: 'promptSent' });
  const userMessages = (view: ReturnType<typeof renderChatView>) =>
    view.all('#messages > .message.user').map((message) => message.querySelector('.message-content')?.textContent);

  it('is not shown while no prompt is queued', () => {
    const view = renderChatView();
    view.connect();
    prompt(view, 'first');

    expect(queue(view)).toBeNull();
  });

  it('pins the prompts sent during a turn between the transcript and the input area, next to go out at the top, each marked as queued', () => {
    const view = renderChatView();
    view.connect();
    prompt(view, 'first');

    prompt(view, 'second');
    prompt(view, 'third');

    expect([...view.container.children].map((child) => child.id)).toEqual(['sessionBanner', 'transcript', 'questionAnchor', 'loadOverlay']);
    expect([...view.part('#questionAnchor').children].map((child) => child.id)).toEqual(['queuedPrompts', 'inputArea']);
    expect(queue(view)?.getAttribute('aria-label')).toBe('Queued prompts');
    expect(queued(view)).toEqual([
      ['Queued', 'second', 'second'],
      ['Queued', 'third', 'third'],
    ]);
    expect(userMessages(view)).toEqual(['first']);
  });

  it('offers to send only the top prompt now, which cancels the running turn', () => {
    const view = renderChatView();
    view.connect();
    prompt(view, 'first');
    prompt(view, 'second');
    prompt(view, 'third');
    view.takePosted();

    const buttons = view.all('#queuedPrompts .send-now');
    expect(buttons.map((button) => button.closest('.queued-prompt')?.querySelector('.queued-text')?.textContent)).toEqual(['second']);
    expect(buttons[0]?.textContent).toBe('Send now');
    fireEvent.click(view.part('#queuedPrompts .send-now'));

    expect(view.takePosted()).toEqual([{ type: 'cancelTurn' }]);
  });

  it('moves a queued prompt into the transcript when it goes out, and is gone once the last one has', () => {
    const view = renderChatView();
    view.connect();
    prompt(view, 'first');
    prompt(view, 'second');
    prompt(view, 'third');

    view.send({ type: 'promptEnd' });
    expect(queued(view).map(([, value]) => value)).toEqual(['third']);
    expect(userMessages(view)).toEqual(['first', 'second']);

    view.send({ type: 'promptEnd' });
    expect(queue(view)).toBeNull();
    expect(userMessages(view)).toEqual(['first', 'second', 'third']);
  });

  it('expands a queued prompt without changing its text, the composer or the running turn', () => {
    const view = renderChatView();
    view.connect();
    prompt(view, 'first');
    prompt(view, 'line one\nline two\nline three\nline four');
    view.send({ type: 'promptEdited', text: 'composer draft' });
    view.takePosted();
    const expand = view.part<HTMLButtonElement>('[aria-label="Expand queued prompt"]');
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(expand);
    expect(expand.getAttribute('aria-expanded')).toBe('true');
    expect(view.part('.queued-text').className).not.toContain('line-clamp');
    expect(view.part('.queued-text').textContent).toBe('line one\nline two\nline three\nline four');
    fireEvent.click(expand);
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    expect(view.part<HTMLTextAreaElement>('#promptInput').value).toBe('composer draft');
    expect(view.store.getSnapshot().activeSession?.turnRunning).toBe(true);
    expect(view.takePosted()).toEqual([]);
  });

  it('holds the queue head during inline editing and sends the saved text when the agent is idle', () => {
    const view = renderChatView();
    view.connect();
    prompt(view, 'first');
    prompt(view, 'second');
    prompt(view, 'third');
    view.takePosted();
    fireEvent.click(view.part('[aria-label="Edit queued prompt"]'));
    const editor = view.part<HTMLTextAreaElement>('[aria-label="Queued prompt text"]');
    expect(document.activeElement).toBe(editor);
    fireEvent.change(editor, { target: { value: 'saved second' } });
    view.send({ type: 'promptEnd' });
    expect(view.takePosted()).toEqual([]);
    expect(userMessages(view)).toEqual(['first']);
    expect(editor.value).toBe('saved second');
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(view.takePosted()).toEqual([{ type: 'sendPrompt', text: 'saved second' }, { type: 'queuedPrompts', count: 1 }]);
    expect(userMessages(view)).toEqual(['first', 'saved second']);
    expect(queued(view).map(([, text]) => text)).toEqual(['third']);
  });

  it('uses Escape to discard only the inline edit, and ignores Enter during composition or with Shift', () => {
    const view = renderChatView();
    view.connect();
    prompt(view, 'first');
    prompt(view, 'second');
    fireEvent.click(view.part('[aria-label="Edit queued prompt"]'));
    const editor = view.part<HTMLTextAreaElement>('[aria-label="Queued prompt text"]');
    fireEvent.change(editor, { target: { value: 'unsaved' } });
    view.takePosted();
    fireEvent.keyDown(editor, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true });
    expect(editor.value).toBe('unsaved');
    expect(view.container.querySelector('[aria-label="Queued prompt text"]')).toBe(editor);
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(view.container.querySelector('[aria-label="Queued prompt text"]')).toBeNull();
    expect(document.activeElement).toBe(view.part('[aria-label="Edit queued prompt"]'));
    expect(queued(view).map(([, text]) => text)).toEqual(['second']);
    expect(view.takePosted()).toEqual([]);
  });

  it.each(['cancel', 'empty save'] as const)('%s preserves the composer and recalls the last saved text without a transcript entry', (method) => {
    const view = renderChatView();
    view.connect();
    prompt(view, 'first');
    prompt(view, 'second');
    prompt(view, 'third');
    view.send({ type: 'promptEdited', text: 'composer draft' });
    fireEvent.click(view.part('[aria-label="Edit queued prompt"]'));
    const editor = view.part<HTMLTextAreaElement>('[aria-label="Queued prompt text"]');
    fireEvent.change(editor, { target: { value: method === 'cancel' ? 'unsaved edit' : ' \n\t' } });
    view.takePosted();
    if (method === 'cancel') { fireEvent.click(view.part('[aria-label="Cancel queued prompt"]')); }
    else { fireEvent.keyDown(editor, { key: 'Enter' }); }
    expect(view.part<HTMLTextAreaElement>('#promptInput').value).toBe('composer draft');
    expect(queued(view).map(([, text]) => text)).toEqual(['third']);
    expect(userMessages(view)).toEqual(['first']);
    expect(view.takePosted()).toEqual([{ type: 'queuedPrompts', count: 1 }]);
    view.send({ type: 'promptEdited', text: '' });
    fireEvent.keyDown(view.part('#promptInput'), { key: 'ArrowUp' });
    expect(view.part<HTMLTextAreaElement>('#promptInput').value).toBe('second');
    expect(userMessages(view)).toEqual(['first']);
    expect(view.takePosted()).toEqual([]);
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

    view.send({ type: 'promptEnd' });
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

describe('the empty state', () => {
  it('points to the Agents view at the top of the transcript until a session connects, with no actions of its own', () => {
    const view = renderChatView();
    const line = view.part('#emptyState');
    expect(view.part('#messages').firstElementChild).toBe(line);
    expect(line.textContent).toBe('Add or pick an agent in the Agents view to start a session.');
    expect(line.querySelector('button, a')).toBeNull();
    expect(line.style.display).toBe('');

    view.connect();

    expect(line.style.display).toBe('none');
  });
});

describe('transcript entries', () => {
  it('copies a user message directly without offering Markdown options', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const view = renderChatView();
    view.connect();
    view.send({ type: 'promptEdited', text: 'user message' }, { type: 'promptSent' });

    const message = view.part('.message.user');
    expect(message.querySelector('[aria-label="Copy options"]')).toBeNull();
    expect(message.querySelector('[aria-label="Copy message"]')).not.toBeNull();
    expect(message.querySelector('[role="group"]')).toBeNull();

    const copyButton = message.querySelector<HTMLButtonElement>('[aria-label="Copy message"]');
    assert.exists(copyButton);
    await act(async () => fireEvent.click(copyButton));
    expect(writeText).toHaveBeenCalledWith('user message');
  });

  it('keeps agent copy options while using an unboxed icon button', () => {
    const view = renderChatView();
    view.connect();
    view.send({ type: 'promptStart' });
    view.answer('agent response');

    const message = view.part('.message.agent');
    const trigger = message.querySelector<HTMLButtonElement>('[aria-label="Copy options"]');
    assert.exists(trigger);
    expect(trigger.className).toContain('bg-transparent');
    expect(trigger.className).not.toContain('shadow-');
    fireEvent.click(trigger);
    expect(message.querySelector('[role="group"]')?.textContent).toContain('Copy Markdown');
  });

  it('draws prompts, turns and errors in order, with their classes, and a plan inside its turn', () => {
    const view = renderChatView();
    view.connect();
    view.send({ type: 'promptEdited', text: 'question' }, { type: 'promptSent' }, { type: 'promptStart' });
    view.answer('answer');
    view.send({
      type: 'plan',
      steps: [
        { text: 'done', status: 'completed' },
        { text: '<b>next</b>', status: 'pending' },
      ],
    });
    view.send({ type: 'error', message: 'boom' });

    const entries = [...view.part('#messages').children].filter((child) => child.id !== 'emptyState');
    expect(entries.map((entry) => {
      const text = entry.cloneNode(true) as HTMLElement;
      text.querySelectorAll('.message-copy, [role="group"], [role="status"]').forEach((control) => control.remove());
      return `${hookClasses(entry)}: ${text.textContent}`;
    })).toEqual([
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

    view.answer('\n ');

    expect(view.all('.turn')).toEqual([]);
  });
});

describe('a turn', () => {
  it('shows its parts in the order they arrived', () => {
    const view = renderChatView();
    view.connect();
    view.toolCall({ toolCallId: 't1', title: 'Read' });
    view.answer('answer');
    view.thought('hmm');

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
    view.answer('*x* and ');
    view.answer('**y**');

    const message = view.part('.message.agent');
    expect(hookClasses(message)).toBe('message agent');
    expect([message.querySelector('em')?.textContent, message.querySelector('[data-streamdown="strong"]')?.textContent]).toEqual(['x', 'y']);
  });
});

describe('a compaction', () => {
  type Report = Extract<Action, { type: 'compactionUpdate' }>;
  const report = (status = 'in_progress', fields: Partial<Pick<Report, 'summary' | 'error'>> = {}, compactionId = 'opaque/id'): Report => ({
    type: 'compactionUpdate', compactionId, status, summary: { present: false }, error: { present: false }, ...fields,
  });
  const chunk = (text: string): Action => ({ type: 'compactionSummaryChunk', compactionId: 'opaque/id', content: { type: 'text', text } });
  const summary = { present: true, value: [{ type: 'text', text: '**Summary**' }] } as const;
  const withSummary = (status = 'in_progress') => report(status, { summary: { present: true, value: [...summary.value] } });

  it('renders standalone and active-turn compactions at their first position, outside tool-call groups', () => {
    const view = renderChatView();
    view.connect();
    view.send(report('completed', {}, 'before'), { type: 'promptStart' });
    view.answer('Before');
    view.toolCall({ toolCallId: 't1' });
    view.send(withSummary());
    view.toolCall({ toolCallId: 't2' });
    view.answer('After');
    view.send(report('completed'));
    expect(view.all('#messages > .compaction-block')).toHaveLength(1);
    expect(view.all('.turn > *').map((element) => element.classList[0])).toEqual(['message', 'turn-tools', 'compaction-block', 'turn-tools', 'message']);
    expect(view.all('.turn-tools-summary').map((element) => element.textContent)).toEqual(['▾ 1 tool call', '▾ 1 tool call']);
    expect(view.all('.compaction-header').map((element) => element.textContent)).toEqual(['Compaction completed', 'Compaction completed']);
  });

  it('starts expanded with Markdown and a progress indicator, respecting manual collapse during chunks', async () => {
    const view = renderChatView();
    view.send(withSummary());
    const details = view.part<HTMLDetailsElement>('.compaction-block');
    expect(details.open).toBe(true);
    expect(view.part('.compaction-header').textContent).toBe('Compacting…');
    expect(view.all('.compaction-indicator')).toHaveLength(1);
    expect(view.part('.compaction-content [data-streamdown="strong"]').textContent).toBe('Summary');
    await toggle(details);
    view.send(chunk(' more'));
    expect(details.open).toBe(false);
    expect(view.takePosted()).toEqual([]);
  });

  it('collapses on completion once, allows reopening, and retains that choice on same-status patches', async () => {
    const view = renderChatView();
    view.send(withSummary(), report('completed'));
    const details = view.part<HTMLDetailsElement>('.compaction-block');
    expect(details.open).toBe(false);
    expect(view.all('.compaction-indicator')).toHaveLength(0);
    await toggle(details);
    view.send(report('completed'), chunk(' tail'));
    expect(details.open).toBe(true);
  });

  it.each(['failed', 'cancelled'])('opens on transition to %s, then respects manual collapse', async (status) => {
    const view = renderChatView();
    view.send(withSummary('completed'));
    const details = view.part<HTMLDetailsElement>('.compaction-block');
    view.send(report(status));
    expect(details.open).toBe(true);
    expect(view.part('.compaction-header').textContent).toBe(`Compaction ${status}`);
    expect(view.all('.compaction-indicator')).toHaveLength(0);
    await toggle(details);
    view.send(report(status), chunk(' partial'));
    expect(details.open).toBe(false);
  });

  it('shows an unknown status neutrally without a progress indicator or inferred outcome', () => {
    const view = renderChatView();
    view.send(withSummary('future_status'));
    expect(view.part('.compaction-header').textContent).toBe('Compaction — unknown status: future_status');
    expect(view.all('.compaction-indicator')).toHaveLength(0);
    expect(view.part('.compaction-header').className).not.toMatch(/text-(success|failure|progress)/);
  });

  it.each([{ value: undefined }, { value: null }, { value: [] }, { value: [{ type: 'text', text: '' }] }])('shows only the header for absent or empty summary $value', ({ value }) => {
    const view = renderChatView();
    view.send(report('completed', value === undefined ? {} : { summary: { present: true, value } }));
    expect(view.part('.compaction-header').textContent).toBe('Compaction completed');
    expect(view.all('.compaction-content, .compaction-block summary')).toHaveLength(0);
  });

  it('removes a cleared summary without removing independently expandable structured error details', async () => {
    const view = renderChatView();
    const error = '{"code":42,"data":{"retry":false,"values":[null,3]},"message":"Reported"}';
    view.send(withSummary(), report('failed', { summary: { present: true, value: null }, error: { present: true, value: error } }));
    expect(view.all('.compaction-content')).toHaveLength(0);
    const details = view.part<HTMLDetailsElement>('.compaction-error');
    expect(details.open).toBe(false);
    await toggle(details);
    expect(JSON.parse(view.part('.compaction-error pre').textContent)).toEqual({ code: 42, data: { retry: false, values: [null, 3] }, message: 'Reported' });
    view.send(report('failed', { error: { present: true, value: null } }));
    expect(view.all('.compaction-error, .compaction-block summary')).toHaveLength(0);
  });

  it('renders plain errors without requiring a particular error shape', () => {
    const view = renderChatView();
    view.send(report('failed', { error: { present: true, value: 'Plain failure' } }));
    expect(view.part('.compaction-error pre').textContent).toBe('Plain failure');
  });

  it('keeps reported error details accessible independently of a collapsed summary', () => {
    const view = renderChatView();
    view.send(withSummary('completed'), report('completed', { error: { present: true, value: '["reported",null,42]' } }));
    const error = view.part('.compaction-error');
    expect(error.parentElement?.closest('details')).toBeNull();
    expect(JSON.parse(view.part('.compaction-error pre').textContent)).toEqual(['reported', null, 42]);
  });

  it('preserves structured error text exactly, including numbers that cannot be represented as JavaScript numbers', () => {
    const view = renderChatView();
    const error = '{"identifier":9007199254740993,"data":{"arbitrary":true}}';
    view.send(report('failed', { error: { present: true, value: error } }));
    expect(view.part('.compaction-error pre').textContent).toBe(error);
  });

  it('joins adjacent streamed text into continuous Markdown and replaces it with the final summary', async () => {
    const view = renderChatView();
    view.send(chunk('**Con'));
    for (const text of ['tin', 'uous', '**\n\n', '- first\n', '- second']) { view.send(chunk(text)); }
    expect(view.all('.compaction-content [data-streamdown="strong"]').map((element) => element.textContent)).toEqual(['Continuous']);
    expect(view.all('.compaction-content li').map((element) => element.textContent)).toEqual(['first', 'second']);
    view.send(report('completed', { summary: { present: true, value: [{ type: 'text', text: '**Final**' }] } }));
    await toggle(view.part<HTMLDetailsElement>('.compaction-block'));
    expect(view.all('.compaction-content [data-streamdown="strong"]').map((element) => element.textContent)).toEqual(['Final']);
    expect(view.part('.compaction-content').textContent).not.toContain('Continuous');
  });

  it('preserves non-text order and uses type-specific placeholders for unsupported content', () => {
    const view = renderChatView();
    view.send(report('failed', { summary: { present: true, value: [
      { type: 'text', text: '**Before**' },
      { type: 'image', mimeType: 'image/png', data: 'AA==' },
      { type: 'text', text: '**After**' },
      { type: 'audio', mimeType: 'audio/wav', data: 'AA==' },
      { type: 'resource_link', uri: 'file:///summary', name: 'summary' },
      { type: 'resource', resource: { uri: 'file:///data', blob: 'AA==', mimeType: 'application/octet-stream' } },
    ] } }));
    expect(view.all('.compaction-content > *').map((element) => element.textContent)).toEqual([
      'Before', 'Unsupported image content', 'After', 'Unsupported audio content', 'Unsupported resource_link content', 'Unsupported resource content',
    ]);
  });

  it('measures live duration from the first in-progress report to the first terminal report, not subsequent patches', () => {
    const view = renderChatView();
    view.at(1000);
    view.send(withSummary());
    view.at(20_000);
    view.send(report(), chunk(' more'));
    view.at(55_432);
    view.send(report('completed'));
    expect(view.part('.compaction-header').textContent).toBe('Compaction completed in 54s');
    view.at(90_000);
    view.send(report('completed'), report('failed'));
    expect(view.part('.compaction-header').textContent).toBe('Compaction failed in 54s');
  });

  it.each(['failed', 'cancelled'])('times implicit first-chunk progress until %s', (status) => {
    const view = renderChatView();
    view.at(3000);
    view.send(chunk('Partial'));
    view.at(4600);
    view.send(report(status));
    expect(view.part('.compaction-header').textContent).toBe(`Compaction ${status} in 2s`);
  });

  it('omits zero-second and completed-snapshot durations', () => {
    const view = renderChatView();
    view.at(1000);
    view.send(report());
    view.at(1400);
    view.send(report('completed'), report('completed', {}, 'snapshot'));
    expect(view.all('.compaction-header').map((element) => element.textContent)).toEqual(['Compaction completed', 'Compaction completed']);
  });

  it('excludes replay progress and completion from duration, including a terminal report after load ends', () => {
    const view = renderChatView();
    view.connect();
    view.send({ type: 'loadSessionStart' }, withSummary(), report('in_progress', {}, 'pending'));
    view.at(54_000);
    view.send(report('completed'), { type: 'loadSessionEnd', ok: true });
    expect(view.part<HTMLDetailsElement>('.compaction-block').open).toBe(false);
    view.at(90_000);
    view.send(report('completed', {}, 'pending'));
    expect(view.all('.compaction-header').map((element) => element.textContent)).toEqual(['Compaction completed', 'Compaction completed']);
  });

  it('does not use unknown statuses or turn/session end as timing endpoints', () => {
    const view = renderChatView();
    view.connect();
    view.send(report('future'));
    view.at(10_000);
    view.send(report('completed'));
    expect(view.part('.compaction-header').textContent).toBe('Compaction completed');
    view.send({ type: 'clearTranscript' });
    view.connect();
    view.at(20_000);
    view.send({ type: 'promptStart' }, withSummary());
    view.at(25_000);
    view.send(report('future'), { type: 'promptEnd' }, { type: 'sessionEnded', message: 'Exited' });
    expect(view.part('.compaction-header').textContent).toBe('Compaction — unknown status: future');
    view.at(30_000);
    view.send(report('cancelled'));
    expect(view.part('.compaction-header').textContent).toBe('Compaction cancelled in 10s');
  });
});

describe('a thought', () => {
  it('is open with an indicator while the agent thinks, and closes with its duration when the answer starts', () => {
    const view = renderChatView();
    view.connect();
    view.at(1_000);
    view.thought('let me think');
    const thought = view.part<HTMLDetailsElement>('.thought-block');
    expect(hookClasses(thought)).toBe('thought-block streaming');
    expect(thought.open).toBe(true);
    expect(thought.querySelector('summary .thought-indicator')).not.toBeNull();
    expect(thought.querySelector('summary')?.textContent).toBe(' Thinking…');
    expect(thought.querySelector('.thought-content')?.textContent).toBe('let me think');

    view.at(3_000);
    view.answer('answer');

    expect(hookClasses(thought)).toBe('thought-block');
    expect(thought.open).toBe(false);
    expect(thought.querySelector('summary')?.textContent).toBe('Thought for 2s');
  });

  it('tells the store when the user opens or closes it', async () => {
    const view = renderChatView();
    view.connect();
    view.thought('hmm');
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
    view.toolCall({ toolCallId: 't1', title: 'Run', status: 'running', content: [{ kind: 'text', text: 'one' }, { kind: 'text', text: 'two' }] });
    view.toolCall({ toolCallId: 't2' });

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

  it('draws no diffs while a tool call is closed, and once the user opens it draws each where it was reported among the texts', async () => {
    const view = renderChatView();
    view.connect();
    const edit: ToolCallContent = { kind: 'diff', files: [diffFile({
      operation: 'modify',
      path: 'src/a.ts',
      added: 1,
      removed: 1,
      hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b', '+B', ' c'] }],
      opens: 'fileAndChanges',
    })] };
    view.toolCall({ toolCallId: 't1', title: 'Edit', status: 'completed', content: [{ kind: 'text', text: 'before' }, edit, { kind: 'text', text: 'after' }] });
    view.toolCall({ toolCallId: 't2', title: 'Edit', status: 'completed', content: [edit] });
    const [call, onlyDiffs] = view.all('.tool-call-inline');
    assert.exists(call);
    assert.exists(onlyDiffs);
    expect(call.querySelector('.tc-diff')).toBeNull();

    await toggle(call as HTMLDetailsElement);
    await toggle(onlyDiffs as HTMLDetailsElement);

    expect([...call.querySelectorAll('.tc-body-inner > *')].map((block) => block.className.split(' ')[0])).toEqual(['tc-body-block', 'tc-diff', 'tc-body-block']);
    expect(onlyDiffs.querySelector<HTMLElement>('.tc-body')?.style.display).toBe('');
    const header = call.querySelector('.tc-diff-header');
    expect([...(header?.children ?? [])].map((part) => part.textContent)).toEqual(['Modified', 'src/a.ts', '+1', '−1']);
    const lineType = (cell: Element) => /diff-(?:gutter|code)-(\w+)/.exec(cell.className)?.[1] ?? '';
    expect(
      [...call.querySelectorAll('.tc-diff tr.diff-line')].map((row) => [...row.querySelectorAll('td')].map((cell) => `${lineType(cell)}:${cell.textContent}`)),
    ).toEqual([
      ['normal:1', 'normal:1', 'normal:a'],
      ['delete:2', 'delete:', 'delete:b'],
      ['insert:', 'insert:2', 'insert:B'],
      ['normal:3', 'normal:3', 'normal:c'],
    ]);
  });

  it("heads each file with its operation and paths, and notes why a file shows no lines", async () => {
    const view = renderChatView();
    view.connect();
    view.toolCall({ toolCallId: 't1', title: 'Apply patch', status: 'failed', content: [
      { kind: 'diff', files: [
        diffFile({ operation: 'move', path: 'src/math.ts', oldPath: 'src/util.ts', note: 'noPatch' }),
        diffFile({ operation: 'delete', path: '/elsewhere/logo.png', note: 'noPatch' }),
      ] },
      { kind: 'diff', files: [diffFile({ operation: 'modify', path: 'src/left-out.ts', note: 'noLines' })] },
    ] });

    expect(view.all('.tc-diff-file').map((file) => [file.querySelector('.tc-diff-header')?.textContent, file.querySelector('.tc-diff-note')?.textContent])).toEqual([
      ['Movedsrc/util.ts → src/math.ts', 'No patch reported'],
      ['Deleted/elsewhere/logo.png', 'No patch reported'],
      ['Modifiedsrc/left-out.ts', "No lines in the agent's patch"],
    ]);
    expect(view.container.querySelector('.tc-diff table')).toBeNull();
  });

  it("makes each file's path a link that opens it, with the context VS Code's menu reads; a move's source and a directory are not links", () => {
    const view = renderChatView();
    view.connect();
    view.toolCall({ toolCallId: 't1', title: 'Edit', status: 'failed', content: [
      { kind: 'diff', files: [diffFile({
        operation: 'modify',
        path: 'a.ts',
        added: 1,
        removed: 1,
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
        opens: 'fileAndChanges',
      })] },
      { kind: 'diff', files: [
        diffFile({ operation: 'move', path: 'src/math.ts', oldPath: 'src/util.ts', note: 'noPatch' }),
        diffFile({ operation: 'add', path: 'dist', note: 'noPatch', opens: null }),
      ] },
    ] });
    view.takePosted();

    const links = view.all('.tc-diff-link');
    expect(links.map((link): unknown[] => [link.textContent, JSON.parse(link.dataset['vscodeContext'] ?? 'null') as unknown])).toEqual([
      ['a.ts', { webviewSection: 'toolCallDiffFile', acpToolCallId: 't1', acpDiffFile: 0, acpDiffFileHasLines: true, preventDefaultContextMenuItems: true }],
      ['src/math.ts', { webviewSection: 'toolCallDiffFile', acpToolCallId: 't1', acpDiffFile: 1, acpDiffFileHasLines: false, preventDefaultContextMenuItems: true }],
    ]);
    expect(view.all('.tc-diff-path').map((path) => path.textContent)).toEqual(['a.ts', 'src/util.ts → src/math.ts', 'dist']);

    fireEvent.click(view.part('.tc-diff-file:nth-child(1) .tc-diff-link'));
    expect(view.takePosted()).toEqual([{ type: 'openFile', toolCallId: 't1', file: 0 }]);
  });

  it("gives a command's output and its tool call's title the context Open in Terminal reads: its session, the title, and its terminal or the tool call itself", () => {
    const view = renderChatView();
    view.connect();
    view.send({ type: 'terminal', terminalId: 'term', text: 'ok', truncated: false, exitStatus: null });
    view.toolCall({ toolCallId: 'c1', title: 'npm test', content: [{ kind: 'terminal', terminalId: 'term' }] });
    view.toolCall({ toolCallId: 'c2', title: '', content: [{ kind: 'commandOutput', text: 'a.ts', truncated: false }] });
    view.toolCall({ toolCallId: 'c3', title: 'Read a.ts', content: [{ kind: 'text', text: 'a' }] });
    const contexts = (selector: string) => view.all(selector).map((element) => JSON.parse(element.dataset['vscodeContext'] ?? 'null') as unknown);

    const expected = [
      { webviewSection: 'commandOutput', acpSessionId: 's1', acpTitle: 'npm test', acpTerminalId: 'term' },
      { webviewSection: 'commandOutput', acpSessionId: 's1', acpTitle: 'Tool Call', acpToolCallId: 'c2' },
    ];
    expect(contexts('.tc-command')).toEqual(expected);
    expect(contexts('.tc-summary')).toEqual([...expected, null]);
  });

  it("spins in a tool call's summary while a command of its terminals runs, and stops once it ends", () => {
    const view = renderChatView();
    view.connect();
    view.toolCall({ toolCallId: 't1', title: 'npm test', status: 'completed', content: [{ kind: 'terminal', terminalId: 'term' }] });
    expect(view.container.querySelector('.tc-body .tc-command')).toBeNull();

    view.send({ type: 'terminal', terminalId: 'term', text: 'running tests', truncated: false, exitStatus: null });
    expect(view.part('#tc-t1 summary .tc-running').title).toBe('Command running');
    expect(view.part('.tc-command-text').textContent).toBe('running tests');

    view.send({ type: 'terminal', terminalId: 'term', text: 'all passed', truncated: false, exitStatus: { exitCode: 0, signal: null } });
    expect(view.container.querySelector('.tc-running')).toBeNull();
    expect(view.part('.tc-command').textContent).toBe('all passed');
  });

  it("notes a command's earlier output not shown above its text, and how it failed below", () => {
    const view = renderChatView();
    view.connect();
    view.send({ type: 'terminal', terminalId: 'term', text: 'Error: 3 tests failed', truncated: true, exitStatus: { exitCode: 1, signal: null } });
    view.toolCall({ toolCallId: 't1', title: 'npm test', content: [{ kind: 'terminal', terminalId: 'term' }] });

    expect([...view.part('.tc-command').children].map((part) => [part.className.split(' ')[0], part.textContent])).toEqual([
      ['tc-command-cut', 'Earlier output not shown'],
      ['tc-command-text', 'Error: 3 tests failed'],
      ['tc-command-failure', 'Exit code 1'],
    ]);
    expect(view.container.querySelector('.tc-body-truncated')).toBeNull();
  });

  it("shows a command's text sent as text the same way, with no spinner", () => {
    const view = renderChatView();
    view.connect();
    view.toolCall({ toolCallId: 't1', title: 'ls', status: 'running', content: [{ kind: 'commandOutput', text: 'a.ts\nb.ts', truncated: true }] });

    expect(view.part('.tc-command-cut').textContent).toBe('Earlier output not shown');
    expect(view.part('.tc-command-text').textContent).toBe('a.ts\nb.ts');
    expect(view.container.querySelector('.tc-running')).toBeNull();
  });

  it('says the agent disconnected before a command still running finished, once its session ends', () => {
    const view = renderChatView();
    view.connect();
    view.send({ type: 'terminal', terminalId: 'term', text: 'watching', truncated: false, exitStatus: null });
    view.toolCall({ toolCallId: 't1', title: 'npm run watch', content: [{ kind: 'terminal', terminalId: 'term' }] });

    view.send({ type: 'sessionEnded', message: 'Fake exited unexpectedly (code 1).' });

    expect(view.container.querySelector('.tc-running')).toBeNull();
    expect(view.part('.tc-command-disconnected').textContent).toBe('The agent disconnected before the command finished.');
  });

  it('notes content cut off at the limit', () => {
    const view = renderChatView();
    view.connect();

    view.toolCall({ toolCallId: 't1', title: 'Run', content: [{ kind: 'text', text: 'x'.repeat(25_000) }] });

    expect(view.part('.tc-body-block').textContent).toHaveLength(20_000);
    expect(view.part('.tc-body-truncated').textContent).toBe('... (output truncated)');
  });

  it('opens a failed tool call, and tells the store when the user closes it', async () => {
    const view = renderChatView();
    view.connect();
    view.toolCall({ toolCallId: 't1', title: 'Run', status: 'failed' });
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
    view.toolCall({ toolCallId: 't1', title: 'Read' });
    const summary = view.part('.turn-tools-summary');
    const list = view.part('.turn-tools-list');
    expect(summary.textContent).toBe('▾ 1 tool call');

    for (const id of ['t2', 't3', 't4']) {
      view.toolCall({ toolCallId: id, title: 'Read' });
    }
    view.send({ type: 'promptEnd' });
    expect(summary.textContent).toBe('▸ 4 tool calls');
    expect(hookClasses(list)).toBe('turn-tools-list collapsed');

    fireEvent.click(summary);
    expect(summary.textContent).toBe('▾ 4 tool calls');
    expect(hookClasses(list)).toBe('turn-tools-list');
  });
});
