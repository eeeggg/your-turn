import { expect, it } from 'vitest';
import { initialState, update } from '@/webview/state/RootState';
import { promptHistory } from '@/webview/state/Transcript';
import type { ExtensionToWebviewMessage, PresentationTarget } from '@/shared/WebviewMessages';

const target: PresentationTarget = { configuredName: 'fake', sessionId: 's1', generation: 1, projection: 1 };
const snapshot: ExtensionToWebviewMessage = { type: 'contentSnapshot', queue: [], composer: { text: '', revision: 0 }, target, revision: 0, currentTurn: 2, nextId: 3, usage: null, terminals: [], entries: [
  { kind: 'prompt', id: 1, text: 'Question' },
  { kind: 'turn', id: 2, parts: [
    { kind: 'thought', messageId: 'r1', text: 'Thinking', startedAt: 0, endedAt: 1, open: false },
    { kind: 'message', messageId: 'm1', text: 'Partial' },
  ] },
] };

it.each(['confirmed', 'already released'] as const)('keeps a queued save pending until the host reports it %s', (outcome) => {
  const original = { id: 4, text: 'Original', draft: 'Edited', revision: 2 };
  const starting = update(initialState, { ...snapshot, queue: [original] }, 0).state;
  const saving = update(starting, { type: 'queuedPromptEditSaved', id: 4 }, 0);
  expect(saving.outgoing).toEqual([{ type: 'queueChanged', target, change: { kind: 'editSaved', id: 4, revision: 3 } }]);
  expect(saving.state.transcript.queued[0]).toMatchObject(original);
  const queue = outcome === 'confirmed' ? [{ id: 4, text: 'Edited', draft: null, revision: 3 }] : [];
  const repaired = update(saving.state, { type: 'contentPatch', target, base: 0, revision: 1, patches: [],
    currentTurn: null, nextId: 3, usage: null, queue }, 0).state;
  expect(repaired.transcript.queued).toEqual(queue.map((entry) => ({ ...entry, open: false })));
});

it.each(['snapshot', 'repair'] as const)('reissues pending image context after a %s changes the projection', (delivery) => {
  const state = update(initialState, snapshot, 0).state;
  const mounted = update(state, { type: 'markdownImageMounted', occurrence: 1, source: './tiny.gif' }, 0);
  expect(mounted.outgoing).toEqual([{ type: 'markdownImageContext', target }]);
  const next = { ...target, projection: 2 };
  const refreshed = update(mounted.state, delivery === 'snapshot' ? { ...snapshot, target: next } : {
    type: 'contentPatch', target: next, baseTarget: target, base: 0, revision: 1, patches: [], currentTurn: 2, nextId: 3, usage: null,
  }, 0);
  expect(refreshed.outgoing).toEqual([{ type: 'markdownImageContext', target: next }]);
  expect(update(refreshed.state, { type: 'markdownImageContext', target, context: 1 }, 0).outgoing).toEqual([]);
  expect(update(refreshed.state, { type: 'markdownImageContext', target: next, context: 1 }, 0).outgoing)
    .toEqual([{ type: 'resolveMarkdownImage', context: 1, occurrence: 1, source: './tiny.gif' }]);
});

it('keeps a resolved image and its consent context during projection repair', () => {
  const state = update(initialState, snapshot, 0).state;
  const mounted = update(state, { type: 'markdownImageMounted', occurrence: 1, source: 'https://example.com/tiny.gif' }, 0).state;
  const contextualized = update(mounted, { type: 'markdownImageContext', target, context: 1 }, 0).state;
  const resolved = update(contextualized, { type: 'markdownImage', context: 1, occurrence: 1, src: 'data:image/gif;base64,R0lG' }, 0).state;
  const repaired = update(resolved, { type: 'contentPatch', target: { ...target, projection: 2 }, baseTarget: target,
    base: 0, revision: 1, patches: [], currentTurn: 2, nextId: 3, usage: null }, 0);
  expect(repaired.outgoing).toEqual([]);
  expect(repaired.state.transcript.markdownContext).toBe(1);
  expect(repaired.state.transcript.markdownImages.get(1)?.presentation?.src).toBe('data:image/gif;base64,R0lG');
});

