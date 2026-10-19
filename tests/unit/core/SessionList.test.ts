import { describe, expect, it, vi } from 'vitest';
import { agent, methods, RequestError } from '@agentclientprotocol/sdk';
import type { AgentApp, ListSessionsResponse, SessionInfo } from '@agentclientprotocol/sdk';
import type { ClientHandlers } from '@/core/ClientHandlers';
import { ConnectionManager } from '@/core/ConnectionManager';
import { SessionHistoryStore, type KeyValueStore } from '@/core/SessionHistoryStore';
import { SessionList, type AgentSessions } from '@/core/SessionList';
import { SessionManager, type AuthPrompt } from '@/core/SessionManager';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import { fakeAgent, InProcessAgents, type AgentScript } from './InProcessAgents';

const NOW = Date.parse('2026-10-18T12:00:00Z');

const unused = (): never => {
  throw new Error('not used by these tests');
};
const unusedHandlers: ClientHandlers = {
  files: { readTextFile: unused, writeTextFile: unused },
  terminals: { createTerminal: unused, terminalOutput: unused, waitForTerminalExit: unused, killTerminal: unused, releaseTerminal: unused, dispose() {} },
  permissions: { requestPermission: unused },
};

function memoryStore(): KeyValueStore {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key, value) => { values.set(key, value); },
  };
}

function setup(scripts: Record<string, AgentScript>) {
  const agents = new InProcessAgents(scripts);
  const authPrompt = { chooseAuthMethod: vi.fn<AuthPrompt['chooseAuthMethod']>(async () => undefined) };
  const manager = new SessionManager(
    agents,
    new ConnectionManager(new SessionUpdateHandler(), '0.0.0-test', () => unusedHandlers),
    {
      workspaceCwd: () => '/work',
      agentConfigs: () => Object.fromEntries(Object.keys(scripts).map((name) => [name, { command: name }])),
      activeFileLink: () => undefined,
    },
    authPrompt,
  );
  const history = new SessionHistoryStore(memoryStore());
  manager.setHistoryStore(history);
  const list = new SessionList(manager, history, () => Object.keys(scripts), () => '/work', () => NOW);
  return { agents, manager, history, list, authPrompt };
}

/**
 * The agent's sessions once they are no longer loading. Bounded by looks, not
 * time: in-process agents answer without yielding to timers, so a list that
 * keeps restarting would starve Vitest's timeout.
 */
async function listed(list: SessionList, agentName: string): Promise<AgentSessions> {
  for (let look = 0; look < 20; look++) {
    const sessions = await list.sessionsOf(agentName);
    const loading = sessions.kind === 'loading' || (sessions.kind === 'listed' && sessions.more.kind === 'loading');
    if (!loading) {
      return sessions;
    }
    await new Promise((resolve) => list.once('changed', resolve));
  }
  throw new Error(`Sessions of ${agentName} were still loading after 20 looks`);
}

const listingCaps = { agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } } };

