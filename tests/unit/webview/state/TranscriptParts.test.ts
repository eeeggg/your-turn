import { assert, describe, expect, it } from 'vitest';
import { planStepIcon, thoughtSummary, turnShown } from '@/webview/state/Transcript';
import { chatView, promptEnd } from '@tests/unit/webview/state/TranscriptTestSupport';

describe('agent messages', () => {
  it('collects the text of a turn into one message, and starts a turn per prompt', () => {
    const view = chatView();
    view.connect();
    for (const answer of ['hello ', 'world']) {
      view.answer(answer);
    }
    view.prompt('next');
    view.send({ type: 'promptStart' });
    view.answer('again');

    expect(view.summary()).toEqual(['turn: hello world', 'prompt: next', 'turn: again']);
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

describe('plans', () => {
  it("replaces the turn's plan with each update where it was first reported, and starts another in the next turn", () => {
    const view = chatView();
    view.connect();
    view.plan({ text: 'a', status: 'pending' });
    view.answer('working');
    view.plan({ text: 'a', status: 'completed' }, { text: 'b', status: 'pending' });
    expect(view.summary()).toEqual(['turn: plan a, b | working']);

    view.prompt('next');
    view.send({ type: 'promptStart' });
    view.plan({ text: 'c', status: 'pending' });

    expect(view.summary()).toEqual(['turn: plan a, b | working', 'prompt: next', 'turn: plan c']);
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

describe('what is shown', () => {
  it('marks each plan step status with an icon', () => {
    expect((['pending', 'running', 'completed'] as const).map(planStepIcon)).toEqual(['⬜', '🔄', '✅']);
  });

  it('rounds the thought duration to whole seconds', () => {
    expect(thoughtSummary({ startedAt: 0, endedAt: 2_500 })).toBe('Thought for 3s');
    expect(thoughtSummary({ startedAt: 0, endedAt: 499 })).toBe('Thought');
    expect(thoughtSummary({ startedAt: 0, endedAt: null })).toBe('Thought');
  });
});