it.each(['agentText', 'thoughtText', 'promptText', 'toolCall', 'plan', 'usage', 'compactionSummaryChunk'])('ignores obsolete %s content traffic instead of maintaining a second content authority', (type) => {
  const state = update(initialState, snapshot, 0).state;
  const obsolete = { type, messageId: 'obsolete', text: 'obsolete', toolCallId: 'obsolete', steps: [], usage: { used: 5, size: 10, cost: null }, compactionId: 'obsolete', content: 'obsolete' } as unknown as Parameters<typeof update>[1];
  expect(update(state, obsolete, 1).state).toBe(state);
});

it('applies an atomic selection without inheriting the previous session composer, content, or question draft', () => {
  let state = update(initialState, { ...snapshot, composer: { text: 'old composer', revision: 9 } }, 0).state;
  state = update(state, { type: 'questions', questions: [{ interactionId: 'old', sessionId: 's1', agentName: 'fake', message: 'Old', title: null, description: null, fields: [], draft: { text: 'old draft' } }] }, 0).state;
  const changed = update(state, { type: 'viewSnapshot', state: { activeSessionId: 's2', session: {
    sessionId: 's2', agentName: 'Other Agent', cwd: '/other', pickers: [], commands: [],
  } }, tabs: { tabs: [], selectedTabId: null }, running: false, loading: false, questions: [],
  content: { ...snapshot, target: { configuredName: 'other', sessionId: 's2', generation: 2, projection: 2 }, entries: [], composer: { text: 'other composer', revision: 1 }, currentTurn: null, nextId: 1 },
  }, 0);
  expect(changed.state.activeSession).toMatchObject({ sessionId: 's2', agentName: 'Other Agent', turnRunning: false, loading: false });
  expect(changed.state.promptBox.text).toBe('other composer');
  expect(changed.state.transcript.entries).toEqual([]);
  expect(changed.state.questions.items).toEqual([]);
  expect(changed.outgoing).toEqual([]);
});

it('clears an unselected transcript atomically when no retained content remains', () => {
  const first = update(initialState, snapshot, 0).state;
  const cleared = update(first, { type: 'viewSnapshot', state: { activeSessionId: null, session: null },
    tabs: { tabs: [], selectedTabId: null }, running: false, loading: false, questions: [], content: null,
  }, 0);
  expect(cleared.state.transcript.entries).toEqual([]);
  expect(cleared.state.transcript.projection).toBeNull();
  expect(cleared.outgoing).toEqual([]);
});

it('keeps pre-session typing when the first atomic projection has an empty core composer', () => {
  const typed = update(initialState, { type: 'promptEdited', text: 'typed before session' }, 0).state;
  const rebuilt = update(typed, { type: 'viewSnapshot', state: { activeSessionId: 's1', session: {
    sessionId: 's1', agentName: 'Display name', cwd: '/work', pickers: [], commands: [],
  } }, tabs: { tabs: [], selectedTabId: null }, running: false, loading: false, questions: [], content: snapshot,
  }, 0);
  expect(rebuilt.state.promptBox.text).toBe('typed before session');
  expect(rebuilt.outgoing).toEqual([{ type: 'composerEdited', target, revision: 1, text: 'typed before session' }]);
});

it('reconstructs the retained queue and inline draft without adding unsent prompts to recall or dispatching', () => {
  const rebuilt = update(initialState, { ...snapshot,
    queue: [{ id: 10, text: 'Queued', draft: 'Unfinished edit' }],
  }, 0);
  expect(rebuilt.state.transcript.queued).toEqual([{ id: 10, text: 'Queued', draft: 'Unfinished edit', open: false }]);
  expect(promptHistory(rebuilt.state.transcript)).toEqual(['Question']);
  expect(rebuilt.state.transcript.followRequests).toBe(0);
  expect(rebuilt.outgoing).toEqual([]);
});

