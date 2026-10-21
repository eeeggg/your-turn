import { afterEach, describe, expect, it } from 'vitest';
import { answer, connect, loadChatPage, plan, thought, toolCall, type ChatPage } from './chatPage';

const pages: ChatPage[] = [];

function open(savedState?: unknown): ChatPage {
  const page = loadChatPage(savedState === undefined ? {} : { savedState });
  pages.push(page);
  return page;
}

afterEach(() => {
  for (const page of pages.splice(0)) {
    expect(page.errors).toEqual([]);
    page.close();
  }
});

/** One full turn: a user prompt, a thought, a tool call, an answer and a plan. */
function runTurn(page: ChatPage): void {
  connect(page, { agentName: 'OpenCode', title: 'Session title', cwd: '/work/project' });
  page.typePrompt('question');
  page.pressKey('Enter');
  page.window.Date.now = () => 1_000;
  page.send({ type: 'promptStart' });
  thought(page, 'thinking');
  toolCall(page, { toolCallId: 't1', title: 'Read file', status: 'pending', texts: ['file body'] });
  page.window.Date.now = () => 3_000;
  answer(page, 'answer');
  plan(page, { text: 'step', status: 'pending' });
  page.send({ type: 'promptEnd' });
}

/** What an earlier build saved: a transcript the page cannot tie to any session. */
const earlierBuildState = {
  hasActiveSession: true,
  sessionState: { agentName: 'OpenCode', cwd: '/work/project', title: 'Old session' },
  transcript: [
    { kind: 'message', role: 'user', text: 'old question' },
    { kind: 'message', role: 'agent', text: 'old answer' },
  ],
};

function transcriptOnScreen(page: ChatPage): string[] {
  return [...page.byId('messages').children]
    .filter((el) => el.id !== 'emptyState')
    .map((el) => el.textContent);
}

describe('a rebuilt page', () => {
  it('shows no transcript and no session until the extension reports one', () => {
    const page = open(earlierBuildState);

    expect(transcriptOnScreen(page)).toEqual([]);
    expect(page.byId('sessionBanner').classList.contains('visible')).toBe(false);
    expect(page.byId('inputArea').classList.contains('disabled')).toBe(true);
    expect(page.takePosted()).toEqual([{ type: 'ready' }]);
  });

  it('shows no old transcript when the extension reports no session', () => {
    const page = open(earlierBuildState);

    page.send({ type: 'state', activeSessionId: null, session: null });

    expect(transcriptOnScreen(page)).toEqual([]);
    expect(page.byId('emptyState').style.display).toBe('');
  });

  it('shows no old transcript when the extension reports a different session', () => {
    const page = open(earlierBuildState);

    connect(page, { agentName: 'OpenCode', title: 'New session' });

    expect(transcriptOnScreen(page)).toEqual([]);
    expect(page.byId('bannerAgent').textContent).toBe('New session');
  });
});

describe('saved state', () => {
  it('stays empty through a full turn', () => {
    const page = open();
    runTurn(page);

    expect(page.byId('messages').querySelector('.turn > .message.agent')?.textContent).toBe('answer');
    expect(page.savedState()).toBeUndefined();
  });
});
