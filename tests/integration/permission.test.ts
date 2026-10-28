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

  test("Asks under the request's title, with the detail as the prompt, marking what each option does", async () => {
    interface Shown { items: readonly vscode.QuickPickItem[]; options: vscode.QuickPickOptions | undefined; token?: vscode.CancellationToken }
    const shown: Shown[] = [];
    const window = vscode.window as { showQuickPick: unknown };
    const original = window.showQuickPick;
    window.showQuickPick = async (items: readonly vscode.QuickPickItem[], options?: vscode.QuickPickOptions, token?: vscode.CancellationToken) => {
      shown.push({ items, options, ...(token ? { token } : {}) });
      return items[2];
    };
    try {
      const options = [
        { id: 'allow', name: 'Allow', kind: 'allow_once' },
        { id: 'reject', name: 'Reject', kind: 'reject_always' },
        { id: 'sandbox', name: 'Run in the sandbox', kind: 'other' },
      ] as const;

      const chosen = await permissionQuickPick.choose({ title: 'Run command?', detail: 'npm test in /work — Needs the network' }, options, new AbortController().signal);
      await permissionQuickPick.choose({ title: 'Edit a.ts', detail: null }, options, new AbortController().signal);

      assert.strictEqual(chosen, 'sandbox');
      assert.deepStrictEqual(shown.map(({ items }) => items.map(({ label, description }) => [label, description])), [
        [['$(check) Allow', 'allow_once'], ['$(x) Reject', 'reject_always'], ['Run in the sandbox', undefined]],
        [['$(check) Allow', 'allow_once'], ['$(x) Reject', 'reject_always'], ['Run in the sandbox', undefined]],
      ]);
      assert.deepStrictEqual(shown.map(({ options: shownWith }) => [shownWith?.title, shownWith?.placeHolder, shownWith?.prompt]), [
        ['ACP Agent Permission Request', 'Run command?', 'npm test in /work — Needs the network'],
        ['ACP Agent Permission Request', 'Edit a.ts', undefined],
      ]);
    } finally {
      window.showQuickPick = original;
    }
  });

  test('closes the Quick Pick when its request cancellation signal aborts', async () => {
    const window = vscode.window as { showQuickPick: unknown };
    const original = window.showQuickPick;
    let token: vscode.CancellationToken | undefined;
    let resolvePick: ((item: vscode.QuickPickItem | undefined) => void) | undefined;
    window.showQuickPick = (_items: readonly vscode.QuickPickItem[], _options?: vscode.QuickPickOptions, cancellation?: vscode.CancellationToken) => {
      token = cancellation;
      return new Promise((resolve) => { resolvePick = resolve; });
    };
    const controller = new AbortController();
    try {
      const choice = permissionQuickPick.choose(
        { title: 'Run command?', detail: null },
        [{ id: 'allow', name: 'Allow', kind: 'allow_once' }],
        controller.signal,
      );
      controller.abort();

      assert.strictEqual(token?.isCancellationRequested, true);
      resolvePick?.(undefined);
      assert.strictEqual(await choice, undefined);
    } finally {
      window.showQuickPick = original;
      resolvePick?.(undefined);
    }
  });
});
