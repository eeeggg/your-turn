import * as assert from 'assert';
import { suite, test } from 'mocha';
import * as vscode from 'vscode';
import { createWorkspaceEnvironment, workspaceUnavailability } from '@/adapters/WorkspaceEnvironment';
import { WorkspaceState } from '@/core/PersistedState';

suite('In a window with no folder', () => {
  test('is unavailable', () => {
    assert.strictEqual(workspaceUnavailability(vscode.workspace), 'empty');
  });

  test("activates registering only the commands of the Agents view's Other Workspaces mode, without giving tests its API", async () => {
    const ext = vscode.extensions.getExtension('eeeggg.your-turn');
    assert.ok(ext);
    assert.strictEqual(await ext.activate(), undefined);
    assert.deepStrictEqual(
      (await vscode.commands.getCommands(true)).filter((command) => command.startsWith('your-turn.')).sort(),
      ['your-turn.openSessionInWorkspace', 'your-turn.showAgents', 'your-turn.showOtherWorkspaces'],
    );
  });

  test('has no workspace target', () => {
    const values = new Map<string, unknown>();
    const store = { get: <T>(key: string) => values.get(key) as T | undefined, update: async (key: string, value: unknown) => { values.set(key, value); } };

    assert.strictEqual(vscode.workspace.workspaceFolders, undefined);
    assert.strictEqual(createWorkspaceEnvironment(new WorkspaceState(store)).workspaceTarget(), undefined);
  });
});
