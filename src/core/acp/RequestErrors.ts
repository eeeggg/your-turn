import { RequestError } from '@agentclientprotocol/sdk';
import { messageOf } from '@/core/Log';
import { AuthRequired, UnknownSession } from '@/core/acp/AcpDriver';

/** ACP's "resource not found", which names a session it is about in `data.sessionId`; the same in every version. */
const RESOURCE_NOT_FOUND = -32002;

/** ACP's "auth required" (-32000), which some agents report only in the message; the same in every version. */
export function isAuthRequired(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) { return false; }
  return ('code' in e && e.code === -32000)
    || ('message' in e && typeof e.message === 'string' && /auth.?required/i.test(e.message));
}

/** Only ACP's own report of the session as unknown; any other refusal is a failure like the rest. */
function isUnknownSession(e: unknown, sessionId: string): boolean {
  return e instanceof RequestError && e.code === RESOURCE_NOT_FOUND
    && typeof e.data === 'object' && e.data !== null
    && 'sessionId' in e.data && e.data.sessionId === sessionId;
}

export async function authChecked<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (e) {
    throw isAuthRequired(e) ? new AuthRequired(messageOf(e), { cause: e }) : e;
  }
}

/** For a request naming `sessionId`, a session the agent may no longer know. */
export async function sessionChecked<T>(sessionId: string, request: Promise<T>): Promise<T> {
  try {
    return await authChecked(request);
  } catch (e) {
    throw !(e instanceof AuthRequired) && isUnknownSession(e, sessionId) ? new UnknownSession(messageOf(e), { cause: e }) : e;
  }
}
