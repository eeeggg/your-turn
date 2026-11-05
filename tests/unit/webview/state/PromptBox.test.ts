import { describe, expect, it } from 'vitest';
import type { SessionSnapshot, SlashCommand, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import {
  highlightedIndex,
  matchingCommands,
  placeholder,
  type PromptBoxState
} from '@/webview/state/PromptBox';
import { initialState, update, type Action } from '@/webview/state/RootState';
import { createStore } from '@/webview/state/Store';

const init: SlashCommand = { name: 'init', description: 'Initialize the project', takesInput: false, hint: null };
const review: SlashCommand = { name: 'review', description: 'Review changes', takesInput: true, hint: 'What to review' };
const reset: SlashCommand = { name: 'Reset', description: 'Start over', takesInput: false, hint: null };

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
        session: { sessionId: 's1', agentName: 'Fake', cwd: '/work', pickers: [], commands: [init, review, reset], ...session },
      }),
    /** Each prompt sent and its turn ended, so it is in the session's history. */
    sent: (...texts: string[]) =>
      texts.forEach((text) => {
        store.dispatch({ type: 'promptEdited', text });
        store.dispatch({ type: 'promptSent' });
        store.dispatch({ type: 'promptEnd' });
      }),
    older: () => store.dispatch({ type: 'historyMoved', to: 'older' }),
    newer: () => store.dispatch({ type: 'historyMoved', to: 'newer' }),
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

    view.connect({ sessionId: 's2', commands: [] });
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

    view.send({ type: 'commands', commands: [init] });
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

describe('the prompt history', () => {
  it('recalls older prompts from an empty box with the caret at the start, stopping at the oldest, and sends nothing', () => {
    const view = chatView();
    view.connect();
    view.sent('q1', 'q2', 'q3');
    view.takePosted();

    view.older();
    expect([view.box().text, view.box().recall?.caret]).toEqual(['q3', 'start']);
    view.older();
    view.older();
    expect([view.box().text, view.box().recall?.caret]).toEqual(['q1', 'start']);
    const oldest = view.box();
    view.older();

    expect(view.box()).toBe(oldest);
    expect(view.takePosted()).toEqual([]);
  });

  it('recalls newer prompts with the caret at the end, then leaves the history for an empty box', () => {
    const view = chatView();
    view.connect();
    view.sent('q1', 'q2', 'q3');
    view.older();
    view.older();
    view.older();

    view.newer();
    expect([view.box().text, view.box().recall?.caret]).toEqual(['q2', 'end']);
    view.newer();
    expect(view.box().text).toBe('q3');
    view.newer();
    expect([view.box().text, view.box().recall]).toEqual(['', null]);
    const left = view.box();
    view.newer();

    expect(view.box()).toBe(left);
  });

  it('keeps a draft that differs from the latest prompt, but recalls from one that matches it', () => {
    const view = chatView();
    view.connect();
    view.sent('q1', 'q2');
    view.type('draft');
    const drafted = view.box();

    view.older();
    expect(view.box()).toBe(drafted);

    view.type('q2');
    view.older();
    view.older();
    expect(view.box().text).toBe('q1');
  });

  it('keeps an edited recall from either move until it is cleared, then moves on from where it was', () => {
    const view = chatView();
    view.connect();
    view.sent('q1', 'q2', 'q3');
    view.older();
    view.older();
    view.type('q2, edited');
    const edited = view.box();

    view.older();
    view.newer();
    expect(view.box()).toBe(edited);

    view.type('');
    view.older();
    expect(view.box().text).toBe('q1');
  });

  it('starts again from the newest after sending a recalled prompt', () => {
    const view = chatView();
    view.connect();
    view.sent('q1', 'q2');
    view.older();
    view.older();

    view.send({ type: 'promptSent' }, { type: 'promptEnd' });
    expect(view.takePosted()).toContainEqual({ type: 'sendPrompt', text: 'q1' });
    view.older();
    view.older();

    expect(view.box().text).toBe('q2');
  });

  it('stops browsing in another session or none, and once the transcript is cleared, keeping the text', () => {
    const leavings: Action[] = [
      { type: 'state', activeSessionId: 's2', session: { sessionId: 's2', agentName: 'Fake', cwd: '/work', pickers: [], commands: [] } },
      { type: 'state', activeSessionId: null, session: null },
      { type: 'clearTranscript' },
    ];
    const after = leavings.map((leaving) => {
      const view = chatView();
      view.connect();
      view.sent('q1', 'q2');
      view.older();

      view.send(leaving);

      return [view.box().text, view.box().recall];
    });

    expect(after).toEqual(leavings.map(() => ['q2', null]));
  });

  it('starts again from the newest of a loaded history', () => {
    const view = chatView();
    view.connect();
    view.sent('q1', 'q2');
    view.older();
    view.older();

    view.send(
      { type: 'loadSessionStart' },
      { type: 'promptText', messageId: 'u1', text: 'l1' },
      { type: 'promptText', messageId: 'u2', text: 'l2' },
      { type: 'loadSessionEnd', ok: true },
    );
    view.type('');
    view.older();
    expect(view.box().text).toBe('l2');
  });

  it('recalls nothing while a load replays the history', () => {
    const view = chatView();
    view.connect();
    view.sent('q1');
    view.send({ type: 'loadSessionStart' }, { type: 'promptText', messageId: null, text: 'l1' });
    const loading = view.box();

    view.older();

    expect(view.box()).toBe(loading);
  });

  it('shows a recalled slash command with the popup dismissed, which an edit reopens', () => {
    const view = chatView();
    view.connect();
    view.sent('/re');

    view.older();
    expect(view.matches()).toEqual([]);

    view.type('/re');
    expect(view.matches()).toEqual(['review', 'Reset']);
  });

  it('announces the place of each recall, and the empty box on leaving, until the text is edited', () => {
    const view = chatView();
    view.connect();
    view.sent('q1', 'q2', 'q3');

    view.older();
    expect(view.box().announcement).toBe('Prompt 3 of 3');
    view.older();
    expect(view.box().announcement).toBe('Prompt 2 of 3');
    view.newer();
    view.newer();
    expect(view.box().announcement).toBe('Empty prompt');

    view.older();
    view.type('q3!');
    expect(view.box().announcement).toBe('');
  });
});

describe('the placeholder', () => {
  it('mentions slash commands only when the session has some', () => {
    const view = chatView();
    expect(placeholder(view.session())).toBe('Type a message...');

    view.connect({ commands: [] });
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
    );

    expect(view.notified()).toBe(notified);
  });
});
