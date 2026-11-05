import { describe, expect, it } from 'vitest';
import type { QuestionRecord } from '@/shared/WebviewMessages';
import { chatView } from '@tests/unit/webview/state/TranscriptTestSupport';

const record: QuestionRecord = {
  interactionId: 'q1', sessionId: 's1', agentName: 'Agent', message: 'Confirm?', title: null, description: null, fields: [], response: { action: 'accept', content: {} },
};

describe('settled question records', () => {
  it('records each confirmed response once, initially collapsed, without ending the turn or releasing queued prompts', () => {
    const view = chatView();
    view.connect();
    view.prompt('first');
    view.answer('Before');
    view.prompt('queued');
    view.takePosted();
    view.send({ type: 'questionSettled', record });
    const saved = view.transcript();
    expect(view.lastTurn().parts).toEqual([
      { kind: 'message', messageId: null, text: 'Before' },
      { kind: 'question', record, open: false },
    ]);
    expect(saved.currentTurn).not.toBeNull();
    expect(saved.queued.map((prompt) => prompt.text)).toEqual(['queued']);
    expect(view.takePosted()).toEqual([]);
    view.send({ type: 'questionSettled', record });
    expect(view.transcript()).toBe(saved);
    view.answer('After');
    expect(view.lastTurn().parts.at(-1)).toEqual({ kind: 'message', messageId: null, text: 'After' });
    view.send({ type: 'questionRecordToggled', interactionId: 'q1', open: true });
    expect(view.lastTurn().parts[1]).toEqual({ kind: 'question', record, open: true });
    expect(view.takePosted()).toEqual([]);
  });

  it('records idle responses as their own entries and never inserts them into replay or another session', () => {
    const view = chatView();
    view.send({ type: 'questionSettled', record });
    expect(view.transcript().entries).toEqual([]);
    view.connect();
    view.send({ type: 'questionSettled', record: { ...record, sessionId: 'other' } });
    expect(view.transcript().entries).toEqual([]);
    view.send({ type: 'questionSettled', record });
    expect(view.transcript().entries).toEqual([{ kind: 'question', id: 1, record, open: false }]);
    view.send({ type: 'loadSessionStart' });
    view.send({ type: 'questionSettled', record });
    expect(view.transcript().entries).toEqual([]);
    view.send({ type: 'loadSessionEnd', ok: true });
    expect(view.transcript().entries).toEqual([]);
    view.connect({ sessionId: 'other' });
    expect(view.transcript().entries).toEqual([]);
  });
});
