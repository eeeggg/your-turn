import { assert, describe, expect, it } from 'vitest';
import type {
  DiffFile,
  ExtensionToWebviewMessage,
  PlanStep,
  SessionSnapshot,
  SlashCommand,
  ToolCallContent,
  WebviewToExtensionMessage,
} from '@/shared/WebviewMessages';
import { initialState, update, type Action } from '@/webview/state/RootState';
import { createStore } from '@/webview/state/Store';
import {
  planStepIcon,
  promptHistory,
  showsEmptyState,
  shownContent,
  statusGlyph,
  thoughtSummary,
  TOOL_CALL_CONTENT_LIMIT,
  turnShown,
  type ContentContext,
  type Turn,
  type TurnPart,
} from '@/webview/state/Transcript';

const init: SlashCommand = { name: 'init', description: 'Initialize the project', takesInput: false, hint: null };
const review: SlashCommand = { name: 'review', description: 'Review changes', takesInput: true, hint: 'What to review' };

type ToolCallReport = Omit<Extract<ExtensionToWebviewMessage, { type: 'toolCall' }>, 'type' | 'toolCallId'>;

const texts = (...items: string[]): ToolCallContent[] => items.map((text) => ({ kind: 'text', text }));
/** A file as the extension sends it, added with one line. */
const addedFile = (path: string): DiffFile => ({
  operation: 'add',
  path,
  oldPath: null,
  added: 1,
  removed: 0,
  hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+a'] }],
  note: null,
  opens: 'fileAndChanges',
});
const diff: ToolCallContent = { kind: 'diff', files: [addedFile('a.ts')] };
/** Content shown in a session with no terminals, still going. */
const inSession = (): ContentContext => ({ terminals: new Map(), sessionEnded: false });

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
  const partsOf = <K extends TurnPart['kind']>(kind: K) => lastTurn().parts.filter((part): part is Extract<TurnPart, { kind: K }> => part.kind === kind);
  return {
    transcript,
    turns,
    lastTurn,
    thoughts: () => partsOf('thought'),
    groups: () => partsOf('toolCalls'),
    toolCalls: () => partsOf('toolCalls').flatMap((group) => group.toolCalls),
    /** Each entry as `kind: text`, and a turn as its parts in order, the way a reader would summarize the transcript. */
    summary: () =>
      transcript().entries.map((entry) => (entry.kind === 'turn' ? `turn: ${entry.parts.map(partSummary).join(' | ')}` : `${entry.kind}: ${entry.text}`)),
    emptyState: () => showsEmptyState(transcript(), store.getSnapshot().activeSession),
    at: (now: number) => {
      time = now;
    },
    store,
    send: (...actions: Action[]) => actions.forEach((action) => store.dispatch(action)),
    connect: (session: Partial<SessionSnapshot> = {}) => {
      const full = { sessionId: 's1', agentName: 'Fake', cwd: '/work', pickers: [], commands: [init, review], ...session };
      store.dispatch({ type: 'state', activeSessionId: full.sessionId, session: full });
    },
    answer: (text: string, messageId: string | null = null) => store.dispatch({ type: 'agentText', messageId, text }),
    thought: (text: string, messageId: string | null = null) => store.dispatch({ type: 'thoughtText', messageId, text }),
    replayed: (text: string, messageId: string | null = null) => store.dispatch({ type: 'promptText', messageId, text }),
    wholeAnswer: (text: string, messageId: string) => store.dispatch({ type: 'agentMessage', messageId, text }),
    wholeThought: (text: string, messageId: string) => store.dispatch({ type: 'thoughtMessage', messageId, text }),
    wholePrompt: (text: string, messageId: string) => store.dispatch({ type: 'promptMessage', messageId, text }),
    toolCall: (toolCallId: string, report: ToolCallReport = {}) => store.dispatch({ type: 'toolCall', toolCallId, ...report }),
    plan: (...steps: PlanStep[]) => store.dispatch({ type: 'plan', steps }),
    prompt: (text: string) => {
      store.dispatch({ type: 'promptEdited', text });
      store.dispatch({ type: 'promptSent' });
    },
    takePosted: () => posted.splice(0),
  };
}

function partSummary(part: TurnPart): string {
  switch (part.kind) {
    case 'message':
      return part.text;
    case 'thought':
      return `thought ${part.text}`;
    case 'toolCalls':
      return `tools ${part.toolCalls.map((call) => call.toolCallId).join(', ')}`;
    case 'plan':
      return `plan ${part.steps.map((step) => step.text).join(', ')}`;
  }
}

const promptEnd: Action = { type: 'promptEnd' };
const queuedPrompts = (count: number): WebviewToExtensionMessage => ({ type: 'queuedPrompts', count });

