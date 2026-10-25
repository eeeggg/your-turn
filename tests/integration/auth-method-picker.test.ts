import * as assert from 'assert';
import { suite, test } from 'mocha';
import * as vscode from 'vscode';
import { createAuthMethodPicker } from '@/adapters/AuthMethodPicker';
import type { AuthMethod } from '@/core/acp/AcpDriver';

const offered: AuthMethod[] = [
  { id: 'token', name: 'Token', description: 'Paste an API token' },
  { id: 'browser', name: 'Browser', description: null },
];

function observablePicker() {
  let report: (method: AuthMethod) => void = () => {};
  return {
    picker: createAuthMethodPicker((method) => report(method)),
    nextSelection: () => new Promise<AuthMethod>((resolve) => { report = resolve; }),
  };
}

suite('AuthMethodPicker Test Suite', () => {
  test('Returns the method picked from the quick pick', async () => {
    const { picker, nextSelection } = observablePicker();
    const shown = nextSelection();
    const choice = picker.chooseAuthMethod('Fake Agent', offered);
    assert.deepStrictEqual(await shown, offered[0]);

    const moved = nextSelection();
    await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
    assert.deepStrictEqual(await moved, offered[1]);
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');

    assert.deepStrictEqual(await choice, offered[1]);
  });

  test('Returns no method when the quick pick is closed', async () => {
    const { picker, nextSelection } = observablePicker();
    const shown = nextSelection();
    const choice = picker.chooseAuthMethod('Fake Agent', offered);
    await shown;

    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');

    assert.strictEqual(await choice, undefined);
  });
});
