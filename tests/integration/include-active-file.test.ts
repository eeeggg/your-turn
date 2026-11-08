import * as assert from 'assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setup, teardown, suite, suiteSetup, suiteTeardown, test } from 'mocha';
import * as vscode from 'vscode';
import { activeFileLink } from '@/adapters/WorkspaceEnvironment';

suite('IncludeActiveFile Setting Test Suite', () => {
  let originalSetting: boolean | undefined;
  let originalExcludes: string[] | undefined;
  let directory: string;

  suiteSetup(async () => {
    const config = vscode.workspace.getConfiguration('your-turn');
    originalSetting = config.inspect<boolean>('includeActiveFile')?.globalValue;
    originalExcludes = config.inspect<string[]>('activeFileExcludes')?.globalValue;
    directory = await mkdtemp(join(tmpdir(), 'active-file-excludes-'));
  });

  setup(async () => {
    const config = vscode.workspace.getConfiguration('your-turn');
    await config.update('activeFileExcludes', undefined, vscode.ConfigurationTarget.Global);
  });

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    const config = vscode.workspace.getConfiguration('your-turn');
    await config.update('includeActiveFile', originalSetting, vscode.ConfigurationTarget.Global);
    await config.update('activeFileExcludes', originalExcludes, vscode.ConfigurationTarget.Global);
  });

  suiteTeardown(async () => {
    const config = vscode.workspace.getConfiguration('your-turn');
    await config.update('includeActiveFile', originalSetting, vscode.ConfigurationTarget.Global);
    await config.update('activeFileExcludes', originalExcludes, vscode.ConfigurationTarget.Global);
    await rm(directory, { recursive: true, force: true });
  });

  test('Setting your-turn.includeActiveFile defaults to false in schema', () => {
    const config = vscode.workspace.getConfiguration('your-turn');
    const inspected = config.inspect<boolean>('includeActiveFile');
    assert.strictEqual(inspected?.defaultValue, false);
  });

  test('Setting your-turn.logTraffic defaults to false in schema', () => {
    const config = vscode.workspace.getConfiguration('your-turn');
    assert.strictEqual(config.inspect<boolean>('logTraffic')?.defaultValue, false);
  });

  test('Does not link the active document without opting in', async () => {
    const config = vscode.workspace.getConfiguration('your-turn');
    await config.update('includeActiveFile', undefined, vscode.ConfigurationTarget.Global);
    const doc = await vscode.workspace.openTextDocument({ content: 'not shared', language: 'typescript' });
    await vscode.window.showTextDocument(doc);

    try {
      assert.strictEqual(activeFileLink(), undefined);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
  });

  test('Links the active document when enabled', async () => {
    const config = vscode.workspace.getConfiguration('your-turn');
    await config.update('includeActiveFile', true, vscode.ConfigurationTarget.Global);

    const doc = await vscode.workspace.openTextDocument({ content: 'test code', language: 'typescript' });
    await vscode.window.showTextDocument(doc);

    const link = activeFileLink();
    assert.ok(link);
    assert.strictEqual(link.uri, doc.uri.toString());
    assert.strictEqual(link.mimeType, 'text/plain');
  });

  for (const [pattern, filename, excluded] of [
    ['.env', '.env', true],
    ['.env', 'nested/.env', true],
    ['.env', 'nested/.env.local', false],
    ['.env.*', 'nested/.env.local', true],
    ['*.pem', 'nested/private.pem', true],
    ['*.pem', 'nested/private.pem.txt', false],
    ['secrets/**', 'nested/secrets/deeper/token.txt', true],
    ['secrets/**', 'nested/not-secrets/token.txt', false],
    ['**/*.key', 'nested/private.key', true],
    ['*.{pem,key}', 'nested/private.key', true],
    ['token?.txt', 'nested/token1.txt', true],
    ['token[0-9].txt', 'nested/token7.txt', true],
  ] as const) {
    test(`Pattern ${pattern} ${excluded ? 'excludes' : 'allows'} ${filename}`, async () => {
      const config = vscode.workspace.getConfiguration('your-turn');
      await config.update('includeActiveFile', true, vscode.ConfigurationTarget.Global);
      await config.update('activeFileExcludes', [pattern], vscode.ConfigurationTarget.Global);
      const path = join(directory, filename);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, 'fixture');
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
      await vscode.window.showTextDocument(doc);

      assert.strictEqual(activeFileLink()?.uri, excluded ? undefined : doc.uri.toString());
    });
  }

  test('Retains exclusions across toggles and applies edits without a reload', async () => {
    const config = vscode.workspace.getConfiguration('your-turn');
    const doc = await vscode.workspace.openTextDocument({ content: 'fixture' });
    await vscode.window.showTextDocument(doc);
    await config.update('includeActiveFile', true, vscode.ConfigurationTarget.Global);
    await config.update('activeFileExcludes', ['unrelated', 'Untitled-*'], vscode.ConfigurationTarget.Global);
    assert.strictEqual(activeFileLink(), undefined);

    await config.update('includeActiveFile', false, vscode.ConfigurationTarget.Global);
    assert.strictEqual(activeFileLink(), undefined);
    assert.deepStrictEqual(vscode.workspace.getConfiguration('your-turn').get('activeFileExcludes'), ['unrelated', 'Untitled-*']);
    await config.update('includeActiveFile', true, vscode.ConfigurationTarget.Global);
    assert.strictEqual(activeFileLink(), undefined);

    await config.update('activeFileExcludes', [], vscode.ConfigurationTarget.Global);
    assert.strictEqual(activeFileLink()?.uri, doc.uri.toString());
  });
});
