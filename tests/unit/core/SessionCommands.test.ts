import { describe, expect, it, vi } from 'vitest';
import { methods, RequestError } from '@agentclientprotocol/sdk';
import type { AgentApp, InitializeResponse } from '@agentclientprotocol/sdk';
import { ConnectionManager } from '@/core/acp/ConnectionManager';
import { SessionReferences, StartupRequests, WorkspaceState, type KeyValueStore, type SessionAddress } from '@/core/PersistedState';
import { SessionCommands } from '@/core/SessionCommands';
import { SessionManager, type SessionEnvironment } from '@/core/SessionManager';
import { SessionStartup } from '@/core/SessionStartup';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import { SessionTabs } from '@/core/SessionTabs';
import { ProgressLocation } from '@/core/VsCodeApi';
import { fakeAgent, InProcessAgents, unusedHandlers, work, type AgentScript } from './InProcessAgents';
import { ScriptedUser, type Call } from './ScriptedUser';

const progress = (title: string): Call => ({ call: 'withProgress', options: { location: ProgressLocation.Notification, title, cancellable: false } });
const focusChatView: Call = { call: 'executeCommand', command: 'acp-chat.focus' };

/**
 * An agent that numbers the sessions it creates across all its launches
 * (`one-1`, `one-2`, ...) and records the other requests it receives.
 */
