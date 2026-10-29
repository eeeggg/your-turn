import { afterEach, describe, expect, it } from 'vitest';
import { setLogSink, type LogSink } from '@/core/Log';
import {
  SessionReferences,
  WorkspaceState,
  type KeyValueStore,
  type SessionAddress,
  type SessionReference,
} from '@/core/PersistedState';

const REFERENCES_KEY = 'acp.sessionReferences';
const WORKSPACE_KEY = 'acp.workspace';

const LOCAL = 'file:///home/me/work';
const DEVENV = 'vscode-remote://ssh-remote%2Bdevenv/home/me/work';
const DEVENV_WORKSPACE = 'vscode-remote://ssh-remote%2Bdevenv/home/me/both.code-workspace';
/** A remote window's workspace file saved on the client: its URI is on the client, its folders and agents on devenv. */
const CLIENT_WORKSPACE = 'file:///Users/me/Desktop/both.code-workspace';

/** Stands in for VS Code's state, which outlives the extension: new objects over the same one are a restart. */
function memoryStore(saved: Record<string, unknown> = {}): KeyValueStore & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>(Object.entries(saved));
  return {
    values,
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key, value) => {
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
    },
  };
}

/** Like VS Code's state, reads a change back at once, but finishes writing it only when the test calls `finish[n]`. */
function heldStore(saved: Record<string, unknown> = {}): KeyValueStore & { values: Map<string, unknown>; finish: (() => void)[] } {
  const store = memoryStore(saved);
  const finish: (() => void)[] = [];
  return {
    ...store,
    finish,
    update: (key, value) => {
      void store.update(key, value);
      return new Promise<void>((resolve) => finish.push(resolve));
    },
  };
}

/**
 * Like VS Code's global state, which can serve a value it held before a write that has already finished, until it is
 * written again. `serveEarlier(key, n)` serves the value from `n` writes back, or nothing before the first.
 */
function revertibleStore(saved: Record<string, unknown> = {}): KeyValueStore & {
  values: Map<string, unknown>;
  serveEarlier: (key: string, writesBack?: number) => void;
} {
  const store = memoryStore(saved);
  const held = new Map<string, unknown[]>(Object.entries(saved).map(([key, value]) => [key, [value]]));
  return {
    ...store,
    update: async (key, value) => {
      held.set(key, [...(held.get(key) ?? []), value]);
      await store.update(key, value);
    },
    serveEarlier: (key, writesBack = 1) => {
      const values = held.get(key) ?? [];
      const value = values[values.length - 1 - writesBack];
      if (value === undefined) {
        store.values.delete(key);
      } else {
        store.values.set(key, value);
      }
    },
  };
}

/** A clock that moves on a minute each time it is read, so each change is later than the one before. */
function ticking(): () => number {
  let now = Date.parse('2026-10-29T10:00:00Z');
  return () => (now += 60_000);
}

