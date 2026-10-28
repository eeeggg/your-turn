import type { PermissionOutcome, PermissionRequest } from '@/core/acp/AcpDriver';

export interface Permissions {
  requestPermission(request: PermissionRequest, signal?: AbortSignal): Promise<PermissionOutcome>;
  cancelSession(sessionId: string): void;
}

/** What one connection's client requests are answered by; each connection gets its own. */
export interface ClientHandlers {
  permissions: Permissions;
}
