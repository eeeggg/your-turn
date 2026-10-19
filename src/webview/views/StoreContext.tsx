import { createContext, use, useSyncExternalStore } from 'react';
import type { Action, RootState } from '@/webview/state/RootState';
import type { Store } from '@/webview/state/Store';

export const StoreContext = createContext<Store<RootState, Action> | null>(null);

function useStore(): Store<RootState, Action> {
  const store = use(StoreContext);
  if (!store) {
    throw new Error('Chat view components must render inside a StoreContext.');
  }
  return store;
}

/** `select` must return a part of the state, not build a new object, or every render looks like a change. */
export function useSelector<T>(select: (state: RootState) => T): T {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => select(store.getSnapshot()));
}

export function useDispatch(): (action: Action) => void {
  return useStore().dispatch;
}
