import type { ElicitationRequest, ElicitationResponse, PermissionOutcome, PermissionRequest } from '@/core/acp/AcpDriver';

export interface Permissions {
  requestPermission(request: PermissionRequest, signal?: AbortSignal): Promise<PermissionOutcome>;
  cancelSession(sessionId: string): void;
}

export interface Elicitations {
  create(request: ElicitationRequest, signal?: AbortSignal): Promise<ElicitationResponse>;
  complete(elicitationId: string): void;
  close(): void;
}

/** What one connection's client requests are answered by; each connection gets its own. */
export interface ClientHandlers {
  permissions: Permissions;
  elicitations?: Elicitations;
}
