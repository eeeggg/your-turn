import { describe, expect, it } from 'vitest';
import { StartupRequests, type KeyValueStore, type SessionAddress } from '@/core/PersistedState';
import { WorkspaceOpening } from '@/core/WorkspaceOpening';
import { ScriptedUser } from '@tests/unit/core/ScriptedUser';

const address: SessionAddress = {
  configuredName: 'Claude',
  sessionId: 's1',
  cwd: '/home/me/api',
  host: 'vscode-remote://ssh-remote+devenv',
  workspaceUri: 'vscode-remote://ssh-remote%2Bdevenv/home/me/api',
};

/** Global state that reads a change back at once and finishes writing it a step later, saying so in `log`. */
function loggingStore(log: string[]): KeyValueStore {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: (key, value) => {
      values.set(key, value);
      return Promise.resolve().then(() => { log.push('written'); });
    },
  };
}

describe('WorkspaceOpening', () => {
  it("asks the window opening the session's workspace to load it, opening the workspace once that is written", async () => {
    const log: string[] = [];
    const globalState = loggingStore(log);
    const opening = new WorkspaceOpening(new StartupRequests(globalState), async (uri) => { log.push(`opened ${uri}`); }, new ScriptedUser());

    await opening.open(address);

    expect(log).toEqual(['written', `opened ${address.workspaceUri}`]);
    expect(await new StartupRequests(globalState).take(address.workspaceUri)).toEqual(address);
  });

  it('reports a workspace that cannot be opened', async () => {
    const user = new ScriptedUser();
    const opening = new WorkspaceOpening(new StartupRequests(loggingStore([])), async () => {
      throw new Error('Unable to resolve workspace');
    }, user);

    await opening.open(address);

    expect(user.take()).toEqual([{
      call: 'showErrorMessage',
      message: `Failed to open the workspace ${address.workspaceUri}: Unable to resolve workspace`,
    }]);
  });
});
