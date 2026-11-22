import { randomUUID } from 'node:crypto';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agent, methods, RequestError } from '@agentclientprotocol/sdk';
import type { AgentApp, InitializeResponse } from '@agentclientprotocol/sdk';
import { ConnectionManager } from '@/core/acp/ConnectionManager';
import { PermissionRequests } from '@/core/PermissionRequests';
import {
  SessionReferences,
  StartupRequests,
  WorkspaceState,
  type KeyValueStore,
  type SessionAddress
} from '@/core/PersistedState';
import { SessionCommands } from '@/core/sessions/Commands';
import { SessionManager, type SessionEnvironment } from '@/core/sessions/Manager';
import { SessionStartup } from '@/core/sessions/Startup';
import { SessionUpdateHandler } from '@/core/sessions/UpdateHandler';
import { SessionTabs } from '@/core/sessions/Tabs';
import { ProgressLocation } from '@/core/VsCodeApi';
import {
  fakeAgent,
  InProcessAgents,
  work,
  type AgentScript
} from '@tests/unit/core/InProcessAgents';
import { ScriptedUser, type Call } from '@tests/unit/core/ScriptedUser';

const progress = (title: string): Call => ({ call: 'withProgress', options: { location: ProgressLocation.Notification, title, cancellable: false } });
const focusChatView: Call = { call: 'executeCommand', command: 'your-turn-chat.focus' };
const ONE_FIRST_SESSION = randomUUID();
const ONE_SECOND_SESSION = randomUUID();
const TWO_FIRST_SESSION = randomUUID();
const TWO_SECOND_SESSION = randomUUID();
const OLD_SESSION = '5c4d793d-cd98-41f3-9dda-d930bb98c867';
const OLDER_SESSION = '88c4eed7-73b5-4d18-8955-ce324d818293';
const DORMANT_SESSION = 'fc77d87d-7180-4387-b694-1e7e5e3d87ab';
const REQUESTED_SESSION = 'ec366b17-4273-4dc1-869f-392d94d38085';
const LATEST_SESSION = 'fe1882c2-9f85-4705-b391-5615e326849d';
const CREATED_SESSIONS = {
  one: [ONE_FIRST_SESSION, ONE_SECOND_SESSION],
  two: [TWO_FIRST_SESSION, TWO_SECOND_SESSION],
} as const;

/**
 * Explicit IDs support exact request assertions; defaults model fresh creations.
 * shortcut: loads and controls are scripted. Seed known sessions and validate their IDs when Slice 1
 * authority or Slice 2 routing tests need it; retain session state across process replacement.
 */
function sessionAgent(name?: keyof typeof CREATED_SESSIONS, init: Partial<InitializeResponse> = {}, extend: (app: AgentApp) => AgentApp = (app) => app) {
  const ids = name ? CREATED_SESSIONS[name] : undefined;
  let created = 0;
  const requests: { method: string; params: unknown }[] = [];
  const waiting: ((request: { method: string; params: unknown }) => void)[] = [];
  const record = (request: { method: string; params: unknown }) => {
    requests.push(request);
    waiting.shift()?.(request);
  };
  const script: AgentScript = () => extend(fakeAgent(init)
    .onRequest(methods.agent.session.new, () => {
      const sessionId = ids ? ids[created++] : randomUUID();
      if (!sessionId) { throw new Error('No further session ID supplied to the fixture'); }
      return { sessionId };
    })
    .onRequest(methods.agent.session.load, ({ params }) => {
      record({ method: 'session/load', params });
      return {};
    })
    .onRequest(methods.agent.session.resume, ({ params }) => {
      record({ method: 'session/resume', params });
      return {};
    })
    .onRequest(methods.agent.session.setMode, ({ params }) => {
      record({ method: 'session/set_mode', params });
      return {};
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      record({ method: 'session/cancel', params });
    }));
  const nextRequest = () => new Promise<{ method: string; params: unknown }>((resolve) => waiting.push(resolve));
  return { script, requests, nextRequest };
}

function memoryStore(): KeyValueStore {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key, value) => { values.set(key, value); },
  };
}

/** A remote window's workspace file saved on the client, so its URI and host differ. */
const WORKSPACE = { uri: 'file:///Users/me/work.code-workspace', host: 'vscode-remote://ssh-remote+devenv' };

function setup(scripts: Record<string, AgentScript>, persistedTabs = false) {
  const agents = new InProcessAgents(scripts);
  const environment: SessionEnvironment = {
    workspaceRoots: () => work,
    workspaceTarget: () => WORKSPACE,
    workspaceTargetKnown: () => Promise.resolve(WORKSPACE),
    agentConfigs: () => Object.fromEntries(Object.keys(scripts).map((name) => [name, { command: name }])),
    activeFileLink: () => undefined,
  };
  const manager = new SessionManager(
    agents,
    new ConnectionManager('0.0.0-test', () => {
      const permissions = new PermissionRequests({ autoApprove: () => 'ask', choose: async () => undefined });
      return { permissions, permissionInteractions: permissions };
    }),
    environment,
    { chooseAuthMethod: async () => undefined },
    new SessionUpdateHandler(),
  );
  const globalState = memoryStore();
  const references = new SessionReferences(globalState);
  const workspace = new WorkspaceState(memoryStore());
  manager.setPersistedState(references, workspace);
  const tabs = new SessionTabs(persistedTabs ? { workspace, references, environment } : undefined);
  manager.on('session-opened', ({ sessionId, agentName }) => {
    const session = manager.getSession({ configuredName: agentName, sessionId });
    if (session) { tabs.open(session); }
  });
  const transcript = { hasRunningTurn: false, queuedPrompts: 0, clearTranscript: vi.fn(), sessionTabs: tabs, notifyTabsChanged: vi.fn() };
  const review = {
    paths: [] as string[],
    unresolvedFileCount: () => review.paths.length,
  };
  const user = new ScriptedUser();
  const startup = new SessionStartup(manager, workspace, environment, new StartupRequests(globalState), persistedTabs ? tabs : undefined);
  const commands = new SessionCommands(manager, transcript, review, user, user, () => Object.keys(scripts), startup);
  /** Another window asks the window opening the address's workspace to load its session. */
  const request = (address: SessionAddress) => new StartupRequests(globalState).request(address);
  return { agents, manager, references, workspace, transcript, review, user, commands, request, tabs, environment };
}

/** Where session `sessionId` of agent configuration `configuredName` lives in the test workspace. */
const addressOf = (configuredName: string, sessionId: string) =>
  ({ configuredName, sessionId, cwd: work.cwd, host: WORKSPACE.host, workspaceUri: WORKSPACE.uri });

const RETRY_CHOOSE = ['Retry', 'Choose Session', 'Choose Agent'];
const failedToOpen = (message: string, items: string[] = RETRY_CHOOSE): Call => ({ call: 'showErrorMessage', message: `Failed to open session: ${message}`, items });
const choosingAgent = (items: string[]): Call => ({
  call: 'showQuickPick', items, options: { title: 'Choose Agent', placeHolder: 'Open the session through which agent?' },
});
const choosingSession: Call = { call: 'executeCommand', command: 'your-turn-sessions.focus' };

/** An agent that can load, and refuses the first `refusals` loads as another client has the session open. */
function refusingAgent(refusals = Infinity) {
  const requested: string[] = [];
  const loaded: string[] = [];
  let refused = 0;
  const script: AgentScript = () => fakeAgent({ agentCapabilities: { loadSession: true } })
    .onRequest(methods.agent.session.load, ({ params }) => {
      requested.push(params.sessionId);
      if (refused++ < refusals) {
        throw RequestError.internalError(undefined, 'session in use by another client');
      }
      loaded.push(params.sessionId);
      return {};
    });
  return { script, requested, loaded };
}


