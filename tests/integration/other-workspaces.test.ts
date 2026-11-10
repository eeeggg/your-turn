import * as assert from 'assert';
import { suite, teardown, test } from 'mocha';
import * as vscode from 'vscode';
import { SessionTreeProvider } from '@/adapters/SessionTreeProvider';
import { createWorkspaceEnvironment } from '@/adapters/WorkspaceEnvironment';
import { ConnectionManager } from '@/core/acp/ConnectionManager';
import { AgentManager } from '@/core/AgentManager';
import { SessionReferences, type KeyValueStore, type SessionAddress } from '@/core/PersistedState';
import { WorkspaceState } from '@/core/PersistedState';
import { SessionList, type AgentSessions } from '@/core/SessionList';
import { SessionManager } from '@/core/SessionManager';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import { cleanup } from '@tests/integration/cleanup';

function memoryStore(): KeyValueStore {
  const values = new Map<string, unknown>();
  return { get: <T>(key: string) => values.get(key) as T | undefined, update: async (key, value) => { values.set(key, value); } };
}

/** A clock that moves on a minute each time it is read, so each session is used after the one before. */
function ticking(): () => number {
  let now = Date.parse('2026-10-29T10:00:00Z');
  return () => (now += 60_000);
}

const THIS_WORKSPACE = 'file:///home/me/this';
const LOCAL = 'file://';
const DEVENV = 'vscode-remote://ssh-remote+devenv';
const API = 'vscode-remote://ssh-remote%2Bdevenv/home/me/api';
const WEB = 'file:///home/me/web';

const address = (workspaceUri: string, configuredName: string, sessionId: string, host = LOCAL): SessionAddress =>
  ({ configuredName, sessionId, cwd: '/home/me/work', host, workspaceUri });

const { Collapsed, None } = vscode.TreeItemCollapsibleState;

