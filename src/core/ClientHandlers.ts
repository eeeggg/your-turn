import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

export interface Permissions {
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
}

/** What one connection's client requests are answered by; each connection gets its own. */
export interface ClientHandlers {
  permissions: Permissions;
}