describe('the transcript and its session', () => {
  it('leaves room for the empty state only without a session and an empty transcript', () => {
    const view = chatView();
    expect(view.emptyState()).toBe(true);

    view.send({ type: 'error', message: 'boom' });
    expect(view.emptyState()).toBe(false);

    view.connect();
    expect(view.summary()).toEqual([]);
    expect(view.emptyState()).toBe(false);
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
      expect(view.emptyState()).toBe(true);
    }
  });

  it('leaves only the empty state after a state without a session, even when none was connected', () => {
    const view = chatView();
    view.send({ type: 'error', message: 'boom' });

    view.send({ type: 'state', activeSessionId: null, session: null });

    expect(view.summary()).toEqual([]);
    expect(view.emptyState()).toBe(true);
  });

  it('changes nothing when an empty transcript is cleared again', () => {
    const view = chatView();
    const before = view.transcript();

    view.send({ type: 'clearTranscript' }, { type: 'state', activeSessionId: null, session: null });

    expect(view.transcript()).toBe(before);
  });

  it('never reuses an entry ID after clearing the transcript', () => {
    const view = chatView();
    view.connect({ sessionId: 's1' });
    view.send({ type: 'promptStart' });
    view.answer('old');
    view.send(promptEnd);
    const oldId = view.lastTurn().id;

    view.connect({ sessionId: 's2' });
    view.send({ type: 'promptStart' });
    view.answer('new');

    expect(view.lastTurn().id).not.toBe(oldId);
  });
});

