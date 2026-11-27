import type { AcpSchema, SessionUpdate } from '@/core/acp/AcpDriver';
import { logError } from '@/core/Log';

export interface SessionIdentity {
  readonly configuredName: string;
  readonly sessionId: string;
}

export interface SessionOrigin {
  readonly identity: SessionIdentity;
  readonly sourceId: string;
}

export interface QualifiedSessionUpdate {
  readonly origin: SessionOrigin;
  /** The confirmed delegation root owns review associations; origin still identifies the reporter. */
  readonly reviewOwner?: SessionIdentity;
  readonly update: SessionUpdate;
  readonly schema: AcpSchema;
}

export interface SessionRegistration {
  readonly sessionId: string;
  readonly agentId: string;
  readonly agentName: string;
}

export interface SessionDelivery {
  readonly input: QualifiedSessionUpdate;
  readonly registration: SessionRegistration | undefined;
}

export interface SessionLoad {
  readonly registration: SessionRegistration;
  readonly origin: SessionOrigin;
  readonly attempt: symbol;
}

export type SessionUpdateListener = (delivery: SessionDelivery) => void;

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

  handleUpdate(delivery: SessionDelivery): void {
    for (const listener of this.listeners) {
      try {
        listener(delivery);
      } catch (e) {
        logError('Error in session update listener', e);
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
