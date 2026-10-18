import { createContext, use, useSyncExternalStore } from 'react';
import type { ChatEvent, ChatState } from '@/webview/ChatState';
import type { Store } from '@/webview/Store';

export const StoreContext = createContext<Store<ChatState, ChatEvent> | null>(null);

function useStore(): Store<ChatState, ChatEvent> {
  const store = use(StoreContext);
  if (!store) {
    throw new Error('Chat views must render inside a StoreContext.');
  }
  return store;
}

/** `select` must return a part of the state, not build a new object, or every render looks like a change. */
export function useChatState<T>(select: (state: ChatState) => T): T {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => select(store.getSnapshot()));
}

export function useDispatch(): (event: ChatEvent) => void {
  return useStore().dispatch;
}
