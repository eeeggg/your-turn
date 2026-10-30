import * as assert from 'assert';
import { join } from 'node:path';
import { suite, suiteSetup, suiteTeardown, teardown, test } from 'mocha';
import * as vscode from 'vscode';
import { permissionQuickPick } from '@/adapters/PermissionQuickPick';
import { createWorkspaceEnvironment } from '@/adapters/WorkspaceEnvironment';
import { ConnectionManager } from '@/core/acp/ConnectionManager';
import { AgentManager } from '@/core/AgentManager';
import { PermissionRequests } from '@/core/PermissionRequests';
import { SessionReferences, WorkspaceState } from '@/core/PersistedState';
import { SessionManager } from '@/core/SessionManager';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import type { ExtensionTestApi } from '@/extension';
import { cleanup } from '@tests/integration/cleanup';
import { remoteWebview } from '@tests/integration/webviews';

suite("The window's workspace target", () => {
  const agentName = 'fake-persisted-folder';
  const sessionId = `persisted-folder-${process.env['VSCODE_TEST_GROUP'] ?? 'default'}`;
  const config = () => vscode.workspace.getConfiguration('acp');
  let api: ExtensionTestApi;
  let folder: vscode.Uri;
  let original: unknown;
  const panels: vscode.WebviewPanel[] = [];
  /** Disposals of what a test built outside the extension, run first in teardown. */
  const owned: (() => unknown)[] = [];

  function webview(): vscode.Webview {
    const panel = vscode.window.createWebviewPanel('acp-persisted-folder-test', 'Workspace URI', { viewColumn: vscode.ViewColumn.One, preserveFocus: true });
    panels.push(panel);
    return panel.webview;
  }

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension<ExtensionTestApi | undefined>('formulahendry.acp-client');
    const activated = await extension?.activate();
    assert.ok(activated, 'the extension returns its test API in extension tests');
    api = activated;
    await api.persistedStateSettled();
    const folders = vscode.workspace.workspaceFolders ?? [];
    assert.strictEqual(folders.length, 1, 'a folder window has exactly one folder');
    folder = folders[0]?.uri ?? assert.fail('a folder window has a folder');
    original = config().inspect('agents')?.globalValue;
    await config().update(
      'agents',
      { [agentName]: { command: process.execPath, args: [join(__dirname, 'fixtures', 'fakeAgent-v1.js')], env: { ELECTRON_RUN_AS_NODE: '1', ACP_TEST_SESSION_ID: sessionId } } },
      vscode.ConfigurationTarget.Global,
    );
  });

  teardown(async function () {
    const { workspaceState } = api.storage;
    await cleanup(this.currentTest, [
      ...owned.splice(0),
      ...panels.splice(0).map((panel) => () => { panel.dispose(); }),
      () => vscode.commands.executeCommand('acp.disconnectAgent', agentName),
      () => api.persistedStateSettled(),
      ...workspaceState.keys().map((key) => () => workspaceState.update(key, undefined)),
      () => api.sessionReferences.reset(),
    ]);
  });

  suiteTeardown(async function () {
    await cleanup(this.currentTest, [() => config().update('agents', original, vscode.ConfigurationTarget.Global)]);
  });

  const workspaceState = () => new WorkspaceState(api.storage.workspaceState);
  const onDevenv = () => ({
    uri: folder.with({ scheme: 'vscode-remote', authority: 'ssh-remote+devenv' }).toString(),
    host: 'vscode-remote://ssh-remote+devenv',
  });

  test("has the window's folder as its workspace target, on the local host", () => {
    assert.deepStrictEqual(createWorkspaceEnvironment(workspaceState()).workspaceTarget(), { uri: folder.toString(), host: 'file://' });
  });

  test('in a local window, keeps its folder as the workspace target whatever webview it is given, storing no workspace target', async () => {
    const state = workspaceState();
    const environment = createWorkspaceEnvironment(state, undefined);
    environment.useWebview(remoteWebview(webview(), 'ssh-remote+devenv'));
    assert.deepStrictEqual(environment.workspaceTarget(), { uri: folder.toString(), host: 'file://' });
    await state.settled();
    assert.strictEqual(workspaceState().workspaceTarget(), undefined);
  });

  test('in a remote window, learns its folder on the remote from a webview of the window, and keeps it once the webview is gone', async () => {
    const state = workspaceState();
    const environment = createWorkspaceEnvironment(state, 'ssh-remote');
    assert.strictEqual(environment.workspaceTarget(), undefined);

    environment.useWebview(remoteWebview(webview(), 'ssh-remote+devenv'));
    assert.deepStrictEqual(environment.workspaceTarget(), onDevenv());
    await state.settled();
    environment.useWebview(undefined);
    assert.deepStrictEqual(environment.workspaceTarget(), onDevenv());
  });

  test('in a remote window, starts with the workspace target an earlier startup learned', async () => {
    const earlier = workspaceState();
    createWorkspaceEnvironment(earlier, 'ssh-remote').useWebview(remoteWebview(webview(), 'ssh-remote+devenv'));
    await earlier.settled();

    assert.deepStrictEqual(workspaceState().workspaceTarget(), onDevenv());
    assert.deepStrictEqual(createWorkspaceEnvironment(workspaceState(), 'ssh-remote').workspaceTarget(), onDevenv());
  });

  test("in a remote window, takes no workspace target from a stored one for another path, and learns this one's", async () => {
    const state = workspaceState();
    await state.setWorkspaceTarget({ uri: 'vscode-remote://ssh-remote%2Bdevenv/home/me/elsewhere', host: onDevenv().host });
    const environment = createWorkspaceEnvironment(state, 'ssh-remote');
    assert.strictEqual(environment.workspaceTarget(), undefined);

    environment.useWebview(remoteWebview(webview(), 'ssh-remote+devenv'));
    await state.settled();
    assert.deepStrictEqual(workspaceState().workspaceTarget(), onDevenv());
  });

  /** What `known` has settled with so far, or 'pending', so a test can tell a target still awaited from a known one. */
  async function soFar(known: Promise<unknown>): Promise<unknown> {
    return Promise.race([known, Promise.resolve('pending')]);
  }

  test('knows the workspace target at once in a local window, or in a remote window that learned it before', async () => {
    assert.deepStrictEqual(await soFar(createWorkspaceEnvironment(workspaceState(), undefined).workspaceTargetKnown()), { uri: folder.toString(), host: 'file://' });

    const state = workspaceState();
    await state.setWorkspaceTarget(onDevenv());
    assert.deepStrictEqual(await soFar(createWorkspaceEnvironment(state, 'ssh-remote').workspaceTargetKnown()), onDevenv());
  });

  test('in a remote window, knows the workspace target once given a webview of the window', async () => {
    const state = workspaceState();
    const environment = createWorkspaceEnvironment(state, 'ssh-remote');
    const known = environment.workspaceTargetKnown();
    assert.strictEqual(await soFar(known), 'pending');

    environment.useWebview(remoteWebview(webview(), 'ssh-remote+devenv'));
    assert.deepStrictEqual(await soFar(known), onDevenv());
    await state.settled();
  });

  test('in a remote window, has no workspace target once given a webview it cannot learn the URI from', async () => {
    const environment = createWorkspaceEnvironment(workspaceState(), 'ssh-remote');
    const known = environment.workspaceTargetKnown();

    environment.useWebview({ asWebviewUri: (uri) => uri });
    assert.strictEqual(await soFar(known), undefined);
  });

  test('records a session opened here as its reference and as the last active session of this workspace', async () => {
    await vscode.commands.executeCommand('acp.connectAgent', agentName);
    await api.persistedStateSettled();

    const address = { configuredName: agentName, sessionId, cwd: folder.fsPath, host: 'file://', workspaceUri: folder.toString() };
    assert.deepStrictEqual(new WorkspaceState(api.storage.workspaceState).lastActiveSession(), address);
    const reference = api.sessionReferences.get({ host: 'file://', configuredName: agentName, sessionId });
    assert.ok(reference, 'the session has a reference');
    const { configuredName, sessionId: referenced, cwd, host, workspaceUri } = reference;
    assert.deepStrictEqual({ configuredName, sessionId: referenced, cwd, host, workspaceUri }, address);
  });

  test('in a remote window, records a session opened while its target is pending once given a webview of the window', async () => {
    // The manager disposes the stores it records to, so it records references to its own, in memory.
    const stored = new Map<string, unknown>();
    const references = new SessionReferences({ get: <T>(key: string) => stored.get(key) as T | undefined, update: async (key, value) => { stored.set(key, value); } });
    const state = workspaceState();
    const environment = createWorkspaceEnvironment(state, 'ssh-remote');
    const updates = new SessionUpdateHandler();
    const manager = new SessionManager(
      new AgentManager(),
      new ConnectionManager(updates, '0.0.0-test', () => ({ permissions: new PermissionRequests(permissionQuickPick) })),
      environment,
      { chooseAuthMethod: async () => undefined },
    );
    owned.push(() => manager.dispose(), () => updates.dispose());
    manager.setPersistedState(references, state);
    const recorded = () => [
      references.get({ host: onDevenv().host, configuredName: agentName, sessionId }),
      workspaceState().lastActiveSession(),
    ];

    await manager.connectToAgent(agentName);
    await references.settled();
    await state.settled();
    assert.deepStrictEqual(recorded(), [undefined, undefined]);

    environment.useWebview(remoteWebview(webview(), 'ssh-remote+devenv'));
    await manager.recordsSettled();
    await references.settled();
    await state.settled();
    const address = { configuredName: agentName, sessionId, cwd: folder.fsPath, host: onDevenv().host, workspaceUri: onDevenv().uri };
    const [reference, lastActive] = recorded();
    assert.deepStrictEqual(lastActive, address);
    assert.ok(reference, 'the session has a reference on the remote host');
    const { configuredName, sessionId: referenced, cwd, host, workspaceUri } = reference;
    assert.deepStrictEqual({ configuredName, sessionId: referenced, cwd, host, workspaceUri }, address);
  });
});
