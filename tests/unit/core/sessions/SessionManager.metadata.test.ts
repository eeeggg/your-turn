import { randomUUID } from 'node:crypto';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agent, methods, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import type { AgentContext, SessionConfigOption, SessionNotification } from '@agentclientprotocol/sdk';
import * as V2 from '@agentclientprotocol/sdk/experimental/v2';
import { setLogSink } from '@/core/Log';
import { SessionManager } from '@/core/sessions/Manager';
import { ChatViewController } from '@/core/ChatViewController';
import type { ExtensionToWebviewMessage } from '@/shared/WebviewMessages';
import { SessionStates } from '@/core/sessions/States';
import type { SessionLoad } from '@/core/sessions/UpdateHandler';
import { Reviews } from '@/core/review/Reviews';
import { ReviewControls } from '@/core/review/ReviewControls';
import * as CommandOutput from '@/core/CommandOutput';
import * as RetainedContent from '@/core/sessions/Content';
import { AgentTerminals } from '@/core/AgentTerminals';
import { PermissionRequests } from '@/core/PermissionRequests';
import { ElicitationRequests } from '@/core/ElicitationRequests';
import { contentSnapshots, questionSnapshots } from '@tests/unit/core/ChatViewControllerTestSupport';
import { initialState, update as updateView } from '@/webview/state/RootState';
import { promptHistory } from '@/webview/state/Transcript';
import { fakeAgent, fakeV2Agent, unusedEditor, type AgentScript } from '@tests/unit/core/InProcessAgents';
import {
  WORKSPACE,
  FIRST_SESSION,
  SECOND_SESSION,
  OLD_SESSION,
  OLDER_SESSION,
  LOADED_SESSION,
  RESUMED_SESSION,
  address,
  modelOption,
  modelConfig,
  setup,
  sessionAgent,
  promptTarget,
} from '@tests/unit/core/sessions/SessionManagerTestSupport';

