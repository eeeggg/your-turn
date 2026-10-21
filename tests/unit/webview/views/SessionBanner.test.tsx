// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionSnapshot } from '@/shared/WebviewMessages';
import { initialState, update, type Action } from '@/webview/state/RootState';
import { SessionBanner } from '@/webview/views/SessionBanner';
import { createStore } from '@/webview/state/Store';
import { StoreContext } from '@/webview/views/StoreContext';

afterEach(cleanup);

function renderBanner() {
  const store = createStore(initialState, update, () => undefined);
  const send = (action: Action) => act(() => store.dispatch(action));
  const { container } = render(
    <StoreContext value={store}>
      <SessionBanner />
    </StoreContext>,
  );
  const part = (selector: string) => {
    const found = container.querySelector<HTMLElement>(selector);
    if (!found) {
      throw new Error(`nothing matches ${selector}`);
    }
    return found;
  };
  const connect = (session: Partial<SessionSnapshot> = {}) =>
    send({
      type: 'state',
      activeSessionId: 's1',
      session: { sessionId: 's1', agentName: 'OpenCode', cwd: '/work/project', pickers: [], commands: [], ...session },
    });
  return { send, connect, part };
}

describe('session banner', () => {
  it('is hidden and empty without a session', () => {
    const { part } = renderBanner();

    expect(part('.session-banner').classList.contains('visible')).toBe(false);
    expect(part('.agent').textContent).toBe('');
    expect(part('.cwd').textContent).toBe('');
    expect(part('.status').childElementCount).toBe(0);
  });

  it("shows the session's name and working directory once connected", () => {
    const { connect, part } = renderBanner();

    connect({ title: 'Fix the build' });

    expect(part('.session-banner').classList.contains('visible')).toBe(true);
    expect(part('.agent').textContent).toBe('Fix the build');
    expect(part('.cwd').textContent).toBe('/work/project');
  });

  it('shows a spinner only while a turn runs', () => {
    const { connect, send, part } = renderBanner();
    connect();

    send({ type: 'promptStart' });
    expect(part('.status .spinner')).toBeTruthy();

    send({ type: 'promptEnd' });
    expect(part('.status').childElementCount).toBe(0);
  });

  it('hides and empties again on disconnect', () => {
    const { connect, send, part } = renderBanner();
    connect();
    send({ type: 'promptStart' });

    send({ type: 'state', activeSessionId: null, session: null });

    expect(part('.session-banner').classList.contains('visible')).toBe(false);
    expect(part('.agent').textContent).toBe('');
    expect(part('.status').childElementCount).toBe(0);
  });
});
