import { describe, expect, it, vi } from 'vitest';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';

function chunk(sessionId: string, text: string): SessionNotification {
  return { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } };
}

describe('SessionUpdateHandler', () => {
  it('delivers each update to every listener in registration order', () => {
    const handler = new SessionUpdateHandler();
    const received: string[] = [];
    handler.addListener((u) => received.push(`first:${u.sessionId}`));
    handler.addListener((u) => received.push(`second:${u.sessionId}`));

    handler.handleUpdate(chunk('s1', 'a'));
    handler.handleUpdate(chunk('s2', 'b'));

    expect(received).toEqual(['first:s1', 'second:s1', 'first:s2', 'second:s2']);
  });

  it('passes the notification through unchanged', () => {
    const handler = new SessionUpdateHandler();
    const listener = vi.fn();
    handler.addListener(listener);
    const update = chunk('s1', 'hello');

    handler.handleUpdate(update);

    expect(listener).toHaveBeenCalledExactlyOnceWith(update);
  });

  it('registers a listener once even if it is added twice', () => {
    const handler = new SessionUpdateHandler();
    const listener = vi.fn();
    handler.addListener(listener);
    handler.addListener(listener);

    handler.handleUpdate(chunk('s1', 'a'));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops delivering to a removed listener', () => {
    const handler = new SessionUpdateHandler();
    const removed = vi.fn();
    const kept = vi.fn();
    handler.addListener(removed);
    handler.addListener(kept);

    handler.removeListener(removed);
    handler.handleUpdate(chunk('s1', 'a'));

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

    expect(() => handler.handleUpdate(chunk('s1', 'a'))).not.toThrow();
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('delivers updates without a sessionUpdate field', () => {
    const handler = new SessionUpdateHandler();
    const listener = vi.fn();
    handler.addListener(listener);
    const malformed = { sessionId: 's1', update: {} } as unknown as SessionNotification;

    handler.handleUpdate(malformed);

    expect(listener).toHaveBeenCalledExactlyOnceWith(malformed);
  });

  it('delivers nothing after dispose', () => {
    const handler = new SessionUpdateHandler();
    const listener = vi.fn();
    handler.addListener(listener);

    handler.dispose();
    handler.handleUpdate(chunk('s1', 'a'));

    expect(listener).not.toHaveBeenCalled();
  });
});
