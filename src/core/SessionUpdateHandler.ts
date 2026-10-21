import type { SessionUpdate } from '@/core/acp/AcpDriver';
import { log, messageOf } from './Log';

export type SessionUpdateListener = (sessionId: string, update: SessionUpdate) => void;

/**
 * Routes the session updates of every connection's ACP driver to registered listeners.
 * The ChatViewController registers as a listener to forward updates to the webview.
 */
export class SessionUpdateHandler {
  private listeners = new Set<SessionUpdateListener>();

  addListener(listener: SessionUpdateListener): void {
    this.listeners.add(listener);
  }

  removeListener(listener: SessionUpdateListener): void {
    this.listeners.delete(listener);
  }

  handleUpdate(sessionId: string, update: SessionUpdate): void {
    for (const listener of this.listeners) {
      try {
        listener(sessionId, update);
      } catch (e) {
        log(`Error in session update listener: ${messageOf(e)}`);
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
