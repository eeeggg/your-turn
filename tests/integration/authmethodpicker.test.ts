import * as assert from 'assert';
import { suite, test } from 'mocha';
import * as vscode from 'vscode';
import { authMethodPicker } from '@/adapters/AuthMethodPicker';
import type { AuthMethod } from '@/core/acp/AcpDriver';

const offered: AuthMethod[] = [
  { id: 'token', name: 'Token', description: 'Paste an API token' },
  { id: 'browser', name: 'Browser', description: null },
];

/** The extension API cannot see a quick pick, so this gives it time to open before the workbench's commands drive it. */
const opened = () => new Promise((resolve) => setTimeout(resolve, 500));

suite('AuthMethodPicker Test Suite', () => {
  test('Returns the method picked from the quick pick', async () => {
    const choice = authMethodPicker.chooseAuthMethod('Fake Agent', offered);
    await opened();

    await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');

    assert.deepStrictEqual(await choice, offered[1]);
  });

  test('Returns no method when the quick pick is closed', async () => {
    const choice = authMethodPicker.chooseAuthMethod('Fake Agent', offered);
    await opened();

    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');

    assert.strictEqual(await choice, undefined);
  });
});