describe('a session whose agent exited', () => {
  const ended: Action = { type: 'sessionEnded', message: 'Fake exited unexpectedly (code 1).' };
  const noSession: Action = { type: 'state', activeSessionId: null, session: null };

  function midTurn() {
    const view = chatView();
    view.connect();
    view.prompt('first');
    view.send({ type: 'promptStart' });
    view.answer('working');
    view.prompt('second');
    view.takePosted();
    return view;
  }

  it('keeps the conversation and ends it with why, sending no queued prompt', () => {
    const view = midTurn();

    view.send(ended, noSession);

    expect(view.summary()).toEqual(['prompt: first', 'turn: working', 'error: Fake exited unexpectedly (code 1).']);
    expect(view.transcript().currentTurn).toBeNull();
    expect(view.transcript().queued).toEqual([]);
    expect(view.takePosted()).toEqual([queuedPrompts(0)]);
    expect(view.store.getSnapshot().activeSession).toBeNull();
    expect(view.emptyState()).toBe(false);
  });

  it('sends nothing when a late promptEnd arrives', () => {
    const view = midTurn();
    view.send(ended, noSession);
    view.takePosted();

    view.send(promptEnd);

    expect(view.takePosted()).toEqual([]);
  });

  it('belongs to its session again when it is reopened, so a disconnect then clears it', () => {
    const view = midTurn();
    view.send(ended, noSession);

    view.connect();
    expect(view.summary()).toHaveLength(3);

    view.send(noSession);
    expect(view.summary()).toEqual([]);
  });

  it('gives way to the next session', () => {
    const view = midTurn();
    view.send(ended, noSession);

    view.connect({ sessionId: 's2' });
    view.send(noSession);

    expect(view.summary()).toEqual([]);
    expect(view.emptyState()).toBe(true);
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

});

describe('the queue', () => {
  it('holds a prompt sent during a turn instead of sending it, out of the transcript while the turn grows', () => {
    const view = chatView();
    view.connect();
    view.prompt('first');
    view.send({ type: 'promptStart' });
    view.answer('working');
    view.takePosted();

    view.prompt('also this');
    view.answer(' still');

    expect(view.takePosted()).toEqual([queuedPrompts(1)]);
    expect(view.transcript().queued).toEqual(['also this']);
    expect(view.summary()).toEqual(['prompt: first', 'turn: working still']);
  });

  it('holds a second prompt sent before the extension reports that the first one started', () => {
    const view = chatView();
    view.connect();

    view.prompt('first');
    view.prompt('second');

    expect(view.takePosted()).toEqual([{ type: 'sendPrompt', text: 'first' }, queuedPrompts(1)]);
    expect(view.transcript().queued).toEqual(['second']);
  });

  it('sends the top prompt when the turn ends, below that turn, and the next one only when its turn ends', () => {
    const view = chatView();
    view.connect();
    view.prompt('first');
    view.send({ type: 'promptStart' });
    view.answer('one');
    view.prompt('second');
    view.prompt('third');
    view.takePosted();

    view.send(promptEnd);
    expect(view.takePosted()).toEqual([{ type: 'sendPrompt', text: 'second' }, queuedPrompts(1)]);
    expect(view.transcript().queued).toEqual(['third']);
    expect(view.store.getSnapshot().activeSession?.turnRunning).toBe(true);

    view.send({ type: 'promptStart' });
    view.answer('two');
    view.send(promptEnd);
    expect(view.takePosted()).toEqual([{ type: 'sendPrompt', text: 'third' }, queuedPrompts(0)]);
    expect(view.transcript().queued).toEqual([]);

    view.send({ type: 'promptStart' }, promptEnd);
    expect(view.takePosted()).toEqual([]);
    expect(view.summary()).toEqual(['prompt: first', 'turn: one', 'prompt: second', 'turn: two', 'prompt: third']);
  });

  it('sends the top prompt now by cancelling the turn, as often as the user asks, so it goes out when the turn ends', () => {
    const view = chatView();
    view.connect();
    view.prompt('first');
    view.prompt('second');
    view.prompt('third');
    view.takePosted();
    const before = view.transcript().followRequests;

    view.send({ type: 'sendNowChosen' }, { type: 'sendNowChosen' });

    expect(view.takePosted()).toEqual([{ type: 'cancelTurn' }, { type: 'cancelTurn' }]);
    expect(view.transcript().queued).toEqual(['second', 'third']);
    expect(view.transcript().followRequests).toBe(before + 2);

    view.send(promptEnd);
    expect(view.takePosted()).toEqual([{ type: 'sendPrompt', text: 'second' }, queuedPrompts(1)]);
  });

  it('does not cancel the turn to send now when nothing is queued', () => {
    const view = chatView();
    view.connect();
    view.prompt('first');
    view.takePosted();

    view.send({ type: 'sendNowChosen' });

    expect(view.takePosted()).toEqual([]);
  });

  it('drops the queue when the transcript is cleared', () => {
    type View = ReturnType<typeof chatView>;
    const clears: [string, (view: View) => void][] = [
      ['another session', (view) => view.connect({ sessionId: 's2' })],
      ['a disconnect', (view) => view.send({ type: 'state', activeSessionId: null, session: null })],
      ['a load', (view) => view.send({ type: 'loadSessionStart' })],
      ['clearTranscript', (view) => view.send({ type: 'clearTranscript' })],
    ];
    for (const [name, clear] of clears) {
      const view = chatView();
      view.connect();
      view.prompt('first');
      view.prompt('second');
      view.takePosted();

      clear(view);
      view.send(promptEnd);

      expect(view.transcript().queued, name).toEqual([]);
      expect(view.takePosted(), name).toEqual([queuedPrompts(0)]);
    }
  });

  it('tells the extension how many prompts are queued each time that changes, so a switch can say what it discards', () => {
    const view = chatView();
    view.connect();
    view.prompt('first');
    view.prompt('second');
    view.prompt('third');
    expect(view.takePosted()).toEqual([{ type: 'sendPrompt', text: 'first' }, queuedPrompts(1), queuedPrompts(2)]);

    view.answer('working');
    expect(view.takePosted()).toEqual([]);

    view.send({ type: 'promptStart' }, promptEnd);
    expect(view.takePosted()).toEqual([{ type: 'sendPrompt', text: 'second' }, queuedPrompts(1)]);
  });
});

describe('agent messages', () => {
  it('collects the text of a turn into one message, and starts a turn per prompt', () => {
    const view = chatView();
    view.connect();
    for (const answer of ['hello ', 'world']) {
      view.answer(answer);
    }
    view.send({ type: 'promptStart' });
    view.answer('again');

    expect(view.summary()).toEqual(['turn: hello world', 'turn: again']);
  });

  it('draws a turn only once it has more than whitespace', () => {
    const view = chatView();
    view.connect();
    view.answer('\n  ');
    expect(turnShown(view.lastTurn())).toBe(false);

    view.answer('hi');
    expect(turnShown(view.lastTurn())).toBe(true);
    expect(view.lastTurn().parts).toEqual([{ kind: 'message', messageId: null, text: '\n  hi' }]);
  });

  it('starts another message after a tool call, the plan or a thought, and when the message ID changes', () => {
    const view = chatView();
    view.connect();

    view.answer('one', 'm1');
    view.answer(' and');
    view.answer(' more', 'm1');
    view.answer('two', 'm2');
    view.toolCall('t1', { title: 'Read' });
    view.answer('three', 'm2');
    view.plan({ text: 'a', status: 'pending' });
    view.answer('four');
    view.thought('hmm');
    view.answer('five');

    expect(view.summary()).toEqual(['turn: one and more | two | tools t1 | three | plan a | four | thought hmm | five']);
  });

  it('gives the latest message with the ID its whole text, in whichever turn, and adds a message for an ID it has not seen', () => {
    const view = chatView();
    view.connect();
    view.answer('one', 'm1');
    view.toolCall('t1');
    view.answer('draft', 'm1');
    view.send(promptEnd);
    view.answer('two', 'm2');

    view.wholeAnswer('final', 'm1');
    view.wholeAnswer('three', 'm3');
    view.answer(' more', 'm3');

    expect(view.summary()).toEqual(['turn: one | tools t1 | final', 'turn: two | three more']);
  });

  it('clears the text of a message given none, and adds nothing for an ID it has not seen', () => {
    const view = chatView();
    view.connect();
    view.answer('oops', 'm1');
    const before = view.transcript().entries;

    view.wholeAnswer('', 'm1');
    view.wholeAnswer('', 'm2');
    view.wholeThought('', 'r1');

    expect(view.lastTurn().parts).toEqual([{ kind: 'message', messageId: 'm1', text: '' }]);
    expect(turnShown(view.lastTurn())).toBe(false);
    expect(view.transcript().entries).toHaveLength(before.length);
  });

  it('keeps the text of the answer and asks the extension for nothing when the turn ends', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'promptStart' });
    view.answer('**bold**');
    view.takePosted();

    view.send(promptEnd);

    expect(view.takePosted()).toEqual([]);
    expect(view.summary()).toEqual(['turn: **bold**']);
  });

  it('is the current turn from its first text until the prompt ends', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'promptStart' });
    expect(view.transcript().currentTurn).toBeNull();

    view.answer('answer');
    expect(view.transcript().currentTurn).toBe(view.lastTurn().id);

    view.send(promptEnd);
    expect(view.transcript().currentTurn).toBeNull();
  });
});

