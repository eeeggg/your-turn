import * as assert from 'assert';
import { suite, suiteSetup, suiteTeardown, test } from 'mocha';
import * as vscode from 'vscode';
import { activeFileLink } from '@/adapters/WorkspaceEnvironment';

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

  test('Links the active document when enabled', async () => {
    const config = vscode.workspace.getConfiguration('acp');
    await config.update('includeActiveFile', true, vscode.ConfigurationTarget.Global);

    const doc = await vscode.workspace.openTextDocument({ content: 'test code', language: 'typescript' });
    await vscode.window.showTextDocument(doc);

    const link = activeFileLink();
    assert.ok(link);
    assert.strictEqual(link.uri, doc.uri.toString());
    assert.strictEqual(link.mimeType, 'text/plain');
  });
});
