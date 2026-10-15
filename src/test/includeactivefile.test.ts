import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ContentBlock } from '@agentclientprotocol/sdk';

suite('IncludeActiveFile Setting Test Suite', () => {
  let originalSetting: boolean | undefined;

  suiteSetup(async () => {
    const config = vscode.workspace.getConfiguration('acp');
    originalSetting = config.get<boolean>('includeActiveFile');
  });

  suiteTeardown(async () => {
    const config = vscode.workspace.getConfiguration('acp');
    await config.update('includeActiveFile', originalSetting, vscode.ConfigurationTarget.Global);
  });

  test('Setting acp.includeActiveFile defaults to true in schema', () => {
    const config = vscode.workspace.getConfiguration('acp');
    const inspected = config.inspect<boolean>('includeActiveFile');
    assert.strictEqual(inspected?.defaultValue, true);
  });

  test('Builds prompt with resource_link when enabled and document open', async () => {
    const config = vscode.workspace.getConfiguration('acp');
    await config.update('includeActiveFile', true, vscode.ConfigurationTarget.Global);

    // Open a sample document in editor
    const doc = await vscode.workspace.openTextDocument({ content: 'test code', language: 'typescript' });
    const editor = await vscode.window.showTextDocument(doc);
    assert.ok(editor);

    const text = 'Explain this file';
    const prompt: ContentBlock[] = [{ type: 'text', text }];

    const cfg = vscode.workspace.getConfiguration('acp');
    if (cfg.get<boolean>('includeActiveFile', true)) {
      const activeEditor = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0];
      if (activeEditor) {
        prompt.unshift({
          type: 'resource_link',
          uri: activeEditor.document.uri.toString(),
          name: activeEditor.document.uri.fsPath,
          mimeType: activeEditor.document.uri.scheme === 'untitled' ? 'text/plain' : undefined,
        });
      }
    }

    assert.strictEqual(prompt.length, 2);
    assert.strictEqual(prompt[0].type, 'resource_link');
    assert.ok((prompt[0] as any).uri.length > 0);
    assert.strictEqual(prompt[1].type, 'text');
    assert.strictEqual((prompt[1] as any).text, 'Explain this file');
  });
});
