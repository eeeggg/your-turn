import type { AvailableCommand } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import type { SessionSnapshot, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import { highlightedIndex, matchingCommands, placeholder, type PromptBoxState } from '@/webview/PromptBox';
import { initialState, update, type Action } from '@/webview/RootState';
import { createStore } from '@/webview/Store';

const init: AvailableCommand = { name: 'init', description: 'Initialize the project' };
const review: AvailableCommand = { name: 'review', description: 'Review changes', input: { hint: 'What to review' } };
const reset: AvailableCommand = { name: 'Reset', description: 'Start over' };

function chatView() {
  const posted: WebviewToExtensionMessage[] = [];
  const store = createStore(initialState, update, (message: WebviewToExtensionMessage) => posted.push(message));
  let notified = 0;
  store.subscribe(() => notified++);
  return {
    box: (): PromptBoxState => store.getSnapshot().promptBox,
    session: () => store.getSnapshot().activeSession,
    matches: () => matchingCommands(store.getSnapshot().promptBox, store.getSnapshot().activeSession).map((command) => command.name),
    highlighted: () => {
      const { promptBox, activeSession } = store.getSnapshot();
      return highlightedIndex(promptBox, matchingCommands(promptBox, activeSession));
    },
    send: (...actions: Action[]) => actions.forEach((action) => store.dispatch(action)),
    type: (text: string) => store.dispatch({ type: 'promptEdited', text }),
    connect: (session: Partial<SessionSnapshot> = {}) =>
      store.dispatch({
        type: 'state',
        activeSessionId: 's1',
        session: { sessionId: 's1', agentName: 'Fake', cwd: '/work', modes: null, configOptions: null, availableCommands: [init, review, reset], ...session },
      }),
    takePosted: () => posted.splice(0),
    notified: () => notified,
  };
}

describe('sending', () => {
  it('sends the trimmed text and empties the box', () => {
    const view = chatView();
    view.connect();
    view.type('  hello  ');

    view.send({ type: 'promptSent' });

    expect(view.takePosted()).toEqual([{ type: 'sendPrompt', text: 'hello' }]);
    expect(view.box().text).toBe('');
  });

  it('sends nothing for blank text', () => {
    const view = chatView();
    view.connect();
    view.type(' \n ');

    view.send({ type: 'promptSent' });

    expect(view.takePosted()).toEqual([]);
    expect(view.box().text).toBe(' \n ');
  });

  it('sends nothing, and keeps the text, without a session or while one loads', () => {
    const view = chatView();
    view.type('hello');
    view.send({ type: 'promptSent' });
    expect(view.takePosted()).toEqual([]);

    view.connect();
    view.send({ type: 'loadSessionStart' }, { type: 'promptSent' });
    expect(view.takePosted()).toEqual([]);
    expect(view.box().text).toBe('hello');
  });

  it('keeps the text across a disconnect', () => {
    const view = chatView();
    view.connect();
    view.type('draft');

    view.send({ type: 'state', activeSessionId: null, session: null });

    expect(view.box().text).toBe('draft');
  });

  it('asks the extension to cancel the turn', () => {
    const view = chatView();
    view.connect();

    view.send({ type: 'turnCancelled' });

    expect(view.takePosted()).toEqual([{ type: 'cancelTurn' }]);
  });
});

describe('the slash command popup', () => {
  it('lists the commands whose names start with what follows the slash, ignoring case', () => {
    const view = chatView();
    view.connect();

    view.type('/');
    expect(view.matches()).toEqual(['init', 'review', 'Reset']);

    view.type('/re');
    expect(view.matches()).toEqual(['review', 'Reset']);
  });

  it('is closed for text without a leading slash, once a space follows the name, and when nothing matches', () => {
    const view = chatView();
    view.connect();

    for (const text of ['', 'hello /init', '/review x', '/zzz']) {
      view.type(text);
      expect(view.matches()).toEqual([]);
    }
  });

  it('is closed without a session, while one loads, or when the agent has no commands', () => {
    const view = chatView();
    view.type('/');
    expect(view.matches()).toEqual([]);

    view.connect();
    view.send({ type: 'loadSessionStart' });
    expect(view.matches()).toEqual([]);

    view.connect({ sessionId: 's2', availableCommands: [] });
    expect(view.matches()).toEqual([]);
  });

  it('closes on dismissal until the text is edited again', () => {
    const view = chatView();
    view.connect();
    view.type('/');

    view.send({ type: 'slashPopupDismissed' });
    expect(view.matches()).toEqual([]);

    view.type('/r');
    expect(view.matches()).toEqual(['review', 'Reset']);
  });

  it('moves the highlight within the matches and starts again at the top after an edit', () => {
    const view = chatView();
    view.connect();
    view.type('/');
    expect(view.highlighted()).toBe(0);

    view.send({ type: 'slashHighlightMoved', by: -1 });
    expect(view.highlighted()).toBe(0);

    view.send({ type: 'slashHighlightMoved', by: 1 }, { type: 'slashHighlightMoved', by: 1 });
    expect(view.highlighted()).toBe(2);
    const atBottom = view.box();
    view.send({ type: 'slashHighlightMoved', by: 1 });
    expect(view.box()).toBe(atBottom);

    view.type('/r');
    expect(view.highlighted()).toBe(0);
  });

  it('highlights the item under the pointer', () => {
    const view = chatView();
    view.connect();
    view.type('/');

    view.send({ type: 'slashCommandHighlighted', index: 1 });

    expect(view.highlighted()).toBe(1);
  });

  it('keeps the highlight on a match when the agent replaces its commands under the popup', () => {
    const view = chatView();
    view.connect();
    view.type('/');
    view.send({ type: 'slashCommandHighlighted', index: 2 });

    view.send({ type: 'sessionUpdate', sessionId: 's1', update: { sessionUpdate: 'available_commands_update', availableCommands: [init] } });
    expect(view.highlighted()).toBe(0);

    view.send({ type: 'slashHighlightMoved', by: 1 });
    expect(view.highlighted()).toBe(0);
  });

  it('ignores moving the highlight while closed', () => {
    const view = chatView();
    view.connect();
    const before = view.box();

    view.send({ type: 'slashHighlightMoved', by: 1 });

    expect(view.box()).toBe(before);
  });
});

describe('choosing a slash command', () => {
  it('sends a command without input at once', () => {
    const view = chatView();
    view.connect();
    view.type('/in');

    view.send({ type: 'slashCommandChosen', name: 'init' });

    expect(view.takePosted()).toEqual([{ type: 'sendPrompt', text: '/init' }]);
    expect(view.box().text).toBe('');
  });

  it('inserts a command that takes input, closing the popup', () => {
    const view = chatView();
    view.connect();
    view.type('/re');

    view.send({ type: 'slashCommandChosen', name: 'review' });

    expect(view.takePosted()).toEqual([]);
    expect(view.box().text).toBe('/review ');
    expect(view.matches()).toEqual([]);
  });

  it('ignores a command the agent does not have', () => {
    const view = chatView();
    view.connect();
    view.type('/');
    const before = view.box();

    view.send({ type: 'slashCommandChosen', name: 'gone' });

    expect(view.box()).toBe(before);
    expect(view.takePosted()).toEqual([]);
  });
});

describe('the placeholder', () => {
  it('mentions slash commands only when the session has some', () => {
    const view = chatView();
    expect(placeholder(view.session())).toBe('Type a message...');

    view.connect({ availableCommands: [] });
    expect(placeholder(view.session())).toBe('Type a message...');

    view.connect();
    expect(placeholder(view.session())).toBe('Type a message or / for commands...');
  });
});

describe('what the store is told', () => {
  it('notifies no one of actions that change nothing in the prompt box', () => {
    const view = chatView();
    view.connect();
    view.type('/');
    view.send({ type: 'slashPopupDismissed' });
    const notified = view.notified();

    view.send(
      { type: 'slashPopupDismissed' },
      { type: 'slashCommandHighlighted', index: 0 },
      { type: 'markdownRendered', items: [{ id: 999, html: '<p>none</p>' }] },
    );

    expect(view.notified()).toBe(notified);
  });
});