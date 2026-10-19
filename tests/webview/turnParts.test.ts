import { afterEach, assert, beforeEach, describe, expect, it } from 'vitest';
import { hookClasses } from '@tests/hookClasses';
import { connect, loadChatPage, textChunk, update, type ChatPage } from './chatPage';

let page: ChatPage;

beforeEach(() => {
  page = loadChatPage();
  connect(page);
  page.send({ type: 'promptStart' });
});

afterEach(() => {
  expect(page.errors).toEqual([]);
  page.close();
});

/** Each part of the only turn as `hook classes: text`. */
function parts(): string[] {
  const turn = page.document.querySelector('.turn');
  return [...(turn?.children ?? [])].map((el) => `${hookClasses(el)}: ${el.textContent}`);
}

const plan = (...steps: [content: string, status: 'pending' | 'completed'][]) => ({
  entries: steps.map(([content, status]) => ({ content, status, priority: 'medium' as const })),
});

describe('the parts of a turn', () => {
  it('keeps the text before and after a tool call in the order it arrived', () => {
    update(page, 'agent_message_chunk', textChunk('Let me check.'));
    update(page, 'tool_call', { toolCallId: 't1', title: 'Read', status: 'completed' });
    update(page, 'agent_message_chunk', textChunk('Done.'));

    expect(parts()).toEqual(['message agent: Let me check.', 'turn-tools: ▾ 1 tool call✓Read', 'message agent: Done.']);
  });

  it('starts a new agent message when the message ID changes', () => {
    update(page, 'agent_message_chunk', { ...textChunk('one'), messageId: 'm1' });
    update(page, 'agent_message_chunk', { ...textChunk(' more'), messageId: 'm1' });
    update(page, 'agent_message_chunk', { ...textChunk('two'), messageId: 'm2' });

    expect(parts()).toEqual(['message agent: one more', 'message agent: two']);
  });

  it('shows thinking after the answer as a thought of its own, below it', () => {
    update(page, 'agent_thought_chunk', textChunk('first'));
    update(page, 'agent_message_chunk', textChunk('answer'));
    update(page, 'agent_thought_chunk', textChunk('second'));

    expect(parts()).toEqual(['thought-block: Thoughtfirst', 'message agent: answer', 'thought-block streaming:  Thinking…second']);
  });

  it('finishes a thought when a tool call follows it', () => {
    update(page, 'agent_thought_chunk', textChunk('hmm'));
    update(page, 'tool_call', { toolCallId: 't1', title: 'Read', status: 'completed' });

    const thought = page.document.querySelector<HTMLDetailsElement>('.thought-block');
    expect(hookClasses(thought)).toBe('thought-block');
    expect(thought?.open).toBe(false);
  });

  it('keeps the plan where it was first reported, updating it there', () => {
    update(page, 'agent_message_chunk', textChunk('before'));
    update(page, 'plan', plan(['a', 'pending']));
    update(page, 'agent_message_chunk', textChunk('after'));
    update(page, 'plan', plan(['a', 'completed']));

    expect(parts()).toEqual(['message agent: before', 'plan: Plan✅ a', 'message agent: after']);
  });

  it('collapses each group of more than three tool calls on its own when the turn ends', () => {
    for (const id of ['t1', 't2', 't3', 't4']) {
      update(page, 'tool_call', { toolCallId: id, title: id, status: 'completed' });
    }
    update(page, 'agent_message_chunk', textChunk('halfway'));
    for (const id of ['t5', 't6']) {
      update(page, 'tool_call', { toolCallId: id, title: id, status: 'completed' });
    }
    page.send({ type: 'promptEnd', stopReason: 'end_turn' });

    const summaries = () => [...page.document.querySelectorAll<HTMLElement>('.turn-tools-summary')];
    expect(summaries().map((summary) => summary.textContent)).toEqual(['▸ 4 tool calls', '▾ 2 tool calls']);

    const second = summaries()[1];
    assert.exists(second);
    second.click();
    expect(summaries().map((summary) => summary.textContent)).toEqual(['▸ 4 tool calls', '▸ 2 tool calls']);
  });

  it("enables a message's code block controls once something follows it, while the turn goes on", () => {
    update(page, 'agent_message_chunk', textChunk('```ts\nconst a = 1;\n```\n'));
    const copy = () => page.document.querySelector<HTMLButtonElement>('[data-streamdown="code-block-copy-button"]');
    expect(copy()?.disabled).toBe(true);

    update(page, 'tool_call', { toolCallId: 't1', title: 'Read' });

    expect(copy()?.disabled).toBe(false);
  });

  it('lets the user open each thought on its own', async () => {
    update(page, 'agent_thought_chunk', { ...textChunk('one'), messageId: 'r1' });
    update(page, 'agent_thought_chunk', { ...textChunk('two'), messageId: 'r2' });
    const [first, second] = [...page.document.querySelectorAll<HTMLDetailsElement>('.thought-block')];
    assert.exists(first);
    assert.exists(second);
    expect([first.open, second.open]).toEqual([false, true]);

    const summary = first.querySelector('summary');
    assert.exists(summary);
    const toggled = new Promise((resolve) => first.addEventListener('toggle', resolve, { once: true }));
    summary.click();
    await toggled;

    expect([first.open, second.open]).toEqual([true, true]);
  });
});