it('posts busy submissions without deciding queue membership or releasing anything on idle', () => {
  let state = update(initialState, { type: 'state', activeSessionId: 's1', session: {
    sessionId: 's1', agentName: 'fake', cwd: '/work', pickers: [], commands: [],
  } }, 0).state;
  state = update(state, { ...snapshot, queue: [{ id: 10, text: 'Head', draft: null }] }, 0).state;
  state = update(state, { type: 'foregroundActivity', running: true }, 0).state;
  state = update(state, { type: 'promptEdited', text: 'Tail' }, 0).state;
  const sent = update(state, { type: 'promptSent' }, 0);
  expect(sent.outgoing).toEqual([{ type: 'composerEdited', target, revision: 2, text: '' }, { type: 'sendPrompt', target, text: 'Tail' }]);
  expect(sent.state.transcript.queued).toBe(state.transcript.queued);
  const idle = update(sent.state, { type: 'foregroundActivity', running: false }, 0);
  expect(idle.outgoing).toEqual([]);
  expect(idle.state.transcript.queued).toBe(state.transcript.queued);
});

it('keeps immediate queue typing when an older edit acknowledgement arrives', () => {
  let state = update(initialState, { ...snapshot, queue: [{ id: 10, text: 'Head', draft: null }] }, 0).state;
  state = update(state, { type: 'queuedPromptEditStarted', id: 10 }, 0).state;
  state = update(state, { type: 'queuedPromptEdited', id: 10, text: 'latest typing' }, 0).state;
  const echoed = update(state, { type: 'contentPatch', target, base: 0, revision: 1, patches: [], currentTurn: 2, nextId: 3, usage: null,
    queue: [{ id: 10, text: 'Head', draft: 'Head' }],
  }, 0);
  expect(echoed.state.transcript.queued[0]?.draft).toBe('latest typing');
});

it('advances queue edit revisions even when an acknowledgement has unchanged text and draft', () => {
  const first = update(initialState, { ...snapshot, queue: [{ id: 10, text: 'Head', draft: null, revision: 2 }] }, 0).state;
  const echoed = update(first, { type: 'contentPatch', target, base: 0, revision: 1, patches: [], currentTurn: 2, nextId: 3, usage: null,
    queue: [{ id: 10, text: 'Head', draft: null, revision: 4 }],
  }, 0).state;
  expect(echoed.transcript.queued[0]?.revision).toBe(4);
  const editing = update(echoed, { type: 'queuedPromptEditStarted', id: 10 }, 0);
  expect(editing.outgoing).toEqual([{ type: 'queueChanged', target, change: { kind: 'editStarted', id: 10, revision: 5 } }]);
});

it('projects queue changes without losing expansion or replacing unchanged rows and transcript content', () => {
  const first = update(initialState, { ...snapshot, queue: [
    { id: 10, text: 'Head', draft: null }, { id: 11, text: 'Tail', draft: null },
  ] }, 0).state;
  const expanded = update(first, { type: 'queuedPromptToggled', id: 10 }, 0).state;
  const changed = update(expanded, { type: 'contentPatch', target, base: 0, revision: 1,
    patches: [], currentTurn: 2, nextId: 3, usage: null,
    queue: [{ id: 10, text: 'Head', draft: 'Editing' }, { id: 11, text: 'Tail', draft: null }],
  }, 0);
  expect(changed.state.transcript.queued[0]).toEqual({ id: 10, text: 'Head', draft: 'Editing', open: true });
  expect(changed.state.transcript.queued[1]).toBe(expanded.transcript.queued[1]);
  expect(changed.state.transcript.entries).toBe(expanded.transcript.entries);
  expect(promptHistory(changed.state.transcript)).toEqual(['Question']);
  expect(changed.outgoing).toEqual([]);
  const rebuilt = update(changed.state, { ...snapshot, target: { ...target, projection: 2 },
    queue: [{ id: 10, text: 'Head', draft: 'Editing' }],
  }, 0);
  expect(rebuilt.state.transcript.queued).toEqual([{ id: 10, text: 'Head', draft: 'Editing', open: true }]);
  expect(promptHistory(rebuilt.state.transcript)).toEqual(['Question']);
  expect(rebuilt.outgoing).toEqual([]);
});

