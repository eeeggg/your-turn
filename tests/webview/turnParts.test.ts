import { assert, beforeEach, describe, expect, it } from 'vitest';
import { hookClasses } from '@tests/hookClasses';
import {
  answer,
  connect,
  loadChatPage,
  plan,
  shownText,
  thought,
  toolCall,
  type ChatPage
} from '@tests/webview/chatPage';

let page: ChatPage;

beforeEach(() => {
  page = loadChatPage();
  connect(page);
  page.send({ type: 'promptStart' });
});

/** Each part of the only turn as `hook classes: text`. */
function parts(): string[] {
  const turn = page.document.querySelector('.turn');
  return [...(turn?.children ?? [])].map((el) => `${hookClasses(el)}: ${shownText(el)}`);
}

describe('the parts of a turn', () => {
  it('keeps the text before and after a tool call in the order it arrived', () => {
    answer(page, 'Let me check.');
    toolCall(page, { toolCallId: 't1', title: 'Read', status: 'completed' });
    answer(page, 'Done.');

    expect(parts()).toEqual(['message agent: Let me check.', 'turn-tools: ▾ 1 tool call✓Read', 'message agent: Done.']);
  });

  it('starts a new agent message when the message ID changes', () => {
    answer(page, 'one', 'm1');
    answer(page, ' more', 'm1');
    answer(page, 'two', 'm2');

    expect(parts()).toEqual(['message agent: one more', 'message agent: two']);
  });

  it('shows thinking after the answer as a thought of its own, below it', () => {
    thought(page, 'first');
    answer(page, 'answer');
    thought(page, 'second');

    expect(parts()).toEqual(['thought-block: Thoughtfirst', 'message agent: answer', 'thought-block streaming:  Thinking…second']);
  });

  it('finishes a thought when a tool call follows it', () => {
    thought(page, 'hmm');
    toolCall(page, { toolCallId: 't1', title: 'Read', status: 'completed' });

    const block = page.document.querySelector<HTMLDetailsElement>('.thought-block');
    expect(hookClasses(block)).toBe('thought-block');
    expect(block?.open).toBe(false);
  });

  it('keeps the plan where it was first reported, updating it there', () => {
    answer(page, 'before');
    plan(page, { text: 'a', status: 'pending' });
    answer(page, 'after');
    plan(page, { text: 'a', status: 'completed' });

    expect(parts()).toEqual(['message agent: before', 'plan: Plan✅ a', 'message agent: after']);
  });

  it('collapses each group of more than three tool calls on its own when the turn ends', () => {
    for (const id of ['t1', 't2', 't3', 't4']) {
      toolCall(page, { toolCallId: id, title: id, status: 'completed' });
    }
    answer(page, 'halfway');
    for (const id of ['t5', 't6']) {
      toolCall(page, { toolCallId: id, title: id, status: 'completed' });
    }
    page.send({ type: 'promptEnd' });

    const summaries = () => [...page.document.querySelectorAll<HTMLElement>('.turn-tools-summary')];
    expect(summaries().map((summary) => summary.textContent)).toEqual(['▸ 4 tool calls', '▾ 2 tool calls']);

    const second = summaries()[1];
    assert.exists(second);
    second.click();
    expect(summaries().map((summary) => summary.textContent)).toEqual(['▸ 4 tool calls', '▸ 2 tool calls']);
  });

  it("enables a message's code block controls once something follows it, while the turn goes on", () => {
    answer(page, '```ts\nconst a = 1;\n```\n');
    const copy = () => page.document.querySelector<HTMLButtonElement>('[data-streamdown="code-block-copy-button"]');
    expect(copy()?.disabled).toBe(true);

    toolCall(page, { toolCallId: 't1', title: 'Read' });

    expect(copy()?.disabled).toBe(false);
  });

  it('lets the user open each thought on its own', async () => {
    thought(page, 'one', 'r1');
    thought(page, 'two', 'r2');
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
