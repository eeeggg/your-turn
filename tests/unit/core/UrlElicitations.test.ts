import { describe, expect, it } from 'vitest';
import { ElicitationRequests } from '@/core/ElicitationRequests';
import { attachUrlElicitations, type UrlElicitationPrompt } from '@/core/UrlElicitations';

const request = { mode: 'url' as const, rpcId: 1, scope: { sessionId: 'session' }, elicitationId: 'external', url: 'https://example.org/connect?state=abc', message: 'Authorize repository access' };

describe('URL elicitation consent delivery', () => {
  it.each(['accept', 'decline', 'cancel'] as const)('returns %s without content and opens only after accepted consent', async (action) => {
    const requests = new ElicitationRequests();
    const events: string[] = [];
    let choose: (action: 'accept' | 'decline' | 'cancel') => void = () => {};
    const prompt: UrlElicitationPrompt = {
      choose: (agent, interaction) => {
        expect(agent).toBe('test-agent');
        expect(interaction).toMatchObject({ message: request.message, url: request.url });
        return new Promise((resolve) => { choose = resolve; });
      },
      open: (url) => { events.push(`open:${url}`); return Promise.resolve(true); },
      failed: () => { throw new Error('Unexpected opening failure'); },
    };
    const dispose = attachUrlElicitations('test-agent', requests, prompt);
    requests.subscribe((change) => { if (change.kind === 'responded' && change.response) { events.push(`response:${change.response.action}`); } });
    const response = requests.create(request);
    expect(events).toEqual([]);
    choose(action);
    expect(await response).toEqual({ action });
    await dispose();
    expect(events).toEqual(action === 'accept' ? ['response:accept', `open:${request.url}`] : [`response:${action}`]);
    requests.close();
  });

  it('cancels withdrawn consent and never opens a stale selection', async () => {
    const requests = new ElicitationRequests();
    let choose: (action: 'accept') => void = () => {};
    let shownSignal: AbortSignal | undefined;
    const dispose = attachUrlElicitations('test-agent', requests, {
      choose: (_agent, _interaction, signal) => { shownSignal = signal; return new Promise((resolve) => { choose = resolve; }); },
      open: () => { throw new Error('Must not open withdrawn URL'); },
      failed: () => { throw new Error('Unexpected failure'); },
    });
    const controller = new AbortController();
    const response = requests.create(request, controller.signal);
    const rejected = expect(response).rejects.toMatchObject({ kind: 'cancelled' });
    controller.abort();
    expect(shownSignal?.aborted).toBe(true);
    choose('accept');
    await rejected;
    await dispose();
    expect(requests.snapshot()).toEqual([]);
  });

  it.each([false, new Error('Opening refused')])('reports an opening failure locally without changing accepted consent: %s', async (result) => {
    const requests = new ElicitationRequests();
    const failures: string[] = [];
    const responses: unknown[] = [];
    const dispose = attachUrlElicitations('test-agent', requests, {
      choose: () => Promise.resolve('accept'),
      open: () => result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
      failed: (agent) => { failures.push(agent); },
    });
    requests.subscribe((change) => { if (change.kind === 'responded') { responses.push(change.response); } });
    expect(await requests.create(request)).toEqual({ action: 'accept' });
    await dispose();
    expect(failures).toEqual(['test-agent']);
    expect(responses).toEqual([{ action: 'accept' }]);
    requests.close();
  });

  it('keeps concurrent request choices and connection-local completion IDs independent', async () => {
    const first = new ElicitationRequests();
    const second = new ElicitationRequests();
    const choices = new Map<string, (action: 'accept' | 'decline') => void>();
    const opened: string[] = [];
    const prompt: UrlElicitationPrompt = {
      choose: (_agent, interaction) => new Promise((resolve) => { choices.set(interaction.url, resolve); }),
      open: (url) => { opened.push(url); return Promise.resolve(true); },
      failed: () => { throw new Error('Unexpected failure'); },
    };
    const detachFirst = attachUrlElicitations('first', first, prompt);
    const detachSecond = attachUrlElicitations('second', second, prompt);
    const a = first.create(request);
    const b = first.create({ ...request, elicitationId: 'other', url: 'https://example.org/other' });
    const c = second.create({ ...request, url: 'https://example.org/second' });
    choices.get('https://example.org/other')?.('decline');
    expect(await b).toEqual({ action: 'decline' });
    choices.get('https://example.org/second')?.('accept');
    expect(await c).toEqual({ action: 'accept' });
    first.complete('external');
    expect(second.snapshot()).toMatchObject([{ status: 'awaitingCompletion', completed: false }]);
    choices.get(request.url)?.('accept');
    expect(await a).toEqual({ action: 'accept' });
    await Promise.all([detachFirst(), detachSecond()]);
    expect(first.snapshot()).toEqual([]);
    expect(opened).toEqual(['https://example.org/second', request.url]);
    second.complete('external');
    expect(second.snapshot()).toEqual([]);
    first.close();
    second.close();
  });
});
