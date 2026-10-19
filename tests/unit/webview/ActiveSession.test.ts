import { describe, expect, it } from 'vitest';
import type { SessionSnapshot } from '@/shared/WebviewMessages';
import { sessionName, type ActiveSession } from '@/webview/ActiveSession';
import { initialState, update, type Action } from '@/webview/RootState';
import { createStore } from '@/webview/Store';

function snapshot(session: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: 's1',
    agentName: 'Fake Agent',
    cwd: '/work',
    modes: null,
    configOptions: null,
    availableCommands: [],
    ...session,
  };
}

function chatView() {
  const store = createStore(initialState, update, () => undefined);
  let notified = 0;
  store.subscribe(() => notified++);
  return {
    session: (): ActiveSession | null => store.getSnapshot().activeSession,
    send: (...actions: Action[]) => actions.forEach((action) => store.dispatch(action)),
    connect: (session: Partial<SessionSnapshot> = {}) =>
      store.dispatch({ type: 'state', activeSessionId: session.sessionId ?? 's1', session: snapshot(session) }),
    notified: () => notified,
  };
}

const disconnect: Action = { type: 'state', activeSessionId: null, session: null };

describe('the active session', () => {
  it('is none until the extension reports one', () => {
    expect(chatView().session()).toBeNull();
  });

  it('takes the agent, title and working directory from the state message', () => {
    const view = chatView();

    view.connect({ agentName: 'OpenCode', title: 'Fix the build', cwd: '/work/project' });

    expect(view.session()).toEqual({
      sessionId: 's1',
      agentName: 'OpenCode',
      title: 'Fix the build',
      cwd: '/work/project',
      turnRunning: false,
    });
  });

  it('has no title when the snapshot has none', () => {
    const view = chatView();

    view.connect();

    expect(view.session()?.title).toBeNull();
  });

  it('is none again after a disconnect or a cleared transcript', () => {
    const view = chatView();

    view.connect();
    view.send(disconnect);
    expect(view.session()).toBeNull();

    view.connect();
    view.send({ type: 'clearTranscript' });
    expect(view.session()).toBeNull();
  });
});

describe('the title', () => {
  it('follows sessionInfoUpdate, and null clears it', () => {
    const view = chatView();
    view.connect({ title: 'Old' });

    view.send({ type: 'sessionInfoUpdate', title: 'New' });
    expect(view.session()?.title).toBe('New');

    view.send({ type: 'sessionInfoUpdate', title: null });
    expect(view.session()?.title).toBeNull();
  });

  it('is ignored without a session', () => {
    const view = chatView();

    view.send({ type: 'sessionInfoUpdate', title: 'New' });

    expect(view.session()).toBeNull();
  });

  it('names the session by its title, else by its agent', () => {
    const session: ActiveSession = { sessionId: 's1', agentName: 'OpenCode', title: 'Fix the build', cwd: '/w', turnRunning: false };

    expect(sessionName(session)).toBe('Fix the build');
    expect(sessionName({ ...session, title: null })).toBe('OpenCode');
    expect(sessionName({ ...session, title: '' })).toBe('OpenCode');
  });
});

describe('whether a turn is running', () => {
  it('runs from promptStart to promptEnd', () => {
    const view = chatView();
    view.connect();

    view.send({ type: 'promptStart' });
    expect(view.session()?.turnRunning).toBe(true);

    view.send({ type: 'promptEnd', stopReason: 'end_turn' });
    expect(view.session()?.turnRunning).toBe(false);
  });

  it('stops when a load starts', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'promptStart' });

    view.send({ type: 'loadSessionStart' });

    expect(view.session()?.turnRunning).toBe(false);
  });

  it('keeps running when the same session is reported again, which updates its details', () => {
    const view = chatView();
    view.connect({ title: 'Old' });
    view.send({ type: 'promptStart' });

    view.connect({ title: 'New', cwd: '/elsewhere' });

    expect(view.session()).toMatchObject({ title: 'New', cwd: '/elsewhere', turnRunning: true });
  });

  it('does not carry over to a different session', () => {
    const view = chatView();
    view.connect({ sessionId: 's1' });
    view.send({ type: 'promptStart' });

    view.connect({ sessionId: 's2' });

    expect(view.session()).toMatchObject({ sessionId: 's2', turnRunning: false });
  });

  it('does not start without a session', () => {
    const view = chatView();

    view.send({ type: 'promptStart' });

    expect(view.session()).toBeNull();
  });
});

describe('what the store is told', () => {
  it('notifies no one of actions that change nothing', () => {
    const view = chatView();
    view.connect();
    const before = view.session();
    const notified = view.notified();

    view.send({ type: 'promptEnd', stopReason: 'end_turn' }, { type: 'error', message: 'boom' }, { type: 'pickersClosed' });

    expect(view.session()).toBe(before);
    expect(view.notified()).toBe(notified);
  });
});
