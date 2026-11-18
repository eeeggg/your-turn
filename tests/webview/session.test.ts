import { describe, expect, it, onTestFinished } from 'vitest';
import { connect, DEFAULT_SESSION_ID, loadChatPage, type ChatPage } from '@tests/webview/chatPage';

let page: ChatPage;
const OTHER_SESSION_ID = '6d6f181f-5cfa-48d7-bc38-1d687e385d55';

describe('session state', () => {
  it('reconstructs tab status and review markers without announcing on a fresh page', () => {
    page = loadChatPage();
    const tabs = { selectedTabId: 'selected', tabs: [
      { tabId: 'selected', title: 'Selected', agentName: 'Agent', cwd: '/work', additionalDirectories: [], status: 'quiet',
        review: { modified: false, created: false, deleted: false } },
      { tabId: 'answer', title: 'Build', agentName: 'Agent', cwd: '/work', additionalDirectories: [], status: 'needsInput',
        review: { modified: true, created: true, deleted: true } },
    ] } as const;
    page.send({ type: 'viewSnapshot', state: { activeSessionId: null, session: null }, tabs, running: false, loading: false, questions: [], content: null });
    const tab = page.byId('sessionTabs').querySelector<HTMLElement>('[aria-label="Build"]');
    const live = page.byId('sessionTabStatus');
    if (!tab) { throw new Error('Missing tab'); }
    expect(tab.textContent).toBe('?MUDBuild');
    expect(page.byId(tab.getAttribute('aria-describedby') ?? '').textContent).toBe('Needs your input. Modified files. Created files. Deleted files.');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toBe('');
    tab.focus();
    page.send({ type: 'sessionTabAnnouncement', revision: 1, text: 'Build: Needs your input.' });
    const announced = live.firstChild;
    page.send({ type: 'sessionTabs', ...tabs });
    expect(announced?.textContent).toBe('Build: Needs your input.');
    expect(live.firstChild).toBe(announced);
    expect(page.document.activeElement).toBe(tab);
    expect(page.takePosted()).toEqual([{ type: 'ready' }]);
  });

  it('posts the presentation tab ID rather than the session ID when closing a tab', () => {
    page = loadChatPage();
    const sessionId = '5a089aee-37da-46ab-9b04-097b16d5cf52';
    const tabId = 'tab-close-target';
    connect(page, { sessionId }, tabId);
    page.takePosted();

    const close = page.document.querySelector<HTMLButtonElement>('#sessionTabs button[aria-label="Close Fake Agent"]');
    expect(close).not.toBeNull();
    close?.click();
    const posted = page.takePosted();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: 'closeSessionTab' });
    expect(posted[0]).not.toEqual({ type: 'closeSessionTab', tabId: sessionId });
    expect(posted).toEqual([{ type: 'closeSessionTab', tabId }]);
  });

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
    const tab = { tabId: 'tab', agentName: 'OpenCode', cwd: '/work', additionalDirectories: [], status: 'quiet' as const,
      review: { modified: false, created: false, deleted: false } };

    page.send({ type: 'sessionInfoUpdate', title: 'New' });
    page.send({ type: 'sessionTabs', selectedTabId: 'tab', tabs: [{ ...tab, title: 'New' }] });
    expect(page.document.querySelector('[role="tab"]')?.textContent).toBe('New');

    page.send({ type: 'sessionInfoUpdate', title: null });
    page.send({ type: 'sessionTabs', selectedTabId: 'tab', tabs: [{ ...tab, title: null }] });
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
    connect(page, { sessionId: DEFAULT_SESSION_ID });
    page.typePrompt('hello');
    page.pressKey('Enter');

    connect(page, { sessionId: OTHER_SESSION_ID, agentName: 'OpenCode' }, 'tab-other');

    expect(page.document.querySelectorAll('.message')).toHaveLength(0);
    expect(page.document.querySelector('[role="tab"]')?.textContent).toBe('OpenCode');
    expect(page.byId('inputArea').classList.contains('disabled')).toBe(false);
  });

  it('keeps the transcript when the host reports the same session again', () => {
    page = loadChatPage({ retained: true });
    connect(page, { sessionId: DEFAULT_SESSION_ID });
    page.typePrompt('hello');
    page.pressKey('Enter');

    connect(page, { sessionId: DEFAULT_SESSION_ID });

    expect([...page.document.querySelectorAll('.message.user')].map((el) => el.textContent)).toEqual(['hello']);
  });

  it('clears the transcript on disconnect, leaving only the empty state', () => {
    page = loadChatPage();
    connect(page, { sessionId: DEFAULT_SESSION_ID });
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
    connect(page, { sessionId: DEFAULT_SESSION_ID });
    page.typePrompt('hello');
    page.pressKey('Enter');

    page.send({ type: 'state', activeSessionId: null, session: null });
    connect(page, { sessionId: DEFAULT_SESSION_ID });

    expect(page.document.querySelectorAll('.message')).toHaveLength(0);
  });

  it('shows extension errors as error messages', () => {
    page = loadChatPage();
    page.send({ type: 'error', message: 'boom' });

    const errors = [...page.document.querySelectorAll('.message.error')].map((el) => el.textContent);
    expect(errors).toEqual(['boom']);
  });
});
