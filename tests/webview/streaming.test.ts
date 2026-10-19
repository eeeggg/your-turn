import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hookClasses } from '@tests/hookClasses';
import { connect, loadChatPage, textChunk, update, type ChatPage } from './chatPage';

let page: ChatPage;

beforeEach(() => {
  page = loadChatPage();
  connect(page);
  page.takePosted();
});

afterEach(() => {
  expect(page.errors).toEqual([]);
  page.close();
});

function agentMessages(): string[] {
  return [...page.document.querySelectorAll('.message.agent')].map((el) => el.textContent ?? '');
}

describe('streaming a turn', () => {
  it('switches the send button to stop while a prompt runs', () => {
    page.send({ type: 'promptStart' });
    const button = page.byId<HTMLButtonElement>('sendStopBtn');

    expect(hookClasses(button)).toBe('send-stop-btn stop');
    expect(button.textContent).toBe('■ Stop');
    expect(page.byId('status').querySelector('.spinner')).not.toBeNull();

    page.send({ type: 'promptEnd', stopReason: 'end_turn' });
    expect(hookClasses(button)).toBe('send-stop-btn send');
    expect(button.textContent).toBe('Send');
    expect(page.byId('status').textContent).toBe('');
  });

  it('accumulates message chunks into one agent message inside a turn', () => {
    page.send({ type: 'promptStart' });
    update(page, 'agent_message_chunk', textChunk('hello '));
    update(page, 'agent_message_chunk', textChunk('world'));

    expect(agentMessages()).toEqual(['hello world']);
    expect(page.document.querySelector('.turn > .message.agent')).not.toBeNull();
  });

  it('waits for non-whitespace text before showing the agent message', () => {
    page.send({ type: 'promptStart' });
    update(page, 'agent_message_chunk', textChunk('\n  '));
    expect(agentMessages()).toEqual([]);

    update(page, 'agent_message_chunk', textChunk('hi'));
    expect(agentMessages()).toEqual(['hi']);
  });

  it('starts a separate agent message for each turn', () => {
    for (const text of ['first', 'second']) {
      page.send({ type: 'promptStart' });
      update(page, 'agent_message_chunk', textChunk(text));
      page.send({ type: 'promptEnd', stopReason: 'end_turn' });
    }

    expect(agentMessages()).toEqual(['first', 'second']);
    expect(page.document.querySelectorAll('.turn')).toHaveLength(2);
  });
});

describe('thinking', () => {
  it('streams thought chunks into an open block at the top of the turn', () => {
    page.send({ type: 'promptStart' });
    update(page, 'agent_thought_chunk', textChunk('let me '));
    update(page, 'agent_thought_chunk', textChunk('think'));

    const thought = page.document.querySelector<HTMLDetailsElement>('.turn > .thought-block');
    expect(thought?.classList.contains('streaming')).toBe(true);
    expect(thought?.open).toBe(true);
    expect(thought?.querySelector('summary')?.textContent).toContain('Thinking…');
    expect(thought?.querySelector('.thought-content')?.textContent).toBe('let me think');
  });

  it('collapses the thought and shows its duration once the answer starts', () => {
    page.window.Date.now = () => 10_000;
    page.send({ type: 'promptStart' });
    update(page, 'agent_thought_chunk', textChunk('hmm'));

    page.window.Date.now = () => 13_000;
    update(page, 'agent_message_chunk', textChunk('answer'));

    const thought = page.document.querySelector<HTMLDetailsElement>('.thought-block');
    expect(thought?.open).toBe(false);
    expect(thought?.classList.contains('streaming')).toBe(false);
    expect(thought?.querySelector('summary')?.textContent).toBe('Thought for 3s');
    expect(page.document.querySelector('.turn')?.firstElementChild).toBe(thought);
  });

  it('lets the user reopen the thought while the answer streams', async () => {
    page.send({ type: 'promptStart' });
    update(page, 'agent_thought_chunk', textChunk('hmm'));
    update(page, 'agent_message_chunk', textChunk('answer'));
    const thought = page.document.querySelector<HTMLDetailsElement>('.thought-block');

    await toggle(thought);
    update(page, 'agent_message_chunk', textChunk(' continues'));

    expect(thought?.open).toBe(true);
  });

  it('finishes the thought when the answer starts, even if the user closed it', async () => {
    page.window.Date.now = () => 10_000;
    page.send({ type: 'promptStart' });
    update(page, 'agent_thought_chunk', textChunk('hmm'));
    const thought = page.document.querySelector<HTMLDetailsElement>('.thought-block');
    await toggle(thought);

    page.window.Date.now = () => 13_000;
    update(page, 'agent_message_chunk', textChunk('answer'));

    expect(thought?.open).toBe(false);
    expect(thought?.classList.contains('streaming')).toBe(false);
    expect(thought?.querySelector('summary')?.textContent).toBe('Thought for 3s');
  });

  it('finalizes a thought without an answer at promptEnd', () => {
    page.send({ type: 'promptStart' });
    update(page, 'agent_thought_chunk', textChunk('hmm'));
    page.send({ type: 'promptEnd', stopReason: 'end_turn' });

    const thought = page.document.querySelector('.thought-block');
    expect(thought?.classList.contains('streaming')).toBe(false);
    expect(thought?.querySelector('summary')?.textContent).toBe('Thought');
    expect(page.takePosted()).toEqual([]);
  });
});

describe('plans', () => {
  it('renders plan entries with status icons and escapes their text', () => {
    update(page, 'plan', {
      entries: [
        { content: 'done step', status: 'completed', priority: 'high' },
        { content: 'current step', status: 'in_progress', priority: 'medium' },
        { content: '<b>next</b>', status: 'pending', priority: 'low' },
      ],
    });

    const entries = [...page.document.querySelectorAll('.plan .plan-entry')];
    expect(entries.map((el) => el.textContent)).toEqual(['✅ done step', '🔄 current step', '⬜ <b>next</b>']);
    expect(entries.map((el) => el.classList.contains('completed'))).toEqual([true, false, false]);
    expect(page.document.querySelector('.plan b')).toBeNull();
  });

  it('replaces the plan when the agent updates it during a turn', () => {
    page.send({ type: 'promptStart' });
    update(page, 'plan', { entries: [{ content: 'a', status: 'pending', priority: 'high' }] });
    update(page, 'plan', {
      entries: [
        { content: 'a', status: 'completed', priority: 'high' },
        { content: 'b', status: 'pending', priority: 'low' },
      ],
    });

    expect(plans()).toEqual([['✅ a', '⬜ b']]);
  });

  it('starts a new plan in the next turn', () => {
    for (const step of ['first', 'second']) {
      page.send({ type: 'promptStart' });
      update(page, 'plan', { entries: [{ content: step, status: 'pending', priority: 'low' }] });
      page.send({ type: 'promptEnd', stopReason: 'end_turn' });
    }

    expect(plans()).toEqual([['⬜ first'], ['⬜ second']]);
  });
});

function plans(): string[][] {
  return [...page.document.querySelectorAll('.plan')].map((plan) =>
    [...plan.querySelectorAll('.plan-entry')].map((entry) => entry.textContent ?? ''),
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