describe('thoughts', () => {
  it('streams into an open thought, which closes with its duration once the answer starts', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'promptStart' });
    view.at(10_000);
    view.thought('let me ');
    view.at(11_000);
    view.thought('think');
    expect(view.thoughts()).toEqual([{ kind: 'thought', messageId: null, text: 'let me think', startedAt: 10_000, endedAt: null, open: true }]);

    view.at(13_000);
    view.answer('\n');
    expect(view.thoughts()[0]).toMatchObject({ endedAt: null, open: true });
    view.answer('answer');

    const [thought] = view.thoughts();
    expect(thought).toMatchObject({ text: 'let me think', startedAt: 10_000, endedAt: 13_000, open: false });
    assert.exists(thought);
    expect(thoughtSummary(thought)).toBe('Thought for 3s');
  });

  it('finishes and closes a thought when a tool call, the plan or another thought follows it', () => {
    const view = chatView();
    view.connect();
    view.at(1_000);
    view.thought('a', 'r1');
    view.at(2_000);
    view.thought('b', 'r2');
    view.at(3_000);
    view.toolCall('t1', { title: 'Read' });
    view.thought('c');
    view.at(4_000);
    view.plan();

    expect(view.thoughts().map(({ text, endedAt, open }) => ({ text, endedAt, open }))).toEqual([
      { text: 'a', endedAt: 2_000, open: false },
      { text: 'b', endedAt: 3_000, open: false },
      { text: 'c', endedAt: 4_000, open: false },
    ]);
  });

  it('finishes a thought without an answer at the end of the turn', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'promptStart' });
    view.at(1_000);
    view.thought('hmm');
    view.at(1_400);

    view.send(promptEnd);

    const [thought] = view.thoughts();
    expect(thought).toMatchObject({ endedAt: 1_400, open: true });
    assert.exists(thought);
    expect(thoughtSummary(thought)).toBe('Thought');
  });

  it('leaves a thought as the user set it while the answer streams', () => {
    const view = chatView();
    view.connect();
    view.thought('hmm');
    view.answer('answer');

    view.send({ type: 'thoughtToggled', turnId: view.lastTurn().id, part: 0, open: true });
    view.answer(' continues');

    expect(view.thoughts()[0]?.open).toBe(true);
  });

  it('makes thinking after the answer a thought of its own, below it', () => {
    const view = chatView();
    view.connect();
    view.at(1_000);
    view.thought('a');
    view.at(2_000);
    view.answer('answer');
    view.at(9_000);
    view.thought('b');
    view.at(10_000);
    view.send(promptEnd);

    expect(view.summary()).toEqual(['turn: thought a | answer | thought b']);
    expect(view.thoughts().map(({ startedAt, endedAt }) => [startedAt, endedAt])).toEqual([
      [1_000, 2_000],
      [9_000, 10_000],
    ]);
  });

  it('gives a thought its whole text where it is, keeping its time and how the user set it, and starts one for an ID it has not seen', () => {
    const view = chatView();
    view.connect();
    view.at(1_000);
    view.thought('a', 'r1');
    view.at(2_000);
    view.answer('answer', 'm1');
    view.send({ type: 'thoughtToggled', turnId: view.lastTurn().id, part: 0, open: true });
    view.at(3_000);

    view.wholeThought('all of a', 'r1');
    view.wholeThought('b', 'r2');

    expect(view.thoughts().map(({ messageId, text, startedAt, endedAt, open }) => ({ messageId, text, startedAt, endedAt, open }))).toEqual([
      { messageId: 'r1', text: 'all of a', startedAt: 1_000, endedAt: 2_000, open: true },
      { messageId: 'r2', text: 'b', startedAt: 3_000, endedAt: null, open: true },
    ]);
  });

  it('changes nothing when a toggle matches the thought, or names a part that is not a thought', () => {
    const view = chatView();
    view.connect();
    view.thought('hmm');
    view.answer('answer');
    const turnId = view.lastTurn().id;
    const before = view.transcript();

    view.send({ type: 'thoughtToggled', turnId, part: 0, open: false });
    view.send({ type: 'thoughtToggled', turnId, part: 1, open: true });
    view.send({ type: 'thoughtToggled', turnId, part: 2, open: true });

    expect(view.transcript()).toBe(before);
  });
});

