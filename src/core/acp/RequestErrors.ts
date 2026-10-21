import { messageOf } from '@/core/Log';
import { AuthRequired, UnknownSession } from './AcpDriver';

/** ACP's "auth required" (-32000), which some agents report only in the message; the same in every version. */
export function isAuthRequired(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) { return false; }
  return ('code' in e && e.code === -32000)
    || ('message' in e && typeof e.message === 'string' && /auth.?required/i.test(e.message));
}

function isUnknownSession(e: unknown): boolean {
  return typeof e === 'object' && e !== null
    && 'message' in e && typeof e.message === 'string'
    && /not found|no such|unknown session/i.test(e.message);
}

export async function authChecked<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (e) {
    throw isAuthRequired(e) ? new AuthRequired(messageOf(e), { cause: e }) : e;
  }
}

/** For a request naming a session the agent may no longer know. */
export async function sessionChecked<T>(request: Promise<T>): Promise<T> {
  try {
    return await authChecked(request);
  } catch (e) {
    throw !(e instanceof AuthRequired) && isUnknownSession(e) ? new UnknownSession(messageOf(e), { cause: e }) : e;
  }
}
