import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'node:child_process';
import { methods } from '@agentclientprotocol/sdk';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { ConnectionManager, ConnectionInfo } from '@/core/ConnectionManager';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import { setLogSink, type TrafficDirection } from '@/core/Log';
import { FileSystemHandler } from '@/adapters/FileSystemHandler';
import { TerminalHandler } from '@/adapters/TerminalHandler';
import { PermissionHandler } from '@/adapters/PermissionHandler';

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const CLIENT_VERSION = '0.0.0-test';

suite('ConnectionManager Test Suite', () => {
  let originalAutoApprove: string | undefined;
  let child: ChildProcess;
  let manager: ConnectionManager;
  let info: ConnectionInfo;
  const texts: string[] = [];
  const traffic: { direction: TrafficDirection; data: any }[] = [];

  suiteSetup(async () => {
    const config = vscode.workspace.getConfiguration('acp');
    originalAutoApprove = config.get<string>('autoApprovePermissions');
    await config.update('autoApprovePermissions', 'allowAll', vscode.ConfigurationTarget.Global);

    setLogSink({
      log() {},
      error() {},
      traffic: (direction, data) => traffic.push({ direction, data }),
    });

    const updates = new SessionUpdateHandler();
    updates.addListener((n: SessionNotification) => {
      if (n.update.sessionUpdate === 'agent_message_chunk' && n.update.content.type === 'text') {
        texts.push(n.update.content.text);
      }
    });
    manager = new ConnectionManager(updates, CLIENT_VERSION, () => ({
      files: new FileSystemHandler(),
      terminals: new TerminalHandler(),
      permissions: new PermissionHandler(),
    }));

    // Inside the test host, process.execPath is the Electron binary.
    child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'fakeAgent.js')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    info = await manager.connect('fake-agent', child);
  });

  suiteTeardown(async () => {
    child?.kill();
    setLogSink(undefined);
    manager?.dispose();
    const config = vscode.workspace.getConfiguration('acp');
    await config.update('autoApprovePermissions', originalAutoApprove, vscode.ConfigurationTarget.Global);
  });

  test('Initializes and registers the connection', () => {
    assert.strictEqual(info.initResponse.agentInfo?.name, 'FakeAgent');
    assert.strictEqual(manager.getConnection('fake-agent'), info);
  });

  test('Sends the client version in initialize', () => {
    const initialize = traffic.find(t => t.direction === 'send' && t.data?.method === 'initialize');
    assert.strictEqual(initialize?.data.params.clientInfo.version, CLIENT_VERSION);
  });

  test('Creates a session and sets a config option', async () => {
    const created = await info.connection.agent.request(methods.agent.session.new, { cwd: __dirname, mcpServers: [] });
    assert.strictEqual(created.sessionId, 'fake-session');
    assert.strictEqual(created.configOptions?.[0]?.category, 'model');

    const updated = await info.connection.agent.request(methods.agent.session.setConfigOption, {
      sessionId: created.sessionId,
      configId: 'model',
      value: 'model-b',
    });
    assert.strictEqual(updated.configOptions[0]?.currentValue, 'model-b');
  });

  test('Routes session updates and answers permission requests during a prompt', async () => {
    const response = await info.connection.agent.request(methods.agent.session.prompt, {
      sessionId: 'fake-session',
      prompt: [{ type: 'text', text: 'hi' }],
    });
    assert.strictEqual(response.stopReason, 'end_turn');
    assert.ok(texts.includes('hello'), `updates: ${JSON.stringify(texts)}`);
    assert.ok(texts.includes('perm:allow'), `updates: ${JSON.stringify(texts)}`);
  });

  test('Sends cancel as a notification', async () => {
    await info.connection.agent.notify(methods.agent.session.cancel, { sessionId: 'fake-session' });
    await waitFor(() => texts.includes('cancel-ack'));
  });

  test('Traffic tap records both directions', () => {
    const sentMethods = traffic.filter(t => t.direction === 'send').map(t => t.data?.method);
    const receivedMethods = traffic.filter(t => t.direction === 'recv').map(t => t.data?.method);
    assert.ok(sentMethods.includes('initialize'), `sent: ${JSON.stringify(sentMethods)}`);
    assert.ok(receivedMethods.includes('session/update'), `received: ${JSON.stringify(receivedMethods)}`);
  });
});
