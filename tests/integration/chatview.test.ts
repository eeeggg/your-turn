import * as assert from 'assert';
import { suite, test } from 'mocha';
import * as vscode from 'vscode';
import type { ExtensionTestApi } from '@/extension';

suite('Chat View Test Suite', () => {
  test('Boots when focused: its script loads and its first message reaches the extension', async () => {
    const extension = vscode.extensions.getExtension<ExtensionTestApi | undefined>('formulahendry.acp-client');
    assert.ok(extension);
    const api = await extension.activate();
    assert.ok(api, 'activate returns the test API in extension tests');
    const ready = new Promise<void>((resolve) => {
      const subscription = api.chatMessages((message) => {
        if (message.type === 'ready') {
          subscription.dispose();
          resolve();
        }
      });
    });

    await vscode.commands.executeCommand('acp-chat.focus');

    await ready;
  }).timeout(15_000);
});
