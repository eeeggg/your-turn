import type { PermissionOutcome, PermissionRequest } from '@/core/acp/AcpDriver';

export interface Permissions {
  requestPermission(request: PermissionRequest): Promise<PermissionOutcome>;
}

/** What one connection's client requests are answered by; each connection gets its own. */
export interface ClientHandlers {
  permissions: Permissions;
}