describe('SessionManager', () => {
  it('opens the first still-unresolved review file after selection and successful Load', async () => {
    const { manager, chatView } = setup({ fake: () => fakeAgent({ agentCapabilities: { loadSession: true } })
      .onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION }))
      .onRequest(methods.agent.session.load, () => ({})) });
    let release!: (text: string) => void;
    const lateRead = new Promise<string>((resolve) => { release = resolve; });
    const reviews = new Reviews({
      read: (path) => path === '/w/remaining.ts' ? lateRead : Promise.resolve('new'),
      watch: () => ({ dispose() {} }), snapshot: () => undefined,
      restore: () => { throw new Error('Unexpected restore'); },
      applyEdit: () => { throw new Error('Unexpected edit'); },
      save: () => { throw new Error('Unexpected save'); },
    }, manager);
    onTestFinished(() => reviews.dispose());
    const shown: string[] = [];
    const controls = new ReviewControls(reviews, {
      captureNavigation: () => () => true, activePath: () => undefined, isOpen: () => false,
      open: async () => {}, showChange: async (path, current) => { if (!current || current()) { shown.push(path); } },
      showChangeOf: async () => {}, closeChange: async () => {}, showError: () => {}, text: () => undefined,
    });
    chatView.setReviewOpening(controls);
    manager.on('active-session-changed', (registration) => {
      reviews.activeSessionChanged(registration);
      chatView.notifyActiveSessionChanged();
    });
    manager.on('session-load-start', (load) => { reviews.loadStarted(load); chatView.notifyLoadSessionStart(load); });
    manager.on('session-load-end', (load, ok) => { reviews.loadEnded(load); chatView.notifyLoadSessionEnd(load, ok); });
    manager.on('session-removed', (registration) => reviews.sessionRemoved(registration));
    manager.on('turn-ended', (registration) => { chatView.notifyTurnEnded(registration); });
    const evidence = (sessionId: string, path: string) => {
      const registration = manager.getSession(address(sessionId));
      if (!registration) { throw new Error('Missing session'); }
      return reviews.handleSessionUpdate({ origin: { identity: address(sessionId), sourceId: registration.agentId }, schema: 'v1',
        update: { kind: 'toolCall', toolCallId: path, status: 'completed',
          content: [{ kind: 'diff', diff: { kind: 'wholeFile', path, oldText: 'old', newText: 'new' } }] } });
    };
    await manager.connectToAgent('fake');
    await evidence(FIRST_SESSION, '/w/shared.ts');
    const receiving = evidence(FIRST_SESSION, '/w/remaining.ts');
    try {
      manager.recordTurnEnded(address(FIRST_SESSION));
      await manager.loadSession('fake', SECOND_SESSION);
      await evidence(SECOND_SESSION, '/w/shared.ts');
      expect(await controls.keepAll()).toMatchObject({ kind: 'applied' });
      release('new');
      await receiving;
      await chatView.reviewOpeningSettled();
      expect(shown).toEqual([]);
      expect(manager.sessionState(address(FIRST_SESSION))?.reviewOpportunity).not.toBeNull();
      await manager.loadSession('fake', FIRST_SESSION);
      await chatView.reviewOpeningSettled();
      expect(shown).toEqual(['/w/remaining.ts']);
      expect(manager.sessionState(address(FIRST_SESSION))?.reviewOpportunity).toBeNull();
    } finally { release('new'); await receiving; }
  });

  it('retains a completion opportunity across Load but not tab closure', async () => {
    const { manager } = setup({ fake: () => fakeAgent({ agentCapabilities: { loadSession: true } })
      .onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION }))
      .onRequest(methods.agent.session.load, () => ({})) });
    const identity = address(FIRST_SESSION);
    await manager.connectToAgent('fake');
    expect(manager.sessionState(identity)?.reviewOpportunity).toBeNull();
    manager.recordTurnEnded(identity);
    const opportunity = manager.sessionState(identity)?.reviewOpportunity;
    expect(typeof opportunity).toBe('number');
    await manager.loadSession('fake', SECOND_SESSION);
    expect(manager.sessionState(address(SECOND_SESSION))?.reviewOpportunity).toBeNull();
    await manager.loadSession('fake', FIRST_SESSION);
    expect(manager.sessionState(identity)?.reviewOpportunity).toBe(opportunity);
    if (opportunity == null) { throw new Error('Missing opportunity'); }
    manager.recordTurnEnded(identity);
    const newer = manager.sessionState(identity)?.reviewOpportunity;
    expect(newer).not.toBe(opportunity);
    manager.consumeReviewOpportunity(identity, opportunity);
    expect(manager.sessionState(identity)?.reviewOpportunity).toBe(newer);
    manager.releaseSessionState(identity);
    await manager.loadSession('fake', FIRST_SESSION);
    expect(manager.sessionState(identity)?.reviewOpportunity).toBeNull();
  });

  it('reconstructs a pending Load overlay through a replacement controller', async () => {
    let entered!: () => void;
    const loading = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const completing = new Promise<void>((resolve) => { finish = resolve; });
    const parts = setup({ fake: () => fakeAgent({ agentCapabilities: { loadSession: true } })
      .onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION }))
      .onRequest(methods.agent.session.load, async () => { entered(); await completing; return {}; }) });
    await parts.manager.connectToAgent('fake');
    const load = parts.manager.loadSession('fake', FIRST_SESSION);
    try {
      await loading;
      await parts.chatView.dispose();
      const posted: ExtensionToWebviewMessage[] = [];
      const replacement = new ChatViewController(parts.manager, {
        visible: true, post: (message) => posted.push(message), executeCommand: async () => {},
        showsToolCallDiffs: () => false, reveal: async () => {}, showInformationMessage: async () => undefined,
      }, unusedEditor);
      onTestFinished(() => replacement.dispose());
      const ended = (attempt: SessionLoad, ok: boolean) => { replacement.notifyLoadSessionEnd(attempt, ok); };
      parts.manager.on('session-load-end', ended);
      onTestFinished(() => { parts.manager.off('session-load-end', ended); });
      await replacement.handleMessage({ type: 'ready' });
      const rebuilt = posted.reduce((state, message) => updateView(state, structuredClone(message), 0).state, initialState);
      expect(rebuilt.activeSession?.loading).toBe(true);
      expect(posted).toHaveLength(1);
      finish();
      await load;
      const completed = posted.reduce((state, message) => updateView(state, structuredClone(message), 0).state, initialState);
      expect(completed.activeSession?.loading).toBe(false);
    } finally { finish(); await load; }
  });

  it('reconstructs ready as one projection with controls, activity, content, composer, queue and questions', async () => {
    const { manager, chatView, posted } = setup({ fake: sessionAgent(FIRST_SESSION).script });
    await manager.connectToAgent('fake');
    await chatView.handleMessage({ type: 'ready' });
    const target = promptTarget(posted);
    manager.editComposer(target, target.generation, 1, 'retained composer');
    manager.applyForegroundState(target, 'running');
    await chatView.handleMessage({ type: 'sendPrompt', target, text: 'retained queue' });
    posted.splice(0);
    await chatView.handleMessage({ type: 'ready' });
    expect(posted).toHaveLength(1);
    const rebuilt = posted.reduce((state, message) => updateView(state, structuredClone(message), 0).state, initialState);
    expect(rebuilt.activeSession).toMatchObject({ sessionId: FIRST_SESSION, turnRunning: true, loading: false });
    expect(rebuilt.pickers.pickers).toHaveLength(1);
    expect(rebuilt.promptBox.text).toBe('retained composer');
    expect(rebuilt.transcript.queued.map((entry) => entry.text)).toEqual(['retained queue']);
    expect(rebuilt.questions.items).toEqual([]);
    expect(rebuilt.sessionTabs.tabs).toHaveLength(1);
  });

  it.each([undefined, NaN, Infinity, -1, 0, 1.5])('rejects invalid queue edit revision %s without changing the retained draft', (revision) => {
    const states = new SessionStates(() => {});
    onTestFinished(() => states.dispose());
    const identity = address(FIRST_SESSION);
    states.attach({ agentName: 'fake', agentId: 'source', sessionId: FIRST_SESSION });
    const state = states.view(identity);
    if (!state) { throw new Error('Missing retained owner'); }
    states.enqueue(identity, state.generation, 'head');
    const before = states.view(identity);
    const head = before?.queue[0];
    if (!head) { throw new Error('Missing queued prompt'); }
    states.changeQueue(identity, state.generation, { kind: 'editStarted', id: head.id, revision } as Parameters<SessionStates['changeQueue']>[2]);
    expect(states.view(identity)).toBe(before);
  });

  it('preserves retained content and generation when Resume reports early content', () => {
    const states = new SessionStates(() => {});
    onTestFinished(() => states.dispose());
    const identity = address(FIRST_SESSION);
    const original = { agentName: 'fake', agentId: 'old-source', sessionId: FIRST_SESSION };
    states.attach(original);
    states.submitted(original, 'Original prompt');
    const before = states.view(identity);
    states.retireSource(original.agentId);
    const resumed = { ...original, agentId: 'new-source' };
    states.acceptOpening({ identity, sourceId: resumed.agentId }, { kind: 'agentText', messageId: 'early', text: 'Resume output' }, 0);
    states.attach(resumed);
    expect(states.view(identity)?.generation).toBe(before?.generation);
    expect(states.view(identity)?.content.entries).toMatchObject([{ kind: 'prompt', text: 'Original prompt' }, { kind: 'turn', parts: [{ text: 'Resume output' }] }]);
    const current = states.view(identity);
    if (!current) { throw new Error('Missing resumed owner'); }
    states.enqueue(identity, current.generation, 'Unsent');
    states.retireSource(resumed.agentId);
    expect(states.view(identity)?.queue).toEqual([]);
  });

  it.each(['failed', 'closed'] as const)('does not publish early Resume content after opening is %s', (outcome) => {
    const states = new SessionStates(() => {});
    onTestFinished(() => states.dispose());
    const identity = address(FIRST_SESSION);
    const original = { agentName: 'fake', agentId: 'old-source', sessionId: FIRST_SESSION };
    states.attach(original);
    states.submitted(original, 'Original prompt');
    const before = states.view(identity);
    states.retireSource(original.agentId);
    const resumed = { ...original, agentId: 'new-source' };
    states.acceptOpening({ identity, sourceId: resumed.agentId }, { kind: 'agentText', messageId: 'early', text: 'Uncommitted Resume output' }, 0);
    if (outcome === 'failed') {
      states.discardOpening(resumed.agentId, resumed.sessionId);
      expect(states.view(identity)).toBe(before);
    } else {
      states.release(identity);
      states.attach(resumed);
      states.accept(resumed, { kind: 'agentText', messageId: 'late', text: 'Late output' }, 1);
      expect(states.view(identity)).toBeUndefined();
    }
  });

  it.each([false, true])('keeps connection-owned queue drafts through Load settlement (success: %s)', (ok) => {
    const states = new SessionStates(() => {});
    onTestFinished(() => states.dispose());
    const identity = address(FIRST_SESSION);
    const registration = { agentName: 'fake', agentId: 'source', sessionId: FIRST_SESSION };
    states.attach(registration);
    const before = states.view(identity);
    if (!before) { throw new Error('Missing retained owner'); }
    states.enqueue(identity, before.generation, 'head');
    const head = states.view(identity)?.queue[0];
    if (!head) { throw new Error('Missing queued head'); }
    states.changeQueue(identity, before.generation, { kind: 'editStarted', id: head.id, revision: 1 });
    states.changeQueue(identity, before.generation, { kind: 'edited', id: head.id, text: 'unfinished edit', revision: 2 });
    const queue = states.view(identity)?.queue;
    const load: SessionLoad = { registration, origin: { identity, sourceId: registration.agentId }, attempt: Symbol() };
    states.beginLoad(load);
    states.accept(registration, { kind: 'promptText', messageId: 'replay', text: 'Replayed' }, 0);
    states.endLoad(load, ok);
    expect(states.view(identity)?.queue).toBe(queue);
    states.retireSource(registration.agentId);
    expect(states.view(identity)?.queue).toEqual([]);
  });

  it.each([false, true])('excludes cancelled unsent prompts from recall across Load (success: %s)', (ok) => {
    const states = new SessionStates(() => {});
    onTestFinished(() => states.dispose());
    const identity = address(FIRST_SESSION);
    const registration = { agentName: 'fake', agentId: 'source', sessionId: FIRST_SESSION };
    states.attach(registration);
    states.submitted(registration, 'Original');
    const before = states.view(identity);
    if (!before) { throw new Error('Missing owner'); }
    states.enqueue(identity, before.generation, 'Cancelled');
    const queued = states.view(identity)?.queue[0];
    if (!queued) { throw new Error('Missing queued prompt'); }
    states.changeQueue(identity, before.generation, { kind: 'cancelled', id: queued.id });
    const load: SessionLoad = { registration, origin: { identity, sourceId: registration.agentId }, attempt: Symbol() };
    states.beginLoad(load);
    states.accept(registration, { kind: 'agentText', messageId: 'intro', text: 'Intro' }, 0);
    states.accept(registration, { kind: 'promptText', messageId: 'p1', text: 'Original' }, 0);
    states.endLoad(load, ok);
    const state = states.view(identity);
    expect(state?.queue).toEqual([]);
    expect(state?.content.entries.filter((entry) => entry.kind === 'prompt').map((entry) => entry.text)).toEqual(['Original']);
  });

  it.each([false, true])('keeps session question settlement received during staged Load (success: %s)', async (ok) => {
    const states = new SessionStates(() => {});
    onTestFinished(() => states.dispose());
    const identity = address(FIRST_SESSION);
    const registration = { agentName: 'fake', agentId: 'source', sessionId: FIRST_SESSION };
    states.attach(registration);
    const requests = new ElicitationRequests();
    const answer = requests.create({ mode: 'form', rpcId: 1, scope: { sessionId: FIRST_SESSION }, message: 'During Load', requestedSchema: {} });
    const interaction = requests.snapshot()[0];
    if (interaction?.mode !== 'form') { throw new Error('Missing question'); }
    const load: SessionLoad = { registration, origin: { identity, sourceId: registration.agentId }, attempt: Symbol() };
    states.beginLoad(load);
    states.accept(registration, { kind: 'agentText', messageId: 'replay', text: 'Replay' }, 0);
    requests.respond(interaction.interactionId, { action: 'decline' });
    states.questionSettled(registration, { agentName: 'fake', interaction, response: await answer });
    states.endLoad(load, ok);
    const content = states.view(identity)?.content;
    expect(content?.entries.flatMap((entry) => entry.kind === 'turn' ? entry.parts.filter((part) => part.kind === 'question') : entry.kind === 'question' ? [entry] : []))
      .toHaveLength(1);
  });

  it('shows only unanswered requests of an unselected tab ahead of foreground work', async () => {
    const { manager, chatView, posted } = setup({ fake: sessionAgent(FIRST_SESSION).script });
    const registration = await manager.connectToAgent('fake');
    chatView.sessionTabs.open({ ...registration, sessionId: SECOND_SESSION });
    const requests = new ElicitationRequests();
    const stop = manager.interactions.observe({ agentName: 'fake', agentId: registration.agentId, elicitations: requests, permissions: undefined });
    onTestFinished(() => { stop(); requests.close(); });
    const lastTabs = () => posted.filter((message) => message.type === 'sessionTabs').at(-1);
    manager.applyForegroundState(address(FIRST_SESSION), 'running');
    expect(lastTabs()).toMatchObject({ selectedTabId: 'tab-2', tabs: [{ status: 'working' }, { status: 'quiet' }] });

    const url = requests.create({ rpcId: null, mode: 'url', scope: { sessionId: FIRST_SESSION }, message: 'Connect', elicitationId: 'browser', url: 'https://example.org/connect' });
    expect(lastTabs()).toMatchObject({ tabs: [{ status: 'needsInput' }, { status: 'quiet' }] });
    const interaction = requests.snapshot()[0];
    if (!interaction) { throw new Error('Missing pending URL'); }
    expect(requests.respond(interaction.interactionId, { action: 'accept' })).toEqual({ kind: 'settled' });
    await url;
    expect(requests.snapshot()[0]?.status).toBe('awaitingCompletion');
    expect(lastTabs()).toMatchObject({ tabs: [{ status: 'working' }, { status: 'quiet' }] });
    expect(posted.filter(({ type }) => type === 'sessionTabAnnouncement')).toHaveLength(1);
  });

  it('observes native permission and URL requests before registration without creating retained session state', async () => {
    let permissionSeen!: () => void;
    const permissionArrived = new Promise<void>((resolve) => { permissionSeen = resolve; });
    let urlSeen!: () => void;
    const urlArrived = new Promise<void>((resolve) => { urlSeen = resolve; });
    let choose!: (value: string) => void;
    const choice = new Promise<string>((resolve) => { choose = resolve; });
    const permissions = new PermissionRequests({ autoApprove: () => 'ask', choose: () => choice });
    const parts = setup({ fake: () => fakeAgent().onRequest(methods.agent.session.new, async ({ client }) => {
      expect(await client.request(methods.client.session.requestPermission, {
        sessionId: FIRST_SESSION, toolCall: { toolCallId: 'opening' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      })).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
      await client.request(methods.client.elicitation.create, {
        sessionId: FIRST_SESSION, mode: 'url', message: 'Connect', elicitationId: 'opening-url', url: 'https://example.org/connect',
      });
      return { sessionId: FIRST_SESSION };
    }) }, undefined, () => ({ permissions, permissionInteractions: permissions }));
    const stop = parts.manager.interactions.subscribe(() => {
      const pending = parts.manager.interactions.pending(address(FIRST_SESSION), parts.agents.launched[0]?.process.id ?? '');
      if (pending.permissions.length) { permissionSeen(); }
      if (pending.elicitations.length) { urlSeen(); }
    });
    const connecting = parts.manager.connectToAgent('fake');
    try {
      await permissionArrived;
      const agentId = parts.agents.launched[0]?.process.id ?? '';
      expect(parts.manager.interactions.pending(address(FIRST_SESSION), agentId)).toMatchObject({ permissions: [{ sessionId: FIRST_SESSION }], elicitations: [] });
      expect(parts.manager.interactions.pending({ configuredName: 'other', sessionId: FIRST_SESSION }, agentId)).toEqual({ permissions: [], elicitations: [] });
      expect(parts.manager.sessionState(address(FIRST_SESSION))).toBeUndefined();
      choose('allow');
      await urlArrived;
      expect(parts.manager.interactions.pending(address(FIRST_SESSION), agentId)).toMatchObject({ permissions: [], elicitations: [{ mode: 'url', elicitationId: 'opening-url' }] });
      expect(parts.manager.getActiveSession()).toBeUndefined();
      expect(parts.manager.sessionState(address(FIRST_SESSION))).toBeUndefined();
    } finally {
      choose('allow');
      stop();
      await parts.manager.disconnectAgent('fake');
      await connecting.catch(() => undefined);
    }
  });

  it('projects sessionless authentication questions without creating a session or a session answer record', async () => {
    let arrived!: () => void;
    const created = new Promise<void>((resolve) => { arrived = resolve; });
    let authenticated = false;
    const parts = setup({ fake: () => fakeAgent({ authMethods: [{ id: 'browser', name: 'Browser' }] })
      .onRequest(methods.agent.authenticate, async ({ client, requestId }) => {
        if (requestId === null) { throw new Error('Missing authentication request'); }
        const response = await client.request(methods.client.elicitation.create, {
          requestId, mode: 'form', message: 'Authentication', requestedSchema: {},
        });
        expect(response).toEqual({ action: 'accept', content: {} });
        authenticated = true;
        return {};
      })
      .onRequest(methods.agent.session.new, () => {
        if (!authenticated) { throw RequestError.authRequired(); }
        return { sessionId: FIRST_SESSION };
      }) });
    parts.authPrompt.chooseAuthMethod.mockResolvedValue({ id: 'browser', name: 'Browser', description: null });
    const stop = parts.manager.interactions.subscribe((question) => { if (question) { arrived(); } });
    const connecting = parts.manager.connectToAgent('fake');
    try {
      await created;
      expect(parts.manager.getActiveSession()).toBeUndefined();
      expect(parts.manager.sessionState(address(FIRST_SESSION))).toBeUndefined();
      const question = parts.manager.interactions.snapshot(null)[0];
      expect(question?.interaction.message).toBe('Authentication');
      expect(question?.interaction.scope.requestId).toBeDefined();
      const id = question?.interaction.interactionId ?? '';
      await parts.chatView.handleMessage({ type: 'questionDraft', target: null, interactionId: id, draft: { text: 'raw' } });
      await parts.chatView.handleMessage({ type: 'ready' });
      expect(questionSnapshots(parts.posted).at(-1)?.questions).toEqual([expect.objectContaining({ interactionId: id, sessionId: null, draft: { text: 'raw' } })]);
      await parts.chatView.handleMessage({ type: 'questionResponse', target: null, interactionId: id, action: 'accept', content: {} });
      await connecting;
      expect(parts.manager.sessionState(address(FIRST_SESSION))?.content.entries).toEqual([]);
      expect(parts.manager.interactions.snapshot(null)).toEqual([]);
    } finally {
      stop();
      await parts.manager.disconnectAgent('fake');
      await connecting.catch(() => undefined);
    }
  });

  it.each([false, true])('retains an opening wire question across controller replacement (settles without controller: %s)', async (settlesWithoutController) => {
    let received!: () => void;
    const created = new Promise<void>((resolve) => { received = resolve; });
    let finishOpening!: () => void;
    const opening = new Promise<void>((resolve) => { finishOpening = resolve; });
    let answer: Promise<unknown> | undefined;
    const parts = setup({ fake: () => fakeAgent().onRequest(methods.agent.session.new, async ({ client }) => {
      answer = client.request(methods.client.elicitation.create, {
        sessionId: FIRST_SESSION, mode: 'form', message: 'Opening question',
        requestedSchema: { type: 'object', properties: { count: { type: 'integer' } } },
      }).catch((error: unknown) => error);
      await opening;
      return { sessionId: FIRST_SESSION };
    }) }, undefined, ({ elicitations }) => {
      elicitations.subscribe((change) => { if (change.kind === 'created') { received(); } });
      return { permissions: { requestPermission: async () => ({ kind: 'cancelled' }), cancelSession() {} } };
    });
    const connecting = parts.manager.connectToAgent('fake');
    try {
      await created;
      expect(parts.manager.getActiveSession()).toBeUndefined();
      expect(parts.manager.sessionState(address(FIRST_SESSION))).toBeUndefined();
      finishOpening();
      await connecting;
      await parts.chatView.handleMessage({ type: 'ready' });
      const questions = questionSnapshots(parts.posted).at(-1)?.questions;
      expect(questions).toEqual([expect.objectContaining({ message: 'Opening question', draft: null })]);
      const id = questions?.[0]?.interactionId ?? '';
      const target = promptTarget(parts.posted);
      expect(parts.manager.interactions.respond(id, { ...target, generation: target.generation + 1 }, { action: 'decline' })).toEqual({ kind: 'stale' });
      expect(parts.manager.interactions.respond(id, { ...target, configuredName: 'foreign' }, { action: 'decline' })).toEqual({ kind: 'stale' });
      expect(parts.manager.interactions.respond(id, null, { action: 'decline' })).toEqual({ kind: 'stale' });
      expect(parts.manager.interactions.snapshot(address(FIRST_SESSION))).toHaveLength(1);
      await parts.chatView.handleMessage({ type: 'questionDraft', target, interactionId: id, draft: { count: '-' } });
      await parts.chatView.dispose();
      if (settlesWithoutController) {
        expect(parts.manager.interactions.respond(id, target, { action: 'accept', content: { count: 3 } })).toEqual({ kind: 'settled' });
      }
      const posted: ExtensionToWebviewMessage[] = [];
      const replacement = new ChatViewController(parts.manager, {
        visible: false, post: (message) => posted.push(message), executeCommand: async () => {},
        showsToolCallDiffs: () => false, reveal: async () => {}, showInformationMessage: async () => { throw new Error('Reconstruction must not repeat discovery'); },
      }, unusedEditor);
      onTestFinished(() => replacement.dispose());
      await replacement.handleMessage({ type: 'ready' });
      if (settlesWithoutController) { expect(parts.manager.interactions.snapshot(target)).toEqual([]); }
      else {
        expect(questionSnapshots(posted).at(-1)?.questions).toEqual([expect.objectContaining({ interactionId: id, draft: { count: '-' } })]);
        await replacement.handleMessage({ type: 'questionResponse', target: promptTarget(posted), interactionId: id, action: 'accept', content: { count: 3 } });
      }
      expect(await answer).toEqual({ action: 'accept', content: { count: 3 } });
      posted.splice(0);
      await replacement.handleMessage({ type: 'ready' });
      const shown = posted.reduce((state, message) => updateView(state, structuredClone(message), 0).state, initialState);
      expect(shown.transcript.entries).toMatchObject([{ kind: 'question', record: { interactionId: id, response: { action: 'accept', content: { count: 3 } } } }]);
      expect(posted.map((message) => message.type)).toEqual(['viewSnapshot']);
    } finally {
      finishOpening();
      await connecting;
      await parts.manager.disconnectAgent('fake');
      await answer;
    }
  });

  it('steers only the issued unedited head and keeps later submissions queued until every overlapping prompt settles', async () => {
    const pending: { text: string; finish: () => void }[] = [];
    let entered!: () => void;
    let nextEntry = new Promise<void>((resolve) => { entered = resolve; });
    const { manager, chatView, posted } = setup({ fake: () => fakeAgent()
      .onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION }))
      .onRequest(methods.agent.session.prompt, async ({ params }) => {
        const text = params.prompt.flatMap((part) => part.type === 'text' ? [part.text] : []).join('');
        await new Promise<void>((resolve) => { pending.push({ text, finish: resolve }); entered(); });
        return { stopReason: 'end_turn' };
      }) });
    await manager.connectToAgent('fake');
    await chatView.handleMessage({ type: 'ready' });
    const target = promptTarget(posted);
    const first = chatView.handleMessage({ type: 'sendPrompt', target, text: 'first' });
    await nextEntry;
    await chatView.handleMessage({ type: 'sendPrompt', target, text: 'head' });
    await chatView.handleMessage({ type: 'sendPrompt', target, text: 'tail' });
    const [head, tail] = manager.sessionState(target)?.queue ?? [];
    if (!head || !tail) { throw new Error('Missing queued submissions'); }
    const change = (kind: 'steer' | 'editStarted' | 'editDiscarded', id = head.id) => chatView.handleMessage({ type: 'queueChanged', target,
      change: kind === 'steer' ? { kind, id } : { kind, id, revision: kind === 'editStarted' ? 1 : 2 } });
    try {
      await change('steer', tail.id);
      await change('editStarted');
      await change('steer');
      expect(manager.sessionState(target)?.queue.map((entry) => entry.text)).toEqual(['head', 'tail']);
      expect(pending.map((entry) => entry.text)).toEqual(['first']);
      await change('editDiscarded');
      nextEntry = new Promise<void>((resolve) => { entered = resolve; });
      await change('steer');
      await nextEntry;
      expect(pending.map((entry) => entry.text)).toEqual(['first', 'head']);
      expect(manager.sessionState(target)?.queue.map((entry) => entry.text)).toEqual(['tail']);
      pending[0]?.finish();
      await first;
      expect(manager.hasForegroundWork(target)).toBe(true);
      expect(manager.sessionState(target)?.queue.map((entry) => entry.text)).toEqual(['tail']);
      nextEntry = new Promise<void>((resolve) => { entered = resolve; });
      pending[1]?.finish();
      await nextEntry;
      expect(pending.map((entry) => entry.text)).toEqual(['first', 'head', 'tail']);
      expect(manager.sessionState(target)?.queue).toEqual([]);
      const shown = posted.reduce((state, message) => updateView(state, structuredClone(message), 0).state, initialState);
      expect(shown.transcript.entries.filter((entry) => entry.kind === 'prompt').map((entry) => entry.text)).toEqual(['first', 'head', 'tail']);
    } finally {
      await manager.disconnectAgent('fake');
      for (const entry of pending) { entry.finish(); }
      await first;
    }
  });

  it('routes every page submission into the retained queue while busy without dispatching it', async () => {
    const { manager, chatView, posted } = setup({ fake: sessionAgent(FIRST_SESSION).script });
    await manager.connectToAgent('fake');
    await chatView.handleMessage({ type: 'ready' });
    const target = promptTarget(posted);
    manager.applyForegroundState(target, 'running');
    await chatView.handleMessage({ type: 'sendPrompt', target, text: 'queued from page' });
    expect(manager.sessionState(target)?.queue.map((entry) => entry.text)).toEqual(['queued from page']);
    expect(manager.sessionState(target)?.content.entries).toEqual([]);
    expect(chatView.queuedPrompts).toBe(1);
    await chatView.handleMessage({ type: 'ready' });
    expect(chatView.queuedPrompts).toBe(1);
    expect(contentSnapshots(posted).at(-1)).toMatchObject({ queue: [{ text: 'queued from page' }] });
  });

  it('reconstructs the core queue on ready without dispatching it or accepting old-page queue edits', async () => {
    const { manager, chatView, posted } = setup({ fake: sessionAgent(FIRST_SESSION).script });
    await manager.connectToAgent('fake');
    await chatView.handleMessage({ type: 'ready' });
    const target = promptTarget(posted);
    manager.applyForegroundState(target, 'running');
    await manager.submitPrompt(target, target.generation, 'retained queue');
    const head = manager.sessionState(target)?.queue[0];
    if (!head) { throw new Error('Missing queue head'); }
    posted.length = 0;
    await chatView.handleMessage({ type: 'ready' });
    expect(contentSnapshots(posted).at(-1)).toMatchObject({ queue: [{ id: head.id, text: 'retained queue', draft: null }] });
    const edit = { type: 'queueChanged' as const, target, change: { kind: 'cancelled' as const, id: head.id } };
    await chatView.handleMessage(edit);
    expect(manager.sessionState(target)?.queue.map((entry) => entry.text)).toEqual(['retained queue']);
    const current = promptTarget(posted);
    await chatView.handleMessage({ type: 'queueChanged', target: current, change: { kind: 'editStarted', id: head.id, revision: 1 } });
    await chatView.handleMessage({ type: 'queueChanged', target: current, change: { kind: 'edited', id: head.id, revision: 3, text: 'latest edit' } });
    await chatView.handleMessage({ type: 'queueChanged', target: current, change: { kind: 'edited', id: head.id, revision: 2, text: 'old edit' } });
    expect(manager.sessionState(current)?.queue[0]).toMatchObject({ draft: 'latest edit', revision: 3 });
    await chatView.handleMessage({ ...edit, target: current });
    expect(manager.sessionState(current)?.queue).toEqual([]);
    expect(manager.sessionState(current)?.content.entries).toEqual([]);
    expect(posted.filter((message) => message.type === 'contentPatch').at(-1)).toMatchObject({ type: 'contentPatch', queue: [] });
    const rebuilt = posted.reduce((state, message) => updateView(state, structuredClone(message), 0).state, initialState);
    expect(promptHistory(rebuilt.transcript)).toEqual([]);
  });

  it('retains queued submissions without a page and releases one after the current prompt settles', async () => {
    const pending: { text: string; finish: () => void }[] = [];
    let started!: () => void;
    let firstStarted!: () => void;
    const entered = new Promise<void>((resolve) => { firstStarted = resolve; });
    const next = new Promise<void>((resolve) => { started = resolve; });
    const { manager } = setup({ fake: () => fakeAgent()
      .onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION }))
      .onRequest(methods.agent.session.prompt, async ({ params }) => {
        const text = params.prompt.flatMap((part) => part.type === 'text' ? [part.text] : []).join('');
        await new Promise<void>((resolve) => { pending.push({ text, finish: resolve }); firstStarted(); if (pending.length === 2) { started(); } });
        return { stopReason: 'end_turn' };
      }) });
    await manager.connectToAgent('fake');
    const identity = address(FIRST_SESSION);
    const first = manager.sendPrompt(identity, 'first');
    const generation = manager.sessionState(identity)?.generation;
    if (generation === undefined) { throw new Error('Missing owner'); }
    await manager.submitPrompt(identity, generation, 'second');
    await manager.submitPrompt(identity, generation, 'third');
    try {
      expect(manager.sessionState(identity)?.queue.map((entry) => entry.text)).toEqual(['second', 'third']);
      await entered;
      pending[0]?.finish();
      await first;
      await next;
      expect(pending.map((entry) => entry.text)).toEqual(['first', 'second']);
      expect(manager.sessionState(identity)?.queue.map((entry) => entry.text)).toEqual(['third']);
    } finally {
      await manager.disconnectAgent('fake');
      for (const entry of pending) { entry.finish(); }
      await first;
    }
  });

  it('retains an ordered composer draft through page recreation without adding transcript content', async () => {
    const { manager, chatView, posted } = setup({ fake: sessionAgent(FIRST_SESSION).script });
    await manager.connectToAgent('fake');
    await chatView.handleMessage({ type: 'ready' });
    const target = promptTarget(posted);
    const edit = { type: 'composerEdited' as const, target, revision: 2, text: 'latest draft' };
    await chatView.handleMessage(edit);
    await chatView.handleMessage({ ...edit, revision: 1, text: 'obsolete draft' });
    posted.length = 0;
    await chatView.handleMessage({ type: 'ready' });
    const rebuilt = contentSnapshots(posted).at(-1);
    expect(rebuilt).toMatchObject({ composer: { text: 'latest draft', revision: 2 }, entries: [] });
    const stale = { ...edit, revision: 3, text: 'old page' };
    await chatView.handleMessage(stale);
    posted.length = 0;
    await chatView.handleMessage({ type: 'ready' });
    expect(contentSnapshots(posted).at(-1)).toMatchObject({ composer: { text: 'latest draft', revision: 2 } });
  });

  it('holds an edited core queue head through idle and releases its saved text without skipping it', async () => {
    const prompts: string[] = [];
    const { manager } = setup({ fake: () => fakeAgent()
      .onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION }))
      .onRequest(methods.agent.session.prompt, ({ params }) => {
        prompts.push(params.prompt.flatMap((part) => part.type === 'text' ? [part.text] : []).join(''));
        return { stopReason: 'end_turn' };
      }) });
    await manager.connectToAgent('fake');
    const identity = address(FIRST_SESSION);
    const generation = manager.sessionState(identity)?.generation;
    if (generation === undefined) { throw new Error('Missing owner'); }
    manager.applyForegroundState(identity, 'running');
    await manager.submitPrompt(identity, generation, 'head');
    await manager.submitPrompt(identity, generation, 'tail');
    const head = manager.sessionState(identity)?.queue[0];
    if (!head) { throw new Error('Missing queue head'); }
    manager.changeQueuedPrompt(identity, generation, { kind: 'editStarted', id: head.id, revision: 1 });
    manager.changeQueuedPrompt(identity, generation, { kind: 'edited', id: head.id, text: 'saved head', revision: 2 });
    manager.applyForegroundState(identity, 'idle');
    expect(prompts).toEqual([]);
    expect(manager.sessionState(identity)?.queue.map((entry) => entry.text)).toEqual(['head', 'tail']);
    let settled!: () => void;
    const completed = new Promise<void>((resolve) => { settled = resolve; });
    const stop = manager.onChanged(() => {
      if (prompts.length === 2 && !manager.hasForegroundWork(identity)) { settled(); }
    });
    try {
      manager.changeQueuedPrompt(identity, generation, { kind: 'editSaved', id: head.id, revision: 3 });
      await completed;
      expect(prompts).toEqual(['saved head', 'tail']);
      expect(manager.sessionState(identity)?.queue).toEqual([]);
      manager.changeQueuedPrompt(identity, generation, { kind: 'cancelled', id: head.id });
      expect(manager.sessionState(identity)?.content.entries.filter((entry) => entry.kind === 'prompt').map((entry) => entry.text)).toEqual(['saved head', 'tail']);
    } finally { stop(); }
  });

  it('excludes cancelled core queue text from recall and drops unsent entries on source retirement', async () => {
    const { manager, chatView, posted } = setup({ fake: sessionAgent(FIRST_SESSION).script });
    await manager.connectToAgent('fake');
    await chatView.handleMessage({ type: 'ready' });
    const target = promptTarget(posted);
    manager.applyForegroundState(target, 'running');
    await manager.submitPrompt(target, target.generation, 'head');
    await manager.submitPrompt(target, target.generation, 'tail');
    await manager.submitPrompt(target, target.generation - 1, 'wrong generation');
    const head = manager.sessionState(target)?.queue[0];
    if (!head) { throw new Error('Missing queue head'); }
    manager.changeQueuedPrompt(target, target.generation - 1, { kind: 'cancelled', id: head.id });
    expect(manager.sessionState(target)?.queue.map((entry) => entry.text)).toEqual(['head', 'tail']);
    manager.changeQueuedPrompt(target, target.generation, { kind: 'cancelled', id: head.id });
    const shown = () => posted.reduce((state, message) => updateView(state, structuredClone(message), 0).state, initialState);
    expect(promptHistory(shown().transcript)).toEqual([]);
    expect(manager.sessionState(target)?.queue.map((entry) => entry.text)).toEqual(['tail']);
    await manager.disconnectAgent('fake');
    expect(manager.sessionState(target)?.queue).toEqual([]);
    expect(promptHistory(shown().transcript)).toEqual([]);
    await manager.submitPrompt(target, target.generation, 'late');
    expect(manager.sessionState(target)?.queue).toEqual([]);
  });

  it('records a failed prompt before dispatching its queued successor and does not release again on duplicate idle', async () => {
    let release!: () => void;
    let entered!: () => void;
    let next!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const successor = new Promise<void>((resolve) => { next = resolve; });
    const observations: unknown[][] = [];
    const prompts: string[] = [];
    const { manager } = setup({ fake: () => fakeAgent()
      .onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION }))
      .onRequest(methods.agent.session.prompt, async ({ params }) => {
        const text = params.prompt.flatMap((part) => part.type === 'text' ? [part.text] : []).join('');
        prompts.push(text);
        if (text === 'first') { entered(); await gate; throw new RequestError(-32000, 'Refused'); }
        observations.push(manager.sessionState(address(FIRST_SESSION))?.content.entries.map((entry) => entry.kind) ?? []);
        next();
        return { stopReason: 'end_turn' };
      }) });
    await manager.connectToAgent('fake');
    const identity = address(FIRST_SESSION);
    const first = manager.sendPrompt(identity, 'first');
    const failure = expect(first).rejects.toThrow('Refused');
    await started;
    const generation = manager.sessionState(identity)?.generation;
    if (generation === undefined) { throw new Error('Missing owner'); }
    await manager.submitPrompt(identity, generation, 'second');
    release();
    await failure;
    await successor;
    expect(observations).toEqual([['prompt', 'error', 'prompt']]);
    manager.applyForegroundState(identity, 'idle');
    manager.applyForegroundState(identity, 'idle');
    expect(prompts).toEqual(['first', 'second']);
  });

  it('preserves the composer across disconnect and Load, and releases it on tab close', async () => {
    const { manager, chatView, posted } = setup({ fake: () => fakeAgent({ agentCapabilities: { loadSession: true } })
      .onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION }))
      .onRequest(methods.agent.session.load, () => ({})) });
    await manager.connectToAgent('fake');
    await chatView.handleMessage({ type: 'ready' });
    let target = promptTarget(posted);
    await chatView.handleMessage({ type: 'composerEdited', target, revision: 1, text: 'retained' });
    await manager.disconnectAgent('fake');
    expect(manager.sessionState(target)?.composer).toEqual({ text: 'retained', revision: 1 });
    await manager.loadSession('fake', FIRST_SESSION);
    expect(manager.sessionState(target)?.composer).toEqual({ text: 'retained', revision: 1 });
    await chatView.handleMessage({ type: 'ready' });
    target = promptTarget(posted);
    manager.releaseSessionState(target);
    await chatView.handleMessage({ type: 'composerEdited', target, revision: 2, text: 'late' });
    expect(manager.sessionState(target)).toBeUndefined();
  });

  describe('session settings', () => {
    it('rejects controls addressed to another configuration with the same session ID', async () => {
      const controls: unknown[] = [];
      const script: AgentScript = () => fakeAgent()
        .onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION, configOptions: [modelOption('a')] }))
        .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
          controls.push(params);
          return { configOptions: [modelOption('b')] };
        });
      const { manager } = setup({ fake: sessionAgent(FIRST_SESSION).script, other: script });
      await manager.connectToAgent('fake');
      const selected = await manager.connectToAgent('other');
      const wrong = { configuredName: 'fake', sessionId: FIRST_SESSION };
      const right = { configuredName: 'other', sessionId: FIRST_SESSION };

      expect(manager.getSession(wrong)).toBeUndefined();
      expect(manager.getSession(right)).toBe(selected);
      await manager.setConfigOption(wrong, 'model', 'b');
      await manager.setMode(wrong, 'code');
      await manager.setModel(wrong, 'b');
      await manager.cancelTurn(wrong);
      await expect(manager.sendPrompt(wrong, 'Wrong owner')).rejects.toThrow('Session not found');
      manager.applySessionInfoUpdate(wrong, { title: 'Wrong title' });
      manager.applyConfigOptions(wrong, [modelConfig('b')]);
      manager.applyCurrentMode(wrong, 'code');
      manager.applyAvailableCommands(wrong, [{ name: 'wrong', description: '', takesInput: false, hint: null }]);
      expect(selected.title).toBeUndefined();
      expect(selected.availableCommands).toEqual([]);
      expect(selected.configOptions).toEqual([modelConfig('a')]);
      expect(controls).toEqual([]);

      await manager.setConfigOption(right, 'model', 'b');
      expect(controls).toEqual([{ sessionId: FIRST_SESSION, configId: 'model', value: 'b' }]);
      expect(selected.configOptions).toEqual([modelConfig('b')]);
    });

    it.each(['config', 'mode'] as const)('does not apply a delayed %s setter to a replacement registration with the same ID', async (kind) => {
      let enter: () => void = () => {};
      let release: () => void = () => {};
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      const modes = { availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }], currentModeId: 'ask' };
      const state = kind === 'config' ? { configOptions: [modelOption('a')] } : { modes };
      const script: AgentScript = () => fakeAgent({ agentCapabilities: { loadSession: true } })
        .onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION, ...state }))
        .onRequest(methods.agent.session.load, () => state)
        .onRequest(methods.agent.session.setConfigOption, async () => {
          enter();
          await released;
          return { configOptions: [modelOption('b')] };
        })
        .onRequest(methods.agent.session.setMode, async () => {
          enter();
          await released;
          return {};
        });
      const { manager, reference, takeEvents, agents } = setup({ fake: script });
      const original = await manager.connectToAgent('fake');
      const setting = kind === 'config'
        ? manager.setConfigOption(address(FIRST_SESSION), 'model', 'b')
        : manager.setMode(address(FIRST_SESSION), 'code');
      let replacement;
      try {
        await entered;
        replacement = await manager.loadSession('fake', FIRST_SESSION);
        expect(replacement).not.toBe(original);
        takeEvents();
      } finally {
        release();
        await setting;
      }

      expect(agents.launched).toHaveLength(1);
      expect(manager.getSession(address(FIRST_SESSION))).toBe(replacement);
      expect(replacement.configOptions).toEqual(kind === 'config' ? [modelConfig('a')] : null);
      expect(replacement.modes?.current).toBe(kind === 'mode' ? 'ask' : undefined);
      expect(reference(FIRST_SESSION)?.selections).toEqual({ options: {} });
      expect(takeEvents()).toEqual([]);
    });

    it('replaces the config options with the full set the agent returns', async () => {
      const fake = sessionAgent(FIRST_SESSION, (app) => app.onRequest(methods.agent.session.setConfigOption, ({ params }) => ({
        configOptions: [modelOption(String(params.value))],
      })));
      const { manager } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');

      const options = await manager.setConfigOption(address(FIRST_SESSION), 'model', 'b');

      expect(options).toEqual([modelConfig('b')]);
      expect(manager.getSession(address(FIRST_SESSION))?.configOptions).toEqual([modelConfig('b')]);
    });

    it('keeps the config options, with the value asked for, when the agent answers without them', async () => {
      const fake = sessionAgent(FIRST_SESSION, (app) => app.onRequest(methods.agent.session.setConfigOption, () => (
        { configOptions: null } as unknown as { configOptions: SessionConfigOption[] }
      )));
      const { manager, reference } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');

      const options = await manager.setConfigOption(address(FIRST_SESSION), 'model', 'b');

      expect(options).toBeNull();
      expect(manager.getSession(address(FIRST_SESSION))?.configOptions).toEqual([modelConfig('b')]);
      expect(reference(FIRST_SESSION)?.selections).toEqual({ options: { model: 'b' } });
    });

    it('sets a boolean option, keeping the value asked for when the agent answers without the options', async () => {
      const fast: SessionConfigOption = { id: 'fast', name: 'Fast', type: 'boolean', currentValue: false };
      const set: unknown[] = [];
      const fake: AgentScript = () => fakeAgent()
        .onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION, configOptions: [modelOption('a'), fast] }))
        .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
          set.push(params);
          return { configOptions: null } as unknown as { configOptions: SessionConfigOption[] };
        });
      const { manager, reference } = setup({ fake });
      await manager.connectToAgent('fake');

      await manager.setConfigOption(address(FIRST_SESSION), 'fast', true);

      expect(set).toEqual([{ sessionId: FIRST_SESSION, configId: 'fast', type: 'boolean', value: true }]);
      expect(manager.getSession(address(FIRST_SESSION))?.configOptions?.find((option) => option.id === 'fast')?.current).toBe(true);
      expect(reference(FIRST_SESSION)?.selections).toEqual({ options: { model: 'a', fast: true } });
    });

    it('sets the model through the model config option', async () => {
      const set: unknown[] = [];
      const fake = sessionAgent(FIRST_SESSION, (app) => app.onRequest(methods.agent.session.setConfigOption, ({ params }) => {
        set.push(params);
        return { configOptions: [modelOption(String(params.value))] };
      }));
      const { manager } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');

      await manager.setModel(address(FIRST_SESSION), 'b');

      expect(set).toEqual([{ sessionId: FIRST_SESSION, configId: 'model', value: 'b' }]);
    });

    it('cannot set the model when the agent has no model option', async () => {
      const script: AgentScript = () => fakeAgent().onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION }));
      const { manager } = setup({ fake: script });
      await manager.connectToAgent('fake');

      await expect(manager.setModel(address(FIRST_SESSION), 'b')).rejects.toThrow('Fake Agent does not expose a model config option');
    });

    it('sets a mode through session/set_mode when the agent has no mode config option', async () => {
      const setModes: string[] = [];
      const script: AgentScript = () => fakeAgent()
        .onRequest(methods.agent.session.new, () => ({
          sessionId: FIRST_SESSION,
          modes: { availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }], currentModeId: 'ask' },
        }))
        .onRequest(methods.agent.session.setMode, ({ params }) => {
          setModes.push(params.modeId);
          return {};
        });
      const { manager, takeEvents } = setup({ fake: script });
      await manager.connectToAgent('fake');
      takeEvents();

      await manager.setMode(address(FIRST_SESSION), 'code');

      expect(setModes).toEqual(['code']);
      expect(manager.getSession(address(FIRST_SESSION))?.modes?.current).toBe('code');
      expect(takeEvents()).toEqual([['mode-changed', manager.getSession(address(FIRST_SESSION)), 'code']]);
    });

    it('sets the mode through a mode config option when the agent has one', async () => {
      const set: unknown[] = [];
      const modeOption: SessionConfigOption = {
        id: 'agent-mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'ask',
        options: [{ value: 'ask', name: 'Ask' }, { value: 'code', name: 'Code' }],
      };
      const script: AgentScript = () => fakeAgent()
        .onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION, configOptions: [modeOption] }))
        .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
          set.push(params);
          return { configOptions: [{ ...modeOption, currentValue: String(params.value) }] };
        });
      const { manager } = setup({ fake: script });
      await manager.connectToAgent('fake');

      await manager.setMode(address(FIRST_SESSION), 'code');

      expect(set).toEqual([{ sessionId: FIRST_SESSION, configId: 'agent-mode', value: 'code' }]);
    });
  });

  describe('session updates', () => {
    it('rejects stale native output targets and opens retained output only for the issued projection', async () => {
      const opened: string[] = [];
      const written: string[] = [];
      const { manager, connections, chatView, posted } = setup({ fake: sessionAgent(FIRST_SESSION).script }, {
        editor: unusedEditor, showsDiffs: false,
        terminals: { open: (name) => { opened.push(name); return { write: (text) => { written.push(text); }, show() {} }; } },
      });
      const connect = connections.connect.bind(connections);
      let sink: import('@/core/acp/AcpDriver').SessionUpdateSink | undefined;
      vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, input, closed) => {
        sink = input;
        return connect(name, streams, id, input, closed);
      });
      await manager.connectToAgent('fake');
      sink?.handleUpdate(FIRST_SESSION, { kind: 'terminalOutput', terminalId: 'term', data: new TextEncoder().encode('retained') }, 'v2');
      await chatView.handleMessage({ type: 'ready' });
      const old = contentSnapshots(posted).at(-1);
      if (!old) { throw new Error('Missing projection'); }
      await chatView.handleMessage({ type: 'ready' });

      expect(chatView.openCommandOutput(old.target, { kind: 'terminal', terminalId: 'term' }, 'stale')).toBe(false);
      expect(opened).toEqual([]);
      expect(written).toEqual([]);
      const current = contentSnapshots(posted).at(-1);
      if (!current) { throw new Error('Missing current projection'); }
      expect(chatView.openCommandOutput(current.target, { kind: 'terminal', terminalId: 'term' }, 'Output')).toBe(true);
      expect(opened).toEqual(['Output']);
      expect(written).toEqual(['retained']);
    });

    it('releases terminal and diff retention without clearing an already-open native terminal', async () => {
      const written: string[] = [];
      const states = new SessionStates(() => {}, { open: () => ({ write: (text) => { written.push(text); }, show() {} }) });
      onTestFinished(() => states.dispose());
      const identity = { configuredName: 'fake', sessionId: FIRST_SESSION };
      const registration = { agentName: 'fake', agentId: 'source', sessionId: FIRST_SESSION };
      states.attach(registration);
      states.accept(registration, { kind: 'terminalOutput', terminalId: 'term', data: new TextEncoder().encode('retained') }, 0);
      states.accept(registration, { kind: 'toolCall', toolCallId: 'edit', content: [
        { kind: 'diff', diff: { kind: 'wholeFile', path: '/work/a.ts', oldText: 'a', newText: 'b' } },
      ] }, 0);
      expect(states.openCommandOutput(identity, { kind: 'terminal', terminalId: 'term' }, 'Output')).toBe(true);
      expect(states.toolCallDiffs(identity, 'edit', '/work')?.flat()[0]?.path).toBe('a.ts');
      expect(written).toEqual(['retained']);

      states.release(identity);

      expect(states.openCommandOutput(identity, { kind: 'terminal', terminalId: 'term' }, 'Output')).toBe(false);
      expect(states.toolCallDiffs(identity, 'edit', '/work')).toBeUndefined();
      expect(written).toEqual(['retained']);
      await states.dispose();
      expect(states.view(identity)).toBeUndefined();
    });

    it('does not resurrect released content through an old registration after the same session reopens', async () => {
      const states = new SessionStates(() => {});
      onTestFinished(() => states.dispose());
      const identity = { configuredName: 'fake', sessionId: FIRST_SESSION };
      const old = { agentName: 'fake', agentId: 'old-source', sessionId: FIRST_SESSION };
      states.attach(old);
      states.accept(old, { kind: 'agentMessage', messageId: 'm1', text: 'Original' }, 0);
      const generation = states.view(identity)?.generation;
      states.release(identity);
      states.attach(old);
      states.accept(old, { kind: 'agentMessage', messageId: 'm1', text: 'Late' }, 1);
      states.submitted(old, 'Late prompt');
      expect(states.view(identity)).toBeUndefined();
      const replacement = { ...old, agentId: 'new-source' };
      states.attach(replacement);
      states.submitted(replacement, 'New prompt');
      states.accept(old, { kind: 'agentMessage', messageId: 'm1', text: 'Late again' }, 2);
      states.promptFailed(old, 'Old error');
      expect(states.view(identity)?.generation).not.toBe(generation);
      expect(states.view(identity)?.content.entries).toEqual([{ kind: 'prompt', id: 1, text: 'New prompt' }]);
    });

    it('rejects every former registration after a loaded owner is closed and reopened', () => {
      const states = new SessionStates(() => {});
      onTestFinished(() => states.dispose());
      const identity = { configuredName: 'fake', sessionId: FIRST_SESSION };
      const old = { agentName: 'fake', agentId: 'source', sessionId: FIRST_SESSION };
      states.attach(old);
      const loading = { ...old };
      states.attach(loading);
      const load: SessionLoad = { registration: loading, origin: { identity, sourceId: 'source' }, attempt: Symbol() };
      states.beginLoad(load);
      states.endLoad(load, true);
      states.release(identity);
      const reopened = { ...old, agentId: 'replacement' };
      states.attach(reopened);
      states.submitted(reopened, 'Current');

      states.accept(old, { kind: 'agentMessage', messageId: 'old', text: 'Late content' }, 1);
      states.submitted(old, 'Late prompt');
      states.promptFailed(old, 'Late error');
      states.turnEnded(old, 2);
      states.attach(old);

      expect(states.view(identity)?.content.entries).toEqual([{ kind: 'prompt', id: 1, text: 'Current' }]);
    });

    it.each([false, true])('cannot commit a staged Load after its tab closes (success: %s)', (ok) => {
      const states = new SessionStates(() => {});
      onTestFinished(() => states.dispose());
      const identity = { configuredName: 'fake', sessionId: FIRST_SESSION };
      const registration = { agentName: 'fake', agentId: 'source', sessionId: FIRST_SESSION };
      states.attach(registration);
      const load: SessionLoad = { registration, origin: { identity, sourceId: 'source' }, attempt: Symbol() };
      states.beginLoad(load);
      states.accept(registration, { kind: 'agentMessage', messageId: 'replay', text: 'Replay' }, 0);
      states.release(identity);
      const reopened = { ...registration, agentId: 'replacement' };
      states.attach(reopened);
      states.submitted(reopened, 'Current');
      const current = states.view(identity);

      states.endLoad(load, ok);
      states.accept(registration, { kind: 'agentMessage', messageId: 'late', text: 'Late replay' }, 1);

      expect(states.view(identity)).toBe(current);
      expect(states.view(identity)?.content.entries).toEqual([{ kind: 'prompt', id: 1, text: 'Current' }]);
    });

    it('projects an empty owner before content and changes its generation only after successful Load', async () => {
      let failLoad = false;
      const script: AgentScript = () => fakeAgent({ agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } })
        .onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION }))
        .onRequest(methods.agent.session.load, () => {
          if (failLoad) { throw RequestError.invalidParams(undefined, 'Replay failed'); }
          return {};
        })
        .onRequest(methods.agent.session.resume, () => ({}));
      const { manager, chatView, posted } = setup({ fake: script });
      const snapshot = async () => {
        posted.splice(0);
        await chatView.handleMessage({ type: 'ready' });
        const snapshot = contentSnapshots(posted).at(-1);
        if (!snapshot) { throw new Error('Missing retained presentation for empty session'); }
        return snapshot;
      };
      await manager.connectToAgent('fake');
      const original = await snapshot();
      expect(original.entries).toEqual([]);
      await manager.resumeSession('fake', FIRST_SESSION);
      expect((await snapshot()).target.generation).toBe(original.target.generation);
      await manager.loadSession('fake', FIRST_SESSION);
      const loaded = await snapshot();
      expect(loaded.entries).toEqual([]);
      expect(loaded.target.generation).not.toBe(original.target.generation);
      failLoad = true;
      await expect(manager.loadSession('fake', FIRST_SESSION)).rejects.toThrow('Replay failed');
      expect((await snapshot()).target.generation).toBe(loaded.target.generation);
    });

    it('projects an accepted local prompt before the agent replies or emits content', async () => {
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => { finish = resolve; });
      const { manager, chatView, posted } = setup({ fake: () => fakeAgent()
        .onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION }))
        .onRequest(methods.agent.session.prompt, async () => { await finished; return { stopReason: 'end_turn' }; }),
      });
      await manager.connectToAgent('fake');
      await chatView.handleMessage({ type: 'ready' });
    const prompt = chatView.handleMessage({ type: 'sendPrompt', target: promptTarget(posted), text: 'First prompt' });
      try {
        const view = posted.reduce((state, message) => updateView(state, structuredClone(message), 0).state, initialState);
        expect(view.transcript.entries).toEqual([{ kind: 'prompt', id: 1, text: 'First prompt' }]);
        expect(view.activeSession?.turnRunning).toBe(true);
      } finally { finish(); await prompt; }
    });

    it('flushes command output cleaned during a local prompt before reporting its end', async () => {
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => { finish = resolve; });
      const { manager, connections, chatView, posted } = setup({ fake: () => fakeAgent()
        .onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION }))
        .onRequest(methods.agent.session.prompt, async () => { await finished; return { stopReason: 'end_turn' }; }),
      });
      const connect = connections.connect.bind(connections);
      let sink: import('@/core/acp/AcpDriver').SessionUpdateSink | undefined;
      vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, input, closed) => {
        sink = input;
        return connect(name, streams, id, input, closed);
      });
      await manager.connectToAgent('fake');
      await chatView.handleMessage({ type: 'ready' });
    const prompt = chatView.handleMessage({ type: 'sendPrompt', target: promptTarget(posted), text: 'run' });
      let cleaned!: () => void;
      const cleaning = new Promise<void>((resolve) => { cleaned = resolve; });
      const stop = manager.onChanged(() => {
        const state = manager.sessionState({ configuredName: 'fake', sessionId: FIRST_SESSION });
        if (state?.content.entries.some((entry) => entry.kind === 'turn' && entry.parts.some((part) => part.kind === 'toolCalls'
          && part.toolCalls.some((call) => call.content.some((item) => item.kind === 'commandOutput'))))) { cleaned(); }
      });
      try {
        sink?.handleUpdate(FIRST_SESSION, { kind: 'toolCall', toolCallId: 'run', toolKind: 'execute', content: [{ kind: 'text', text: '\x1b[32mdone\x1b[0m' }] }, 'v1');
        await cleaning;
      } finally { stop(); finish(); await prompt; }
      const end = posted.findIndex((message) => message.type === 'promptEnd');
      expect(end).toBeGreaterThanOrEqual(0);
      const view = posted.slice(0, end).reduce((state, message) => updateView(state, structuredClone(message), 0).state, initialState);
      expect(view.transcript.entries).toMatchObject([{ kind: 'prompt', text: 'run' }, { kind: 'turn', parts: [
        { kind: 'toolCalls', toolCalls: [{ content: [{ kind: 'commandOutput', text: 'done', truncated: false }] }] },
      ] }]);
    });

    it('patches the empty retained projection on its first content update', async () => {
      const { manager, connections, chatView, posted } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      const connect = connections.connect.bind(connections);
      let sink: import('@/core/acp/AcpDriver').SessionUpdateSink | undefined;
      vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, input, closed) => {
        sink = input;
        return connect(name, streams, id, input, closed);
      });
      await manager.connectToAgent('fake');
      await chatView.handleMessage({ type: 'ready' });
      let view = posted.reduce((state, message) => updateView(state, structuredClone(message), 0).state, initialState);
      posted.splice(0);
      sink?.handleUpdate(FIRST_SESSION, { kind: 'toolCall', toolCallId: 'run', content: [{ kind: 'terminal', terminalId: 'term' }] }, 'v2');
      expect(posted).toMatchObject([{ type: 'contentPatch', patches: [{ kind: 'insert', entries: [
        { kind: 'turn', parts: [{ kind: 'toolCalls', toolCalls: [{ toolCallId: 'run', content: [{ kind: 'terminal', terminalId: 'term' }] }] }] },
      ] }] }]);
      view = posted.reduce((state, message) => updateView(state, structuredClone(message), 0).state, view);
      expect(view.transcript.entries).toMatchObject([{ kind: 'turn', parts: [{ kind: 'toolCalls', toolCalls: [{ toolCallId: 'run' }] }] }]);
    });

    it('retains terminal output cleaned before session registration without publishing it early', async () => {
      let started!: () => void;
      const readStarted = new Promise<void>((resolve) => { started = resolve; });
      let sink: import('@/core/acp/AcpDriver').SessionUpdateSink | undefined;
      const shown = AgentTerminals.prototype.shown;
      let reading: Promise<CommandOutput.ShownOutput> | undefined;
      const read = vi.spyOn(AgentTerminals.prototype, 'shown').mockImplementation(function (this: AgentTerminals, ...args) {
        reading = shown.call(this, ...args);
        started();
        return reading;
      });
      onTestFinished(() => read.mockRestore());
      const identity = { configuredName: 'fake', sessionId: FIRST_SESSION };
      const { manager, connections } = setup({ fake: () => fakeAgent().onRequest(methods.agent.session.new, async () => {
        sink?.handleUpdate(FIRST_SESSION, { kind: 'terminalOutput', terminalId: 'term', data: new TextEncoder().encode('\x1b[32mearly\x1b[0m') }, 'v2');
        await readStarted;
        await reading;
        expect(manager.sessionState(identity)).toBeUndefined();
        return { sessionId: FIRST_SESSION };
      }) });
      const connect = connections.connect.bind(connections);
      vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, input, closed) => {
        sink = input;
        return connect(name, streams, id, input, closed);
      });
      await manager.connectToAgent('fake');
      expect(manager.sessionState(identity)?.terminals.get('term')).toEqual({ text: 'early', truncated: false, exitStatus: null });
    });

    it.each([false, true])('keeps cleaned replay terminal snapshots staged until Load settles (success: %s)', async (ok) => {
      let started!: () => void;
      let readStarted = new Promise<void>((resolve) => { started = resolve; });
      const shown = AgentTerminals.prototype.shown;
      let reading: Promise<CommandOutput.ShownOutput> | undefined;
      const read = vi.spyOn(AgentTerminals.prototype, 'shown').mockImplementation(function (this: AgentTerminals, ...args) {
        reading = shown.call(this, ...args);
        started();
        return reading;
      });
      onTestFinished(() => read.mockRestore());
      let replayed!: () => void;
      let finish!: () => void;
      const replay = new Promise<void>((resolve) => { replayed = resolve; });
      const finished = new Promise<void>((resolve) => { finish = resolve; });
      let sink: import('@/core/acp/AcpDriver').SessionUpdateSink | undefined;
      const { manager, connections } = setup({ fake: () => fakeAgent({ agentCapabilities: { loadSession: true } })
        .onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION }))
        .onRequest(methods.agent.session.load, async () => {
          sink?.handleUpdate(FIRST_SESSION, { kind: 'terminal', terminalId: 'term', output: new TextEncoder().encode('\x1b[32mreplayed\x1b[0m'),
            exitStatus: { exitCode: 0, signal: null } }, 'v2');
          await readStarted;
          await reading;
          replayed();
          await finished;
          if (!ok) { throw RequestError.invalidParams(undefined, 'Replay failed'); }
          return {};
        }),
      });
      const connect = connections.connect.bind(connections);
      vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, input, closed) => {
        sink = input;
        return connect(name, streams, id, input, closed);
      });
      await manager.connectToAgent('fake');
      sink?.handleUpdate(FIRST_SESSION, { kind: 'terminalOutput', terminalId: 'term', data: new TextEncoder().encode('original') }, 'v2');
      await readStarted;
      await reading;
      const identity = { configuredName: 'fake', sessionId: FIRST_SESSION };
      const before = manager.sessionState(identity);
      expect(before?.terminals.get('term')).toEqual({ text: 'original', truncated: false, exitStatus: null });
      readStarted = new Promise<void>((resolve) => { started = resolve; });
      const loading = manager.loadSession('fake', FIRST_SESSION).then(() => 'ok', () => 'failed');
      try {
        await replay;
        expect(manager.sessionState(identity)).toBe(before);
      } finally { finish(); }
      expect(await loading).toBe(ok ? 'ok' : 'failed');
      expect(manager.sessionState(identity)?.terminals.get('term')).toEqual(ok
        ? { text: 'replayed', truncated: false, exitStatus: { exitCode: 0, signal: null } }
        : { text: 'original', truncated: false, exitStatus: null });
      if (!ok) { expect(manager.sessionState(identity)).toBe(before); }
    });

    it('cannot publish a delayed terminal read into a closed and reopened owner', async () => {
      let started!: () => void;
      const readStarted = new Promise<void>((resolve) => { started = resolve; });
      const original = AgentTerminals.prototype.shown;
      let finish!: () => void;
      const held = new Promise<void>((resolve) => { finish = resolve; });
      let reading: Promise<CommandOutput.ShownOutput> | undefined;
      const read = vi.spyOn(AgentTerminals.prototype, 'shown').mockImplementation(function (this: AgentTerminals, ...args) {
        const output = original.call(this, ...args);
        reading = output?.then(async (value) => { await held; return value; });
        started();
        return reading;
      });
      onTestFinished(() => { finish(); read.mockRestore(); });
      const states = new SessionStates(() => {});
      onTestFinished(() => states.dispose());
      const identity = { configuredName: 'fake', sessionId: FIRST_SESSION };
      const registration = { agentName: 'fake', agentId: 'old', sessionId: FIRST_SESSION };
      states.attach(registration);
      states.accept(registration, { kind: 'terminalOutput', terminalId: 'term', data: new TextEncoder().encode('Old') }, 0);
      await readStarted;
      const oldRead = reading;
      expect(oldRead).toBeDefined();
      states.release(identity);
      states.attach({ ...registration, agentId: 'new' });
      const current = states.view(identity);

      finish();
      await oldRead;

      expect(states.view(identity)).toBe(current);
      expect(states.view(identity)?.terminals.size).toBe(0);
    });

    it('ingests each terminal update once through the runtime update path', async () => {
      const written: string[] = [];
      const { manager, connections } = setup({ fake: sessionAgent(FIRST_SESSION).script }, {
        editor: unusedEditor, showsDiffs: false, terminals: { open: () => ({ write: (text) => { written.push(text); }, show() {} }) },
      });
      const connect = connections.connect.bind(connections);
      let sink: import('@/core/acp/AcpDriver').SessionUpdateSink | undefined;
      vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, input, closed) => {
        sink = input;
        return connect(name, streams, id, input, closed);
      });
      await manager.connectToAgent('fake');
      const identity = { configuredName: 'fake', sessionId: FIRST_SESSION };
      sink?.handleUpdate(FIRST_SESSION, { kind: 'terminalOutput', terminalId: 'term', data: new TextEncoder().encode('clean') }, 'v2');
      expect(manager.openCommandOutput(identity, { kind: 'terminal', terminalId: 'term' }, 'Terminal')).toBe(true);
      expect(written).toEqual(['clean']);
    });

    it('projects retained terminal changes and reconstructs them after page recreation', async () => {
      const { manager, connections, chatView, posted } = setup({ fake: sessionAgent(FIRST_SESSION).script }, {
        editor: unusedEditor, showsDiffs: false, terminals: { open: () => ({ write: () => {}, show() {} }) },
      });
      const connect = connections.connect.bind(connections);
      let sink: import('@/core/acp/AcpDriver').SessionUpdateSink | undefined;
      vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, input, closed) => {
        sink = input;
        return connect(name, streams, id, input, closed);
      });
      await manager.connectToAgent('fake');
      sink?.handleUpdate(FIRST_SESSION, { kind: 'toolCall', toolCallId: 'run', content: [{ kind: 'terminal', terminalId: 'term' }] }, 'v2');
      await chatView.handleMessage({ type: 'ready' });
      let finished!: () => void;
      const changed = new Promise<void>((resolve) => { finished = resolve; });
      const stop = manager.onChanged(() => {
        if (manager.sessionState({ configuredName: 'fake', sessionId: FIRST_SESSION })?.terminals.get('term')?.text === 'clean') { finished(); }
      });
      try {
        sink?.handleUpdate(FIRST_SESSION, { kind: 'terminalOutput', terminalId: 'term', data: new TextEncoder().encode('\x1b[32mclean\x1b[0m') }, 'v2');
        await changed;
        const view = posted.reduce((state, message) => updateView(state, structuredClone(message), 0).state, initialState);
        expect(view.transcript.terminals.get('term')).toEqual({ text: 'clean', truncated: false, exitStatus: null });
        await chatView.handleMessage({ type: 'ready' });
        const rebuilt = posted.reduce((state, message) => updateView(state, structuredClone(message), 0).state, initialState);
        expect(rebuilt.transcript.terminals.get('term')).toEqual({ text: 'clean', truncated: false, exitStatus: null });
      } finally { stop(); }
    });

    it.each([false, true])('retains command and terminal output through Load and equal-ID owner replacement (success: %s)', async (ok) => {
      const written: string[] = [];
      const sinks = new Map<string, import('@/core/acp/AcpDriver').SessionUpdateSink>();
      const { manager, connections } = setup({ fake: () => fakeAgent({ agentCapabilities: { loadSession: true } })
        .onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION }))
        .onRequest(methods.agent.session.load, () => {
          sinks.get('fake')?.handleUpdate(FIRST_SESSION, { kind: 'terminalOutput', terminalId: 'term', data: new TextEncoder().encode('replayed') }, 'v2');
          if (!ok) { throw RequestError.invalidParams(undefined, 'Replay failed'); }
          return {};
        }), other: sessionAgent(FIRST_SESSION).script,
      }, { editor: unusedEditor, showsDiffs: false, terminals: { open: () => ({ write: (text) => { written.push(text); }, show() {} }) } });
      const connect = connections.connect.bind(connections);
      vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, input, closed) => {
        sinks.set(name, input);
        return connect(name, streams, id, input, closed);
      });
      const identity = { configuredName: 'fake', sessionId: FIRST_SESSION };
      await manager.connectToAgent('fake');
      sinks.get('fake')?.handleUpdate(FIRST_SESSION, { kind: 'terminalOutput', terminalId: 'term', data: new TextEncoder().encode('original') }, 'v2');
      sinks.get('fake')?.handleUpdate(FIRST_SESSION, { kind: 'toolCall', toolCallId: 'run', toolKind: 'execute', content: [
        { kind: 'text', text: '\x1b[32mcommand\x1b[0m' },
      ] }, 'v1');
      expect(manager.openCommandOutput(identity, { kind: 'toolCall', toolCallId: 'run' }, 'Run')).toBe(true);
      expect(written).toEqual(['\x1b[32mcommand\x1b[0m']);
      written.splice(0);
      const loading = await manager.loadSession('fake', FIRST_SESSION).then(() => 'ok', () => 'failed');
      expect(loading).toBe(ok ? 'ok' : 'failed');
      await manager.connectToAgent('other');
      sinks.get('other')?.handleUpdate(FIRST_SESSION, { kind: 'terminalOutput', terminalId: 'term', data: new TextEncoder().encode('other') }, 'v2');
      expect(manager.openCommandOutput(identity, { kind: 'terminal', terminalId: 'term' }, 'Terminal')).toBe(true);
      expect(manager.openCommandOutput({ configuredName: 'other', sessionId: FIRST_SESSION }, { kind: 'terminal', terminalId: 'term' }, 'Other')).toBe(true);
      expect(written).toEqual([ok ? 'replayed' : 'original', 'other']);
      expect(manager.openCommandOutput(identity, { kind: 'toolCall', toolCallId: 'run' }, 'Run')).toBe(!ok);
    });

    it('opens retained diff files after registration removal and does not retarget equal tool-call IDs', async () => {
      const opened: string[] = [];
      const changed: string[] = [];
      const { manager, connections, chatView, posted } = setup({ fake: sessionAgent(FIRST_SESSION).script, other: sessionAgent(FIRST_SESSION).script }, {
        showsDiffs: true,
        editor: { exists: async () => true, readText: async () => null, open: async (path) => { opened.push(path); },
          showChanges: async (path) => { changed.push(path); }, showInformationMessage: async () => undefined },
      });
      const connect = connections.connect.bind(connections);
      const sinks = new Map<string, import('@/core/acp/AcpDriver').SessionUpdateSink>();
      vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, input, closed) => {
        sinks.set(name, input);
        return connect(name, streams, id, input, closed);
      });
      const registration = await manager.connectToAgent('fake');
      sinks.get('fake')?.handleUpdate(FIRST_SESSION, { kind: 'toolCall', toolCallId: 'edit', content: [
        { kind: 'diff', diff: { kind: 'wholeFile', path: '/work/first.ts', oldText: 'a', newText: 'b' } },
      ] }, 'v1');
      await manager.disconnectAgent('fake');
      chatView.notifySessionRemoved(registration);
      await chatView.handleMessage({ type: 'ready' });
      expect(contentSnapshots(posted).at(-1)).toMatchObject({ entries: [
        { kind: 'turn', parts: [{ kind: 'toolCalls', toolCalls: [{ content: [{ kind: 'diff', files: [{ path: 'first.ts' }] }] }] }] },
      ] });
      const first = contentSnapshots(posted).at(-1);
      if (!first) { throw new Error('Missing retained projection'); }
      await chatView.handleMessage({ type: 'openFile', target: first.target, toolCallId: 'edit', file: 0 });
      await chatView.handleMessage({ type: 'openChanges', target: first.target, toolCallId: 'edit', file: 0 });
      await manager.connectToAgent('other');
      sinks.get('other')?.handleUpdate(FIRST_SESSION, { kind: 'toolCall', toolCallId: 'edit', content: [
        { kind: 'diff', diff: { kind: 'wholeFile', path: '/work/second.ts', oldText: 'a', newText: 'b' } },
      ] }, 'v1');
      chatView.notifyActiveSessionChanged();
      const second = contentSnapshots(posted).at(-1);
      if (!second) { throw new Error('Missing other projection'); }
      await chatView.handleMessage({ type: 'openFile', target: second.target, toolCallId: 'edit', file: 0 });
      expect(opened).toEqual(['/work/first.ts', '/work/second.ts']);
      expect(changed).toEqual(['/work/first.ts']);
    });

    it.each([false, true])('keeps retained diff files owner-local through Load (success: %s)', async (ok) => {
      let replayed!: () => void;
      let finish!: () => void;
      const replay = new Promise<void>((resolve) => { replayed = resolve; });
      const finished = new Promise<void>((resolve) => { finish = resolve; });
      const { manager, connections } = setup({ fake: () => fakeAgent({ agentCapabilities: { loadSession: true } })
        .onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION }))
        .onRequest(methods.agent.session.load, async () => {
          sink?.handleUpdate(FIRST_SESSION, { kind: 'toolCall', toolCallId: 'edit', content: [
            { kind: 'diff', diff: { kind: 'wholeFile', path: '/work/replayed.ts', oldText: 'old', newText: 'new' } },
          ] }, 'v1');
          replayed();
          await finished;
          if (!ok) { throw RequestError.invalidParams(undefined, 'Replay failed'); }
          return {};
        }), other: sessionAgent(FIRST_SESSION).script,
      });
      const identity = { configuredName: 'fake', sessionId: FIRST_SESSION };
      const connect = connections.connect.bind(connections);
      let sink: import('@/core/acp/AcpDriver').SessionUpdateSink | undefined;
      vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, input, closed) => {
        if (name === 'fake') { sink = input; }
        return connect(name, streams, id, input, closed);
      });
      await manager.connectToAgent('fake');
      sink?.handleUpdate(FIRST_SESSION, { kind: 'toolCall', toolCallId: 'edit', content: [
        { kind: 'diff', diff: { kind: 'wholeFile', path: '/work/original.ts', oldText: null, newText: 'original' } },
      ] }, 'v1');
      const before = manager.sessionToolCallDiffs(identity, 'edit', '/work');
      expect(before?.flat()[0]).toMatchObject({ path: 'original.ts', reported: { path: '/work/original.ts' } });
      const loading = manager.loadSession('fake', FIRST_SESSION).then(() => 'ok', () => 'failed');
      try {
        await replay;
        expect(manager.sessionToolCallDiffs(identity, 'edit', '/work')?.flat()[0]?.reported?.path).toBe('/work/original.ts');
      } finally { finish(); await loading; }
      expect(await loading).toBe(ok ? 'ok' : 'failed');
      expect(manager.sessionToolCallDiffs(identity, 'edit', '/work')?.flat()[0]?.reported?.path)
        .toBe(ok ? '/work/replayed.ts' : '/work/original.ts');
      await manager.connectToAgent('other');
      expect(manager.sessionToolCallDiffs({ configuredName: 'other', sessionId: FIRST_SESSION }, 'edit', '/work')).toBeUndefined();
      expect(manager.sessionToolCallDiffs(identity, 'edit', '/work')?.flat()[0]?.reported?.path)
        .toBe(ok ? '/work/replayed.ts' : '/work/original.ts');
    });

    it('cleans command output received before session registration', async () => {
      let sink: import('@/core/acp/AcpDriver').SessionUpdateSink | undefined;
      const { manager, connections, chatView, posted } = setup({ fake: () => fakeAgent()
        .onRequest(methods.agent.session.new, () => {
          sink?.handleUpdate(FIRST_SESSION, { kind: 'toolCall', toolCallId: 'run', toolKind: 'execute', content: [{ kind: 'text', text: 'Early' }] }, 'v1');
          return { sessionId: FIRST_SESSION };
        }),
      });
      const connect = connections.connect.bind(connections);
      vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, input, closed) => {
        sink = input;
        return connect(name, streams, id, input, closed);
      });
      let finishCleaning!: () => void;
      const cleaned = new Promise<void>((resolve) => { finishCleaning = resolve; });
      const stop = manager.onChanged(() => {
        const entries = manager.sessionState({ configuredName: 'fake', sessionId: FIRST_SESSION })?.content.entries;
        if (entries?.some((entry) => entry.kind === 'turn' && entry.parts.some((part) => part.kind === 'toolCalls'
          && part.toolCalls.some((call) => call.content.some((item) => item.kind === 'commandOutput'))))) { finishCleaning(); }
      });
      try {
        await manager.connectToAgent('fake');
        await cleaned;
        await chatView.handleMessage({ type: 'ready' });
        expect(contentSnapshots(posted).at(-1)).toMatchObject({ entries: [
          { kind: 'turn', parts: [{ kind: 'toolCalls', toolCalls: [{ content: [{ kind: 'commandOutput', text: 'Early', truncated: false }] }] }] },
        ] });
      } finally { stop(); }
    });

    it('patches only the changed retained tool call and preserves its sibling reference', async () => {
      const { manager, connections, chatView, posted } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      const connect = connections.connect.bind(connections);
      let sink: import('@/core/acp/AcpDriver').SessionUpdateSink | undefined;
      vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, input, closed) => {
        sink = input;
        return connect(name, streams, id, input, closed);
      });
      await manager.connectToAgent('fake');
      sink?.handleUpdate(FIRST_SESSION, { kind: 'toolCall', toolCallId: 'first', title: 'First', status: 'running', content: [] }, 'v1');
      sink?.handleUpdate(FIRST_SESSION, { kind: 'toolCall', toolCallId: 'second', title: 'Second', status: 'running', content: [] }, 'v1');
      await chatView.handleMessage({ type: 'ready' });
      let view = posted.reduce((state, message) => updateView(state, structuredClone(message), 0).state, initialState);
      const before = view.transcript.entries[0];
      if (before?.kind !== 'turn' || before.parts[0]?.kind !== 'toolCalls') { throw new Error('Expected tool calls'); }
      const sibling = before.parts[0].toolCalls[1];
      posted.splice(0);
      sink?.handleUpdate(FIRST_SESSION, { kind: 'toolCall', toolCallId: 'first', status: 'completed' }, 'v1');
      expect(posted).toMatchObject([{ type: 'contentPatch', patches: [{ kind: 'toolCall', call: { toolCallId: 'first', status: 'completed' } }] }]);
      view = posted.reduce((state, message) => updateView(state, structuredClone(message), 0).state, view);
      const after = view.transcript.entries[0];
      if (after?.kind !== 'turn' || after.parts[0]?.kind !== 'toolCalls') { throw new Error('Expected tool calls'); }
      expect(after.parts[0].toolCalls[1]).toBe(sibling);
    });

    it.each(['replacement', 'failed Load', 'successful Load', 'rename', 'close/reopen'] as const)('keeps asynchronous command cleaning with its retained content: %s', async (change) => {
      const cleaning: { text: string; finish: (output: CommandOutput.ShownOutput) => void; attempted: Promise<void> }[] = [];
      const attempts: (() => void)[] = [];
      const clean = vi.spyOn(CommandOutput, 'cleaned').mockImplementation((text) => {
        let finish!: (output: CommandOutput.ShownOutput) => void;
        const result = new Promise<CommandOutput.ShownOutput>((resolve) => { finish = resolve; });
        const attempted = new Promise<void>((resolve) => { attempts.push(resolve); });
        cleaning.push({ text, finish, attempted });
        return result;
      });
      const transition = RetainedContent.withCleanedToolContent;
      const applied = vi.spyOn(RetainedContent, 'withCleanedToolContent').mockImplementation((...args) => {
        const result = transition(...args);
        attempts.shift()?.();
        return result;
      });
      onTestFinished(() => { clean.mockRestore(); applied.mockRestore(); });
      let sink: import('@/core/acp/AcpDriver').SessionUpdateSink | undefined;
      const { manager, connections, chatView } = setup({ fake: () => fakeAgent({ agentCapabilities: { loadSession: true } })
        .onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION }))
        .onRequest(methods.agent.session.load, ({ params }) => {
          if (params.sessionId !== FIRST_SESSION) { throw new Error('Unexpected Load target'); }
          sink?.handleUpdate(FIRST_SESSION, { kind: 'toolCall', toolCallId: 'run', toolKind: 'execute', title: 'Run',
            content: [{ kind: 'text', text: 'Replayed' }] }, 'v1');
          if (change === 'failed Load') { throw RequestError.invalidParams(undefined, 'Replay failed'); }
          return {};
        }),
      });
      const connect = connections.connect.bind(connections);
      vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, input, closed) => {
        sink = input;
        return connect(name, streams, id, input, closed);
      });
      await manager.connectToAgent('fake');
      await chatView.dispose();
      sink?.handleUpdate(FIRST_SESSION, { kind: 'toolCall', toolCallId: 'run', toolKind: 'execute', title: 'Run',
        content: [{ kind: 'text', text: 'Original' }] }, 'v1');
      if (change === 'replacement') {
        sink?.handleUpdate(FIRST_SESSION, { kind: 'toolCall', toolCallId: 'run', content: [] }, 'v1');
      } else if (change === 'rename') {
        manager.agentsChanged({ fake: { command: 'fake' } }, { renamed: { command: 'fake' } });
      } else if (change === 'close/reopen') {
        manager.releaseSessionState({ configuredName: 'fake', sessionId: FIRST_SESSION });
        await manager.loadSession('fake', FIRST_SESSION);
      } else {
        await manager.loadSession('fake', FIRST_SESSION).catch((error: unknown) => { if (change !== 'failed Load') { throw error; } });
      }
      for (const work of cleaning) {
        work.finish({ text: work.text, truncated: false });
        await work.attempted;
      }
      const content = change === 'replacement' ? [] : [{ kind: 'commandOutput', output: {
        text: change === 'successful Load' || change === 'close/reopen' ? 'Replayed' : 'Original', truncated: false,
      } }];
      expect(manager.sessionState({ configuredName: change === 'rename' ? 'renamed' : 'fake', sessionId: FIRST_SESSION }))
        .toMatchObject({ content: { entries: [{ kind: 'turn', parts: [{ kind: 'toolCalls', toolCalls: [{ content }] }] }] } });
      if (change === 'rename') { expect(manager.sessionState({ configuredName: 'fake', sessionId: FIRST_SESSION })).toBeUndefined(); }
    });

    it('retains cleaned command output and reconstructs it after the webview becomes ready again', async () => {
      const { manager, connections, chatView, posted } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      const connect = connections.connect.bind(connections);
      let sink: import('@/core/acp/AcpDriver').SessionUpdateSink | undefined;
      vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, input, closed) => {
        sink = input;
        return connect(name, streams, id, input, closed);
      });
      await manager.connectToAgent('fake');
      sink?.handleUpdate(FIRST_SESSION, { kind: 'agentMessage', messageId: 'm1', text: 'Starting' }, 'v1');
      await chatView.handleMessage({ type: 'ready' });
      let finishCleaning!: () => void;
      const cleaned = new Promise<void>((resolve) => { finishCleaning = resolve; });
      const stop = manager.onChanged(() => {
        const entries = manager.sessionState({ configuredName: 'fake', sessionId: FIRST_SESSION })?.content.entries;
        if (entries?.some((entry) => entry.kind === 'turn' && entry.parts.some((part) => part.kind === 'toolCalls'
          && part.toolCalls.some((call) => call.content.some((item) => item.kind === 'commandOutput'))))) { finishCleaning(); }
      });
      try {
        sink?.handleUpdate(FIRST_SESSION, { kind: 'toolCall', toolCallId: 'run', toolKind: 'execute', title: 'Run', status: 'running',
          content: [{ kind: 'text', text: '\x1b[32mok\x1b[0m\nDownloading 5%\rDownloading done\n' }] }, 'v1');
        await cleaned;
        const projected = posted.reduce((state, message) => updateView(state, structuredClone(message), 0).state, initialState);
        expect(projected.transcript.entries).toMatchObject([{ kind: 'turn', parts: [
          { kind: 'message', text: 'Starting' },
          { kind: 'toolCalls', toolCalls: [{ toolCallId: 'run', content: [{ kind: 'commandOutput', text: 'ok\nDownloading done', truncated: false }] }] },
        ] }]);
        await chatView.handleMessage({ type: 'ready' });
        const snapshot = contentSnapshots(posted).at(-1);
        expect(snapshot).toMatchObject({ entries: [{ kind: 'turn', parts: [
          { kind: 'message', text: 'Starting' },
          { kind: 'toolCalls', toolCalls: [{ toolCallId: 'run', content: [{ kind: 'commandOutput', text: 'ok\nDownloading done', truncated: false }] }] },
        ] }] });
      } finally { stop(); }
    });

    it('does not suppress a tool call before the replacement owner has a projection', async () => {
      const { manager, connections, chatView, posted } = setup({ fake: sessionAgent(FIRST_SESSION).script, other: sessionAgent(SECOND_SESSION).script });
      const connect = connections.connect.bind(connections);
      const sinks = new Map<string, import('@/core/acp/AcpDriver').SessionUpdateSink>();
      vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, input, closed) => {
        sinks.set(name, input);
        return connect(name, streams, id, input, closed);
      });
      await manager.connectToAgent('fake');
      sinks.get('fake')?.handleUpdate(FIRST_SESSION, { kind: 'agentMessage', messageId: 'm1', text: 'First owner' }, 'v1');
      await chatView.handleMessage({ type: 'ready' });
      await manager.connectToAgent('other');
      chatView.notifyActiveSessionChanged();
      const selected = posted.reduce((state, message) => updateView(state, structuredClone(message), 0).state, initialState);
      posted.splice(0);
      sinks.get('other')?.handleUpdate(SECOND_SESSION, { kind: 'toolCall', toolCallId: 't1', title: 'Read', status: 'running', content: [] }, 'v2');
      const view = posted.reduce((state, message) => updateView(state, structuredClone(message), 0).state, selected);
      expect(view.transcript.entries).toMatchObject([{ kind: 'turn', parts: [{ kind: 'toolCalls', toolCalls: [
        { toolCallId: 't1', title: 'Read', status: 'running', content: [] },
      ] }] }]);
      expect(view.transcript.projection?.target).toMatchObject({ configuredName: 'other', sessionId: SECOND_SESSION });
    });

    it('projects thought timing when completion flushes the final thought chunk', async () => {
      const { manager, connections, chatView, posted } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      const connect = connections.connect.bind(connections);
      let sink: import('@/core/acp/AcpDriver').SessionUpdateSink | undefined;
      vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, input, closed) => {
        sink = input;
        return connect(name, streams, id, input, closed);
      });
      await manager.connectToAgent('fake');
      sink?.handleUpdate(FIRST_SESSION, { kind: 'thoughtText', messageId: 'r1', text: 'First' }, 'v1');
      await chatView.handleMessage({ type: 'ready' });
      let view = posted.reduce((state, message) => updateView(state, structuredClone(message), 0).state, initialState);
      sink?.handleUpdate(FIRST_SESSION, { kind: 'foreground', state: 'running' }, 'v2');
      posted.splice(0);
      sink?.handleUpdate(FIRST_SESSION, { kind: 'thoughtText', messageId: 'r1', text: ' tail' }, 'v1');
      sink?.handleUpdate(FIRST_SESSION, { kind: 'foreground', state: 'idle' }, 'v2');
      view = posted.reduce((state, message) => updateView(state, structuredClone(message), 0).state, view);
      const turn = view.transcript.entries[0];
      if (turn?.kind !== 'turn' || turn.parts[0]?.kind !== 'thought') { throw new Error('Expected projected thought'); }
      expect(turn.parts[0].text).toBe('First tail');
      expect(turn.parts[0].endedAt).not.toBeNull();
      expect(turn.parts[0].open).toBe(false);
    });

    it('flushes projected partial text before foreground completion', async () => {
      const { manager, connections, chatView, posted } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      const connect = connections.connect.bind(connections);
      let sink: import('@/core/acp/AcpDriver').SessionUpdateSink | undefined;
      vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, input, closed) => {
        sink = input;
        return connect(name, streams, id, input, closed);
      });
      await manager.connectToAgent('fake');
      sink?.handleUpdate(FIRST_SESSION, { kind: 'agentMessage', messageId: 'm1', text: 'First' }, 'v1');
      await chatView.handleMessage({ type: 'ready' });
      sink?.handleUpdate(FIRST_SESSION, { kind: 'foreground', state: 'running' }, 'v2');
      posted.splice(0);
      sink?.handleUpdate(FIRST_SESSION, { kind: 'agentText', messageId: 'm1', text: ' tail' }, 'v1');
      sink?.handleUpdate(FIRST_SESSION, { kind: 'foreground', state: 'idle' }, 'v2');
      expect(posted[0]).toMatchObject({ type: 'contentPatch', currentTurn: null, patches: [{ kind: 'appendText', text: ' tail' }] });
      expect(posted[1]).toEqual({ type: 'foregroundActivity', running: false });
    });

    it.each([false, true])('projects committed content after Load settles (success: %s)', async (ok) => {
      let sink: import('@/core/acp/AcpDriver').SessionUpdateSink | undefined;
      const { manager, connections, chatView, posted } = setup({ fake: () => fakeAgent({ agentCapabilities: { loadSession: true } })
        .onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION }))
        .onRequest(methods.agent.session.load, ({ params }) => {
          if (params.sessionId !== FIRST_SESSION) { throw new Error('Unexpected Load target'); }
          sink?.handleUpdate(FIRST_SESSION, { kind: 'agentMessage', messageId: 'm2', text: 'Replayed' }, 'v1');
          if (!ok) { throw RequestError.invalidParams(undefined, 'Replay failed'); }
          return {};
        }),
      });
      const connect = connections.connect.bind(connections);
      vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, input, closed) => {
        sink = input;
        return connect(name, streams, id, input, closed);
      });
      manager.on('active-session-changed', () => chatView.notifyActiveSessionChanged());
      manager.on('session-load-start', (load) => chatView.notifyLoadSessionStart(load));
      manager.on('session-load-end', (load, success) => chatView.notifyLoadSessionEnd(load, success));
      await manager.connectToAgent('fake');
      sink?.handleUpdate(FIRST_SESSION, { kind: 'agentMessage', messageId: 'm1', text: 'Retained' }, 'v1');
      await chatView.handleMessage({ type: 'ready' });
      posted.splice(0);
      await manager.loadSession('fake', FIRST_SESSION).catch((error: unknown) => { if (ok) { throw error; } });
      expect(contentSnapshots(posted).at(-1)).toMatchObject({ entries: [
        { kind: 'turn', parts: [{ kind: 'message', text: ok ? 'Replayed' : 'Retained' }] },
      ] });
      const view = posted.reduce((state, message) => updateView(state, structuredClone(message), 0).state, initialState);
      expect(view.transcript.entries).toMatchObject([{ kind: 'turn', parts: [{ kind: 'message', text: ok ? 'Replayed' : 'Retained' }] }]);
    });

    it('projects the selected owner when two configurations use the same session ID', async () => {
      const { manager, connections, chatView, posted } = setup({ fake: sessionAgent(FIRST_SESSION).script, other: sessionAgent(FIRST_SESSION).script });
      const connect = connections.connect.bind(connections);
      const sinks = new Map<string, import('@/core/acp/AcpDriver').SessionUpdateSink>();
      vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, input, closed) => {
        sinks.set(name, input);
        return connect(name, streams, id, input, closed);
      });
      await manager.connectToAgent('fake');
      sinks.get('fake')?.handleUpdate(FIRST_SESSION, { kind: 'agentMessage', messageId: 'm1', text: 'First owner' }, 'v1');
      await chatView.handleMessage({ type: 'ready' });
      posted.splice(0);
      await manager.connectToAgent('other');
      sinks.get('other')?.handleUpdate(FIRST_SESSION, { kind: 'agentMessage', messageId: 'm1', text: 'Second owner' }, 'v1');
      chatView.notifyActiveSessionChanged();
      expect(contentSnapshots(posted).at(-1)).toMatchObject({
        target: { configuredName: 'other', sessionId: FIRST_SESSION }, entries: [{ kind: 'turn', parts: [{ text: 'Second owner' }] }],
      });
    });

    it('projects rich prompt contraction without duplicating the following turn', async () => {
      const { manager, connections, chatView, posted } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      const connect = connections.connect.bind(connections);
      let sink: import('@/core/acp/AcpDriver').SessionUpdateSink | undefined;
      vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, input, closed) => {
        sink = input;
        return connect(name, streams, id, input, closed);
      });
      await manager.connectToAgent('fake');
      sink?.handleUpdate(FIRST_SESSION, { kind: 'promptRichMessage', messageId: 'p1', content: [
        { kind: 'text', text: 'Before' }, { kind: 'image', data: '', mimeType: 'image/png' }, { kind: 'text', text: 'After' },
      ] }, 'v1');
      sink?.handleUpdate(FIRST_SESSION, { kind: 'agentMessage', messageId: 'm1', text: 'Answer' }, 'v1');
      await chatView.handleMessage({ type: 'ready' });
      let view = posted.reduce((state, message) => updateView(state, structuredClone(message), 0).state, initialState);
      const answer = view.transcript.entries[3];
      posted.splice(0);
      sink?.handleUpdate(FIRST_SESSION, { kind: 'promptRichMessage', messageId: 'p1', content: [{ kind: 'text', text: 'Revised' }] }, 'v1');
      view = posted.reduce((state, message) => updateView(state, structuredClone(message), 0).state, view);
      expect(view.transcript.entries).toEqual([
        { kind: 'prompt', id: 5, messageId: 'p1', text: 'Revised' },
        { kind: 'turn', id: 4, parts: [{ kind: 'message', messageId: 'm1', text: 'Answer' }] },
      ]);
      expect(view.transcript.entries[1]).toBe(answer);
    });

    it('reconstructs retained content on ready and sends only new text during streaming', async () => {
      const { manager, connections, chatView, posted } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      const connect = connections.connect.bind(connections);
      let sink: import('@/core/acp/AcpDriver').SessionUpdateSink | undefined;
      vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, input, closed) => {
        sink = input;
        return connect(name, streams, id, input, closed);
      });
      await manager.connectToAgent('fake');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
      sink?.handleUpdate(FIRST_SESSION, { kind: 'agentText', messageId: 'm1', text: 'Partial' }, 'v1');
      await chatView.handleMessage({ type: 'ready' });
      expect(contentSnapshots(posted).at(-1)).toMatchObject({ entries: [
        { kind: 'turn', parts: [{ kind: 'message', text: 'Partial' }] },
      ] });
      posted.splice(0);
      sink?.handleUpdate(FIRST_SESSION, { kind: 'agentText', messageId: 'm1', text: ' one' }, 'v1');
      await vi.advanceTimersByTimeAsync(8);
      sink?.handleUpdate(FIRST_SESSION, { kind: 'agentText', messageId: 'm1', text: ' two' }, 'v1');
      await vi.advanceTimersByTimeAsync(8);
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({ type: 'contentPatch', patches: [{ kind: 'appendText', text: ' one two' }] });
      } finally { vi.useRealTimers(); }
    });

    it('retains submitted prompts and ends their content turns when submissions settle', async () => {
      const { manager } = setup({ fake: sessionAgent(FIRST_SESSION, (app) => app
        .onRequest(methods.agent.session.prompt, ({ params }) => {
          if (params.sessionId !== FIRST_SESSION) { throw new Error('Wrong prompt target'); }
          return { stopReason: 'end_turn' };
        })).script,
      });
      await manager.connectToAgent('fake');
      await manager.sendPrompt(address(FIRST_SESSION), 'First prompt');
      await manager.sendPrompt(address(FIRST_SESSION), 'Second prompt');
      expect(manager.sessionState({ configuredName: 'fake', sessionId: FIRST_SESSION })).toMatchObject({ content: {
        entries: [{ kind: 'prompt', text: 'First prompt' }, { kind: 'prompt', text: 'Second prompt' }], currentTurn: null,
      } });
    });

    it('retains streamed content and whole-message replacements before projection', async () => {
      const { manager, connections, updates } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      const connect = connections.connect.bind(connections);
      let sink: import('@/core/acp/AcpDriver').SessionUpdateSink | undefined;
      vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, input, closed) => {
        sink = input;
        return connect(name, streams, id, input, closed);
      });
      await manager.connectToAgent('fake');
      const identity = { configuredName: 'fake', sessionId: FIRST_SESSION };
      let observed: unknown;
      updates.addListener(() => { observed = manager.sessionState(identity); });
      sink?.handleUpdate(FIRST_SESSION, { kind: 'agentText', messageId: 'm1', text: 'First' }, 'v1');
      sink?.handleUpdate(FIRST_SESSION, { kind: 'agentText', messageId: 'm1', text: ' partial' }, 'v1');
      expect(observed).toMatchObject({ content: { entries: [
        { kind: 'turn', parts: [{ kind: 'message', messageId: 'm1', text: 'First partial' }] },
      ] } });
      sink?.handleUpdate(FIRST_SESSION, { kind: 'agentText', messageId: 'm2', text: 'Second' }, 'v1');
      sink?.handleUpdate(FIRST_SESSION, { kind: 'agentMessage', messageId: 'm1', text: 'Replacement' }, 'v1');
      expect(manager.sessionState(identity)).toMatchObject({ content: { entries: [
        { kind: 'turn', parts: [
          { kind: 'message', messageId: 'm1', text: 'Replacement' },
          { kind: 'message', messageId: 'm2', text: 'Second' },
        ] },
      ] } });
    });

    it('does not attach usage from a failed Resume when the same connection retries', async () => {
      let sink: import('@/core/acp/AcpDriver').SessionUpdateSink | undefined;
      let attempts = 0;
      const { manager, connections } = setup({ fake: () => fakeAgent({ agentCapabilities: { sessionCapabilities: { resume: {} } } })
        .onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION }))
        .onRequest(methods.agent.session.resume, ({ params }) => {
          if (params.sessionId !== SECOND_SESSION) { throw new Error('Unexpected Resume target'); }
          if (++attempts === 1) {
            sink?.handleUpdate(SECOND_SESSION, { kind: 'usage', used: 999, size: 1000, cost: null }, 'v1');
            throw RequestError.invalidParams(undefined, 'Resume failed');
          }
          return {};
        }),
      });
      const connect = connections.connect.bind(connections);
      vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, input, closed) => {
        sink = input;
        return connect(name, streams, id, input, closed);
      });
      await manager.connectToAgent('fake');
      sink?.handleUpdate(FIRST_SESSION, { kind: 'usage', used: 123, size: 1000, cost: null }, 'v1');

      await expect(manager.resumeSession('fake', SECOND_SESSION)).rejects.toThrow('Resume failed');
      expect(manager.isConnected('fake')).toBe(true);
      expect(manager.sessionState({ configuredName: 'fake', sessionId: SECOND_SESSION })).toBeUndefined();
      await manager.resumeSession('fake', SECOND_SESSION);

      expect(manager.sessionState({ configuredName: 'fake', sessionId: SECOND_SESSION })?.usage).toBeNull();
      expect(manager.sessionState({ configuredName: 'fake', sessionId: FIRST_SESSION })?.usage).toEqual({ used: 123, size: 1000, cost: null });
    });

    it.each([false, true])('attaches early usage only after successful registration (opening fails: %s)', async (fails) => {
      let sink: import('@/core/acp/AcpDriver').SessionUpdateSink | undefined;
      let enter: () => void = () => {};
      let finish: () => void = () => {};
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const finished = new Promise<void>((resolve) => { finish = resolve; });
      const { manager, connections } = setup({ fake: () => fakeAgent()
        .onRequest(methods.agent.session.new, async () => {
          sink?.handleUpdate(FIRST_SESSION, { kind: 'usage', used: 321, size: 1000, cost: null }, 'v1');
          enter();
          await finished;
          if (fails) { throw RequestError.invalidParams(undefined, 'Opening failed'); }
          return { sessionId: FIRST_SESSION };
        }),
      });
      const connect = connections.connect.bind(connections);
      vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, input, closed) => {
        sink = input;
        return connect(name, streams, id, input, closed);
      });
      const identity = { configuredName: 'fake', sessionId: FIRST_SESSION };
      const opening = manager.connectToAgent('fake').then(() => 'ok', () => 'failed');
      try {
        await entered;
        expect(manager.sessionState(identity)).toBeUndefined();
      } finally { finish(); await opening; }

      expect(await opening).toBe(fails ? 'failed' : 'ok');
      expect(manager.sessionState(identity)?.usage).toEqual(fails ? undefined : { used: 321, size: 1000, cost: null });
    });

    it.each(['failed', 'replaced', 'cleared'] as const)('keeps usage committed until Load finishes: %s', async (outcome) => {
      let sink: import('@/core/acp/AcpDriver').SessionUpdateSink | undefined;
      let enter: () => void = () => {};
      let finish: () => void = () => {};
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const finished = new Promise<void>((resolve) => { finish = resolve; });
      const { manager, connections } = setup({ fake: () => fakeAgent({ agentCapabilities: { loadSession: true } })
        .onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION }))
        .onRequest(methods.agent.session.load, async () => {
          if (outcome !== 'cleared') {
            sink?.handleUpdate(FIRST_SESSION, { kind: 'usage', used: 456, size: 2000, cost: null }, 'v1');
          }
          enter();
          await finished;
          if (outcome === 'failed') { throw RequestError.invalidParams(undefined, 'Replay failed'); }
          return {};
        }),
      });
      const connect = connections.connect.bind(connections);
      vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, input, closed) => {
        sink = input;
        return connect(name, streams, id, input, closed);
      });
      await manager.connectToAgent('fake');
      sink?.handleUpdate(FIRST_SESSION, { kind: 'usage', used: 123, size: 1000, cost: null }, 'v1');
      const identity = { configuredName: 'fake', sessionId: FIRST_SESSION };
      const loading = manager.loadSession('fake', FIRST_SESSION);
      const result = loading.then(() => 'ok', () => 'failed');
      try {
        await entered;
        expect(manager.sessionState(identity)?.usage).toEqual({ used: 123, size: 1000, cost: null });
      } finally { finish(); await result; }

      expect(await result).toBe(outcome === 'failed' ? 'failed' : 'ok');
      expect(manager.sessionState(identity)?.usage).toEqual(outcome === 'failed'
        ? { used: 123, size: 1000, cost: null }
        : outcome === 'replaced' ? { used: 456, size: 2000, cost: null } : null);
    });

    it('keeps retained usage separate for equal session IDs across configurations', async () => {
      const { manager, connections } = setup({
        fake: sessionAgent(FIRST_SESSION).script,
        other: sessionAgent(FIRST_SESSION).script,
      });
      const connect = connections.connect.bind(connections);
      const sinks = new Map<string, import('@/core/acp/AcpDriver').SessionUpdateSink>();
      vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, input, closed) => {
        sinks.set(name, input);
        return connect(name, streams, id, input, closed);
      });
      await manager.connectToAgent('fake');
      sinks.get('fake')?.handleUpdate(FIRST_SESSION, { kind: 'usage', used: 123, size: 1000, cost: null }, 'v1');
      await manager.connectToAgent('other');
      sinks.get('other')?.handleUpdate(FIRST_SESSION, { kind: 'usage', used: 456, size: 2000, cost: null }, 'v1');

      expect(manager.sessionState({ configuredName: 'fake', sessionId: FIRST_SESSION })?.usage).toEqual({ used: 123, size: 1000, cost: null });
      expect(manager.sessionState({ configuredName: 'other', sessionId: FIRST_SESSION })?.usage).toEqual({ used: 456, size: 2000, cost: null });
      manager.agentsChanged({ fake: { command: 'fake' }, other: { command: 'other' } }, { renamed: { command: 'fake' }, other: { command: 'other' } });
      expect(manager.sessionState({ configuredName: 'fake', sessionId: FIRST_SESSION })).toBeUndefined();
      expect(manager.sessionState({ configuredName: 'renamed', sessionId: FIRST_SESSION })?.usage).toEqual({ used: 123, size: 1000, cost: null });
      expect(manager.sessionState({ configuredName: 'other', sessionId: FIRST_SESSION })?.usage).toEqual({ used: 456, size: 2000, cost: null });
    });

    it('projects retained usage when the webview becomes ready without another agent update', async () => {
      const { manager, connections, chatView, posted, updates } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      const connect = connections.connect.bind(connections);
      let sink: import('@/core/acp/AcpDriver').SessionUpdateSink | undefined;
      vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, input, closed) => {
        sink = input;
        return connect(name, streams, id, input, closed);
      });
      await manager.connectToAgent('fake');
      const observed: unknown[] = [];
      updates.addListener(() => observed.push(manager.sessionState({ configuredName: 'fake', sessionId: FIRST_SESSION })?.usage));
      sink?.handleUpdate(FIRST_SESSION, { kind: 'usage', used: 123, size: 1000, cost: { amount: 0.25, currency: 'USD' } }, 'v2');
      expect(observed).toEqual([{ used: 123, size: 1000, cost: { amount: 0.25, currency: 'USD' } }]);
      posted.splice(0);

      await chatView.handleMessage({ type: 'ready' });

      expect(contentSnapshots(posted).at(-1)?.usage).toEqual({ used: 123, size: 1000, cost: { amount: 0.25, currency: 'USD' } });
      await manager.disconnectAgent('fake');
      sink?.handleUpdate(FIRST_SESSION, { kind: 'usage', used: 999, size: 1000, cost: null }, 'v2');
      expect(manager.sessionState({ configuredName: 'fake', sessionId: FIRST_SESSION })?.usage).toEqual({
        used: 123, size: 1000, cost: { amount: 0.25, currency: 'USD' },
      });
    });

    it('rejects normalized input captured from a retired connection before global fan-out', async () => {
      const { manager, connections, updates, received } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      const connect = connections.connect.bind(connections);
      let sink: import('@/core/acp/AcpDriver').SessionUpdateSink | undefined;
      vi.spyOn(connections, 'connect').mockImplementation((name, streams, id, input, closed) => {
        sink = input;
        return connect(name, streams, id, input, closed);
      });
      const registration = await manager.connectToAgent('fake');
      const projected: unknown[] = [];
      updates.addListener((delivery) => projected.push(delivery));
      sink?.handleUpdate(FIRST_SESSION, { kind: 'agentText', messageId: null, text: 'accepted' }, 'v1');
      expect(projected).toHaveLength(1);
      expect(received).toEqual([[FIRST_SESSION, { kind: 'agentText', messageId: null, text: 'accepted' }]]);
      await manager.disconnectAgent('fake');
      sink?.handleUpdate(FIRST_SESSION, { kind: 'configOptions', options: [modelConfig('b')] }, 'v1');
      expect(projected).toHaveLength(1);
      expect(received).toHaveLength(1);
      expect(registration.configOptions).toEqual([modelConfig('a')]);
    });

    it('qualifies equal-ID V1/V2 review evidence through actual connections and runtime before fan-out', async () => {
      const { manager, updates, receivedAtLeast } = setup({
        fake: () => fakeAgent({ agentCapabilities: { sessionCapabilities: { list: {} } } })
          .onRequest(methods.agent.session.list, async ({ client }) => {
            await client.notify(methods.client.session.update, { sessionId: FIRST_SESSION, update: {
              sessionUpdate: 'tool_call', toolCallId: 'same', title: 'Edit', status: 'completed',
              content: [{ type: 'diff', path: '/w/a.ts', oldText: 'a', newText: 'A' }],
            } });
            return { sessions: [] };
          }),
        other: () => fakeV2Agent().onRequest(V2.methods.agent.session.list, async ({ client }) => {
          const update: V2.UpdateSessionNotification['update'] = {
            sessionUpdate: 'tool_call_update', toolCallId: 'same', title: 'Edit', status: 'completed',
            content: [{ type: 'diff', changes: [{ operation: 'modify', path: '/w/b.ts', fileType: 'text' }],
              patch: { format: 'git_patch', text: 'diff --git /w/b.ts /w/b.ts\n--- /w/b.ts\n+++ /w/b.ts\n@@ -1 +1 @@\n-b\n+B\n' } }],
          };
          await client.notify(V2.methods.client.session.update, { sessionId: FIRST_SESSION, update });
          return { sessions: [] };
        }),
      });
      const reviews = new Reviews({ read: async (path) => path === '/w/a.ts' ? 'A' : 'B\n', restore: async () => {}, watch: () => ({ dispose() {} }), snapshot: () => undefined,
        applyEdit: async () => { throw new Error('Unexpected edit'); }, save: async () => { throw new Error('Unexpected save'); },
      }, manager);
      onTestFinished(() => reviews.dispose());
      const taking: Promise<void>[] = [];
      const origins: { configuredName: string; sourceId: string; schema: string }[] = [];
      updates.addListener(({ input, registration }) => {
        expect(registration).toBeUndefined();
        origins.push({ configuredName: input.origin.identity.configuredName, sourceId: input.origin.sourceId, schema: input.schema });
        taking.push(reviews.handleSessionUpdate(input));
      });
      const received = receivedAtLeast(2);
      await manager.listSessions('fake');
      await manager.listSessions('other');
      await received;
      await Promise.all(taking);
      expect(origins.map(({ configuredName, schema }) => [configuredName, schema])).toEqual([['fake', 'v1'], ['other', 'v2']]);
      expect(origins[0]?.sourceId).not.toBe(origins[1]?.sourceId);
      reviews.activeSessionChanged({ sessionId: FIRST_SESSION, agentName: 'fake', agentId: origins[0]?.sourceId ?? '' });
      expect(reviews.shown()?.files().map(({ path }) => path)).toEqual(['/w/a.ts']);
      reviews.activeSessionChanged({ sessionId: FIRST_SESSION, agentName: 'other', agentId: origins[1]?.sourceId ?? '' });
      expect(reviews.shown()?.files().map(({ path }) => path)).toEqual(['/w/b.ts']);
    });

    it('keeps an early mode and explicit title clearing until its source registers', async () => {
      const { manager, receivedAtLeast, references } = setup({ fake: () => fakeAgent()
        .onRequest(methods.agent.session.new, async ({ client }) => {
          await client.notify(methods.client.session.update, { sessionId: FIRST_SESSION, update: { sessionUpdate: 'current_mode_update', currentModeId: 'code' } });
          await client.notify(methods.client.session.update, { sessionId: FIRST_SESSION, update: { sessionUpdate: 'session_info_update', title: null } });
          return { sessionId: FIRST_SESSION, modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }] } };
        }) });
      await references.used(address(FIRST_SESSION));
      await references.setTitle(address(FIRST_SESSION), 'Remembered title');
      const received = receivedAtLeast(2);
      const session = await manager.connectToAgent('fake');
      await received;
      expect(session.modes?.current).toBe('code');
      expect(session.title).toBeUndefined();
    });

    it('does not publish obsolete load completion into a replacement registration', async () => {
      let enter: () => void = () => {};
      let release: () => void = () => {};
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let loads = 0;
      const { manager, posted, chatView } = setup({ fake: () => fakeAgent({ agentCapabilities: { loadSession: true } })
        .onRequest(methods.agent.session.load, async () => {
          if (++loads === 1) { enter(); await gate; }
          return {};
        }) });
      manager.on('session-load-start', (load) => chatView.notifyLoadSessionStart(load));
      manager.on('session-load-end', (load, ok) => chatView.notifyLoadSessionEnd(load, ok));
      const opening = manager.loadSession('fake', FIRST_SESSION).catch(() => undefined);
      try {
        await entered;
        await manager.loadSession('fake', FIRST_SESSION);
        posted.splice(0);
      } finally { release(); }
      await opening;
      expect(posted).toEqual([]);
    });

    it.each(['before', 'after'] as const)('keeps early metadata and activity source-local when the other source registers %s delivery', async (order) => {
      let earlyClient!: V2.AgentContext;
      const option = (currentValue: string): V2.SessionConfigOption => ({
        configId: 'model', name: 'Model', category: 'model', type: 'select', currentValue,
        options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }],
      });
      const { manager, receivedAtLeast } = setup({
        fake: sessionAgent(FIRST_SESSION).script,
        other: () => fakeV2Agent()
          .onRequest(V2.methods.agent.session.list, ({ client }) => { earlyClient = client; return { sessions: [] }; })
          .onRequest(V2.methods.agent.session.new, () => ({ sessionId: FIRST_SESSION, configOptions: [option('a')] })),
      });
      await manager.listSessions('other');
      const selected = order === 'before' ? await manager.connectToAgent('fake') : undefined;
      const received = receivedAtLeast(4);
      for (const update of [
        { sessionUpdate: 'config_option_update', configOptions: [option('b')] },
        { sessionUpdate: 'available_commands_update', availableCommands: [{ type: 'command', name: 'other', description: 'Other' }] },
        { sessionUpdate: 'session_info_update', title: 'Other title' },
        { sessionUpdate: 'state_update', state: 'running' },
      ] satisfies V2.UpdateSessionNotification['update'][]) {
        await earlyClient.notify(V2.methods.client.session.update, { sessionId: FIRST_SESSION, update });
      }
      await received;
      const first = selected ?? await manager.connectToAgent('fake');
      expect(first.configOptions).toEqual([modelConfig('a')]);
      expect(first.availableCommands).toEqual([]);
      expect(first.title).toBeUndefined();
      expect(manager.hasForegroundWork(address(FIRST_SESSION))).toBe(false);

      await manager.disconnectAgent('fake');
      const other = await manager.connectToAgent('other');
      expect(other.configOptions).toEqual([modelConfig('b')]);
      expect(other.availableCommands).toEqual([{ name: 'other', description: 'Other', takesInput: false, hint: null }]);
      expect(other.title).toBe('Other title');
      expect(manager.hasForegroundWork({ configuredName: 'other', sessionId: FIRST_SESSION })).toBe(true);
    });

    it('does not apply another accepting source metadata to the selected session with the same ID', async () => {
      let client!: AgentContext;
      const { manager, receivedAtLeast } = setup({
        fake: sessionAgent(FIRST_SESSION).script,
        other: () => fakeAgent({ agentCapabilities: { sessionCapabilities: { list: {} } } }).onRequest(methods.agent.session.list, ({ client: connected }) => {
          client = connected;
          return { sessions: [] };
        }),
      });
      const session = await manager.connectToAgent('fake');
      await manager.ensureConnected('other');
      await manager.listSessions('other');
      const received = receivedAtLeast(1);
      await client.notify(methods.client.session.update, {
        sessionId: FIRST_SESSION, update: { sessionUpdate: 'config_option_update', configOptions: [modelOption('b')] },
      });
      await received;
      expect(session.configOptions).toEqual([modelConfig('a')]);
    });

    it('applies metadata once before dispatch even when no controller receives the update', async () => {
      let client!: AgentContext;
      const { manager, receivedAtLeast, updates } = setup({
        fake: () => fakeAgent().onRequest(methods.agent.session.new, ({ client: connected }) => {
          client = connected;
          return { sessionId: FIRST_SESSION };
        }),
      });
      const session = await manager.connectToAgent('fake');
      const seen: unknown[] = [];
      const applying = vi.spyOn(manager, 'applyConfigOptions');
      updates.addListener(({ registration }) => {
        expect(registration).toBe(session);
        seen.push(session.configOptions);
      });
      const received = receivedAtLeast(1);
      await client.notify(methods.client.session.update, {
        sessionId: FIRST_SESSION, update: { sessionUpdate: 'config_option_update', configOptions: [modelOption('b')] },
      });
      await received;
      expect(session.configOptions).toEqual([modelConfig('b')]);
      expect(seen).toEqual([[modelConfig('b')]]);
      expect(applying).not.toHaveBeenCalled();
    });

    it('reports an unregistered source title with its captured owner rather than the current raw-ID occupant', async () => {
      let client!: AgentContext;
      const { manager, receivedAtLeast, agents } = setup({
        fake: sessionAgent(FIRST_SESSION).script,
        other: () => fakeAgent({ agentCapabilities: { sessionCapabilities: { list: {} } } })
          .onRequest(methods.agent.session.list, ({ client: connected }) => { client = connected; return { sessions: [] }; }),
      });
      const selected = await manager.connectToAgent('fake');
      await manager.listSessions('other');
      const reports: unknown[][] = [];
      manager.on('session-info-changed', (...args) => reports.push(args));
      const received = receivedAtLeast(1);
      await client.notify(methods.client.session.update, {
        sessionId: FIRST_SESSION, update: { sessionUpdate: 'session_info_update', title: 'Other title' },
      });
      await received;
      expect(selected.title).toBeUndefined();
      expect(reports).toEqual([[{
        identity: { configuredName: 'other', sessionId: FIRST_SESSION },
        sourceId: agents.running('other')[0]?.process.id,
      }, { kind: 'sessionInfo', title: 'Other title' }]]);
      expect(reports[0]?.[0]).not.toHaveProperty('sourceId', selected.agentId);
    });

    it('keeps slash commands, config options and a title that arrive while the session is being created', async () => {
      const script: AgentScript = () => fakeAgent().onRequest(methods.agent.session.new, async ({ client }) => {
        const notify = (update: SessionNotification['update']) =>
          client.notify(methods.client.session.update, { sessionId: FIRST_SESSION, update });
        await notify({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'init', description: 'Init' }] });
        await notify({ sessionUpdate: 'config_option_update', configOptions: [modelOption('b')] });
        await notify({ sessionUpdate: 'session_info_update', title: 'Early title' });
        return { sessionId: FIRST_SESSION, configOptions: [modelOption('a')] };
      });
      const { manager, received, receivedAtLeast } = setup({ fake: script });
      const updatesReceived = receivedAtLeast(3);

      const session = await manager.connectToAgent('fake');
      await updatesReceived;

      expect(received).toHaveLength(3);
      expect(session.availableCommands).toEqual([{ name: 'init', description: 'Init', takesInput: false, hint: null }]);
      expect(session.configOptions).toEqual([modelConfig('b')]);
      expect(session.title).toBe('Early title');
    });

    it.each([
      ['creating', (manager: SessionManager) => manager.connectToAgent('fake')],
      ['resuming', (manager: SessionManager) => manager.resumeSession('fake', FIRST_SESSION)],
      ['loading', (manager: SessionManager) => manager.loadSession('fake', FIRST_SESSION)],
    ])('takes the slash commands a v2 session state carries, on %s the session', async (_, open) => {
      const availableCommands: V2.AvailableCommand[] = [{ type: 'command', name: 'init', description: 'Init' }];
      const script: AgentScript = () => fakeV2Agent()
        .onRequest(V2.methods.agent.session.new, () => ({ sessionId: FIRST_SESSION, availableCommands }))
        .onRequest(V2.methods.agent.session.resume, () => ({ availableCommands }));
      const { manager } = setup({ fake: script });

      const session = await open(manager);

      expect(session.availableCommands).toEqual([{ name: 'init', description: 'Init', takesInput: false, hint: null }]);
    });

    it('treats null config options in an update as none', async () => {
      const fake = sessionAgent(FIRST_SESSION, (app) => app.onRequest(methods.agent.session.prompt, async ({ client }) => {
        const update = { sessionUpdate: 'config_option_update', configOptions: null } as unknown as SessionNotification['update'];
        await client.notify(methods.client.session.update, { sessionId: FIRST_SESSION, update });
        return { stopReason: 'end_turn' };
      }));
      const { manager, received, receivedAtLeast } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');
      const updated = receivedAtLeast(received.length + 1);

      await manager.sendPrompt(address(FIRST_SESSION), 'hello');
      await updated;

      expect(manager.getSession(address(FIRST_SESSION))?.configOptions).toEqual([]);
    });

    it("caches titles in the session's reference and clears them on null", async () => {
      const { manager, reference } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      await manager.connectToAgent('fake');

      manager.applySessionInfoUpdate(address(FIRST_SESSION), { title: 'Named' });
      expect(manager.getSession(address(FIRST_SESSION))?.title).toBe('Named');
      expect(reference(FIRST_SESSION)?.title).toBe('Named');

      manager.applySessionInfoUpdate(address(FIRST_SESSION), { updatedAt: '2026-10-18T10:00:00Z' });
      expect(reference(FIRST_SESSION)?.title).toBe('Named');

      manager.applySessionInfoUpdate(address(FIRST_SESSION), { title: null });
      expect(manager.getSession(address(FIRST_SESSION))).not.toHaveProperty('title');
      expect(reference(FIRST_SESSION)).not.toHaveProperty('title');
    });

    it('records the mode the agent switches to itself', async () => {
      const script: AgentScript = () => fakeAgent().onRequest(methods.agent.session.new, () => ({
        sessionId: FIRST_SESSION,
        modes: { availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }], currentModeId: 'ask' },
      }));
      const { manager } = setup({ fake: script });
      await manager.connectToAgent('fake');

      manager.applyCurrentMode(address(FIRST_SESSION), 'code');

      expect(manager.getSession(address(FIRST_SESSION))?.modes?.current).toBe('code');
    });

    it('moves the session to the top of the session history when a turn ends', async () => {
      vi.useFakeTimers({ now: Date.parse('2026-10-18T10:00:00Z'), toFake: ['Date'] });
      try {
        const fake = sessionAgent(FIRST_SESSION, (app) => app.onRequest(methods.agent.session.prompt, () => ({ stopReason: 'end_turn' })));
        const { manager, chatView, references, posted } = setup({ fake: fake.script });
        await manager.connectToAgent('fake');
        vi.setSystemTime(Date.parse('2026-10-18T11:00:00Z'));
        await references.used(address(OLDER_SESSION));
        vi.setSystemTime(Date.parse('2026-10-18T12:00:00Z'));

        await chatView.handleMessage({ type: 'ready' });
        await chatView.handleMessage({ type: 'sendPrompt', target: promptTarget(posted), text: 'hello' });

        expect(references.list(WORKSPACE.host, 'fake', '/work').map((r) => r.sessionId)).toEqual([FIRST_SESSION, OLDER_SESSION]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('selections', () => {
    const effortOption = (currentValue: string): SessionConfigOption => ({
      id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue,
      options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }],
    });
    const fastOption = (currentValue: boolean): SessionConfigOption => ({ id: 'fast', name: 'Fast', type: 'boolean', currentValue });
    const modes = (currentModeId: string) => ({ availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }], currentModeId });
    const caps = { agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } };

    /**
     * An agent whose sessions start with model `a`, effort `low` and a boolean option off. Setting the model
     * to `b` resets the effort to `medium`. A prompt makes it change the effort and the boolean option itself. A load
     * replays two model changes, then answers with model `b`; a resume answers with model `b`.
     */
    function selectingAgent(sessionIds: readonly string[] = []) {
      let created = 0;
      const defaults = { model: 'a', effort: 'low', fast: false };
      const options = { ...defaults };
      const all = () => [modelOption(options.model), effortOption(options.effort), fastOption(options.fast)];
      const script: AgentScript = () => fakeAgent(caps)
        .onRequest(methods.agent.session.new, () => {
          Object.assign(options, defaults);
          return { sessionId: sessionIds[created++] ?? randomUUID(), configOptions: all() };
        })
        .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
          if (params.configId === 'model') {
            options.model = String(params.value);
            if (options.model === 'b') { options.effort = 'medium'; }
          }
          return { configOptions: all() };
        })
        .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
          await client.notify(methods.client.session.update, {
            sessionId: params.sessionId,
            update: { sessionUpdate: 'config_option_update', configOptions: [modelOption(options.model), effortOption('medium'), fastOption(true)] },
          });
          return { stopReason: 'end_turn' };
        })
        .onRequest(methods.agent.session.load, async ({ params, client }) => {
          const notify = (update: SessionNotification['update']) => client.notify(methods.client.session.update, { sessionId: params.sessionId, update });
          await notify({ sessionUpdate: 'config_option_update', configOptions: [modelOption('a')] });
          await notify({ sessionUpdate: 'config_option_update', configOptions: [modelOption('b')] });
          return { configOptions: [modelOption('b')] };
        })
        .onRequest(methods.agent.session.resume, () => ({ configOptions: [modelOption('b')] }));
      return script;
    }

    /**
     * An agent using the separate modes API and no config options, whose sessions start in mode `ask`. A prompt
     * makes it switch to `ask` itself; a load replays a switch to `code`, then answers in mode `code`.
     */
    function modesAgent(sessionId?: string) {
      const script: AgentScript = () => fakeAgent(caps)
        .onRequest(methods.agent.session.new, () => ({ sessionId: sessionId ?? randomUUID(), modes: modes('ask') }))
        .onRequest(methods.agent.session.setMode, () => ({}))
        .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
          await client.notify(methods.client.session.update, {
            sessionId: params.sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: 'ask' },
          });
          return { stopReason: 'end_turn' };
        })
        .onRequest(methods.agent.session.load, async ({ params, client }) => {
          await client.notify(methods.client.session.update, {
            sessionId: params.sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: 'code' },
          });
          return { modes: modes('code') };
        });
      return script;
    }

    it('starts distinct mode sessions across process replacement', async () => {
      const { manager } = setup({ fake: modesAgent() });
      const first = await manager.connectToAgent('fake');
      const second = await manager.newSession();
      expect(second).toBeDefined();
      expect(second?.sessionId).not.toBe(first.sessionId);
      expect(second?.modes?.current).toBe('ask');
    });

    it('saves every option as the agent answers the user, with the changes it brings about', async () => {
      const { manager, reference } = setup({ fake: selectingAgent([FIRST_SESSION]) });
      await manager.connectToAgent('fake');

      await manager.setConfigOption(address(FIRST_SESSION), 'model', 'b');

      expect(reference(FIRST_SESSION)?.selections).toEqual({ options: { model: 'b', effort: 'medium', fast: false } });
    });

    it('saves what the agent answers, not the value asked for', async () => {
      const fake = sessionAgent(FIRST_SESSION, (app) => app.onRequest(methods.agent.session.setConfigOption, () => ({ configOptions: [modelOption('a')] })));
      const { manager, reference } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');

      await manager.setConfigOption(address(FIRST_SESSION), 'model', 'b');

      expect(reference(FIRST_SESSION)?.selections).toEqual({ options: { model: 'a' } });
    });

    it('saves nothing for a change still pending, nor for one the agent rejects', async () => {
      let received: () => void = () => {};
      const requested = new Promise<void>((resolve) => { received = resolve; });
      let answer: () => void = () => {};
      const answered = new Promise<void>((resolve) => { answer = resolve; });
      const fake = sessionAgent(FIRST_SESSION, (app) => app.onRequest(methods.agent.session.setConfigOption, async () => {
        received();
        await answered;
        throw RequestError.invalidParams(undefined, 'unknown value');
      }));
      const { manager, reference } = setup({ fake: fake.script });
      await manager.connectToAgent('fake');

      const setting = manager.setConfigOption(address(FIRST_SESSION), 'model', 'b');
      await requested;
      expect(reference(FIRST_SESSION)?.selections).toEqual({ options: {} });
      answer();

      await expect(setting).rejects.toThrow('unknown value');
      expect(reference(FIRST_SESSION)?.selections).toEqual({ options: {} });
    });

    it('saves every option when the agent changes them itself', async () => {
      const { manager, reference, received, receivedAtLeast } = setup({ fake: selectingAgent([FIRST_SESSION]) });
      await manager.connectToAgent('fake');
      const reported = receivedAtLeast(received.length + 1);

      await manager.sendPrompt(address(FIRST_SESSION), 'hello');
      await reported;

      expect(reference(FIRST_SESSION)?.selections).toEqual({ options: { model: 'a', effort: 'medium', fast: true } });
    });

    it('saves the mode of an agent using the modes API as the user sets it, then as the agent switches it', async () => {
      const { manager, reference, received, receivedAtLeast } = setup({ fake: modesAgent(FIRST_SESSION) });
      await manager.connectToAgent('fake');

      await manager.setMode(address(FIRST_SESSION), 'code');
      expect(reference(FIRST_SESSION)?.selections).toEqual({ modeId: 'code', options: {} });

      const reported = receivedAtLeast(received.length + 1);
      await manager.sendPrompt(address(FIRST_SESSION), 'hello');
      await reported;
      expect(reference(FIRST_SESSION)?.selections).toEqual({ modeId: 'ask', options: {} });
    });

    it('saves nothing from the state a session is created with, nor from updates while it is created', async () => {
      const script: AgentScript = () => fakeAgent().onRequest(methods.agent.session.new, async ({ client }) => {
        const update = (configOptions: SessionConfigOption[]) => client.notify(methods.client.session.update, {
          sessionId: FIRST_SESSION, update: { sessionUpdate: 'config_option_update', configOptions },
        });
        await update([modelOption('a')]);
        await update([modelOption('b')]);
        return { sessionId: FIRST_SESSION, configOptions: [modelOption('b')], modes: modes('ask') };
      });
      const { manager, reference, receivedAtLeast } = setup({ fake: script });
      const updated = receivedAtLeast(2);

      await manager.connectToAgent('fake');
      await updated;

      expect(reference(FIRST_SESSION)?.selections).toEqual({ options: {} });
    });

    it('starts a new session with the selections its agent supplies, not those saved for another', async () => {
      const { manager, reference } = setup({ fake: selectingAgent([FIRST_SESSION, SECOND_SESSION]) });
      await manager.connectToAgent('fake');
      await manager.setConfigOption(address(FIRST_SESSION), 'model', 'b');

      const created = await manager.newSession();

      expect(created?.sessionId).toBe(SECOND_SESSION);
      expect(reference(SECOND_SESSION)?.selections).toEqual({ options: {} });
      expect(created?.configOptions?.find((option) => option.id === 'model')?.current).toBe('a');
    });

    it('saves no mode for a session with config options, as they replace its modes', async () => {
      const script: AgentScript = () => fakeAgent()
        .onRequest(methods.agent.session.new, () => ({ sessionId: FIRST_SESSION, configOptions: [modelOption('a')], modes: modes('ask') }));
      const { manager, reference } = setup({ fake: script });
      await manager.connectToAgent('fake');

      manager.applyCurrentMode(address(FIRST_SESSION), 'code');

      expect(reference(FIRST_SESSION)?.selections).toEqual({ options: { model: 'a' } });
    });

    it('keeps what was saved for a session when it is loaded or resumed, saving nothing it opens with or replays', async () => {
      const { manager, reference, references } = setup({ fake: selectingAgent() });
      const saved = { options: { model: 'a', effort: 'low' } };
      for (const sessionId of [LOADED_SESSION, RESUMED_SESSION]) {
        await references.saveSelections(address(sessionId), saved);
      }

      await manager.loadSession('fake', LOADED_SESSION);
      await manager.resumeSession('fake', RESUMED_SESSION);

      expect(reference(LOADED_SESSION)?.selections).toEqual(saved);
      expect(reference(RESUMED_SESSION)?.selections).toEqual(saved);
    });

    it('keeps the mode saved for a session of an agent using the modes API when it is loaded', async () => {
      const { manager, reference, references } = setup({ fake: modesAgent() });
      await references.saveSelections(address(LOADED_SESSION), { modeId: 'ask', options: {} });

      await manager.loadSession('fake', LOADED_SESSION);

      expect(reference(LOADED_SESSION)?.selections).toEqual({ modeId: 'ask', options: {} });
    });

    it('saves the changes the agent makes once a loaded session has opened', async () => {
      const { manager, reference } = setup({ fake: selectingAgent() });
      await manager.loadSession('fake', LOADED_SESSION);

      manager.applyConfigOptions(address(LOADED_SESSION), [modelConfig('a')]);

      expect(reference(LOADED_SESSION)?.selections).toEqual({ options: { model: 'a' } });
    });

    describe('reapplied after a load or resume', () => {
      it.each(['load', 'resume'] as const)('stops an obsolete %s after a saved-option reply without retargeting the replacement', async (how) => {
        let enter: () => void = () => {};
        let release: () => void = () => {};
        const entered = new Promise<void>((resolve) => { enter = resolve; });
        const released = new Promise<void>((resolve) => { release = resolve; });
        const requests: string[] = [];
        let openings = 0;
        const initial = [modelOption('a'), fastOption(false)];
        const restored = [modelOption('b'), fastOption(true)];
        const open = () => ({ configOptions: ++openings === 1 ? initial : restored });
        const script: AgentScript = () => fakeAgent(caps)
          .onRequest(methods.agent.session.load, open)
          .onRequest(methods.agent.session.resume, open)
          .onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
            requests.push(params.configId);
            if (params.configId === 'model') {
              enter();
              await released;
            }
            return { configOptions: [modelOption('b'), fastOption(false)] };
          });
        const { manager, references, reference, takeEvents } = setup({ fake: script });
        const saved = { options: { model: 'b', fast: true } };
        await references.saveSelections(address(FIRST_SESSION), saved);
        let load: SessionLoad | undefined;
        manager.once('session-load-start', (started) => { load = started; });
        const opening = how === 'load'
          ? manager.loadSession('fake', FIRST_SESSION)
          : manager.resumeSession('fake', FIRST_SESSION);
        const result = opening.then(() => 'opened', () => 'rejected');
        let replacement;
        try {
          await entered;
          replacement = await manager.resumeSession('fake', FIRST_SESSION);
          takeEvents();
        } finally {
          release();
        }

        expect(await result).toBe('rejected');
        expect(requests).toEqual(['model']);
        expect(manager.getActiveSession()).toBe(replacement);
        expect(manager.openSessionOf('fake')).toBe(replacement);
        expect(replacement.configOptions?.map((option) => option.current)).toEqual(['b', true]);
        expect(reference(FIRST_SESSION)?.selections).toEqual(saved);
        expect(takeEvents()).toEqual(how === 'load' ? [['session-load-end', load, false]] : []);
      });

      const select = (id: string, category: 'mode' | 'model' | 'thought_level', currentValue: string, values: string[]): SessionConfigOption => ({
        id, name: id, category, type: 'select', currentValue, options: values.map((value) => ({ value, name: value })),
      });

      /**
       * An agent whose sessions load with, in this order, effort `low`, a boolean option `fast` off, model `a` and mode
       * `ask`. Setting the model to `b` resets the effort to `medium` and offers effort `high` as well. `answer` makes it
       * reject the first request for an option, or answer it without changing anything; it sets the option when asked
       * again, so requesting an option twice shows instead of repeating forever.
       */
      function reapplyingAgent(answer: (configId: string) => 'reject' | 'ignore' | undefined = () => undefined) {
        const requests: [string, string | boolean][] = [];
        const script: AgentScript = () => {
          const state: Record<string, string | boolean> = { effort: 'low', fast: false, model: 'a', mode: 'ask' };
          const all = (): SessionConfigOption[] => [
            select('effort', 'thought_level', String(state['effort']), state['model'] === 'b' ? ['low', 'medium', 'high'] : ['low', 'medium']),
            { id: 'fast', name: 'Fast', type: 'boolean', currentValue: state['fast'] === true },
            select('model', 'model', String(state['model']), ['a', 'b']),
            select('mode', 'mode', String(state['mode']), ['ask', 'code']),
          ];
          return fakeAgent(caps)
            .onRequest(methods.agent.session.load, () => ({ configOptions: all() }))
            .onRequest(methods.agent.session.resume, () => ({ configOptions: all() }))
            .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
              const again = requests.some(([configId]) => configId === params.configId);
              requests.push([params.configId, params.value]);
              const how = again ? undefined : answer(params.configId);
              if (how === 'reject') { throw RequestError.invalidParams(undefined, 'unknown value'); }
              if (how !== 'ignore') {
                state[params.configId] = params.value;
                if (params.configId === 'model' && params.value === 'b') { state['effort'] = 'medium'; }
              }
              return { configOptions: all() };
            });
        };
        return { script, requests };
      }

      /** The session's options as displayed, by ID. */
      const shown = (manager: SessionManager, sessionId: string) =>
        Object.fromEntries((manager.getSession(address(sessionId))?.configOptions ?? []).map((option) => [option.id, option.current]));

      /** The ID and reason of each saved value logged as not reapplied. */
      function notReapplied(): unknown[][] {
        const logged: unknown[][] = [];
        setLogSink({
          trace() {}, debug() {}, info() {}, error() {},
          warn: (message, context) => {
            if (message === 'Saved option not reapplied') { logged.push([context?.['configId'] ?? context?.['modeId'], context?.['reason']]); }
          },
        });
        onTestFinished(() => { setLogSink(undefined); });
        return logged;
      }

      it('requests the saved values that differ before the load ends: the mode, then the model, then the rest in the agent\'s order', async () => {
        const fake = reapplyingAgent();
        const { manager, references } = setup({ fake: fake.script });
        await references.saveSelections(address(FIRST_SESSION), { options: { effort: 'high', fast: true, model: 'b', mode: 'code' } });
        let requestedByEnd = 0;
        manager.on('session-load-end', () => { requestedByEnd = fake.requests.length; });

        await manager.loadSession('fake', FIRST_SESSION);

        expect(fake.requests).toEqual([['mode', 'code'], ['model', 'b'], ['effort', 'high'], ['fast', true]]);
        expect(requestedByEnd).toBe(4);
        expect(shown(manager, FIRST_SESSION)).toEqual({ effort: 'high', fast: true, model: 'b', mode: 'code' });
      });

      it('compares again after each answer, requesting nothing a change of model already brought about', async () => {
        const fake = reapplyingAgent();
        const { manager, references } = setup({ fake: fake.script });
        await references.saveSelections(address(FIRST_SESSION), { options: { effort: 'medium', model: 'b' } });

        await manager.loadSession('fake', FIRST_SESSION);

        expect(fake.requests).toEqual([['model', 'b']]);
        expect(shown(manager, FIRST_SESSION)).toMatchObject({ effort: 'medium', model: 'b' });
      });

      it('skips and logs saved values the agent does not offer, and options it no longer has', async () => {
        const logged = notReapplied();
        const fake = reapplyingAgent();
        const { manager, references } = setup({ fake: fake.script });
        await references.saveSelections(address(FIRST_SESSION), { options: { effort: 'high', fast: 'yes', gone: 'x', model: 'z', mode: 'ask' } });

        await manager.loadSession('fake', FIRST_SESSION);

        expect(fake.requests).toEqual([]);
        expect(logged).toEqual([['effort', 'not offered'], ['fast', 'not offered'], ['gone', 'not offered'], ['model', 'not offered']]);
        expect(shown(manager, FIRST_SESSION)).toEqual({ effort: 'low', fast: false, model: 'a', mode: 'ask' });
      });

      it('skips and logs a value the agent rejects, reapplies the rest, and saves none of what it answers', async () => {
        const logged = notReapplied();
        const fake = reapplyingAgent((configId) => (configId === 'model' ? 'reject' : undefined));
        const { manager, references, reference } = setup({ fake: fake.script });
        const saved = { options: { fast: true, model: 'b' } };
        await references.saveSelections(address(FIRST_SESSION), saved);

        await manager.loadSession('fake', FIRST_SESSION);

        expect(fake.requests).toEqual([['model', 'b'], ['fast', true]]);
        expect(logged).toEqual([['model', expect.stringContaining('unknown value')]]);
        expect(shown(manager, FIRST_SESSION)).toEqual({ effort: 'low', fast: true, model: 'a', mode: 'ask' });
        expect(reference(FIRST_SESSION)?.selections).toEqual(saved);
      });

      it('requests each option once, showing what the agent answers', async () => {
        const logged = notReapplied();
        const fake = reapplyingAgent(() => 'ignore');
        const { manager, references } = setup({ fake: fake.script });
        await references.saveSelections(address(FIRST_SESSION), { options: { model: 'b' } });

        await manager.loadSession('fake', FIRST_SESSION);

        expect(fake.requests).toEqual([['model', 'b']]);
        expect(logged).toEqual([['model', 'the agent answered with another value']]);
        expect(shown(manager, FIRST_SESSION)).toMatchObject({ model: 'a' });
      });

      it('reapplies them after a resume too, before the session becomes active, saving none of what the agent answers', async () => {
        const fake = reapplyingAgent((configId) => (configId === 'fast' ? 'reject' : undefined));
        const { manager, references, reference } = setup({ fake: fake.script });
        const saved = { options: { fast: true, model: 'b' } };
        await references.saveSelections(address(FIRST_SESSION), saved);
        let requestedWhenActive = 0;
        manager.on('active-session-changed', () => { requestedWhenActive = fake.requests.length; });

        await manager.resumeSession('fake', FIRST_SESSION);

        expect(fake.requests).toEqual([['model', 'b'], ['fast', true]]);
        expect(requestedWhenActive).toBe(2);
        expect(shown(manager, FIRST_SESSION)).toEqual({ effort: 'medium', fast: false, model: 'b', mode: 'ask' });
        expect(reference(FIRST_SESSION)?.selections).toEqual(saved);
      });

      it('reapplies those saved where the session was used, on its host, before the window knows its workspace target', async () => {
        const fake = reapplyingAgent();
        const { manager, references, withPendingWorkspaceTarget } = setup({ fake: fake.script });
        await references.saveSelections(address(FIRST_SESSION), { options: { model: 'b' } });
        withPendingWorkspaceTarget();

        await manager.loadSession('fake', FIRST_SESSION, address(FIRST_SESSION));

        expect(fake.requests).toEqual([['model', 'b']]);
      });

      it("reapplies those saved through another configuration, whose reference moves to the one it loads through", async () => {
        const fake = reapplyingAgent();
        const other = reapplyingAgent();
        const { manager, references, reference, workspace } = setup({ fake: fake.script, other: other.script });
        await references.setTitle(address(FIRST_SESSION), 'Kept title');
        await references.saveSelections(address(FIRST_SESSION), { options: { model: 'b' } });
        const before = reference(FIRST_SESSION);

        await manager.loadSession('other', FIRST_SESSION, address(FIRST_SESSION));

        expect([fake.requests, other.requests]).toEqual([[], [['model', 'b']]]);
        expect(manager.getSession({ configuredName: 'other', sessionId: FIRST_SESSION })?.title).toBe('Kept title');
        expect(reference(FIRST_SESSION)).toBeUndefined();
        expect(references.get({ host: WORKSPACE.host, configuredName: 'other', sessionId: FIRST_SESSION }))
          .toEqual({ ...before, configuredName: 'other', lastActiveAt: expect.any(String) as unknown });
        expect(workspace.lastActiveSession()).toEqual({ ...address(FIRST_SESSION), configuredName: 'other' });
      });

      it('leaves the reference where it was when the load through another configuration fails', async () => {
        const refusing: AgentScript = () => fakeAgent(caps).onRequest(methods.agent.session.load, () => {
          throw new RequestError(-32000, 'Session is in use by another client');
        });
        const { manager, references, reference, workspace } = setup({ fake: reapplyingAgent().script, other: refusing });
        await references.setTitle(address(FIRST_SESSION), 'Kept title');
        await workspace.setLastActiveSession(address(FIRST_SESSION));
        const before = reference(FIRST_SESSION);

        await expect(manager.loadSession('other', FIRST_SESSION, address(FIRST_SESSION))).rejects.toThrow('in use by another client');

        expect(reference(FIRST_SESSION)).toEqual(before);
        expect(references.get({ host: WORKSPACE.host, configuredName: 'other', sessionId: FIRST_SESSION })).toBeUndefined();
        expect(workspace.lastActiveSession()).toEqual(address(FIRST_SESSION));
      });

      it("moves the reference of a session resumed through another configuration, on this window's host when none is given", async () => {
        const fake = reapplyingAgent();
        const other = reapplyingAgent();
        const { manager, references, reference } = setup({ fake: fake.script, other: other.script });
        await references.setTitle(address(FIRST_SESSION), 'Kept title');
        await references.saveSelections(address(FIRST_SESSION), { options: { model: 'b' } });

        await manager.resumeSession('other', FIRST_SESSION, { configuredName: 'fake' });

        expect([fake.requests, other.requests]).toEqual([[], [['model', 'b']]]);
        expect(manager.getSession({ configuredName: 'other', sessionId: FIRST_SESSION })?.title).toBe('Kept title');
        expect(reference(FIRST_SESSION)).toBeUndefined();
        expect(references.get({ host: WORKSPACE.host, configuredName: 'other', sessionId: FIRST_SESSION })).toMatchObject({ title: 'Kept title' });
      });

      it.each([
        ['load', 'rename'], ['resume', 'rename'],
        ['load', 'remove'], ['resume', 'remove'],
      ] as const)('keeps deferred %s persistence bound to its registration after %s', async (how, change) => {
        const other = reapplyingAgent();
        const { manager, references, reference, workspace, withPendingWorkspaceTarget } = setup({ other: other.script });
        await references.setTitle(address(FIRST_SESSION), 'Original reference');
        await references.saveSelections(address(FIRST_SESSION), { options: { model: 'b' } });
        const before = reference(FIRST_SESSION);
        const learn = withPendingWorkspaceTarget();
        const usedThrough = { configuredName: 'fake' };
        if (how === 'load') { await manager.loadSession('other', FIRST_SESSION, usedThrough); }
        else { await manager.resumeSession('other', FIRST_SESSION, usedThrough); }
        manager.applySessionInfoUpdate({ configuredName: 'other', sessionId: FIRST_SESSION }, { title: 'Deferred title' });
        if (change === 'rename') {
          manager.agentsChanged({ other: { command: 'other' } }, { renamed: { command: 'other' } });
        } else {
          await manager.disconnectAgent('other');
        }

        learn();
        await manager.recordsSettled();
        await references.settled();
        await workspace.settled();

        expect(references.get({ host: WORKSPACE.host, configuredName: 'other', sessionId: FIRST_SESSION })).toBeUndefined();
        if (change === 'rename') {
          expect(reference(FIRST_SESSION)).toBeUndefined();
          expect(references.get({ host: WORKSPACE.host, configuredName: 'renamed', sessionId: FIRST_SESSION }))
            .toMatchObject({ title: 'Deferred title', selections: { options: { model: 'b' } } });
          expect(workspace.lastActiveSession()?.configuredName).toBe('renamed');
        } else {
          expect(reference(FIRST_SESSION)).toEqual(before);
          expect(workspace.lastActiveSession()).toBeUndefined();
        }
      });

      it('reapplies the mode saved for an agent using the modes API when it offers it', async () => {
        const logged = notReapplied();
        const requested: string[] = [];
        const script: AgentScript = () => fakeAgent(caps)
          .onRequest(methods.agent.session.load, () => ({ modes: modes('code') }))
          .onRequest(methods.agent.session.setMode, ({ params }) => { requested.push(params.modeId); return {}; });
        const { manager, references } = setup({ fake: script });
        await references.saveSelections(address(OLD_SESSION), { modeId: 'ask', options: {} });
        await references.saveSelections(address(OLDER_SESSION), { modeId: 'plan', options: {} });

        await manager.loadSession('fake', OLD_SESSION);
        expect(manager.getSession(address(OLD_SESSION))?.modes?.current).toBe('ask');
        await manager.loadSession('fake', OLDER_SESSION);

        expect(requested).toEqual(['ask']);
        expect(logged).toEqual([['plan', 'not offered']]);
        expect(manager.getSession(address(OLDER_SESSION))?.modes?.current).toBe('code');
      });
    });
  });

  describe('renamed configurations', () => {
    const fakeConfig = { command: 'fake' };

    it('notifies configuration renames after moving live ownership, but not unrelated changes', async () => {
      const { manager, agents } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      const session = await manager.connectToAgent('fake');
      const renames: unknown[][] = [];
      manager.on('configuration-renamed', (from, to) => {
        renames.push([from, to, session.agentName, manager.openSessionOf(to) === session,
          manager.isConnected(to), manager.hasSession(from), manager.isConnected(from)]);
      });

      manager.agentsChanged({ fake: fakeConfig }, { renamed: fakeConfig });
      manager.agentsChanged({ renamed: fakeConfig }, { again: fakeConfig });
      manager.agentsChanged({ again: fakeConfig }, { again: fakeConfig, fake: { command: 'other' } });
      manager.agentsChanged({ again: fakeConfig, fake: { command: 'other' } }, { again: fakeConfig, fake: { command: 'changed' } });

      expect(renames).toEqual([
        ['fake', 'renamed', 'renamed', true, true, false, false],
        ['renamed', 'again', 'again', true, true, false, false],
      ]);
      expect(manager.getActiveSession()).toBe(session);
      expect(agents.launched).toHaveLength(1);
    });

    it.each([
      ['load', 'initialization'], ['load', 'opening'],
      ['resume', 'initialization'], ['resume', 'opening'],
    ] as const)('keeps %s bound to the current configuration after renames during %s', async (how, stage) => {
      let enter: () => void = () => {};
      let release: () => void = () => {};
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      const pause = async () => { enter(); await released; };
      const open = async () => {
        if (stage === 'opening') { await pause(); }
        return { configOptions: [modelOption('a')] };
      };
      const requested: unknown[] = [];
      const script: AgentScript = () => agent()
        .onRequest(methods.agent.initialize, async () => {
          if (stage === 'initialization') { await pause(); }
          return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } };
        })
        .onRequest(methods.agent.session.load, open)
        .onRequest(methods.agent.session.resume, open)
        .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
          requested.push(params);
          return { configOptions: [modelOption(String(params.value))] };
        });
      const { manager, agents, references, workspace } = setup({ fake: script });
      await references.saveSelections(address(FIRST_SESSION), { options: { model: 'b' } });
      const events: unknown[][] = [];
      let load: SessionLoad | undefined;
      manager.once('session-load-start', (started) => { load = started; });
      manager.on('session-opened', (...args) => events.push(['opened', ...args]));
      manager.on('session-load-end', (...args) => events.push(['load-end', ...args]));
      manager.on('session-added', (...args) => events.push(['added', ...args]));
      const opening = how === 'load' ? manager.loadSession('fake', FIRST_SESSION) : manager.resumeSession('fake', FIRST_SESSION);
      const result = opening.then((session) => ({ session }), (error: unknown) => ({ error }));
      try {
        await entered;
        manager.agentsChanged({ fake: fakeConfig }, { renamed: fakeConfig });
        manager.agentsChanged({ renamed: fakeConfig }, { again: fakeConfig });
        manager.agentsChanged({ again: fakeConfig }, { again: fakeConfig, fake: { command: 'other' } });
      } finally {
        release();
      }
      const outcome = await result;
      expect(outcome).not.toHaveProperty('error');
      if (!('session' in outcome)) { throw outcome.error; }
      const { session } = outcome;
      expect(manager.openSessionOf('again')).toBe(session);
      expect(manager.hasSession('fake')).toBe(false);
      expect(session.agentName).toBe('again');
      expect(manager.getActiveSession()).toBe(session);
      expect(manager.getSession({ configuredName: 'again', sessionId: FIRST_SESSION })).toBe(session);
      expect(manager.getSession({ configuredName: 'fake', sessionId: FIRST_SESSION })).toBeUndefined();
      expect(session.configOptions).toEqual([modelConfig('b')]);
      expect(requested).toEqual([{ sessionId: FIRST_SESSION, configId: 'model', value: 'b' }]);
      expect(events).toEqual(how === 'load'
        ? [['added', session], ['load-end', load, true], ['opened', session, 'loaded']]
        : [['added', session], ['opened', session, 'resumed']]);
      if (how === 'load') {
        expect(load?.origin.identity.configuredName).toBe(stage === 'opening' ? 'fake' : 'again');
        expect(load?.registration).toBe(session);
      }
      await references.settled();
      await workspace.settled();
      expect(references.get({ host: WORKSPACE.host, configuredName: 'fake', sessionId: FIRST_SESSION })).toBeUndefined();
      expect(references.get({ host: WORKSPACE.host, configuredName: 'again', sessionId: FIRST_SESSION })?.selections).toEqual({ options: { model: 'b' } });
      expect(workspace.lastActiveSession()?.configuredName).toBe('again');
      await manager.ensureConnected('again');
      expect(agents.launched).toHaveLength(1);
      await manager.disconnectAgent('again');
      expect(manager.getActiveSession()).toBeUndefined();
    });

    it.each(['initialization', 'creation'] as const)('keeps the captured configuration through two renames and old-name reuse during %s', async (stage) => {
      let enter: () => void = () => {};
      let release: () => void = () => {};
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      const pause = async () => { enter(); await released; };
      const script: AgentScript = () => agent()
        .onRequest(methods.agent.initialize, async () => {
          if (stage === 'initialization') { await pause(); }
          return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true } };
        })
        .onRequest(methods.agent.session.new, async () => {
          if (stage === 'creation') { await pause(); }
          return { sessionId: FIRST_SESSION };
        });
      const { manager, agents, references, workspace } = setup({ fake: script });
      const opening = manager.connectToAgent('fake');
      try {
        await entered;
        manager.agentsChanged({ fake: fakeConfig }, { renamed: fakeConfig });
        manager.agentsChanged({ renamed: fakeConfig }, { again: fakeConfig });
        manager.agentsChanged({ again: fakeConfig }, { again: fakeConfig, fake: { command: 'other' } });
      } finally {
        release();
      }
      const session = await opening;
      await manager.recordsSettled();
      await references.settled();
      await workspace.settled();

      expect(session.agentName).toBe('again');
      expect(manager.openSessionOf('again')).toBe(session);
      expect(manager.hasSession('fake')).toBe(false);
      expect(manager.isConnected('again')).toBe(true);
      expect(manager.isConnected('fake')).toBe(false);
      expect(manager.getCachedCapabilities('again')?.load).toBe(true);
      expect(workspace.lastActiveSession()?.configuredName).toBe('again');
      expect(references.get({ host: WORKSPACE.host, configuredName: 'fake', sessionId: FIRST_SESSION })).toBeUndefined();
      expect(references.get({ host: WORKSPACE.host, configuredName: 'again', sessionId: FIRST_SESSION })).toBeDefined();

      await manager.ensureConnected('again');
      expect(agents.launched).toHaveLength(1);
      await manager.disconnectAgent('again');
      expect(manager.getActiveSession()).toBeUndefined();
      expect(manager.isConnected('again')).toBe(false);
    });

    it('keeps the renamed live registration on its original connection', async () => {
      const prompted: string[] = [];
      const fake = sessionAgent(FIRST_SESSION, (app) => app
        .onRequest(methods.agent.session.prompt, ({ params }) => {
          prompted.push(params.sessionId);
          return { stopReason: 'end_turn' };
        })
        .onRequest(methods.agent.session.setConfigOption, ({ params }) => ({
          configOptions: [modelOption(String(params.value))],
        })));
      const { manager } = setup({ fake: fake.script });
      const session = await manager.connectToAgent('fake');

      manager.agentsChanged({ fake: fakeConfig }, { renamed: fakeConfig });

      expect(manager.getActiveSession()).toBe(session);
      expect(session.agentName).toBe('renamed');
      expect(manager.openSessionOf('renamed')).toBe(session);
      expect(manager.hasSession('fake')).toBe(false);
      expect(manager.isConnected('renamed')).toBe(true);
      expect(manager.isConnected('fake')).toBe(false);
      await manager.sendPrompt({ configuredName: 'renamed', sessionId: FIRST_SESSION }, 'Continue after rename');
      await manager.setConfigOption({ configuredName: 'renamed', sessionId: FIRST_SESSION }, 'model', 'b');
      expect(prompted).toEqual([FIRST_SESSION]);
      expect(session.configOptions).toEqual([modelConfig('b')]);

      await manager.disconnectAgent('renamed');

      expect(manager.getActiveSession()).toBeUndefined();
      expect(manager.isConnected('renamed')).toBe(false);
    });

    it("rebinds this host's references and this workspace's last active session to the new name", async () => {
      const { manager, references, workspace, reference } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      await manager.connectToAgent('fake');
      await manager.recordsSettled();

      manager.agentsChanged({ fake: fakeConfig }, { renamed: fakeConfig });
      await references.settled();
      await workspace.settled();

      expect(reference(FIRST_SESSION)).toBeUndefined();
      expect(references.get({ host: WORKSPACE.host, configuredName: 'renamed', sessionId: FIRST_SESSION })).toBeDefined();
      expect(workspace.lastActiveSession()?.configuredName).toBe('renamed');
    });

    it('records a session still running under the old name under the new one', async () => {
      const { manager, references, reference } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      await manager.connectToAgent('fake');

      manager.agentsChanged({ fake: fakeConfig }, { renamed: fakeConfig });
      manager.applySessionInfoUpdate({ configuredName: 'renamed', sessionId: FIRST_SESSION }, { title: 'After the rename' });
      await manager.recordsSettled();
      await references.settled();

      expect(reference(FIRST_SESSION)).toBeUndefined();
      expect(references.get({ host: WORKSPACE.host, configuredName: 'renamed', sessionId: FIRST_SESSION })?.title).toBe('After the rename');
    });

    it('records a session still running under its first name under the last, after two renames', async () => {
      const { manager, references } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      await manager.connectToAgent('fake');

      manager.agentsChanged({ fake: fakeConfig }, { renamed: fakeConfig });
      manager.agentsChanged({ renamed: fakeConfig }, { again: fakeConfig });
      manager.applySessionInfoUpdate({ configuredName: 'again', sessionId: FIRST_SESSION }, { title: 'After both' });
      await manager.recordsSettled();
      await references.settled();

      expect(references.get({ host: WORKSPACE.host, configuredName: 'again', sessionId: FIRST_SESSION })?.title).toBe('After both');
    });

    it('keeps recording the original session under its renamed configuration when the old name is reused', async () => {
      const { manager, references, reference } = setup({ fake: sessionAgent(FIRST_SESSION).script });
      await manager.connectToAgent('fake');
      manager.agentsChanged({ fake: fakeConfig }, { renamed: fakeConfig });

      manager.agentsChanged({ renamed: fakeConfig }, { renamed: fakeConfig, fake: { command: 'other' } });
      manager.applySessionInfoUpdate({ configuredName: 'renamed', sessionId: FIRST_SESSION }, { title: 'Still the original session' });
      await manager.recordsSettled();
      await references.settled();

      expect(reference(FIRST_SESSION)).toBeUndefined();
      expect(references.get({ host: WORKSPACE.host, configuredName: 'renamed', sessionId: FIRST_SESSION })?.title)
        .toBe('Still the original session');
    });
  });
});
