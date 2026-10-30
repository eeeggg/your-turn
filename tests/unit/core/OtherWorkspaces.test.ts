import { describe, expect, it } from 'vitest';
import { otherWorkspaces } from '@/core/OtherWorkspaces';
import type { SessionReference } from '@/core/PersistedState';

const LOCAL = 'file://';
const DEVENV = 'vscode-remote://ssh-remote+devenv';

/** A reference last active `minute` minutes past ten. */
function reference(workspaceUri: string, configuredName: string, sessionId: string, minute: number, host = LOCAL): SessionReference {
  return {
    configuredName,
    sessionId,
    cwd: '/home/me/work',
    host,
    workspaceUri,
    lastActiveAt: `2026-10-29T10:${String(minute).padStart(2, '0')}:00.000Z`,
    selections: { options: {} },
  };
}

const NOW = Date.parse('2026-10-29T12:00:00.000Z');

const shape = (workspaces: ReturnType<typeof otherWorkspaces>) => workspaces.map(({ uri, configurations }) => ({
  uri,
  configurations: configurations.map(({ configuredName, sessions }) => [configuredName, sessions.map((session) => session.reference.sessionId)]),
}));

describe('otherWorkspaces', () => {
  it('groups the sessions by workspace, then configuration, each the most recently used first', () => {
    const references = [
      reference('file:///home/me/api', 'Claude', 'a1', 1),
      reference('file:///home/me/web', 'Codex', 'w1', 2),
      reference('file:///home/me/api', 'Codex', 'a2', 3),
      reference('file:///home/me/api', 'Claude', 'a3', 4),
    ];

    expect(shape(otherWorkspaces(references, undefined, NOW))).toEqual([
      { uri: 'file:///home/me/api', configurations: [['Claude', ['a3', 'a1']], ['Codex', ['a2']]] },
      { uri: 'file:///home/me/web', configurations: [['Codex', ['w1']]] },
    ]);
  });

  it('shows each session by its cached title, or as untitled, with its age and where it was used', () => {
    const titled = { ...reference('vscode-remote://ssh-remote%2Bdevenv/home/me/api', 'Claude', 'a1', 1, DEVENV), title: '  Fix the build  ' };
    const untitled = reference('vscode-remote://ssh-remote%2Bdevenv/home/me/api', 'Claude', 'a2', 0, DEVENV);

    const [workspace] = otherWorkspaces([titled, untitled], undefined, NOW);

    expect(workspace?.configurations[0]?.sessions).toEqual([
      {
        reference: titled,
        label: 'Fix the build',
        age: '1 hour ago',
        tooltip: [
          'Agent: Claude',
          'Session: a1',
          'Workspace: vscode-remote://ssh-remote%2Bdevenv/home/me/api',
          'cwd: /home/me/work',
          'Last active: 2026-10-29T10:01:00.000Z',
        ].join('\n'),
      },
      expect.objectContaining({ reference: untitled, label: 'Untitled', age: '2 hours ago' }),
    ]);
  });

  it("leaves out this window's workspace", () => {
    const references = [
      reference('file:///home/me/api', 'Claude', 'a1', 1),
      reference('file:///home/me/web', 'Claude', 'w1', 2),
    ];

    expect(shape(otherWorkspaces(references, 'file:///home/me/web', NOW))).toEqual([
      { uri: 'file:///home/me/api', configurations: [['Claude', ['a1']]] },
    ]);
  });

  it('lists nothing when every session is in this workspace', () => {
    expect(otherWorkspaces([reference('file:///home/me/web', 'Claude', 'w1', 2)], 'file:///home/me/web', NOW)).toEqual([]);
  });

  it.each([
    { name: 'a local folder by its name', uri: 'file:///home/me/api', host: LOCAL, label: 'api', description: undefined },
    { name: 'a name with escaped characters as written', uri: 'file:///home/me/my%20app', host: LOCAL, label: 'my app', description: undefined },
    { name: 'a saved workspace by its file name', uri: 'file:///home/me/team.code-workspace', host: LOCAL, label: 'team (Workspace)', description: undefined },
    {
      name: 'a remote folder with its host',
      uri: 'vscode-remote://ssh-remote%2Bdevenv/home/me/api',
      host: DEVENV,
      label: 'api',
      description: 'ssh-remote+devenv',
    },
    {
      name: 'a workspace file on the client with the host its folders are on',
      uri: 'file:///Users/me/work.code-workspace',
      host: DEVENV,
      label: 'work (Workspace)',
      description: 'ssh-remote+devenv',
    },
  ])('labels $name', ({ uri, host, label, description }) => {
    const [workspace] = otherWorkspaces([reference(uri, 'Claude', 's', 1, host)], undefined, NOW);

    expect(workspace && { uri: workspace.uri, host: workspace.host, label: workspace.label, description: workspace.description })
      .toEqual({ uri, host, label, description });
  });
});
