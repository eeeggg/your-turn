import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect, loadChatPage, textChunk, update, type ChatPage } from './chatPage';

let page: ChatPage;

beforeEach(() => {
  page = loadChatPage();
  connect(page);
});

afterEach(() => {
  expect(page.errors).toEqual([]);
  page.close();
});

function messages(): string[] {
  return [...page.document.querySelectorAll('.message')].map((el) => `${el.className}: ${el.textContent}`);
}

function replay(turns: Array<[user: string, agent: string]>): void {
  for (const [user, agent] of turns) {
    update(page, 'user_message_chunk', textChunk(user));
    update(page, 'agent_message_chunk', textChunk(agent));
  }
}

describe('loading a session', () => {
  it('clears the chat and shows the overlay while history replays', () => {
    page.typePrompt('old');
    page.pressKey('Enter');

    page.send({ type: 'loadSessionStart' });

    expect(page.byId('loadOverlay').classList.contains('visible')).toBe(true);
    expect(page.byId('inputArea').classList.contains('disabled')).toBe(true);
    expect(messages()).toEqual([]);
    expect(page.byId('messages').contains(page.byId('emptyState'))).toBe(true);
    expect(page.byId('emptyState').style.display).toBe('none');
  });

  it('splits replayed history into turns at each user message', () => {
    page.send({ type: 'loadSessionStart' });
    replay([
      ['q1', 'a1'],
      ['q2', 'a2'],
    ]);

    expect(messages()).toEqual([
      'message user: q1',
      'message agent: a1',
      'message user: q2',
      'message agent: a2',
    ]);
    expect(page.document.querySelectorAll('.turn')).toHaveLength(2);
  });

  it('joins consecutive user chunks into one message', () => {
    page.send({ type: 'loadSessionStart' });
    update(page, 'user_message_chunk', textChunk('hel'));
    update(page, 'user_message_chunk', textChunk('lo'));

    expect(messages()).toEqual(['message user: hello']);
  });

  it('requests markdown for every replayed answer in one batch when the load ends', () => {
    page.send({ type: 'loadSessionStart' });
    replay([
      ['q1', 'a1'],
      ['q2', 'a2'],
    ]);
    page.takePosted();

    page.send({ type: 'loadSessionEnd', ok: true });

    expect(page.takePosted()).toEqual([
      {
        type: 'renderMarkdown',
        items: [
          { index: 1, text: 'a1' },
          { index: 3, text: 'a2' },
        ],
      },
    ]);
    expect(page.byId('loadOverlay').classList.contains('visible')).toBe(false);
    expect(page.byId('inputArea').classList.contains('disabled')).toBe(false);

    page.send({ type: 'markdownRendered', items: [{ index: 3, html: '<p>A2</p>' }] });
    const answers = [...page.document.querySelectorAll('.message.agent')].map((el) => el.innerHTML);
    expect(answers).toEqual(['a1', '<p>A2</p>']);
  });

  it('reports a failed load', () => {
    page.send({ type: 'loadSessionStart' });
    page.send({ type: 'loadSessionEnd', ok: false });

    expect(messages()).toEqual(['message error: Failed to load session history.']);
    expect(page.byId('loadOverlay').classList.contains('visible')).toBe(false);
  });
});
