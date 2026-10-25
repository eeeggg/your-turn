import type { Disposable, Event } from 'vscode';

/**
 * Reads observable state now and after any event that can change it, settling
 * once `read` finds it. Reading once more after subscription closes the gap
 * between the first read and listener registration.
 */
export function observed<T>(events: Event<unknown> | readonly Event<unknown>[], read: () => T | undefined): Promise<T> {
  const found = read();
  if (found !== undefined) { return Promise.resolve(found); }
  return new Promise((resolve) => {
    const sources: readonly Event<unknown>[] = typeof events === 'function' ? [events] : events;
    const subscriptions: Disposable[] = [];
    const changed = () => {
      const next = read();
      if (next !== undefined) {
        for (const subscription of subscriptions) { subscription.dispose(); }
        resolve(next);
      }
    };
    for (const event of sources) {
      subscriptions.push(event(changed));
    }
    changed();
  });
}
