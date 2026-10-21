import type { SlashCommand, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import type { Action } from '@/webview/state/RootState';

/** The session the chat view shows, whether a turn is running in it, and whether it is still loading. */
export interface ActiveSession {
  readonly sessionId: string;
  readonly agentName: string;
  readonly title: string | null;
  readonly cwd: string;
  readonly commands: readonly SlashCommand[];
  /** From the webview posting a prompt, or the extension's `promptStart`, to `promptEnd`. */
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
        commands: next.commands,
        turnRunning: same && session.turnRunning,
        loading: same && session.loading,
      };
    }
    case 'clearTranscript':
    case 'sessionEnded':
      return null;
    case 'sessionInfoUpdate':
      return session && { ...session, title: action.title };
    case 'commands':
      return session && { ...session, commands: action.commands };
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

/** A posted prompt starts its turn at once, before its `promptStart` arrives, so the next prompt waits in the queue. */
export function withPromptsPosted(session: ActiveSession | null, outgoing: readonly WebviewToExtensionMessage[]): ActiveSession | null {
  return outgoing.some((message) => message.type === 'sendPrompt') ? withChanges(session, { turnRunning: true }) : session;
}

function withChanges(session: ActiveSession | null, changes: Partial<ActiveSession>): ActiveSession | null {
  if (!session) {
    return null;
  }
  const keys = Object.keys(changes) as (keyof ActiveSession)[];
  return keys.every((key) => session[key] === changes[key]) ? session : { ...session, ...changes };
}
