import { describe, expect, it, vi } from 'vitest';
import { observed } from '@tests/integration/observed';

const hooks = vi.hoisted(() => ({ cleanup: () => {} }));
vi.mock('mocha', () => ({ teardown: (cleanup: () => void) => { hooks.cleanup = cleanup; }, suiteTeardown: () => {} }));

function source() {
  const listeners = new Set<(value: unknown) => void>();
  return {
    event: (listener: (value: unknown) => void) => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
    fire: () => { for (const listener of listeners) { listener(undefined); } },
    size: () => listeners.size,
  };
}

describe('owned event observation', () => {
  it('cancels unresolved observations at the test boundary', async () => {
    const event = source();
    const waiting = observed(event.event, () => undefined);
    const outcome = waiting.catch((error: unknown) => error);
    hooks.cleanup();
    expect(event.size()).toBe(0);
    expect(await outcome).toMatchObject({ name: 'AbortError' });
  });

  it('rejects a failed read and removes every subscription', async () => {
    const first = source();
    const second = source();
    const failure = new Error('read failed');
    let broken = false;
    const waiting = observed([first.event, second.event], () => { if (broken) { throw failure; } return undefined; });
    const outcome = waiting.catch((error: unknown) => error);
    try {
      broken = true;
      expect(() => first.fire()).not.toThrow();
      expect(await outcome).toBe(failure);
      expect(first.size() + second.size()).toBe(0);
    } finally {
      hooks.cleanup();
    }
  });

  it('resolves from observable state and detaches from sibling sources', async () => {
    const first = source();
    const second = source();
    let ready = false;
    const waiting = observed([first.event, second.event], () => ready ? 'ready' : undefined);
    try {
      ready = true;
      second.fire();
      expect(await waiting).toBe('ready');
      expect(first.size() + second.size()).toBe(0);
    } finally { hooks.cleanup(); }
  });

  it('detaches a subscription that delivers synchronously before returning its disposable', async () => {
    let ready = false;
    let disposed = false;
    const event = (changed: (value: unknown) => void) => {
      ready = true;
      changed(undefined);
      return { dispose: () => { disposed = true; } };
    };
    try {
      expect(await observed(event, () => ready ? 'ready' : undefined)).toBe('ready');
      expect(disposed).toBe(true);
    } finally { hooks.cleanup(); }
  });

  it('rejects a subscription failure after detaching earlier sources', async () => {
    const first = source();
    const failure = new Error('subscription failed');
    const broken = () => { throw failure; };
    try {
      await expect(observed([first.event, broken], () => undefined)).rejects.toBe(failure);
      expect(first.size()).toBe(0);
    } finally { hooks.cleanup(); }
  });

  it('reads again after registration when state changes without delivering an event', async () => {
    let ready = false;
    let disposed = false;
    const event = () => {
      ready = true;
      return { dispose: () => { disposed = true; } };
    };
    try {
      expect(await observed(event, () => ready ? 'ready' : undefined)).toBe('ready');
      expect(disposed).toBe(true);
    } finally { hooks.cleanup(); }
  });
});
