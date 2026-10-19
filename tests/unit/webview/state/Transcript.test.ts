import type { AvailableCommand, SessionUpdate } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import type { SessionSnapshot, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import { initialState, update, type Action } from '@/webview/state/RootState';
import { createStore } from '@/webview/state/Store';
import {
  contentTexts,
  planEntryIcon,
  showsWelcome,
  shownContent,
  statusClass,
  statusGlyph,
  thoughtSummary,
  TOOL_CALL_CONTENT_LIMIT,
  turnShown,
  type Turn,
} from '@/webview/state/Transcript';

const init: AvailableCommand = { name: 'init', description: 'Initialize the project' };
const review: AvailableCommand = { name: 'review', description: 'Review changes', input: { hint: 'What to review' } };

type SessionUpdateKind = SessionUpdate['sessionUpdate'];

function chatView() {
  const posted: WebviewToExtensionMessage[] = [];
  let time = 0;
  const store = createStore(
    initialState,
    update,
    (message: WebviewToExtensionMessage) => posted.push(message),
    () => time,
  );
  const transcript = () => store.getSnapshot().transcript;
  const turns = () => transcript().entries.filter((entry): entry is Turn => entry.kind === 'turn');
  const lastTurn = (): Turn => {
    const turn = turns().at(-1);
    if (!turn) {
      throw new Error('no turn in the transcript');
    }
    return turn;
  };
  return {
    transcript,
    turns,
    lastTurn,
    /** Each entry as `kind: text`, the way a reader would summarize the transcript. */
    summary: () =>
      transcript().entries.map((entry) => {
        switch (entry.kind) {
          case 'turn':
            return `turn: ${entry.message.text}`;
          case 'plan':
            return `plan: ${entry.entries.map((planEntry) => planEntry.content).join(', ')}`;
          default:
            return `${entry.kind}: ${entry.text}`;
        }
      }),
    welcome: () => showsWelcome(transcript(), store.getSnapshot().activeSession),
    at: (now: number) => {
      time = now;
    },
    send: (...actions: Action[]) => actions.forEach((action) => store.dispatch(action)),
    connect: (session: Partial<SessionSnapshot> = {}) => {
      const full = { sessionId: 's1', agentName: 'Fake', cwd: '/work', modes: null, configOptions: null, availableCommands: [init, review], ...session };
      store.dispatch({ type: 'state', activeSessionId: full.sessionId, session: full });
    },
    update: <K extends SessionUpdateKind>(sessionUpdate: K, fields: Omit<Extract<SessionUpdate, { sessionUpdate: K }>, 'sessionUpdate'>) =>
      store.dispatch({ type: 'sessionUpdate', sessionId: 's1', update: { sessionUpdate, ...fields } as SessionUpdate }),
    prompt: (text: string) => {
      store.dispatch({ type: 'promptEdited', text });
      store.dispatch({ type: 'promptSent' });
    },
    takePosted: () => posted.splice(0),
  };
}

const text = (value: string) => ({ content: { type: 'text' as const, text: value } });
const textContent = (value: string) => ({ type: 'content' as const, content: { type: 'text' as const, text: value } });

describe('the transcript and its session', () => {
  it('leaves room for the welcome card only without a session and an empty transcript', () => {
    const view = chatView();
    expect(view.welcome()).toBe(true);

    view.send({ type: 'error', message: 'boom' });
    expect(view.welcome()).toBe(false);

    view.connect();
    expect(view.summary()).toEqual([]);
    expect(view.welcome()).toBe(false);
  });

  it('keeps the transcript for the same session and clears it for another', () => {
    const view = chatView();
    view.connect({ sessionId: 's1' });
    view.prompt('hello');

    view.connect({ sessionId: 's1', title: 'Renamed' });
    expect(view.summary()).toEqual(['prompt: hello']);

    view.connect({ sessionId: 's2' });
    expect(view.summary()).toEqual([]);
  });

  it('clears the transcript on disconnect and on clearTranscript', () => {
    const view = chatView();
    for (const end of [
      { type: 'state', activeSessionId: null, session: null },
      { type: 'clearTranscript' },
    ] as const) {
      view.connect();
      view.prompt('hello');

      view.send(end);

      expect(view.summary()).toEqual([]);
      expect(view.welcome()).toBe(true);
    }
  });

  it('leaves only the welcome card after a state without a session, even when none was connected', () => {
    const view = chatView();
    view.send({ type: 'error', message: 'boom' });

    view.send({ type: 'state', activeSessionId: null, session: null });

    expect(view.summary()).toEqual([]);
    expect(view.welcome()).toBe(true);
  });

  it('changes nothing when an empty transcript is cleared again', () => {
    const view = chatView();
    const before = view.transcript();

    view.send({ type: 'clearTranscript' }, { type: 'state', activeSessionId: null, session: null });

    expect(view.transcript()).toBe(before);
  });

  it('never reuses an entry ID, so a late rendering of a cleared message lands nowhere', () => {
    const view = chatView();
    view.connect({ sessionId: 's1' });
    view.send({ type: 'promptStart' });
    view.update('agent_message_chunk', text('old'));
    view.send({ type: 'promptEnd', stopReason: 'end_turn' });
    const oldId = view.lastTurn().id;

    view.connect({ sessionId: 's2' });
    view.send({ type: 'promptStart' });
    view.update('agent_message_chunk', text('new'));
    view.send({ type: 'markdownRendered', items: [{ id: oldId, html: '<p>old</p>' }] });

    expect(view.lastTurn().id).not.toBe(oldId);
    expect(view.lastTurn().message.html).toBeNull();
  });
});

describe('prompts', () => {
  it('shows exactly the prompt the prompt box sent', () => {
    const view = chatView();
    view.connect();

    view.prompt('  hello  ');
    view.prompt('   ');

    expect(view.summary()).toEqual(['prompt: hello']);
  });

  it('shows nothing when the prompt box cannot send', () => {
    const view = chatView();
    view.prompt('hello');
    view.connect();
    view.send({ type: 'loadSessionStart' });
    view.prompt('hello');

    expect(view.summary()).toEqual([]);
  });

  it('shows a slash command sent on choosing it, but not one that waits for input', () => {
    const view = chatView();
    view.connect();

    view.send({ type: 'slashCommandChosen', name: 'review' }, { type: 'slashCommandChosen', name: 'init' });

    expect(view.summary()).toEqual(['prompt: /init']);
  });

  it('places a mid-turn prompt below the running turn, which keeps growing', () => {
    const view = chatView();
    view.connect();
    view.prompt('first');
    view.send({ type: 'promptStart' });
    view.update('agent_message_chunk', text('working'));

    view.prompt('also this');
    view.update('agent_message_chunk', text(' still'));

    expect(view.summary()).toEqual(['prompt: first', 'turn: working still', 'prompt: also this']);
  });
});

describe('agent messages', () => {
  it('collects the chunks of a turn into one message, and starts a turn per prompt', () => {
    const view = chatView();
    view.connect();
    for (const answer of ['hello ', 'world']) {
      view.update('agent_message_chunk', text(answer));
    }
    view.send({ type: 'promptStart' });
    view.update('agent_message_chunk', text('again'));

    expect(view.summary()).toEqual(['turn: hello world', 'turn: again']);
  });

  it('draws a turn only once it has more than whitespace', () => {
    const view = chatView();
    view.connect();
    view.update('agent_message_chunk', text('\n  '));
    expect(turnShown(view.lastTurn())).toBe(false);

    view.update('agent_message_chunk', text('hi'));
    expect(turnShown(view.lastTurn())).toBe(true);
    expect(view.lastTurn().message.text).toBe('\n  hi');
  });

  it('ignores chunks without text', () => {
    const view = chatView();
    view.connect();

    view.update('agent_message_chunk', text(''));
    view.update('agent_message_chunk', { content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } });

    expect(view.summary()).toEqual([]);
  });

  it('asks for markdown at the end of a turn and applies what comes back', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'promptStart' });
    view.update('agent_message_chunk', text('**bold**'));
    view.takePosted();

    view.send({ type: 'promptEnd', stopReason: 'end_turn' });
    const { id } = view.lastTurn();
    expect(view.takePosted()).toEqual([{ type: 'renderMarkdown', items: [{ id, text: '**bold**' }] }]);

    view.send({ type: 'markdownRendered', items: [{ id, html: '<p><b>bold</b></p>' }] });
    expect(view.lastTurn().message).toEqual({ text: '**bold**', html: '<p><b>bold</b></p>' });
  });

  it('asks for no markdown when the turn showed no answer', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'promptStart' }, { type: 'promptEnd', stopReason: 'end_turn' });
    view.send({ type: 'promptStart' });
    view.update('agent_message_chunk', text('  '));
    view.send({ type: 'promptEnd', stopReason: 'end_turn' });

    expect(view.takePosted()).toEqual([]);
  });

  it('ignores rendered markdown for an entry that is not a turn', () => {
    const view = chatView();
    view.connect();
    view.prompt('hello');
    const before = view.transcript();
    const promptId = before.entries[0]!.id;

    view.send({ type: 'markdownRendered', items: [{ id: promptId, html: '<p>x</p>' }] });

    expect(view.transcript()).toBe(before);
  });
});