it('restores the core composer and does not let an older acknowledgement overwrite newer typing', () => {
  let state = update(initialState, { ...snapshot, composer: { text: 'retained draft', revision: 4 } }, 0).state;
  expect(state.promptBox.text).toBe('retained draft');
  const edited = update(state, { type: 'promptEdited', text: 'newer typing' }, 0);
  expect(edited.state.promptBox.text).toBe('newer typing');
  expect(edited.outgoing).toEqual([{ type: 'composerEdited', target, revision: 5, text: 'newer typing' }]);
  state = update(edited.state, { type: 'contentPatch', target, base: 0, revision: 1, patches: [], currentTurn: 2, nextId: 3, usage: null,
    composer: { text: 'retained draft', revision: 4 } }, 0).state;
  expect(state.promptBox.text).toBe('newer typing');
  const rebuilt = update(state, { ...snapshot, target: { ...target, projection: 2 }, composer: { text: 'newer typing', revision: 5 } }, 0);
  expect(rebuilt.state.promptBox.text).toBe('newer typing');
  expect(rebuilt.outgoing).toEqual([]);
});

it('keeps draft edit ordering when a slash command submits without changing empty composer text', () => {
  let state = update(initialState, { type: 'state', activeSessionId: 's1', session: {
    sessionId: 's1', agentName: 'fake', cwd: '/work', pickers: [], commands: [{ name: 'init', description: '', takesInput: false, hint: null }],
  } }, 0).state;
  state = update(state, { ...snapshot, composer: { text: '', revision: 4 } }, 0).state;
  state = update(state, { type: 'slashCommandChosen', name: 'init' }, 0).state;
  expect(update(state, { type: 'promptEdited', text: 'next draft' }, 0).outgoing)
    .toEqual([{ type: 'composerEdited', target, revision: 5, text: 'next draft' }]);
});

it('sends prompts without inserting a second authoritative transcript entry', () => {
  let state = update(initialState, { type: 'state', activeSessionId: 's1', session: {
    sessionId: 's1', agentName: 'fake', cwd: '/work', pickers: [], commands: [],
  } }, 0).state;
  state = update(state, { ...snapshot, entries: [], currentTurn: null, nextId: 1 }, 0).state;
  state = update(state, { type: 'promptEdited', text: 'First' }, 0).state;
  const sent = update(state, { type: 'promptSent' }, 0);
  expect(sent.outgoing).toEqual([{ type: 'composerEdited', target, revision: 2, text: '' }, { type: 'sendPrompt', target, text: 'First' }]);
  expect(sent.state.transcript.entries).toEqual([]);
  const accepted = update(sent.state, { type: 'contentPatch', target, base: 0, revision: 1, currentTurn: null, nextId: 2, usage: null,
    patches: [{ kind: 'insert', index: 0, entries: [{ kind: 'prompt', id: 1, text: 'First' }] }],
  }, 0);
  expect(accepted.state.transcript.entries).toEqual([{ kind: 'prompt', id: 1, text: 'First' }]);
});

it('keeps a queued prompt through same-session content reconstruction without dispatching it', () => {
  let state = update(initialState, { type: 'state', activeSessionId: 's1', session: {
    sessionId: 's1', agentName: 'fake', cwd: '/work', pickers: [], commands: [],
  } }, 0).state;
  state = update(state, snapshot, 0).state;
  state = update(state, { type: 'foregroundActivity', running: true }, 0).state;
  state = update(state, { type: 'contentPatch', target, base: 0, revision: 1, patches: [], currentTurn: 2, nextId: 3, usage: null,
    queue: [{ id: 10, text: 'Queued', draft: null }],
  }, 0).state;
  const queued = state.transcript.queued;
  expect(queued).toHaveLength(1);
  const rebuilt = update(state, { ...snapshot, target: { ...target, projection: 2 }, queue: [{ id: 10, text: 'Queued', draft: null }] }, 0);
  expect(rebuilt.outgoing).toEqual([]);
  expect(rebuilt.state.transcript.queued).toEqual(queued);
  expect(rebuilt.state.transcript.queued[0]).toBe(queued[0]);
  expect(rebuilt.state.activeSession?.turnRunning).toBe(true);
});

