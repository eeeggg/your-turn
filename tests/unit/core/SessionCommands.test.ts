import { randomUUID } from 'node:crypto';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { methods, RequestError } from '@agentclientprotocol/sdk';
import type { AgentApp, InitializeResponse } from '@agentclientprotocol/sdk';
import { ConnectionManager } from '@/core/acp/ConnectionManager';
import {
  SessionReferences,
  StartupRequests,
  WorkspaceState,
  type KeyValueStore,
  type SessionAddress
} from '@/core/PersistedState';
import { SessionCommands } from '@/core/SessionCommands';
import { SessionManager, type SessionEnvironment } from '@/core/SessionManager';
import { SessionStartup } from '@/core/SessionStartup';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import { SessionTabs } from '@/core/SessionTabs';
import type { ReviewDecision, ReviewDecisionResult } from '@/core/review/Reviews';
import { ProgressLocation } from '@/core/VsCodeApi';
import {
  fakeAgent,
  InProcessAgents,
  unusedHandlers,
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
    new ConnectionManager('0.0.0-test', () => unusedHandlers),
    environment,
    { chooseAuthMethod: async () => undefined },
    new SessionUpdateHandler(),
  );
  const globalState = memoryStore();
  const references = new SessionReferences(globalState);
  const workspace = new WorkspaceState(memoryStore());
  manager.setPersistedState(references, workspace);
  const tabs = new SessionTabs(persistedTabs ? { workspace, references, environment } : undefined);
  manager.on('session-opened', ({ sessionId }) => {
    const session = manager.getSession(sessionId);
    if (session) { tabs.open(session); }
  });
  const transcript = { hasRunningTurn: false, queuedPrompts: 0, clearTranscript: vi.fn(), sessionTabs: tabs, notifyTabsChanged: vi.fn() };
  /** The session each Keep All was made in. */
  const keptIn: (string | null)[] = [];
  let resolutionBlocked = false;
  class CapturedKeep implements ReviewDecision {
    readonly action = 'keep-all';
    constructor(readonly paths: readonly string[]) {}
  }
  const review = {
    paths: [] as string[],
    resolutionBlocked: () => resolutionBlocked,
    blockResolution: () => { resolutionBlocked = true; },
    reviewedPaths: () => review.paths,
    captureKeepAll: (): ReviewDecision => new CapturedKeep([...review.paths]),
    keepAll: async (decision?: ReviewDecision): Promise<ReviewDecisionResult> => {
      const resolved = decision instanceof CapturedKeep ? [...decision.paths] : [...review.paths];
      keptIn.push(manager.getActiveSessionId());
      review.paths = review.paths.filter((path) => !resolved.includes(path));
      return { kind: 'applied', saved: true, resolved };
    },
  };
  const user = new ScriptedUser();
  const startup = new SessionStartup(manager, workspace, environment, new StartupRequests(globalState), persistedTabs ? tabs : undefined);
  const commands = new SessionCommands(manager, transcript, review, user, user, () => Object.keys(scripts), startup);
  /** Another window asks the window opening the address's workspace to load its session. */
  const request = (address: SessionAddress) => new StartupRequests(globalState).request(address);
  return { agents, manager, references, workspace, transcript, review, keptIn, user, commands, request, tabs, environment };
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

const underReview = (count: string) => `${count} still under review, kept until this session is opened again in this window.`;
const asked = (question: string, detail: string, action: string, keepAll?: { label: string; detail: string }): Call => ({
  call: 'showQuickPick',
  items: [{ label: action, detail }, ...(keepAll ? [keepAll] : []), { label: 'Cancel' }],
  options: { title: action, placeHolder: question },
});

