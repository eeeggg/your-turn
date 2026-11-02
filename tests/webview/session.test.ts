import { describe, expect, it, onTestFinished } from 'vitest';
import { connect, loadChatPage, type ChatPage } from './chatPage';

let page: ChatPage;

describe('session state', () => {
  it('closes every test-owned page after the test finishes', () => {
    const opened: ChatPage[] = [];
    const heard: string[] = [];
    onTestFinished(() => {
      try {
        for (const openedPage of opened) {
          openedPage.window.dispatchEvent(new openedPage.window.Event('cleanup-probe'));
        }
        expect(heard).toEqual([]);
      } finally {
        for (const openedPage of opened) { openedPage.close(); }
      }
    });
    page = loadChatPage();
    opened.push(page, loadChatPage());
    for (const [index, openedPage] of opened.entries()) {
      openedPage.window.addEventListener('cleanup-probe', () => heard.push(String(index)));
      openedPage.window.dispatchEvent(new openedPage.window.Event('cleanup-probe'));
    }
    expect(heard).toEqual(['0', '1']);
    heard.length = 0;
  });

  it('starts disconnected and tells the host it is ready', () => {
    page = loadChatPage();

    expect(page.takePosted()).toEqual([{ type: 'ready' }]);
    expect(page.byId('inputArea').classList.contains('disabled')).toBe(true);
    expect(page.byId('sessionTabs').hidden).toBe(true);
    expect(page.byId('emptyState').style.display).toBe('');
  });

  it('shows the banner and enables input when a session connects', () => {
    page = loadChatPage();
    connect(page, { agentName: 'OpenCode', cwd: '/work/project' });

    expect(page.byId('sessionTabs').hidden).toBe(false);
    expect(page.document.querySelector('[role="tab"]')?.textContent).toBe('OpenCode');
    expect(page.document.querySelector('[role="tab"]')?.getAttribute('title')).toContain('/work/project');
    expect(page.byId('inputArea').classList.contains('disabled')).toBe(false);
    expect(page.byId('emptyState').style.display).toBe('none');
  });

  it('prefers the session title over the agent name', () => {
    page = loadChatPage();
    connect(page, { agentName: 'OpenCode', title: 'Fix the build' });

    expect(page.document.querySelector('[role="tab"]')?.textContent).toBe('Fix the build');
  });

  it('updates the title from sessionInfoUpdate and falls back to the agent name when cleared', () => {
    page = loadChatPage();
    connect(page, { agentName: 'OpenCode', title: 'Old' });

    page.send({ type: 'sessionInfoUpdate', title: 'New' });
    page.send({ type: 'sessionTabs', selectedTabId: 'tab', tabs: [{ tabId: 'tab', title: 'New', agentName: 'OpenCode', cwd: '/work', additionalDirectories: [], running: false }] });
    expect(page.document.querySelector('[role="tab"]')?.textContent).toBe('New');

    page.send({ type: 'sessionInfoUpdate', title: null });
    page.send({ type: 'sessionTabs', selectedTabId: 'tab', tabs: [{ tabId: 'tab', title: null, agentName: 'OpenCode', cwd: '/work', additionalDirectories: [], running: false }] });
    expect(page.document.querySelector('[role="tab"]')?.textContent).toBe('OpenCode');
  });

  it('ignores sessionInfoUpdate when no session is connected', () => {
    page = loadChatPage();
    page.send({ type: 'sessionInfoUpdate', title: 'New' });

    expect(page.document.querySelector('[role="tab"]')).toBeNull();
  });

  it('returns to the disconnected view on a state message without a session', () => {
    page = loadChatPage();
    connect(page);
    page.send({ type: 'state', activeSessionId: null, session: null });

    expect(page.document.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(page.byId('inputArea').classList.contains('disabled')).toBe(true);
    expect(page.byId('emptyState').style.display).toBe('');
  });

  it('clearTranscript removes messages and returns to the disconnected view', () => {
    page = loadChatPage();
    connect(page);
    page.typePrompt('hello');
    page.pressKey('Enter');
    page.send({ type: 'clearTranscript' });

    expect(page.document.querySelectorAll('.message')).toHaveLength(0);
    expect(page.byId('messages').contains(page.byId('emptyState'))).toBe(true);
    expect(page.byId('emptyState').style.display).toBe('');
    expect(page.document.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(page.byId('inputArea').classList.contains('disabled')).toBe(true);
  });

  it('clears the transcript when the host reports a different session', () => {
    page = loadChatPage();
    connect(page, { sessionId: 's1' });
    page.typePrompt('hello');
    page.pressKey('Enter');

    connect(page, { sessionId: 's2', agentName: 'OpenCode' });

    expect(page.document.querySelectorAll('.message')).toHaveLength(0);
    expect(page.document.querySelector('[role="tab"]')?.textContent).toBe('OpenCode');
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

  it('clears the transcript on disconnect, leaving only the empty state', () => {
    page = loadChatPage();
    connect(page, { sessionId: 's1' });
    page.typePrompt('hello');
    page.pressKey('Enter');
    page.send({ type: 'promptStart' });

    page.send({ type: 'state', activeSessionId: null, session: null });

    expect(page.document.querySelectorAll('.message')).toHaveLength(0);
    expect(page.byId('messages').contains(page.byId('emptyState'))).toBe(true);
    expect(page.byId('emptyState').style.display).toBe('');
    expect(page.document.querySelector('.activity-dot')).toBeNull();
  });

  it('keeps the transcript cleared when the same session reconnects', () => {
    page = loadChatPage();
    connect(page, { sessionId: 's1' });
    page.typePrompt('hello');
    page.pressKey('Enter');

    page.send({ type: 'state', activeSessionId: null, session: null });
    connect(page, { sessionId: 's1' });

    expect(page.document.querySelectorAll('.message')).toHaveLength(0);
  });

  it('shows extension errors as error messages', () => {
    page = loadChatPage();
    page.send({ type: 'error', message: 'boom' });

    const errors = [...page.document.querySelectorAll('.message.error')].map((el) => el.textContent);
    expect(errors).toEqual(['boom']);
  });
});
