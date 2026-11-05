import { describe, expect, it, onTestFinished } from 'vitest';
import { methods, RequestError } from '@agentclientprotocol/sdk';
import type { InitializeResponse } from '@agentclientprotocol/sdk';
import type { SessionRoots } from '@/core/acp/AcpDriver';
import { ConnectionManager } from '@/core/acp/ConnectionManager';
import {
  SessionReferences,
  StartupRequests,
  WorkspaceState,
  type KeyValueStore,
  type SessionAddress,
  type WorkspaceTarget,
} from '@/core/PersistedState';
import { SessionManager, type SessionEnvironment } from '@/core/SessionManager';
import { SessionStartup } from '@/core/SessionStartup';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import {
  fakeAgent,
  InProcessAgents,
  unusedHandlers,
  work,
  type AgentScript
} from '@tests/unit/core/InProcessAgents';

function memoryStore(): KeyValueStore {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key, value) => { values.set(key, value); },
  };
}

const TARGET: WorkspaceTarget = { uri: 'file:///work', host: 'file://' };

/** The workspace's last active session, used through configuration `fake`. */
const last: SessionAddress = { configuredName: 'fake', sessionId: 's1', cwd: work.cwd, host: TARGET.host, workspaceUri: TARGET.uri };

/**
 * An agent that loads any session but `gone`, which it does not know, and records the requests it receives. While
 * `inUse` is set, it refuses each load as another client has the session open.
 */
function loadingAgent(init: Partial<InitializeResponse> = { agentCapabilities: { loadSession: true } }) {
  const requests: string[] = [];
  const state = { inUse: false };
  const script: AgentScript = () => fakeAgent(init)
    .onRequest(methods.agent.session.new, () => {
      requests.push('session/new');
      return { sessionId: 'new' };
    })
    .onRequest(methods.agent.session.load, ({ params }) => {
      requests.push(`session/load ${params.sessionId}`);
      if (params.sessionId === 'gone') {
        throw new RequestError(-32002, 'Resource not found', { sessionId: params.sessionId });
      }
      if (state.inUse) {
        throw new RequestError(-32000, 'Session is in use by another client');
      }
      return {};
    });
  return { script, requests, state };
}

function setup(scripts: Record<string, AgentScript>) {
  const agents = new InProcessAgents(scripts);
  const updates = new SessionUpdateHandler();
  let roots: SessionRoots = work;
  let target: WorkspaceTarget | undefined = TARGET;
  const environment: SessionEnvironment = {
    workspaceRoots: () => roots,
    workspaceTarget: () => target,
    workspaceTargetKnown: () => (target ? Promise.resolve(target) : new Promise<undefined>(() => {})),
    agentConfigs: () => Object.fromEntries(Object.keys(scripts).map((name) => [name, { command: name }])),
    activeFileLink: () => undefined,
  };
  const manager = new SessionManager(agents, new ConnectionManager(updates, '0.0.0-test', () => unusedHandlers), environment, {
    chooseAuthMethod: async () => undefined,
  });
  onTestFinished(async () => { await manager.dispose(); updates.dispose(); });
  const globalState = memoryStore();
  const references = new SessionReferences(globalState, () => Date.now());
  const workspace = new WorkspaceState(memoryStore());
  manager.setPersistedState(references, workspace);
  return {
    agents,
    manager,
    references,
    workspace,
    startup: new SessionStartup(manager, workspace, environment, new StartupRequests(globalState)),
    /** Another window asks the window opening the address's workspace to load its session. */
    request: (address: SessionAddress) => new StartupRequests(globalState).request(address),
    /** What another window opening the workspace would be given. */
    taken: (workspaceUri = TARGET.uri) => new StartupRequests(globalState).take(workspaceUri),
    /** As when the workspace's first folder is no longer the one its sessions were used in. */
    withCwd(cwd: string) { roots = { ...roots, cwd }; },
    /** As in a remote window that has yet to learn its workspace URI. */
    withoutWorkspaceTarget() { target = undefined; },
    /** As in a remote window once it learns its workspace URI. */
    withWorkspaceTarget() { target = TARGET; },
    /** The reference to session `sessionId` through configuration `configuredName`. */
    reference: (configuredName: string, sessionId = 's1') => references.get({ host: TARGET.host, configuredName, sessionId }),
  };
}

/** A workspace whose last active session is `address`, which has a reference. */
async function seeded(scripts: Record<string, AgentScript>, address: SessionAddress = last) {
  const context = setup(scripts);
  await context.references.setTitle(address, 'Kept title');
  await context.workspace.setLastActiveSession(address);
  return context;
}

