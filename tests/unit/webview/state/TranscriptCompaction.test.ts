import { describe, expect, it } from 'vitest';
import type { Action } from '@/webview/state/RootState';
import { chatView, promptEnd } from './TranscriptTestSupport';

describe('session compaction', () => {
  type Patch = Extract<Action, { type: 'compactionUpdate' }>;
  const patch = (compactionId: string, status = 'in_progress', fields: Partial<Pick<Patch, 'summary' | 'error'>> = {}): Patch => ({
    type: 'compactionUpdate', compactionId, status, summary: { present: false }, error: { present: false }, ...fields,
  });
  const chunk = (compactionId: string, text: string): Action => ({ type: 'compactionSummaryChunk', compactionId, content: { type: 'text', text } });

  it('places a compaction between turns without starting a turn', () => {
    const view = chatView();
    view.connect();
    view.answer('Before');
    view.send(promptEnd, patch('c1', 'completed'));
    view.answer('After');

    expect(view.transcript().entries).toEqual([
      { kind: 'turn', id: 1, parts: [{ kind: 'message', messageId: null, text: 'Before' }] },
      { kind: 'compaction', id: 2, compactionId: 'c1', status: 'completed', summary: [], error: null, open: false, startedAt: null, endedAt: null, timingAllowed: false },
      { kind: 'turn', id: 3, parts: [{ kind: 'message', messageId: null, text: 'After' }] },
    ]);
    expect(view.takePosted()).toEqual([]);
  });

  it('keeps the first position inside a turn and separates surrounding text and tool-call groups', () => {
    const view = chatView();
    view.connect();
    view.answer('Before', 'm1');
    view.toolCall('t1');
    view.send(chunk('c1', 'First'));
    view.toolCall('t2');
    view.answer('After', 'm1');
    view.send(promptEnd, patch('c1', 'completed'), chunk('c1', ' Last'));

    expect(view.lastTurn().parts.map((part) => part.kind)).toEqual(['message', 'toolCalls', 'compaction', 'toolCalls', 'message']);
    expect(view.lastTurn().parts[2]).toEqual({
      kind: 'compaction', compactionId: 'c1', status: 'completed', summary: [{ type: 'text', text: 'First' }, { type: 'text', text: ' Last' }], error: null,
      open: false, startedAt: 0, endedAt: 0, timingAllowed: false,
    });
    expect(view.toolCalls().map((call) => call.toolCallId)).toEqual(['t1', 't2']);
    expect(view.transcript().entries).toHaveLength(1);
  });

  it('places compaction in a running turn even before its first other output', () => {
    const view = chatView();
    view.connect();
    view.send({ type: 'promptStart' }, patch('c1'));
    view.answer('After');

    expect(view.transcript().entries).toHaveLength(1);
    expect(view.lastTurn().parts.map((part) => part.kind)).toEqual(['compaction', 'message']);
  });

  it('creates an in-progress compaction from its first chunk and preserves non-text content', () => {
    const view = chatView();
    view.send(chunk('opaque/id', 'First'), {
      type: 'compactionSummaryChunk', compactionId: 'opaque/id',
      content: { type: 'resource_link', uri: 'file:///summary', name: 'summary', _meta: { nested: [null, true, 3] } },
    });
    expect(view.transcript().entries).toEqual([{
      kind: 'compaction', id: 1, compactionId: 'opaque/id', status: 'in_progress', error: null,
      open: true, startedAt: 0, endedAt: null, timingAllowed: true,
      summary: [{ type: 'text', text: 'First' }, { type: 'resource_link', uri: 'file:///summary', name: 'summary', _meta: { nested: [null, true, 3] } }],
    }]);
    expect(view.transcript().currentTurn).toBeNull();
  });

  it('retains omitted patches, replaces accumulated content, and appends subsequent chunks', () => {
    const view = chatView();
    view.send(chunk('c1', 'Old'), patch('c1', 'failed', { error: { present: true, value: 'Failure' } }));
    const before = view.transcript();
    view.send(patch('c1', 'completed', { summary: { present: true, value: [{ type: 'text', text: 'Replacement' }] } }), chunk('c1', ' Tail'));

    expect(view.transcript().entries).toEqual([{
      kind: 'compaction', id: 1, compactionId: 'c1', status: 'completed', error: 'Failure',
      open: false, startedAt: 0, endedAt: 0, timingAllowed: false,
      summary: [{ type: 'text', text: 'Replacement' }, { type: 'text', text: ' Tail' }],
    }]);
    expect(before.entries[0]).toHaveProperty('summary', [{ type: 'text', text: 'Old' }]);
    expect(before.entries[0]).toHaveProperty('status', 'failed');
  });

  it.each([{ value: null }, { value: [] }] satisfies { value: null | [] }[])('clears accumulated summary with $value and accepts later chunks', ({ value }) => {
    const view = chatView();
    view.send(chunk('c1', 'Old'), patch('c1', 'failed', {
      summary: { present: true, value }, error: { present: true, value: 'Failure' },
    }));
    expect(view.transcript().entries[0]).toHaveProperty('summary', []);
    view.send(patch('c1', 'failed', { error: { present: true, value: '' } }));
    expect(view.transcript().entries[0]).toHaveProperty('error', '');
    view.send(patch('c1', 'failed', { error: { present: true, value: null } }), chunk('c1', 'New'));
    expect(view.transcript().entries[0]).toHaveProperty('error', null);
    expect(view.transcript().entries[0]).toHaveProperty('summary', [{ type: 'text', text: 'New' }]);
  });

  it.each(['failed', 'cancelled', '_paused', 'future_status'])('retains reported %s across turn and load completion', (status) => {
    const view = chatView();
    view.connect();
    view.send({ type: 'promptStart' }, patch('c1', status), promptEnd, { type: 'loadSessionEnd', ok: true });
    expect(view.lastTurn().parts[0]).toEqual({
      kind: 'compaction', compactionId: 'c1', status, summary: [], error: null,
      open: true, startedAt: null, endedAt: null, timingAllowed: status !== 'failed' && status !== 'cancelled',
    });
  });

  it('updates a standalone compaction in place even while another turn is running', () => {
    const view = chatView();
    view.send(patch('c1'), patch('c2'));
    view.answer('Later');
    view.send(patch('c1', 'completed'), chunk('c2', 'Second'));
    expect(view.transcript().entries).toEqual([
      { kind: 'compaction', id: 1, compactionId: 'c1', status: 'completed', summary: [], error: null, open: false, startedAt: 0, endedAt: 0, timingAllowed: false },
      { kind: 'compaction', id: 2, compactionId: 'c2', status: 'in_progress', summary: [{ type: 'text', text: 'Second' }], error: null, open: true, startedAt: 0, endedAt: null, timingAllowed: true },
      { kind: 'turn', id: 3, parts: [{ kind: 'message', messageId: null, text: 'Later' }] },
    ]);
  });

  it.each([
    ['session change', { type: 'state', activeSessionId: 's2', session: { sessionId: 's2', agentName: 'Fake', cwd: '/work', pickers: [], commands: [] } }],
    ['disconnect', { type: 'state', activeSessionId: null, session: null }],
    ['load', { type: 'loadSessionStart' }],
    ['clear', { type: 'clearTranscript' }],
  ] satisfies [string, Action][])('clears compactions on %s so IDs can be used in the new transcript', (_name, clear) => {
    const view = chatView();
    view.connect();
    view.send(chunk('c1', 'Old'), clear);
    expect(view.transcript().entries).toEqual([]);
    view.send(patch('c1', 'completed'));
    expect(view.transcript().entries).toEqual([{
      kind: 'compaction', id: 2, compactionId: 'c1', status: 'completed', summary: [], error: null,
      open: false, startedAt: null, endedAt: null, timingAllowed: false,
    }]);
  });

  it('retains compaction with an ended session until another session replaces it', () => {
    const view = chatView();
    view.connect();
    view.send(chunk('c1', 'Retained'), { type: 'sessionEnded', message: 'Exited' }, { type: 'state', activeSessionId: null, session: null });
    expect(view.transcript().entries).toEqual([
      { kind: 'compaction', id: 1, compactionId: 'c1', status: 'in_progress', summary: [{ type: 'text', text: 'Retained' }], error: null, open: true, startedAt: 0, endedAt: null, timingAllowed: true },
      { kind: 'error', id: 2, text: 'Exited' },
    ]);
    view.connect({ sessionId: 's2' });
    expect(view.transcript().entries).toEqual([]);
  });

  it('rebuilds from replayed updates without treating omitted summary or error as resets', () => {
    const view = chatView();
    view.connect();
    view.send(chunk('old', 'Discard'), { type: 'loadSessionStart' });
    view.replayed('Prompt');
    view.answer('Before');
    view.send(chunk('c1', 'Retained'), patch('c1', 'failed', { error: { present: true, value: 'Failure' } }));
    view.answer('After');
    view.send(patch('c1', 'failed'), { type: 'loadSessionEnd', ok: true });
    expect(view.lastTurn().parts).toEqual([
      { kind: 'message', messageId: null, text: 'Before' },
      { kind: 'compaction', compactionId: 'c1', status: 'failed', summary: [{ type: 'text', text: 'Retained' }], error: 'Failure', open: true, startedAt: null, endedAt: null, timingAllowed: false },
      { kind: 'message', messageId: null, text: 'After' },
    ]);
    expect(view.transcript().entries).toHaveLength(2);
  });
});
