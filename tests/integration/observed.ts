import type { Disposable, Event } from 'vscode';
import { suiteTeardown, teardown } from 'mocha';
import type { ExtensionToWebviewMessage } from '@/shared/WebviewMessages';

export function promptTarget(posts: readonly ExtensionToWebviewMessage[]) {
  const snapshot = [...posts].reverse().flatMap((message) => message.type === 'viewSnapshot' ? message.content ? [message.content] : []
    : message.type === 'contentSnapshot' && message.readingRequest === undefined ? [message] : [])[0];
  if (!snapshot) { throw new Error('Missing issued projection'); }
  return snapshot.target;
}

const pending = new Set<() => void>();
teardown(() => { for (const cancel of pending) { cancel(); } });
suiteTeardown(() => { for (const cancel of pending) { cancel(); } });

/**
 * Reads observable state now and after any event that can change it, settling
 * once `read` finds it. Reading once more after subscription closes the gap
 * between the first read and listener registration.
 */
export function observed<T>(events: Event<unknown> | readonly Event<unknown>[], read: () => T | undefined): Promise<T> {
  const observation = new Promise<T>((resolve, reject) => {
    const sources: readonly Event<unknown>[] = typeof events === 'function' ? [events] : events;
    const subscriptions: Disposable[] = [];
    const state = { finished: false };
    const finished = () => state.finished;
    const cleanup = () => {
      state.finished = true;
      pending.delete(cancel);
      for (const subscription of subscriptions.splice(0)) { subscription.dispose(); }
    };
    const cancel = () => { cleanup(); reject(new DOMException('Observation cancelled at test teardown', 'AbortError')); };
    const changed = () => {
      if (state.finished) { return; }
      try {
        const next = read();
        if (next !== undefined) { cleanup(); resolve(next); }
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error('Observation read failed', { cause: error }));
      }
    };
    pending.add(cancel);
    changed();
    try {
      for (const event of sources) {
        if (state.finished) { break; }
        const subscription = event(changed);
        if (finished()) { subscription.dispose(); } else { subscriptions.push(subscription); }
      }
      changed();
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error('Observation subscription failed', { cause: error }));
    }
  });
  // An action can fail before its observation is awaited; teardown still owns it.
  void observation.catch(() => {});
  return observation;
}
