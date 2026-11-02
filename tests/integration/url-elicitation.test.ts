import * as assert from 'assert';
import { suite, test } from 'mocha';
import * as vscode from 'vscode';
import { urlElicitationQuickPick } from '@/adapters/UrlElicitationQuickPick';
import { attachUrlElicitations } from '@/core/UrlElicitations';
import { ElicitationRequests } from '@/core/ElicitationRequests';

suite('URL elicitation native boundary', () => {
  test('serializes consent and removes withdrawn requests without answering or opening them', async () => {
    const window = vscode.window as { showQuickPick: unknown };
    const original = window.showQuickPick;
    const requests = new ElicitationRequests();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const shown: string[] = [];
    let displayed: () => void = () => {};
    const ready = new Promise<void>((resolve) => { displayed = resolve; });
    let finish: () => void = () => {};
    window.showQuickPick = (_items: readonly vscode.QuickPickItem[], options: vscode.QuickPickOptions, token: vscode.CancellationToken) => {
      shown.push(options.placeHolder ?? '');
      return new Promise((resolve) => {
        finish = () => resolve(undefined);
        token.onCancellationRequested(() => resolve(undefined));
        displayed();
      });
    };
    const opened: string[] = [];
    const detach = attachUrlElicitations('test-agent', requests, {
      ...urlElicitationQuickPick,
      open: (url) => { opened.push(url); return Promise.resolve(true); },
    });
    try {
      const create = (message: string, controller: AbortController) => requests.create({
        mode: 'url', rpcId: message, scope: { sessionId: 'url-cancel-session' }, elicitationId: message,
        url: 'https://example.org', message,
      }, controller.signal);
      const first = create('First request', firstController);
      const firstRejected = assert.rejects(first, (error: unknown) => error instanceof Error && 'kind' in error && error.kind === 'cancelled');
      await ready;
      const second = create('Queued request', secondController);
      const secondRejected = assert.rejects(second, (error: unknown) => error instanceof Error && 'kind' in error && error.kind === 'cancelled');
      secondController.abort();
      firstController.abort();
      await Promise.all([firstRejected, secondRejected]);
      await detach();
      assert.deepStrictEqual(shown, ['First request']);
      assert.deepStrictEqual(opened, []);
      assert.deepStrictEqual(requests.snapshot(), []);
    } finally {
      requests.close();
      finish();
      await detach();
      window.showQuickPick = original;
    }
  });

  test('opens the consented URI through VS Code once and never opens declined or dismissed requests', async () => {
    const window = vscode.window as { showQuickPick: unknown };
    const env = vscode.env as { openExternal: unknown };
    const originalPick = window.showQuickPick;
    const originalOpen = env.openExternal;
    const opened: string[] = [];
    const shown: { items: readonly vscode.QuickPickItem[]; options: vscode.QuickPickOptions | undefined }[] = [];
    let action: 'accept' | 'decline' | 'cancel' = 'accept';
    window.showQuickPick = async (items: readonly (vscode.QuickPickItem & { action: string })[], options?: vscode.QuickPickOptions) => {
      shown.push({ items, options });
      return items.find((item) => item.action === action);
    };
    env.openExternal = async (uri: vscode.Uri) => { opened.push(uri.toString(true)); return true; };
    const requests = new ElicitationRequests();
    const detach = attachUrlElicitations('test-agent', requests, urlElicitationQuickPick);
    try {
      for (const choice of ['accept', 'decline', 'cancel'] as const) {
        action = choice;
        const url = 'http://localhost:3000/connect?state=abc%2Fdef#finish';
        const response = await requests.create({ mode: 'url', rpcId: choice, scope: { sessionId: 'url-boundary-session' }, elicitationId: choice, url, message: 'Connect the service' });
        assert.deepStrictEqual(response, { action: choice });
      }
      await detach();
      assert.strictEqual(opened.length, 1);
      const target = new URL(opened[0] ?? '');
      assert.strictEqual(target.origin, 'http://localhost:3000');
      assert.strictEqual(target.pathname, '/connect');
      assert.strictEqual(target.searchParams.get('state'), 'abc/def');
      assert.strictEqual(target.hash, '#finish');
      assert.strictEqual(shown.length, 3);
      for (const pick of shown) {
        assert.strictEqual(pick.options?.title, 'test-agent — Open external URL');
        assert.strictEqual(pick.options.placeHolder, 'Connect the service');
        assert.deepStrictEqual(pick.items.map(({ label, description, detail }) => [label, description, detail]), [
          ['Open URL', 'localhost:3000', 'http://localhost:3000/connect?state=abc%2Fdef#finish'],
          ['Decline', undefined, undefined],
        ]);
      }
    } finally {
      requests.close();
      await detach();
      window.showQuickPick = originalPick;
      env.openExternal = originalOpen;
    }
  });
});