describe('thoughts', () => {
  it('streams into an open thought, which closes with its duration once the answer starts', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'promptStart' });
    view.at(10_000);
    view.update('agent_thought_chunk', text('let me '));
    view.at(11_000);
    view.update('agent_thought_chunk', text('think'));
    expect(view.lastTurn().thought).toEqual({ text: 'let me think', startedAt: 10_000, endedAt: null, open: true });

    view.at(13_000);
    view.update('agent_message_chunk', text('answer'));

    const thought = view.lastTurn().thought!;
    expect(thought).toEqual({ text: 'let me think', startedAt: 10_000, endedAt: 13_000, open: false });
    expect(thoughtSummary(thought)).toBe('Thought for 3s');
  });

  it('finishes a thought without an answer at the end of the turn', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'promptStart' });
    view.at(1_000);
    view.update('agent_thought_chunk', text('hmm'));
    view.at(1_400);

    view.send({ type: 'promptEnd', stopReason: 'end_turn' });

    const thought = view.lastTurn().thought!;
    expect(thought.endedAt).toBe(1_400);
    expect(thought.open).toBe(true);
    expect(thoughtSummary(thought)).toBe('Thought');
  });

  it('leaves the thought as the user set it while the answer streams', () => {
    const view = chatView();
    view.connect();
    view.update('agent_thought_chunk', text('hmm'));
    view.update('agent_message_chunk', text('answer'));
    const turnId = view.lastTurn().id;

    view.send({ type: 'thoughtToggled', turnId, open: true });
    view.update('agent_message_chunk', text(' continues'));

    expect(view.lastTurn().thought?.open).toBe(true);
  });

  it('keeps the time the thought ended when more of it arrives', () => {
    const view = chatView();
    view.connect();
    view.at(1_000);
    view.update('agent_thought_chunk', text('a'));
    view.at(2_000);
    view.update('agent_message_chunk', text('answer'));
    view.at(9_000);
    view.update('agent_thought_chunk', text('b'));
    view.send({ type: 'promptEnd', stopReason: 'end_turn' });

    expect(view.lastTurn().thought).toMatchObject({ text: 'ab', endedAt: 2_000 });
  });

  it('changes nothing when a toggle matches the thought, or the turn has none', () => {
    const view = chatView();
    view.connect();
    view.update('agent_thought_chunk', text('hmm'));
    view.send({ type: 'promptStart' });
    view.update('agent_message_chunk', text('no thought here'));
    const [thinking, answering] = view.turns();
    const before = view.transcript();

    view.send({ type: 'thoughtToggled', turnId: thinking!.id, open: true });
    view.send({ type: 'thoughtToggled', turnId: answering!.id, open: false });

    expect(view.transcript()).toBe(before);
  });

  it('ignores thought chunks without text', () => {
    const view = chatView();
    view.connect();

    view.update('agent_thought_chunk', { content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } });

    expect(view.summary()).toEqual([]);
  });
});