describe('tool calls', () => {
  it('adds a tool call to the current turn as pending unless the agent says otherwise', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'promptStart' });

    view.toolCall('t1', { title: 'Read', content: texts('body') });

    expect(view.toolCalls()).toEqual([{ toolCallId: 't1', title: 'Read', status: 'pending', content: texts('body'), open: false }]);
  });

  it("keeps a tool call's diffs where they were reported among its texts", () => {
    const view = chatView();
    view.connect();

    view.toolCall('t1', { title: 'Edit', content: [...texts('before'), diff, ...texts('after')] });

    expect(view.toolCalls()[0]?.content).toEqual([...texts('before'), diff, ...texts('after')]);
  });

  it('groups tool calls reported one after another, and starts another group after anything else', () => {
    const view = chatView();
    view.connect();

    view.toolCall('t1', { title: 'Read' });
    view.toolCall('t2', { title: 'Read' });
    view.answer('found it');
    view.toolCall('t3', { title: 'Edit' });

    expect(view.summary()).toEqual(['turn: tools t1, t2 | found it | tools t3']);
  });

  it('opens a tool call that fails, whether from the start or by an update, and only when it becomes failed', () => {
    const view = chatView();
    view.connect();
    view.toolCall('early', { title: 'A', status: 'failed' });
    view.toolCall('late', { title: 'B', status: 'running' });
    const turnId = view.lastTurn().id;

    view.toolCall('late', { status: 'failed' });
    expect(view.toolCalls().map((call) => call.open)).toEqual([true, true]);

    view.send({ type: 'toolCallToggled', turnId, toolCallId: 'late', open: false });
    view.toolCall('late', { status: 'failed', title: 'B again' });
    expect(view.toolCalls()[1]).toMatchObject({ title: 'B again', open: false });
  });

  it('keeps what a report leaves out', () => {
    const view = chatView();
    view.connect();
    view.toolCall('t1', { title: 'Run', status: 'running', content: texts('out') });

    view.toolCall('t1');

    expect(view.toolCalls()[0]).toMatchObject({ title: 'Run', status: 'running', content: texts('out') });
  });

  it('replaces the text and the title a report carries', () => {
    const view = chatView();
    view.connect();
    view.toolCall('t1', { title: 'Edit', content: [...texts('old'), diff] });

    view.toolCall('t1', { title: 'Edit foo.ts', content: texts('new') });

    expect(view.toolCalls()[0]).toMatchObject({ title: 'Edit foo.ts', content: texts('new') });
  });

  it('revises a tool call the agent reports again, wherever it is', () => {
    const view = chatView();
    view.connect();
    view.toolCall('t0', { title: 'List' });
    view.answer('then');
    view.toolCall('t1', { title: 'Read', status: 'pending' });
    view.send(promptEnd, { type: 'promptStart' });
    view.answer('next turn');

    view.toolCall('t1', { title: 'Read foo.ts', status: 'completed' });
    view.toolCall('t1', { content: texts('body') });

    expect(view.summary()).toEqual(['turn: tools t0 | then | tools t1', 'turn: next turn']);
    const first = view.turns()[0];
    assert.exists(first);
    expect(first.parts[2]).toEqual({
      kind: 'toolCalls',
      toolCalls: [{ toolCallId: 't1', title: 'Read foo.ts', status: 'completed', content: texts('body'), open: false }],
      collapsed: false,
    });
  });

  it('shows a tool call first reported without a title, and takes the title once the agent gives one', () => {
    const view = chatView();
    view.connect();

    view.toolCall('t1', { status: 'running' });
    expect(view.toolCalls()).toEqual([{ toolCallId: 't1', title: '', status: 'running', content: [], open: false }]);

    view.toolCall('t1', { title: 'Read foo.ts' });
    expect(view.toolCalls()[0]?.title).toBe('Read foo.ts');
  });

  it('changes nothing when a toggle names a tool call it never saw, or matches the tool call', () => {
    const view = chatView();
    view.connect();
    view.toolCall('t1', { title: 'Read' });
    const before = view.transcript();

    view.send({ type: 'toolCallToggled', turnId: view.lastTurn().id, toolCallId: 'unknown', open: true });
    view.send({ type: 'toolCallToggled', turnId: view.lastTurn().id, toolCallId: 't1', open: false });

    expect(view.transcript()).toBe(before);
  });

  it('collapses each group of more than three tool calls when the turn ends, which the user can undo', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'promptStart' });
    for (const count of [3, 4]) {
      for (let index = 0; index < count; index++) {
        view.toolCall(`${count}-${index}`, { title: 'Read', status: 'completed' });
      }
      view.answer(`after ${count}`);
    }
    expect(view.groups().map((group) => group.collapsed)).toEqual([false, false]);

    view.send(promptEnd);
    expect(view.groups().map((group) => group.collapsed)).toEqual([false, true]);

    view.send({ type: 'toolCallsToggled', turnId: view.lastTurn().id, part: 2 });
    expect(view.groups().map((group) => group.collapsed)).toEqual([false, false]);
  });

  it('keeps a short group the user collapsed collapsed when the turn ends', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'promptStart' });
    view.toolCall('t1', { title: 'Read' });

    view.send({ type: 'toolCallsToggled', turnId: view.lastTurn().id, part: 0 }, promptEnd);

    expect(view.groups()[0]?.collapsed).toBe(true);
  });

  it('changes nothing when a group toggle names a part that is not a group', () => {
    const view = chatView();
    view.connect();
    view.answer('answer');
    const before = view.transcript();

    view.send({ type: 'toolCallsToggled', turnId: view.lastTurn().id, part: 0 }, { type: 'toolCallsToggled', turnId: view.lastTurn().id, part: 1 });

    expect(view.transcript()).toBe(before);
  });
});

describe("a tool call's files", () => {
  const edited: ToolCallContent = { kind: 'diff', files: [addedFile('a.ts')] };
  const twoFiles: ToolCallContent = {
    kind: 'diff',
    files: [{ ...addedFile('b.bin'), operation: 'delete', added: 0, hunks: [], note: 'binary', opens: 'file' }, addedFile('c.ts')],
  };

  it("asks the extension to open the file clicked, by its place across the tool call's diffs, changing nothing", () => {
    const view = chatView();
    view.connect();
    view.toolCall('t1', { title: 'Edit', content: [edited, ...texts('done'), twoFiles] });
    const before = view.transcript();

    view.send({ type: 'diffFileClicked', toolCallId: 't1', file: 2 });

    expect(view.takePosted()).toEqual([{ type: 'openFile', toolCallId: 't1', file: 2 }]);
    expect(view.transcript()).toBe(before);
  });

  it("gives each diff shown its first file's place across the tool call's diffs", () => {
    const { blocks } = shownContent([edited, ...texts('done'), twoFiles, edited], inSession(), true);

    expect(blocks.map((block) => (block.kind === 'diff' ? block.firstFile : block.text))).toEqual([0, 'done', 1, 3]);
  });
});

