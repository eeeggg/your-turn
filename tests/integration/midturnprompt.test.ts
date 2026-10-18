import * as assert from 'assert';
import { suite, test } from 'mocha';
import * as vscode from 'vscode';

suite('MidTurnPrompt Setting Test Suite', () => {
  test('Setting acp.chat.midTurnPrompt defaults to "queue" in schema', () => {
    const config = vscode.workspace.getConfiguration('acp');
    const inspected = config.inspect<string>('chat.midTurnPrompt');
    assert.strictEqual(inspected?.defaultValue, 'queue');
  });
});