describe('SessionCommands', () => {
  it('creates distinct default sessions across agents and repeated restarts without a fixed creation limit', async () => {
    const one = sessionAgent();
    const two = sessionAgent();
    const { commands, manager } = setup({ one: one.script, two: two.script });
    onTestFinished(() => manager.dispose());
    await commands.connect('one');
    const first = manager.getActiveSessionId();
    expect(first).not.toBeNull();
    await commands.connect('two');
    const second = manager.getActiveSessionId();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    await commands.newSession();
    const third = manager.getActiveSessionId();
    expect(third).not.toBeNull();
    expect(third).not.toBe(first);
    expect(third).not.toBe(second);
    await commands.restart();
    const fourth = manager.getActiveSessionId();
    expect(fourth).not.toBeNull();
    expect([first, second, third]).not.toContain(fourth);
    const cancelled = two.nextRequest();
    await commands.cancelTurn();
    expect(await cancelled).toEqual({ method: 'session/cancel', params: { sessionId: fourth } });
  });

  it('selects the renamed tab of a live session without loading or reconnecting', async () => {
    const one = sessionAgent('one', { agentCapabilities: { loadSession: true } });
    const { commands, manager, tabs, agents, environment, user } = setup({ one: one.script, renamed: one.script }, true);
    onTestFinished(() => manager.dispose());
    const before = { one: { command: 'one' } };
    const after = { renamed: { command: 'one' } };
    environment.agentConfigs = () => before;
    await commands.connect('one');
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
    expect(user.take()).toEqual([focusChatView]);
  });

  it('confirms closing a renamed live tab and disconnects its actual running agent only after acceptance', async () => {
    const { commands, manager, tabs, transcript, environment, user } = setup({ one: sessionAgent('one').script }, true);
    onTestFinished(() => manager.dispose());
    const before = { one: { command: 'one' } };
    const after = { renamed: { command: 'one' } };
    await commands.connect('one');
    environment.agentConfigs = () => after;
    manager.agentsChanged(before, after);
    tabs.agentsChanged(before, after);
    const snapshot = tabs.snapshot();
    if (!snapshot.selectedTabId) { throw new Error('missing active tab'); }
    transcript.hasRunningTurn = true;
    user.take();
    user.answer(undefined);

    await commands.closeTab(snapshot.selectedTabId);

    expect(tabs.snapshot()).toEqual(snapshot);
    expect(manager.isConnected('renamed')).toBe(true);
    expect(manager.isConnected('one')).toBe(false);
    expect(user.take()).toEqual([asked('Close this session tab?', 'This stops the turn in progress.', 'Close Tab')]);
    user.answer('Close Tab');
    await commands.closeTab(snapshot.selectedTabId);
    expect(manager.getActiveSessionId()).toBeNull();
    expect(manager.isConnected('renamed')).toBe(false);
    expect(manager.isConnected('one')).toBe(false);
    expect(tabs.snapshot()).toEqual({ tabs: [], selectedTabId: null });
  });

  it('returns to an already active renamed MRU tab without replaying it', async () => {
    const one = sessionAgent('one', { agentCapabilities: { loadSession: true } });
    const { commands, manager, tabs, agents, environment } = setup({ one: one.script, renamed: one.script }, true);
    onTestFinished(() => manager.dispose());
    const before = { one: { command: 'one' } };
    const after = { renamed: { command: 'one' } };
    environment.agentConfigs = () => before;
    await commands.connect('one');
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

  it('asks before a dormant-tab close opens an MRU session that would stop active work', async () => {
    const { commands, manager, tabs, transcript, agents, user } = setup({ one: sessionAgent('one').script, two: sessionAgent('two', { agentCapabilities: { loadSession: true } }).script }, true);
    onTestFinished(() => manager.dispose());
    await commands.connect('one');
    tabs.open({ agentName: 'two', agentDisplayName: 'Two', sessionId: OLDER_SESSION, cwd: work.cwd });
    const dormant = tabs.open({ agentName: 'removed', agentDisplayName: 'Removed', sessionId: DORMANT_SESSION, cwd: work.cwd });
    transcript.hasRunningTurn = true;
    user.take();
    user.answer(undefined);

    await commands.closeTab(dormant);

    expect(manager.getActiveAgentName()).toBe('one');
    expect(agents.launched).toHaveLength(1);
    expect(tabs.snapshot().selectedTabId).toBeNull();
    expect(tabs.snapshot().tabs.map((tab) => tab.agentName)).toEqual(['one', 'two']);
    expect(user.take()).toEqual([asked('Open a different session?', 'This stops the turn in progress.', 'Open Session')]);
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
    expect(user.take()).toEqual([focusChatView, failedToOpen(`The session belongs to ${WORKSPACE.uri} on ${WORKSPACE.host}, but this workspace is ${target.uri} on ${target.host}.`)]);
  });

  it('rejects a restored tab whose cwd changed before launching its agent', async () => {
    const { commands, manager, tabs, agents, user } = setup({ one: sessionAgent('one', { agentCapabilities: { loadSession: true } }).script }, true);
    onTestFinished(() => manager.dispose());
    const tabId = tabs.open({ agentName: 'one', agentDisplayName: 'One', sessionId: OLD_SESSION, cwd: '/previous' });
    user.answer(undefined);

    await commands.selectTab(tabId);

    expect(agents.launched).toEqual([]);
    expect(tabs.snapshot().selectedTabId).toBe(tabId);
    expect(user.take()).toEqual([focusChatView, failedToOpen("The session was used in /previous, but this workspace's agents run in /work.", ['Choose Session'])]);
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
    await commands.connect('one');
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
    await manager.connectToAgent('one');
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
    await commands.connect('one');
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

  it('does not create a targeted session when stopping foreground work is declined', async () => {
    const { commands, manager, tabs, user, transcript, agents } = setup({ one: sessionAgent('one').script, two: sessionAgent('two').script });
    await commands.connect('one');
    const before = tabs.snapshot();
    transcript.hasRunningTurn = true;
    user.answer(undefined);
    await commands.newSession('two');
    expect(manager.getActiveSessionId()).toBe(ONE_FIRST_SESSION);
    expect(tabs.snapshot()).toEqual(before);
    expect(agents.launched.map((agent) => agent.name)).toEqual(['one']);
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
    await commands.connect('one');
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
    await commands.connect('one');
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
    await commands.connect('one');
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

  it('leaves navigation unchanged when departure is cancelled and closes unfocused references without a request', async () => {
    const agent = sessionAgent('one', { agentCapabilities: { loadSession: true } });
    const { commands, manager, tabs, transcript, user, agents } = setup({ one: agent.script });
    await commands.connect('one');
    await commands.open('one', OLDER_SESSION);
    const [first, second] = tabs.snapshot().tabs;
    if (!first || !second) { throw new Error('missing tabs'); }
    transcript.queuedPrompts = 1;
    const before = tabs.snapshot();
    user.answer(undefined, undefined);
    await commands.selectTab(first.tabId);
    await commands.closeTab(second.tabId);
    expect(tabs.snapshot()).toEqual(before);
    expect(manager.getActiveSessionId()).toBe(OLDER_SESSION);
    const requests = [...agent.requests];
    await commands.closeTab(first.tabId);
    expect(agent.requests).toEqual(requests);
    expect(agents.launched).toHaveLength(1);
    expect(tabs.snapshot().tabs.map((tab) => tab.tabId)).toEqual([second.tabId]);
  });

  it('creates a fresh session for an explicitly targeted agent without an intermediate session', async () => {
    const { commands, manager, agents, tabs } = setup({ one: sessionAgent('one').script, two: sessionAgent('two').script });
    await commands.connect('one');
    await commands.newSession('two');
    expect(manager.getActiveSessionId()).toBe(TWO_FIRST_SESSION);
    expect(manager.hasSession('one')).toBe(false);
    expect(agents.launched.map((agent) => agent.name)).toEqual(['one', 'two']);
    await commands.newSession('two');
    expect(manager.getActiveSessionId()).toBe(TWO_SECOND_SESSION);
    expect(tabs.snapshot().tabs.map((tab) => tab.sessionId)).toEqual([ONE_FIRST_SESSION, TWO_FIRST_SESSION, TWO_SECOND_SESSION]);
  });

  describe('connect', () => {
    it('makes a session with the named agent the active session', async () => {
      const { manager, user, commands } = setup({ one: sessionAgent('one').script });

      await commands.connect('one');

      expect(manager.getActiveSessionId()).toBe(ONE_FIRST_SESSION);
      expect(user.take()).toEqual([progress('Connecting to one...')]);
    });

    it('asks which configured agent to connect when none is named', async () => {
      const { manager, user, commands } = setup({ one: sessionAgent('one').script, two: sessionAgent('two').script });
      user.answer('two');

      await commands.connect();

      expect(manager.getActiveSessionId()).toBe(TWO_FIRST_SESSION);
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

    it('switches agents without asking when nothing would be lost, and clears the transcript', async () => {
      const { manager, transcript, user, commands } = setup({ one: sessionAgent('one').script, two: sessionAgent('two').script });
      await manager.connectToAgent('one');

      await commands.connect('two');

      expect(manager.getActiveSessionId()).toBe(TWO_FIRST_SESSION);
      expect(manager.hasSession('one')).toBe(false);
      expect(transcript.clearTranscript).toHaveBeenCalledOnce();
      expect(user.take()).toEqual([progress('Connecting to two...')]);
    });

    it('asks before switching agents while a turn is running, as it stops the agent', async () => {
      const { manager, transcript, user, commands } = setup({ one: sessionAgent('one').script, two: sessionAgent('two').script });
      await manager.connectToAgent('one');
      transcript.hasRunningTurn = true;
      user.answer('Switch Agent');

      await commands.connect('two');

      expect(manager.getActiveSessionId()).toBe(TWO_FIRST_SESSION);
      expect(user.take()).toEqual([
        asked('Switch to two?', 'This stops the turn in progress.', 'Switch Agent'),
        progress('Connecting to two...'),
      ]);
    });

    it('keeps the session and the transcript when the user declines to switch', async () => {
      const { manager, transcript, user, commands } = setup({ one: sessionAgent('one').script, two: sessionAgent('two').script });
      await manager.connectToAgent('one');
      transcript.hasRunningTurn = true;
      user.answer(undefined);

      await commands.connect('two');

      expect(manager.getActiveSessionId()).toBe(ONE_FIRST_SESSION);
      expect(transcript.clearTranscript).not.toHaveBeenCalled();
    });

    it('asks while files are under review, and with Keep All keeps them before switching', async () => {
      const { manager, review, keptIn, user, commands } = setup({ one: sessionAgent('one').script, two: sessionAgent('two').script });
      await manager.connectToAgent('one');
      review.paths = ['/w/a.ts', '/w/b.ts'];
      user.answer('Keep All and Switch');

      await commands.connect('two');

      expect(keptIn).toEqual([ONE_FIRST_SESSION]);
      expect(manager.getActiveSessionId()).toBe(TWO_FIRST_SESSION);
      expect(user.take()).toEqual([
        asked('Switch to two?', underReview('2 files are'), 'Switch Agent', {
          label: 'Keep All and Switch', detail: 'Keep 2 files under review before continuing.',
        }),
        progress('Connecting to two...'),
      ]);
    });

    it.each([
      ['connect', 'Keep All and Switch'],
      ['new-same', 'Keep All and Start'],
      ['new-other', 'Keep All and Start'],
      ['open', 'Keep All and Open'],
      ['close', 'Keep All and Close'],
    ] as const)('awaits Keep All and permits %s departure only for applied outcomes', async (departure, label) => {
      for (const kind of ['blocked', 'stale', 'failed', 'applied'] as const) {
        const { manager, review, user, commands, transcript, tabs } = setup({
          one: sessionAgent('one', { agentCapabilities: { loadSession: true } }).script,
          two: sessionAgent('two').script,
        });
        await manager.connectToAgent('one');
        review.paths = ['/w/a.ts'];
        const selected = tabs.snapshot().selectedTabId;
        if (!selected) { throw new Error('Missing selected session tab'); }
        let release = () => {};
        let started = () => {};
        const waiting = new Promise<void>((resolve) => { started = resolve; });
        const gate = new Promise<void>((resolve) => { release = resolve; });
        vi.spyOn(review, 'keepAll').mockImplementation(async () => {
          started();
          await gate;
          return kind === 'applied' ? { kind, saved: true, resolved: ['/w/a.ts'] }
            : kind === 'failed' ? { kind, reason: 'Cannot save', applied: ['/w/a.ts'], unsaved: ['/w/a.ts'] }
              : { kind, reason: 'Not current' };
        });
        user.answer(label);
        const leaving = departure === 'connect' ? commands.connect('two')
          : departure === 'new-same' ? commands.newSession()
            : departure === 'new-other' ? commands.newSession('two')
              : departure === 'open' ? commands.open('one', OLD_SESSION) : commands.closeTab(selected);
        try {
          await waiting;
          expect(manager.getActiveSessionId()).toBe(ONE_FIRST_SESSION);
          expect(tabs.snapshot().selectedTabId).toBe(selected);
          expect(transcript.clearTranscript).not.toHaveBeenCalled();
          release();
          await leaving;
          expect(manager.getActiveSessionId()).toBe(kind !== 'applied' ? ONE_FIRST_SESSION
            : departure === 'connect' || departure === 'new-other' ? TWO_FIRST_SESSION
              : departure === 'new-same' ? ONE_SECOND_SESSION : departure === 'open' ? OLD_SESSION : null);
          if (kind !== 'applied') {
            expect(transcript.clearTranscript).not.toHaveBeenCalled();
            expect(tabs.snapshot().selectedTabId).toBe(selected);
          }
          expect(review.paths).toEqual(['/w/a.ts']);
        } finally { release(); await leaving; }
      }
    });

    it.each(['blocked', 'stale', 'failed'] as const)('does not switch after a %s Keep All outcome', async (kind) => {
      const { manager, review, user, commands, transcript } = setup({ one: sessionAgent('one').script, two: sessionAgent('two').script });
      await manager.connectToAgent('one');
      review.paths = ['/w/a.ts'];
      vi.spyOn(review, 'keepAll').mockResolvedValue(kind === 'failed'
        ? { kind, reason: 'Cannot save', applied: ['/w/a.ts'], unsaved: ['/w/a.ts'] }
        : { kind, reason: 'Not current' });
      user.answer('Keep All and Switch');
      await commands.connect('two');
      expect(manager.getActiveSessionId()).toBe(ONE_FIRST_SESSION);
      expect(transcript.clearTranscript).not.toHaveBeenCalled();
      expect(review.paths).toEqual(['/w/a.ts']);
    });

    it('freezes departure Keep All before the picker can receive newer files', async () => {
      const { manager, review, user, commands } = setup({ one: sessionAgent('one').script, two: sessionAgent('two').script });
      await manager.connectToAgent('one');
      review.paths = ['/w/a.ts'];
      const pick = user.showQuickPick.bind(user);
      vi.spyOn(user, 'showQuickPick').mockImplementation((items, options) => {
        review.paths.push('/w/newer.ts');
        return pick(items, options);
      });
      user.answer('Keep All and Switch');
      await commands.connect('two');
      expect(review.paths).toEqual(['/w/newer.ts']);
      expect(manager.getActiveSessionId()).toBe(TWO_FIRST_SESSION);
    });

    it('keeps ordinary departure available but omits Keep All while workspace resolution is blocked', async () => {
      const { manager, review, user, commands } = setup({ one: sessionAgent('one').script, two: sessionAgent('two').script });
      await manager.connectToAgent('one');
      review.paths = ['/w/a.ts'];
      review.blockResolution();
      user.answer('Switch Agent');
      await commands.connect('two');
      const choices = user.take().find((call) => call.call === 'showQuickPick');
      expect(choices?.call === 'showQuickPick' ? choices.items : []).toEqual([
        { label: 'Switch Agent', detail: '1 file is still under review, kept until this session is opened again in this window.' },
        { label: 'Cancel' },
      ]);
      expect(review.paths).toEqual(['/w/a.ts']);
      expect(manager.getActiveSessionId()).toBe(TWO_FIRST_SESSION);
    });

    it('does not ask when connecting the agent that already has the active session', async () => {
      const { manager, transcript, review, user, commands } = setup({ one: sessionAgent('one').script });
      await manager.connectToAgent('one');
      transcript.hasRunningTurn = true;
      transcript.queuedPrompts = 1;
      review.paths = ['/w/a.ts'];

      await commands.connect('one');

      expect(manager.getActiveSessionId()).toBe(ONE_FIRST_SESSION);
      expect(user.take()).toEqual([progress('Connecting to one...')]);
    });

    it('reports a failure to connect', async () => {
      const { user, commands } = setup({
        broken: () => fakeAgent().onRequest(methods.agent.session.new, () => {
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
      await manager.connectToAgent('one');

      await commands.newSession();

      expect(manager.getActiveSessionId()).toBe(ONE_SECOND_SESSION);
      expect(user.take()).toEqual([progress('Starting new session with Fake Agent...')]);
    });

    it('asks first while a turn is running', async () => {
      const { agents, manager, transcript, user, commands } = setup({ one: sessionAgent('one').script });
      await manager.connectToAgent('one');
      transcript.hasRunningTurn = true;
      user.answer(undefined);

      await commands.newSession();

      expect(agents.launched).toHaveLength(1);
      expect(manager.getActiveSessionId()).toBe(ONE_FIRST_SESSION);
      expect(user.take()).toEqual([asked('Start a new session?', 'This stops the turn in progress.', 'New Session')]);
    });

    it('names everything it would lose, and keeps every file when asked', async () => {
      const { manager, transcript, review, keptIn, user, commands } = setup({ one: sessionAgent('one').script });
      await manager.connectToAgent('one');
      transcript.hasRunningTurn = true;
      transcript.queuedPrompts = 1;
      review.paths = ['/w/a.ts'];
      user.answer('Keep All and Start');

      await commands.newSession();

      expect(keptIn).toEqual([ONE_FIRST_SESSION]);
      expect(manager.getActiveSessionId()).toBe(ONE_SECOND_SESSION);
      expect(user.take()).toEqual([
        asked(
          'Start a new session?',
          `This stops the turn in progress and discards 1 queued prompt. ${underReview('1 file is')}`,
          'New Session',
          { label: 'Keep All and Start', detail: 'This stops the turn in progress and discards 1 queued prompt. Keep 1 file under review before continuing.' },
        ),
        progress('Starting new session with Fake Agent...'),
      ]);
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
      await manager.connectToAgent('flaky');

      await commands.newSession();

      expect(user.take()).toEqual([
        progress('Starting new session with Fake Agent...'),
        { call: 'showErrorMessage', message: 'Failed to start new session: Internal error: out of quota' },
      ]);
    });
  });

  describe.each([
    { action: 'Switch Agent', transition: (commands: SessionCommands) => commands.connect('two'), destination: TWO_FIRST_SESSION },
    { action: 'New Session', transition: (commands: SessionCommands) => commands.newSession(), destination: ONE_SECOND_SESSION },
    { action: 'Open Session', transition: (commands: SessionCommands) => commands.open('two', OLD_SESSION), destination: OLD_SESSION },
  ])('$action decisions', ({ action, transition, destination }) => {
    it.each([
      ['dismisses the confirmation', undefined],
      ['chooses Cancel', 'Cancel'],
    ])('leaves the session, transcript, queued prompts, and review unchanged when the user %s', async (_choice, answer) => {
      const { agents, manager, transcript, review, keptIn, user, commands } = setup({
        one: sessionAgent('one').script,
        two: sessionAgent('two', { agentCapabilities: { loadSession: true } }).script,
      });
      await manager.connectToAgent('one');
      transcript.hasRunningTurn = true;
      transcript.queuedPrompts = 2;
      review.paths = ['/w/a.ts'];
      user.answer(answer);

      await transition(commands);

      expect(manager.getActiveSessionId()).toBe(ONE_FIRST_SESSION);
      expect(agents.running('one')).toHaveLength(1);
      expect(agents.launched).toHaveLength(1);
      expect(transcript.clearTranscript).not.toHaveBeenCalled();
      expect(transcript.queuedPrompts).toBe(2);
      expect(review.paths).toEqual(['/w/a.ts']);
      expect(keptIn).toEqual([]);
      expect(user.take()).toHaveLength(1);
    });

    it('continues without Keep All and leaves review unresolved', async () => {
      const { manager, review, keptIn, user, commands } = setup({
        one: sessionAgent('one').script,
        two: sessionAgent('two', { agentCapabilities: { loadSession: true } }).script,
      });
      await manager.connectToAgent('one');
      review.paths = ['/w/a.ts'];
      user.answer(action);

      await transition(commands);

      expect(manager.getActiveSessionId()).toBe(destination);
      expect(review.paths).toEqual(['/w/a.ts']);
      expect(keptIn).toEqual([]);
    });
  });

  describe('disconnect', () => {
    it("stops the active session's agent", async () => {
      const { agents, manager, user, commands } = setup({ one: sessionAgent('one').script });
      await manager.connectToAgent('one');

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
    it("restarts the active session's agent on a new process with a new session", async () => {
      const { agents, manager, user, commands } = setup({ one: sessionAgent('one').script });
      await manager.connectToAgent('one');
      const [first] = agents.launched;

      await commands.restart();

      expect(first?.killed).toBe(true);
      expect(agents.running('one')).toHaveLength(1);
      expect(manager.getActiveSessionId()).toBe(ONE_SECOND_SESSION);
      expect(user.take()).toEqual([
        progress('Restarting Fake Agent...'),
        { call: 'showInformationMessage', message: 'Restarted one' },
      ]);
    });

    it('restarts the agent it is given', async () => {
      const { manager, user, commands } = setup({ one: sessionAgent('one').script, two: sessionAgent('two').script });
      await manager.connectToAgent('one');

      await commands.restart('two');

      expect(manager.getActiveAgentName()).toBe('two');
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

    it('reports a failure to restart', async () => {
      let created = 0;
      const { manager, user, commands } = setup({
        flaky: () => fakeAgent().onRequest(methods.agent.session.new, () => {
          if (++created > 1) {
            throw RequestError.internalError(undefined, 'out of quota');
          }
          return { sessionId: randomUUID() };
        }),
      });
      await manager.connectToAgent('flaky');

      await commands.restart();

      expect(user.take()).toEqual([
        progress('Restarting Fake Agent...'),
        { call: 'showErrorMessage', message: 'Failed to restart: Internal error: out of quota' },
      ]);
    });
  });

  describe('turns and session controls', () => {
    it("cancels the active session's turn", async () => {
      const one = sessionAgent('one');
      const { manager, commands } = setup({ one: one.script });
      await manager.connectToAgent('one');
      const cancelled = one.nextRequest();

      await commands.cancelTurn();

      expect(await cancelled).toEqual({ method: 'session/cancel', params: { sessionId: ONE_FIRST_SESSION } });
      expect(one.requests).toHaveLength(1);
    });

    it('sets the mode it is given', async () => {
      const one = sessionAgent('one');
      const { manager, user, commands } = setup({ one: one.script });
      await manager.connectToAgent('one');

      await commands.setMode('plan');

      expect(one.requests).toEqual([{ method: 'session/set_mode', params: { sessionId: ONE_FIRST_SESSION, modeId: 'plan' } }]);
      expect(user.take()).toEqual([]);
    });

    it('asks for the mode when none is given, and does nothing when dismissed', async () => {
      const one = sessionAgent('one');
      const { manager, user, commands } = setup({ one: one.script });
      await manager.connectToAgent('one');
      user.answer('code', undefined);

      await commands.setMode();
      await commands.setMode();

      const ask: Call = { call: 'showInputBox', options: { placeHolder: 'Enter mode ID (e.g., "plan", "code")', title: 'Set Agent Mode' } };
      expect(one.requests).toEqual([{ method: 'session/set_mode', params: { sessionId: ONE_FIRST_SESSION, modeId: 'code' } }]);
      expect(user.take()).toEqual([ask, ask]);
    });

    it('reports a model the agent cannot set', async () => {
      const { manager, user, commands } = setup({ one: sessionAgent('one').script });
      await manager.connectToAgent('one');
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
      await manager.connectToAgent('one');
      transcript.hasRunningTurn = true;

      await commands.open('one', OLD_SESSION);

      expect(manager.getActiveSessionId()).toBe(OLD_SESSION);
      expect(user.take()).toEqual([focusChatView, progress('Loading session…')]);
    });

    it("asks before opening another of the agent's sessions while prompts are queued, as they are discarded", async () => {
      const { manager, transcript, user, commands } = setup({ one: sessionAgent('one', loads).script });
      await manager.connectToAgent('one');
      transcript.hasRunningTurn = true;
      transcript.queuedPrompts = 2;
      user.answer('Open Session');

      await commands.open('one', OLD_SESSION);

      expect(manager.getActiveSessionId()).toBe(OLD_SESSION);
      expect(user.take()).toEqual([
        asked('Open a different session?', 'This discards 2 queued prompts.', 'Open Session'),
        focusChatView,
        progress('Loading session…'),
      ]);
    });

    it("asks before opening another agent's session while a turn is running, and stays when declined", async () => {
      const two = sessionAgent('two', loads);
      const { manager, transcript, user, commands } = setup({ one: sessionAgent('one').script, two: two.script });
      await manager.connectToAgent('one');
      transcript.hasRunningTurn = true;
      user.answer(undefined);

      await commands.open('two', OLD_SESSION);

      expect(manager.getActiveSessionId()).toBe(ONE_FIRST_SESSION);
      expect(two.requests).toEqual([]);
      expect(user.take()).toEqual([asked('Open a different session?', 'This stops the turn in progress.', 'Open Session')]);
    });

    it('asks while files are under review, and with Keep All keeps them before opening', async () => {
      const { manager, review, keptIn, user, commands } = setup({ one: sessionAgent('one', loads).script });
      await manager.connectToAgent('one');
      review.paths = ['/w/a.ts'];
      user.answer('Keep All and Open');

      await commands.open('one', OLD_SESSION);

      expect(keptIn).toEqual([ONE_FIRST_SESSION]);
      expect(manager.getActiveSessionId()).toBe(OLD_SESSION);
      expect(user.take()).toEqual([
        asked('Open a different session?', underReview('1 file is'), 'Open Session', {
          label: 'Keep All and Open', detail: 'Keep 1 file under review before continuing.',
        }),
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
      ['connecting to another agent', (commands) => commands.connect('two'), [`two creates ${TWO_FIRST_SESSION}`]],
      ['starting a new session', (commands) => commands.newSession(), [`one creates ${ONE_FIRST_SESSION}`]],
      ['restarting the agent', (commands) => commands.restart(), [`one creates ${ONE_FIRST_SESSION}`]],
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

    it('asks before leaving what the shown session would lose, and stays when declined', async () => {
      const one = refusingAgent(0);
      const { manager, transcript, user, commands, request } = setup({ one: one.script, two: sessionAgent('two').script });
      await commands.revealRequested();
      await manager.connectToAgent('two');
      transcript.queuedPrompts = 1;
      await request(addressOf('one', REQUESTED_SESSION));
      user.answer('Cancel');

      await commands.openRequested();

      expect(manager.getActiveSessionId()).toBe(TWO_FIRST_SESSION);
      expect(one.requested).toEqual([]);
      expect(user.take()).toEqual([asked('Open a different session?', 'This discards 1 queued prompt.', 'Open Session')]);
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