describe('plans', () => {
  it("replaces the turn's plan with each update where it was first reported, and starts another in the next turn", () => {
    const view = chatView();
    view.connect();
    view.plan({ text: 'a', status: 'pending' });
    view.answer('working');
    view.plan({ text: 'a', status: 'completed' }, { text: 'b', status: 'pending' });
    expect(view.summary()).toEqual(['turn: plan a, b | working']);

    view.send({ type: 'promptStart' });
    view.plan({ text: 'c', status: 'pending' });

    expect(view.summary()).toEqual(['turn: plan a, b | working', 'turn: plan c']);
  });

  it('starts another plan when the turn it was in was cleared', () => {
    const view = chatView();
    view.connect();
    view.plan({ text: 'a', status: 'pending' });
    view.send({ type: 'loadSessionStart' });

    view.plan({ text: 'b', status: 'pending' });

    expect(view.summary()).toEqual(['turn: plan b']);
  });
});

describe('loading a session', () => {
  it('splits the replay into turns at each prompt and joins the text of one prompt', () => {
    const view = chatView();
    view.connect();
    view.prompt('before the load');
    view.send({ type: 'loadSessionStart' });

    view.replayed('he');
    view.replayed('llo');
    view.answer('a1');
    view.replayed('q2');
    view.answer('a2');

    expect(view.summary()).toEqual(['prompt: hello', 'turn: a1', 'prompt: q2', 'turn: a2']);
  });

  it('gives a replayed prompt with an ID its whole text where it is, and starts another prompt for an ID it has not seen', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'loadSessionStart' });

    view.wholePrompt('Fix', 'u0');
    view.answer('a1');
    view.wholePrompt('Fix the build', 'u0');
    view.answer(' more');
    view.wholePrompt('q2', 'u1');
    view.replayed(' now');
    view.wholePrompt('q3', 'u2');
    view.answer('a3');

    expect(view.summary()).toEqual(['prompt: Fix the build', 'turn: a1 more', 'prompt: q2 now', 'prompt: q3', 'turn: a3']);
  });

  it('keeps replayed prompts with different IDs apart, with nothing between them, joining the text of each', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'loadSessionStart' });

    view.replayed('he', 'u1');
    view.replayed('llo', 'u1');
    view.replayed('q2', 'u2');
    view.replayed(' now', null);

    expect(view.summary()).toEqual(['prompt: hello', 'prompt: q2 now']);
  });

  it('adds nothing for an empty whole prompt it has not seen, leaving the chunks after it to replay the prompt', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'loadSessionStart' });

    view.wholePrompt('', 'u1');
    view.replayed('Hello', 'u1');
    view.wholeAnswer('', 'a1');
    view.answer('Hi!', 'a1');
    view.wholePrompt('', 'u2');
    view.wholePrompt('', 'u3');
    view.replayed('q3', 'u3');

    expect(view.summary()).toEqual(['prompt: Hello', 'turn: Hi!', 'prompt: q3']);
  });

  it('ends each replayed turn as a live one ends', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'loadSessionStart' });
    for (const prompt of ['q1', 'q2']) {
      view.replayed(prompt);
      for (const id of ['1', '2', '3', '4']) {
        view.toolCall(`${prompt}-${id}`, { title: id, status: 'completed' });
      }
      view.thought('hmm');
    }
    view.send({ type: 'loadSessionEnd', ok: true });

    expect(
      view.turns().map((turn) => turn.parts.map((part) => (part.kind === 'toolCalls' ? part.collapsed : part.kind === 'thought' && part.endedAt !== null))),
    ).toEqual([
      [true, true],
      [true, true],
    ]);
  });

  it('asks the extension for nothing when the load ends, and leaves no turn current', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'loadSessionStart' });
    view.replayed('q1');
    view.answer('a1');
    view.replayed('q2');
    view.answer('a2');
    view.takePosted();

    view.send({ type: 'loadSessionEnd', ok: true });

    expect(view.takePosted()).toEqual([]);
    expect(view.summary()).toEqual(['prompt: q1', 'turn: a1', 'prompt: q2', 'turn: a2']);
    expect(view.transcript().currentTurn).toBeNull();
  });

  it('reports a failed load in the transcript', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'loadSessionStart' }, { type: 'loadSessionEnd', ok: false });

    expect(view.summary()).toEqual(['error: Failed to load session.']);
  });
});

