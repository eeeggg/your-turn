import * as assert from 'assert';
import { suite, suiteSetup, suiteTeardown, test } from 'mocha';
import * as path from 'path';
import * as vscode from 'vscode';
import { methods } from '@agentclientprotocol/sdk';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { AgentManager, type AgentProcess } from '@/core/AgentManager';
import { ConnectionManager, ConnectionInfo } from '@/core/ConnectionManager';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import { setLogSink, type TrafficDirection } from '@/core/Log';
import { PermissionRequests } from '@/core/PermissionRequests';
import { ProcessTerminals } from '@/core/ProcessTerminals';
import { FileSystemHandler } from '@/adapters/FileSystemHandler';
import { permissionQuickPick } from '@/adapters/PermissionQuickPick';
import { pseudoterminalDisplays } from '@/adapters/PseudoterminalDisplays';

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
  let agent: AgentProcess;
  let manager: ConnectionManager;
  let info: ConnectionInfo;
  const exits: (number | null)[] = [];
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
      terminals: new ProcessTerminals(pseudoterminalDisplays),
      permissions: new PermissionRequests(permissionQuickPick),
    }));

    // Inside the test host, process.execPath is the Electron binary.
    agent = new AgentManager().launch('fake-agent', {
      command: process.execPath,
      args: [path.join(__dirname, 'fixtures', 'fakeAgent.js')],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    }, __dirname, {
      error: () => {},
      exit: (code) => exits.push(code),
    });
    info = await manager.connect('fake-agent', agent);
  });

  suiteTeardown(async () => {
    agent?.kill();
    setLogSink(undefined);
    const config = vscode.workspace.getConfiguration('acp');
    await config.update('autoApprovePermissions', originalAutoApprove, vscode.ConfigurationTarget.Global);
  });

  test('Initializes the connection', () => {
    assert.strictEqual(info.initResponse.agentInfo?.name, 'FakeAgent');
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

  test('Reports the agent exiting after it is killed', async () => {
    agent.kill();
    await waitFor(() => exits.length > 0);
    assert.strictEqual(exits.length, 1);
  });
});
