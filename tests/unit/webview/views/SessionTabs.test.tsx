// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionSnapshot, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import { initialState, update, type Action } from '@/webview/state/RootState';
import { SessionTabs } from '@/webview/views/SessionTabs';
import { createStore } from '@/webview/state/Store';
import { StoreContext } from '@/webview/views/StoreContext';

afterEach(cleanup);

const review = { modified: false, created: false, deleted: false };

function renderTabs() {
  const posted: WebviewToExtensionMessage[] = [];
  const store = createStore(initialState, update, (message: WebviewToExtensionMessage) => posted.push(message));
  const send = (action: Action) => act(() => store.dispatch(action));
  const { container } = render(
    <StoreContext value={store}>
      <SessionTabs />
    </StoreContext>,
  );
  const part = (selector: string) => {
    const found = container.querySelector<HTMLElement>(selector);
    if (!found) {
      throw new Error(`nothing matches ${selector}`);
    }
    return found;
  };
  const connect = (session: Partial<SessionSnapshot> = {}) => send({
    type: 'sessionTabs', selectedTabId: 'a', tabs: [{
      tabId: 'a', title: session.title ?? null, agentName: session.agentName ?? 'OpenCode', cwd: session.cwd ?? '/work/project',
      additionalDirectories: [], status: 'quiet', review,
    }],
  });
  return { send, connect, part, posted };
}

