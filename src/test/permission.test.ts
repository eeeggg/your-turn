import * as assert from 'assert';
import * as vscode from 'vscode';
import { PermissionHandler } from '../handlers/PermissionHandler';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';

suite('PermissionHandler Test Suite', () => {
  let originalConfig: string | undefined;

  suiteSetup(async () => {
    const config = vscode.workspace.getConfiguration('acp');
    originalConfig = config.get<string>('autoApprovePermissions');
    // Set to allowAll for deterministic automated testing without UI prompts
    await config.update('autoApprovePermissions', 'allowAll', vscode.ConfigurationTarget.Global);
  });

  suiteTeardown(async () => {
    const config = vscode.workspace.getConfiguration('acp');
    await config.update('autoApprovePermissions', originalConfig, vscode.ConfigurationTarget.Global);
  });

  test('Should queue and resolve concurrent permission requests', async () => {
    const handler = new PermissionHandler();

    const request1: RequestPermissionRequest = {
      sessionId: 'test-session',
      options: [
        { optionId: 'allow-1', name: 'Allow 1', kind: 'allow_once' },
        { optionId: 'reject-1', name: 'Reject 1', kind: 'reject_once' },
      ],
      toolCall: {
        toolCallId: 'call-1',
        title: 'Edit file 1',
        status: 'pending',
      },
    };

    const request2: RequestPermissionRequest = {
      sessionId: 'test-session',
      options: [
        { optionId: 'allow-2', name: 'Allow 2', kind: 'allow_once' },
        { optionId: 'reject-2', name: 'Reject 2', kind: 'reject_once' },
      ],
      toolCall: {
        toolCallId: 'call-2',
        title: 'Edit file 2',
        status: 'pending',
      },
    };

    const [res1, res2] = await Promise.all([
      handler.requestPermission(request1),
      handler.requestPermission(request2),
    ]);

    assert.strictEqual(res1.outcome.outcome, 'selected');
    assert.strictEqual((res1.outcome as any).optionId, 'allow-1');

    assert.strictEqual(res2.outcome.outcome, 'selected');
    assert.strictEqual((res2.outcome as any).optionId, 'allow-2');
  });

  test('Queue remains operational even if a request fails or is malformed', async () => {
    const handler = new PermissionHandler();

    const malformedRequest = {} as any;
    const validRequest: RequestPermissionRequest = {
      sessionId: 'test-session',
      options: [
        { optionId: 'allow-ok', name: 'Allow OK', kind: 'allow_once' },
      ],
      toolCall: {
        toolCallId: 'call-ok',
        title: 'Valid call',
        status: 'pending',
      },
    };

    // First request should fail gracefully to cancelled
    const res1 = await handler.requestPermission(malformedRequest);
    assert.strictEqual(res1.outcome.outcome, 'cancelled');

    // Next request in queue should still succeed
    const res2 = await handler.requestPermission(validRequest);
    assert.strictEqual(res2.outcome.outcome, 'selected');
    assert.strictEqual((res2.outcome as any).optionId, 'allow-ok');
  });
});
