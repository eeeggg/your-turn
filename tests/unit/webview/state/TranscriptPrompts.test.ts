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
    expect(view.transcript().queued.map((prompt) => prompt.text)).toEqual(['also this']);
    expect(view.summary()).toEqual(['prompt: first', 'turn: working still']);
  });

  it('holds a second prompt sent before the extension reports that the first one started', () => {
    const view = chatView();
    view.connect();

    view.prompt('first');
    view.prompt('second');

    expect(view.takePosted()).toEqual([{ type: 'sendPrompt', text: 'first' }, queuedPrompts(1)]);
    expect(view.transcript().queued.map((prompt) => prompt.text)).toEqual(['second']);
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
    expect(view.transcript().queued.map((prompt) => prompt.text)).toEqual(['third']);
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

    const id = view.transcript().queued[0]?.id ?? -1;
    view.send({ type: 'sendNowChosen', id }, { type: 'sendNowChosen', id });

    expect(view.takePosted()).toEqual([{ type: 'cancelTurn' }, { type: 'cancelTurn' }]);
    expect(view.transcript().queued.map((prompt) => prompt.text)).toEqual(['second', 'third']);
    expect(view.transcript().followRequests).toBe(before + 2);

    view.send(promptEnd);
    expect(view.takePosted()).toEqual([{ type: 'sendPrompt', text: 'second' }, queuedPrompts(1)]);
  });

  it('does not cancel the turn to send now when nothing is queued', () => {
    const view = chatView();
    view.connect();
    view.prompt('first');
    view.takePosted();

    view.send({ type: 'sendNowChosen', id: -1 });

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

  it('keeps duplicate entries independently owned through removal and ignores all stale actions', () => {
    const view = chatView();
    view.connect();
    view.prompt('running');
    view.prompt('duplicate');
    view.prompt('duplicate');
    const first = view.transcript().queued[0]?.id ?? -1;
    const second = view.transcript().queued[1]?.id ?? -1;
    expect(first).not.toBe(second);
    view.send({ type: 'queuedPromptToggled', id: second }, { type: 'queuedPromptEditStarted', id: second },
      { type: 'queuedPromptEdited', id: second, text: 'second edit' }, { type: 'queuedPromptCancelled', id: first });
    const survivor = view.transcript().queued[0];
    expect(survivor).toEqual({ id: second, text: 'duplicate', open: true, draft: 'second edit' });
    view.takePosted();
    const before = view.transcript();
    view.send({ type: 'queuedPromptCancelled', id: first }, { type: 'queuedPromptEditStarted', id: first },
      { type: 'queuedPromptEdited', id: first, text: 'wrong' }, { type: 'queuedPromptEditSaved', id: first },
      { type: 'queuedPromptEditDiscarded', id: first }, { type: 'queuedPromptToggled', id: first }, { type: 'sendNowChosen', id: first });
    expect(view.transcript()).toBe(before);
    expect(view.takePosted()).toEqual([]);
    expect(promptHistory(view.transcript())).toEqual(['running', 'duplicate']);
  });

  it.each(['save', 'escape', 'cancel'] as const)('holds an edited head after idle and resumes in order on %s', (finish) => {
    const view = chatView();
    view.connect();
    view.prompt('running');
    view.prompt('head');
    view.prompt('tail');
    const id = view.transcript().queued[0]?.id ?? -1;
    view.send({ type: 'queuedPromptEditStarted', id }, { type: 'queuedPromptEdited', id, text: 'changed head' });
    view.takePosted();
    view.send(promptEnd);
    expect(view.store.getSnapshot().activeSession?.turnRunning).toBe(false);
    expect(view.takePosted()).toEqual([]);
    // A new composer submission must not overtake the held head either.
    view.prompt('new tail');
    expect(view.takePosted()).toEqual([queuedPrompts(3)]);
    view.send({ type: finish === 'save' ? 'queuedPromptEditSaved' : finish === 'escape' ? 'queuedPromptEditDiscarded' : 'queuedPromptCancelled', id });
    const sent = finish === 'save' ? 'changed head' : finish === 'escape' ? 'head' : 'tail';
    expect(view.takePosted()).toEqual([{ type: 'sendPrompt', text: sent }, queuedPrompts(finish === 'cancel' ? 1 : 2)]);
    expect(view.transcript().queued.map((prompt) => prompt.text)).toEqual(finish === 'cancel' ? ['new tail'] : ['tail', 'new tail']);
    expect(view.store.getSnapshot().activeSession?.turnRunning).toBe(true);
    expect(view.summary()).toEqual(['prompt: running', `prompt: ${sent}`]);
  });

  it('sends an unedited head while a later entry is edited, then holds that entry without skipping it', () => {
    const view = chatView();
    view.connect();
    view.prompt('running');
    view.prompt('head');
    view.prompt('edited tail');
    view.prompt('last');
    const id = view.transcript().queued[1]?.id ?? -1;
    view.send({ type: 'queuedPromptEditStarted', id });
    view.takePosted();
    view.send(promptEnd);
    expect(view.takePosted()).toEqual([{ type: 'sendPrompt', text: 'head' }, queuedPrompts(2)]);
    view.send(promptEnd);
    expect(view.takePosted()).toEqual([]);
    expect(view.transcript().queued.map((prompt) => prompt.text)).toEqual(['edited tail', 'last']);
    expect(view.transcript().queued[0]?.draft).toBe('edited tail');
  });

  it('honors Send now interruption but still holds an edited head until editing ends', () => {
    const view = chatView();
    view.connect();
    view.prompt('running');
    view.prompt('head');
    view.prompt('tail');
    const id = view.transcript().queued[0]?.id ?? -1;
    view.send({ type: 'sendNowChosen', id }, { type: 'queuedPromptEditStarted', id });
    expect(view.takePosted()).toEqual([{ type: 'sendPrompt', text: 'running' }, queuedPrompts(1), queuedPrompts(2), { type: 'cancelTurn' }]);
    view.send(promptEnd);
    expect(view.takePosted()).toEqual([]);
    view.send({ type: 'sendNowChosen', id });
    expect(view.takePosted()).toEqual([]);
    view.send({ type: 'queuedPromptEditDiscarded', id });
    expect(view.takePosted()).toEqual([{ type: 'sendPrompt', text: 'head' }, queuedPrompts(1)]);
    const before = view.transcript();
    view.send({ type: 'queuedPromptEditStarted', id }, { type: 'queuedPromptCancelled', id }, { type: 'sendNowChosen', id });
    expect(view.transcript()).toBe(before);
    expect(view.takePosted()).toEqual([]);
  });

  it('cancels the head before an outstanding Send now completes and sends only its successor', () => {
    const view = chatView();
    view.connect();
    view.prompt('running');
    view.prompt('head');
    view.prompt('tail');
    const id = view.transcript().queued[0]?.id ?? -1;
    view.takePosted();
    view.send({ type: 'sendNowChosen', id }, { type: 'queuedPromptCancelled', id });
    expect(view.takePosted()).toEqual([{ type: 'cancelTurn' }, queuedPrompts(1)]);
    view.send(promptEnd);
    expect(view.takePosted()).toEqual([{ type: 'sendPrompt', text: 'tail' }, queuedPrompts(0)]);
    expect(view.summary()).toEqual(['prompt: running', 'prompt: tail']);
    expect(promptHistory(view.transcript())).toEqual(['running', 'head', 'tail']);
  });

  it('retains saved edits on cancellation and orders cancelled recall entries with later sent prompts', () => {
    const view = chatView();
    view.connect();
    view.prompt('running');
    view.prompt('head');
    view.prompt('tail');
    const head = view.transcript().queued[0]?.id ?? -1;
    const tail = view.transcript().queued[1]?.id ?? -1;
    view.send({ type: 'queuedPromptEditStarted', id: head }, { type: 'queuedPromptEdited', id: head, text: 'saved head' },
      { type: 'queuedPromptEditSaved', id: head }, { type: 'queuedPromptCancelled', id: tail }, { type: 'queuedPromptCancelled', id: head });
    expect(view.store.getSnapshot().promptBox.text).toBe('');
    expect(promptHistory(view.transcript())).toEqual(['running', 'tail', 'saved head']);
    view.send({ type: 'historyMoved', to: 'older' });
    expect(view.store.getSnapshot().promptBox.text).toBe('saved head');
    view.send({ type: 'historyMoved', to: 'older' });
    expect(view.store.getSnapshot().promptBox.text).toBe('tail');
    view.send(promptEnd);
    view.prompt('later sent');
    expect(promptHistory(view.transcript())).toEqual(['running', 'tail', 'saved head', 'later sent']);
    expect(view.summary()).toEqual(['prompt: running', 'prompt: later sent']);
  });

  it('does not reuse ownership or cancelled recall across session replacement, loading or clearing', () => {
    const view = chatView();
    const oldIds: number[] = [];
    for (const clear of [() => view.connect({ sessionId: 's2' }), () => view.send({ type: 'loadSessionStart' }), () => view.send({ type: 'clearTranscript' })]) {
      view.connect();
      view.prompt('running');
      view.prompt('cancelled');
      const id = view.transcript().queued[0]?.id ?? -1;
      expect(oldIds).not.toContain(id);
      oldIds.push(id);
      view.send({ type: 'queuedPromptCancelled', id });
      clear();
      expect(promptHistory(view.transcript())).toEqual([]);
      expect(view.transcript().queued).toEqual([]);
      view.send({ type: 'queuedPromptCancelled', id }, { type: 'queuedPromptEditSaved', id });
      expect(promptHistory(view.transcript())).toEqual([]);
    }
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
