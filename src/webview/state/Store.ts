/** What an update makes of one action: the next state, and the messages to post to the extension. */
export interface Transition<S, O> {
  state: S;
  outgoing: readonly O[];
}

/**
 * The webview's state, changed only by dispatching actions through a pure
 * `update`. `subscribe` and `getSnapshot` are the contract React's
 * `useSyncExternalStore` takes.
 */
export interface Store<S, A> {
  subscribe: (onStoreChange: () => void) => () => void;
  getSnapshot: () => S;
  dispatch: (action: A) => void;
}

/**
 * Listeners hear only of actions that change the state; `update` returns the same object for the rest.
 * `update` is handed the time of each dispatch, in milliseconds since the epoch, so it never reads a clock itself.
 */
export function createStore<S, A, O>(
  initial: S,
  update: (state: S, action: A, now: number) => Transition<S, O>,
  post: (message: O) => void,
  clock: () => number = () => Date.now(),
): Store<S, A> {
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
    dispatch(action) {
      const next = update(state, action, clock());
      const changed = next.state !== state;
      state = next.state;
      next.outgoing.forEach((message) => post(message));
      if (changed) {
        listeners.forEach((listener) => listener());
      }
    },
  };
}