suite('The Agents view', () => {
  const owned: (() => unknown)[] = [];

  teardown(async function () {
    await cleanup(this.currentTest, owned.splice(0));
  });

  /** The view over references in global state, with no agents, as in a window where the extension is unavailable. */
  function agentsView() {
    const globalState = memoryStore();
    const references = new SessionReferences(globalState, ticking());
    const provider = new SessionTreeProvider(undefined, references, () => THIS_WORKSPACE);
    owned.push(() => provider.dispose());
    return { provider, references, anotherWindow: new SessionReferences(globalState, ticking()) };
  }

  const shown = (item: vscode.TreeItem) => ({ label: item.label, description: item.description, collapsible: item.collapsibleState, command: item.command });

  test('session-history updates preserve agent targets while child loading is pending', async () => {
    const references = new SessionReferences(memoryStore());
    const workspace = new WorkspaceState(memoryStore());
    const environment = createWorkspaceEnvironment(workspace);
    const updates = new SessionUpdateHandler();
    const manager = new SessionManager(
      new AgentManager(),
      new ConnectionManager(updates, '0.0.0-test', () => { throw new Error('No agent should start for a history update'); }),
      environment,
      { chooseAuthMethod: async () => undefined },
    );
    owned.push(() => manager.dispose(), () => updates.dispose());
    let resolveChildren!: (sessions: AgentSessions) => void;
    const children = new Promise<AgentSessions>((resolve) => { resolveChildren = resolve; });
    class PendingSessionList extends SessionList {
      override sessionsOf(): Promise<AgentSessions> { return children; }
    }
    const list = new PendingSessionList(manager, references, () => ['Claude', 'Codex'], () => '/home/me/work', () => ({ uri: THIS_WORKSPACE, host: LOCAL }));
    const provider = new SessionTreeProvider(list, references, () => THIS_WORKSPACE);
    owned.push(() => provider.dispose(), () => list.dispose());
    const roots = await provider.getChildren();
    const selected = roots[0];
    assert.ok(selected && 'agentName' in selected);
    const pending = provider.getChildren(selected);
    owned.push(async () => {
      resolveChildren({ kind: 'unsupported' });
      await pending;
    });
    const changes: unknown[] = [];
    const subscription = provider.onDidChangeTreeData((element) => { changes.push(element); });
    owned.push(() => subscription.dispose());

    await references.used(address(THIS_WORKSPACE, 'Claude', 'context-menu-history'));

    assert.ok(changes.length > 0, 'history changes refresh the visible sessions');
    assert.ok(changes.every((element) => element !== undefined && element !== null), 'session-history changes must not invalidate the entire tree');
    const refreshed = await provider.getChildren();
    assert.strictEqual(refreshed[0], roots[0], 'the selected agent retains its command-argument identity');
    assert.strictEqual(refreshed[1], roots[1], 'an unrelated agent retains its command-argument identity');
    assert.strictEqual(selected.agentName, 'Claude', 'the pending refresh preserves the explicit command target');
    assert.strictEqual(provider.getTreeItem(selected).contextValue, 'agent-without-session');
    resolveChildren({ kind: 'unsupported' });
    assert.deepStrictEqual((await pending).map((item) => provider.getTreeItem(item).contextValue), ['session-info-unsupported']);
  });

  test("lists other workspaces, the configurations their sessions were used through, and those sessions", async () => {
    const { provider, references } = agentsView();
    await references.used(address(THIS_WORKSPACE, 'Claude', 'here'));
    await references.setTitle(address(API, 'Claude', 'a1', DEVENV), 'Fix the build');
    await references.used(address(API, 'Codex', 'a2', DEVENV));
    await references.used(address(WEB, 'Codex', 'w1'));
    provider.show('otherWorkspaces');

    const workspaces = await provider.getChildren();
    assert.deepStrictEqual(workspaces.map((item) => shown(provider.getTreeItem(item))), [
      { label: 'web', description: undefined, collapsible: Collapsed, command: undefined },
      { label: 'api', description: 'ssh-remote+devenv', collapsible: Collapsed, command: undefined },
    ]);
    const configurations = await provider.getChildren(workspaces[1]);
    assert.deepStrictEqual(configurations.map((item) => shown(provider.getTreeItem(item))), [
      { label: 'Codex', description: undefined, collapsible: Collapsed, command: undefined },
      { label: 'Claude', description: undefined, collapsible: Collapsed, command: undefined },
    ]);
    const sessions = await provider.getChildren(configurations[1]);
    assert.deepStrictEqual(sessions.map((item) => [provider.getTreeItem(item).label, provider.getTreeItem(item).collapsibleState]), [['Fix the build', None]]);
    assert.deepStrictEqual(await provider.getChildren(sessions[0]), []);
    const opens = sessions[0] && provider.getTreeItem(sessions[0]).command;
    assert.deepStrictEqual(
      [opens?.command, opens?.arguments?.map((argument: SessionAddress) => [argument.workspaceUri, argument.configuredName, argument.sessionId])],
      ['your-turn.openSessionInWorkspace', [[API, 'Claude', 'a1']]],
    );
  });

  test("shows this workspace's agents again, redrawing on each switch", async () => {
    const { provider, references } = agentsView();
    await references.used(address(WEB, 'Codex', 'w1'));
    let redrawn = 0;
    const subscription = provider.onDidChangeTreeData(() => { redrawn++; });
    owned.push(() => subscription.dispose());

    provider.show('otherWorkspaces');
    assert.strictEqual((await provider.getChildren()).length, 1);
    provider.show('agents');

    assert.deepStrictEqual(await provider.getChildren(), []);
    assert.strictEqual(redrawn, 2);
  });

  test('reads the references again each time it is drawn, and redraws when this window changes them', async () => {
    const { provider, references, anotherWindow } = agentsView();
    provider.show('otherWorkspaces');
    assert.deepStrictEqual(await provider.getChildren(), []);

    await anotherWindow.used(address(WEB, 'Codex', 'w1'));
    assert.deepStrictEqual((await provider.getChildren()).map((item) => provider.getTreeItem(item).label), ['web']);

    let redrawn = 0;
    const subscription = provider.onDidChangeTreeData(() => { redrawn++; });
    owned.push(() => subscription.dispose());
    await references.used(address(API, 'Claude', 'a1', DEVENV));
    assert.strictEqual(redrawn, 1);
  });
});
