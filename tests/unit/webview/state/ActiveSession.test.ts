import { describe, expect, it } from 'vitest';
import type { SessionSnapshot, SlashCommand } from '@/shared/WebviewMessages';
import { canPrompt, sessionName, type ActiveSession } from '@/webview/state/ActiveSession';
import { initialState, update, type Action } from '@/webview/state/RootState';
import { createStore } from '@/webview/state/Store';

function snapshot(session: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: 's1',
    agentName: 'Fake Agent',
    cwd: '/work',
    pickers: [],
    commands: [],
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
const init: SlashCommand = { name: 'init', description: 'Initialize the project', takesInput: false, hint: null };

describe('the active session', () => {
  it('is none until the extension reports one', () => {
    expect(chatView().session()).toBeNull();
  });

  it('takes the agent, title, working directory and slash commands from the state message', () => {
    const view = chatView();

    view.connect({ agentName: 'OpenCode', title: 'Fix the build', cwd: '/work/project', commands: [init] });

    expect(view.session()).toEqual({
      sessionId: 's1',
      agentName: 'OpenCode',
      title: 'Fix the build',
      cwd: '/work/project',
      commands: [init],
      turnRunning: false,
      loading: false,
    });
  });

  it('has no title when the snapshot has none', () => {
    const view = chatView();

    view.connect();

    expect(view.session()?.title).toBeNull();
  });

  it('is none again after a disconnect, a cleared transcript or the end of the session', () => {
    const view = chatView();

    view.connect();
    view.send(disconnect);
    expect(view.session()).toBeNull();

    view.connect();
    view.send({ type: 'clearTranscript' });
    expect(view.session()).toBeNull();

    view.connect();
    view.send({ type: 'promptStart' }, { type: 'sessionEnded', message: 'Fake exited unexpectedly (code 1).' });
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
    const session: ActiveSession = {
      sessionId: 's1',
      agentName: 'OpenCode',
      title: 'Fix the build',
      cwd: '/w',
      commands: [],
      turnRunning: false,
      loading: false,
    };

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

    view.send({ type: 'promptEnd' });
    expect(view.session()?.turnRunning).toBe(false);
  });

  it('starts as soon as the user sends a prompt, before the extension reports it', () => {
    const view = chatView();
    view.connect();

    view.send({ type: 'promptEdited', text: 'hello' }, { type: 'promptSent' });

    expect(view.session()?.turnRunning).toBe(true);
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

describe('slash commands', () => {
  it('are replaced by the commands the extension sends', () => {
    const view = chatView();
    view.connect({ commands: [init] });
    const review: SlashCommand = { name: 'review', description: 'Review changes', takesInput: true, hint: 'what to review' };

    view.send({ type: 'commands', commands: [review] });

    expect(view.session()?.commands).toEqual([review]);
  });

  it('are left alone by other messages, and ignored without a session', () => {
    const view = chatView();
    view.send({ type: 'commands', commands: [init] });
    expect(view.session()).toBeNull();

    view.connect({ commands: [init] });
    const before = view.session();
    view.send({ type: 'pickers', pickers: [] }, { type: 'agentText', messageId: null, text: 'hi' });
    expect(view.session()).toBe(before);
  });
});

describe('loading', () => {
  it('runs from loadSessionStart to loadSessionEnd, and prompting waits for it', () => {
    const view = chatView();
    view.connect();
    expect(canPrompt(view.session())).toBe(true);

    view.send({ type: 'loadSessionStart' });
    expect(view.session()?.loading).toBe(true);
    expect(canPrompt(view.session())).toBe(false);

    view.send({ type: 'loadSessionEnd', ok: true });
    expect(view.session()?.loading).toBe(false);
    expect(canPrompt(view.session())).toBe(true);
  });

  it('continues when the same session is reported again, but not into a different one', () => {
    const view = chatView();
    view.connect({ sessionId: 's1' });
    view.send({ type: 'loadSessionStart' });

    view.connect({ sessionId: 's1' });
    expect(view.session()?.loading).toBe(true);

    view.connect({ sessionId: 's2' });
    expect(view.session()?.loading).toBe(false);
  });

  it('cannot prompt without a session', () => {
    expect(canPrompt(null)).toBe(false);
  });
});

describe('what the store is told', () => {
  it('notifies no one of actions that change nothing', () => {
    const view = chatView();
    view.connect();
    const before = view.session();
    const notified = view.notified();

    view.send(
      { type: 'promptEnd' },
      { type: 'file-attached', path: '/work/a.ts', name: 'a.ts' },
      { type: 'pickersClosed' },
    );

    expect(view.session()).toBe(before);
    expect(view.notified()).toBe(notified);
  });
});
