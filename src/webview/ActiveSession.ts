import type { Action } from '@/webview/RootState';

/** The session the chat view shows, and whether a turn is running in it. */
export interface ActiveSession {
  readonly sessionId: string;
  readonly agentName: string;
  readonly title: string | null;
  readonly cwd: string;
  /** From `promptStart` to `promptEnd`, which the extension sends once every prompt sent mid-turn has returned. */
  readonly turnRunning: boolean;
}

/** The title when the session has one, else the agent's name. */
export function sessionName(session: ActiveSession): string {
  return session.title || session.agentName;
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
      return {
        sessionId: next.sessionId,
        agentName: next.agentName,
        title: next.title ?? null,
        cwd: next.cwd,
        turnRunning: session?.sessionId === next.sessionId && session.turnRunning,
      };
    }
    case 'clearTranscript':
      return null;
    case 'sessionInfoUpdate':
      return session && { ...session, title: action.title };
    case 'promptStart':
      return withTurn(session, true);
    case 'promptEnd':
    case 'loadSessionStart':
      return withTurn(session, false);
    default:
      return session;
  }
}

function withTurn(session: ActiveSession | null, turnRunning: boolean): ActiveSession | null {
  return session && session.turnRunning !== turnRunning ? { ...session, turnRunning } : session;
}
