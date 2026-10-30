import { logError, messageOf } from './Log';
import type { SessionAddress, StartupRequests } from './PersistedState';
import type { Window } from './VsCodeApi';

/**
 * Opens a session in the window of its workspace: a startup request asks the window opening the workspace to load the
 * session, and only once it is written is the workspace opened. Opening says nothing of whether the session loads
 * there, which only that window knows.
 */
export class WorkspaceOpening {
  constructor(
    private readonly requests: Pick<StartupRequests, 'request'>,
    /** Opens a workspace stored as the client sees it in a new window, or brings forward the window it is open in. */
    private readonly openWorkspace: (workspaceUri: string) => PromiseLike<void>,
    private readonly window: Pick<Window, 'showErrorMessage'>,
  ) {}

  /** A workspace that cannot be opened is reported; its session's reference stays, and its request expires unread. */
  async open(address: SessionAddress): Promise<void> {
    await this.requests.request(address);
    try {
      await this.openWorkspace(address.workspaceUri);
    } catch (e) {
      logError('Failed to open workspace', e, { workspaceUri: address.workspaceUri });
      void this.window.showErrorMessage(`Failed to open the workspace ${address.workspaceUri}: ${messageOf(e)}`);
    }
  }
}
