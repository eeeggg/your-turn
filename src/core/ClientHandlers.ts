import type {
  ElicitationChange,
  ElicitationInteraction,
  ElicitationRequest,
  ElicitationResponse,
  ElicitationResponseResult,
  PermissionOutcome,
  PermissionRequest
} from '@/core/acp/AcpDriver';

export interface Permissions {
  requestPermission(request: PermissionRequest, signal?: AbortSignal): Promise<PermissionOutcome>;
  cancelSession(sessionId: string): void;
}

export interface Elicitations {
  create(request: ElicitationRequest, signal?: AbortSignal): Promise<ElicitationResponse>;
  complete(elicitationId: string): void;
  close(): void;
}

/** The live connection's interaction surface; presentation never owns ACP resolvers. */
export interface ElicitationInteractions {
  snapshot(): readonly ElicitationInteraction[];
  subscribe(listener: (change: ElicitationChange) => void): () => void;
  respond(interactionId: string, response: unknown): ElicitationResponseResult;
}

/** What one connection's client requests are answered by; each connection gets its own. */
export interface ClientHandlers {
  permissions: Permissions;
  elicitations?: Elicitations;
  /** Release connection-specific presentation subscriptions, without answering requests. */
  close?(): void;
}