describe('tool calls', () => {
  it('adds a tool call to the current turn as pending unless the agent says otherwise', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'promptStart' });

    view.update('tool_call', { toolCallId: 't1', title: 'Read', content: [textContent('body')] });

    expect(view.lastTurn().toolCalls).toEqual([{ toolCallId: 't1', title: 'Read', status: 'pending', texts: ['body'], open: false }]);
  });

  it('opens a tool call that fails, whether from the start or by an update, and only when it becomes failed', () => {
    const view = chatView();
    view.connect();
    view.update('tool_call', { toolCallId: 'early', title: 'A', status: 'failed' });
    view.update('tool_call', { toolCallId: 'late', title: 'B', status: 'in_progress' });
    const turnId = view.lastTurn().id;

    view.update('tool_call_update', { toolCallId: 'late', status: 'failed' });
    expect(view.lastTurn().toolCalls.map((call) => call.open)).toEqual([true, true]);

    view.send({ type: 'toolCallToggled', turnId, toolCallId: 'late', open: false });
    view.update('tool_call_update', { toolCallId: 'late', status: 'failed', title: 'B again' });
    expect(view.lastTurn().toolCalls[1]).toMatchObject({ title: 'B again', open: false });
  });

  it('keeps what an update leaves out', () => {
    const view = chatView();
    view.connect();
    view.update('tool_call', { toolCallId: 't1', title: 'Run', status: 'in_progress', content: [textContent('out')] });

    view.update('tool_call_update', { toolCallId: 't1' });
    view.update('tool_call_update', { toolCallId: 't1', title: '', status: null, content: null });

    expect(view.lastTurn().toolCalls[0]).toMatchObject({ title: 'Run', status: 'in_progress', texts: ['out'] });
  });

  it('replaces the content and the title an update carries', () => {
    const view = chatView();
    view.connect();
    view.update('tool_call', { toolCallId: 't1', title: 'Edit', content: [textContent('old')] });

    view.update('tool_call_update', { toolCallId: 't1', title: 'Edit foo.ts', content: [textContent('new')] });

    expect(view.lastTurn().toolCalls[0]).toMatchObject({ title: 'Edit foo.ts', texts: ['new'] });
  });

  it('revises a tool call the agent reports again, wherever it is', () => {
    const view = chatView();
    view.connect();
    view.update('tool_call', { toolCallId: 't1', title: 'Read', status: 'pending' });
    view.send({ type: 'promptEnd', stopReason: 'end_turn' }, { type: 'promptStart' });
    view.update('agent_message_chunk', text('next turn'));

    view.update('tool_call', { toolCallId: 't1', title: 'Read foo.ts', status: 'completed' });
    view.update('tool_call_update', { toolCallId: 't1', content: [textContent('body')] });

    const [first, second] = view.turns();
    expect(first!.toolCalls).toEqual([{ toolCallId: 't1', title: 'Read foo.ts', status: 'completed', texts: ['body'], open: false }]);
    expect(second!.toolCalls).toEqual([]);
  });

  it('ignores an update for a tool call it never saw', () => {
    const view = chatView();
    view.connect();
    view.update('tool_call', { toolCallId: 't1', title: 'Read' });
    const before = view.transcript();

    view.update('tool_call_update', { toolCallId: 'unknown', status: 'completed' });
    view.send({ type: 'toolCallToggled', turnId: view.lastTurn().id, toolCallId: 'unknown', open: true });
    view.send({ type: 'toolCallToggled', turnId: view.lastTurn().id, toolCallId: 't1', open: false });

    expect(view.transcript()).toBe(before);
  });

  it('collapses more than three tool calls when the turn ends, which the user can undo', () => {
    const view = chatView();
    view.connect();
    for (const count of [3, 4]) {
      view.send({ type: 'promptStart' });
      for (let index = 0; index < count; index++) {
        view.update('tool_call', { toolCallId: `${count}-${index}`, title: 'Read', status: 'completed' });
      }
      view.send({ type: 'promptEnd', stopReason: 'end_turn' });
    }
    expect(view.turns().map((turn) => turn.toolCallsCollapsed)).toEqual([false, true]);

    view.send({ type: 'toolCallsToggled', turnId: view.lastTurn().id });
    expect(view.lastTurn().toolCallsCollapsed).toBe(false);
  });

  it('keeps a short list the user collapsed collapsed when the turn ends', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'promptStart' });
    view.update('tool_call', { toolCallId: 't1', title: 'Read' });

    view.send({ type: 'toolCallsToggled', turnId: view.lastTurn().id }, { type: 'promptEnd', stopReason: 'end_turn' });

    expect(view.lastTurn().toolCallsCollapsed).toBe(true);
  });
});