it('removes a dispatched queue entry only when core projects the accepted content', () => {
  let state = update(initialState, { type: 'state', activeSessionId: 's1', session: {
    sessionId: 's1', agentName: 'fake', cwd: '/work', pickers: [], commands: [],
  } }, 0).state;
  state = update(state, { ...snapshot, queue: [{ id: 10, text: 'Queued', draft: null }] }, 0).state;
  state = update(state, { type: 'foregroundActivity', running: true }, 0).state;
  const ended = update(state, { type: 'foregroundActivity', running: false }, 1);
  expect(ended.outgoing).toEqual([]);
  expect(ended.state.transcript.entries).toEqual(snapshot.entries);
  expect(ended.state.transcript.queued.map((entry) => entry.text)).toEqual(['Queued']);
  const accepted = update(ended.state, { type: 'contentPatch', target, base: 0, revision: 1, currentTurn: null, nextId: 4, usage: null,
    queue: [], patches: [{ kind: 'insert', index: 2, entries: [{ kind: 'prompt', id: 3, text: 'Queued' }] }],
  }, 1);
  expect(accepted.state.transcript.queued).toEqual([]);
  expect(accepted.state.transcript.entries).toEqual([...snapshot.entries, { kind: 'prompt', id: 3, text: 'Queued' }]);
  expect(accepted.outgoing).toEqual([]);
});

it('recalls only accepted prompts after cancellation and later queue dispatch', () => {
  let state = update(initialState, { type: 'state', activeSessionId: 's1', session: {
    sessionId: 's1', agentName: 'fake', cwd: '/work', pickers: [], commands: [],
  } }, 0).state;
  state = update(state, { ...snapshot, queue: [{ id: 10, text: 'Head', draft: null }, { id: 11, text: 'Cancelled', draft: null }] }, 0).state;
  state = update(state, { type: 'foregroundActivity', running: true }, 0).state;
  const cancelled = state.transcript.queued[1];
  if (!cancelled) { throw new Error('Missing queued prompt'); }
  expect(update(state, { type: 'queuedPromptCancelled', id: cancelled.id }, 0).outgoing)
    .toEqual([{ type: 'queueChanged', target, change: { kind: 'cancelled', id: 11 } }]);
  state = update(state, { type: 'foregroundActivity', running: false }, 1).state;
  state = update(state, { type: 'contentPatch', target, base: 0, revision: 1, currentTurn: null, nextId: 4, usage: null,
    queue: [], patches: [{ kind: 'insert', index: 2, entries: [{ kind: 'prompt', id: 3, text: 'Head' }] }],
  }, 1).state;
  expect(promptHistory(state.transcript)).toEqual(['Question', 'Head']);
});

it('does not reuse a queue ID when a content patch reports a lower content allocator', () => {
  let state = update(initialState, { type: 'state', activeSessionId: 's1', session: {
    sessionId: 's1', agentName: 'fake', cwd: '/work', pickers: [], commands: [],
  } }, 0).state;
  state = update(state, { ...snapshot, queue: [{ id: 10, text: 'First queued', draft: null }, { id: 11, text: 'Second queued', draft: null }] }, 0).state;
  state = update(state, { type: 'foregroundActivity', running: true }, 0).state;
  state = update(state, { type: 'contentPatch', target, base: 0, revision: 1, currentTurn: 2, nextId: 3, usage: null,
    patches: [{ kind: 'appendText', turnId: 2, part: 1, text: ' more' }],
  }, 1).state;
  const [first, second] = state.transcript.queued;
  if (!first || !second) { throw new Error('Missing queued prompts'); }
  expect(first.id).not.toBe(second.id);
  expect(update(state, { type: 'queuedPromptCancelled', id: first.id }, 1).outgoing)
    .toEqual([{ type: 'queueChanged', target, change: { kind: 'cancelled', id: 10 } }]);
  state = update(state, { type: 'contentPatch', target, base: 1, revision: 2, currentTurn: 2, nextId: 3, usage: null, patches: [],
    queue: [{ id: 11, text: 'Second queued', draft: null }],
  }, 1).state;
  expect(state.transcript.queued).toEqual([second]);
});