function sessionAgent(name: string, init: Partial<InitializeResponse> = {}, extend: (app: AgentApp) => AgentApp = (app) => app) {
  let created = 0;
  const requests: { method: string; params: unknown }[] = [];
  const waiting: ((request: { method: string; params: unknown }) => void)[] = [];
  const record = (request: { method: string; params: unknown }) => {
    requests.push(request);
    waiting.shift()?.(request);
  };
  const script: AgentScript = () => extend(fakeAgent(init)
    .onRequest(methods.agent.session.new, () => ({ sessionId: `${name}-${++created}` }))
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

function setup(scripts: Record<string, AgentScript>) {
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
    new ConnectionManager(new SessionUpdateHandler(), '0.0.0-test', () => unusedHandlers),
    environment,
    { chooseAuthMethod: async () => undefined },
  );
  const globalState = memoryStore();
  const references = new SessionReferences(globalState);
  const workspace = new WorkspaceState(memoryStore());
  manager.setPersistedState(references, workspace);
  const tabs = new SessionTabs();
  manager.on('session-opened', (sessionId) => {
    const session = manager.getSession(sessionId);
    if (session) { tabs.open(session); }
  });
  const transcript = { hasRunningTurn: false, queuedPrompts: 0, clearTranscript: vi.fn(), sessionTabs: tabs, notifyTabsChanged: vi.fn() };
  /** The session each Keep All was made in. */
  const keptIn: (string | null)[] = [];
  const review = {
    paths: [] as string[],
    reviewedPaths: () => review.paths,
    keepAll: () => {
      keptIn.push(manager.getActiveSessionId());
      review.paths = [];
    },
  };
  const user = new ScriptedUser();
  const startup = new SessionStartup(manager, workspace, environment, new StartupRequests(globalState));
  const commands = new SessionCommands(manager, transcript, review, user, user, () => Object.keys(scripts), startup);
  /** Another window asks the window opening the address's workspace to load its session. */
  const request = (address: SessionAddress) => new StartupRequests(globalState).request(address);
  return { agents, manager, references, workspace, transcript, review, keptIn, user, commands, request, tabs };
}

/** Where session `sessionId` of agent configuration `configuredName` lives in the test workspace. */
const addressOf = (configuredName: string, sessionId: string) =>
  ({ configuredName, sessionId, cwd: work.cwd, host: WORKSPACE.host, workspaceUri: WORKSPACE.uri });

const RETRY_CHOOSE = ['Retry', 'Choose Session', 'Choose Agent'];
const failedToOpen = (message: string, items: string[] = RETRY_CHOOSE): Call => ({ call: 'showErrorMessage', message: `Failed to open session: ${message}`, items });
const choosingAgent = (items: string[]): Call => ({
  call: 'showQuickPick', items, options: { title: 'Choose Agent', placeHolder: 'Open the session through which agent?' },
});
const choosingSession: Call = { call: 'executeCommand', command: 'acp-sessions.focus' };

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
  it('does not create a targeted session when stopping foreground work is declined', async () => {
    const { commands, manager, tabs, user, transcript, agents } = setup({ one: sessionAgent('one').script, two: sessionAgent('two').script });
    await commands.connect('one');
    const before = tabs.snapshot();
    transcript.hasRunningTurn = true;
    user.answer(undefined);
    await commands.newSession('two');
    expect(manager.getActiveSessionId()).toBe('one-1');
    expect(tabs.snapshot()).toEqual(before);
    expect(agents.launched.map((agent) => agent.name)).toEqual(['one']);
  });

  it('retains a retryable MRU reference without selection when reopening after close fails', async () => {
    let fail = false;
    const script: AgentScript = () => fakeAgent({ agentCapabilities: { loadSession: true } })
      .onRequest(methods.agent.session.new, () => ({ sessionId: 'one-1' }))
      .onRequest(methods.agent.session.load, () => {
        if (fail) { throw RequestError.internalError(undefined, 'Cannot reopen'); }
        return {};
      });
    const { commands, manager, tabs, user } = setup({ one: script });
    await commands.connect('one');
    await commands.open('one', 'older');
    const [first, second] = tabs.snapshot().tabs;
    if (!first || !second) { throw new Error('missing tabs'); }
    fail = true;
    user.answer(undefined);
    await commands.closeTab(second.tabId);
    expect(manager.getActiveSessionId()).toBeNull();
    expect(tabs.snapshot()).toEqual({ tabs: [first], selectedTabId: null });
    fail = false;
    await commands.selectTab(first.tabId);
    expect(manager.getActiveSessionId()).toBe('one-1');
    expect(tabs.snapshot().selectedTabId).toBe(first.tabId);
  });

  it('serializes a tab load with a competing tree open so the last request remains selected', async () => {
    let release: (() => void) | undefined;
    let arrived: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { arrived = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    let hold = false;
    const script: AgentScript = () => fakeAgent({ agentCapabilities: { loadSession: true } })
      .onRequest(methods.agent.session.new, () => ({ sessionId: 'one-1' }))
      .onRequest(methods.agent.session.load, async ({ params }) => {
        if (hold && params.sessionId === 'one-1') { arrived?.(); await held; }
        return {};
      });
    const { commands, manager, tabs } = setup({ one: script });
    await commands.connect('one');
    await commands.open('one', 'older');
    const first = tabs.snapshot().tabs[0];
    if (!first) { throw new Error('missing tab'); }
    hold = true;
    const selecting = commands.selectTab(first.tabId);
    await started;
    const opening = commands.open('one', 'latest');
    release?.();
    await Promise.all([selecting, opening]);
    expect(manager.getActiveSessionId()).toBe('latest');
    const snapshot = tabs.snapshot();
    expect(snapshot.tabs.find((tab) => tab.tabId === snapshot.selectedTabId)?.sessionId).toBe('latest');
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
    await commands.open('one', 'older');
    const [first, second] = tabs.snapshot().tabs;
    if (!first || !second) { throw new Error('missing opened tabs'); }
    await commands.selectTab(first.tabId);
    expect(manager.getActiveSessionId()).toBe('one-1');
    expect(tabs.snapshot().selectedTabId).toBe(first.tabId);
    await commands.closeTab(first.tabId);
    expect(manager.getActiveSessionId()).toBe('older');
    expect(tabs.snapshot().selectedTabId).toBe(second.tabId);
    expect(references.list(WORKSPACE.host, 'one', '/work').map((ref) => ref.sessionId).sort()).toEqual(['older', 'one-1']);
    await commands.closeTab(second.tabId);
    expect(manager.getActiveSessionId()).toBeNull();
    expect(tabs.snapshot()).toEqual({ tabs: [], selectedTabId: null });
  });

  it('leaves navigation unchanged when departure is cancelled and closes unfocused references without a request', async () => {
    const agent = sessionAgent('one', { agentCapabilities: { loadSession: true } });
    const { commands, manager, tabs, transcript, user, agents } = setup({ one: agent.script });
    await commands.connect('one');
    await commands.open('one', 'older');
    const [first, second] = tabs.snapshot().tabs;
    if (!first || !second) { throw new Error('missing tabs'); }
    transcript.queuedPrompts = 1;
    const before = tabs.snapshot();
    user.answer(undefined, undefined);
    await commands.selectTab(first.tabId);
    await commands.closeTab(second.tabId);
    expect(tabs.snapshot()).toEqual(before);
    expect(manager.getActiveSessionId()).toBe('older');
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
    expect(manager.getActiveSessionId()).toBe('two-1');
    expect(manager.hasSession('one')).toBe(false);
    expect(agents.launched.map((agent) => agent.name)).toEqual(['one', 'two']);
    await commands.newSession('two');
    expect(manager.getActiveSessionId()).toBe('two-2');
    expect(tabs.snapshot().tabs.map((tab) => tab.sessionId)).toEqual(['one-1', 'two-1', 'two-2']);
  });

  describe('connect', () => {
    it('makes a session with the named agent the active session', async () => {
      const { manager, user, commands } = setup({ one: sessionAgent('one').script });

      await commands.connect('one');

      expect(manager.getActiveSessionId()).toBe('one-1');
      expect(user.take()).toEqual([progress('Connecting to one...')]);
    });

    it('asks which configured agent to connect when none is named', async () => {
      const { manager, user, commands } = setup({ one: sessionAgent('one').script, two: sessionAgent('two').script });
      user.answer('two');

      await commands.connect();

      expect(manager.getActiveSessionId()).toBe('two-1');
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
        { call: 'showWarningMessage', message: 'No ACP agents configured. Add agents in Settings > ACP > Agents.' },
      ]);
    });

    it('switches agents without asking when nothing would be lost, and clears the transcript', async () => {
      const { manager, transcript, user, commands } = setup({ one: sessionAgent('one').script, two: sessionAgent('two').script });
      await manager.connectToAgent('one');

      await commands.connect('two');

      expect(manager.getActiveSessionId()).toBe('two-1');
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

      expect(manager.getActiveSessionId()).toBe('two-1');
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

      expect(manager.getActiveSessionId()).toBe('one-1');
      expect(transcript.clearTranscript).not.toHaveBeenCalled();
    });

    it('asks while files are under review, and with Keep All keeps them before switching', async () => {
      const { manager, review, keptIn, user, commands } = setup({ one: sessionAgent('one').script, two: sessionAgent('two').script });
      await manager.connectToAgent('one');
      review.paths = ['/w/a.ts', '/w/b.ts'];
      user.answer('Keep All and Switch');

      await commands.connect('two');

      expect(keptIn).toEqual(['one-1']);
      expect(manager.getActiveSessionId()).toBe('two-1');
      expect(user.take()).toEqual([
        asked('Switch to two?', underReview('2 files are'), 'Switch Agent', {
          label: 'Keep All and Switch', detail: 'Keep 2 files under review before continuing.',
        }),
        progress('Connecting to two...'),
      ]);
    });

    it('does not ask when connecting the agent that already has the active session', async () => {
      const { manager, transcript, review, user, commands } = setup({ one: sessionAgent('one').script });
      await manager.connectToAgent('one');
      transcript.hasRunningTurn = true;
      transcript.queuedPrompts = 1;
      review.paths = ['/w/a.ts'];

      await commands.connect('one');

      expect(manager.getActiveSessionId()).toBe('one-1');
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

      expect(manager.getActiveSessionId()).toBe('one-2');
      expect(user.take()).toEqual([progress('Starting new session with Fake Agent...')]);
    });

    it('asks first while a turn is running', async () => {
      const { agents, manager, transcript, user, commands } = setup({ one: sessionAgent('one').script });
      await manager.connectToAgent('one');
      transcript.hasRunningTurn = true;
      user.answer(undefined);

      await commands.newSession();

      expect(agents.launched).toHaveLength(1);
      expect(manager.getActiveSessionId()).toBe('one-1');
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

      expect(keptIn).toEqual(['one-1']);
      expect(manager.getActiveSessionId()).toBe('one-2');
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

      expect(manager.getActiveSessionId()).toBe('one-1');
      expect(user.take().map((c) => c.call)).toEqual(['showQuickPick', 'withProgress']);
    });

    it('reports a failure to start the session', async () => {
      let created = 0;
      const { manager, user, commands } = setup({
        flaky: () => fakeAgent().onRequest(methods.agent.session.new, () => {
          if (++created > 1) {
            throw RequestError.internalError(undefined, 'out of quota');
          }
          return { sessionId: 'flaky-1' };
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
    { action: 'Switch Agent', transition: (commands: SessionCommands) => commands.connect('two'), destination: 'two-1' },
    { action: 'New Session', transition: (commands: SessionCommands) => commands.newSession(), destination: 'one-2' },
    { action: 'Open Session', transition: (commands: SessionCommands) => commands.open('two', 'old'), destination: 'old' },
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

      expect(manager.getActiveSessionId()).toBe('one-1');
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
      expect(manager.getActiveSessionId()).toBe('one-2');
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
          return { sessionId: 'flaky-1' };
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

      expect(await cancelled).toEqual({ method: 'session/cancel', params: { sessionId: 'one-1' } });
      expect(one.requests).toHaveLength(1);
    });

    it('sets the mode it is given', async () => {
      const one = sessionAgent('one');
      const { manager, user, commands } = setup({ one: one.script });
      await manager.connectToAgent('one');

      await commands.setMode('plan');

      expect(one.requests).toEqual([{ method: 'session/set_mode', params: { sessionId: 'one-1', modeId: 'plan' } }]);
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
      expect(one.requests).toEqual([{ method: 'session/set_mode', params: { sessionId: 'one-1', modeId: 'code' } }]);
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

      await commands.open('one', 'old');

      expect(manager.getActiveSessionId()).toBe('old');
      expect(one.requests).toEqual([{ method: 'session/load', params: { sessionId: 'old', cwd: '/work', mcpServers: [] } }]);
      expect(user.take()).toEqual([focusChatView, progress('Loading session…')]);
    });

    it('resumes the session when the agent can only resume', async () => {
      const one = sessionAgent('one', resumes);
      const { manager, user, commands } = setup({ one: one.script });

      await commands.open('one', 'old');

      expect(manager.getActiveSessionId()).toBe('old');
      expect(one.requests.map((r) => r.method)).toEqual(['session/resume']);
      expect(user.take()).toEqual([focusChatView, { call: 'showInformationMessage', message: 'Resumed session (history not replayed).' }]);
    });

    it('reports an agent that can neither load nor resume', async () => {
      const { user, commands } = setup({ one: sessionAgent('one').script });
      user.answer(undefined);

      await commands.open('one', 'old');

      expect(user.take()).toEqual([focusChatView, failedToOpen('Agent "one" cannot load or resume sessions.')]);
    });

    it('only shows the chat view when the session is already active', async () => {
      const one = sessionAgent('one', loads);
      const { manager, transcript, user, commands } = setup({ one: one.script });
      await manager.loadSession('one', 'old');
      transcript.hasRunningTurn = true;

      await commands.open('one', 'old');

      expect(one.requests).toHaveLength(1);
      expect(user.take()).toEqual([focusChatView]);
    });

    it("opens another of the agent's sessions without asking while a turn is running, as the turn goes on", async () => {
      const one = sessionAgent('one', loads);
      const { manager, transcript, user, commands } = setup({ one: one.script });
      await manager.connectToAgent('one');
      transcript.hasRunningTurn = true;

      await commands.open('one', 'old');

      expect(manager.getActiveSessionId()).toBe('old');
      expect(user.take()).toEqual([focusChatView, progress('Loading session…')]);
    });

    it("asks before opening another of the agent's sessions while prompts are queued, as they are discarded", async () => {
      const { manager, transcript, user, commands } = setup({ one: sessionAgent('one', loads).script });
      await manager.connectToAgent('one');
      transcript.hasRunningTurn = true;
      transcript.queuedPrompts = 2;
      user.answer('Open Session');

      await commands.open('one', 'old');

      expect(manager.getActiveSessionId()).toBe('old');
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

      await commands.open('two', 'old');

      expect(manager.getActiveSessionId()).toBe('one-1');
      expect(two.requests).toEqual([]);
      expect(user.take()).toEqual([asked('Open a different session?', 'This stops the turn in progress.', 'Open Session')]);
    });

    it('asks while files are under review, and with Keep All keeps them before opening', async () => {
      const { manager, review, keptIn, user, commands } = setup({ one: sessionAgent('one', loads).script });
      await manager.connectToAgent('one');
      review.paths = ['/w/a.ts'];
      user.answer('Keep All and Open');

      await commands.open('one', 'old');

      expect(keptIn).toEqual(['one-1']);
      expect(manager.getActiveSessionId()).toBe('old');
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

      await commands.open('one', 'old');

      expect(manager.getActiveSessionId()).toBe('old');
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

      await commands.open('one', 'old');

      expect(user.take()).toEqual([focusChatView, progress('Loading session…'), failedToOpen('Internal error: session in use by another client'), choosingSession]);
    });

    it('opens the session through the agent chosen from every configuration, where its reference moves', async () => {
      const two = sessionAgent('two', loads);
      const { manager, references, user, commands } = setup({ one: refusingAgent().script, two: two.script });
      await references.setTitle(addressOf('one', 'old'), 'Kept title');
      user.answer('Choose Agent', 'two');

      await commands.open('one', 'old');

      expect(manager.getActiveSession()).toMatchObject({ sessionId: 'old', agentName: 'two', title: 'Kept title' });
      expect(user.take()).toEqual([
        focusChatView,
        progress('Loading session…'),
        failedToOpen('Internal error: session in use by another client'),
        choosingAgent(['one', 'two']),
        progress('Loading session…'),
      ]);
      expect(references.get({ host: WORKSPACE.host, configuredName: 'one', sessionId: 'old' })).toBeUndefined();
      expect(references.get({ host: WORKSPACE.host, configuredName: 'two', sessionId: 'old' })).toMatchObject({ title: 'Kept title' });
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

      await commands.open(undefined, 'old');
      await commands.open('one', undefined);

      const missing: Call = { call: 'showErrorMessage', message: 'Open Session: missing agentName/sessionId.' };
      expect(user.take()).toEqual([missing, missing]);
    });
  });

  describe('restore the last session', () => {
    it('loads the last active session, asking nothing', async () => {
      const one = refusingAgent(0);
      const { manager, workspace, user, commands } = setup({ one: one.script });
      await workspace.setLastActiveSession(addressOf('one', 'old'));

      await commands.restoreLastSession();

      expect(manager.getActiveSessionId()).toBe('old');
      expect(one.loaded).toEqual(['old']);
      expect(user.take()).toEqual([]);
    });

    it('loads nothing once the user has set out to open a session themselves, though it failed to open', async () => {
      const one = refusingAgent();
      const { workspace, user, commands } = setup({ one: one.script });
      await workspace.setLastActiveSession(addressOf('one', 'old'));
      user.answer(undefined);
      await commands.open('one', 'other');
      user.take();

      await commands.restoreLastSession();

      expect(one.requested).toEqual(['other']);
      expect(user.take()).toEqual([]);
    });

    it.each<[string, (commands: SessionCommands) => Promise<void>, string[]]>([
      ['connecting to another agent', (commands) => commands.connect('two'), ['two creates two-1']],
      ['starting a new session', (commands) => commands.newSession(), ['one creates one-1']],
      ['restarting the agent', (commands) => commands.restart(), ['one creates one-1']],
    ])('lets a load under way end before %s', async (_, act, after) => {
      const order: string[] = [];
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => { release = resolve; });
      const creating = (name: string) => fakeAgent({ agentCapabilities: { loadSession: true } })
        .onRequest(methods.agent.session.new, () => {
          order.push(`${name} creates ${name}-1`);
          return { sessionId: `${name}-1` };
        });
      const one: AgentScript = () => creating('one').onRequest(methods.agent.session.load, async () => {
        order.push('one loads old');
        await released;
        order.push('one answers old');
        return {};
      });
      const { manager, workspace, commands } = setup({ one, two: () => creating('two') });
      await workspace.setLastActiveSession(addressOf('one', 'old'));
      const loading = new Promise<void>((resolve) => { manager.once('session-load-start', () => resolve()); });

      const restoring = commands.restoreLastSession();
      await loading;
      const acting = act(commands);
      release();
      await Promise.all([restoring, acting]);

      expect(order).toEqual(['one loads old', 'one answers old', ...after]);
    });

    it('loads the session again through the same configuration on Retry', async () => {
      const one = refusingAgent(1);
      const { manager, workspace, user, commands } = setup({ one: one.script });
      await workspace.setLastActiveSession(addressOf('one', 'old'));
      user.answer('Retry');

      await commands.restoreLastSession();

      expect(manager.getActiveSessionId()).toBe('old');
      expect(user.take()).toEqual([failedToOpen('Internal error: session in use by another client'), progress('Loading session…')]);
    });

    it('shows the Agents view to choose another session on Choose Session', async () => {
      const { workspace, user, commands } = setup({ one: refusingAgent().script });
      await workspace.setLastActiveSession(addressOf('one', 'old'));
      user.answer('Choose Session');

      await commands.restoreLastSession();

      expect(user.take()).toEqual([failedToOpen('Internal error: session in use by another client'), choosingSession]);
    });

    it('loads through the agent chosen from every configuration, where the reference and the last active session move', async () => {
      const { manager, references, workspace, user, commands } = setup({ one: refusingAgent().script, two: refusingAgent(0).script });
      await references.setTitle(addressOf('one', 'old'), 'Kept title');
      await workspace.setLastActiveSession(addressOf('one', 'old'));
      user.answer('Choose Agent', 'two');

      await commands.restoreLastSession();

      expect(manager.getActiveSession()).toMatchObject({ sessionId: 'old', agentName: 'two', title: 'Kept title' });
      expect(user.take()).toEqual([
        failedToOpen('Internal error: session in use by another client'),
        choosingAgent(['one', 'two']),
        progress('Loading session…'),
      ]);
      expect(references.get({ host: WORKSPACE.host, configuredName: 'two', sessionId: 'old' })).toMatchObject({ title: 'Kept title' });
      expect(workspace.lastActiveSession()).toEqual(addressOf('two', 'old'));
    });

    it('offers only Choose Session when the workspace cwd is not the one the session was used in', async () => {
      const { workspace, user, commands } = setup({ one: refusingAgent(0).script });
      await workspace.setLastActiveSession({ ...addressOf('one', 'old'), cwd: '/moved' });
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
      await workspace.setLastActiveSession(addressOf('one', 'old'));
      await request(addressOf('one', 'asked'));

      await commands.revealRequested();
      await commands.restoreLastSession();

      expect(manager.getActiveSessionId()).toBe('asked');
      expect(one.requested).toEqual(['asked']);
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
      await request(addressOf('one', 'asked'));

      await commands.openRequested();
      await commands.openRequested();

      expect(manager.getActiveSessionId()).toBe('asked');
      expect(one.requested).toEqual(['asked']);
      expect(user.take()).toEqual([focusChatView, progress('Loading session…')]);
    });

    it('asks before leaving what the shown session would lose, and stays when declined', async () => {
      const one = refusingAgent(0);
      const { manager, transcript, user, commands, request } = setup({ one: one.script, two: sessionAgent('two').script });
      await commands.revealRequested();
      await manager.connectToAgent('two');
      transcript.queuedPrompts = 1;
      await request(addressOf('one', 'asked'));
      user.answer('Cancel');

      await commands.openRequested();

      expect(manager.getActiveSessionId()).toBe('two-1');
      expect(one.requested).toEqual([]);
      expect(user.take()).toEqual([asked('Open a different session?', 'This discards 1 queued prompt.', 'Open Session')]);
    });

    it('does not open again the request the window opened with', async () => {
      const one = refusingAgent(0);
      const { user, commands, request } = setup({ one: one.script });
      await request(addressOf('one', 'asked'));
      await commands.revealRequested();
      user.take();

      await commands.openRequested();

      expect(one.requested).toEqual([]);
      expect(user.take()).toEqual([]);
    });
  });
});
