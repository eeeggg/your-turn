import { beforeEach, describe, expect, it } from 'vitest';
import { hookClasses } from '@tests/hookClasses';
import { answer, connect, loadChatPage, replayed, shownText, toolCall, type ChatPage } from './chatPage';

let page: ChatPage;

beforeEach(() => {
  page = loadChatPage();
  connect(page);
});

function messages(): string[] {
  return [...page.document.querySelectorAll('.message')].map((el) => `${hookClasses(el)}: ${shownText(el)}`);
}

function replay(turns: [user: string, agent: string][]): void {
  for (const [user, agent] of turns) {
    replayed(page, user);
    answer(page, agent);
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

  it('splits replayed history into turns at each prompt', () => {
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

  it('joins consecutive prompt text into one message', () => {
    page.send({ type: 'loadSessionStart' });
    replayed(page, 'hel');
    replayed(page, 'lo');

    expect(messages()).toEqual(['message user: hello']);
  });

  it('renders replayed answers as markdown as they arrive, asking the extension for nothing', () => {
    page.send({ type: 'loadSessionStart' });
    replay([
      ['q1', '**a1**'],
      ['q2', '*a2*'],
    ]);
    page.takePosted();
    const emphasis = () => [...page.document.querySelectorAll('.message.agent')].map((el) => el.querySelector('[data-streamdown="strong"], em')?.textContent);
    expect(emphasis()).toEqual(['a1', 'a2']);

    page.send({ type: 'loadSessionEnd', ok: true });

    expect(page.takePosted()).toEqual([]);
    expect(emphasis()).toEqual(['a1', 'a2']);
    expect(page.byId('loadOverlay').classList.contains('visible')).toBe(false);
    expect(page.byId('inputArea').classList.contains('disabled')).toBe(false);
  });

  it('collapses more than three tool calls in a replayed turn, as in a live one', () => {
    page.send({ type: 'loadSessionStart' });
    for (const prompt of ['q1', 'q2']) {
      replayed(page, prompt);
      for (const id of ['1', '2', '3', '4']) {
        toolCall(page, { toolCallId: `${prompt}-${id}`, title: id, status: 'completed' });
      }
    }
    page.send({ type: 'loadSessionEnd', ok: true });

    const lists = [...page.document.querySelectorAll('.turn-tools-list')];
    expect(lists.map((list) => list.classList.contains('collapsed'))).toEqual([true, true]);
  });

  it('reports a failed load', () => {
    page.send({ type: 'loadSessionStart' });
    page.send({ type: 'loadSessionEnd', ok: false });

    expect(messages()).toEqual(['message error: Failed to load session.']);
    expect(page.byId('loadOverlay').classList.contains('visible')).toBe(false);
  });
});