/** An agent that lists sessions in pages keyed by cursor ('' for the first), recording each request. */
function listingAgent(pages: Record<string, ListSessionsResponse | (() => ListSessionsResponse)>, extend = (app: AgentApp) => app) {
  const requests: (string | null | undefined)[] = [];
  const script: AgentScript = () => extend(fakeAgent(listingCaps).onRequest(methods.agent.session.list, ({ params }) => {
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
      const { manager, history, list } = setup({ plain: () => fakeAgent() });
      await manager.ensureConnected('plain');
      expect(list.agents()).toEqual([{ name: 'plain', hasSession: false, expandable: false }]);

      history.upsertNew('plain', '/work', 'old');
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
            age: '3h ago',
            isActive: true,
            tooltip: 'Agent: fake\nSession: titled\ncwd: /work\nLast active: 2026-10-18T09:00:00Z\nListed by agent',
          },
          {
            sessionId: '0123456789abcdefghij',
            label: '01234567…ghij',
            age: '1w ago',
            isActive: false,
            tooltip: 'Agent: fake\nSession: 0123456789abcdefghij\ncwd: /work\nLast active: 2026-10-11T12:00:00Z\nListed by agent',
          },
        ],
      });
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
      const script: AgentScript = () => fakeAgent(listingCaps).onRequest(methods.agent.session.list, () =>
        new Promise<ListSessionsResponse>((resolve) => replies.push(resolve)));
      const { list } = setup({ fake: script });

      await list.sessionsOf('fake');
      await vi.waitFor(() => expect(replies).toHaveLength(1));
      list.invalidate('fake');
      await list.sessionsOf('fake');
      await vi.waitFor(() => expect(replies).toHaveLength(2));

      replies[1]?.({ sessions: [session('fresh')] });
      expect(await listed(list, 'fake')).toMatchObject({ rows: [{ sessionId: 'fresh' }] });
      replies[0]?.({ sessions: [session('stale')] });
      await new Promise((resolve) => setImmediate(resolve));
      expect(await list.sessionsOf('fake')).toMatchObject({ rows: [{ sessionId: 'fresh' }] });
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
    it('lists the workspace\'s entries for an agent that loads but cannot list, most recent first', async () => {
      const { history, list } = setup({ fake: () => fakeAgent({ agentCapabilities: { loadSession: true } }) });
      vi.useFakeTimers({ now: Date.parse('2026-10-18T11:00:00Z'), toFake: ['Date'] });
      try {
        history.upsertNew('fake', '/work', 'untitled-session-id');
        vi.setSystemTime(Date.parse('2026-10-18T11:30:00Z'));
        history.upsertNew('fake', '/work', 'prompted');
        history.setFirstPromptIfMissing('fake', 'prompted', `  ${'p'.repeat(70)}  `);
        vi.setSystemTime(Date.parse('2026-10-18T11:59:30Z'));
        history.upsertNew('fake', '/work', 'titled');
        history.setTitle('fake', 'titled', 'A title');
        history.upsertNew('fake', '/elsewhere', 'other-workspace');
      } finally {
        vi.useRealTimers();
      }

      const sessions = await list.sessionsOf('fake');

      expect(sessions).toMatchObject({ kind: 'listed', source: 'history', more: { kind: 'none' } });
      expect(sessions.kind === 'listed' && sessions.rows.map(({ sessionId, label, age }) => ({ sessionId, label, age }))).toEqual([
        { sessionId: 'titled', label: 'A title', age: '30s ago' },
        { sessionId: 'prompted', label: `${'p'.repeat(59)}…`, age: '30m ago' },
        { sessionId: 'untitled-session-id', label: 'untitled…n-id', age: '1h ago' },
      ]);
      expect(sessions.kind === 'listed' && sessions.rows[0]?.tooltip).toBe(
        'Agent: fake\nSession: titled\ncwd: /work\nLast active: 2026-10-18T11:59:30.000Z\nStored locally — agent does not list sessions',
      );
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
    const { manager, history, list } = setup({
      fake: () => fakeAgent().onRequest(methods.agent.session.new, () => ({ sessionId: 's1' })),
    });
    const changes = vi.fn();
    list.on('changed', changes);

    await manager.connectToAgent('fake');
    const afterConnect = changes.mock.calls.length;
    expect(afterConnect).toBeGreaterThan(0);

    history.setTitle('fake', 's1', 'Renamed');
    expect(changes.mock.calls.length).toBeGreaterThan(afterConnect);
  });

  it('stops listening to sessions and session history when disposed', () => {
    const { manager, history, list } = setup({});
    const events = ['session-added', 'session-removed', 'active-session-changed', 'session-info-changed'];
    expect(events.map((event) => manager.listenerCount(event))).toEqual([1, 1, 1, 1]);
    expect(history.listenerCount('changed')).toBe(1);

    list.dispose();

    expect(events.map((event) => manager.listenerCount(event))).toEqual([0, 0, 0, 0]);
    expect(history.listenerCount('changed')).toBe(0);
  });
});
