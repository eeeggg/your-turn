import { describe, expect, it } from 'vitest';
import type { SessionSnapshot, SlashCommand } from '@/shared/WebviewMessages';
import { canPrompt, sessionName, type ActiveSession } from '@/webview/state/ActiveSession';
import { initialState, update, type Action } from '@/webview/state/RootState';
import { createStore } from '@/webview/state/Store';
const SESSION_ID = 'b8513b93-c484-46fc-8eab-b1bb03c9eca5';
const OTHER_SESSION_ID = '854a90a1-fb88-463c-a67f-365281cc3ae0';

function snapshot(session: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: SESSION_ID,
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
    connect: (session: Partial<SessionSnapshot> = {}) => {
      store.dispatch({ type: 'state', activeSessionId: session.sessionId ?? SESSION_ID, session: snapshot(session) });
      store.dispatch({ type: 'contentSnapshot', queue: [], composer: { text: '', revision: 0 }, target: { configuredName: session.agentName ?? 'Fake Agent', sessionId: session.sessionId ?? SESSION_ID, generation: 1, projection: 1 },
        revision: 0, entries: [], currentTurn: null, nextId: 1, usage: null, terminals: [] });
    },
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
      sessionId: SESSION_ID,
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
      sessionId: SESSION_ID,
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
    view.connect({ sessionId: SESSION_ID });
    view.send({ type: 'promptStart' });

    view.connect({ sessionId: OTHER_SESSION_ID });

    expect(view.session()).toMatchObject({ sessionId: OTHER_SESSION_ID, turnRunning: false });
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
    view.send({ type: 'pickers', pickers: [] }, { type: 'contentPatch', target: { configuredName: 'Fake Agent', sessionId: SESSION_ID, generation: 1, projection: 1 }, base: 0, revision: 1, currentTurn: 1, nextId: 2, usage: null,
      patches: [{ kind: 'insert', index: 0, entries: [{ kind: 'turn', id: 1, parts: [{ kind: 'message', messageId: null, text: 'hi' }] }] }] });
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
    view.connect({ sessionId: SESSION_ID });
    view.send({ type: 'loadSessionStart' });

    view.connect({ sessionId: SESSION_ID });
    expect(view.session()?.loading).toBe(true);

    view.connect({ sessionId: OTHER_SESSION_ID });
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
      { type: 'pickersClosed' },
    );

    expect(view.session()).toBe(before);
    expect(view.notified()).toBe(notified);
  });
});