describe('the prompt history', () => {
  it('is the replayed prompts, each as last revised, then the prompts sent after the load, oldest first', () => {
    const view = chatView();
    view.connect();
    view.prompt('before the load');
    view.send(promptEnd, { type: 'loadSessionStart' });
    view.wholePrompt('Fix', 'u1');
    view.answer('a1');
    view.wholePrompt('Fix the build', 'u1');
    view.replayed('q', 'u2');
    view.replayed('2', 'u2');
    view.answer('a2');
    view.send({ type: 'loadSessionEnd', ok: true });

    view.prompt('q3');

    expect(promptHistory(view.transcript())).toEqual(['Fix the build', 'q2', 'q3']);
  });

  it('leaves out a replayed prompt with no more than whitespace', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'loadSessionStart' });
    view.replayed('q1', 'u1');
    view.replayed(' \n', 'u2');

    expect(promptHistory(view.transcript())).toEqual(['q1']);
  });

  it('takes in a queued prompt only once it is sent', () => {
    const view = chatView();
    view.connect();
    view.prompt('q1');
    view.prompt('q2');
    expect(promptHistory(view.transcript())).toEqual(['q1']);

    view.send(promptEnd);

    expect(promptHistory(view.transcript())).toEqual(['q1', 'q2']);
  });

  it('belongs to the session, empty once another replaces it', () => {
    const view = chatView();
    view.connect();
    view.prompt('q1');

    view.connect({ sessionId: 's2' });

    expect(promptHistory(view.transcript())).toEqual([]);
  });
});

describe('following the stream', () => {
  it('asks the view to follow for each prompt the user sends, mid-turn ones included, and not for one that cannot be sent', () => {
    const view = chatView();
    view.connect();
    const before = view.transcript().followRequests;

    view.prompt('first');
    view.send({ type: 'promptStart' });
    view.prompt('mid-turn');
    view.prompt('   ');
    view.send({ type: 'slashCommandChosen', name: 'init' });

    expect(view.transcript().followRequests).toBe(before + 3);
  });

  it('does not ask the view to follow when a queued prompt goes out by itself at the end of a turn', () => {
    const view = chatView();
    view.connect();
    view.prompt('first');
    view.prompt('queued');
    view.takePosted();
    const before = view.transcript().followRequests;

    view.send(promptEnd);

    expect(view.takePosted()).toContainEqual({ type: 'sendPrompt', text: 'queued' });
    expect(view.transcript().followRequests).toBe(before);
  });

  it('asks the view to follow each time the transcript is cleared', () => {
    const view = chatView();
    const clears: [string, () => void][] = [
      ['another session', () => view.connect({ sessionId: 's2' })],
      ['a disconnect', () => view.send({ type: 'state', activeSessionId: null, session: null })],
      ['a load', () => view.send({ type: 'loadSessionStart' })],
      ['clearTranscript', () => view.send({ type: 'clearTranscript' })],
    ];
    for (const [name, clear] of clears) {
      view.connect({ sessionId: 's1' });
      view.prompt('hello');
      const before = view.transcript().followRequests;

      clear();

      expect(view.transcript().followRequests, name).toBe(before + 1);
    }
  });

  it('does not ask the view to follow for what the agent sends, replayed prompts included, or for the same session again', () => {
    const view = chatView();
    view.connect();
    view.prompt('question');
    view.send({ type: 'promptStart' });
    const live = view.transcript().followRequests;

    view.answer('answer');
    view.toolCall('t1', { title: 'Read' });
    view.send(promptEnd);
    view.connect({ title: 'Renamed' });
    expect(view.transcript().followRequests).toBe(live);

    view.send({ type: 'loadSessionStart' });
    const loading = view.transcript().followRequests;
    view.replayed('q1');
    view.answer('a1');
    view.replayed('q2');
    view.send({ type: 'loadSessionEnd', ok: true });
    expect(view.transcript().followRequests).toBe(loading);
  });
});

describe('errors', () => {
  it('shows extension errors, with a fallback for an empty one', () => {
    const view = chatView();
    view.send({ type: 'error', message: 'boom' }, { type: 'error', message: '' });

    expect(view.summary()).toEqual(['error: boom', 'error: An error occurred']);
  });
});

