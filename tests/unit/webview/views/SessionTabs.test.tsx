// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionSnapshot, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import { initialState, update, type Action } from '@/webview/state/RootState';
import { SessionTabs } from '@/webview/views/SessionTabs';
import { createStore } from '@/webview/state/Store';
import { StoreContext } from '@/webview/views/StoreContext';

afterEach(cleanup);

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
      additionalDirectories: [], running: false,
    }],
  });
  return { send, connect, part, posted };
}

describe('session tabs', () => {
  it('shows navigation references and sends requests without changing selection locally', () => {
    const { send, posted } = renderTabs();
    send({ type: 'sessionTabs', selectedTabId: 'a', tabs: [
      { tabId: 'a', title: 'Fix the build', agentName: 'OpenCode', cwd: '/work/project', additionalDirectories: ['/other'], running: false },
      { tabId: 'b', title: null, agentName: 'Other', cwd: '/work/project', additionalDirectories: [], running: true },
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

  it('shows an activity dot only while the snapshot reports work', () => {
    const { connect, send } = renderTabs();
    connect();

    send({ type: 'sessionTabs', selectedTabId: 'a', tabs: [{ tabId: 'a', title: null, agentName: 'OpenCode', cwd: '/work/project', additionalDirectories: [], running: true }] });
    expect(screen.getByLabelText('Actively working').classList.contains('bg-success')).toBe(true);

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
