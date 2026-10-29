import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agent, methods, RequestError } from '@agentclientprotocol/sdk';
import type { AgentApp, ListSessionsResponse, SessionInfo } from '@agentclientprotocol/sdk';
import { ConnectionManager } from '@/core/acp/ConnectionManager';
import { SessionReferences, WorkspaceState, type KeyValueStore, type SessionAddress, type WorkspaceTarget } from '@/core/PersistedState';
import { SessionList, type AgentSessions } from '@/core/SessionList';
import { SessionManager, type AuthPrompt } from '@/core/SessionManager';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import { fakeAgent, InProcessAgents, unusedHandlers, type AgentScript } from './InProcessAgents';

const NOW = Date.parse('2026-10-18T12:00:00Z');

function memoryStore(): KeyValueStore {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key, value) => { values.set(key, value); },
  };
}

/** A remote window's workspace file saved on the client, so its URI and host differ. */
const WORKSPACE: WorkspaceTarget = { uri: 'file:///Users/me/work.code-workspace', host: 'vscode-remote://ssh-remote+devenv' };

/** Where session `sessionId` of `configuredName` lives in the test workspace. */
const address = (configuredName: string, sessionId: string): SessionAddress =>
  ({ configuredName, sessionId, cwd: '/work', host: WORKSPACE.host, workspaceUri: WORKSPACE.uri });

function setup(scripts: Record<string, AgentScript>) {
  const agents = new InProcessAgents(scripts);
  const authPrompt = { chooseAuthMethod: vi.fn<AuthPrompt['chooseAuthMethod']>(async () => undefined) };
  let target: WorkspaceTarget | undefined = WORKSPACE;
  const manager = new SessionManager(
    agents,
    new ConnectionManager(new SessionUpdateHandler(), '0.0.0-test', () => unusedHandlers),
    {
      workspaceCwd: () => '/work',
      workspaceTarget: () => target,
      workspaceTargetKnown: () => Promise.resolve(target),
      agentConfigs: () => Object.fromEntries(Object.keys(scripts).map((name) => [name, { command: name }])),
      activeFileLink: () => undefined,
    },
    authPrompt,
  );
  onTestFinished(async () => { await manager.dispose(); });
  const references = new SessionReferences(memoryStore(), () => Date.now());
  manager.setPersistedState(references, new WorkspaceState(memoryStore()));
  const list = new SessionList(manager, references, () => Object.keys(scripts), () => '/work', () => target, () => NOW);
  onTestFinished(() => { list.dispose(); });
  return {
    agents,
    manager,
    references,
    list,
    authPrompt,
    /** As in a window with no folder, or an untitled multi-root workspace. */
    withoutWorkspaceTarget() { target = undefined; },
  };
}

/**
 * The agent's sessions once they are no longer loading. Bounded by looks, not
 * time: in-process agents answer without yielding to timers, so a list that
 * keeps restarting would starve Vitest's timeout.
 */
async function listed(list: SessionList, agentName: string): Promise<AgentSessions> {
  for (let look = 0; look < 20; look++) {
    // Listening before looking, as the list can settle while the look is awaited.
    let changed!: () => void;
    const change = new Promise<void>((resolve) => { changed = resolve; });
    list.once('changed', changed);
    const sessions = await list.sessionsOf(agentName);
    const loading = sessions.kind === 'loading' || (sessions.kind === 'listed' && sessions.more.kind === 'loading');
    if (!loading) {
      list.off('changed', changed);
      return sessions;
    }
    await change;
  }
  throw new Error(`Sessions of ${agentName} were still loading after 20 looks`);
}

const listingCaps = { agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } } };

/** An agent that lists sessions in pages keyed by cursor ('' for the first), recording each request. */
function listingAgent(
  pages: Record<string, ListSessionsResponse | (() => ListSessionsResponse | Promise<ListSessionsResponse>)>,
  extend = (app: AgentApp) => app,
  init: Parameters<typeof fakeAgent>[0] = listingCaps,
) {
  const requests: (string | null | undefined)[] = [];
  const script: AgentScript = () => extend(fakeAgent(init).onRequest(methods.agent.session.list, ({ params }) => {
    requests.push(params.cursor);
    const page = pages[params.cursor ?? ''];
    if (!page) {
      throw new Error(`no page ${String(params.cursor)}`);
    }
    return typeof page === 'function' ? page() : page;
  }));
  return { script, requests };
}

