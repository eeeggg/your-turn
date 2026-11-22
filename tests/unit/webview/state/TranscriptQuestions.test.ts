import { describe, expect, it } from 'vitest';
import type { ExtensionToWebviewMessage, QuestionRecord } from '@/shared/WebviewMessages';
import { chatView, TRANSCRIPT_SESSION_ID, OTHER_TRANSCRIPT_SESSION_ID } from '@tests/unit/webview/state/TranscriptTestSupport';
import type { Action } from '@/webview/state/RootState';

const record: QuestionRecord = {
  interactionId: 'q1', sessionId: TRANSCRIPT_SESSION_ID, agentName: 'Agent', message: 'Confirm?', title: null, description: null, fields: [], response: { action: 'accept', content: {} },
};

const snapshot: Extract<ExtensionToWebviewMessage, { type: 'contentSnapshot' }> = {
  type: 'contentSnapshot', queue: [], composer: { text: '', revision: 0 },
  target: { configuredName: 'Fake', sessionId: TRANSCRIPT_SESSION_ID, generation: 1, projection: 1 },
  revision: 0, entries: [], currentTurn: null, nextId: 1, usage: null, terminals: [],
};

describe('settled question records', () => {
  it('ignores obsolete settlement traffic instead of creating webview-owned content', () => {
    const view = chatView();
    view.connect();
    view.send(snapshot);
    const before = view.transcript();
    view.send({ type: 'questionSettled', record } as unknown as Action);
    expect(view.transcript()).toBe(before);
    expect(view.takePosted()).toEqual([]);
  });

  it('records each confirmed response once, initially collapsed, without ending the turn or releasing queued prompts', () => {
    const view = chatView();
    view.connect();
    view.send(snapshot);
    view.prompt('first');
    view.answer('Before');
    view.prompt('queued');
    view.send({ type: 'contentPatch', target: { configuredName: 'Fake', sessionId: TRANSCRIPT_SESSION_ID, generation: 1, projection: 1 },
      base: view.transcript().projection?.revision ?? 0, revision: (view.transcript().projection?.revision ?? 0) + 1, patches: [], currentTurn: view.transcript().currentTurn, nextId: view.transcript().nextId, usage: null,
      queue: [{ id: 10, text: 'queued', draft: null }],
    });
    view.takePosted();
    const turn = view.lastTurn();
    const settled: Extract<ExtensionToWebviewMessage, { type: 'contentPatch' }> = {
      type: 'contentPatch', target: snapshot.target, base: view.transcript().projection?.revision ?? 0, revision: (view.transcript().projection?.revision ?? 0) + 1,
      patches: [{ kind: 'spliceParts', turnId: turn.id, index: 1, remove: 0, parts: [{ kind: 'question', record, open: false }] }],
      currentTurn: turn.id, nextId: view.transcript().nextId, usage: null,
    };
    view.send(settled);
    const saved = view.transcript();
    expect(view.lastTurn().parts).toEqual([
      { kind: 'message', messageId: null, text: 'Before' },
      { kind: 'question', record, open: false },
    ]);
    expect(saved.currentTurn).not.toBeNull();
    expect(saved.queued.map((prompt) => prompt.text)).toEqual(['queued']);
    expect(view.takePosted()).toEqual([]);
    view.send(settled);
    expect(view.transcript()).toBe(saved);
    view.send({ type: 'contentPatch', target: snapshot.target, base: saved.projection?.revision ?? 0, revision: (saved.projection?.revision ?? 0) + 1,
      patches: [{ kind: 'spliceParts', turnId: turn.id, index: 2, remove: 0, parts: [{ kind: 'message', messageId: null, text: 'After' }] }],
      currentTurn: turn.id, nextId: saved.nextId, usage: null });
    expect(view.lastTurn().parts.at(-1)).toEqual({ kind: 'message', messageId: null, text: 'After' });
    view.send({ type: 'questionRecordToggled', interactionId: 'q1', open: true });
    expect(view.lastTurn().parts[1]).toEqual({ kind: 'question', record, open: true });
    expect(view.takePosted()).toEqual([]);
  });

  it('reconstructs idle records and rejects obsolete settlement patches after replay or a session change', () => {
    const view = chatView();
    const settled: Extract<ExtensionToWebviewMessage, { type: 'contentPatch' }> = {
      type: 'contentPatch', target: snapshot.target, base: 0, revision: 1,
      patches: [{ kind: 'insert', index: 0, entries: [{ kind: 'question', id: 1, record, open: false }] }],
      currentTurn: null, nextId: 2, usage: null,
    };
    view.send(settled);
    expect(view.transcript().entries).toEqual([]);
    view.connect();
    view.send(snapshot);
    view.send({ ...settled, target: { ...snapshot.target, sessionId: OTHER_TRANSCRIPT_SESSION_ID } });
    expect(view.transcript().entries).toEqual([]);
    view.send(settled);
    expect(view.transcript().entries).toEqual([{ kind: 'question', id: 1, record, open: false }]);
    view.send({ ...snapshot, target: { ...snapshot.target, projection: 2 }, entries: [{ kind: 'question', id: 1, record, open: false }], nextId: 2 });
    expect(view.transcript().entries).toEqual([{ kind: 'question', id: 1, record, open: false }]);
    view.send({ type: 'loadSessionStart' });
    view.send(settled);
    expect(view.transcript().entries).toEqual([]);
    view.send({ type: 'loadSessionEnd', ok: true });
    view.send({ ...snapshot, target: { ...snapshot.target, generation: 2, projection: 3 } });
    view.send(settled);
    expect(view.transcript().entries).toEqual([]);
    view.connect({ sessionId: OTHER_TRANSCRIPT_SESSION_ID });
    view.send({ ...snapshot, target: { ...snapshot.target, sessionId: OTHER_TRANSCRIPT_SESSION_ID, generation: 3, projection: 4 } });
    view.send(settled);
    expect(view.transcript().entries).toEqual([]);
    expect(view.takePosted()).toEqual([]);
  });
});
