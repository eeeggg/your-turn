import * as assert from 'assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, suiteSetup, suiteTeardown, teardown, test } from 'mocha';
import * as vscode from 'vscode';
import { permissionQuickPick } from '@/adapters/PermissionQuickPick';
import { createWorkspaceEnvironment } from '@/adapters/WorkspaceEnvironment';
import type { ConfigOption } from '@/core/acp/AcpDriver';
import { ConnectionManager } from '@/core/acp/ConnectionManager';
import { AgentManager } from '@/core/AgentManager';
import { PermissionRequests } from '@/core/PermissionRequests';
import { SessionReferences, StartupRequests, WorkspaceState, type KeyValueStore, type SessionAddress } from '@/core/PersistedState';
import { SessionManager } from '@/core/SessionManager';
import { SessionStartup, type StartupOutcome } from '@/core/SessionStartup';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import { cleanup } from '@tests/integration/cleanup';

function memoryStore(): KeyValueStore {
  const values = new Map<string, unknown>();
  return { get: <T>(key: string) => values.get(key) as T | undefined, update: async (key, value) => { values.set(key, value); } };
}

function currents(options: ConfigOption[] | null | undefined): Record<string, string | boolean> {
  return Object.fromEntries((options ?? []).map((option) => [option.id, option.current]));
}

