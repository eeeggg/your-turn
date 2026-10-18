import { describe, expect, it } from 'vitest';
import { createStore, type Transition } from '@/webview/Store';

type Event = { type: 'add'; amount: number } | { type: 'report' };

function update(state: number, event: Event): Transition<number, string> {
  return event.type === 'add'
    ? { state: state + event.amount, outgoing: [] }
    : { state, outgoing: [`at ${state}`] };
}

function counter() {
  const posted: string[] = [];
  const store = createStore(0, update, (message: string) => posted.push(message));
  let notified = 0;
  const unsubscribe = store.subscribe(() => notified++);
  return { store, posted, notifications: () => notified, unsubscribe };
}

describe('Store', () => {
  it('applies each event to the state', () => {
    const { store } = counter();

    store.dispatch({ type: 'add', amount: 2 });
    store.dispatch({ type: 'add', amount: 3 });

    expect(store.getSnapshot()).toBe(5);
  });

  it('notifies subscribers only of events that change the state', () => {
    const { store, notifications } = counter();

    store.dispatch({ type: 'add', amount: 0 });
    store.dispatch({ type: 'report' });
    store.dispatch({ type: 'add', amount: 1 });

    expect(notifications()).toBe(1);
  });

  it('posts the outgoing messages, whether or not the state changed', () => {
    const { store, posted } = counter();

    store.dispatch({ type: 'report' });
    store.dispatch({ type: 'add', amount: 4 });
    store.dispatch({ type: 'report' });

    expect(posted).toEqual(['at 0', 'at 4']);
  });

  it('stops notifying a subscriber once it unsubscribes', () => {
    const { store, notifications, unsubscribe } = counter();

    unsubscribe();
    store.dispatch({ type: 'add', amount: 1 });

    expect(notifications()).toBe(0);
  });
});
