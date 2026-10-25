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

/** The value at `path` in a JSON value, or undefined. */
function at(value: unknown, ...path: string[]): unknown {
  return path.reduce<unknown>(
    (v, key) => (typeof v === 'object' && v !== null && key in v ? (v as Record<string, unknown>)[key] : undefined),
    value,
  );
}

const CLIENT_VERSION = '0.0.0-test';

for (const version of [1, 2]) {
  suite(`ConnectionManager Test Suite, ACP v${version}`, () => {
    let originalAutoApprove: string | undefined;
    let agent: AgentProcess | undefined;
    let manager: ConnectionManager;
    let driver: AcpDriver;
    const exits: (number | null)[] = [];
    const texts: string[] = [];
    const textWaiters: { text: string; resolve: () => void }[] = [];
    const exitWaiters: (() => void)[] = [];
    const logs: string[] = [];
    const traffic: { direction: TrafficDirection; data: unknown }[] = [];

    suiteSetup(async () => {
      const config = vscode.workspace.getConfiguration('acp');
      originalAutoApprove = config.get<string>('autoApprovePermissions');
      await config.update('autoApprovePermissions', 'allowAll', vscode.ConfigurationTarget.Global);

      setLogSink({
        log: (message) => logs.push(message),
        warn() {},
        error() {},
        traffic: (direction, data) => traffic.push({ direction, data }),
      });

      const updates = new SessionUpdateHandler();
      updates.addListener((_sessionId, update) => {
        if (update.kind === 'agentText') {
          texts.push(update.text);
          for (const waiter of textWaiters.splice(0)) {
            if (texts.includes(waiter.text)) {
              waiter.resolve();
            } else {
              textWaiters.push(waiter);
            }
          }
        }
      });
      manager = new ConnectionManager(updates, CLIENT_VERSION, () => ({ permissions: new PermissionRequests(permissionQuickPick) }));

      // Inside the test host, process.execPath is the Electron binary.
      agent = new AgentManager().launch('fake-agent', {
        command: process.execPath,
        args: [path.join(__dirname, 'fixtures', `fakeAgent-v${version}.js`)],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      }, __dirname, {
        error: () => {},
        exit: (code) => {
          exits.push(code);
          for (const resolve of exitWaiters.splice(0)) { resolve(); }
        },
      });
      driver = await manager.connect('fake-agent', agent);
    });

    const nextText = (text: string) => texts.includes(text)
      ? Promise.resolve()
      : new Promise<void>((resolve) => textWaiters.push({ text, resolve }));
    const nextExit = () => new Promise<void>((resolve) => exitWaiters.push(resolve));

    suiteTeardown(async () => {
      agent?.kill();
      setLogSink(undefined);
      const config = vscode.workspace.getConfiguration('acp');
      await config.update('autoApprovePermissions', originalAutoApprove, vscode.ConfigurationTarget.Global);
    });

    test('Initializes the connection', () => {
      assert.strictEqual(driver.agent.displayName, 'FakeAgent');
    });

    test(`Negotiates ACP v${version}`, () => {
      assert.ok(logs.includes(`ConnectionManager: negotiated ACP v${version} with agent fake-agent`), `logs: ${JSON.stringify(logs)}`);
    });

    test('Sends one initialize, asking for v2 with the client version', () => {
      const initializes = traffic.filter(t => t.direction === 'send' && at(t.data, 'method') === 'initialize');
      assert.strictEqual(initializes.length, 1);
      assert.strictEqual(at(initializes[0]?.data, 'params', 'protocolVersion'), 2);
      assert.strictEqual(at(initializes[0]?.data, 'params', 'info', 'version'), CLIENT_VERSION);
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
      const acknowledged = nextText('cancel-ack');
      await driver.cancel('fake-session');
      await acknowledged;
    });

    test('Traffic tap records both directions', () => {
      const sentMethods = traffic.filter(t => t.direction === 'send').map(t => at(t.data, 'method'));
      const receivedMethods = traffic.filter(t => t.direction === 'recv').map(t => at(t.data, 'method'));
      assert.ok(sentMethods.includes('initialize'), `sent: ${JSON.stringify(sentMethods)}`);
      assert.ok(receivedMethods.includes('session/update'), `received: ${JSON.stringify(receivedMethods)}`);
    });

    test('Reports the agent exiting after it is killed', async () => {
      assert.ok(agent);
      const exited = nextExit();
      agent.kill();
      await exited;
      assert.strictEqual(exits.length, 1);
    });
  });
}
