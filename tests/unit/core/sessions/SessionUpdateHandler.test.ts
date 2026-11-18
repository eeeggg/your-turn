import { describe, expect, it, vi } from 'vitest';
import type { SessionUpdate } from '@/core/acp/AcpDriver';
import { SessionUpdateHandler, type SessionDelivery } from '@/core/sessions/UpdateHandler';

const SESSION_ID = 'f46de271-4614-4bbf-a2cd-c6ea2160a19f';
const OTHER_SESSION_ID = 'ebc4bda3-f73e-41fc-bf94-b3ebd28d2177';

function chunk(text: string): SessionUpdate {
  return { kind: 'agentText', messageId: null, text };
}

function delivery(sessionId: string, update: SessionUpdate, schema: 'v1' | 'v2' = 'v1'): SessionDelivery {
  return { input: { origin: { identity: { configuredName: 'fake', sessionId }, sourceId: 'source' }, update, schema }, registration: undefined };
}

describe('SessionUpdateHandler', () => {
  it('delivers each update to every listener in registration order', () => {
    const handler = new SessionUpdateHandler();
    const received: string[] = [];
    handler.addListener(({ input }) => received.push(`first:${input.origin.identity.sessionId}`));
    handler.addListener(({ input }) => received.push(`second:${input.origin.identity.sessionId}`));

    handler.handleUpdate(delivery(SESSION_ID, chunk('a')));
    handler.handleUpdate(delivery(OTHER_SESSION_ID, chunk('b')));

    expect(received).toEqual([`first:${SESSION_ID}`, `second:${SESSION_ID}`, `first:${OTHER_SESSION_ID}`, `second:${OTHER_SESSION_ID}`]);
  });

  it('passes the update through unchanged, with the schema of the driver that passed it up', () => {
    const handler = new SessionUpdateHandler();
    const listener = vi.fn();
    handler.addListener(listener);
    const update = chunk('hello');

    const input = delivery(SESSION_ID, update, 'v2');
    handler.handleUpdate(input);

    expect(listener).toHaveBeenCalledExactlyOnceWith(input);
    expect(listener.mock.calls[0]?.[0]).toBe(input);
    listener.mockClear();
    const registered = { ...input, registration: { sessionId: SESSION_ID, agentId: 'source', agentName: 'fake' } };
    handler.handleUpdate(registered);
    expect(listener).toHaveBeenCalledExactlyOnceWith(registered);
  });

  it('registers a listener once even if it is added twice', () => {
    const handler = new SessionUpdateHandler();
    const listener = vi.fn();
    handler.addListener(listener);
    handler.addListener(listener);

    handler.handleUpdate(delivery(SESSION_ID, chunk('a')));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops delivering to a removed listener', () => {
    const handler = new SessionUpdateHandler();
    const removed = vi.fn();
    const kept = vi.fn();
    handler.addListener(removed);
    handler.addListener(kept);

    handler.removeListener(removed);
    handler.handleUpdate(delivery(SESSION_ID, chunk('a')));

    expect(removed).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledTimes(1);
  });

  it('keeps delivering to later listeners when one throws', () => {
    const handler = new SessionUpdateHandler();
    const later = vi.fn();
    handler.addListener(() => {
      throw new Error('listener failed');
    });
    handler.addListener(later);

    expect(() => handler.handleUpdate(delivery(SESSION_ID, chunk('a')))).not.toThrow();
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('delivers nothing after dispose', () => {
    const handler = new SessionUpdateHandler();
    const listener = vi.fn();
    handler.addListener(listener);

    handler.dispose();
    handler.handleUpdate(delivery(SESSION_ID, chunk('a')));

    expect(listener).not.toHaveBeenCalled();
  });
});
