import * as assert from 'assert';
import { suite, suiteSetup, suiteTeardown, test } from 'mocha';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AcpDriver } from '@/core/acp/AcpDriver';
import { ConnectionManager } from '@/core/acp/ConnectionManager';
import { AgentManager, type AgentProcess } from '@/core/AgentManager';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import { setLogSink, type TrafficDirection } from '@/core/Log';
import { PermissionRequests } from '@/core/PermissionRequests';
import { permissionQuickPick } from '@/adapters/PermissionQuickPick';

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/** The value at `path` in a JSON value, or undefined. */
function at(value: unknown, ...path: string[]): unknown {
  return path.reduce<unknown>(
    (v, key) => (typeof v === 'object' && v !== null && key in v ? (v as Record<string, unknown>)[key] : undefined),
    value,
  );
}

const CLIENT_VERSION = '0.0.0-test';

suite('ConnectionManager Test Suite', () => {
  let originalAutoApprove: string | undefined;
  let agent: AgentProcess | undefined;
  let manager: ConnectionManager;
  let driver: AcpDriver;
  const exits: (number | null)[] = [];
  const texts: string[] = [];
  const traffic: { direction: TrafficDirection; data: unknown }[] = [];

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
    updates.addListener((_sessionId, update) => {
      if (update.kind === 'agentText') {
        texts.push(update.text);
      }
    });
    manager = new ConnectionManager(updates, CLIENT_VERSION, () => ({ permissions: new PermissionRequests(permissionQuickPick) }));

    // Inside the test host, process.execPath is the Electron binary.
    agent = new AgentManager().launch('fake-agent', {
      command: process.execPath,
      args: [path.join(__dirname, 'fixtures', 'fakeAgent.js')],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    }, __dirname, {
      error: () => {},
      exit: (code) => exits.push(code),
    });
    driver = await manager.connect('fake-agent', agent);
  });

  suiteTeardown(async () => {
    agent?.kill();
    setLogSink(undefined);
    const config = vscode.workspace.getConfiguration('acp');
    await config.update('autoApprovePermissions', originalAutoApprove, vscode.ConfigurationTarget.Global);
  });

  test('Initializes the connection', () => {
    assert.strictEqual(driver.agent.displayName, 'FakeAgent');
  });

  test('Sends the client version in initialize', () => {
    const initialize = traffic.find(t => t.direction === 'send' && at(t.data, 'method') === 'initialize');
    assert.strictEqual(at(initialize?.data, 'params', 'clientInfo', 'version'), CLIENT_VERSION);
  });

  test('Creates a session and sets a config option', async () => {
    const created = await driver.newSession(__dirname);
    assert.strictEqual(created.sessionId, 'fake-session');
    assert.strictEqual(created.configOptions?.[0]?.category, 'model');

    const updated = await driver.setConfigOption(created.sessionId, 'model', 'model-b');
    assert.strictEqual(updated?.[0]?.current, 'model-b');
  });

  test('Routes session updates and answers permission requests during a prompt', async () => {
    await driver.prompt('fake-session', [{ kind: 'text', text: 'hi' }]);
    assert.ok(texts.includes('hello'), `updates: ${JSON.stringify(texts)}`);
    assert.ok(texts.includes('perm:allow'), `updates: ${JSON.stringify(texts)}`);
  });

  test('Sends cancel as a notification', async () => {
    await driver.cancel('fake-session');
    await waitFor(() => texts.includes('cancel-ack'));
  });

  test('Traffic tap records both directions', () => {
    const sentMethods = traffic.filter(t => t.direction === 'send').map(t => at(t.data, 'method'));
    const receivedMethods = traffic.filter(t => t.direction === 'recv').map(t => at(t.data, 'method'));
    assert.ok(sentMethods.includes('initialize'), `sent: ${JSON.stringify(sentMethods)}`);
    assert.ok(receivedMethods.includes('session/update'), `received: ${JSON.stringify(receivedMethods)}`);
  });

  test('Reports the agent exiting after it is killed', async () => {
    assert.ok(agent);
    agent.kill();
    await waitFor(() => exits.length > 0);
    assert.strictEqual(exits.length, 1);
  });
});
