import { describe, expect, it } from 'vitest';
import { ElicitationRequests } from '@/core/ElicitationRequests';
import type { ElicitationRequest, ElicitationChange } from '@/core/acp/AcpDriver';

const form: ElicitationRequest = { mode: 'form', rpcId: 1, scope: { sessionId: 's1', toolCallId: null }, message: 'Question', requestedSchema: {} };
const url: ElicitationRequest = { mode: 'url', rpcId: 2, scope: { requestId: 'auth-1' }, message: 'Authorize', elicitationId: 'external', url: 'https://example.org' };

describe('connection-owned elicitation requests', () => {
  it('isolates failing observers from promise ownership and other observers', async () => {
    const requests = new ElicitationRequests();
    requests.subscribe(() => { throw new Error('Observer failed'); });
    const changes: ElicitationChange[] = [];
    requests.subscribe((change) => changes.push(change));
    const answer = requests.create(form);
    requests.respond(requests.snapshot()[0]?.interactionId ?? '', { action: 'cancel' });
    expect(await answer).toEqual({ action: 'cancel' });
    expect(changes.map((change) => change.kind)).toEqual(['created', 'responded']);
    requests.close();
  });
  it.each(['accept', 'decline', 'cancel'] as const)('settles %s once without affecting another pending request', async (action) => {
    const requests = new ElicitationRequests();
    const changes: ElicitationChange[] = [];
    const unsubscribe = requests.subscribe((change) => changes.push(change));
    const first = requests.create(form);
    const second = requests.create({ ...form, rpcId: 'second' });
    const [a, b] = requests.snapshot();
    expect(a).toMatchObject({ rpcId: 1, scope: { sessionId: 's1', toolCallId: null }, message: 'Question', mode: 'form' });
    expect(a?.interactionId).not.toBe(b?.interactionId);
    const response = action === 'accept' ? { action, content: {} } : { action };
    expect(requests.respond(a?.interactionId ?? '', response)).toEqual({ kind: 'settled' });
    expect(await first).toEqual(response);
    expect(requests.respond(a?.interactionId ?? '', response)).toEqual({ kind: 'stale' });
    expect(requests.snapshot()).toEqual([b]);
    expect(changes.map((change) => change.kind)).toEqual(['created', 'created', 'responded']);
    expect(changes[2]).toMatchObject({ response });
    unsubscribe();
    requests.respond(b?.interactionId ?? '', { action: 'cancel' });
    await second;
    expect(changes).toHaveLength(3);
    requests.close();
  });

  it('leaves invalid submissions pending and copies accepted arrays before publishing', async () => {
    const requests = new ElicitationRequests();
    const answer = requests.create({ ...form, requestedSchema: { required: ['tags'], properties: { tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } } } });
    const id = requests.snapshot()[0]?.interactionId ?? '';
    expect(requests.respond(id, { action: 'accept', content: {} })).toEqual({ kind: 'invalid', errors: { tags: 'Required' } });
    expect(requests.respond(id, { action: 'decline', content: { tags: ['a'] } })).toEqual({ kind: 'invalid', errors: { '': 'Unexpected content' } });
    const tags = ['a'];
    requests.respond(id, { action: 'accept', content: { tags } });
    tags.push('b');
    expect(await answer).toEqual({ action: 'accept', content: { tags: ['a'] } });
  });

  it('distinguishes individual abort and connection closure from user dismissal', async () => {
    const requests = new ElicitationRequests();
    const changes: ElicitationChange[] = [];
    requests.subscribe((change) => changes.push(change));
    const controller = new AbortController();
    const aborted = requests.create(form, controller.signal);
    const abortedCheck = expect(aborted).rejects.toMatchObject({ kind: 'cancelled' });
    const closed = requests.create(url);
    const closedCheck = expect(closed).rejects.toMatchObject({ kind: 'closed' });
    const ids = requests.snapshot().map((request) => request.interactionId);
    controller.abort();
    await abortedCheck;
    expect(requests.snapshot()).toHaveLength(1);
    requests.close();
    requests.close();
    await closedCheck;
    expect(changes.map((change) => change.kind)).toEqual(['created', 'created', 'withdrawn', 'closed']);
    expect(requests.snapshot()).toEqual([]);
    for (const id of ids) { expect(requests.respond(id, { action: 'cancel' })).toEqual({ kind: 'stale' }); }
    await expect(requests.create(form)).rejects.toMatchObject({ kind: 'closed' });
  });

  it('never publishes an already-aborted request and does not undo a winning response', async () => {
    const requests = new ElicitationRequests();
    const controller = new AbortController();
    controller.abort();
    await expect(requests.create(form, controller.signal)).rejects.toMatchObject({ kind: 'cancelled' });
    expect(requests.snapshot()).toEqual([]);
    const next = new AbortController();
    const answer = requests.create(form, next.signal);
    requests.respond(requests.snapshot()[0]?.interactionId ?? '', { action: 'decline' });
    next.abort();
    expect(await answer).toEqual({ action: 'decline' });
  });

  it('retains accepted URL tracking until completion, rejects outstanding reuse, then permits reuse', async () => {
    const requests = new ElicitationRequests();
    const answer = requests.create(url);
    const id = requests.snapshot()[0]?.interactionId ?? '';
    expect(requests.respond(id, { action: 'accept', content: {} })).toMatchObject({ kind: 'invalid' });
    requests.respond(id, { action: 'accept' });
    expect(await answer).toEqual({ action: 'accept' });
    expect(requests.snapshot()).toMatchObject([{ interactionId: id, status: 'awaitingCompletion' }]);
    await expect(requests.create(url)).rejects.toMatchObject({ kind: 'invalid' });
    requests.complete('unknown');
    expect(requests.snapshot()).toHaveLength(1);
    requests.complete('external');
    requests.complete('external');
    expect(requests.snapshot()).toEqual([]);
    const reused = requests.create(url);
    requests.respond(requests.snapshot()[0]?.interactionId ?? '', { action: 'cancel' });
    expect(await reused).toEqual({ action: 'cancel' });
  });

  it('records completion racing consent without manufacturing or replacing consent', async () => {
    const requests = new ElicitationRequests();
    const changes: ElicitationChange[] = [];
    requests.subscribe((change) => changes.push(change));
    const answer = requests.create(url);
    const id = requests.snapshot()[0]?.interactionId ?? '';
    requests.complete('external');
    requests.complete('external');
    expect(requests.snapshot()).toMatchObject([{ interactionId: id, status: 'pending', completed: true }]);
    await expect(requests.create(url)).rejects.toMatchObject({ kind: 'invalid' });
    requests.respond(id, { action: 'accept' });
    expect(await answer).toEqual({ action: 'accept' });
    expect(requests.snapshot()).toEqual([]);
    expect(changes.map((change) => change.kind)).toEqual(['created', 'completed', 'responded']);
  });

  it('rejects ambiguous scope and invalid parent identity without creating requests', async () => {
    const requests = new ElicitationRequests((id) => id === 7);
    await expect(requests.create(url)).rejects.toMatchObject({ kind: 'invalid' });
    await expect(requests.create({ ...form, scope: { sessionId: 's', requestId: 7 } })).rejects.toMatchObject({ kind: 'invalid' });
    const answer = requests.create({ ...url, scope: { requestId: 7 } });
    expect(requests.snapshot()).toMatchObject([{ scope: { requestId: 7 }, rpcId: 2 }]);
    requests.respond(requests.snapshot()[0]?.interactionId ?? '', { action: 'decline' });
    await answer;
  });

  it('does not let controls from a closed connection address its replacement', async () => {
    const old = new ElicitationRequests();
    const oldAnswer = old.create(url);
    const check = expect(oldAnswer).rejects.toMatchObject({ kind: 'closed' });
    const oldId = old.snapshot()[0]?.interactionId ?? '';
    old.close();
    await check;
    const replacement = new ElicitationRequests();
    const answer = replacement.create(url);
    expect(replacement.respond(oldId, { action: 'accept' })).toEqual({ kind: 'stale' });
    replacement.respond(replacement.snapshot()[0]?.interactionId ?? '', { action: 'cancel' });
    await answer;
  });
});
