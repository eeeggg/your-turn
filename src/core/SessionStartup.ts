import { UnknownSession } from './acp/AcpDriver';
import { messageOf } from './Log';
import type { SessionAddress, WorkspaceState } from './PersistedState';
import type { SessionEnvironment, SessionInfo, SessionManager } from './SessionManager';

/** Why a session did not open, and what the user is told; its reference stays either way. */
export interface OpeningFailure {
  /**
   * `unconfigured`: no configuration has the name tried. `cwdChanged`: the workspace's agent cwd is no longer the
   * session's. `loadUnsupported`: the agent cannot load sessions, or for Open Session, cannot resume them either.
   * `failed`: the agent could not start, or refused, as the message says.
   */
  kind: 'unconfigured' | 'cwdChanged' | 'loadUnsupported' | 'unknownSession' | 'failed';
  message: string;
}

/** The failure an error opening a session means. */
export function openingFailure(e: unknown): OpeningFailure {
  return { kind: e instanceof UnknownSession ? 'unknownSession' : 'failed', message: messageOf(e) };
}

export type StartupOutcome =
  /** The workspace has no last active session, or a session opened, or was set out to open, first. */
  | { kind: 'nothing' }
  | { kind: 'loaded'; session: SessionInfo }
  /** `configuredName` is the configuration the load was tried through. */
  | { kind: 'failed'; address: SessionAddress; configuredName: string; failure: OpeningFailure };

/**
 * Loads the workspace's last active session when a window starts, through the configuration it was last used through,
 * replaying its transcript; and again, or through another configuration, as the user asks after a failure.
 */
export class SessionStartup {
  private attempted: Promise<StartupOutcome> | undefined;
  private forgone = false;

  constructor(
    private readonly sessions: SessionManager,
    private readonly workspace: WorkspaceState,
    private readonly environment: Pick<SessionEnvironment, 'workspaceRoots' | 'agentConfigs'>,
  ) {
    sessions.on('session-opened', () => { void this.forgo(); });
  }

  /**
   * Load the last active session, unless a session has opened in this activation or the attempt was forgone; only the
   * first call per activation tries.
   */
  attempt(): Promise<StartupOutcome> {
    this.attempted ??= this.first();
    return this.attempted;
  }

  /** Make no attempt from now on, as a session is opening otherwise; settles once an attempt under way has. */
  async forgo(): Promise<void> {
    this.forgone = true;
    await this.attempted;
  }

  /** Load the session through `configuredName`, which its reference and the last active session move to on success. */
  loadThrough(address: SessionAddress, configuredName: string): Promise<StartupOutcome> {
    return this.load(address, configuredName);
  }

  private async first(): Promise<StartupOutcome> {
    const address = this.workspace.lastActiveSession();
    if (this.forgone || !address || this.sessions.getActiveSession()) {
      return { kind: 'nothing' };
    }
    return this.load(address, address.configuredName);
  }

  private async load(address: SessionAddress, configuredName: string): Promise<StartupOutcome> {
    const failed = (failure: OpeningFailure): StartupOutcome => ({ kind: 'failed', address, configuredName, failure });
    if (this.environment.agentConfigs()[configuredName] === undefined) {
      return failed({ kind: 'unconfigured', message: `No agent configuration is named "${configuredName}".` });
    }
    const { cwd } = this.environment.workspaceRoots();
    if (cwd !== address.cwd) {
      return failed({ kind: 'cwdChanged', message: `The session was used in ${address.cwd}, but this workspace's agents run in ${cwd}.` });
    }
    try {
      const capabilities = await this.sessions.ensureConnected(configuredName);
      if (!capabilities.load) {
        return failed({ kind: 'loadUnsupported', message: `Agent "${configuredName}" cannot load sessions.` });
      }
      return { kind: 'loaded', session: await this.sessions.loadSession(configuredName, address.sessionId, address) };
    } catch (e) {
      return failed(openingFailure(e));
    }
  }
}
