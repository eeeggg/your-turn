import { beforeEach, describe, expect, it } from 'vitest';
import { answer, connect, loadChatPage, plan, shownText, thought, type ChatPage } from './chatPage';

let page: ChatPage;

beforeEach(() => {
  page = loadChatPage();
  connect(page);
  page.takePosted();
});

function agentMessages(): string[] {
  return [...page.document.querySelectorAll('.message.agent')].map(shownText);
}

describe('streaming a turn', () => {
  it('shows the spinner while a prompt runs', () => {
    page.send({ type: 'promptStart' });

    expect(page.byId('status').querySelector('.spinner')).not.toBeNull();

    page.send({ type: 'promptEnd' });
    expect(page.byId('status').textContent).toBe('');
  });

  it('accumulates the text of a turn into one agent message', () => {
    page.send({ type: 'promptStart' });
    answer(page, 'hello ');
    answer(page, 'world');

    expect(agentMessages()).toEqual(['hello world']);
    expect(page.document.querySelector('.turn > .message.agent')).not.toBeNull();
  });

  it('waits for non-whitespace text before showing the agent message', () => {
    page.send({ type: 'promptStart' });
    answer(page, '\n  ');
    expect(agentMessages()).toEqual([]);

    answer(page, 'hi');
    expect(agentMessages()).toEqual(['hi']);
  });

  it('starts a separate agent message for each turn', () => {
    for (const text of ['first', 'second']) {
      page.send({ type: 'promptStart' });
      answer(page, text);
      page.send({ type: 'promptEnd' });
    }

    expect(agentMessages()).toEqual(['first', 'second']);
    expect(page.document.querySelectorAll('.turn')).toHaveLength(2);
  });
});

describe('thinking', () => {
  it('streams thought text into an open block at the top of the turn', () => {
    page.send({ type: 'promptStart' });
    thought(page, 'let me ');
    thought(page, 'think');

    const block = page.document.querySelector<HTMLDetailsElement>('.turn > .thought-block');
    expect(block?.classList.contains('streaming')).toBe(true);
    expect(block?.open).toBe(true);
    expect(block?.querySelector('summary')?.textContent).toContain('Thinking…');
    expect(block?.querySelector('.thought-content')?.textContent).toBe('let me think');
  });

  it('collapses the thought and shows its duration once the answer starts', () => {
    page.window.Date.now = () => 10_000;
    page.send({ type: 'promptStart' });
    thought(page, 'hmm');

    page.window.Date.now = () => 13_000;
    answer(page, 'answer');

    const block = page.document.querySelector<HTMLDetailsElement>('.thought-block');
    expect(block?.open).toBe(false);
    expect(block?.classList.contains('streaming')).toBe(false);
    expect(block?.querySelector('summary')?.textContent).toBe('Thought for 3s');
    expect(page.document.querySelector('.turn')?.firstElementChild).toBe(block);
  });

  it('lets the user reopen the thought while the answer streams', async () => {
    page.send({ type: 'promptStart' });
    thought(page, 'hmm');
    answer(page, 'answer');
    const block = page.document.querySelector<HTMLDetailsElement>('.thought-block');

    await toggle(block);
    answer(page, ' continues');

    expect(block?.open).toBe(true);
  });

  it('finishes the thought when the answer starts, even if the user closed it', async () => {
    page.window.Date.now = () => 10_000;
    page.send({ type: 'promptStart' });
    thought(page, 'hmm');
    const block = page.document.querySelector<HTMLDetailsElement>('.thought-block');
    await toggle(block);

    page.window.Date.now = () => 13_000;
    answer(page, 'answer');

    expect(block?.open).toBe(false);
    expect(block?.classList.contains('streaming')).toBe(false);
    expect(block?.querySelector('summary')?.textContent).toBe('Thought for 3s');
  });

  it('finalizes a thought without an answer at promptEnd', () => {
    page.send({ type: 'promptStart' });
    thought(page, 'hmm');
    page.send({ type: 'promptEnd' });

    const block = page.document.querySelector('.thought-block');
    expect(block?.classList.contains('streaming')).toBe(false);
    expect(block?.querySelector('summary')?.textContent).toBe('Thought');
    expect(page.takePosted()).toEqual([]);
  });
});

describe('plans', () => {
  it('renders plan steps with status icons and escapes their text', () => {
    plan(
      page,
      { text: 'done step', status: 'completed' },
      { text: 'current step', status: 'running' },
      { text: '<b>next</b>', status: 'pending' },
    );

    const entries = [...page.document.querySelectorAll('.plan .plan-entry')];
    expect(entries.map((el) => el.textContent)).toEqual(['✅ done step', '🔄 current step', '⬜ <b>next</b>']);
    expect(entries.map((el) => el.classList.contains('completed'))).toEqual([true, false, false]);
    expect(page.document.querySelector('.plan b')).toBeNull();
  });

  it('replaces the plan when the agent updates it during a turn', () => {
    page.send({ type: 'promptStart' });
    plan(page, { text: 'a', status: 'pending' });
    plan(page, { text: 'a', status: 'completed' }, { text: 'b', status: 'pending' });

    expect(plans()).toEqual([['✅ a', '⬜ b']]);
  });

  it('starts a new plan in the next turn', () => {
    for (const step of ['first', 'second']) {
      page.send({ type: 'promptStart' });
      plan(page, { text: step, status: 'pending' });
      page.send({ type: 'promptEnd' });
    }

    expect(plans()).toEqual([['⬜ first'], ['⬜ second']]);
  });
});

function plans(): string[][] {
  return [...page.document.querySelectorAll('.plan')].map((block) =>
    [...block.querySelectorAll('.plan-entry')].map((entry) => entry.textContent),
  );
}

/** Click the summary, as the user does, and wait for the `toggle` event the browser queues. */
async function toggle(details: HTMLDetailsElement | null): Promise<void> {
  if (!details) {
    throw new Error('no details element to toggle');
  }
  const toggled = new Promise((resolve) => details.addEventListener('toggle', resolve, { once: true }));
  details.querySelector('summary')?.click();
  await toggled;
}
