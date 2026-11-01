import { describe, expect, it } from 'vitest';
import type { ExtensionToWebviewMessage } from '@/shared/WebviewMessages';
import { initialState, update } from '@/webview/state/RootState';

type Question = Extract<ExtensionToWebviewMessage, { type: 'questions' }>['questions'][number];
const question: Question = {
  interactionId: 'q1', agentName: 'Agent', sessionId: null, message: 'Settings?', title: null, description: null, draft: null,
  fields: [
    { name: 'count', kind: 'integer', title: null, description: null, required: true, choices: null, minimum: 0, maximum: 3, minLength: null, maxLength: null, minItems: null, maxItems: null, pattern: null, format: null, default: 0 },
    { name: 'enabled', kind: 'boolean', title: null, description: null, required: false, choices: null, minimum: null, maximum: null, minLength: null, maxLength: null, minItems: null, maxItems: null, pattern: null, format: null, default: false },
  ],
};

describe('question state', () => {
  it('initializes defaults without submitting and retains edited raw input when another request appends', () => {
    const received = update(initialState, { type: 'questions', questions: [question] }, 0);
    expect(received.outgoing).toEqual([]);
    expect(received.state.questions.items[0]?.draft).toEqual({ count: 0, enabled: false });
    const edited = update(received.state, { type: 'questionFieldEdited', interactionId: 'q1', name: 'count', value: '-' }, 0);
    expect(edited.outgoing).toEqual([{ type: 'questionDraft', interactionId: 'q1', draft: { count: '-', enabled: false } }]);
    const appended = update(edited.state, { type: 'questions', questions: [question, { ...question, interactionId: 'q2' }] }, 0);
    expect(appended.state.questions.items.map((item) => item.draft)).toEqual([{ count: '-', enabled: false }, { count: 0, enabled: false }]);
  });

  it('validates complete typed answers and waits for extension settlement rather than removing the question optimistically', () => {
    let state = update(initialState, { type: 'questions', questions: [question] }, 0).state;
    state = update(state, { type: 'questionFieldEdited', interactionId: 'q1', name: 'count', value: '1.5' }, 0).state;
    const invalid = update(state, { type: 'questionSubmitted', interactionId: 'q1' }, 0);
    expect(invalid.outgoing).toEqual([]);
    expect(invalid.state.questions.items[0]?.errors).toEqual({ count: 'Enter a whole number' });
    state = update(invalid.state, { type: 'questionFieldEdited', interactionId: 'q1', name: 'count', value: '2' }, 0).state;
    const sent = update(state, { type: 'questionSubmitted', interactionId: 'q1' }, 0);
    expect(sent.outgoing).toEqual([{ type: 'questionResponse', interactionId: 'q1', action: 'accept', content: { count: 2, enabled: false } }]);
    expect(sent.state.questions.items).toHaveLength(1);
    expect(sent.state.questions.items[0]?.submitting).toBe(true);
    expect(update(sent.state, { type: 'questionSubmitted', interactionId: 'q1' }, 0).outgoing).toEqual([]);
    const rejected = update(sent.state, { type: 'questionErrors', interactionId: 'q1', errors: { count: 'Invalid value' } }, 0);
    expect(rejected.state.questions.items[0]).toMatchObject({ submitting: false, draft: { count: '2', enabled: false }, errors: { count: 'Invalid value' } });
    expect(update(rejected.state, { type: 'questions', questions: [] }, 0).state.questions.items).toEqual([]);
  });

  it('clears optional defaults without restoring them and keeps decline and dismissal distinct', () => {
    let state = update(initialState, { type: 'questions', questions: [question] }, 0).state;
    const cleared = update(state, { type: 'questionFieldCleared', interactionId: 'q1', name: 'enabled' }, 0);
    expect(cleared.outgoing).toEqual([{ type: 'questionDraft', interactionId: 'q1', draft: { count: 0 } }]);
    state = update(cleared.state, { type: 'questions', questions: [question] }, 0).state;
    expect(update(state, { type: 'questionSubmitted', interactionId: 'q1' }, 0).outgoing).toEqual([{ type: 'questionResponse', interactionId: 'q1', action: 'accept', content: { count: 0 } }]);
    for (const action of ['decline', 'cancel'] as const) {
      expect(update(state, { type: 'questionDismissed', interactionId: 'q1', action }, 0).outgoing).toEqual([{ type: 'questionResponse', interactionId: 'q1', action }]);
    }
  });

  it('does not reapply defaults to an explicitly empty saved draft after page recreation', () => {
    const received = update(initialState, { type: 'questions', questions: [{ ...question, draft: {} }] }, 0);
    expect(received.state.questions.items[0]?.draft).toEqual({});
  });

  it('keeps pending requests independent and ignores edits and responses for stale or unknown fields', () => {
    let state = update(initialState, { type: 'questions', questions: [question, { ...question, interactionId: 'q2' }] }, 0).state;
    expect(update(state, { type: 'questionFieldEdited', interactionId: 'q1', name: 'unknown', value: 'x' }, 0)).toEqual({ state, outgoing: [] });
    state = update(state, { type: 'questionDismissed', interactionId: 'q1', action: 'cancel' }, 0).state;
    for (const action of [
      { type: 'questionFieldEdited', interactionId: 'q1', name: 'count', value: '2' },
      { type: 'questionDismissed', interactionId: 'q1', action: 'decline' },
    ] as const) {
      expect(update(state, action, 0)).toEqual({ state, outgoing: [] });
    }
    expect(update(state, { type: 'questionSubmitted', interactionId: 'q2' }, 0).outgoing).toEqual([{ type: 'questionResponse', interactionId: 'q2', action: 'accept', content: { count: 0, enabled: false } }]);
    state = update(state, { type: 'questions', questions: [] }, 0).state;
    expect(update(state, { type: 'questionSubmitted', interactionId: 'q1' }, 0)).toEqual({ state, outgoing: [] });
    expect(update(state, { type: 'questionErrors', interactionId: 'q1', errors: { count: 'Invalid' } }, 0)).toEqual({ state, outgoing: [] });
  });

  it.each(['', ' ', '-', 'NaN', 'Infinity'])('retains invalid numeric draft %j without sending an answer', (value) => {
    let state = update(initialState, { type: 'questions', questions: [question] }, 0).state;
    state = update(state, { type: 'questionFieldEdited', interactionId: 'q1', name: 'count', value }, 0).state;
    const submitted = update(state, { type: 'questionSubmitted', interactionId: 'q1' }, 0);
    expect(submitted.outgoing).toEqual([]);
    expect(submitted.state.questions.items[0]).toMatchObject({ draft: { count: value, enabled: false }, errors: { count: 'Enter a number' }, submitting: false });
  });

  it('reports missing required fields without confusing omission with false or zero', () => {
    const state = update(initialState, { type: 'questions', questions: [{ ...question, draft: { enabled: false } }] }, 0).state;
    const submitted = update(state, { type: 'questionSubmitted', interactionId: 'q1' }, 0);
    expect(submitted.outgoing).toEqual([]);
    expect(submitted.state.questions.items[0]?.errors).toEqual({ count: 'Required' });
  });
});
