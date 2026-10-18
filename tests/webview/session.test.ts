import { afterEach, describe, expect, it } from 'vitest';
import { connect, loadChatPage, type ChatPage } from './chatPage';

let page: ChatPage;

afterEach(() => {
  expect(page.errors).toEqual([]);
  page.close();
});

describe('session state', () => {
  it('starts disconnected and tells the host it is ready', () => {
    page = loadChatPage();

    expect(page.takePosted()).toEqual([{ type: 'ready' }]);
    expect(page.byId('inputArea').classList.contains('disabled')).toBe(true);
    expect(page.byId('sessionBanner').classList.contains('visible')).toBe(false);
    expect(page.byId('emptyState').style.display).toBe('');
  });

  it('shows the banner and enables input when a session connects', () => {
    page = loadChatPage();
    connect(page, { agentName: 'OpenCode', cwd: '/work/project' });

    expect(page.byId('sessionBanner').classList.contains('visible')).toBe(true);
    expect(page.byId('bannerAgent').textContent).toBe('OpenCode');
    expect(page.byId('bannerCwd').textContent).toBe('/work/project');
    expect(page.byId('inputArea').classList.contains('disabled')).toBe(false);
    expect(page.byId('emptyState').style.display).toBe('none');
  });

  it('prefers the session title over the agent name', () => {
    page = loadChatPage();
    connect(page, { agentName: 'OpenCode', title: 'Fix the build' });

    expect(page.byId('bannerAgent').textContent).toBe('Fix the build');
  });

  it('updates the title from sessionInfoUpdate and falls back to the agent name when cleared', () => {
    page = loadChatPage();
    connect(page, { agentName: 'OpenCode', title: 'Old' });

    page.send({ type: 'sessionInfoUpdate', title: 'New' });
    expect(page.byId('bannerAgent').textContent).toBe('New');

    page.send({ type: 'sessionInfoUpdate', title: null });
    expect(page.byId('bannerAgent').textContent).toBe('OpenCode');
  });

  it('ignores sessionInfoUpdate when no session is connected', () => {
    page = loadChatPage();
    page.send({ type: 'sessionInfoUpdate', title: 'New' });

    expect(page.byId('bannerAgent').textContent).toBe('');
  });

  it('returns to the disconnected view on a state message without a session', () => {
    page = loadChatPage();
    connect(page);
    page.send({ type: 'state', activeSessionId: null, session: null });

    expect(page.byId('sessionBanner').classList.contains('visible')).toBe(false);
    expect(page.byId('inputArea').classList.contains('disabled')).toBe(true);
    expect(page.byId('emptyState').style.display).toBe('');
  });

  it('clearChat removes messages and returns to the disconnected view', () => {
    page = loadChatPage();
    connect(page);
    page.typePrompt('hello');
    page.pressKey('Enter');
    page.send({ type: 'clearChat' });

    expect(page.document.querySelectorAll('.message')).toHaveLength(0);
    expect(page.byId('messages').contains(page.byId('emptyState'))).toBe(true);
    expect(page.byId('emptyState').style.display).toBe('');
    expect(page.byId('sessionBanner').classList.contains('visible')).toBe(false);
    expect(page.byId('inputArea').classList.contains('disabled')).toBe(true);
  });

  it('clears the transcript when the host reports a different session', () => {
    page = loadChatPage();
    connect(page, { sessionId: 's1' });
    page.typePrompt('hello');
    page.pressKey('Enter');

    connect(page, { sessionId: 's2', agentName: 'OpenCode' });

    expect(page.document.querySelectorAll('.message')).toHaveLength(0);
    expect(page.byId('bannerAgent').textContent).toBe('OpenCode');
    expect(page.byId('inputArea').classList.contains('disabled')).toBe(false);
  });

  it('keeps the transcript when the host reports the same session again', () => {
    page = loadChatPage();
    connect(page, { sessionId: 's1' });
    page.typePrompt('hello');
    page.pressKey('Enter');

    connect(page, { sessionId: 's1' });

    expect([...page.document.querySelectorAll('.message.user')].map((el) => el.textContent)).toEqual(['hello']);
  });

  it('keeps the transcript on disconnect and clears it when a new session follows', () => {
    page = loadChatPage();
    connect(page, { sessionId: 's1' });
    page.typePrompt('hello');
    page.pressKey('Enter');

    page.send({ type: 'state', activeSessionId: null, session: null });
    expect(page.document.querySelectorAll('.message.user')).toHaveLength(1);

    connect(page, { sessionId: 's2' });
    expect(page.document.querySelectorAll('.message')).toHaveLength(0);
  });

  it('welcome buttons run the connect and add-agent commands', () => {
    page = loadChatPage();
    page.takePosted();

    page.byId('welcomeConnectAgent').click();
    page.byId('welcomeAddAgent').click();

    expect(page.takePosted()).toEqual([
      { type: 'executeCommand', command: 'acp.connectAgent' },
      { type: 'executeCommand', command: 'acp.addAgent' },
    ]);
  });

  it('shows extension errors as error messages', () => {
    page = loadChatPage();
    page.send({ type: 'error', message: 'boom' });

    const errors = [...page.document.querySelectorAll('.message.error')].map((el) => el.textContent);
    expect(errors).toEqual(['boom']);
  });
});
