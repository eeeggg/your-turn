import { log, messageOf } from './Log';

import type { SessionNotification } from '@agentclientprotocol/sdk';

export type SessionUpdateListener = (update: SessionNotification) => void;

/**
 * Routes session/update notifications to registered listeners.
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

  handleUpdate(update: SessionNotification): void {
    log(`sessionUpdate: type=${update.update.sessionUpdate}, sessionId=${update.sessionId}`);

    for (const listener of this.listeners) {
      try {
        listener(update);
      } catch (e) {
        log(`Error in session update listener: ${messageOf(e)}`);
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