describe('SessionStartup', () => {
  it('loads nothing in a workspace with no last active session', async () => {
    const { agents, startup } = setup({ fake: loadingAgent().script });

    expect(await startup.attempt()).toEqual({ kind: 'nothing' });
    expect(agents.launched).toEqual([]);
  });

  it('loads the last active session through its configured name once per activation, creating none', async () => {
    const fake = loadingAgent();
    const { manager, startup } = await seeded({ fake: fake.script });

    const outcome = await startup.attempt();

    expect(outcome).toEqual({ kind: 'loaded', session: manager.getSession('s1') });
    expect(manager.getActiveSessionId()).toBe('s1');
    expect(await startup.attempt()).toBe(outcome);
    expect(fake.requests).toEqual(['session/load s1']);
  });

  it('loads nothing when a session is already open', async () => {
    const fake = loadingAgent();
    const { manager, startup } = await seeded({ fake: fake.script });
    await manager.connectToAgent('fake');

    expect(await startup.attempt()).toEqual({ kind: 'nothing' });
    expect(fake.requests).toEqual(['session/new']);
  });

  it('loads nothing once a session has opened in this activation, though none is open now', async () => {
    const fake = loadingAgent();
    const { manager, startup } = await seeded({ fake: fake.script });
    await manager.connectToAgent('fake');
    await manager.disconnectAgent('fake');

    expect(await startup.attempt()).toEqual({ kind: 'nothing' });
    expect(fake.requests).toEqual(['session/new']);
  });

  it('loads nothing once forgone, as the user set out to open a session themselves', async () => {
    const fake = loadingAgent();
    const { startup } = await seeded({ fake: fake.script });

    await startup.forgo();

    expect(await startup.attempt()).toEqual({ kind: 'nothing' });
    expect(fake.requests).toEqual([]);
  });

  it('loads before the window knows its workspace target', async () => {
    const fake = loadingAgent();
    const { startup, withoutWorkspaceTarget } = await seeded({ fake: fake.script });
    withoutWorkspaceTarget();

    expect(await startup.attempt()).toMatchObject({ kind: 'loaded' });
    expect(fake.requests).toEqual(['session/load s1']);
  });

  describe('a session another window asked for', () => {
    const asked: SessionAddress = { ...last, sessionId: 's2' };

    it('loads it ahead of the last active session, taking the request so no window loads it again', async () => {
      const fake = loadingAgent();
      const { manager, startup, request, taken } = await seeded({ fake: fake.script });
      await request(asked);

      expect(await startup.attempt()).toEqual({ kind: 'loaded', session: manager.getSession('s2') });

      expect(fake.requests).toEqual(['session/load s2']);
      expect(await taken()).toBeUndefined();
    });

    it('loads it in a workspace with no last active session', async () => {
      const fake = loadingAgent();
      const { startup, request } = setup({ fake: fake.script });
      await request(asked);

      expect(await startup.attempt()).toMatchObject({ kind: 'loaded', session: { sessionId: 's2' } });
      expect(fake.requests).toEqual(['session/load s2']);
    });

    it('gives it once per activation, as it opened', async () => {
      const { startup, request } = setup({ fake: loadingAgent().script });
      await request(asked);

      expect(await startup.requested()).toEqual(asked);
      expect(await startup.requested()).toEqual(asked);
      expect(await startup.requestedSince()).toBeUndefined();
    });

    it('leaves a request for another workspace, loading the last active session', async () => {
      const fake = loadingAgent();
      const { startup, request, taken } = await seeded({ fake: fake.script });
      const elsewhere = { ...asked, workspaceUri: 'file:///elsewhere' };
      await request(elsewhere);

      expect(await startup.requested()).toBeUndefined();
      expect(await startup.attempt()).toMatchObject({ kind: 'loaded', session: { sessionId: 's1' } });
      expect(await taken('file:///elsewhere')).toEqual(elsewhere);
    });

    it('fails as the last active session would, offering the same ways on', async () => {
      const fake = loadingAgent();
      const { manager, startup, request } = await seeded({ fake: fake.script });
      const gone = { ...asked, sessionId: 'gone' };
      await request(gone);

      expect(await startup.attempt()).toEqual({
        kind: 'failed', address: gone, configuredName: 'fake',
        failure: { kind: 'unknownSession', message: expect.stringContaining('Resource not found') as unknown },
      });
      expect(manager.getActiveSession()).toBeUndefined();
    });

    it('leaves the request for when a remote window has learned its workspace URI', async () => {
      const fake = loadingAgent();
      const { startup, request, withoutWorkspaceTarget, withWorkspaceTarget } = await seeded({ fake: fake.script });
      await request(asked);
      withoutWorkspaceTarget();

      expect(await startup.attempt()).toMatchObject({ kind: 'loaded', session: { sessionId: 's1' } });
      withWorkspaceTarget();
      expect(await startup.requestedSince()).toEqual(asked);
    });

    it('gives a request made since it opened once', async () => {
      const { startup, request } = setup({ fake: loadingAgent().script });
      expect(await startup.requested()).toBeUndefined();
      await request(asked);

      expect(await startup.requestedSince()).toEqual(asked);
      expect(await startup.requestedSince()).toBeUndefined();
    });

    it('takes the request it opened with before any made since', async () => {
      const { startup, request } = setup({ fake: loadingAgent().script });
      await request(asked);

      expect(await startup.requestedSince()).toBeUndefined();
      expect(await startup.requested()).toEqual(asked);
    });
  });

  describe('failing', () => {
    const cases: {
      name: string;
      address?: SessionAddress;
      init?: Partial<InitializeResponse>;
      cwd?: string;
      inUse?: boolean;
      failure: unknown;
      requests: string[];
    }[] = [
      {
        name: 'its configuration is gone',
        address: { ...last, configuredName: 'removed' },
        failure: { kind: 'unconfigured', message: 'No agent configuration is named "removed".' },
        requests: [],
      },
      {
        name: 'the workspace cwd changed',
        cwd: '/elsewhere',
        failure: { kind: 'cwdChanged', message: "The session was used in /work, but this workspace's agents run in /elsewhere." },
        requests: [],
      },
      { name: 'its agent cannot load sessions', init: {}, failure: { kind: 'loadUnsupported', message: 'Agent "fake" cannot load sessions.' }, requests: [] },
      {
        name: 'its agent does not know the session',
        address: { ...last, sessionId: 'gone' },
        failure: { kind: 'unknownSession', message: expect.stringContaining('Resource not found') as unknown },
        requests: ['session/load gone'],
      },
      {
        name: 'its agent refuses the load',
        inUse: true,
        failure: { kind: 'failed', message: expect.stringContaining('in use by another client') as unknown },
        requests: ['session/load s1'],
      },
    ];

    it.each(cases)('keeps the reference and loads nothing else when $name', async ({ address = last, init, cwd, inUse = false, failure, requests }) => {
      const fake = loadingAgent(init);
      fake.state.inUse = inUse;
      const { manager, startup, workspace, withCwd, reference } = await seeded({ fake: fake.script }, address);
      if (cwd) { withCwd(cwd); }
      const before = reference(address.configuredName, address.sessionId);

      expect(await startup.attempt()).toEqual({ kind: 'failed', address, configuredName: address.configuredName, failure });

      expect(fake.requests).toEqual(requests);
      expect(manager.getActiveSession()).toBeUndefined();
      expect(reference(address.configuredName, address.sessionId)).toEqual(before);
      expect(workspace.lastActiveSession()).toEqual(address);
    });

    it('launches no agent when the workspace cwd changed', async () => {
      const { agents, startup, withCwd } = await seeded({ fake: loadingAgent().script });
      withCwd('/elsewhere');

      await startup.attempt();

      expect(agents.launched).toEqual([]);
    });
  });

  it('loads the session again through the same configuration', async () => {
    const fake = loadingAgent();
    fake.state.inUse = true;
    const { startup } = await seeded({ fake: fake.script });
    await startup.attempt();
    fake.state.inUse = false;

    expect(await startup.loadThrough(last, 'fake')).toMatchObject({ kind: 'loaded', session: { sessionId: 's1' } });
    expect(fake.requests).toEqual(['session/load s1', 'session/load s1']);
  });

  it('loads through another configuration, moving the reference and the last active session there', async () => {
    const fake = loadingAgent();
    const removed = { ...last, configuredName: 'removed' };
    const { startup, workspace, reference } = await seeded({ fake: fake.script }, removed);
    await startup.attempt();

    expect(await startup.loadThrough(removed, 'fake')).toMatchObject({ kind: 'loaded', session: { sessionId: 's1', agentName: 'fake' } });

    expect(reference('removed')).toBeUndefined();
    expect(reference('fake')).toMatchObject({ title: 'Kept title' });
    expect(workspace.lastActiveSession()).toEqual(last);
  });

  it('keeps the reference where it was when another configuration cannot load the session', async () => {
    const fake = loadingAgent();
    fake.state.inUse = true;
    const removed = { ...last, configuredName: 'removed' };
    const { startup, workspace, reference } = await seeded({ fake: fake.script }, removed);
    const before = reference('removed');

    expect(await startup.loadThrough(removed, 'fake')).toEqual({
      kind: 'failed', address: removed, configuredName: 'fake', failure: { kind: 'failed', message: expect.stringContaining('in use') as unknown },
    });

    expect(reference('removed')).toEqual(before);
    expect(reference('fake')).toBeUndefined();
    expect(workspace.lastActiveSession()).toEqual(removed);
  });
});
