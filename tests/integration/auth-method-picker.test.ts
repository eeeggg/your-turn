import * as assert from 'assert';
import { suite, teardown, test } from 'mocha';
import * as vscode from 'vscode';
import { createAuthMethodPicker } from '@/adapters/AuthMethodPicker';
import type { AuthMethod } from '@/core/acp/AcpDriver';
import { cleanup } from '@tests/integration/cleanup';

const choices: Promise<AuthMethod | undefined>[] = [];

const offered: AuthMethod[] = [
  { id: 'token', name: 'Token', description: 'Paste an API token' },
  { id: 'browser', name: 'Browser', description: null },
];

function observablePicker() {
  let report: (method: AuthMethod) => void = () => {};
  const picker = createAuthMethodPicker((method) => report(method));
  return {
    picker: { chooseAuthMethod: (...args: Parameters<typeof picker.chooseAuthMethod>) => {
      const choice = picker.chooseAuthMethod(...args);
      choices.push(choice);
      return choice;
    } },
    nextSelection: () => new Promise<AuthMethod>((resolve) => { report = resolve; }),
  };
}

suite('AuthMethodPicker Test Suite', () => {
  teardown(async function () {
    await cleanup(this.currentTest, [
      () => vscode.commands.executeCommand('workbench.action.closeQuickOpen'),
      async () => { await Promise.all(choices.splice(0)); },
    ]);
  });

  for (const description of ['Open the browser to sign in', null]) {
    for (const answer of ['Authenticate', 'Cancel', undefined]) {
      test(`Presents one authentication method with description ${description ?? 'none'} and returns the choice ${answer ?? 'dismissal'}`, async () => {
        const method: AuthMethod = { id: 'browser', name: 'Browser', description };
        interface Item extends vscode.QuickPickItem { method?: AuthMethod }
        const shown: { items: readonly Item[]; options: vscode.QuickPickOptions | undefined }[] = [];
        const window = vscode.window as { showQuickPick: unknown; showInformationMessage: unknown };
        const originalPick = window.showQuickPick;
        const originalMessage = window.showInformationMessage;
        window.showInformationMessage = () => { throw new Error('Authentication must use Quick Pick, not a message dialog'); };
        window.showQuickPick = async (items: readonly Item[], options?: vscode.QuickPickOptions) => {
          shown.push({ items, options });
          return items.find((item) => item.label === answer);
        };
        try {
          const choice = await createAuthMethodPicker().chooseAuthMethod('Fake Agent', [method]);

          assert.deepStrictEqual(choice, answer === 'Authenticate' ? method : undefined);
          assert.strictEqual(shown.length, 1);
          const call = shown[0];
          assert.ok(call);
          assert.deepStrictEqual(call.items, [
            { label: 'Authenticate', description: 'Browser', detail: description || 'ID: browser', method },
            { label: 'Cancel' },
          ]);
          assert.ok(call.options);
          assert.strictEqual(call.options.title, 'Fake Agent requires authentication');
          assert.strictEqual(call.options.placeHolder, 'Authenticate via "Browser"?');
        } finally {
          window.showQuickPick = originalPick;
          window.showInformationMessage = originalMessage;
        }
      });
    }
  }

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

  test('Returns the only method after Authenticate is selected in the quick pick', async () => {
    const method: AuthMethod = { id: 'browser', name: 'Browser', description: 'Open the browser to sign in' };
    const { picker, nextSelection } = observablePicker();
    const shown = nextSelection();
    const choice = picker.chooseAuthMethod('Fake Agent', [method]);
    assert.deepStrictEqual(await shown, method);

    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');

    assert.deepStrictEqual(await choice, method);
  });

  test('Returns no method after Cancel is selected in the single-method quick pick', async () => {
    const method: AuthMethod = { id: 'browser', name: 'Browser', description: null };
    const { picker, nextSelection } = observablePicker();
    const shown = nextSelection();
    const choice = picker.chooseAuthMethod('Fake Agent', [method]);
    assert.deepStrictEqual(await shown, method);

    await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');

    assert.strictEqual(await choice, undefined);
  });

  for (const methods of [offered, offered.slice(0, 1)]) {
    test(`Returns no method when the quick pick with ${methods.length} methods is closed`, async () => {
      const { picker, nextSelection } = observablePicker();
      const shown = nextSelection();
      const choice = picker.chooseAuthMethod('Fake Agent', methods);
      await shown;

      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');

      assert.strictEqual(await choice, undefined);
    });
  }
});
