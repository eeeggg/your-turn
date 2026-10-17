import { afterEach, describe, expect, it } from 'vitest';
import { connect, loadChatPage, textChunk, update, type ChatPage } from './chatPage';

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
  update(page, 'agent_thought_chunk', textChunk('thinking'));
  update(page, 'tool_call', {
    toolCallId: 't1',
    title: 'Read file',
    status: 'pending',
    content: [{ type: 'content', content: { type: 'text', text: 'file body' } }],
  });
  page.window.Date.now = () => 3_000;
  update(page, 'agent_message_chunk', textChunk('answer'));
  update(page, 'plan', { entries: [{ content: 'step', status: 'pending', priority: 'low' }] });
  page.send({ type: 'promptEnd', stopReason: 'end_turn' });
}

describe('state persistence', () => {
  it('saves the session and transcript', () => {
    const page = open();
    runTurn(page);

    expect(page.savedState()).toEqual({
      hasActiveSession: true,
      sessionState: { agentName: 'OpenCode', cwd: '/work/project', title: 'Session title' },
      transcript: [
        { kind: 'message', role: 'user', text: 'question' },
        { kind: 'toolCall', toolCallId: 't1', title: 'Read file', status: 'pending', content: ['file body'] },
        { kind: 'plan', plan: { sessionUpdate: 'plan', entries: [{ content: 'step', status: 'pending', priority: 'low' }] } },
        { kind: 'thought', text: 'thinking', durationSec: 2 },
        { kind: 'message', role: 'agent', text: 'answer' },
      ],
    });
  });

  it('restores a saved chat and requests markdown before signalling ready', () => {
    const first = open();
    runTurn(first);

    const page = open(first.savedState());

    expect(page.byId('sessionBanner').classList.contains('visible')).toBe(true);
    expect(page.byId('bannerAgent').textContent).toBe('Session title');
    expect(page.byId('inputArea').classList.contains('disabled')).toBe(false);
    const restored = [...page.byId('messages').children]
      .filter((el) => el.id !== 'emptyState')
      .map((el) => el.className);
    expect(restored).toEqual(['message user', 'tool-call-inline', 'plan', 'thought-block', 'message agent']);
    expect(page.document.querySelector('.thought-block summary')?.textContent).toBe('Thought for 2s');
    expect(page.byId('tc-t1').querySelector('.tc-body-block')?.textContent).toBe('file body');
    expect(page.takePosted()).toEqual([
      { type: 'renderMarkdown', items: [{ index: 4, text: 'answer' }] },
      { type: 'ready' },
    ]);
  });

  it('does not restore config option pickers from saved state', () => {
    const first = open();
    connect(first, {
      configOptions: [
        { id: 'model', name: 'Model', type: 'select', currentValue: 'a', options: [{ value: 'a', name: 'A' }] },
      ],
    });

    const page = open(first.savedState());

    expect(page.byId('configOptionsContainer').children).toHaveLength(0);
  });
});
