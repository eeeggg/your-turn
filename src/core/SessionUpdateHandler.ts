import type { AcpSchema, SessionUpdate } from '@/core/acp/AcpDriver';
import { log, messageOf } from './Log';

/** `schema` names the driver that passed the update up. */
export type SessionUpdateListener = (sessionId: string, update: SessionUpdate, schema: AcpSchema) => void;

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

  handleUpdate(sessionId: string, update: SessionUpdate, schema: AcpSchema): void {
    for (const listener of this.listeners) {
      try {
        listener(sessionId, update, schema);
      } catch (e) {
        log(`Error in session update listener: ${messageOf(e)}`);
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
