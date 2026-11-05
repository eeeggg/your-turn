import * as assert from 'assert';
import { suite, test } from 'mocha';
import * as vscode from 'vscode';
import { workspaceUnavailability } from '@/adapters/WorkspaceEnvironment';

suite('In an unsaved workspace', () => {
  test('is unavailable, though both its folders are on disk', () => {
    assert.deepStrictEqual(
      [vscode.workspace.workspaceFile?.scheme, vscode.workspace.workspaceFolders?.map(({ uri }) => uri.scheme)],
      ['untitled', ['file', 'file']],
    );
    assert.strictEqual(workspaceUnavailability(vscode.workspace), 'untitled');
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
});