describe('session tabs', () => {
  it('announces a revision once without moving focus or replaying it on tab updates', () => {
    const { connect, send } = renderTabs();
    connect({ title: 'Build' });
    const tab = screen.getByRole('tab', { name: 'Build' });
    tab.focus();
    const live = screen.getByRole('status');
    expect(live.textContent).toBe('');
    send({ type: 'sessionTabAnnouncement', revision: 2, text: 'Other: Needs your input.' });
    const announced = live.firstChild;
    expect(announced?.textContent).toBe('Other: Needs your input.');
    connect({ title: 'Build' });
    send({ type: 'sessionTabAnnouncement', revision: 2, text: 'Duplicate' });
    send({ type: 'sessionTabAnnouncement', revision: 1, text: 'Obsolete' });
    expect(live.firstChild).toBe(announced);
    expect(document.activeElement).toBe(tab);
  });

  it.each([
    ['needsInput', 'text-warning', 'Needs your input'],
    ['failed', 'text-failure', 'Interrupted or failed'],
    ['completed', 'text-muted-foreground', 'Finished while unselected'],
  ] as const)('shows the %s icon and describes it when unselected', (status, colorClass, description) => {
    const { send } = renderTabs();
    const tabs = [{ tabId: 'a', title: 'A session', agentName: 'Agent', cwd: '/work', additionalDirectories: [], review, status }];
    send({ type: 'sessionTabs', selectedTabId: null, tabs });
    const tab = screen.getByRole('tab', { name: 'A session', description: `${description}.` });
    const indicator = screen.getByLabelText(description);
    expect(tab.contains(indicator)).toBe(true);
    expect(indicator.getAttribute('aria-hidden')).toBe('true');
    expect(indicator.classList.contains(colorClass)).toBe(true);
    expect(indicator.querySelector('svg')).not.toBeNull();
    expect(tab.textContent).toBe('A session');
    expect(tab.getAttribute('aria-selected')).toBe('false');
  });

  it('hides the completed icon when the tab is selected', () => {
    const { send } = renderTabs();
    const tabs = [{ tabId: 'a', title: 'A session', agentName: 'Agent', cwd: '/work', additionalDirectories: [], review, status: 'completed' as const }];
    send({ type: 'sessionTabs', selectedTabId: 'a', tabs });
    const tab = screen.getByRole('tab', { name: 'A session' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(tab.hasAttribute('aria-describedby')).toBe(false);
    expect(screen.queryByLabelText('Finished while unselected')).toBeNull();
  });

  it('describes review markers in fixed order without changing the tab or close name', () => {
    const { send, part } = renderTabs();
    const tabs = [{ tabId: 'a', title: 'Review files', agentName: 'Agent', cwd: '/work', additionalDirectories: [], status: 'working' as const,
      review: { deleted: true, created: true, modified: true } }];
    send({ type: 'sessionTabs', selectedTabId: 'a', tabs });
    const tab = screen.getByRole('tab', { name: 'Review files', description: 'Actively working. Modified files. Created files. Deleted files.' });
    expect(part('.session-tab-markers').textContent).toBe('MUD');
    expect(tab.contains(screen.getByLabelText('Actively working'))).toBe(true);
    const close = screen.getByRole('button', { name: 'Close Review files' });
    expect(close.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(close.textContent).toBe('');
    send({ type: 'sessionTabs', selectedTabId: null, tabs });
    expect(part('.session-tab-markers').textContent).toBe('MUD');
  });

  it('shows navigation references and sends requests without changing selection locally', () => {
    const { send, posted } = renderTabs();
    send({ type: 'sessionTabs', selectedTabId: 'a', tabs: [
      { tabId: 'a', title: 'Fix the build', agentName: 'OpenCode', cwd: '/work/project', additionalDirectories: ['/other'], status: 'quiet', review },
      { tabId: 'b', title: null, agentName: 'Other', cwd: '/work/project', additionalDirectories: [], status: 'working', review },
    ] });
    const first = screen.getByRole('tab', { name: 'Fix the build' });
    const second = screen.getByRole('tab', { name: 'Other' });
    expect(first.title).toBe('Fix the build\nOpenCode\n/work/project\n/other');
    expect(first.getAttribute('aria-selected')).toBe('true');
    expect(second.getAttribute('aria-selected')).toBe('false');
    expect(screen.getAllByLabelText('Actively working')).toHaveLength(1);
    expect(second.contains(screen.getByLabelText('Actively working'))).toBe(true);
    const close = screen.getByRole('button', { name: 'Close Fix the build' });
    expect(first.contains(close)).toBe(false);
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(second);
    expect(posted).toEqual([]);
    fireEvent.keyDown(second, { key: 'Home' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'End' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(first);
    fireEvent.click(second);
    fireEvent.keyDown(second, { key: 'Delete' });
    fireEvent.click(close);
    expect(posted).toEqual([
      { type: 'selectSessionTab', tabId: 'b' }, { type: 'closeSessionTab', tabId: 'b' }, { type: 'closeSessionTab', tabId: 'a' },
    ]);
    expect(first.getAttribute('aria-selected')).toBe('true');
  });

  it('is hidden and empty without a session', () => {
    const { part } = renderTabs();

    expect(part('#sessionTabs').hidden).toBe(true);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryAllByRole('tab')).toEqual([]);
  });

  it("shows the session's name and working directory once connected", () => {
    const { connect, part } = renderTabs();

    connect({ title: 'Fix the build' });

    expect(part('#sessionTabs').hidden).toBe(false);
    expect(screen.getByRole('tab', { name: 'Fix the build' }).title).toBe('Fix the build\nOpenCode\n/work/project');
  });

  it('shows a steady activity icon only while the snapshot reports work', () => {
    const { connect, send } = renderTabs();
    connect();

    send({ type: 'sessionTabs', selectedTabId: 'a', tabs: [{ tabId: 'a', title: null, agentName: 'OpenCode', cwd: '/work/project', additionalDirectories: [], status: 'working', review }] });
    const indicator = screen.getByLabelText('Actively working');
    expect(indicator.classList.contains('activity-dot')).toBe(true);
    expect(indicator.classList.contains('text-success')).toBe(true);
    expect(indicator.classList.contains('animate-pulse')).toBe(false);
    expect(indicator.querySelector('svg')).not.toBeNull();

    connect();
    expect(screen.queryByLabelText('Actively working')).toBeNull();
  });

  it('hides and empties when core removes all navigation references', () => {
    const { connect, send, part } = renderTabs();
    connect();
    send({ type: 'promptStart' });

    send({ type: 'sessionTabs', tabs: [], selectedTabId: null });

    expect(part('#sessionTabs').hidden).toBe(true);
    expect(screen.queryAllByRole('tab')).toEqual([]);
    expect(screen.queryByLabelText('Actively working')).toBeNull();
  });
});
