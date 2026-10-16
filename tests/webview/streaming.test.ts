import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

function assistantMessages(): string[] {
  return [...page.document.querySelectorAll('.message.assistant')].map((el) => el.textContent ?? '');
}

describe('streaming a turn', () => {
  it('switches the send button to stop while a prompt runs', () => {
    page.send({ type: 'promptStart' });
    const button = page.byId<HTMLButtonElement>('sendStopBtn');

    expect(button.className).toBe('send-stop-btn stop');
    expect(button.textContent).toBe('■ Stop');
    expect(page.byId('status').querySelector('.spinner')).not.toBeNull();

    page.send({ type: 'promptEnd', stopReason: 'end_turn' });
    expect(button.className).toBe('send-stop-btn send');
    expect(button.textContent).toBe('Send');
    expect(page.byId('status').textContent).toBe('');
  });

  it('accumulates message chunks into one assistant message inside a turn', () => {
    page.send({ type: 'promptStart' });
    update(page, 'agent_message_chunk', textChunk('hello '));
    update(page, 'agent_message_chunk', textChunk('world'));

    expect(assistantMessages()).toEqual(['hello world']);
    expect(page.document.querySelector('.turn > .message.assistant')).not.toBeNull();
  });

  it('waits for non-whitespace text before showing the assistant message', () => {
    page.send({ type: 'promptStart' });
    update(page, 'agent_message_chunk', textChunk('\n  '));
    expect(assistantMessages()).toEqual([]);

    update(page, 'agent_message_chunk', textChunk('hi'));
    expect(assistantMessages()).toEqual(['\n  hi']);
  });

  it('shows streamed text as plain text until markdown is rendered', () => {
    page.send({ type: 'promptStart' });
    update(page, 'agent_message_chunk', textChunk('<img src="x">'));

    expect(page.document.querySelector('.message.assistant img')).toBeNull();
    expect(assistantMessages()).toEqual(['<img src="x">']);
  });

  it('requests markdown rendering at promptEnd and applies the rendered HTML', () => {
    page.typePrompt('question');
    page.pressKey('Enter');
    page.send({ type: 'promptStart' });
    update(page, 'agent_message_chunk', textChunk('**bold**'));
    page.takePosted();

    page.send({ type: 'promptEnd', stopReason: 'end_turn' });
    expect(page.takePosted()).toEqual([{ type: 'renderMarkdown', items: [{ index: 1, text: '**bold**' }] }]);

    page.send({ type: 'markdownRendered', items: [{ index: 1, html: '<p><strong>bold</strong></p>' }] });
    const el = page.document.querySelector('.message.assistant');
    expect(el?.classList.contains('md-rendered')).toBe(true);
    expect(el?.innerHTML).toBe('<p><strong>bold</strong></p>');
  });

  it('starts a separate assistant message for each turn', () => {
    for (const text of ['first', 'second']) {
      page.send({ type: 'promptStart' });
      update(page, 'agent_message_chunk', textChunk(text));
      page.send({ type: 'promptEnd', stopReason: 'end_turn' });
    }

    expect(assistantMessages()).toEqual(['first', 'second']);
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

  it('finalizes a thought without an answer at promptEnd', () => {
    page.send({ type: 'promptStart' });
    update(page, 'agent_thought_chunk', textChunk('hmm'));
    page.send({ type: 'promptEnd', stopReason: 'end_turn' });

    const thought = page.document.querySelector('.thought-block');
    expect(thought?.classList.contains('streaming')).toBe(false);
    expect(thought?.querySelector('summary')?.textContent).toBe('Thought');
    expect(page.takePosted().filter((m) => m.type === 'renderMarkdown')).toEqual([]);
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
});