describe('commands', () => {
  type TerminalReport = Omit<Extract<Action, { type: 'terminal' }>, 'type' | 'terminalId'>;
  const running: TerminalReport = { text: 'building', truncated: false, exitStatus: null };
  const terminalIn = (terminalId: string): ToolCallContent[] => [{ kind: 'terminal', terminalId }];

  /** The command blocks a tool call shows, in the session's context. */
  function commands(view: ReturnType<typeof chatView>, toolCallId: string) {
    const call = view.toolCalls().find((candidate) => candidate.toolCallId === toolCallId);
    assert.exists(call);
    const { terminals, sessionEnded } = view.transcript();
    const shown = shownContent(call.content, { terminals, sessionEnded }, false);
    return { blocks: shown.blocks.filter((block) => block.kind === 'command'), running: shown.running };
  }

  it("shows a terminal where its tool call reported it, whichever came first, in every tool call showing it, and nothing until it is reported", () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'promptStart' }, { type: 'terminal', terminalId: 'early', ...running });
    view.toolCall('c1', { content: [...texts('before'), ...terminalIn('early'), ...terminalIn('late')] });
    view.toolCall('c2', { content: terminalIn('early') });

    expect(commands(view, 'c1').blocks).toEqual([
      { kind: 'command', text: 'building', truncated: false, status: 'running', failure: null, terminalId: 'early' },
    ]);
    expect(commands(view, 'c2').blocks).toHaveLength(1);

    view.send({ type: 'terminal', terminalId: 'late', text: '', truncated: true, exitStatus: null });
    expect(commands(view, 'c1').blocks.map((block) => [block.terminalId, block.text, block.truncated])).toEqual([
      ['early', 'building', false],
      ['late', '', true],
    ]);
  });

  it('shows a command running while its terminal has no exit status, says how it failed, and says nothing of a success', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'promptStart' });
    const report = (terminalId: string, exitStatus: TerminalReport['exitStatus']) => {
      view.send({ type: 'terminal', terminalId, text: 'out', truncated: false, exitStatus });
      view.toolCall(terminalId, { content: terminalIn(terminalId) });
      return commands(view, terminalId);
    };

    expect(report('running', null)).toMatchObject({ blocks: [{ status: 'running', failure: null }], running: true });
    expect(report('passed', { exitCode: 0, signal: null })).toMatchObject({ blocks: [{ status: 'ended', failure: null }], running: false });
    expect(report('failed', { exitCode: 2, signal: null })).toMatchObject({ blocks: [{ status: 'ended', failure: 'Exit code 2' }] });
    expect(report('killed', { exitCode: null, signal: 'SIGTERM' })).toMatchObject({ blocks: [{ status: 'ended', failure: 'Ended by SIGTERM' }] });
    expect(report('unknown', { exitCode: null, signal: null })).toMatchObject({ blocks: [{ status: 'ended', failure: null }] });
  });

  it('says a command still running when its session ended was cut off by the disconnect, and keeps the terminals through the end', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'promptStart' }, { type: 'terminal', terminalId: 't1', ...running });
    view.toolCall('c1', { content: terminalIn('t1') });

    view.send({ type: 'sessionEnded', message: 'Fake exited unexpectedly (code 1).' }, { type: 'state', activeSessionId: null, session: null });

    expect(commands(view, 'c1')).toEqual({
      blocks: [{ kind: 'command', text: 'building', truncated: false, status: 'disconnected', failure: null, terminalId: 't1' }],
      running: false,
    });
  });

  it('forgets the terminals when the transcript is cleared, as for another session', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'terminal', terminalId: 't1', ...running });

    view.connect({ sessionId: 's2' });
    expect(view.transcript().terminals.size).toBe(0);
    view.send({ type: 'terminal', terminalId: 't1', ...running }, { type: 'clearTranscript' });
    expect(view.transcript().terminals.size).toBe(0);
  });

  it("shows a command's text as the extension cleaned and cut it, outside the limit on other text", () => {
    const half = 'a'.repeat(TOOL_CALL_CONTENT_LIMIT / 2);
    const output: ToolCallContent = { kind: 'commandOutput', text: 'b'.repeat(TOOL_CALL_CONTENT_LIMIT), truncated: true };

    expect(shownContent([...texts(half), output, ...texts(half)], inSession(), false)).toEqual({
      blocks: [
        { kind: 'text', text: half },
        { kind: 'command', text: output.text, truncated: true, status: 'ended', failure: null, terminalId: null },
        { kind: 'text', text: half },
      ],
      truncated: false,
      running: false,
    });
  });
});

describe('what is shown', () => {
  it('truncates tool call content past the limit, across blocks', () => {
    const half = 'a'.repeat(TOOL_CALL_CONTENT_LIMIT / 2);

    expect(shownContent(texts(half, half), inSession(), true)).toEqual({ blocks: texts(half, half), truncated: false, running: false });
    expect(shownContent(texts(half, `${half}b`), inSession(), true)).toEqual({ blocks: texts(half, half), truncated: true, running: false });
    expect(shownContent(texts(half, half, 'c'), inSession(), true)).toEqual({ blocks: texts(half, half), truncated: true, running: false });
  });

  it("shows a tool call's diffs where they were reported among its texts, their files relative to the working directory", () => {
    const half = 'a'.repeat(TOOL_CALL_CONTENT_LIMIT / 2);

    const { blocks, truncated } = shownContent([diff, ...texts(half), diff, ...texts(half, 'c'), diff], inSession(), true);

    expect(truncated).toBe(true);
    expect(blocks.map((block) => (block.kind !== 'diff' ? block.text.length : block.files.map((file) => `${file.operation} ${file.path}`)))).toEqual([
      ['add a.ts'],
      half.length,
      ['add a.ts'],
      half.length,
      ['add a.ts'],
    ]);
  });

  it('leaves the diffs out unless asked for them, as a closed tool call shows none', () => {
    expect(shownContent([...texts('before'), diff, ...texts('after')], inSession(), false)).toEqual({
      blocks: texts('before', 'after'),
      truncated: false,
      running: false,
    });
  });

  it('marks each tool call status with a glyph', () => {
    expect((['pending', 'running', 'completed', 'failed'] as const).map(statusGlyph)).toEqual(['…', '⟳', '✓', '✗']);
  });

  it('marks each plan step status with an icon', () => {
    expect((['pending', 'running', 'completed'] as const).map(planStepIcon)).toEqual(['⬜', '🔄', '✅']);
  });

  it('rounds the thought duration to whole seconds', () => {
    expect(thoughtSummary({ startedAt: 0, endedAt: 2_500 })).toBe('Thought for 3s');
    expect(thoughtSummary({ startedAt: 0, endedAt: 499 })).toBe('Thought');
    expect(thoughtSummary({ startedAt: 0, endedAt: null })).toBe('Thought');
  });
});