it('applies addressed text appends without replacing untouched entries or parts', () => {
  const first = update(initialState, snapshot, 0).state;
  const transition = update(first, { type: 'contentPatch', target, base: 0, revision: 1, currentTurn: 2, nextId: 3, usage: null,
    patches: [{ kind: 'appendText', turnId: 2, part: 1, text: ' answer' }],
  }, 1);
  expect(transition.outgoing).toEqual([]);
  expect(transition.state.transcript.entries[0]).toBe(first.transcript.entries[0]);
  const before = first.transcript.entries[1];
  const after = transition.state.transcript.entries[1];
  if (before?.kind !== 'turn' || after?.kind !== 'turn') { throw new Error('Expected projected turns'); }
  expect(after.parts[0]).toBe(before.parts[0]);
  expect(after.parts[1]).toEqual({ kind: 'message', messageId: 'm1', text: 'Partial answer' });
});

it('rejects duplicate appends and requests recovery for a current-target base mismatch', () => {
  const first = update(initialState, snapshot, 0).state;
  const patch: ExtensionToWebviewMessage = { type: 'contentPatch', target, base: 0, revision: 1, currentTurn: 2, nextId: 3, usage: null,
    patches: [{ kind: 'appendText', turnId: 2, part: 1, text: ' answer' }],
  };
  const applied = update(first, patch, 0).state;
  expect(update(applied, patch, 0).state).toBe(applied);
  expect(update(applied, { ...patch, base: 4, revision: 5 }, 0).outgoing).toEqual([{ type: 'contentSnapshotRequested', target }]);
  expect(update(applied, { ...patch, target: { ...target, projection: 0 } }, 0)).toEqual({ state: applied, outgoing: [] });
});

it.each(([
  [{ kind: 'appendText', turnId: 999, part: 1, text: 'lost' }],
  [{ kind: 'appendText', turnId: 2, part: 9, text: 'lost' }],
  [{ kind: 'replace', id: 999, entry: { kind: 'prompt', id: 3, text: 'lost' } }],
  [{ kind: 'spliceParts', turnId: 2, index: 3, remove: 0, parts: [] }],
  [{ kind: 'spliceParts', turnId: 2, index: 1, remove: 2, parts: [] }],
  [{ kind: 'insert', index: -1, entries: [] }],
  [{ kind: 'insert', index: 3, entries: [] }],
  [{ kind: 'toolCall', turnId: 2, part: 1, call: { toolCallId: 'missing', title: '', status: 'pending', content: [], open: false } }],
  [{ kind: 'appendText', turnId: 2, part: 1, text: 'valid' }, { kind: 'appendText', turnId: 2, part: 5, text: 'lost' }],
] satisfies Extract<ExtensionToWebviewMessage, { type: 'contentPatch' }>['patches'][]).map((patches) => ({ patches })))('recovers atomically from invalid patch addresses: %j', ({ patches }) => {
  const first = update(initialState, snapshot, 0).state;
  expect(update(first, { type: 'contentPatch', target, base: 0, revision: 1, currentTurn: 2, nextId: 3, usage: null, patches }, 1))
    .toEqual({ state: first, outgoing: [{ type: 'contentManifest', target, revision: 0, invalidBase: true,
      versions: { entries: [[1, 0], [2, 0]], terminals: [] } }] });
});

