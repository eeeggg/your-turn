import { beforeEach, describe, expect, it } from 'vitest';
import {
  answer,
  connect,
  loadChatPage,
  plan,
  shownText,
  thought,
  toggle,
  type ChatPage
} from '@tests/webview/chatPage';

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
  it('shows the tab activity indicator while core reports foreground work', () => {
    const tab = { tabId: 'tab', title: null, agentName: 'Agent', cwd: '/work', additionalDirectories: [],
      review: { modified: false, created: false, deleted: false } };
    page.send({ type: 'promptStart' });
    page.send({ type: 'sessionTabs', selectedTabId: 'tab', tabs: [
      { ...tab, status: 'working' },
    ] });

    expect(page.byId('sessionTabs').querySelector('.activity-dot')?.getAttribute('aria-label')).toBe('Actively working');

    page.send({ type: 'promptEnd' });
    page.send({ type: 'sessionTabs', selectedTabId: 'tab', tabs: [
      { ...tab, status: 'quiet' },
    ] });
    expect(page.byId('sessionTabs').querySelector('.activity-dot')).toBeNull();
  });

  it('accumulates the text of a turn into one agent message', () => {
    page.send({ type: 'promptStart' });
    answer(page, 'hello ');
    expect(agentMessages()).toEqual(['hello']);
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
  it('renders plan steps as a list with distinct steady status icons, accessible labels, and escaped text', () => {
    plan(
      page,
      { text: 'done step', status: 'completed' },
      { text: 'current step', status: 'running' },
      { text: '<b>next</b>', status: 'pending' },
    );

    expect(page.document.querySelector('.plan ul')).not.toBeNull();
    const entries = [...page.document.querySelectorAll('.plan .plan-entry')];
    expect(entries.map((el) => el.tagName)).toEqual(['LI', 'LI', 'LI']);
    expect(entries.map((el) => el.textContent)).toEqual([
      'Completed: done step',
      'In progress: current step',
      'Pending: <b>next</b>',
    ]);
    expect(entries.map((el) => el.classList.contains('completed'))).toEqual([true, false, false]);
    const svgs = entries.map((el) => {
      const icon = el.querySelector('.plan-icon');
      expect(icon?.getAttribute('aria-hidden')).toBe('true');
      const svg = icon?.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(Array.from(svg?.classList ?? [])).not.toContain('animate-pulse');
      expect(Array.from(svg?.classList ?? [])).not.toContain('animate-spin');
      return svg?.innerHTML;
    });
    expect(new Set(svgs).size).toBe(3);
    expect(page.document.querySelector('.plan b')).toBeNull();
  });

  it('replaces the plan when the agent updates it during a turn', () => {
    page.send({ type: 'promptStart' });
    plan(page, { text: 'a', status: 'pending' });
    plan(page, { text: 'a', status: 'completed' }, { text: 'b', status: 'pending' });

    expect(plans()).toEqual([['Completed: a', 'Pending: b']]);
  });

  it('starts a new plan in the next turn', () => {
    for (const step of ['first', 'second']) {
      page.send({ type: 'promptStart' });
      plan(page, { text: step, status: 'pending' });
      page.send({ type: 'promptEnd' });
    }

    expect(plans()).toEqual([['Pending: first'], ['Pending: second']]);
  });
});

function plans(): string[][] {
  return [...page.document.querySelectorAll('.plan')].map((block) =>
    [...block.querySelectorAll('.plan-entry')].map((entry) => entry.textContent),
  );
}