for (const version of [1, 2]) {
  suite(`Loading the last active session as the window starts, ACP v${version}`, () => {
    const agentName = `fake-startup-v${version}`;
    const otherName = `fake-startup-other-v${version}`;
    const config = () => vscode.workspace.getConfiguration('acp');
    let original: unknown;
    let records: string;
    /** Disposals of what a test built, run in teardown. */
    const owned: (() => unknown)[] = [];

    suiteSetup(async () => {
      records = join(mkdtempSync(join(tmpdir(), 'acp-startup-')), 'records.jsonl');
      original = config().inspect('agents')?.globalValue;
      const fake = { command: process.execPath, args: [join(__dirname, 'fixtures', `fakeAgent-v${version}.js`)], env: { ELECTRON_RUN_AS_NODE: '1', ACP_TEST_RECORDS: records } };
      await config().update('agents', { [agentName]: fake, [otherName]: fake }, vscode.ConfigurationTarget.Global);
    });

    teardown(async function () {
      await cleanup(this.currentTest, owned.splice(0));
    });

    suiteTeardown(async function () {
      await cleanup(this.currentTest, [
        () => config().update('agents', original, vscode.ConfigurationTarget.Global),
        () => { rmSync(join(records, '..'), { recursive: true, force: true }); },
      ]);
    });

    /** A window starting with `sessionId`, used through `configuredName`, as its last active session. */
    async function starting(sessionId: string, configuredName = agentName) {
      const workspace = new WorkspaceState(memoryStore());
      const globalState = memoryStore();
      const references = new SessionReferences(globalState);
      const environment = createWorkspaceEnvironment(workspace);
      const updates = new SessionUpdateHandler();
      const manager = new SessionManager(
        new AgentManager(),
        new ConnectionManager(updates, '0.0.0-test', () => ({ permissions: new PermissionRequests(permissionQuickPick) })),
        environment,
        { chooseAuthMethod: async () => undefined },
      );
      manager.setPersistedState(references, workspace);
      owned.push(() => manager.dispose(), () => updates.dispose());

      const target = environment.workspaceTarget();
      assert.ok(target, 'a folder window can be opened again');
      const address: SessionAddress = { configuredName, sessionId, cwd: environment.workspaceRoots().cwd, host: target.host, workspaceUri: target.uri };
      await references.saveSelections(address, { options: { model: 'model-b', effort: 'high', fast: true } });
      await workspace.setLastActiveSession(address);

      const texts: string[] = [];
      updates.addListener((id, update) => {
        if (id === sessionId && (update.kind === 'promptText' || update.kind === 'agentText')) {
          texts.push(`${update.kind}: ${update.text}`);
        }
      });
      /** A startup in this window again, as after a reload, over the same storage. */
      const restarted = () => new SessionStartup(manager, workspace, environment, new StartupRequests(globalState));
      /** Another window asks the window opening the address's workspace to load its session. */
      const request = (requested: SessionAddress) => new StartupRequests(globalState).request(requested);
      /** What another window opening the workspace would be given. */
      const taken = () => new StartupRequests(globalState).take(address.workspaceUri);
      return { address, references, workspace, texts, startup: restarted(), restarted, request, taken };
    }

    function loaded(outcome: StartupOutcome) {
      assert.strictEqual(outcome.kind, 'loaded', JSON.stringify(outcome));
      return outcome.session;
    }

    /** The requests the agent received to set an option of `sessionId`. */
    function setRequests(sessionId: string): unknown[] {
      return readFileSync(records, 'utf8').trim().split('\n')
        .map((line) => JSON.parse(line) as { method: string; sessionId?: string; configId?: string; type?: string; value?: unknown })
        .filter((request) => request.method === 'session/set_config_option' && request.sessionId === sessionId)
        .map(({ configId, type, value }) => ({ configId, type, value }));
    }

    const stringType = version === 1 ? undefined : 'id';

    test('replays it and sets its saved options again, high effort only once model B offers it', async () => {
      const sessionId = `startup-v${version}`;
      const { texts, startup } = await starting(sessionId);

      const session = loaded(await startup.attempt());

      assert.deepStrictEqual(texts, ['promptText: earlier question', 'agentText: earlier answer']);
      assert.deepStrictEqual(currents(session.configOptions), { model: 'model-b', effort: 'high', fast: true });
      assert.deepStrictEqual(setRequests(sessionId), [
        { configId: 'model', type: stringType, value: 'model-b' },
        { configId: 'effort', type: stringType, value: 'high' },
        { configId: 'fast', type: 'boolean', value: true },
      ]);
    });

    test('keeps what the agent shows for an option it refuses to set, and sets the rest', async () => {
      const { startup } = await starting('fixed-effort');

      const session = loaded(await startup.attempt());

      assert.deepStrictEqual(currents(session.configOptions), { model: 'model-b', effort: 'medium', fast: true });
      assert.deepStrictEqual(setRequests('fixed-effort'), [
        { configId: 'model', type: stringType, value: 'model-b' },
        { configId: 'effort', type: stringType, value: 'high' },
        { configId: 'fast', type: 'boolean', value: true },
      ]);
    });

    test('fails, keeping the reference, for a session the agent does not know or refuses to load', async () => {
      const { address, references, startup } = await starting('gone');
      const busy = { ...address, sessionId: 'busy' };
      await references.saveSelections(busy, { options: {} });

      const unknown = await startup.attempt();
      const refused = await startup.loadThrough(busy, agentName);

      assert.deepStrictEqual(
        [unknown.kind === 'failed' && unknown.failure.kind, refused.kind === 'failed' && refused.failure],
        ['unknownSession', { kind: 'failed', message: 'Internal error: Session is in use by another client' }],
      );
      assert.ok(references.get(address) && references.get(busy), 'both references stay');
    });

    test('loads the session another window asked for ahead of the last active one, replayed with its options, taking the request', async () => {
      const sessionId = `startup-requested-v${version}`;
      const { address, workspace, texts, startup, request, taken } = await starting(sessionId);
      await workspace.setLastActiveSession({ ...address, sessionId: 'gone' });
      await request(address);

      const session = loaded(await startup.attempt());

      assert.strictEqual(session.sessionId, sessionId);
      assert.deepStrictEqual(texts, ['promptText: earlier question', 'agentText: earlier answer']);
      assert.deepStrictEqual(currents(session.configOptions), { model: 'model-b', effort: 'high', fast: true });
      assert.strictEqual(await taken(), undefined);
    });

    test('fails for a requested session the agent does not know, which a reload does not ask for again', async () => {
      const { address, startup, restarted, request } = await starting(`startup-after-gone-v${version}`);
      await request({ ...address, sessionId: 'gone' });

      const failed = await startup.attempt();
      const reloaded = await restarted().attempt();

      assert.deepStrictEqual(
        [failed.kind === 'failed' && [failed.address.sessionId, failed.failure.kind], loaded(reloaded).sessionId],
        [['gone', 'unknownSession'], address.sessionId],
      );
    });

    test('loads through another configuration as chosen, which its reference and the last active session move to', async () => {
      const sessionId = `startup-moved-v${version}`;
      const retired = `fake-startup-retired-v${version}`;
      const { address, references, workspace, startup } = await starting(sessionId, retired);
      const unconfigured = await startup.attempt();

      const session = loaded(await startup.loadThrough(address, otherName));

      assert.strictEqual(unconfigured.kind === 'failed' && unconfigured.failure.kind, 'unconfigured');
      assert.deepStrictEqual(currents(session.configOptions), { model: 'model-b', effort: 'high', fast: true });
      assert.deepStrictEqual(
        [references.get(address), references.get({ ...address, configuredName: otherName })?.selections, workspace.lastActiveSession()?.configuredName],
        [undefined, { options: { model: 'model-b', effort: 'high', fast: true } }, otherName],
      );
    });
  });
}