const session = (sessionId: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({ sessionId, cwd: '/work', ...extra });

describe('SessionList', () => {
  it('releases test-owned agents and listeners after the test finishes', async () => {
    let exitReported = false;
    onTestFinished(async () => {
      const { agents, manager, references, list } = fixture;
      try {
        expect(agents.launched.map(({ killed, exited }) => ({ killed, exited }))).toEqual([{ killed: true, exited: true }]);
        expect(exitReported).toBe(true);
        expect(manager.listenerCount('session-added')).toBe(0);
        expect(references.listenerCount('changed')).toBe(0);
        expect(list.listenerCount('changed')).toBe(0);
      } finally {
        list.dispose();
        await manager.dispose();
      }
    });
    const fixture = setup({ fake: () => fakeAgent() });
    fixture.list.on('changed', () => {});
    await fixture.manager.ensureConnected('fake');
    void fixture.agents.launched[0]?.exitReported.then(() => { exitReported = true; });
  });

  describe('agents', () => {
    it('lists each configured agent with whether it is in session', async () => {
      const { manager, list } = setup({
        one: () => fakeAgent().onRequest(methods.agent.session.new, () => ({ sessionId: 's1' })),
        two: () => fakeAgent(),
      });
      await manager.connectToAgent('one');

      expect(list.agents()).toEqual([
        { name: 'one', hasSession: true, expandable: true },
        { name: 'two', hasSession: false, expandable: true },
      ]);
    });

    it('cannot expand an agent known to keep no past sessions, unless session history has some', async () => {
      const { manager, references, list } = setup({ plain: () => fakeAgent() });
      await manager.ensureConnected('plain');
      expect(list.agents()).toEqual([{ name: 'plain', hasSession: false, expandable: false }]);

      await references.used(address('plain', 'old'));
      expect(list.agents()).toEqual([{ name: 'plain', hasSession: false, expandable: true }]);
    });
  });

  describe('sessions an agent lists', () => {
    it('starts the agent to learn its capabilities, without creating a session', async () => {
      const fake = listingAgent({ '': { sessions: [] } });
      const { agents, manager, list } = setup({ fake: fake.script });

      await listed(list, 'fake');

      expect(agents.launched).toHaveLength(1);
      expect(manager.hasSession('fake')).toBe(false);
    });

    it('shows them as loading, then lists them with labels, ages and the active session marked', async () => {
      const fake = listingAgent({
        '': {
          sessions: [
            session('titled', { title: '  Fix the build  ', updatedAt: '2026-10-18T09:00:00Z' }),
            session('0123456789abcdefghij', { updatedAt: '2026-10-11T12:00:00Z' }),
          ],
        },
      }, (app) => app.onRequest(methods.agent.session.load, () => ({})));
      const { manager, list } = setup({ fake: fake.script });

      expect(await list.sessionsOf('fake')).toEqual({ kind: 'loading' });
      await listed(list, 'fake');
      await manager.loadSession('fake', 'titled');

      expect(await list.sessionsOf('fake')).toEqual({
        kind: 'listed',
        source: 'agent',
        more: { kind: 'none' },
        rows: [
          {
            sessionId: 'titled',
            label: 'Fix the build',
            age: '3 hours ago',
            isActive: true,
            tooltip: 'Agent: fake\nSession: titled\ncwd: /work\nLast active: 2026-10-18T09:00:00Z\nListed by agent',
          },
          {
            sessionId: '0123456789abcdefghij',
            label: 'Untitled',
            age: '7 days ago',
            isActive: false,
            tooltip: 'Agent: fake\nSession: 0123456789abcdefghij\ncwd: /work\nLast active: 2026-10-11T12:00:00Z\nListed by agent',
          },
        ],
      });
    });

    it('rounds ages down, shows under a minute or a time ahead of ours as now, and shows no age for an undated session', async () => {
      const fake = listingAgent({
        '': {
          sessions: [
            session('nearly-an-hour', { updatedAt: '2026-10-18T11:00:01Z' }),
            session('a-minute', { updatedAt: '2026-10-18T11:59:00Z' }),
            session('nearly-a-minute', { updatedAt: '2026-10-18T11:59:01Z' }),
            session('ahead', { updatedAt: '2026-10-18T12:00:05Z' }),
            session('undated'),
          ],
        },
      });
      const { list } = setup({ fake: fake.script });

      const shown = await listed(list, 'fake');

      expect(shown.kind === 'listed' && shown.rows.map((row) => row.age)).toEqual(['59 minutes ago', '1 minute ago', 'now', 'now', undefined]);
    });

    it('lists them once, until invalidated', async () => {
      const fake = listingAgent({ '': { sessions: [session('a')] } });
      const { list } = setup({ fake: fake.script });

      await listed(list, 'fake');
      await listed(list, 'fake');
      list.invalidate('fake');
      await listed(list, 'fake');

      expect(fake.requests).toEqual([undefined, undefined]);
    });

    describe('a session open here that the agent has not listed', () => {
      const creating = (sessions: SessionInfo[]) =>
        listingAgent({ '': { sessions } }, (app) => app.onRequest(methods.agent.session.new, () => ({ sessionId: 'created' })));
      const ids = (sessions: AgentSessions) => (sessions.kind === 'listed' ? sessions.rows.map((row) => row.sessionId) : sessions);

      it('is shown first as soon as it is created, without asking the agent again', async () => {
        const fake = creating([session('old', { title: 'Old' })]);
        const { manager, list } = setup({ fake: fake.script });
        await listed(list, 'fake');

        await manager.connectToAgent('fake');

        const sessions = await list.sessionsOf('fake');
        expect(ids(sessions)).toEqual(['created', 'old']);
        expect(sessions.kind === 'listed' && sessions.rows[0]).toMatchObject({
          label: 'Untitled',
          isActive: true,
          tooltip: expect.stringMatching(/^Agent: fake\nSession: created\ncwd: \/work\nLast active: .+\nOpen in this window, not yet listed by agent$/) as unknown,
        });
        expect(fake.requests).toEqual([undefined]);
      });

      it('takes the title it reports', async () => {
        const fake = creating([]);
        const { manager, list } = setup({ fake: fake.script });
        await listed(list, 'fake');
        await manager.connectToAgent('fake');

        manager.applySessionInfoUpdate('created', { title: 'Named' });

        const sessions = await list.sessionsOf('fake');
        expect(sessions.kind === 'listed' && sessions.rows.map((row) => row.label)).toEqual(['Named']);
      });

      it('stays while it is open when a later listing omits it, and goes once it is not', async () => {
        const fake = creating([session('old')]);
        const { manager, list } = setup({ fake: fake.script });
        await listed(list, 'fake');
        await manager.connectToAgent('fake');

        list.invalidate('fake');
        expect(ids(await listed(list, 'fake'))).toEqual(['created', 'old']);

        await manager.disconnectAgent('fake');
        expect(ids(await listed(list, 'fake'))).toEqual(['old']);
      });

      it('keeps the title it was opened with when a later listing omits it', async () => {
        let listings = 0;
        const fake = listingAgent({ '': () => ({ sessions: listings++ ? [] : [session('a', { title: 'Listed' })] }) },
          (app) => app.onRequest(methods.agent.session.load, () => ({})));
        const { manager, list } = setup({ fake: fake.script });
        await listed(list, 'fake');
        await manager.loadSession('fake', 'a');

        list.invalidate('fake');

        const sessions = await listed(list, 'fake');
        expect(sessions.kind === 'listed' && sessions.rows.map(({ sessionId, label }) => ({ sessionId, label }))).toEqual([
          { sessionId: 'a', label: 'Listed' },
        ]);
      });

      it('is shown once, where the agent lists it, once it does', async () => {
        const fake = creating([session('created', { title: 'Listed' }), session('old')]);
        const { manager, list } = setup({ fake: fake.script });
        await manager.connectToAgent('fake');

        const sessions = await listed(list, 'fake');
        expect(ids(sessions)).toEqual(['created', 'old']);
        expect(sessions.kind === 'listed' && sessions.rows[0]?.tooltip).toMatch(/Listed by agent$/);
      });
    });

    describe('refreshing', () => {
      const resumable = { agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {} } } };
      /** An agent whose first page is each of `firsts` in turn, the last repeating, and that creates, loads and resumes sessions. */
      function changing(firsts: ListSessionsResponse[], later: Record<string, ListSessionsResponse | (() => Promise<ListSessionsResponse>)> = {}) {
        let asked = 0;
        return listingAgent(
          { '': () => firsts[Math.min(asked++, firsts.length - 1)] ?? { sessions: [] }, ...later },
          (app) => app
            .onRequest(methods.agent.session.new, () => ({ sessionId: 'created' }))
            .onRequest(methods.agent.session.load, () => ({}))
            .onRequest(methods.agent.session.resume, () => ({})),
          resumable,
        );
      }
      const shownNow = async (list: SessionList) => {
        const sessions = await list.sessionsOf('fake');
        return sessions.kind === 'listed' ? { rows: sessions.rows.map((row) => row.label), more: sessions.more.kind } : sessions;
      };
      const page = (...ids: string[]) => ids.map((id) => session(id, { title: id }));

      it('asks the agent for its first page again, showing the rows it has meanwhile', async () => {
        const fake = changing([{ sessions: page('a') }, { sessions: page('b', 'a') }]);
        const { list } = setup({ fake: fake.script });
        await listed(list, 'fake');

        const refreshing = list.refresh('fake');
        expect(await shownNow(list)).toEqual({ rows: ['a'], more: 'none' });
        await refreshing;

        expect(await shownNow(list)).toEqual({ rows: ['b', 'a'], more: 'none' });
        expect(fake.requests).toEqual([undefined, undefined]);
      });

      it('shares one request among the refreshes asked for while one is in progress', async () => {
        const fake = changing([{ sessions: page('a') }]);
        const { list } = setup({ fake: fake.script });
        await listed(list, 'fake');

        await Promise.all([list.refresh('fake'), list.refresh('fake'), list.refreshAll()]);
        expect(fake.requests).toEqual([undefined, undefined]);

        await list.refresh('fake');
        expect(fake.requests).toEqual([undefined, undefined, undefined]);
      });

      it('neither starts an agent nor asks one whose sessions are not shown', async () => {
        const fake = changing([{ sessions: page('a') }]);
        const { agents, manager, list } = setup({ fake: fake.script });

        await list.refreshAll();
        expect(agents.launched).toHaveLength(0);

        await manager.ensureConnected('fake');
        await list.refresh('fake');
        expect(fake.requests).toEqual([]);

        await listed(list, 'fake');
        await manager.disconnectAgent('fake');
        await list.refreshAll();
        expect([agents.launched.length, fake.requests]).toEqual([1, [undefined]]);
      });

      it('refreshes every running agent whose sessions are shown', async () => {
        const one = changing([{ sessions: page('a') }]);
        const two = changing([{ sessions: page('b') }]);
        const { manager, list } = setup({ one: one.script, two: two.script });
        await listed(list, 'one');
        await listed(list, 'two');
        await manager.disconnectAgent('two');

        await list.refreshAll();

        expect([one.requests, two.requests]).toEqual([[undefined, undefined], [undefined]]);
      });

      it('keeps the later pages and their load more, without the sessions the new first page lists', async () => {
        const fake = changing(
          [{ sessions: page('a', 'b'), nextCursor: 'p2' }, { sessions: page('c', 'a'), nextCursor: 'p2' }],
          { p2: { sessions: page('c', 'd'), nextCursor: 'p3' }, p3: { sessions: page('e') } },
        );
        const { list } = setup({ fake: fake.script });
        await listed(list, 'fake');
        await list.loadMore('fake');

        await list.refresh('fake');
        expect(await shownNow(list)).toEqual({ rows: ['c', 'a', 'd'], more: 'available' });

        await list.loadMore('fake');
        expect(await shownNow(list)).toEqual({ rows: ['c', 'a', 'd', 'e'], more: 'none' });
        expect(fake.requests).toEqual([undefined, 'p2', undefined, 'p3']);
      });

      it('takes the whole first page once the agent has no more', async () => {
        const fake = changing([{ sessions: page('a'), nextCursor: 'p2' }, { sessions: page('b', 'a') }], { p2: { sessions: page('c'), nextCursor: 'p3' } });
        const { list } = setup({ fake: fake.script });
        await listed(list, 'fake');
        await list.loadMore('fake');
        expect(await shownNow(list)).toEqual({ rows: ['a', 'c'], more: 'available' });

        await list.refresh('fake');

        expect(await shownNow(list)).toEqual({ rows: ['b', 'a'], more: 'none' });
      });

      it('keeps a page that loads while a refresh is in progress', async () => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        const fake = changing(
          [{ sessions: page('a'), nextCursor: 'p2' }, { sessions: page('b', 'a'), nextCursor: 'p2' }],
          { p2: async () => { await held; return { sessions: page('a', 'c') }; } },
        );
        const { list } = setup({ fake: fake.script });
        await listed(list, 'fake');

        const loading = list.loadMore('fake');
        await list.refresh('fake');
        expect(await shownNow(list)).toEqual({ rows: ['b', 'a'], more: 'loading' });
        release();
        await loading;

        expect(await shownNow(list)).toEqual({ rows: ['b', 'a', 'c'], more: 'none' });
      });

      it('keeps the rows it shows when a refresh fails, and reports a start over that fails', async () => {
        let asked = 0;
        const fake = listingAgent({ '': () => { if (asked++) { throw new Error('busy'); } return { sessions: page('a') }; } });
        const { list } = setup({ fake: fake.script });
        await listed(list, 'fake');

        await list.refresh('fake');
        expect(await shownNow(list)).toEqual({ rows: ['a'], more: 'none' });

        await list.startOver('fake');
        expect(await list.sessionsOf('fake')).toMatchObject({ kind: 'failed' });
        expect(fake.requests).toEqual([undefined, undefined, undefined]);
      });

      it('starts over from the first page when the user asks, showing the rows it has meanwhile', async () => {
        const fake = changing(
          [{ sessions: page('a', 'b'), nextCursor: 'p2' }, { sessions: page('c', 'a'), nextCursor: 'p2' }],
          { p2: { sessions: page('c', 'd') } },
        );
        const { list } = setup({ fake: fake.script });
        await listed(list, 'fake');
        await list.loadMore('fake');

        const startingOver = list.startOver('fake');
        expect(await shownNow(list)).toEqual({ rows: ['a', 'b', 'c', 'd'], more: 'none' });
        await startingOver;

        expect(await shownNow(list)).toEqual({ rows: ['c', 'a'], more: 'available' });
      });

      it('abandons a page still loading when the user starts over', async () => {
        let releaseMore!: () => void;
        let releaseFirst!: () => void;
        const moreHeld = new Promise<void>((resolve) => { releaseMore = resolve; });
        const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
        let asked = 0;
        const fake = listingAgent({
          '': async () => {
            if (asked++ === 0) {
              return { sessions: page('a'), nextCursor: 'p2' };
            }
            await firstHeld;
            return { sessions: page('b', 'a'), nextCursor: 'p2' };
          },
          p2: async () => { await moreHeld; return { sessions: page('c') }; },
        });
        const { list } = setup({ fake: fake.script });
        await listed(list, 'fake');

        const loading = list.loadMore('fake');
        const startingOver = list.startOver('fake');
        releaseMore();
        await loading;
        expect(await shownNow(list)).toMatchObject({ rows: ['a'] });

        releaseFirst();
        await startingOver;
        expect(await shownNow(list)).toEqual({ rows: ['b', 'a'], more: 'available' });
      });

      it('starts over a list that failed by asking for it again', async () => {
        let asked = 0;
        const fake = listingAgent({ '': () => { if (!asked++) { throw new Error('busy'); } return { sessions: page('a') }; } });
        const { list } = setup({ fake: fake.script });
        expect(await listed(list, 'fake')).toMatchObject({ kind: 'failed' });

        await list.startOver('fake');

        expect(await listed(list, 'fake')).toMatchObject({ kind: 'listed', rows: [{ label: 'a' }] });
      });

      it('takes what is reported after a refresh was asked for over its result, and its result over what was reported before', async () => {
        const fake = changing([
          { sessions: [session('a', { title: 'Listed', updatedAt: '2026-10-18T09:00:00Z' })] },
          { sessions: [session('a', { title: 'Relisted', updatedAt: '2026-10-18T10:00:00Z' })] },
        ]);
        const { manager, list } = setup({ fake: fake.script });
        await listed(list, 'fake');
        await manager.loadSession('fake', 'a');
        await list.settled();
        manager.applySessionInfoUpdate('a', { title: 'Reported before' });

        const refreshing = list.refresh('fake');
        manager.recordTurnEnded('a');
        await refreshing;
        await list.settled();

        const sessions = await list.sessionsOf('fake');
        expect(sessions.kind === 'listed' && sessions.rows.map(({ label, age }) => ({ label, age }))).toEqual([{ label: 'Relisted', age: 'now' }]);

        const again = list.refresh('fake');
        manager.applySessionInfoUpdate('a', { title: 'Reported meanwhile' });
        await again;
        expect(await shownNow(list)).toEqual({ rows: ['Reported meanwhile'], more: 'none' });
      });

      it('refreshes once the first turn of a session created here ends, and not after later turns', async () => {
        const fake = changing([{ sessions: [] }, { sessions: page('created') }]);
        const { manager, list } = setup({ fake: fake.script });
        await listed(list, 'fake');
        await manager.connectToAgent('fake');
        await list.settled();
        expect(fake.requests).toEqual([undefined]);

        manager.recordTurnEnded('created');
        await list.settled();
        expect(fake.requests).toEqual([undefined, undefined]);
        expect(await shownNow(list)).toEqual({ rows: ['created'], more: 'none' });

        manager.recordTurnEnded('created');
        await list.settled();
        expect(fake.requests).toEqual([undefined, undefined]);
      });

      it('refreshes once a session is loaded or resumed', async () => {
        const fake = changing([{ sessions: page('a', 'b') }]);
        const { manager, list } = setup({ fake: fake.script });
        await listed(list, 'fake');

        await manager.loadSession('fake', 'a');
        await list.settled();
        expect(fake.requests).toEqual([undefined, undefined]);

        await manager.resumeSession('fake', 'b');
        await list.settled();
        expect(fake.requests).toEqual([undefined, undefined, undefined]);
      });
    });

    describe('what becomes known after listing', () => {
      const loadable = (sessions: SessionInfo[]) =>
        listingAgent({ '': { sessions } }, (app) => app.onRequest(methods.agent.session.load, () => ({})));
      const shown = async (list: SessionList) => {
        const sessions = await listed(list, 'fake');
        return sessions.kind === 'listed' ? sessions.rows.map(({ label, age }) => ({ label, age })) : sessions;
      };

      it('takes the title and time of last activity a session info update reports, and a cleared title', async () => {
        const fake = loadable([session('a', { title: 'Old', updatedAt: '2026-10-18T09:00:00Z' }), session('b', { title: 'Other' })]);
        const { manager, list } = setup({ fake: fake.script });
        await listed(list, 'fake');
        await manager.loadSession('fake', 'a');
        await list.settled();

        manager.applySessionInfoUpdate('a', { title: 'New' });
        expect(await shown(list)).toEqual([{ label: 'New', age: '3 hours ago' }, { label: 'Other', age: undefined }]);

        manager.applySessionInfoUpdate('a', { updatedAt: '2026-10-18T11:00:00Z' });
        expect(await shown(list)).toEqual([{ label: 'New', age: '1 hour ago' }, { label: 'Other', age: undefined }]);

        manager.applySessionInfoUpdate('a', { title: null });
        expect(await shown(list)).toEqual([{ label: 'Untitled', age: '1 hour ago' }, { label: 'Other', age: undefined }]);
        expect(fake.requests).toEqual([undefined, undefined]);
      });

      it('takes the end of a turn as the session\'s last activity', async () => {
        const fake = loadable([session('a', { title: 'A', updatedAt: '2026-10-18T09:00:00Z' })]);
        const { manager, list } = setup({ fake: fake.script });
        await listed(list, 'fake');
        await manager.loadSession('fake', 'a');
        await list.settled();
        const changes = vi.fn();
        list.on('changed', changes);

        manager.recordTurnEnded('a');

        expect(changes).toHaveBeenCalled();
        const sessions = await listed(list, 'fake');
        expect(sessions.kind === 'listed' && sessions.rows[0]).toMatchObject({
          age: 'now',
          tooltip: expect.stringContaining('Last active: 2026-10-18T12:00:00.000Z') as unknown,
        });
      });

      it('forgets it when invalidated, showing the agent\'s list again', async () => {
        const fake = loadable([session('a', { title: 'Listed', updatedAt: '2026-10-18T09:00:00Z' })]);
        const { manager, list } = setup({ fake: fake.script });
        await listed(list, 'fake');
        await manager.loadSession('fake', 'a');
        await list.settled();
        manager.applySessionInfoUpdate('a', { title: 'Reported' });
        manager.recordTurnEnded('a');

        list.invalidate('fake');

        expect(await shown(list)).toEqual([{ label: 'Listed', age: '3 hours ago' }]);
        expect(fake.requests).toEqual([undefined, undefined, undefined]);
      });
    });

    it('appends the next page on load more', async () => {
      const fake = listingAgent({
        '': { sessions: [session('a')], nextCursor: 'p2' },
        p2: { sessions: [session('b')] },
      });
      const { list } = setup({ fake: fake.script });

      const first = await listed(list, 'fake');
      expect(first).toMatchObject({ more: { kind: 'available' } });

      const loading = list.loadMore('fake');
      expect(await list.sessionsOf('fake')).toMatchObject({ rows: [{ sessionId: 'a' }], more: { kind: 'loading' } });
      await loading;

      expect(await list.sessionsOf('fake')).toMatchObject({ rows: [{ sessionId: 'a' }, { sessionId: 'b' }], more: { kind: 'none' } });
      expect(fake.requests).toEqual([undefined, 'p2']);
    });

    it('keeps the listed sessions and reports a failed load more, which can be retried', async () => {
      let failing = true;
      const fake = listingAgent({
        '': { sessions: [session('a')], nextCursor: 'p2' },
        p2: () => {
          if (failing) {
            throw RequestError.internalError(undefined, 'page expired');
          }
          return { sessions: [session('b')] };
        },
      });
      const { list } = setup({ fake: fake.script });
      await listed(list, 'fake');

      await list.loadMore('fake');
      const failed = await list.sessionsOf('fake');
      expect(failed).toMatchObject({ rows: [{ sessionId: 'a' }], more: { kind: 'failed' } });
      expect(failed.kind === 'listed' && failed.more.kind === 'failed' && failed.more.message).toContain('Internal error');

      failing = false;
      await list.loadMore('fake');
      expect(await list.sessionsOf('fake')).toMatchObject({ rows: [{ sessionId: 'a' }, { sessionId: 'b' }], more: { kind: 'none' } });
    });

    it('reports a failed list without asking again until invalidated', async () => {
      const fake = listingAgent({});
      const { list } = setup({ fake: fake.script });

      const failed = await listed(list, 'fake');
      expect(failed.kind).toBe('failed');
      expect(await list.sessionsOf('fake')).toEqual(failed);
      expect(fake.requests).toHaveLength(1);

      list.invalidate('fake');
      await listed(list, 'fake');
      expect(fake.requests).toHaveLength(2);
    });

    it('ignores a list that arrives after it was invalidated', async () => {
      const replies: ((response: ListSessionsResponse) => void)[] = [];
      const waiting: (() => void)[] = [];
      const nextRequest = () => new Promise<void>((resolve) => waiting.push(resolve));
      const script: AgentScript = () => fakeAgent(listingCaps).onRequest(methods.agent.session.list, () =>
        new Promise<ListSessionsResponse>((resolve) => {
          replies.push(resolve);
          waiting.shift()?.();
        }));
      const { list, manager } = setup({ fake: script });
      const requests = vi.spyOn(manager, 'listSessions');
      onTestFinished(async () => {
        try {
          for (const reply of replies) { reply({ sessions: [] }); }
          await Promise.all(requests.mock.results.map((result) => {
            if (result.type !== 'return') { throw result.value; }
            return result.value;
          }));
        } finally {
          requests.mockRestore();
        }
      });

      const first = nextRequest();
      await list.sessionsOf('fake');
      await first;
      expect(replies).toHaveLength(1);
      list.invalidate('fake');
      const second = nextRequest();
      await list.sessionsOf('fake');
      await second;
      expect(replies).toHaveLength(2);

      const changes = vi.fn();
      list.on('changed', changes);
      replies[0]?.({ sessions: [session('stale')] });
      replies[1]?.({ sessions: [session('fresh')] });
      expect(await listed(list, 'fake')).toMatchObject({ rows: [{ sessionId: 'fresh' }] });
      expect(await list.sessionsOf('fake')).toMatchObject({ rows: [{ sessionId: 'fresh' }] });
      expect(changes).toHaveBeenCalledOnce();
    });

    it('asks for authentication when the user cancels it', async () => {
      const script: AgentScript = () => fakeAgent({ ...listingCaps, authMethods: [{ id: 'token', name: 'Token' }] })
        .onRequest(methods.agent.session.list, () => {
          throw RequestError.authRequired();
        });
      const { list, authPrompt } = setup({ fake: script });

      expect(await listed(list, 'fake')).toEqual({ kind: 'auth-required' });
      expect(authPrompt.chooseAuthMethod).toHaveBeenCalledOnce();
    });

    it('reports other authentication failures as failures, with their message', async () => {
      const script: AgentScript = () => fakeAgent(listingCaps).onRequest(methods.agent.session.list, () => {
        throw RequestError.authRequired();
      });
      const { list } = setup({ fake: script });

      expect(await listed(list, 'fake')).toEqual({
        kind: 'failed',
        message: 'Agent "fake" requires authentication but did not advertise any auth methods.',
      });
    });
  });

  describe('sessions from session history', () => {
    it("lists the references of this host and the workspace's cwd for an agent that loads but cannot list, most recent first", async () => {
      const { references, list } = setup({ fake: () => fakeAgent({ agentCapabilities: { loadSession: true } }) });
      vi.useFakeTimers({ now: Date.parse('2026-10-18T11:00:00Z'), toFake: ['Date'] });
      try {
        await references.used(address('fake', 'untitled'));
        vi.setSystemTime(Date.parse('2026-10-18T11:59:30Z'));
        await references.setTitle(address('fake', 'titled'), 'A title');
        await references.used({ ...address('fake', 'other-cwd'), cwd: '/elsewhere' });
        await references.used({ ...address('fake', 'other-host'), host: 'file://' });
        await references.used(address('other-agent', 'theirs'));
      } finally {
        vi.useRealTimers();
      }

      const sessions = await list.sessionsOf('fake');

      expect(sessions).toMatchObject({ kind: 'listed', source: 'history', more: { kind: 'none' } });
      expect(sessions.kind === 'listed' && sessions.rows.map(({ sessionId, label, age }) => ({ sessionId, label, age }))).toEqual([
        { sessionId: 'titled', label: 'A title', age: 'now' },
        { sessionId: 'untitled', label: 'Untitled', age: '1 hour ago' },
      ]);
      expect(sessions.kind === 'listed' && sessions.rows[0]?.tooltip).toBe(
        'Agent: fake\nSession: titled\ncwd: /work\nLast active: 2026-10-18T11:59:30.000Z\nStored locally — agent does not list sessions',
      );
    });

    it('lists none in a window with no workspace target', async () => {
      const { references, list, withoutWorkspaceTarget } = setup({ fake: () => fakeAgent({ agentCapabilities: { loadSession: true } }) });
      await references.used(address('fake', 'old'));
      withoutWorkspaceTarget();

      expect(await list.sessionsOf('fake')).toEqual({ kind: 'listed', source: 'history', rows: [], more: { kind: 'none' } });
    });
  });

  it('reports an agent that can neither list, load nor resume sessions', async () => {
    const { list } = setup({ plain: () => fakeAgent() });

    expect(await list.sessionsOf('plain')).toEqual({ kind: 'unsupported' });
  });

  it('reports an agent that fails to start, and tries again next time', async () => {
    let starts = 0;
    const { list } = setup({
      broken: () => {
        starts++;
        return agent({ name: 'broken' }).onRequest(methods.agent.initialize, () => {
          throw RequestError.internalError(undefined, 'no initialize');
        });
      },
    });

    expect((await list.sessionsOf('broken')).kind).toBe('failed');
    expect((await list.sessionsOf('broken')).kind).toBe('failed');
    expect(starts).toBe(2);
  });

  it('announces a change when a session or session history changes', async () => {
    const { manager, references, list } = setup({
      fake: () => fakeAgent().onRequest(methods.agent.session.new, () => ({ sessionId: 's1' })),
    });
    const changes = vi.fn();
    list.on('changed', changes);

    await manager.connectToAgent('fake');
    const afterConnect = changes.mock.calls.length;
    expect(afterConnect).toBeGreaterThan(0);

    await references.setTitle(address('fake', 's1'), 'Renamed');
    expect(changes.mock.calls.length).toBeGreaterThan(afterConnect);
  });

  it('stops listening to sessions and session history when disposed', () => {
    const { manager, references, list } = setup({});
    const events = ['session-added', 'session-opened', 'session-removed', 'active-session-changed', 'session-info-changed', 'turn-ended'];
    expect(events.map((event) => manager.listenerCount(event))).toEqual([1, 1, 1, 1, 1, 1]);
    expect(references.listenerCount('changed')).toBe(1);

    list.dispose();

    expect(events.map((event) => manager.listenerCount(event))).toEqual([0, 0, 0, 0, 0, 0]);
    expect(references.listenerCount('changed')).toBe(0);
  });
});
