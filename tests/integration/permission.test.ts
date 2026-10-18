import * as assert from 'assert';
import { suite, suiteSetup, suiteTeardown, test } from 'mocha';
import * as vscode from 'vscode';
import { permissionQuickPick } from '@/adapters/PermissionQuickPick';

suite('PermissionQuickPick Test Suite', () => {
  let originalSetting: string | undefined;

  suiteSetup(() => {
    originalSetting = vscode.workspace.getConfiguration('acp').get<string>('autoApprovePermissions');
  });

  suiteTeardown(async () => {
    await vscode.workspace.getConfiguration('acp')
      .update('autoApprovePermissions', originalSetting, vscode.ConfigurationTarget.Global);
  });

  test('Asks by default', async () => {
    await vscode.workspace.getConfiguration('acp')
      .update('autoApprovePermissions', undefined, vscode.ConfigurationTarget.Global);
    assert.strictEqual(permissionQuickPick.autoApprove(), 'ask');
  });

  test('Allows everything once the setting is allowAll', async () => {
    await vscode.workspace.getConfiguration('acp')
      .update('autoApprovePermissions', 'allowAll', vscode.ConfigurationTarget.Global);
    assert.strictEqual(permissionQuickPick.autoApprove(), 'allowAll');
  });
});
