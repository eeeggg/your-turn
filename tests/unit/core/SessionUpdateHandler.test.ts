import { describe, expect, it, vi } from 'vitest';
import type { SessionUpdate } from '@/core/acp/AcpDriver';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';

function chunk(text: string): SessionUpdate {
  return { kind: 'agentText', messageId: null, text };
}

describe('SessionUpdateHandler', () => {
  it('delivers each update to every listener in registration order', () => {
    const handler = new SessionUpdateHandler();
    const received: string[] = [];
    handler.addListener((sessionId) => received.push(`first:${sessionId}`));
    handler.addListener((sessionId) => received.push(`second:${sessionId}`));

    handler.handleUpdate('s1', chunk('a'));
    handler.handleUpdate('s2', chunk('b'));

    expect(received).toEqual(['first:s1', 'second:s1', 'first:s2', 'second:s2']);
  });

  it('passes the update through unchanged', () => {
    const handler = new SessionUpdateHandler();
    const listener = vi.fn();
    handler.addListener(listener);
    const update = chunk('hello');

    handler.handleUpdate('s1', update);

    expect(listener).toHaveBeenCalledExactlyOnceWith('s1', update);
  });

  it('registers a listener once even if it is added twice', () => {
    const handler = new SessionUpdateHandler();
    const listener = vi.fn();
    handler.addListener(listener);
    handler.addListener(listener);

    handler.handleUpdate('s1', chunk('a'));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops delivering to a removed listener', () => {
    const handler = new SessionUpdateHandler();
    const removed = vi.fn();
    const kept = vi.fn();
    handler.addListener(removed);
    handler.addListener(kept);

    handler.removeListener(removed);
    handler.handleUpdate('s1', chunk('a'));

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

    expect(() => handler.handleUpdate('s1', chunk('a'))).not.toThrow();
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('delivers nothing after dispose', () => {
    const handler = new SessionUpdateHandler();
    const listener = vi.fn();
    handler.addListener(listener);

    handler.dispose();
    handler.handleUpdate('s1', chunk('a'));

    expect(listener).not.toHaveBeenCalled();
  });
});
