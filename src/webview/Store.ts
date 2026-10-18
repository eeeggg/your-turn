/** What an update makes of one event: the next state, and the messages to post to the extension. */
export interface Transition<S, O> {
  state: S;
  outgoing: readonly O[];
}

/**
 * The webview's state, changed only by dispatching events through a pure
 * `update`. `subscribe` and `getSnapshot` are the contract React's
 * `useSyncExternalStore` takes.
 */
export interface Store<S, E> {
  subscribe(onStoreChange: () => void): () => void;
  getSnapshot(): S;
  dispatch(event: E): void;
}

/** Listeners hear only of events that change the state; `update` returns the same object for the rest. */
export function createStore<S, E, O>(
  initial: S,
  update: (state: S, event: E) => Transition<S, O>,
  post: (message: O) => void,
): Store<S, E> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    subscribe(onStoreChange) {
      listeners.add(onStoreChange);
      return () => {
        listeners.delete(onStoreChange);
      };
    },
    getSnapshot: () => state,
    dispatch(event) {
      const next = update(state, event);
      const changed = next.state !== state;
      state = next.state;
      next.outgoing.forEach((message) => post(message));
      if (changed) {
        listeners.forEach((listener) => listener());
      }
    },
  };
}
