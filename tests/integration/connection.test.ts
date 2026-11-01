import * as assert from 'assert';
import { suite, suiteSetup, suiteTeardown, test } from 'mocha';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AcpDriver } from '@/core/acp/AcpDriver';
import { ConnectionManager } from '@/core/acp/ConnectionManager';
import { AgentManager, type AgentProcess } from '@/core/AgentManager';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import { clearTraffic, getTrafficJsonl, type TrafficDirection } from '@/core/Traffic';
import { setLogSink } from '@/core/Log';
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
    let updates: SessionUpdateHandler | undefined;
    let exited: Promise<void> | undefined;
    const exits: (number | null)[] = [];
    const texts: string[] = [];
    const textWaiters: { text: string; resolve: () => void }[] = [];
    const exitWaiters: (() => void)[] = [];
    const logs: string[] = [];
    const infos: { message: string; context?: Readonly<Record<string, unknown>> }[] = [];
    const trafficRecords = () => getTrafficJsonl().trimEnd().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { timestamp: string; direction: TrafficDirection; message: unknown });

    suiteSetup(async () => {
      clearTraffic();
      const config = vscode.workspace.getConfiguration('acp');
      originalAutoApprove = config.get<string>('autoApprovePermissions');
      await config.update('autoApprovePermissions', 'allowAll', vscode.ConfigurationTarget.Global);

      setLogSink({
        trace: (message) => logs.push(message),
        debug() {},
        info: (message, context) => infos.push({ message, ...(context === undefined ? {} : { context }) }),
        warn() {},
        error() {},
      });

      updates = new SessionUpdateHandler();
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
      let finishExit: () => void = () => {};
      exited = new Promise<void>((resolve) => { finishExit = resolve; });
      agent = new AgentManager().launch('fake-agent', {
        command: process.execPath,
        args: [path.join(__dirname, 'fixtures', `fakeAgent-v${version}.js`)],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      }, __dirname, {
        error: () => {},
        exit: (code) => {
          exits.push(code);
          finishExit();
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
      try {
        if (agent) { agent.kill(); await exited; }
      } finally {
        updates?.dispose();
        setLogSink(undefined);
        clearTraffic();
        const config = vscode.workspace.getConfiguration('acp');
        await config.update('autoApprovePermissions', originalAutoApprove, vscode.ConfigurationTarget.Global);
      }
    });

    test('Initializes the connection', () => {
      assert.strictEqual(driver.agent.displayName, 'FakeAgent');
    });

    test(`Negotiates ACP v${version}`, () => {
      assert.ok(infos.some(({ message, context }) => {
        const fields = context ?? {};
        return message === 'Negotiated ACP protocol' && fields['version'] === version && fields['agentName'] === 'fake-agent';
      }), `infos: ${JSON.stringify(infos)}`);
    });

    test(version === 1
      ? 'Asks for v2, then initializes v1 with the client version and capabilities'
      : 'Sends one v2 initialize with the client version', () => {
      const initializes = trafficRecords().filter(t => t.direction === 'send' && at(t.message, 'method') === 'initialize');
      assert.deepStrictEqual(initializes.map(t => at(t.message, 'params')), [
        {
          protocolVersion: 2,
          info: { name: 'vscode-acp-client', version: CLIENT_VERSION },
          capabilities: { elicitation: { form: {} } },
        },
        ...(version === 1 ? [{
          protocolVersion: 1,
          clientInfo: { name: 'vscode-acp-client', version: CLIENT_VERSION },
          clientCapabilities: { elicitation: { form: {} }, session: { compaction: {}, configOptions: { boolean: {} } } },
        }] : []),
      ]);
    });

    test('Creates a session and sets a config option', async () => {
      const created = await driver.newSession({ cwd: __dirname, additionalDirectories: [] });
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
      const records = trafficRecords();
      const sentMethods = records.filter(t => t.direction === 'send').map(t => at(t.message, 'method'));
      const receivedMethods = records.filter(t => t.direction === 'recv').map(t => at(t.message, 'method'));
      assert.ok(sentMethods.includes('initialize'), `sent: ${JSON.stringify(sentMethods)}`);
      assert.ok(receivedMethods.includes('session/update'), `received: ${JSON.stringify(receivedMethods)}`);
      assert.ok(records.every(({ timestamp, direction, message }) =>
        Number.isFinite(Date.parse(timestamp)) && ['send', 'recv'].includes(direction) && typeof message === 'object' && message !== null),
      `records: ${JSON.stringify(records)}`);
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
