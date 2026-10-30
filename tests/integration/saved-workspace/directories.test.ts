import * as assert from 'assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, suiteSetup, suiteTeardown, teardown, test } from 'mocha';
import * as vscode from 'vscode';
import { permissionQuickPick } from '@/adapters/PermissionQuickPick';
import { createWorkspaceEnvironment, workspaceUnavailability } from '@/adapters/WorkspaceEnvironment';
import { ConnectionManager } from '@/core/acp/ConnectionManager';
import { AgentManager } from '@/core/AgentManager';
import { PermissionRequests } from '@/core/PermissionRequests';
import { WorkspaceState } from '@/core/PersistedState';
import { SessionManager } from '@/core/SessionManager';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import type { ExtensionTestApi } from '@/extension';
import { cleanup } from '@tests/integration/cleanup';

suite('In a saved workspace', () => {
  test('is available, with both its folders on disk', async () => {
    const extension = vscode.extensions.getExtension<ExtensionTestApi | undefined>('formulahendry.acp-client');
    assert.ok(await extension?.activate(), 'the extension returns its test API in extension tests');
    assert.deepStrictEqual(
      [vscode.workspace.workspaceFile?.scheme, vscode.workspace.workspaceFolders?.map(({ uri }) => uri.scheme)],
      ['file', ['file', 'file']],
    );
    assert.strictEqual(workspaceUnavailability(vscode.workspace), undefined);
  });
});

for (const version of [1, 2]) {
  suite(`The directories a session in a saved workspace is given, ACP v${version}`, () => {
    const agentName = `fake-directories-v${version}`;
    const config = () => vscode.workspace.getConfiguration('acp');
    let original: unknown;
    let records: string;
    /** Disposals of what a test built, run in teardown. */
    const owned: (() => unknown)[] = [];

    suiteSetup(async () => {
      records = join(mkdtempSync(join(tmpdir(), 'acp-directories-')), 'records.jsonl');
      original = config().inspect('agents')?.globalValue;
      await config().update(
        'agents',
        { [agentName]: { command: process.execPath, args: [join(__dirname, '..', 'fixtures', `fakeAgent-v${version}.js`)], env: { ELECTRON_RUN_AS_NODE: '1', ACP_TEST_RECORDS: records } } },
        vscode.ConfigurationTarget.Global,
      );
    });

    teardown(async function () {
      await cleanup(this.currentTest, owned.splice(0));
    });

    suiteTeardown(async function () {
      await cleanup(this.currentTest, [
        () => config().update('agents', original, vscode.ConfigurationTarget.Global),
        () => { rmSync(join(records, '..'), { recursive: true, force: true }); },
      ]);
    });

    test('has the first folder as its cwd and the second as an additional directory, on creation, load and resume', async () => {
      const values = new Map<string, unknown>();
      const state = new WorkspaceState({ get: <T>(key: string) => values.get(key) as T | undefined, update: async (key, value) => { values.set(key, value); } });
      const updates = new SessionUpdateHandler();
      const manager = new SessionManager(
        new AgentManager(),
        new ConnectionManager(updates, '0.0.0-test', () => ({ permissions: new PermissionRequests(permissionQuickPick) })),
        createWorkspaceEnvironment(state),
        { chooseAuthMethod: async () => undefined },
      );
      owned.push(() => manager.dispose(), () => updates.dispose());

      await manager.connectToAgent(agentName);
      await manager.loadSession(agentName, 'loaded');
      await manager.resumeSession(agentName, 'resumed');

      const [first, second] = (vscode.workspace.workspaceFolders ?? []).map(({ uri }) => uri.fsPath);
      const directories = { cwd: first, additionalDirectories: [second] };
      assert.deepStrictEqual(readFileSync(records, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown), version === 1
        ? [{ method: 'session/new', ...directories }, { method: 'session/load', ...directories }, { method: 'session/resume', ...directories }]
        : [{ method: 'session/new', ...directories }, { method: 'session/resume', ...directories, replayFrom: 'start' }, { method: 'session/resume', ...directories }]);
    });
  });
}
