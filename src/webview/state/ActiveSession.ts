import type { AvailableCommand } from '@agentclientprotocol/sdk';
import type { Action } from '@/webview/state/RootState';

/** The session the chat view shows, whether a turn is running in it, and whether it is still loading. */
export interface ActiveSession {
  readonly sessionId: string;
  readonly agentName: string;
  readonly title: string | null;
  readonly cwd: string;
  readonly availableCommands: readonly AvailableCommand[];
  /** From `promptStart` to `promptEnd`, which the extension sends once every prompt sent mid-turn has returned. */
  readonly turnRunning: boolean;
  /** From `loadSessionStart` to `loadSessionEnd`, while the agent replays the transcript. */
  readonly loading: boolean;
}

/** The title when the session has one, else the agent's name. */
export function sessionName(session: ActiveSession): string {
  return session.title || session.agentName;
}

/** Whether the user can write and send prompts: only in a session that has finished loading. */
export function canPrompt(session: ActiveSession | null): session is ActiveSession {
  return session !== null && !session.loading;
}

export function updateActiveSession(
  session: ActiveSession | null,
  action: Action,
): ActiveSession | null {
  switch (action.type) {
    case 'state': {
      const next = action.session;
      if (!next) {
        return null;
      }
      const same = session?.sessionId === next.sessionId;
      return {
        sessionId: next.sessionId,
        agentName: next.agentName,
        title: next.title ?? null,
        cwd: next.cwd,
        availableCommands: next.availableCommands,
        turnRunning: same && session.turnRunning,
        loading: same && session.loading,
      };
    }
    case 'clearTranscript':
      return null;
    case 'sessionInfoUpdate':
      return session && { ...session, title: action.title };
    case 'sessionUpdate':
      return action.update.sessionUpdate === 'available_commands_update'
        ? session && { ...session, availableCommands: action.update.availableCommands }
        : session;
    case 'promptStart':
      return withChanges(session, { turnRunning: true });
    case 'promptEnd':
      return withChanges(session, { turnRunning: false });
    case 'loadSessionStart':
      return withChanges(session, { turnRunning: false, loading: true });
    case 'loadSessionEnd':
      return withChanges(session, { loading: false });
    default:
      return session;
  }
}

function withChanges(session: ActiveSession | null, changes: Partial<ActiveSession>): ActiveSession | null {
  if (!session) {
    return null;
  }
  const keys = Object.keys(changes) as (keyof ActiveSession)[];
  return keys.every((key) => session[key] === changes[key]) ? session : { ...session, ...changes };
}