describe('SessionCommands', () => {
  it('does not attach content from a closed tab to a later Resume on the same connection', async () => {
    const script: AgentScript = () => fakeAgent({ agentCapabilities: { sessionCapabilities: { resume: {}, list: {} } } })
      .onRequest(methods.agent.session.new, () => ({ sessionId: ONE_FIRST_SESSION }))
      .onRequest(methods.agent.session.resume, () => ({}))
      .onRequest(methods.agent.session.list, async ({ client }) => {
        await client.notify(methods.client.session.update, { sessionId: ONE_FIRST_SESSION,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Late closed output' } } });
        return { sessions: [] };
      });
    const { commands, manager, tabs } = setup({ one: script });
    onTestFinished(() => manager.dispose());
    await commands.newSession('one');
    const tabId = tabs.snapshot().selectedTabId;
    if (!tabId) { throw new Error('Missing tab'); }
    await commands.closeTab(tabId);
    await manager.listSessions('one');
    await commands.open('one', ONE_FIRST_SESSION);

    expect(manager.getActiveSessionId()).toBe(ONE_FIRST_SESSION);
    expect(manager.sessionState({ configuredName: 'one', sessionId: ONE_FIRST_SESSION })?.content.entries).toEqual([]);
  });

  it('keeps a working sibling tab open until its cancelled prompt settles', async () => {
    let started!: () => void;
    let finish!: () => void;
    const received = new Promise<void>((resolve) => { started = resolve; });
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const prompts: string[] = [];
    const one = sessionAgent('one', {}, (app) => app.onRequest(methods.agent.session.prompt, async ({ params }) => {
      prompts.push(...params.prompt.flatMap((part) => part.type === 'text' ? [part.text] : []));
      started();
      await held;
      return { stopReason: 'cancelled' };
    }));
    const { commands, manager, tabs, user } = setup({ one: one.script });
    onTestFinished(() => manager.dispose());
    const first = await manager.newSession('one');
    const firstTab = tabs.snapshot().selectedTabId;
    if (!firstTab) { throw new Error('Missing first tab'); }
    const identity = { configuredName: 'one', sessionId: first.sessionId };
    const turn = manager.sendPrompt(identity, 'Hold');
    const generation = manager.sessionState(identity)?.generation;
    if (generation === undefined) { throw new Error('Missing session state'); }
    await manager.submitPrompt(identity, generation, 'Do not send');
    await received;
    const second = await manager.newSession('one');
    user.answer('Stop Turn and Close Tab');
    const closed = commands.closeTab(firstTab);
    try {
      await Promise.race([one.nextRequest(), closed]);
      expect(one.requests).toEqual([{ method: 'session/cancel', params: { sessionId: first.sessionId } }]);
      expect(tabs.snapshot().tabs).toHaveLength(2);
      await commands.selectTab(firstTab);
      expect(manager.getActiveSession()).toBe(first);
      await commands.selectTab(tabs.snapshot().tabs[1]?.tabId ?? 'missing');
    } finally { finish(); await turn; await closed; }
    expect(manager.getSession(identity)).toBeUndefined();
    expect(manager.sessionState(identity)).toBeUndefined();
    expect(manager.getActiveSession()).toBe(second);
    expect(manager.isConnected('one')).toBe(true);
    expect(prompts).toEqual(['Hold']);
  });

  it('can disconnect the connection while Close waits for a held turn', async () => {
    let finish!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const received = new Promise<void>((resolve) => { started = resolve; });
    const one = sessionAgent('one', {}, (app) => app.onRequest(methods.agent.session.prompt, async () => {
      started();
      await held;
      return { stopReason: 'cancelled' };
    }));
    const { commands, manager, tabs, user } = setup({ one: one.script, two: sessionAgent('two').script });
    onTestFinished(() => manager.dispose());
    const first = await manager.newSession('one');
    const firstTab = tabs.snapshot().selectedTabId;
    if (!firstTab) { throw new Error('Missing first tab'); }
    const identity = { configuredName: 'one', sessionId: first.sessionId };
    const turn = manager.sendPrompt(identity, 'Hold');
    const interrupted = expect(turn).rejects.toThrow('ACP connection closed');
    try {
      await received;
      const second = await manager.newSession('two');
      user.answer('Stop Turn and Close Tab');
      const cancel = one.nextRequest();
      const closing = commands.closeTab(firstTab);
      try {
        expect(await Promise.race([cancel, closing])).toMatchObject({ method: 'session/cancel' });
        expect(tabs.snapshot().tabs).toHaveLength(2);
        user.answer('Disconnect Agent');
        await commands.disconnect('one');
        await closing;
        expect(manager.isConnected('one')).toBe(false);
        expect(manager.sessionState(identity)).toBeUndefined();
        expect(tabs.snapshot().tabs.map(({ agentName }) => agentName)).toEqual(['two']);
        expect(manager.getActiveSession()).toBe(second);
      } finally { finish(); await closing; }
    } finally { finish(); await interrupted; }
  });

  it('closes without another cancel when the turn settles during confirmation', async () => {
    let finish!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const received = new Promise<void>((resolve) => { started = resolve; });
    const one = sessionAgent('one', {}, (app) => app.onRequest(methods.agent.session.prompt, async () => {
      started();
      await held;
      return { stopReason: 'end_turn' };
    }));
    const { commands, manager, tabs, user } = setup({ one: one.script });
    onTestFinished(() => manager.dispose());
    const session = await manager.newSession('one');
    const tabId = tabs.snapshot().selectedTabId;
    if (!tabId) { throw new Error('Missing tab'); }
    const turn = manager.sendPrompt({ configuredName: 'one', sessionId: session.sessionId }, 'Finish normally');
    await received;
    vi.spyOn(user, 'showQuickPick').mockImplementationOnce(async (items) => {
      finish();
      await turn;
      return items[0];
    });

    await commands.closeTab(tabId);

    expect(tabs.snapshot().tabs).toEqual([]);
    expect(one.requests).toEqual([]);
    expect(manager.isConnected('one')).toBe(true);
  });

  it('checks an unselected session for work before disconnecting its agent', async () => {
    const { commands, manager, user } = setup({ one: sessionAgent('one').script, two: sessionAgent('two').script });
    onTestFinished(() => manager.dispose());
    const first = await manager.newSession('one');
    manager.applyForegroundState({ configuredName: 'one', sessionId: first.sessionId }, 'running');
    const selected = await manager.newSession('two');
    user.answer('Keep Connected');

    await commands.disconnect('one');

    expect(manager.isConnected('one')).toBe(true);
    expect(manager.getActiveSession()).toBe(selected);
    expect(user.take().map(({ call }) => call)).toEqual(['showQuickPick']);
  });

  it('connects without creating a session or changing the selected tab', async () => {
    const one = sessionAgent('one');
    const two = sessionAgent('two');
    const { commands, manager, tabs } = setup({ one: one.script, two: two.script });
    onTestFinished(() => manager.dispose());
    const selected = await manager.newSession('one');
    const before = tabs.snapshot();

    await commands.connect('two');

    expect(manager.isConnected('two')).toBe(true);
    expect(manager.hasSession('two')).toBe(false);
    expect(manager.getActiveSession()).toBe(selected);
    expect(tabs.snapshot()).toEqual(before);
  });

  it('selects an unselected live sibling without loading it', async () => {
    const one = sessionAgent('one', { agentCapabilities: { loadSession: true } });
    const { commands, manager, tabs, agents } = setup({ one: one.script });
    onTestFinished(() => manager.dispose());
    const first = await manager.newSession('one');
    const firstTab = tabs.snapshot().selectedTabId;
    if (!firstTab) { throw new Error('Missing first tab'); }
    await manager.newSession('one');

    await commands.selectTab(firstTab);

    expect(manager.getActiveSession()).toBe(first);
    expect(tabs.snapshot().selectedTabId).toBe(firstTab);
    expect(one.requests).toEqual([]);
    expect(agents.launched).toHaveLength(1);
  });

  it('keeps distinct sessions across agents and targets the same selection after restart', async () => {
    const one = sessionAgent();
    const two = sessionAgent(undefined, { agentCapabilities: { loadSession: true } });
    const { commands, manager } = setup({ one: one.script, two: two.script });
    onTestFinished(() => manager.dispose());
    await commands.newSession('one');
    const first = manager.getActiveSessionId();
    expect(first).not.toBeNull();
    await commands.newSession('two');
    const second = manager.getActiveSessionId();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    await commands.newSession();
    const third = manager.getActiveSessionId();
    expect(third).not.toBeNull();
    expect(third).not.toBe(first);
    expect(third).not.toBe(second);
    await commands.restart();
    expect(manager.getActiveSessionId()).toBe(third);
    expect(two.requests.map(({ method }) => method)).toEqual(['session/load', 'session/load']);
    const cancelled = two.nextRequest();
    await commands.cancelTurn();
    expect(await cancelled).toEqual({ method: 'session/cancel', params: { sessionId: third } });
  });

  it('selects the renamed tab of a live session without refocusing Chat, loading, or reconnecting', async () => {
    const one = sessionAgent('one', { agentCapabilities: { loadSession: true } });
    const { commands, manager, tabs, agents, environment, user } = setup({ one: one.script, renamed: one.script }, true);
    onTestFinished(() => manager.dispose());
    const before = { one: { command: 'one' } };
    const after = { renamed: { command: 'one' } };
    environment.agentConfigs = () => before;
    await commands.newSession('one');
    const tabId = tabs.snapshot().selectedTabId;
    if (!tabId) { throw new Error('missing active tab'); }
    environment.agentConfigs = () => after;
    manager.agentsChanged(before, after);
    tabs.agentsChanged(before, after);
    user.take();

    await commands.selectTab(tabId);

    expect(manager.getActiveAgentName()).toBe('renamed');
    expect(tabs.snapshot()).toMatchObject({ selectedTabId: tabId, tabs: [{ tabId, agentName: 'renamed' }] });
    expect(tabs.snapshot().tabs).toHaveLength(1);
    expect(agents.launched).toHaveLength(1);
    expect(one.requests).toEqual([]);
    expect(user.take()).toEqual([]);
  });

  it.each(['selected', 'unselected'] as const)('releases retained content only when its %s tab closes', async (selection) => {
    const one = sessionAgent('one');
    const two = sessionAgent('two');
    const { commands, manager, tabs } = setup({ one: one.script, two: two.script });
    onTestFinished(() => manager.dispose());
    await commands.newSession('one');
    const closing = tabs.snapshot().selectedTabId;
    if (!closing) { throw new Error('Missing tab'); }
    const identity = { configuredName: 'one', sessionId: ONE_FIRST_SESSION };
    const retained = manager.sessionState(identity);
    expect(retained).toBeDefined();
    if (selection === 'unselected') {
      await commands.newSession('two');
    } else {
      await manager.disconnectAgent('one');
    }
    expect(manager.sessionState(identity)).toBe(retained);
    const other = manager.sessionState({ configuredName: 'two', sessionId: TWO_FIRST_SESSION });

    await commands.closeTab(closing);

    expect(manager.sessionState(identity)).toBeUndefined();
    expect(tabs.snapshot().tabs.some((tab) => tab.tabId === closing)).toBe(false);
    if (selection === 'unselected') {
      expect(manager.sessionState({ configuredName: 'two', sessionId: TWO_FIRST_SESSION })).toBe(other);
      expect(manager.getActiveAgentName()).toBe('two');
      expect(manager.isConnected('two')).toBe(true);
    }
  });

  it('confirms closing a renamed live tab with unresolved review and keeps its connection', async () => {
    const { commands, manager, tabs, review, environment, user } = setup({ one: sessionAgent('one').script }, true);
    onTestFinished(() => manager.dispose());
    const before = { one: { command: 'one' } };
    const after = { renamed: { command: 'one' } };
    await commands.newSession('one');
    environment.agentConfigs = () => after;
    manager.agentsChanged(before, after);
    tabs.agentsChanged(before, after);
    const snapshot = tabs.snapshot();
    const identity = { configuredName: 'renamed', sessionId: ONE_FIRST_SESSION };
    const retained = manager.sessionState(identity);
    expect(retained).toBeDefined();
    if (!snapshot.selectedTabId) { throw new Error('missing active tab'); }
    review.paths = ['/w/a.ts'];
    user.take();
    user.answer(undefined);

    await commands.closeTab(snapshot.selectedTabId);

    expect(tabs.snapshot()).toEqual(snapshot);
    expect(manager.sessionState(identity)).toBe(retained);
    expect(manager.isConnected('renamed')).toBe(true);
    expect(manager.isConnected('one')).toBe(false);
    expect(user.take().map(({ call }) => call)).toEqual(['showQuickPick']);
    user.answer('Close Tab');
    await commands.closeTab(snapshot.selectedTabId);
    expect(manager.getActiveSessionId()).toBeNull();
    expect(manager.isConnected('renamed')).toBe(true);
    expect(manager.isConnected('one')).toBe(false);
    expect(tabs.snapshot()).toEqual({ tabs: [], selectedTabId: null });
    expect(manager.sessionState(identity)).toBeUndefined();
  });

  it('returns to an already active renamed MRU tab without replaying it', async () => {
    const one = sessionAgent('one', { agentCapabilities: { loadSession: true } });
    const { commands, manager, tabs, agents, environment } = setup({ one: one.script, renamed: one.script }, true);
    onTestFinished(() => manager.dispose());
    const before = { one: { command: 'one' } };
    const after = { renamed: { command: 'one' } };
    environment.agentConfigs = () => before;
    await commands.newSession('one');
    const tabId = tabs.snapshot().selectedTabId;
    environment.agentConfigs = () => after;
    manager.agentsChanged(before, after);
    tabs.agentsChanged(before, after);
    const dormant = tabs.open({ agentName: 'removed', agentDisplayName: 'Removed', sessionId: DORMANT_SESSION, cwd: work.cwd });

    await commands.closeTab(dormant);

    expect(manager.getActiveAgentName()).toBe('renamed');
    expect(tabs.snapshot().selectedTabId).toBe(tabId);
    expect(agents.launched).toHaveLength(1);
    expect(one.requests).toEqual([]);
  });

  it('opens the dormant MRU fallback without stopping unrelated active work', async () => {
    const { commands, manager, tabs, transcript, agents, user } = setup({ one: sessionAgent('one').script, two: sessionAgent('two', { agentCapabilities: { loadSession: true } }).script }, true);
    onTestFinished(() => manager.dispose());
    await commands.newSession('one');
    const identity = { configuredName: 'one', sessionId: ONE_FIRST_SESSION };
    manager.applyForegroundState(identity, 'running');
    tabs.open({ agentName: 'two', agentDisplayName: 'Two', sessionId: OLDER_SESSION, cwd: work.cwd });
    const dormant = tabs.open({ agentName: 'removed', agentDisplayName: 'Removed', sessionId: DORMANT_SESSION, cwd: work.cwd });
    transcript.hasRunningTurn = true;
    user.take();
    user.answer(undefined);

    await commands.closeTab(dormant);

    expect(manager.getActiveAgentName()).toBe('two');
    expect(manager.hasForegroundWork(identity)).toBe(true);
    expect(agents.launched).toHaveLength(2);
    expect(tabs.snapshot().selectedTabId).toBe(tabs.snapshot().tabs[1]?.tabId);
    expect(tabs.snapshot().tabs.map((tab) => tab.agentName)).toEqual(['one', 'two']);
    expect(user.take()).toEqual([focusChatView, progress('Loading session…')]);
  });

  it.each([
    { host: 'vscode-remote://ssh-remote+other', uri: WORKSPACE.uri },
    { host: WORKSPACE.host, uri: 'file:///Users/me/other.code-workspace' },
  ])('rejects a saved tab when the known target changed to $host $uri', async (target) => {
    const { commands, manager, tabs, agents, environment, user } = setup({ one: sessionAgent('one', { agentCapabilities: { loadSession: true } }).script }, true);
    onTestFinished(() => manager.dispose());
    const tabId = tabs.open({ agentName: 'one', agentDisplayName: 'One', sessionId: OLD_SESSION, cwd: work.cwd });
    environment.workspaceTarget = () => target;
    user.answer(undefined);

    await commands.selectTab(tabId);

    expect(agents.launched).toEqual([]);
    expect(tabs.snapshot().selectedTabId).toBe(tabId);
    expect(user.take()).toEqual([failedToOpen(`The session belongs to ${WORKSPACE.uri} on ${WORKSPACE.host}, but this workspace is ${target.uri} on ${target.host}.`)]);
  });

  it('rejects a restored tab whose cwd changed before launching its agent', async () => {
    const { commands, manager, tabs, agents, user } = setup({ one: sessionAgent('one', { agentCapabilities: { loadSession: true } }).script }, true);
    onTestFinished(() => manager.dispose());
    const tabId = tabs.open({ agentName: 'one', agentDisplayName: 'One', sessionId: OLD_SESSION, cwd: '/previous' });
    user.answer(undefined);

    await commands.selectTab(tabId);

    expect(agents.launched).toEqual([]);
    expect(tabs.snapshot().selectedTabId).toBe(tabId);
    expect(user.take()).toEqual([failedToOpen("The session was used in /previous, but this workspace's agents run in /work.", ['Choose Session'])]);
  });

  it('rebinds a restored tab after recovering through another configuration', async () => {
    const { commands, manager, tabs, references, user } = setup({ one: refusingAgent().script, two: refusingAgent(0).script }, true);
    onTestFinished(() => manager.dispose());
    await references.setTitle(addressOf('one', OLD_SESSION), 'Kept title');
    const tabId = tabs.open({ agentName: 'one', agentDisplayName: 'One', sessionId: OLD_SESSION, cwd: work.cwd });
    user.answer('Choose Agent', 'two');

    await commands.restoreLastSession();

    expect(manager.getActiveSession()).toMatchObject({ agentName: 'two', sessionId: OLD_SESSION, title: 'Kept title' });
    expect(tabs.snapshot()).toMatchObject({ selectedTabId: tabId, tabs: [{ tabId, agentName: 'two', sessionId: OLD_SESSION }] });
    expect(tabs.snapshot().tabs).toHaveLength(1);
  });

  it('closes a selected dormant tab without disconnecting an unrelated active session', async () => {
    const one = sessionAgent('one', { agentCapabilities: { loadSession: true } });
    const { commands, manager, tabs, agents } = setup({ one: one.script }, true);
    onTestFinished(() => manager.dispose());
    await commands.newSession('one');
    const activeTab = tabs.snapshot().tabs[0];
    if (!activeTab) { throw new Error('missing active tab'); }
    const dormant = tabs.open({ agentName: 'removed', agentDisplayName: 'Removed', sessionId: DORMANT_SESSION, cwd: work.cwd });

    await commands.closeTab(dormant);

    expect(manager.getActiveSessionId()).toBe(ONE_FIRST_SESSION);
    expect(manager.isConnected('one')).toBe(true);
    expect(tabs.snapshot().selectedTabId).toBe(activeTab.tabId);
    expect(agents.launched).toHaveLength(1);
    expect(one.requests).toEqual([]);
  });

  it('loads a selected dormant tab with its cached reference while the remote target is unavailable', async () => {
    const { commands, manager, tabs, references, environment } = setup({ one: refusingAgent(0).script }, true);
    onTestFinished(() => manager.dispose());
    await references.setTitle(addressOf('one', OLD_SESSION), 'Kept title');
    const tabId = tabs.open({ agentName: 'one', agentDisplayName: 'One', sessionId: OLD_SESSION, cwd: work.cwd });
    environment.workspaceTarget = () => undefined;

    await commands.selectTab(tabId);

    expect(manager.getActiveSession()).toMatchObject({ agentName: 'one', sessionId: OLD_SESSION, title: 'Kept title' });
    expect(tabs.snapshot().selectedTabId).toBe(tabId);
  });

  it('offers agent actions for the row connection and retains that target when dispatching', async () => {
    const { commands, manager, user } = setup({ one: sessionAgent('one').script, two: sessionAgent('two').script });
    onTestFinished(() => manager.dispose());
    user.answer('Connect to Agent');
    await commands.agentActions('two');
    expect(user.take()).toEqual([
      { call: 'showQuickPick', items: [
        { label: 'New Session', command: 'your-turn.newSession' },
        { label: '', kind: -1 },
        { label: 'Connect to Agent', command: 'your-turn.connectAgent' },
        { label: 'Remove Agent', command: 'your-turn.removeAgent' },
      ], options: { title: 'Agent Actions: two' } },
      { call: 'executeCommand', command: 'your-turn.connectAgent', rest: ['two'] },
    ]);
    await manager.newSession('one');
    user.answer('Restart Agent');
    await commands.agentActions('one');
    expect(user.take()).toEqual([
      { call: 'showQuickPick', items: [
        { label: 'New Session', command: 'your-turn.newSession' },
        { label: '', kind: -1 },
        { label: 'Disconnect Agent', command: 'your-turn.disconnectAgent' },
        { label: 'Restart Agent', command: 'your-turn.restartAgent' },
        { label: 'Remove Agent', command: 'your-turn.removeAgent' },
      ], options: { title: 'Agent Actions: one' } },
      { call: 'executeCommand', command: 'your-turn.restartAgent', rest: ['one'] },
    ]);
    user.answer(undefined);
    await commands.agentActions('two');
    expect(user.take().map(({ call }) => call)).toEqual(['showQuickPick']);
    await commands.agentActions();
    expect(user.take()).toEqual([]);
  });

  it('restarts a sessionless connection without creating a session or replacing another agent session', async () => {
    const { commands, manager, agents, tabs } = setup({ one: sessionAgent('one').script, two: sessionAgent('two').script });
    onTestFinished(() => manager.dispose());
    await commands.newSession('one');
    await manager.ensureConnected('two');
    const before = tabs.snapshot();
    await commands.restart('two');
    expect(manager.isConnected('two')).toBe(true);
    expect(manager.hasSession('two')).toBe(false);
    expect(manager.getActiveSessionId()).toBe(ONE_FIRST_SESSION);
    expect(tabs.snapshot()).toEqual(before);
    expect(agents.launched.map(({ name, killed }) => ({ name, killed }))).toEqual([
      { name: 'one', killed: false },
      { name: 'two', killed: true },
      { name: 'two', killed: false },
    ]);
  });

  it('creates a targeted session without stopping foreground work in another agent', async () => {
    const { commands, manager, user, agents } = setup({ one: sessionAgent('one').script, two: sessionAgent('two').script });
    const first = await manager.newSession('one');
    const identity = { configuredName: 'one', sessionId: first.sessionId };
    manager.applyForegroundState(identity, 'running');
    await commands.newSession('two');
    expect(manager.getActiveSessionId()).toBe(TWO_FIRST_SESSION);
    expect(manager.getSession(identity)).toBe(first);
    expect(manager.hasForegroundWork(identity)).toBe(true);
    expect(agents.launched.map((agent) => agent.name)).toEqual(['one', 'two']);
    expect(user.take()).toEqual([progress('Starting new session with two...')]);
  });

  it('retains a retryable MRU reference without selection when reopening after close fails', async () => {
    let fail = false;
    const script: AgentScript = () => fakeAgent({ agentCapabilities: { loadSession: true } })
      .onRequest(methods.agent.session.new, () => ({ sessionId: ONE_FIRST_SESSION }))
      .onRequest(methods.agent.session.load, () => {
        if (fail) { throw RequestError.internalError(undefined, 'Cannot reopen'); }
        return {};
      });
    const { commands, manager, tabs, user } = setup({ one: script });
    await commands.newSession('one');
    await manager.disconnectAgent('one');
    await commands.open('one', OLDER_SESSION);
    const [first, second] = tabs.snapshot().tabs;
    if (!first || !second) { throw new Error('missing tabs'); }
    fail = true;
    user.answer(undefined);
    await commands.closeTab(second.tabId);
    expect(manager.getActiveSessionId()).toBeNull();
    expect(tabs.snapshot()).toEqual({ tabs: [first], selectedTabId: null });
    fail = false;
    await commands.selectTab(first.tabId);
    expect(manager.getActiveSessionId()).toBe(ONE_FIRST_SESSION);
    expect(tabs.snapshot().selectedTabId).toBe(first.tabId);
  });

  it('serializes a tab load with a competing tree open so the last request remains selected', async () => {
    let release: (() => void) | undefined;
    let arrived: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { arrived = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    let hold = false;
    const script: AgentScript = () => fakeAgent({ agentCapabilities: { loadSession: true } })
      .onRequest(methods.agent.session.new, () => ({ sessionId: ONE_FIRST_SESSION }))
      .onRequest(methods.agent.session.load, async ({ params }) => {
        if (hold && params.sessionId === ONE_FIRST_SESSION) { arrived?.(); await held; }
        return {};
      });
    const { commands, manager, tabs } = setup({ one: script });
    await commands.newSession('one');
    await manager.disconnectAgent('one');
    await commands.open('one', OLDER_SESSION);
    const first = tabs.snapshot().tabs[0];
    if (!first) { throw new Error('missing tab'); }
    hold = true;
    const selecting = commands.selectTab(first.tabId);
    await started;
    const opening = commands.open('one', LATEST_SESSION);
    release?.();
    await Promise.all([selecting, opening]);
    expect(manager.getActiveSessionId()).toBe(LATEST_SESSION);
    const snapshot = tabs.snapshot();
    expect(snapshot.tabs.find((tab) => tab.tabId === snapshot.selectedTabId)?.sessionId).toBe(LATEST_SESSION);
  });

  it('does not confuse equal session IDs owned by different configurations', async () => {
    const one = sessionAgent('one', { agentCapabilities: { loadSession: true } });
    const two = sessionAgent('two', { agentCapabilities: { loadSession: true } });
    const { commands, manager, tabs } = setup({ one: one.script, two: two.script });
    await commands.open('one', 'shared');
    await commands.open('two', 'shared');
    expect(manager.getActiveAgentName()).toBe('two');
    expect(tabs.snapshot().tabs.map((tab) => tab.agentName)).toEqual(['one', 'two']);
  });

  it('selects through load and closes only references until closing the selection reopens MRU', async () => {
    const agent = sessionAgent('one', { agentCapabilities: { loadSession: true } });
    const { commands, manager, tabs, references } = setup({ one: agent.script });
    await commands.newSession('one');
    await commands.open('one', OLDER_SESSION);
    const [first, second] = tabs.snapshot().tabs;
    if (!first || !second) { throw new Error('missing opened tabs'); }
    await commands.selectTab(first.tabId);
    expect(manager.getActiveSessionId()).toBe(ONE_FIRST_SESSION);
    expect(tabs.snapshot().selectedTabId).toBe(first.tabId);
    await commands.closeTab(first.tabId);
    expect(manager.getActiveSessionId()).toBe(OLDER_SESSION);
    expect(tabs.snapshot().selectedTabId).toBe(second.tabId);
    expect(references.list(WORKSPACE.host, 'one', '/work').map((ref) => ref.sessionId).sort()).toEqual([ONE_FIRST_SESSION, OLDER_SESSION].sort());
    await commands.closeTab(second.tabId);
    expect(manager.getActiveSessionId()).toBeNull();
    expect(tabs.snapshot()).toEqual({ tabs: [], selectedTabId: null });
  });

  it('leaves navigation unchanged when close is cancelled and closes an unfocused dormant reference', async () => {
    const agent = sessionAgent('one', { agentCapabilities: { loadSession: true } });
    const { commands, manager, tabs, review, user, agents } = setup({ one: agent.script });
    await commands.newSession('one');
    await manager.disconnectAgent('one');
    await commands.open('one', OLDER_SESSION);
    const [first, second] = tabs.snapshot().tabs;
    if (!first || !second) { throw new Error('missing tabs'); }
    review.paths = ['/w/a.ts'];
    const before = tabs.snapshot();
    user.answer(undefined);
    await commands.closeTab(second.tabId);
    expect(tabs.snapshot()).toEqual(before);
    expect(manager.getActiveSessionId()).toBe(OLDER_SESSION);
    review.paths = [];
    const requests = [...agent.requests];
    await commands.closeTab(first.tabId);
    expect(agent.requests).toEqual(requests);
    expect(agents.launched).toHaveLength(2);
    expect(tabs.snapshot().tabs.map((tab) => tab.tabId)).toEqual([second.tabId]);
  });

  it('creates a fresh session for an explicitly targeted agent without an intermediate session', async () => {
    const { commands, manager, agents, tabs } = setup({ one: sessionAgent('one').script, two: sessionAgent('two').script });
    await commands.newSession('one');
    await commands.newSession('two');
    expect(manager.getActiveSessionId()).toBe(TWO_FIRST_SESSION);
    expect(manager.hasSession('one')).toBe(true);
    expect(agents.launched.map((agent) => agent.name)).toEqual(['one', 'two']);
    await commands.newSession('two');
    expect(manager.getActiveSessionId()).toBe(TWO_SECOND_SESSION);
    expect(tabs.snapshot().tabs.map((tab) => tab.sessionId)).toEqual([ONE_FIRST_SESSION, TWO_FIRST_SESSION, TWO_SECOND_SESSION]);
  });

  describe('connect', () => {
    it('initializes the named agent and leaves Chat without a session', async () => {
      const { manager, user, commands } = setup({ one: sessionAgent('one').script });

      await commands.connect('one');

      expect(manager.getActiveSessionId()).toBeNull();
      expect(manager.isConnected('one')).toBe(true);
      expect(user.take()).toEqual([progress('Connecting to one...')]);
    });

    it('asks which configured agent to connect when none is named', async () => {
      const { manager, user, commands } = setup({ one: sessionAgent('one').script, two: sessionAgent('two').script });
      user.answer('two');

      await commands.connect();

      expect(manager.getActiveSessionId()).toBeNull();
      expect(manager.isConnected('two')).toBe(true);
      expect(user.take()).toEqual([
        { call: 'showQuickPick', items: ['one', 'two'], options: { placeHolder: 'Select an agent to connect', title: 'Connect to Agent' } },
        progress('Connecting to two...'),
      ]);
    });

    it('does nothing when the user dismisses the choice of agent', async () => {
      const { agents, user, commands } = setup({ one: sessionAgent('one').script });
      user.answer(undefined);

      await commands.connect();

      expect(agents.launched).toEqual([]);
      expect(user.take().map((c) => c.call)).toEqual(['showQuickPick']);
    });

    it('warns when no agent is configured', async () => {
      const { user, commands } = setup({});

      await commands.connect();

      expect(user.take()).toEqual([
        { call: 'showWarningMessage', message: 'No ACP agents configured. Add agents in Settings > Your Turn > Agents.' },
      ]);
    });

    it('connects another agent without clearing the transcript', async () => {
      const { manager, transcript, user, commands } = setup({ one: sessionAgent('one').script, two: sessionAgent('two').script });
      await manager.newSession('one');

      await commands.connect('two');

      expect(manager.getActiveSessionId()).toBe(ONE_FIRST_SESSION);
      expect(manager.hasSession('one')).toBe(true);
      expect(transcript.clearTranscript).not.toHaveBeenCalled();
      expect(user.take()).toEqual([progress('Connecting to two...')]);
    });

    it('connects another agent without asking or stopping a turn', async () => {
      const { manager, user, commands } = setup({ one: sessionAgent('one').script, two: sessionAgent('two').script });
      const session = await manager.newSession('one');
      const identity = { configuredName: 'one', sessionId: session.sessionId };
      manager.applyForegroundState(identity, 'running');

      await commands.connect('two');

      expect(manager.getActiveSession()).toBe(session);
      expect(manager.hasForegroundWork(identity)).toBe(true);
      expect(user.take()).toEqual([progress('Connecting to two...')]);
    });

    it('keeps the session and transcript when the user dismisses the agent picker', async () => {
      const { manager, transcript, user, commands } = setup({ one: sessionAgent('one').script, two: sessionAgent('two').script });
      await manager.newSession('one');
      transcript.hasRunningTurn = true;
      user.answer(undefined);

      await commands.connect();

      expect(manager.getActiveSessionId()).toBe(ONE_FIRST_SESSION);
      expect(transcript.clearTranscript).not.toHaveBeenCalled();
    });

    it('leaves files under review when connecting another agent', async () => {
      const { manager, review, user, commands } = setup({ one: sessionAgent('one').script, two: sessionAgent('two').script });
      await manager.newSession('one');
      review.paths = ['/w/a.ts', '/w/b.ts'];

      await commands.connect('two');

      expect(review.paths).toEqual(['/w/a.ts', '/w/b.ts']);
      expect(manager.getActiveSessionId()).toBe(ONE_FIRST_SESSION);
      expect(user.take()).toEqual([progress('Connecting to two...')]);
    });

    it('does not resolve review when files arrive while the close picker is open', async () => {
      const { manager, review, user, commands, tabs } = setup({ one: sessionAgent('one').script });
      await manager.newSession('one');
      review.paths = ['/w/a.ts'];
      const pick = user.showQuickPick.bind(user);
      vi.spyOn(user, 'showQuickPick').mockImplementation((items, options) => {
        review.paths.push('/w/newer.ts');
        return pick(items, options);
      });
      user.answer('Close Tab');
      await commands.closeTab(tabs.snapshot().selectedTabId ?? 'missing');
      expect(review.paths).toEqual(['/w/a.ts', '/w/newer.ts']);
      expect(manager.getActiveSessionId()).toBeNull();
    });

    it('offers only Close Tab and Keep Tab Open for an idle session with unresolved review', async () => {
      const { manager, review, user, commands, tabs } = setup({ one: sessionAgent('one').script });
      await manager.newSession('one');
      review.paths = ['/w/a.ts'];
      user.answer('Close Tab');
      await commands.closeTab(tabs.snapshot().selectedTabId ?? 'missing');
      const choices = user.take().find((call) => call.call === 'showQuickPick');
      expect(choices?.call === 'showQuickPick' ? choices.items : []).toEqual([
        { label: 'Close Tab', detail: '1 file is still under review. Review stays available when you reopen this session.' },
        { label: 'Keep Tab Open' },
      ]);
      expect(review.paths).toEqual(['/w/a.ts']);
      expect(manager.getActiveSessionId()).toBeNull();
    });

    it('does not ask when connecting the agent that already has the active session', async () => {
      const { manager, transcript, review, user, commands } = setup({ one: sessionAgent('one').script });
      await manager.newSession('one');
      transcript.hasRunningTurn = true;
      transcript.queuedPrompts = 1;
      review.paths = ['/w/a.ts'];

      await commands.connect('one');

      expect(manager.getActiveSessionId()).toBe(ONE_FIRST_SESSION);
      expect(user.take()).toEqual([progress('Connecting to one...')]);
    });

    it('reports a failure to connect', async () => {
      const { user, commands } = setup({
        broken: () => agent({ name: 'broken' }).onRequest(methods.agent.initialize, () => {
          throw RequestError.internalError(undefined, 'no model configured');
        }),
      });

      await commands.connect('broken');

      expect(user.take()).toEqual([
        progress('Connecting to broken...'),
        { call: 'showErrorMessage', message: 'Failed to connect: Internal error: no model configured' },
      ]);
    });
  });

  describe('new session', () => {
    it("starts a new session with the active session's agent", async () => {
      const { manager, user, commands } = setup({ one: sessionAgent('one').script });
      await manager.newSession('one');

      await commands.newSession();

      expect(manager.getActiveSessionId()).toBe(ONE_SECOND_SESSION);
      expect(user.take()).toEqual([progress('Starting new session with Fake Agent...')]);
    });

    it('preserves a running sibling without asking first', async () => {
      const { agents, manager, user, commands } = setup({ one: sessionAgent('one').script });
      await manager.newSession('one');
      const identity = { configuredName: 'one', sessionId: ONE_FIRST_SESSION };
      manager.applyForegroundState(identity, 'running');

      await commands.newSession();

      expect(agents.launched).toHaveLength(1);
      expect(manager.getActiveSessionId()).toBe(ONE_SECOND_SESSION);
      expect(manager.hasForegroundWork(identity)).toBe(true);
      expect(user.take()).toEqual([progress('Starting new session with Fake Agent...')]);
    });

    it('preserves queued prompts and unresolved review when creating a sibling', async () => {
      const { manager, review, user, commands } = setup({ one: sessionAgent('one').script });
      await manager.newSession('one');
      const identity = { configuredName: 'one', sessionId: ONE_FIRST_SESSION };
      manager.applyForegroundState(identity, 'running');
      const generation = manager.sessionState(identity)?.generation;
      if (generation === undefined) { throw new Error('Missing session state'); }
      await manager.submitPrompt(identity, generation, 'queued');
      review.paths = ['/w/a.ts'];

      await commands.newSession();

      expect(review.paths).toEqual(['/w/a.ts']);
      expect(manager.sessionState(identity)?.queue.map(({ text }) => text)).toEqual(['queued']);
      expect(manager.getActiveSessionId()).toBe(ONE_SECOND_SESSION);
      expect(user.take()).toEqual([progress('Starting new session with Fake Agent...')]);
    });

    it('connects an agent when there is no active session', async () => {
      const { manager, user, commands } = setup({ one: sessionAgent('one').script });
      user.answer('one');

      await commands.newSession();

      expect(manager.getActiveSessionId()).toBe(ONE_FIRST_SESSION);
      expect(user.take().map((c) => c.call)).toEqual(['showQuickPick', 'withProgress']);
    });

    it('reports a failure to start the session', async () => {
      let created = 0;
      const { manager, user, commands } = setup({
        flaky: () => fakeAgent().onRequest(methods.agent.session.new, () => {
          if (++created > 1) {
            throw RequestError.internalError(undefined, 'out of quota');
          }
          return { sessionId: randomUUID() };
        }),
      });
      await manager.newSession('flaky');

      await commands.newSession();

      expect(user.take()).toEqual([
        progress('Starting new session with Fake Agent...'),
        { call: 'showErrorMessage', message: 'Failed to start new session: Internal error: out of quota' },
      ]);
    });
  });

  it.each([
    { action: 'Connect', transition: (commands: SessionCommands) => commands.connect('two'), destination: ONE_FIRST_SESSION },
    { action: 'New Session', transition: (commands: SessionCommands) => commands.newSession(), destination: ONE_SECOND_SESSION },
    { action: 'Open Session', transition: (commands: SessionCommands) => commands.open('two', OLD_SESSION), destination: OLD_SESSION },
  ])('$action preserves prior work and review without confirmation', async ({ transition, destination }) => {
    const { agents, manager, transcript, review, user, commands } = setup({
      one: sessionAgent('one').script,
      two: sessionAgent('two', { agentCapabilities: { loadSession: true } }).script,
    });
    const original = await manager.newSession('one');
    const identity = { configuredName: 'one', sessionId: ONE_FIRST_SESSION };
    manager.applyForegroundState(identity, 'running');
    const state = manager.sessionState(identity);
    if (!state) { throw new Error('Missing original session state'); }
    await manager.submitPrompt(identity, state.generation, 'queued');
    review.paths = ['/w/a.ts'];

    await transition(commands);

    expect(manager.getActiveSessionId()).toBe(destination);
    expect(manager.getSession(identity)).toBe(original);
    expect(agents.running('one')).toHaveLength(1);
    expect(transcript.clearTranscript).not.toHaveBeenCalled();
    expect(manager.hasForegroundWork(identity)).toBe(true);
    expect(manager.sessionState(identity)?.queue.map(({ text }) => text)).toEqual(['queued']);
    expect(review.paths).toEqual(['/w/a.ts']);
    expect(user.take().map(({ call }) => call)).not.toContain('showQuickPick');
  });

  describe('disconnect', () => {
    it("stops the active session's agent", async () => {
      const { agents, manager, user, commands } = setup({ one: sessionAgent('one').script });
      await manager.newSession('one');

      await commands.disconnect();

      expect(agents.running('one')).toEqual([]);
      expect(manager.getActiveSessionId()).toBeNull();
      expect(user.take()).toEqual([{ call: 'showInformationMessage', message: 'Disconnected from one.' }]);
    });

    it('stops the named agent', async () => {
      const { agents, manager, user, commands } = setup({ one: sessionAgent('one').script });
      await manager.ensureConnected('one');

      await commands.disconnect('one');

      expect(agents.running('one')).toEqual([]);
      expect(user.take()).toEqual([{ call: 'showInformationMessage', message: 'Disconnected from one.' }]);
    });

    it('says so when there is no session to disconnect', async () => {
      const { user, commands } = setup({ one: sessionAgent('one').script });

      await commands.disconnect();

      expect(user.take()).toEqual([{ call: 'showInformationMessage', message: 'No active session.' }]);
    });
  });

  describe('restart', () => {
    it('reloads all captured live siblings on the replacement without creating a session or changing tabs', async () => {
      const one = sessionAgent('one', { agentCapabilities: { loadSession: true } });
      const { agents, manager, user, commands, tabs } = setup({ one: one.script });
      const original = await manager.newSession('one');
      const selected = await manager.newSession('one');
      const identity = { configuredName: 'one', sessionId: original.sessionId };
      const generation = manager.sessionState(identity)?.generation;
      if (generation === undefined) { throw new Error('Missing session state'); }
      manager.editComposer(identity, generation, 1, 'Retain this draft');
      const before = tabs.snapshot();
      const [first] = agents.launched;

      await commands.restart();

      expect(first?.killed).toBe(true);
      expect(agents.running('one')).toHaveLength(1);
      expect(manager.getActiveSessionId()).toBe(ONE_SECOND_SESSION);
      expect(manager.getActiveSession()?.agentId).not.toBe(selected.agentId);
      expect(manager.getSession(identity)?.agentId).toBe(manager.getActiveSession()?.agentId);
      expect(manager.sessionState(identity)?.composer.text).toBe('Retain this draft');
      expect(tabs.snapshot()).toEqual(before);
      expect(one.requests).toEqual([ONE_FIRST_SESSION, ONE_SECOND_SESSION].map((sessionId) => ({
        method: 'session/load', params: { sessionId, cwd: work.cwd, mcpServers: [] },
      })));
      expect(user.take()).toEqual([
        progress('Restarting Fake Agent...'),
        { call: 'showInformationMessage', message: 'Restarted one' },
      ]);
    });

    it('restarts the agent it is given', async () => {
      const { manager, user, commands } = setup({ one: sessionAgent('one').script,
        two: sessionAgent('two', { agentCapabilities: { loadSession: true } }).script });
      const target = await manager.newSession('two');
      const selected = await manager.newSession('one');

      await commands.restart('two');

      expect(manager.getActiveSession()).toBe(selected);
      expect(manager.getSession({ configuredName: 'two', sessionId: target.sessionId })?.agentId).not.toBe(target.agentId);
      expect(user.take()).toEqual([
        progress('Restarting two...'),
        { call: 'showInformationMessage', message: 'Restarted two' },
      ]);
    });

    it('does nothing without an agent', async () => {
      const { agents, user, commands } = setup({ one: sessionAgent('one').script });

      await commands.restart();

      expect(agents.launched).toEqual([]);
      expect(user.take()).toEqual([]);
    });

    it('reports unsupported full reload without falling back to Resume', async () => {
      const one = sessionAgent('one', { agentCapabilities: { sessionCapabilities: { resume: {} } } });
      const { manager, user, commands, tabs } = setup({ one: one.script });
      await manager.newSession('one');
      const before = tabs.snapshot();

      await commands.restart();

      expect(user.take()).toEqual([
        progress('Restarting Fake Agent...'),
        { call: 'showErrorMessage', message: `Failed to restart: Could not reload ${ONE_FIRST_SESSION}: Full replay is not supported.` },
      ]);
      expect(one.requests).toEqual([]);
      expect(tabs.snapshot()).toEqual(before);
    });
  });

  describe('turns and session controls', () => {
    it.each(['mode', 'model'] as const)('does not apply an entered %s to a replacement registration with the same session ID', async (control) => {
      const requests: unknown[] = [];
      const script: AgentScript = () => fakeAgent({ agentCapabilities: { loadSession: true } })
        .onRequest(methods.agent.session.new, () => ({ sessionId: OLD_SESSION }))
        .onRequest(methods.agent.session.load, () => ({}))
        .onRequest(methods.agent.session.setMode, ({ params }) => { requests.push(params); return {}; });
      const { manager, user, commands } = setup({ one: script });
      const original = await manager.newSession('one');
      let answer: (value: string) => void = () => {};
      const input = new Promise<string>((resolve) => { answer = resolve; });
      vi.spyOn(user, 'showInputBox').mockReturnValueOnce(input);
      const setting = control === 'mode' ? commands.setMode() : commands.setModel();
      try {
        const replacement = await manager.loadSession('one', OLD_SESSION);
        expect(replacement).not.toBe(original);
      } finally { answer('plan'); }
      await setting;

      expect(requests).toEqual([]);
      expect(user.take()).toEqual([]);
    });

    it("cancels the active session's turn", async () => {
      const one = sessionAgent('one');
      const { manager, commands } = setup({ one: one.script });
      await manager.newSession('one');
      const cancelled = one.nextRequest();

      await commands.cancelTurn();

      expect(await cancelled).toEqual({ method: 'session/cancel', params: { sessionId: ONE_FIRST_SESSION } });
      expect(one.requests).toHaveLength(1);
    });

    it('sets the mode it is given', async () => {
      const one = sessionAgent('one');
      const { manager, user, commands } = setup({ one: one.script });
      await manager.newSession('one');

      await commands.setMode('plan');

      expect(one.requests).toEqual([{ method: 'session/set_mode', params: { sessionId: ONE_FIRST_SESSION, modeId: 'plan' } }]);
      expect(user.take()).toEqual([]);
    });

    it('asks for the mode when none is given, and does nothing when dismissed', async () => {
      const one = sessionAgent('one');
      const { manager, user, commands } = setup({ one: one.script });
      await manager.newSession('one');
      user.answer('code', undefined);

      await commands.setMode();
      await commands.setMode();

      const ask: Call = { call: 'showInputBox', options: { placeHolder: 'Enter mode ID (e.g., "plan", "code")', title: 'Set Agent Mode' } };
      expect(one.requests).toEqual([{ method: 'session/set_mode', params: { sessionId: ONE_FIRST_SESSION, modeId: 'code' } }]);
      expect(user.take()).toEqual([ask, ask]);
    });

    it('reports a model the agent cannot set', async () => {
      const { manager, user, commands } = setup({ one: sessionAgent('one').script });
      await manager.newSession('one');
      user.answer('gpt-9');

      await commands.setModel();

      expect(user.take()).toEqual([
        { call: 'showInputBox', options: { placeHolder: 'Enter model ID', title: 'Set Agent Model' } },
        { call: 'showErrorMessage', message: 'Failed to set model: Fake Agent does not expose a model config option' },
      ]);
    });

    it('does nothing without an active session', async () => {
      const { user, commands } = setup({ one: sessionAgent('one').script });

      await commands.cancelTurn();
      await commands.setMode('plan');
      await commands.setModel('gpt-9');

      expect(user.take()).toEqual([]);
    });
  });

  describe('open a session', () => {
    const loads = { agentCapabilities: { loadSession: true } };
    const resumes = { agentCapabilities: { sessionCapabilities: { resume: {} } } };

    it('loads the session in the chat view when the agent can load', async () => {
      const one = sessionAgent('one', loads);
      const { manager, user, commands } = setup({ one: one.script });

      await commands.open('one', OLD_SESSION);

      expect(manager.getActiveSessionId()).toBe(OLD_SESSION);
      expect(one.requests).toEqual([{ method: 'session/load', params: { sessionId: OLD_SESSION, cwd: '/work', mcpServers: [] } }]);
      expect(user.take()).toEqual([focusChatView, progress('Loading session…')]);
    });

    it('resumes the session when the agent can only resume', async () => {
      const one = sessionAgent('one', resumes);
      const { manager, user, commands } = setup({ one: one.script });

      await commands.open('one', OLD_SESSION);

      expect(manager.getActiveSessionId()).toBe(OLD_SESSION);
      expect(one.requests.map((r) => r.method)).toEqual(['session/resume']);
      expect(user.take()).toEqual([focusChatView, { call: 'showInformationMessage', message: 'Resumed session (history not replayed).' }]);
    });

    it('reports an agent that can neither load nor resume', async () => {
      const { user, commands } = setup({ one: sessionAgent('one').script });
      user.answer(undefined);

      await commands.open('one', OLD_SESSION);

      expect(user.take()).toEqual([focusChatView, failedToOpen('Agent "one" cannot load or resume sessions.')]);
    });

    it('only shows the chat view when the session is already active', async () => {
      const one = sessionAgent('one', loads);
      const { manager, transcript, user, commands } = setup({ one: one.script });
      await manager.loadSession('one', OLD_SESSION);
      transcript.hasRunningTurn = true;

      await commands.open('one', OLD_SESSION);

      expect(one.requests).toHaveLength(1);
      expect(user.take()).toEqual([focusChatView]);
    });

    it("opens another of the agent's sessions without asking while a turn is running, as the turn goes on", async () => {
      const one = sessionAgent('one', loads);
      const { manager, transcript, user, commands } = setup({ one: one.script });
      await manager.newSession('one');
      transcript.hasRunningTurn = true;

      await commands.open('one', OLD_SESSION);

      expect(manager.getActiveSessionId()).toBe(OLD_SESSION);
      expect(user.take()).toEqual([focusChatView, progress('Loading session…')]);
    });

    it("opens another of the agent's sessions without discarding queued prompts", async () => {
      const { manager, user, commands } = setup({ one: sessionAgent('one', loads).script });
      await manager.newSession('one');
      const identity = { configuredName: 'one', sessionId: ONE_FIRST_SESSION };
      manager.applyForegroundState(identity, 'running');
      const state = manager.sessionState(identity);
      if (!state) { throw new Error('Missing session state'); }
      await manager.submitPrompt(identity, state.generation, 'queued');

      await commands.open('one', OLD_SESSION);

      expect(manager.getActiveSessionId()).toBe(OLD_SESSION);
      expect(manager.sessionState(identity)?.queue.map(({ text }) => text)).toEqual(['queued']);
      expect(user.take()).toEqual([
        focusChatView,
        progress('Loading session…'),
      ]);
    });

    it("opens another agent's session without stopping a running turn", async () => {
      const two = sessionAgent('two', loads);
      const { manager, user, commands } = setup({ one: sessionAgent('one').script, two: two.script });
      await manager.newSession('one');
      const identity = { configuredName: 'one', sessionId: ONE_FIRST_SESSION };
      manager.applyForegroundState(identity, 'running');

      await commands.open('two', OLD_SESSION);

      expect(manager.getActiveSessionId()).toBe(OLD_SESSION);
      expect(manager.getActiveAgentName()).toBe('two');
      expect(manager.hasForegroundWork(identity)).toBe(true);
      expect(two.requests.map(({ method }) => method)).toEqual(['session/load']);
      expect(user.take()).toEqual([focusChatView, progress('Loading session…')]);
    });

    it('opens a dormant session without resolving the previous session review', async () => {
      const { manager, review, user, commands } = setup({ one: sessionAgent('one', loads).script });
      await manager.newSession('one');
      review.paths = ['/w/a.ts'];

      await commands.open('one', OLD_SESSION);

      expect(review.paths).toEqual(['/w/a.ts']);
      expect(manager.getActiveSessionId()).toBe(OLD_SESSION);
      expect(user.take()).toEqual([
        focusChatView,
        progress('Loading session…'),
      ]);
    });

    it('reports a session the agent fails to load', async () => {
      const { user, commands } = setup({
        one: () => fakeAgent(loads).onRequest(methods.agent.session.load, () => {
          throw RequestError.invalidParams(undefined, 'Session not found');
        }),
      });
      user.answer(undefined);

      await commands.open('one', 'gone');

      expect(user.take()).toEqual([focusChatView, progress('Loading session…'), failedToOpen('Invalid params: Session not found')]);
    });

    it('opens the session again through the same agent on Retry', async () => {
      const one = refusingAgent(1);
      const { manager, user, commands } = setup({ one: one.script });
      user.answer('Retry');

      await commands.open('one', OLD_SESSION);

      expect(manager.getActiveSessionId()).toBe(OLD_SESSION);
      expect(user.take()).toEqual([
        focusChatView,
        progress('Loading session…'),
        failedToOpen('Internal error: session in use by another client'),
        progress('Loading session…'),
      ]);
    });

    it('shows the Agents view to choose another session on Choose Session', async () => {
      const { user, commands } = setup({ one: refusingAgent().script });
      user.answer('Choose Session');

      await commands.open('one', OLD_SESSION);

      expect(user.take()).toEqual([focusChatView, progress('Loading session…'), failedToOpen('Internal error: session in use by another client'), choosingSession]);
    });

    it('opens the session through the agent chosen from every configuration, where its reference moves', async () => {
      const two = sessionAgent('two', loads);
      const { manager, references, user, commands } = setup({ one: refusingAgent().script, two: two.script });
      await references.setTitle(addressOf('one', OLD_SESSION), 'Kept title');
      user.answer('Choose Agent', 'two');

      await commands.open('one', OLD_SESSION);

      expect(manager.getActiveSession()).toMatchObject({ sessionId: OLD_SESSION, agentName: 'two', title: 'Kept title' });
      expect(user.take()).toEqual([
        focusChatView,
        progress('Loading session…'),
        failedToOpen('Internal error: session in use by another client'),
        choosingAgent(['one', 'two']),
        progress('Loading session…'),
      ]);
      expect(references.get({ host: WORKSPACE.host, configuredName: 'one', sessionId: OLD_SESSION })).toBeUndefined();
      expect(references.get({ host: WORKSPACE.host, configuredName: 'two', sessionId: OLD_SESSION })).toMatchObject({ title: 'Kept title' });
    });

    describe('that the agent reports unknown', () => {
      const unknown = () => fakeAgent(loads).onRequest(methods.agent.session.load, ({ params }) => {
        throw new RequestError(-32002, 'Resource not found', { sessionId: params.sessionId });
      });
      const offered = failedToOpen('Resource not found', [...RETRY_CHOOSE, 'Remove from History']);
      const referenced = (references: SessionReferences, sessionId: string) =>
        references.get({ host: WORKSPACE.host, configuredName: 'one', sessionId });

      it('offers to remove it from session history, and removes it when asked', async () => {
        const { references, user, commands } = setup({ one: unknown });
        await references.used({ configuredName: 'one', sessionId: 'gone', cwd: '/work', host: WORKSPACE.host, workspaceUri: WORKSPACE.uri });
        user.answer('Remove from History');

        await commands.open('one', 'gone');

        expect(user.take()).toEqual([focusChatView, progress('Loading session…'), offered]);
        expect(referenced(references, 'gone')).toBeUndefined();
      });

      it('keeps it in session history when the offer is dismissed', async () => {
        const { references, user, commands } = setup({ one: unknown });
        await references.used({ configuredName: 'one', sessionId: 'gone', cwd: '/work', host: WORKSPACE.host, workspaceUri: WORKSPACE.uri });
        user.answer(undefined);

        await commands.open('one', 'gone');

        expect(user.take()).toEqual([focusChatView, progress('Loading session…'), offered]);
        expect(referenced(references, 'gone')).toBeDefined();
      });
    });

    it('reports a missing agent or session', async () => {
      const { user, commands } = setup({ one: sessionAgent('one').script });

      await commands.open(undefined, OLD_SESSION);
      await commands.open('one', undefined);

      const missing: Call = { call: 'showErrorMessage', message: 'Open Session: missing agentName/sessionId.' };
      expect(user.take()).toEqual([missing, missing]);
    });
  });

  describe('restore the last session', () => {
    it('loads the last active session, asking nothing', async () => {
      const one = refusingAgent(0);
      const { manager, workspace, user, commands } = setup({ one: one.script });
      await workspace.setLastActiveSession(addressOf('one', OLD_SESSION));

      await commands.restoreLastSession();

      expect(manager.getActiveSessionId()).toBe(OLD_SESSION);
      expect(one.loaded).toEqual([OLD_SESSION]);
      expect(user.take()).toEqual([]);
    });

    it('loads nothing once the user has set out to open a session themselves, though it failed to open', async () => {
      const one = refusingAgent();
      const { workspace, user, commands } = setup({ one: one.script });
      await workspace.setLastActiveSession(addressOf('one', OLD_SESSION));
      user.answer(undefined);
      await commands.open('one', OLDER_SESSION);
      user.take();

      await commands.restoreLastSession();

      expect(one.requested).toEqual([OLDER_SESSION]);
      expect(user.take()).toEqual([]);
    });

    it.each<[string, (commands: SessionCommands) => Promise<void>, string[]]>([
      ['connecting to another agent', (commands) => commands.connect('two'), []],
      ['starting a new session', (commands) => commands.newSession(), [`one creates ${ONE_FIRST_SESSION}`]],
      ['restarting the agent', (commands) => commands.restart(), [`one loads ${OLD_SESSION}`, `one answers ${OLD_SESSION}`]],
    ])('lets a load under way end before %s', async (_, act, after) => {
      const order: string[] = [];
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => { release = resolve; });
      const creating = (name: keyof typeof CREATED_SESSIONS) => fakeAgent({ agentCapabilities: { loadSession: true } })
        .onRequest(methods.agent.session.new, () => {
          const sessionId = CREATED_SESSIONS[name][0];
          order.push(`${name} creates ${sessionId}`);
          return { sessionId };
        });
      const one: AgentScript = () => creating('one').onRequest(methods.agent.session.load, async () => {
        order.push(`one loads ${OLD_SESSION}`);
        await released;
        order.push(`one answers ${OLD_SESSION}`);
        return {};
      });
      const { manager, workspace, commands } = setup({ one, two: () => creating('two') });
      await workspace.setLastActiveSession(addressOf('one', OLD_SESSION));
      const loading = new Promise<void>((resolve) => { manager.once('session-load-start', () => resolve()); });

      const restoring = commands.restoreLastSession();
      await loading;
      const acting = act(commands);
      release();
      await Promise.all([restoring, acting]);

      expect(order).toEqual([`one loads ${OLD_SESSION}`, `one answers ${OLD_SESSION}`, ...after]);
    });

    it('loads the session again through the same configuration on Retry', async () => {
      const one = refusingAgent(1);
      const { manager, workspace, user, commands } = setup({ one: one.script });
      await workspace.setLastActiveSession(addressOf('one', OLD_SESSION));
      user.answer('Retry');

      await commands.restoreLastSession();

      expect(manager.getActiveSessionId()).toBe(OLD_SESSION);
      expect(user.take()).toEqual([failedToOpen('Internal error: session in use by another client'), progress('Loading session…')]);
    });

    it('shows the Agents view to choose another session on Choose Session', async () => {
      const { workspace, user, commands } = setup({ one: refusingAgent().script });
      await workspace.setLastActiveSession(addressOf('one', OLD_SESSION));
      user.answer('Choose Session');

      await commands.restoreLastSession();

      expect(user.take()).toEqual([failedToOpen('Internal error: session in use by another client'), choosingSession]);
    });

    it('loads through the agent chosen from every configuration, where the reference and the last active session move', async () => {
      const { manager, references, workspace, user, commands } = setup({ one: refusingAgent().script, two: refusingAgent(0).script });
      await references.setTitle(addressOf('one', OLD_SESSION), 'Kept title');
      await workspace.setLastActiveSession(addressOf('one', OLD_SESSION));
      user.answer('Choose Agent', 'two');

      await commands.restoreLastSession();

      expect(manager.getActiveSession()).toMatchObject({ sessionId: OLD_SESSION, agentName: 'two', title: 'Kept title' });
      expect(user.take()).toEqual([
        failedToOpen('Internal error: session in use by another client'),
        choosingAgent(['one', 'two']),
        progress('Loading session…'),
      ]);
      expect(references.get({ host: WORKSPACE.host, configuredName: 'two', sessionId: OLD_SESSION })).toMatchObject({ title: 'Kept title' });
      expect(workspace.lastActiveSession()).toEqual(addressOf('two', OLD_SESSION));
    });

    it('offers only Choose Session when the workspace cwd is not the one the session was used in', async () => {
      const { workspace, user, commands } = setup({ one: refusingAgent(0).script });
      await workspace.setLastActiveSession({ ...addressOf('one', OLD_SESSION), cwd: '/moved' });
      user.answer(undefined);

      await commands.restoreLastSession();

      expect(user.take()).toEqual([failedToOpen("The session was used in /moved, but this workspace's agents run in /work.", ['Choose Session'])]);
    });

    it('offers to remove a session the agent does not know from history, and removes it when asked', async () => {
      const unknown: AgentScript = () => fakeAgent({ agentCapabilities: { loadSession: true } })
        .onRequest(methods.agent.session.load, ({ params }) => {
          throw new RequestError(-32002, 'Resource not found', { sessionId: params.sessionId });
        });
      const { references, workspace, user, commands } = setup({ one: unknown });
      await references.used(addressOf('one', 'gone'));
      await workspace.setLastActiveSession(addressOf('one', 'gone'));
      user.answer('Remove from History');

      await commands.restoreLastSession();

      expect(user.take()).toEqual([failedToOpen('Resource not found', [...RETRY_CHOOSE, 'Remove from History'])]);
      expect(references.get({ host: WORKSPACE.host, configuredName: 'one', sessionId: 'gone' })).toBeUndefined();
    });
  });

  describe('a session another window asked for', () => {
    it('shows the chat view when the window opened with a request, which its startup load then loads', async () => {
      const one = refusingAgent(0);
      const { manager, workspace, user, commands, request } = setup({ one: one.script });
      await workspace.setLastActiveSession(addressOf('one', OLD_SESSION));
      await request(addressOf('one', REQUESTED_SESSION));

      await commands.revealRequested();
      await commands.restoreLastSession();

      expect(manager.getActiveSessionId()).toBe(REQUESTED_SESSION);
      expect(one.requested).toEqual([REQUESTED_SESSION]);
      expect(user.take()).toEqual([focusChatView]);
    });

    it('shows nothing when the window opened without one', async () => {
      const { user, commands } = setup({ one: refusingAgent(0).script });

      await commands.revealRequested();

      expect(user.take()).toEqual([]);
    });

    it('opens one made since the window opened as Open Session does, once', async () => {
      const one = refusingAgent(0);
      const { manager, user, commands, request } = setup({ one: one.script });
      await commands.revealRequested();
      await request(addressOf('one', REQUESTED_SESSION));

      await commands.openRequested();
      await commands.openRequested();

      expect(manager.getActiveSessionId()).toBe(REQUESTED_SESSION);
      expect(one.requested).toEqual([REQUESTED_SESSION]);
      expect(user.take()).toEqual([focusChatView, progress('Loading session…')]);
    });

    it('opens the requested session without discarding the previous session queue', async () => {
      const one = refusingAgent(0);
      const { manager, user, commands, request } = setup({ one: one.script, two: sessionAgent('two').script });
      await commands.revealRequested();
      await manager.newSession('two');
      const identity = { configuredName: 'two', sessionId: TWO_FIRST_SESSION };
      manager.applyForegroundState(identity, 'running');
      const state = manager.sessionState(identity);
      if (!state) { throw new Error('Missing session state'); }
      await manager.submitPrompt(identity, state.generation, 'queued');
      await request(addressOf('one', REQUESTED_SESSION));

      await commands.openRequested();

      expect(manager.getActiveSessionId()).toBe(REQUESTED_SESSION);
      expect(manager.sessionState(identity)?.queue.map(({ text }) => text)).toEqual(['queued']);
      expect(one.requested).toEqual([REQUESTED_SESSION]);
      expect(user.take()).toEqual([focusChatView, progress('Loading session…')]);
    });

    it('does not open again the request the window opened with', async () => {
      const one = refusingAgent(0);
      const { user, commands, request } = setup({ one: one.script });
      await request(addressOf('one', REQUESTED_SESSION));
      await commands.revealRequested();
      user.take();

      await commands.openRequested();

      expect(one.requested).toEqual([]);
      expect(user.take()).toEqual([]);
    });
  });
});
