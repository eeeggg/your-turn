import * as assert from 'assert';
import * as vscode from 'vscode';

suite('MidRunPrompt Setting Test Suite', () => {
  let originalSetting: string | undefined;

  suiteSetup(async () => {
    const config = vscode.workspace.getConfiguration('acp');
    originalSetting = config.get<string>('chat.midRunPrompt');
  });

  suiteTeardown(async () => {
    const config = vscode.workspace.getConfiguration('acp');
    await config.update('chat.midRunPrompt', originalSetting, vscode.ConfigurationTarget.Global);
  });

  test('Setting acp.chat.midRunPrompt defaults to "queue" in schema', () => {
    const config = vscode.workspace.getConfiguration('acp');
    const inspected = config.inspect<string>('chat.midRunPrompt');
    assert.strictEqual(inspected?.defaultValue, 'queue');
  });

  test('Prompt queue simulation handles sequential dispatching', async () => {
    const inFlight = { count: 0 };
    const pending: string[] = [];
    const sent: string[] = [];

    async function sendPrompt(text: string) {
      if (inFlight.count > 0) {
        pending.push(text);
        return;
      }
      inFlight.count++;
      sent.push(text);
    }

    function finishPrompt() {
      inFlight.count = Math.max(0, inFlight.count - 1);
      const next = pending.shift();
      if (next !== undefined) {
        void sendPrompt(next);
      }
    }

    // First prompt starts
    await sendPrompt('first prompt');
    assert.strictEqual(inFlight.count, 1);
    assert.deepStrictEqual(sent, ['first prompt']);
    assert.deepStrictEqual(pending, []);

    // Second prompt arrives while first is in-flight -> queued
    await sendPrompt('second prompt');
    assert.strictEqual(inFlight.count, 1);
    assert.deepStrictEqual(sent, ['first prompt']);
    assert.deepStrictEqual(pending, ['second prompt']);

    // First prompt finishes -> second prompt dispatched
    finishPrompt();
    assert.strictEqual(inFlight.count, 1);
    assert.deepStrictEqual(sent, ['first prompt', 'second prompt']);
    assert.deepStrictEqual(pending, []);

    // Second prompt finishes
    finishPrompt();
    assert.strictEqual(inFlight.count, 0);
  });
});