/** A clock that stands still until the test moves it on. */
function stopped(): (() => number) & { advance: (ms: number) => void } {
  let now = Date.parse('2026-10-29T10:00:00Z');
  return Object.assign(() => now, { advance: (ms: number) => { now += ms; } });
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The hosts of the workspaces these tests use; the adapter learns a host, and these only stand in for it. */
const HOSTS: Readonly<Record<string, string>> = { [LOCAL]: 'local', [DEVENV]: 'devenv', [DEVENV_WORKSPACE]: 'devenv' };

/** An address on the host its workspace URI is on, unless `fields` gives another. */
function address(sessionId: string, fields: Partial<SessionAddress> = {}): SessionAddress {
  const workspaceUri = fields.workspaceUri ?? DEVENV;
  return { configuredName: 'OpenCode', sessionId, cwd: '/home/me/work', host: HOSTS[workspaceUri] ?? 'unknown', workspaceUri, ...fields };
}

function reference(sessionId: string, fields: Partial<SessionReference> = {}): SessionReference {
  return { ...address(sessionId), lastActiveAt: '2026-10-29T09:00:00.000Z', selections: { options: {} }, ...fields };
}

const devenv = 'devenv';
const ids = (references: SessionReference[]) => references.map((r) => r.sessionId);
const idOf = (sessionId: string) => ({ host: devenv, configuredName: 'OpenCode', sessionId });
const listed = (references: SessionReferences) => ids(references.list(devenv, 'OpenCode', '/home/me/work')).sort();

describe('SessionReferences', () => {
  afterEach(() => setLogSink(undefined));

  describe('across restarts', () => {
    it('reads back what was saved before', async () => {
      const globalState = memoryStore();
      const before = new SessionReferences(globalState, ticking());
      await before.used(address('a'));
      await before.used(address('b'));
      await before.setTitle(address('b'), 'Fix the build');
      await before.saveSelections(address('a'), { options: { model: 'big' } });

      const after = new SessionReferences(globalState);

      expect(after.list(devenv, 'OpenCode', '/home/me/work')).toEqual(before.list(devenv, 'OpenCode', '/home/me/work'));
      expect(after.list(devenv, 'OpenCode', '/home/me/work')).toMatchObject([
        { sessionId: 'b', title: 'Fix the build' },
        { sessionId: 'a', selections: { options: { model: 'big' } } },
      ]);
    });

    it('keeps what another instance over the same store saved meanwhile', async () => {
      const globalState = memoryStore();
      const one = new SessionReferences(globalState, ticking());
      const other = new SessionReferences(globalState, ticking());

      await one.used(address('a'));
      await other.used(address('b'));
      await one.setTitle(address('a'), 'From one');

      expect(ids(new SessionReferences(globalState).list(devenv, 'OpenCode', '/home/me/work')).sort()).toEqual(['a', 'b']);
      expect(other.get({ host: devenv, configuredName: 'OpenCode', sessionId: 'a' })?.title).toBe('From one');
    });
  });

  describe('saved data', () => {
    it.each([
      ['nothing', undefined],
      ['a value that is not an object', 'references'],
      ['an object without a version', { references: [reference('a')] }],
      ['an earlier version', { schemaVersion: 0, references: [reference('a')] }],
      ['the first version, which had no revisions', { schemaVersion: 1, references: [reference('a')] }],
      ['the second version, which derived hosts', { schemaVersion: 2, epoch: 0, references: [{ ...reference('a'), revision: 1 }], removed: [] }],
    ])('starts empty from %s, and replaces it on the first change', async (_, saved) => {
      const globalState = memoryStore(saved === undefined ? {} : { [REFERENCES_KEY]: saved });
      const references = new SessionReferences(globalState, ticking());

      expect(references.list(devenv, 'OpenCode', '/home/me/work')).toEqual([]);
      await references.used(address('b'));

      expect(globalState.values.get(REFERENCES_KEY)).toMatchObject({
        schemaVersion: 3,
        epoch: 0,
        references: [{ ...address('b'), revision: 1 }],
        removed: [],
      });
    });

    it('reads a later version as empty and never overwrites it', async () => {
      const later = { schemaVersion: 4, references: [{ something: 'new' }] };
      const globalState = memoryStore({ [REFERENCES_KEY]: later });
      const references = new SessionReferences(globalState, ticking());

      await references.used(address('a'));
      await references.setTitle(address('a'), 'Title');
      await references.saveSelections(address('a'), { modeId: 'plan', options: {} });
      await references.remove({ host: devenv, configuredName: 'OpenCode', sessionId: 'a' });

      expect(references.list(devenv, 'OpenCode', '/home/me/work')).toEqual([]);
      expect(globalState.values.get(REFERENCES_KEY)).toBe(later);
    });

    it('drops the references and removal records that are malformed and keeps the rest', async () => {
      const removal = { host: devenv, configuredName: 'OpenCode', revision: 2, removedAt: '2026-10-29T09:00:00.000Z' };
      const globalState = memoryStore({
        [REFERENCES_KEY]: {
          schemaVersion: 3,
          epoch: 0,
          references: [
            null,
            'not a reference',
            { ...reference('no-cwd'), cwd: undefined, revision: 1 },
            { ...reference('no-host'), host: undefined, revision: 1 },
            { ...reference('numeric-time'), lastActiveAt: 5, revision: 1 },
            { ...reference('numeric-title'), title: 5, revision: 1 },
            { ...reference('no-selections'), selections: undefined, revision: 1 },
            { ...reference('numeric-mode'), selections: { modeId: 5, options: {} }, revision: 1 },
            { ...reference('object-option'), selections: { options: { model: { id: 'big' } } }, revision: 1 },
            reference('no-revision'),
            { ...reference('fractional-revision'), revision: 1.5 },
            { ...reference('removal-without-time'), revision: 1 },
            { ...reference('removal-with-text-revision'), revision: 1 },
            { ...reference('good', { title: 'Good', selections: { modeId: 'plan', options: { model: 'big', brave: true } } }), revision: 1 },
          ],
          removed: [
            null,
            { ...removal, sessionId: 'removal-without-time', removedAt: undefined },
            { ...removal, sessionId: 'removal-with-text-revision', revision: '2' },
          ],
        },
      });

      const references = new SessionReferences(globalState);

      expect(listed(references)).toEqual(['good', 'removal-with-text-revision', 'removal-without-time']);
      expect(references.get(idOf('good')))
        .toEqual(reference('good', { title: 'Good', selections: { modeId: 'plan', options: { model: 'big', brave: true } } }));

      // A reference with no host is never listed, so only what a write stores shows it dropped.
      await references.used(address('good'));
      const stored = globalState.values.get(REFERENCES_KEY) as { references: SessionReference[] };
      expect(ids(stored.references).sort()).toEqual(['good', 'removal-with-text-revision', 'removal-without-time']);
    });

    it('hides a reference behind a removal record of a higher revision', () => {
      const globalState = memoryStore({
        [REFERENCES_KEY]: {
          schemaVersion: 3,
          epoch: 0,
          references: [{ ...reference('removed'), revision: 1 }, { ...reference('kept'), revision: 3 }],
          removed: [
            { host: devenv, configuredName: 'OpenCode', sessionId: 'removed', revision: 2, removedAt: '2026-10-29T09:00:00.000Z' },
            { host: devenv, configuredName: 'OpenCode', sessionId: 'kept', revision: 2, removedAt: '2026-10-29T09:00:00.000Z' },
          ],
        },
      });

      expect(listed(new SessionReferences(globalState))).toEqual(['kept']);
    });

    it('keeps only the fields of a reference, whatever else the caller passes', async () => {
      const globalState = memoryStore();
      const references = new SessionReferences(globalState, ticking());

      await references.used({ ...address('a'), transcript: 'not ours to keep' } as SessionAddress);

      const [saved] = (globalState.values.get(REFERENCES_KEY) as { references: object[] }).references;
      expect(Object.keys(saved ?? {}).sort())
        .toEqual(['configuredName', 'cwd', 'host', 'lastActiveAt', 'revision', 'selections', 'sessionId', 'workspaceUri']);
    });
  });

  describe('identity', () => {
    it('keeps the same session ID apart on another host or through another configuration', async () => {
      const references = new SessionReferences(memoryStore(), ticking());

      await references.setTitle(address('s'), 'devenv');
      await references.setTitle(address('s', { workspaceUri: LOCAL }), 'local');
      await references.setTitle(address('s', { configuredName: 'OpenCode 2' }), 'renamed');

      expect(references.get({ host: devenv, configuredName: 'OpenCode', sessionId: 's' })?.title).toBe('devenv');
      expect(references.get({ host: 'local', configuredName: 'OpenCode', sessionId: 's' })?.title).toBe('local');
      expect(references.get({ host: devenv, configuredName: 'OpenCode 2', sessionId: 's' })?.title).toBe('renamed');
    });

    it('treats a folder and a saved workspace on one host as the same reference, keeping the workspace last used', async () => {
      const references = new SessionReferences(memoryStore(), ticking());

      await references.used(address('s'));
      await references.used(address('s', { workspaceUri: DEVENV_WORKSPACE }));

      expect(references.list(devenv, 'OpenCode', '/home/me/work')).toEqual([
        expect.objectContaining({ sessionId: 's', workspaceUri: DEVENV_WORKSPACE }),
      ]);
    });

    it('keeps a reference on the host it was recorded with, whatever machine its workspace URI is on', async () => {
      const references = new SessionReferences(memoryStore(), ticking());

      await references.used(address('s'));
      await references.used(address('s', { workspaceUri: CLIENT_WORKSPACE, host: devenv }));
      await references.used(address('t', { workspaceUri: CLIENT_WORKSPACE, host: devenv }));

      expect(references.list(devenv, 'OpenCode', '/home/me/work')).toEqual([
        expect.objectContaining({ sessionId: 't', host: devenv, workspaceUri: CLIENT_WORKSPACE }),
        expect.objectContaining({ sessionId: 's', host: devenv, workspaceUri: CLIENT_WORKSPACE }),
      ]);
      expect(references.list('file://', 'OpenCode', '/home/me/work')).toEqual([]);
      await references.remove(idOf('t'));
      expect(listed(references)).toEqual(['s']);
    });

    it('lists only the host, configuration and exact cwd asked for, the most recently active first', async () => {
      const references = new SessionReferences(memoryStore(), ticking());
      await references.used(address('older'));
      await references.used(address('local', { workspaceUri: LOCAL }));
      await references.used(address('other-agent', { configuredName: 'Codex' }));
      await references.used(address('other-cwd', { cwd: '/home/me/work/sub' }));
      await references.used(address('newer'));

      expect(ids(references.list(devenv, 'OpenCode', '/home/me/work'))).toEqual(['newer', 'older']);
      expect(ids(references.list('local', 'OpenCode', '/home/me/work'))).toEqual(['local']);
    });
  });

  describe('changes', () => {
    it('marks a session active when used, and not when only its title or selections change', async () => {
      const references = new SessionReferences(memoryStore(), ticking());
      await references.used(address('a'));
      await references.used(address('b'));

      await references.setTitle(address('a'), 'Renamed');
      await references.saveSelections(address('a'), { modeId: 'plan', options: {} });
      expect(ids(references.list(devenv, 'OpenCode', '/home/me/work'))).toEqual(['b', 'a']);

      await references.used(address('a'));
      expect(ids(references.list(devenv, 'OpenCode', '/home/me/work'))).toEqual(['a', 'b']);
    });

    it('creates a missing reference on any change to the session', async () => {
      const references = new SessionReferences(memoryStore(), ticking());

      await references.setTitle(address('titled'), 'Titled');
      await references.saveSelections(address('selected'), { options: { brave: true } });

      expect(references.list(devenv, 'OpenCode', '/home/me/work')).toEqual([
        expect.objectContaining({ sessionId: 'selected', selections: { options: { brave: true } } }),
        expect.objectContaining({ sessionId: 'titled', title: 'Titled' }),
      ]);
    });

    it('clears the cached title when the agent reports none', async () => {
      const references = new SessionReferences(memoryStore(), ticking());
      await references.setTitle(address('a'), 'Old title');

      await references.setTitle(address('a'), null);

      expect(references.get({ host: devenv, configuredName: 'OpenCode', sessionId: 'a' })).not.toHaveProperty('title');
    });

    it('replaces the saved selections as a whole', async () => {
      const references = new SessionReferences(memoryStore(), ticking());

      await references.saveSelections(address('a'), { modeId: 'plan', options: { model: 'big', effort: 'high' } });
      await references.saveSelections(address('a'), { options: { model: 'small' } });

      expect(references.get({ host: devenv, configuredName: 'OpenCode', sessionId: 'a' })?.selections)
        .toEqual({ options: { model: 'small' } });
    });

    it('keeps at most its capacity, dropping the least recently active', async () => {
      const references = new SessionReferences(memoryStore(), ticking(), 3);
      for (const id of ['a', 'b', 'c']) {
        await references.used(address(id));
      }
      await references.used(address('a'));

      await references.used(address('d', { workspaceUri: LOCAL }));

      expect(ids(references.list(devenv, 'OpenCode', '/home/me/work'))).toEqual(['a', 'c']);
      expect(ids(references.list('local', 'OpenCode', '/home/me/work'))).toEqual(['d']);
    });

    it('holds 500 by default', async () => {
      const references = new SessionReferences(memoryStore(), ticking());
      for (let i = 0; i <= 500; i++) {
        await references.used(address(`s${i}`));
      }

      expect(references.list(devenv, 'OpenCode', '/home/me/work')).toHaveLength(500);
      expect(references.get({ host: devenv, configuredName: 'OpenCode', sessionId: 's0' })).toBeUndefined();
    });

    it('removes only the reference asked for', async () => {
      const references = new SessionReferences(memoryStore(), ticking());
      await references.used(address('a'));
      await references.used(address('a', { workspaceUri: LOCAL }));
      await references.used(address('b'));

      await references.remove({ host: devenv, configuredName: 'OpenCode', sessionId: 'a' });

      expect(ids(references.list(devenv, 'OpenCode', '/home/me/work'))).toEqual(['b']);
      expect(ids(references.list('local', 'OpenCode', '/home/me/work'))).toEqual(['a']);
    });

    it('announces each change it writes', async () => {
      const references = new SessionReferences(memoryStore(), ticking());
      let announced = 0;
      references.on('changed', () => { announced++; });

      await references.used(address('a'));
      await references.remove({ host: devenv, configuredName: 'OpenCode', sessionId: 'unknown' });

      expect(announced).toBe(1);
    });

    it('logs a failed write instead of failing the change', async () => {
      const errors: string[] = [];
      setLogSink({ error: (message: string) => { errors.push(message); } } as unknown as LogSink);
      const failing: KeyValueStore = { get: () => undefined, update: () => Promise.reject(new Error('disk full')) };

      await new SessionReferences(failing, ticking()).used(address('a'));

      expect(errors).toEqual(['Failed to save session references']);
    });
  });

  describe('rebinding', () => {
    it("moves one configuration's references on one host to its new name, with all they hold", async () => {
      const references = new SessionReferences(memoryStore(), ticking());
      const under = (configuredName: string, host = devenv) => ids(references.list(host, configuredName, '/home/me/work'));
      await references.used(address('a'));
      await references.setTitle(address('a'), 'Kept title');
      await references.saveSelections(address('a'), { options: { model: 'big' } });
      await references.used(address('b', { workspaceUri: LOCAL }));
      await references.used(address('c', { configuredName: 'Claude' }));
      const before = references.get(idOf('a'));

      await references.rebind(devenv, 'OpenCode', 'oc');

      expect([under('oc'), under('OpenCode'), under('OpenCode', 'local'), under('Claude')]).toEqual([['a'], [], ['b'], ['c']]);
      expect(references.get({ ...idOf('a'), configuredName: 'oc' })).toEqual({ ...before, configuredName: 'oc' });
    });

    it('merges with a reference already under the new name, keeping the more recently active', async () => {
      const references = new SessionReferences(memoryStore(), ticking());
      await references.setTitle(address('x', { configuredName: 'oc' }), 'Older under the new name');
      await references.setTitle(address('x'), 'Newer under the old name');
      await references.setTitle(address('y'), 'Older under the old name');
      await references.saveSelections(address('y', { configuredName: 'oc' }), { options: { model: 'small' } });

      await references.rebind(devenv, 'OpenCode', 'oc');

      const rebound = (sessionId: string) => references.get({ ...idOf(sessionId), configuredName: 'oc' });
      expect(rebound('x')).toMatchObject({ title: 'Newer under the old name' });
      expect(rebound('y')).toMatchObject({ selections: { options: { model: 'small' } } });
      expect(rebound('y')).not.toHaveProperty('title');
      expect(references.list(devenv, 'OpenCode', '/home/me/work')).toEqual([]);
    });

    it('changes nothing when applied again', async () => {
      const references = new SessionReferences(memoryStore(), ticking());
      await references.used(address('a'));
      await references.rebind(devenv, 'OpenCode', 'oc');
      let announced = 0;
      references.on('changed', () => { announced++; });

      await references.rebind(devenv, 'OpenCode', 'oc');

      expect(announced).toBe(0);
    });
  });

  describe('observing a listing', () => {
    async function seeded() {
      const references = new SessionReferences(memoryStore(), ticking());
      await references.setTitle(address('listed'), 'Old title');
      await references.setTitle(address('untitled-now'), 'Had a title');
      await references.used(address('gone'));
      await references.used(address('open'));
      await references.used(address('other-cwd', { cwd: '/home/me/work/sub' }));
      await references.used(address('other-agent', { configuredName: 'Codex' }));
      await references.used(address('gone', { workspaceUri: LOCAL }));
      return references;
    }

    const listing = {
      host: devenv,
      configuredName: 'OpenCode',
      sessions: [
        { sessionId: 'listed', title: 'New title' },
        { sessionId: 'untitled-now' },
        { sessionId: 'never-referenced', title: 'Not ours' },
      ],
    };

    it('refreshes the titles of referenced sessions, clearing those listed without one, and adds no others', async () => {
      const references = await seeded();

      await references.observeListing(listing);

      const listed = references.list(devenv, 'OpenCode', '/home/me/work');
      expect(listed.find((r) => r.sessionId === 'listed')?.title).toBe('New title');
      expect(listed.find((r) => r.sessionId === 'untitled-now')).not.toHaveProperty('title');
      expect(ids(listed)).not.toContain('never-referenced');
      expect(ids(listed)).toContain('gone');
    });

    it('prunes by a complete listing only within its host, configuration and cwd, keeping sessions open in this window', async () => {
      const references = await seeded();

      await references.observeListing({ ...listing, complete: { cwd: '/home/me/work', openInThisWindow: new Set(['open']) } });

      expect(ids(references.list(devenv, 'OpenCode', '/home/me/work')).sort()).toEqual(['listed', 'open', 'untitled-now']);
      expect(ids(references.list(devenv, 'OpenCode', '/home/me/work/sub'))).toEqual(['other-cwd']);
      expect(ids(references.list(devenv, 'Codex', '/home/me/work'))).toEqual(['other-agent']);
      expect(ids(references.list('local', 'OpenCode', '/home/me/work'))).toEqual(['gone']);
    });

    it('writes nothing when the listing changes nothing', async () => {
      const globalState = memoryStore();
      const references = new SessionReferences(globalState, ticking());
      await references.setTitle(address('listed'), 'New title');
      const saved = globalState.values.get(REFERENCES_KEY);

      await references.observeListing({ ...listing, complete: { cwd: '/home/me/work', openInThisWindow: new Set() } });

      expect(globalState.values.get(REFERENCES_KEY)).toBe(saved);
    });
  });

  describe('while an earlier value is served', () => {
    it('still shows its own changes', async () => {
      const globalState = revertibleStore();
      const references = new SessionReferences(globalState, ticking());
      await references.used(address('a'));
      await references.setTitle(address('a'), 'Named');

      globalState.serveEarlier(REFERENCES_KEY);

      expect(references.get(idOf('a'))?.title).toBe('Named');
    });

    it('writes no earlier value back', async () => {
      const globalState = revertibleStore();
      const references = new SessionReferences(globalState, ticking());
      await references.used(address('a'));
      await references.setTitle(address('a'), 'Named');

      globalState.serveEarlier(REFERENCES_KEY);
      await references.used(address('b'));

      const after = new SessionReferences(globalState);
      expect(listed(after)).toEqual(['a', 'b']);
      expect(after.get(idOf('a'))?.title).toBe('Named');
    });

    it.each([
      ['removed', (references: SessionReferences) => references.remove(idOf('a'))],
      ['pruned by a complete listing', (references: SessionReferences) => references.observeListing({
        host: devenv,
        configuredName: 'OpenCode',
        sessions: [{ sessionId: 'b' }],
        complete: { cwd: '/home/me/work', openInThisWindow: new Set() },
      })],
    ])('does not bring back a reference it %s', async (_, removal) => {
      const globalState = revertibleStore();
      const references = new SessionReferences(globalState, ticking());
      await references.used(address('a'));
      await references.used(address('b'));
      await removal(references);

      globalState.serveEarlier(REFERENCES_KEY);
      expect(listed(references)).toEqual(['b']);
      await references.used(address('c'));

      expect(listed(new SessionReferences(globalState))).toEqual(['b', 'c']);
    });

    it('does not bring back references it reset', async () => {
      const globalState = revertibleStore();
      const references = new SessionReferences(globalState, ticking());
      await references.used(address('a'));
      await references.reset();

      globalState.serveEarlier(REFERENCES_KEY);
      expect(listed(references)).toEqual([]);
      await references.used(address('b'));

      expect(listed(new SessionReferences(globalState))).toEqual(['b']);
      expect(globalState.values.get(REFERENCES_KEY)).toMatchObject({ epoch: 1 });
    });

    it('forgets its own change once it has read a later one made elsewhere', async () => {
      const globalState = revertibleStore();
      const one = new SessionReferences(globalState, ticking());
      const other = new SessionReferences(globalState, ticking());
      await one.setTitle(address('a'), 'One');
      await other.setTitle(address('a'), 'Other');
      expect(one.get(idOf('a'))?.title).toBe('Other');

      globalState.serveEarlier(REFERENCES_KEY, 2);

      expect(one.get(idOf('a'))).toBeUndefined();
    });

    it('stops showing its own changes a day after making them', async () => {
      const globalState = revertibleStore();
      const clock = stopped();
      const references = new SessionReferences(globalState, clock);
      await references.used(address('a'));
      globalState.serveEarlier(REFERENCES_KEY);

      clock.advance(DAY - 1);
      expect(listed(references)).toEqual(['a']);
      clock.advance(1);
      expect(listed(references)).toEqual([]);
    });
  });

  describe('across windows', () => {
    it('keeps both changes when two windows write from overlapping reads', async () => {
      const globalState = revertibleStore();
      const one = new SessionReferences(globalState, ticking());
      const other = new SessionReferences(globalState, ticking());
      await one.used(address('a'));

      globalState.serveEarlier(REFERENCES_KEY);
      await other.used(address('b'));
      expect(listed(one)).toEqual(['a', 'b']);
      await one.used(address('c'));

      expect(listed(new SessionReferences(globalState))).toEqual(['a', 'b', 'c']);
    });

    it('settles a change and a removal made from the same revision on the removal, in every window', async () => {
      const globalState = revertibleStore();
      const one = new SessionReferences(globalState, ticking());
      const other = new SessionReferences(globalState, ticking());
      await one.used(address('a'));
      await other.remove(idOf('a'));

      globalState.serveEarlier(REFERENCES_KEY);
      await one.setTitle(address('a'), 'One');
      await other.used(address('b'));

      expect(one.get(idOf('a'))).toBeUndefined();
      expect(other.get(idOf('a'))).toBeUndefined();
      expect(new SessionReferences(globalState).get(idOf('a'))).toBeUndefined();
    });

    it('settles two changes made from the same revision on the same one, in every window', async () => {
      const globalState = revertibleStore();
      const one = new SessionReferences(globalState, ticking());
      const other = new SessionReferences(globalState, ticking());
      await one.used(address('a'));
      await other.setTitle(address('a'), 'Other');

      globalState.serveEarlier(REFERENCES_KEY);
      await one.setTitle(address('a'), 'One');
      await other.used(address('b'));

      expect(one.get(idOf('a'))?.title).toBe('Other');
      expect(other.get(idOf('a'))?.title).toBe('Other');
      expect(new SessionReferences(globalState).get(idOf('a'))?.title).toBe('Other');
    });

    it('drops its own earlier changes once it reads a reset made elsewhere', async () => {
      const globalState = revertibleStore();
      const one = new SessionReferences(globalState, ticking());
      const other = new SessionReferences(globalState, ticking());
      await one.used(address('a'));

      await other.reset();
      await one.used(address('b'));

      expect(listed(one)).toEqual(['b']);
      expect(listed(new SessionReferences(globalState))).toEqual(['b']);
    });
  });

  describe('removal records', () => {
    it('keeps a removal record for 30 days, then prunes it on a write', async () => {
      const globalState = memoryStore();
      const clock = stopped();
      const references = new SessionReferences(globalState, clock);
      await references.used(address('a'));
      await references.remove(idOf('a'));
      const removed = () => (globalState.values.get(REFERENCES_KEY) as { removed: unknown[] }).removed;

      clock.advance(30 * DAY - 1);
      await references.used(address('b'));
      expect(removed()).toEqual([{ host: devenv, configuredName: 'OpenCode', sessionId: 'a', revision: 2, removedAt: '2026-10-29T10:00:00.000Z' }]);

      clock.advance(1);
      await references.used(address('c'));
      expect(removed()).toEqual([]);
    });

    it('leaves none for a reference evicted past its capacity', async () => {
      const globalState = memoryStore();
      const references = new SessionReferences(globalState, ticking(), 1);
      await references.used(address('a'));
      await references.used(address('b'));

      expect(globalState.values.get(REFERENCES_KEY)).toMatchObject({ references: [{ sessionId: 'b' }], removed: [] });
      expect(listed(references)).toEqual(['b']);
    });

    it('lets a session removed earlier be referenced again', async () => {
      const references = new SessionReferences(memoryStore(), ticking());
      await references.used(address('a'));
      await references.remove(idOf('a'));

      await references.used(address('a'));

      expect(listed(references)).toEqual(['a']);
    });
  });

  describe('settlement', () => {
    it('settles once every write it started has, as its callers do not wait for them', async () => {
      const globalState = heldStore();
      const references = new SessionReferences(globalState, ticking());
      const order: string[] = [];
      const first = references.used(address('a'));
      const second = references.setTitle(address('b'), 'Fix the build');
      const settled = references.settled().then(() => order.push('settled'));

      globalState.finish[1]?.();
      await second;
      order.push('second written');
      globalState.finish[0]?.();
      await first;
      order.push('first written');
      await settled;

      expect(order).toEqual(['second written', 'first written', 'settled']);
    });

    it('on disposal, settles the writes it started and makes no more', async () => {
      const globalState = heldStore();
      const references = new SessionReferences(globalState, ticking());
      let announced = 0;
      references.on('changed', () => { announced++; });
      const order: string[] = [];
      const writing = references.used(address('a'));
      const disposed = references.dispose().then(() => order.push('disposed'));

      void references.used(address('b'));
      globalState.finish[0]?.();
      await writing;
      order.push('written');
      await disposed;

      expect(order).toEqual(['written', 'disposed']);
      expect(ids(references.list(devenv, 'OpenCode', '/home/me/work'))).toEqual(['a']);
      expect(announced).toBe(1);
    });
  });
});

describe('WorkspaceState', () => {
  it('reads back the last active session saved before', async () => {
    const workspaceState = memoryStore();
    await new WorkspaceState(workspaceState).setLastActiveSession({ ...address('a'), extra: 'dropped' } as SessionAddress);

    expect(new WorkspaceState(workspaceState).lastActiveSession()).toEqual(address('a'));
    expect(workspaceState.values.get(WORKSPACE_KEY)).toEqual({ schemaVersion: 2, lastActiveSession: address('a') });
  });

  it.each([
    ['nothing', undefined],
    ['a malformed session', { schemaVersion: 2, lastActiveSession: { ...address('a'), cwd: 5 } }],
    ['a session without a host', { schemaVersion: 2, lastActiveSession: { ...address('a'), host: undefined } }],
    ['an earlier version', { schemaVersion: 0, lastActiveSession: address('a') }],
    ['the first version, which derived hosts', { schemaVersion: 1, lastActiveSession: address('a') }],
  ])('has no last active session from %s', (_, saved) => {
    const workspaceState = memoryStore(saved === undefined ? {} : { [WORKSPACE_KEY]: saved });

    expect(new WorkspaceState(workspaceState).lastActiveSession()).toBeUndefined();
  });

  const onDevenv = { uri: DEVENV, host: devenv };
  const onClient = { uri: CLIENT_WORKSPACE, host: devenv };

  it('reads back the workspace target saved before, whose URI may be on another machine than its host', async () => {
    const workspaceState = memoryStore();
    await new WorkspaceState(workspaceState).setWorkspaceTarget({ ...onClient, extra: 'dropped' } as typeof onClient);

    expect(new WorkspaceState(workspaceState).workspaceTarget()).toEqual(onClient);
    expect(workspaceState.values.get(WORKSPACE_KEY)).toEqual({ schemaVersion: 2, workspaceTarget: onClient });
  });

  it('keeps the workspace target when the last active session changes, and the session when the target does', async () => {
    const workspaceState = memoryStore();
    const state = new WorkspaceState(workspaceState);

    await state.setWorkspaceTarget(onDevenv);
    await state.setLastActiveSession(address('a'));
    await state.setWorkspaceTarget(onClient);

    expect(workspaceState.values.get(WORKSPACE_KEY)).toEqual({ schemaVersion: 2, lastActiveSession: address('a'), workspaceTarget: onClient });
  });

  it.each([
    ['nothing', undefined],
    ['a target that is not an object', { schemaVersion: 2, workspaceTarget: DEVENV }],
    ['a malformed URI', { schemaVersion: 2, workspaceTarget: { uri: 5, host: devenv } }],
    ['an empty URI', { schemaVersion: 2, workspaceTarget: { uri: '', host: devenv } }],
    ['no host', { schemaVersion: 2, workspaceTarget: { uri: DEVENV } }],
    ['an empty host', { schemaVersion: 2, workspaceTarget: { uri: DEVENV, host: '' } }],
    ['an earlier version', { schemaVersion: 0, workspaceTarget: onDevenv }],
    ['the first version, which kept only the URI', { schemaVersion: 1, workspaceUri: DEVENV }],
  ])('has no workspace target from %s', (_, saved) => {
    const workspaceState = memoryStore(saved === undefined ? {} : { [WORKSPACE_KEY]: saved });

    expect(new WorkspaceState(workspaceState).workspaceTarget()).toBeUndefined();
  });

  it('drops a malformed field when writing the other, keeping the valid one', async () => {
    const workspaceState = memoryStore({ [WORKSPACE_KEY]: { schemaVersion: 2, lastActiveSession: { ...address('a'), cwd: 5 }, workspaceTarget: onDevenv } });

    await new WorkspaceState(workspaceState).setLastActiveSession(address('b'));

    expect(workspaceState.values.get(WORKSPACE_KEY)).toEqual({ schemaVersion: 2, lastActiveSession: address('b'), workspaceTarget: onDevenv });
  });

  it('reads a later version as empty and never overwrites it', async () => {
    const later = { schemaVersion: 3, lastActiveSession: address('a'), workspaceTarget: onDevenv };
    const workspaceState = memoryStore({ [WORKSPACE_KEY]: later });
    const state = new WorkspaceState(workspaceState);

    await state.setLastActiveSession(address('b'));
    await state.setWorkspaceTarget(onClient);

    expect(state.lastActiveSession()).toBeUndefined();
    expect(state.workspaceTarget()).toBeUndefined();
    expect(workspaceState.values.get(WORKSPACE_KEY)).toBe(later);
  });

  it('rebinds the last active session to the new name of its configuration, and no other', async () => {
    const workspaceState = memoryStore();
    const state = new WorkspaceState(workspaceState);
    await state.setLastActiveSession(address('a'));

    await state.rebind('Claude', 'cc');
    expect(state.lastActiveSession()).toEqual(address('a'));

    await state.rebind('OpenCode', 'oc');
    expect(state.lastActiveSession()).toEqual(address('a', { configuredName: 'oc' }));
  });

  it('deletes the session history earlier versions kept, leaving its own state', async () => {
    const workspaceState = memoryStore({
      'acp.sessionHistory.v1': { version: 1, entries: [] },
      [WORKSPACE_KEY]: { schemaVersion: 2, lastActiveSession: address('a') },
    });

    await new WorkspaceState(workspaceState).discardRetired();

    expect([...workspaceState.values.keys()]).toEqual([WORKSPACE_KEY]);
  });

  it('settles once every write it started has, as its callers do not wait for them', async () => {
    const workspaceState = heldStore({ 'acp.sessionHistory.v1': { version: 1, entries: [] } });
    const state = new WorkspaceState(workspaceState);
    const order: string[] = [];
    const discarding = state.discardRetired();
    const setting = state.setLastActiveSession(address('a'));
    const learning = state.setWorkspaceTarget(onDevenv);
    const settled = state.settled().then(() => order.push('settled'));

    workspaceState.finish[1]?.();
    await setting;
    order.push('last active session written');
    workspaceState.finish[0]?.();
    await discarding;
    order.push('retired state discarded');
    workspaceState.finish[2]?.();
    await learning;
    order.push('workspace target written');
    await settled;

    expect(order).toEqual(['last active session written', 'retired state discarded', 'workspace target written', 'settled']);
  });

  it('on disposal, settles the writes it started and makes no more', async () => {
    const retired = { version: 1, entries: [] };
    const workspaceState = heldStore({ 'acp.sessionHistory.v1': retired });
    const state = new WorkspaceState(workspaceState);
    const order: string[] = [];
    const writing = state.setLastActiveSession(address('a'));
    const disposed = state.dispose().then(() => order.push('disposed'));

    void state.setLastActiveSession(address('b'));
    void state.setWorkspaceTarget(onDevenv);
    void state.discardRetired();
    workspaceState.finish[0]?.();
    await writing;
    order.push('written');
    await disposed;

    expect(order).toEqual(['written', 'disposed']);
    expect(state.lastActiveSession()).toEqual(address('a'));
    expect(state.workspaceTarget()).toBeUndefined();
    expect(workspaceState.values.get('acp.sessionHistory.v1')).toBe(retired);
  });
});
