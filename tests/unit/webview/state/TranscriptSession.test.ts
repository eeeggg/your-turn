import { describe, expect, it } from 'vitest';
import type { Action } from '@/webview/state/RootState';
import { chatView, promptEnd, queuedPrompts } from '@tests/unit/webview/state/TranscriptTestSupport';

describe('the transcript session', () => {
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

describe('session usage', () => {
  const report: Action = { type: 'usage', usage: { used: 90000, size: 200000, cost: { amount: 0.123456789, currency: 'EUR' } } };

  it('has no usage until a report arrives, then stores it without adding transcript entries or requesting anything', () => {
    const view = chatView();
    view.connect();
    expect(view.transcript()).toHaveProperty('usage', null);
    const before = view.transcript();

    view.send(report);

    expect(view.transcript()).toHaveProperty('usage', { used: 90000, size: 200000, cost: { amount: 0.123456789, currency: 'EUR' } });
    expect(view.transcript().entries).toBe(before.entries);
    expect(view.transcript().currentTurn).toBeNull();
    expect(view.transcript().followRequests).toBe(before.followRequests);
    expect(view.takePosted()).toEqual([]);
  });

  it('replaces snapshots rather than accumulating context or cost, including a lower usage and changed limit', () => {
    const view = chatView();
    view.connect();
    view.send(report);

    view.send({ type: 'usage', usage: { used: 15000, size: 100000, cost: { amount: 0.234567891, currency: 'EUR' } } });

    expect(view.transcript()).toHaveProperty('usage', { used: 15000, size: 100000, cost: { amount: 0.234567891, currency: 'EUR' } });
  });

  it('removes the previous cost when the latest snapshot reports none', () => {
    const view = chatView();
    view.connect();
    view.send(report, { type: 'usage', usage: { used: 16000, size: 100000, cost: null } });

    expect(view.transcript()).toHaveProperty('usage', { used: 16000, size: 100000, cost: null });
  });

  it('preserves reported zero context and cost', () => {
    const view = chatView();
    view.connect();
    view.send(report, { type: 'usage', usage: { used: 0, size: 0, cost: { amount: 0, currency: 'JPY' } } });

    expect(view.transcript()).toHaveProperty('usage', { used: 0, size: 0, cost: { amount: 0, currency: 'JPY' } });
  });

  it('keeps usage for the same session across turn boundaries and session metadata changes', () => {
    const view = chatView();
    view.connect();
    view.send(report, { type: 'promptStart' }, promptEnd);
    view.connect({ title: 'Renamed' });

    expect(view.transcript()).toHaveProperty('usage', { used: 90000, size: 200000, cost: { amount: 0.123456789, currency: 'EUR' } });
  });

  it.each([
    ['another session', { type: 'state', activeSessionId: 's2', session: { sessionId: 's2', agentName: 'Fake', cwd: '/work', pickers: [], commands: [] } }],
    ['a disconnect', { type: 'state', activeSessionId: null, session: null }],
    ['a load', { type: 'loadSessionStart' }],
    ['an explicit clear', { type: 'clearTranscript' }],
  ] satisfies [string, Action][])('clears a usage-only snapshot on %s', (_name, clear) => {
    const view = chatView();
    view.connect();
    view.send(report);
    expect(view.transcript()).toHaveProperty('usage', { used: 90000, size: 200000, cost: { amount: 0.123456789, currency: 'EUR' } });

    view.send(clear);

    expect(view.transcript()).toHaveProperty('usage', null);
  });

  it('can clear a usage-only snapshot even when its session ID is already null', () => {
    const view = chatView();
    view.send(report);
    expect(view.transcript()).toHaveProperty('usage', { used: 90000, size: 200000, cost: { amount: 0.123456789, currency: 'EUR' } });

    view.send({ type: 'clearTranscript' });

    expect(view.transcript()).toHaveProperty('usage', null);
  });

  it('does not restore usage from replayed transcript entries or load completion without a fresh report', () => {
    const view = chatView();
    view.connect();
    view.send(report);
    expect(view.transcript()).toHaveProperty('usage', { used: 90000, size: 200000, cost: { amount: 0.123456789, currency: 'EUR' } });
    view.send({ type: 'loadSessionStart' });
    view.replayed('question');
    view.answer('answer');
    view.send({ type: 'loadSessionEnd', ok: true });

    expect(view.transcript()).toHaveProperty('usage', null);
  });

  it('accepts a fresh usage report during replay and retains it when the load ends', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'loadSessionStart' });
    view.replayed('question');
    view.send(report);
    view.answer('answer');
    view.send({ type: 'loadSessionEnd', ok: true });

    expect(view.transcript()).toHaveProperty('usage', { used: 90000, size: 200000, cost: { amount: 0.123456789, currency: 'EUR' } });
  });

  it('retains usage with the transcript when the agent exits, until an explicit clear', () => {
    const view = chatView();
    view.connect();
    view.send(report, { type: 'sessionEnded', message: 'Fake exited.' }, { type: 'state', activeSessionId: null, session: null });

    expect(view.transcript()).toHaveProperty('usage', { used: 90000, size: 200000, cost: { amount: 0.123456789, currency: 'EUR' } });

    view.send({ type: 'clearTranscript' });
    expect(view.transcript()).toHaveProperty('usage', null);
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

describe('loading session', () => {
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

describe('errors', () => {
  it('shows extension errors, with a fallback for an empty one', () => {
    const view = chatView();
    view.send({ type: 'error', message: 'boom' }, { type: 'error', message: '' });

    expect(view.summary()).toEqual(['error: boom', 'error: An error occurred']);
  });
});