it('matches presentation targets by fields, not serialized property order', () => {
  const first = update(initialState, snapshot, 0).state;
  const reordered = { projection: 1, generation: 1, sessionId: 's1', configuredName: 'fake' };
  const result = update(first, { type: 'contentPatch', target: reordered, base: 0, revision: 1, currentTurn: 2, nextId: 3, usage: null,
    patches: [{ kind: 'appendText', turnId: 2, part: 1, text: ' answer' }],
  }, 1);
  expect(result.state.transcript.entries[1]).toMatchObject({ parts: [{ text: 'Thinking' }, { text: 'Partial answer' }] });
});

it('rejects delayed snapshots after a newer selection or revision', () => {
  const first = update(initialState, snapshot, 0).state;
  const advanced = update(first, { type: 'contentPatch', target, base: 0, revision: 1, currentTurn: 2, nextId: 3, usage: null, patches: [] }, 0).state;
  expect(update(advanced, snapshot, 0).state).toBe(advanced);
  const selected = update(advanced, { ...snapshot, target: { ...target, configuredName: 'other', projection: 2 } }, 0).state;
  expect(update(selected, snapshot, 0).state).toBe(selected);
});

it('ignores a delayed repair after selecting another session', () => {
  const first = update(initialState, snapshot, 0).state;
  const selected = update(first, { ...snapshot, target: { ...target, sessionId: 'other', projection: 3 } }, 0).state;
  expect(update(selected, { type: 'contentPatch', target: { ...target, projection: 2 }, baseTarget: target,
    base: 0, revision: 2, currentTurn: null, nextId: 4, usage: null, running: false,
    patches: [{ kind: 'insert', index: 2, entries: [{ kind: 'prompt', id: 3, text: 'Do not show here' }] }],
  }, 0)).toEqual({ state: selected, outgoing: [] });
});

it('preserves user thought expansion when a content replacement ends the thought', () => {
  const first = update(initialState, { ...snapshot, entries: [{ kind: 'turn', id: 2, parts: [
    { kind: 'thought', messageId: 'r1', text: 'Thinking', startedAt: 0, endedAt: null, open: true },
  ] }] }, 0).state;
  const collapsed = update(first, { type: 'thoughtToggled', turnId: 2, part: 0, open: false }, 0).state;
  const result = update(collapsed, { type: 'contentPatch', target, base: 0, revision: 1, currentTurn: 2, nextId: 3, usage: null,
    patches: [{ kind: 'spliceParts', turnId: 2, index: 0, remove: 1, parts: [
      { kind: 'thought', messageId: 'r1', text: 'More thought', startedAt: 0, endedAt: 1000, open: true },
    ] }],
  }, 1);
  expect(result.state.transcript.entries[0]).toMatchObject({ parts: [{ text: 'More thought', endedAt: 1000, open: false }] });
});

it('keeps compaction expansion during summary patches and closes on completion', () => {
  const compaction = { kind: 'compaction' as const, compactionId: 'c1', status: 'in_progress', summary: ['First'], error: null,
    open: true, startedAt: 0, endedAt: null, timingAllowed: true };
  const first = update(initialState, { ...snapshot, entries: [{ kind: 'turn', id: 2, parts: [compaction] }] }, 0).state;
  const collapsed = update(first, { type: 'compactionToggled', compactionId: 'c1', open: false }, 0).state;
  const continued = update(collapsed, { type: 'contentPatch', target, base: 0, revision: 1, currentTurn: 2, nextId: 3, usage: null,
    patches: [{ kind: 'spliceParts', turnId: 2, index: 0, remove: 1, parts: [{ ...compaction, summary: ['First', 'Second'] }] }],
  }, 1).state;
  expect(continued.transcript.entries[0]).toMatchObject({ parts: [{ summary: ['First', 'Second'], open: false }] });
  const opened = update(continued, { type: 'compactionToggled', compactionId: 'c1', open: true }, 1).state;
  const completed = update(opened, { type: 'contentPatch', target, base: 1, revision: 2, currentTurn: 2, nextId: 3, usage: null,
    patches: [{ kind: 'spliceParts', turnId: 2, index: 0, remove: 1, parts: [{ ...compaction, status: 'completed', endedAt: 2000, open: false }] }],
  }, 2).state;
  expect(completed.transcript.entries[0]).toMatchObject({ parts: [{ status: 'completed', open: false }] });
});