describe('plans', () => {
  it("replaces the turn's plan with each update, and starts another in the next turn", () => {
    const view = chatView();
    view.connect();
    view.update('plan', { entries: [{ content: 'a', status: 'pending', priority: 'high' }] });
    view.update('plan', { entries: [{ content: 'a', status: 'completed', priority: 'high' }, { content: 'b', status: 'pending', priority: 'low' }] });
    expect(view.summary()).toEqual(['plan: a, b']);

    view.send({ type: 'promptStart' });
    view.update('plan', { entries: [{ content: 'c', status: 'pending', priority: 'low' }] });

    expect(view.summary()).toEqual(['plan: a, b', 'plan: c']);
  });

  it('starts another plan when the one it would replace was cleared', () => {
    const view = chatView();
    view.connect();
    view.update('plan', { entries: [{ content: 'a', status: 'pending', priority: 'high' }] });
    view.send({ type: 'loadSessionStart' });

    view.update('plan', { entries: [{ content: 'b', status: 'pending', priority: 'high' }] });

    expect(view.summary()).toEqual(['plan: b']);
  });
});

describe('loading a session', () => {
  it('splits the replay into turns at each prompt and joins the chunks of one prompt', () => {
    const view = chatView();
    view.connect();
    view.prompt('before the load');
    view.send({ type: 'loadSessionStart' });

    view.update('user_message_chunk', text('he'));
    view.update('user_message_chunk', text('llo'));
    view.update('agent_message_chunk', text('a1'));
    view.update('user_message_chunk', text('q2'));
    view.update('agent_message_chunk', text('a2'));

    expect(view.summary()).toEqual(['prompt: hello', 'turn: a1', 'prompt: q2', 'turn: a2']);
  });

  it('ignores replayed prompt chunks without text', () => {
    const view = chatView();
    view.connect();
    view.update('agent_message_chunk', text('answer'));
    const before = view.transcript();

    view.update('user_message_chunk', { content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } });

    expect(view.transcript()).toBe(before);
  });

  it('ends each replayed turn as a live one ends', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'loadSessionStart' });
    for (const prompt of ['q1', 'q2']) {
      view.update('user_message_chunk', text(prompt));
      view.update('agent_thought_chunk', text('hmm'));
      for (const id of ['1', '2', '3', '4']) {
        view.update('tool_call', { toolCallId: `${prompt}-${id}`, title: id, status: 'completed' });
      }
    }
    view.send({ type: 'loadSessionEnd', ok: true });

    expect(view.turns().map((turn) => [turn.toolCallsCollapsed, turn.thought?.endedAt !== null])).toEqual([
      [true, true],
      [true, true],
    ]);
  });

  it('asks for the markdown of every replayed answer in one batch when the load ends', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'loadSessionStart' });
    view.update('user_message_chunk', text('q1'));
    view.update('agent_message_chunk', text('a1'));
    view.update('user_message_chunk', text('q2'));
    view.update('tool_call', { toolCallId: 't1', title: 'Read' });
    view.update('user_message_chunk', text('q3'));
    view.update('agent_message_chunk', text('a3'));
    view.takePosted();

    view.send({ type: 'loadSessionEnd', ok: true });

    const [first, , third] = view.turns();
    expect(view.takePosted()).toEqual([
      {
        type: 'renderMarkdown',
        items: [
          { id: first!.id, text: 'a1' },
          { id: third!.id, text: 'a3' },
        ],
      },
    ]);
  });

  it('reports a failed load in the transcript', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'loadSessionStart' }, { type: 'loadSessionEnd', ok: false });

    expect(view.summary()).toEqual(['error: Failed to load session.']);
  });
});

