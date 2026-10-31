import { describe, expect, it } from 'vitest';
import { promptHistory } from '@/webview/state/Transcript';
import { chatView, promptEnd, queuedPrompts } from './TranscriptTestSupport';

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

describe('following stream', () => {
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