it('keeps a failed tool call closed after the user closes it and another report changes its title', () => {
  const call = { toolCallId: 't1', title: 'Failed', status: 'failed' as const, content: [], open: true };
  const first = update(initialState, { ...snapshot, entries: [{ kind: 'turn', id: 2, parts: [{ kind: 'toolCalls', collapsed: false, toolCalls: [call] }] }] }, 0).state;
  const closed = update(first, { type: 'toolCallToggled', turnId: 2, toolCallId: 't1', open: false }, 0).state;
  const patched = update(closed, { type: 'contentPatch', target, base: 0, revision: 1, currentTurn: 2, nextId: 3, usage: null,
    patches: [{ kind: 'toolCall', turnId: 2, part: 0, call: { ...call, title: 'Updated failure' } }],
  }, 1).state;
  expect(patched.transcript.entries[0]).toMatchObject({ parts: [{ toolCalls: [{ title: 'Updated failure', open: false }] }] });
});

it('keeps standalone compaction and question expansion on same-status entry replacements', () => {
  const compaction = { kind: 'compaction' as const, id: 1, compactionId: 'c1', status: 'in_progress', summary: ['First'], error: null, open: true, startedAt: 0, endedAt: null, timingAllowed: true };
  const question = { kind: 'question' as const, id: 2, open: false, record: { interactionId: 'q1', sessionId: 's1', agentName: 'fake', message: 'Question', title: null, description: null, fields: [], response: { action: 'decline' as const } } };
  let state = update(initialState, { ...snapshot, entries: [compaction, question], currentTurn: null }, 0).state;
  state = update(state, { type: 'compactionToggled', compactionId: 'c1', open: false }, 0).state;
  state = update(state, { type: 'questionRecordToggled', interactionId: 'q1', open: true }, 0).state;
  const patched = update(state, { type: 'contentPatch', target, base: 0, revision: 1, currentTurn: null, nextId: 3, usage: null,
    patches: [{ kind: 'replace', id: 1, entry: { ...compaction, summary: ['First', 'Second'] } }, { kind: 'replace', id: 2, entry: question }],
  }, 1).state;
  expect(patched.transcript.entries).toMatchObject([{ summary: ['First', 'Second'], open: false }, { open: true }]);
});

it('keeps tool group and settled question expansion when a sibling part is replaced', () => {
  const record = { interactionId: 'q1', sessionId: 's1', agentName: 'fake', message: 'Question', title: null, description: null, fields: [], response: { action: 'decline' as const } };
  const parts = [{ kind: 'question' as const, record, open: false },
    { kind: 'toolCalls' as const, collapsed: false, toolCalls: [{ toolCallId: 't1', title: 'Call', status: 'running' as const, content: [], open: false }] }];
  const first = update(initialState, { ...snapshot, entries: [{ kind: 'turn', id: 2, parts }] }, 0).state;
  let expanded = update(first, { type: 'questionRecordToggled', interactionId: 'q1', open: true }, 0).state;
  expanded = update(expanded, { type: 'toolCallsToggled', turnId: 2, part: 1 }, 0).state;
  expanded = update(expanded, { type: 'toolCallToggled', turnId: 2, toolCallId: 't1', open: true }, 0).state;
  const patched = update(expanded, { type: 'contentPatch', target, base: 0, revision: 1, currentTurn: 2, nextId: 3, usage: null,
    patches: [{ kind: 'spliceParts', turnId: 2, index: 0, remove: 2, parts }],
  }, 1).state;
  expect(patched.transcript.entries[0]).toMatchObject({ parts: [{ open: true }, { collapsed: true, toolCalls: [{ open: true }] }] });
});
