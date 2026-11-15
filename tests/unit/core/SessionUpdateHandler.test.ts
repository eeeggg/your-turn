import { describe, expect, it, vi } from 'vitest';
import type { SessionUpdate } from '@/core/acp/AcpDriver';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';

const SESSION_ID = 'f46de271-4614-4bbf-a2cd-c6ea2160a19f';
const OTHER_SESSION_ID = 'ebc4bda3-f73e-41fc-bf94-b3ebd28d2177';

function chunk(text: string): SessionUpdate {
  return { kind: 'agentText', messageId: null, text };
}

describe('SessionUpdateHandler', () => {
  it('delivers each update to every listener in registration order', () => {
    const handler = new SessionUpdateHandler();
    const received: string[] = [];
    handler.addListener((sessionId) => received.push(`first:${sessionId}`));
    handler.addListener((sessionId) => received.push(`second:${sessionId}`));

    handler.handleUpdate(SESSION_ID, chunk('a'), 'v1');
    handler.handleUpdate(OTHER_SESSION_ID, chunk('b'), 'v1');

    expect(received).toEqual([`first:${SESSION_ID}`, `second:${SESSION_ID}`, `first:${OTHER_SESSION_ID}`, `second:${OTHER_SESSION_ID}`]);
  });

  it('passes the update through unchanged, with the schema of the driver that passed it up', () => {
    const handler = new SessionUpdateHandler();
    const listener = vi.fn();
    handler.addListener(listener);
    const update = chunk('hello');

    handler.handleUpdate(SESSION_ID, update, 'v2');

    expect(listener).toHaveBeenCalledExactlyOnceWith(SESSION_ID, update, 'v2', undefined);
    listener.mockClear();
    handler.handleUpdate(SESSION_ID, update, 'v2', 'connection-1');
    expect(listener).toHaveBeenCalledExactlyOnceWith(SESSION_ID, update, 'v2', 'connection-1');
  });

  it('registers a listener once even if it is added twice', () => {
    const handler = new SessionUpdateHandler();
    const listener = vi.fn();
    handler.addListener(listener);
    handler.addListener(listener);

    handler.handleUpdate(SESSION_ID, chunk('a'), 'v1');

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops delivering to a removed listener', () => {
    const handler = new SessionUpdateHandler();
    const removed = vi.fn();
    const kept = vi.fn();
    handler.addListener(removed);
    handler.addListener(kept);

    handler.removeListener(removed);
    handler.handleUpdate(SESSION_ID, chunk('a'), 'v1');

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

    expect(() => handler.handleUpdate(SESSION_ID, chunk('a'), 'v1')).not.toThrow();
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('delivers nothing after dispose', () => {
    const handler = new SessionUpdateHandler();
    const listener = vi.fn();
    handler.addListener(listener);

    handler.dispose();
    handler.handleUpdate(SESSION_ID, chunk('a'), 'v1');

    expect(listener).not.toHaveBeenCalled();
  });
});