describe('errors and the welcome card', () => {
  it('shows extension errors, with a fallback for an empty one', () => {
    const view = chatView();
    view.send({ type: 'error', message: 'boom' }, { type: 'error', message: '' });

    expect(view.summary()).toEqual(['error: boom', 'error: An error occurred']);
  });

  it("runs the welcome card's commands", () => {
    const view = chatView();

    view.send({ type: 'welcomeCommandChosen', command: 'acp.connectAgent' }, { type: 'welcomeCommandChosen', command: 'acp.addAgent' });

    expect(view.takePosted()).toEqual([
      { type: 'executeCommand', command: 'acp.connectAgent' },
      { type: 'executeCommand', command: 'acp.addAgent' },
    ]);
  });
});

describe('what is shown', () => {
  it('keeps the text of content blocks, skipping other content and empty text', () => {
    expect(
      contentTexts([
        textContent('first'),
        { type: 'diff', path: '/work/a.ts', oldText: 'a', newText: 'b' },
        { type: 'terminal', terminalId: 'term-1' },
        { type: 'content', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } },
        textContent(''),
        textContent('second'),
      ]),
    ).toEqual(['first', 'second']);
  });

  it('truncates tool call content past the limit, across blocks', () => {
    const half = 'a'.repeat(TOOL_CALL_CONTENT_LIMIT / 2);

    expect(shownContent([half, half])).toEqual({ blocks: [half, half], truncated: false });
    expect(shownContent([half, `${half}b`])).toEqual({ blocks: [half, half], truncated: true });
    expect(shownContent([half, half, 'c'])).toEqual({ blocks: [half, half], truncated: true });
  });

  it('marks each tool call status with a glyph and a class', () => {
    const statuses = ['pending', 'in_progress', 'completed', 'failed'] as const;

    expect(statuses.map((status) => `${statusClass(status)} ${statusGlyph(status)}`)).toEqual([
      'pending …',
      'running ⟳',
      'completed ✓',
      'failed ✗',
    ]);
  });

  it('marks each plan entry status with an icon', () => {
    expect((['pending', 'in_progress', 'completed'] as const).map(planEntryIcon)).toEqual(['⬜', '🔄', '✅']);
  });

  it('rounds the thought duration to whole seconds', () => {
    expect(thoughtSummary({ text: '', startedAt: 0, endedAt: 2_500, open: false })).toBe('Thought for 3s');
    expect(thoughtSummary({ text: '', startedAt: 0, endedAt: 499, open: false })).toBe('Thought');
    expect(thoughtSummary({ text: '', startedAt: 0, endedAt: null, open: true })).toBe('Thought');
  });
});
