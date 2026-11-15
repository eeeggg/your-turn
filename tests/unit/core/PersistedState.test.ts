import { afterEach, describe, expect, it } from 'vitest';
import { setLogSink, type LogSink } from '@/core/Log';
import {
  SessionReferences,
  StartupRequests,
  WorkspaceState,
  type KeyValueStore,
  type SessionAddress,
  type SessionReference,
} from '@/core/PersistedState';

const REFERENCES_KEY = 'your-turn.sessionReferences';
const WORKSPACE_KEY = 'your-turn.workspace';
const STARTUP_REQUESTS_KEY = 'your-turn.startupRequests';
const FIRST_SESSION_ID = '144370c4-e3d2-47dd-8b6e-2d2c501dbb23';
const SECOND_SESSION_ID = '2c966b62-f8e8-43b6-a305-995c5fa98307';
const THIRD_SESSION_ID = '874c4c35-2787-425f-8720-aefc877437c3';
const FOURTH_SESSION_ID = 'ace39982-8b3e-4f26-af3d-9ee8344503ec';
const FIFTH_SESSION_ID = 'dc90c7ca-cf05-4539-bf1e-fd8f65193ed0';
const LEGACY_SESSION_ID = '5b9ebdc0-b9aa-4432-8cce-cc49c310b9d3';
const LISTED_SESSION_ID = '19416fe3-35f4-4eb6-8e91-941df41bff1a';
const UNTITLED_SESSION_ID = 'dda55eb7-9164-4ad3-840b-78802f964078';
const OPEN_SESSION_ID = '8c74fb50-b1d0-4575-ac42-a2bdc1edb72b';
const UNREFERENCED_SESSION_ID = '56e6ca41-006d-47d4-a6a1-6649d678246e';

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
      await before.used(address(FIRST_SESSION_ID));
      await before.used(address(SECOND_SESSION_ID));
      await before.setTitle(address(SECOND_SESSION_ID), 'Fix the build');
      await before.saveSelections(address(FIRST_SESSION_ID), { options: { model: 'big' } });

      const after = new SessionReferences(globalState);

      expect(after.list(devenv, 'OpenCode', '/home/me/work')).toEqual(before.list(devenv, 'OpenCode', '/home/me/work'));
      expect(after.list(devenv, 'OpenCode', '/home/me/work')).toMatchObject([
        { sessionId: SECOND_SESSION_ID, title: 'Fix the build' },
        { sessionId: FIRST_SESSION_ID, selections: { options: { model: 'big' } } },
      ]);
    });

    it('keeps what another instance over the same store saved meanwhile', async () => {
      const globalState = memoryStore();
      const one = new SessionReferences(globalState, ticking());
      const other = new SessionReferences(globalState, ticking());

      await one.used(address(FIRST_SESSION_ID));
      await other.used(address(SECOND_SESSION_ID));
      await one.setTitle(address(FIRST_SESSION_ID), 'From one');

      expect(ids(new SessionReferences(globalState).list(devenv, 'OpenCode', '/home/me/work')).sort()).toEqual([FIRST_SESSION_ID, SECOND_SESSION_ID]);
      expect(other.get({ host: devenv, configuredName: 'OpenCode', sessionId: FIRST_SESSION_ID })?.title).toBe('From one');
    });
  });

  describe('saved data', () => {
    it.each([
      ['nothing', undefined],
      ['a value that is not an object', 'references'],
      ['an object without a version', { references: [reference(FIRST_SESSION_ID)] }],
      ['an earlier version', { schemaVersion: 0, references: [reference(FIRST_SESSION_ID)] }],
      ['the first version, which had no revisions', { schemaVersion: 1, references: [reference(FIRST_SESSION_ID)] }],
      ['the second version, which derived hosts', { schemaVersion: 2, epoch: 0, references: [{ ...reference(FIRST_SESSION_ID), revision: 1 }], removed: [] }],
    ])('starts empty from %s, and replaces it on the first change', async (_, saved) => {
      const globalState = memoryStore(saved === undefined ? {} : { [REFERENCES_KEY]: saved });
      const references = new SessionReferences(globalState, ticking());

      expect(references.list(devenv, 'OpenCode', '/home/me/work')).toEqual([]);
      await references.used(address(SECOND_SESSION_ID));

      expect(globalState.values.get(REFERENCES_KEY)).toMatchObject({
        schemaVersion: 3,
        epoch: 0,
        references: [{ ...address(SECOND_SESSION_ID), revision: 1 }],
        removed: [],
      });
    });

    it('reads a later version as empty and never overwrites it', async () => {
      const later = { schemaVersion: 4, references: [{ something: 'new' }] };
      const globalState = memoryStore({ [REFERENCES_KEY]: later });
      const references = new SessionReferences(globalState, ticking());

      await references.used(address(FIRST_SESSION_ID));
      await references.setTitle(address(FIRST_SESSION_ID), 'Title');
      await references.saveSelections(address(FIRST_SESSION_ID), { modeId: 'plan', options: {} });
      await references.remove({ host: devenv, configuredName: 'OpenCode', sessionId: FIRST_SESSION_ID });

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
          references: [{ ...reference(FIRST_SESSION_ID), revision: 1 }, { ...reference(SECOND_SESSION_ID), revision: 3 }],
          removed: [
            { host: devenv, configuredName: 'OpenCode', sessionId: FIRST_SESSION_ID, revision: 2, removedAt: '2026-10-29T09:00:00.000Z' },
            { host: devenv, configuredName: 'OpenCode', sessionId: SECOND_SESSION_ID, revision: 2, removedAt: '2026-10-29T09:00:00.000Z' },
          ],
        },
      });

      expect(listed(new SessionReferences(globalState))).toEqual([SECOND_SESSION_ID]);
    });

    it('keeps only the fields of a reference, whatever else the caller passes', async () => {
      const globalState = memoryStore();
      const references = new SessionReferences(globalState, ticking());

      await references.used({ ...address(FIRST_SESSION_ID), transcript: 'not ours to keep' } as SessionAddress);

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

      await references.used(address(FIRST_SESSION_ID));
      await references.used(address(FIRST_SESSION_ID, { workspaceUri: DEVENV_WORKSPACE }));

      expect(references.list(devenv, 'OpenCode', '/home/me/work')).toEqual([
        expect.objectContaining({ sessionId: FIRST_SESSION_ID, workspaceUri: DEVENV_WORKSPACE }),
      ]);
    });

    it('keeps a reference on the host it was recorded with, whatever machine its workspace URI is on', async () => {
      const references = new SessionReferences(memoryStore(), ticking());

      await references.used(address(FIRST_SESSION_ID));
      await references.used(address(FIRST_SESSION_ID, { workspaceUri: CLIENT_WORKSPACE, host: devenv }));
      await references.used(address(SECOND_SESSION_ID, { workspaceUri: CLIENT_WORKSPACE, host: devenv }));

      expect(references.list(devenv, 'OpenCode', '/home/me/work')).toEqual([
        expect.objectContaining({ sessionId: SECOND_SESSION_ID, host: devenv, workspaceUri: CLIENT_WORKSPACE }),
        expect.objectContaining({ sessionId: FIRST_SESSION_ID, host: devenv, workspaceUri: CLIENT_WORKSPACE }),
      ]);
      expect(references.list('file://', 'OpenCode', '/home/me/work')).toEqual([]);
      await references.remove(idOf(SECOND_SESSION_ID));
      expect(listed(references)).toEqual([FIRST_SESSION_ID]);
    });

    it('lists only the host, configuration and exact cwd asked for, the most recently active first', async () => {
      const references = new SessionReferences(memoryStore(), ticking());
      await references.used(address(FIRST_SESSION_ID));
      await references.used(address(SECOND_SESSION_ID, { workspaceUri: LOCAL }));
      await references.used(address(THIRD_SESSION_ID, { configuredName: 'Codex' }));
      await references.used(address(FOURTH_SESSION_ID, { cwd: '/home/me/work/sub' }));
      await references.used(address(FIFTH_SESSION_ID));

      expect(ids(references.list(devenv, 'OpenCode', '/home/me/work'))).toEqual([FIFTH_SESSION_ID, FIRST_SESSION_ID]);
      expect(ids(references.list('local', 'OpenCode', '/home/me/work'))).toEqual([SECOND_SESSION_ID]);
    });

    it('lists every reference on every host, the most recently active first', async () => {
      const references = new SessionReferences(memoryStore(), ticking());
      await references.used(address(FIRST_SESSION_ID));
      await references.used(address(SECOND_SESSION_ID, { workspaceUri: LOCAL }));
      await references.used(address(THIRD_SESSION_ID, { configuredName: 'Codex' }));
      await references.used(address(FOURTH_SESSION_ID, { cwd: '/home/me/work/sub' }));
      await references.remove(idOf(FIRST_SESSION_ID));

      expect(ids(references.all())).toEqual([FOURTH_SESSION_ID, THIRD_SESSION_ID, SECOND_SESSION_ID]);
    });
  });

  describe('changes', () => {
    it('marks a session active when used, and not when only its title or selections change', async () => {
      const references = new SessionReferences(memoryStore(), ticking());
      await references.used(address(FIRST_SESSION_ID));
      await references.used(address(SECOND_SESSION_ID));

      await references.setTitle(address(FIRST_SESSION_ID), 'Renamed');
      await references.saveSelections(address(FIRST_SESSION_ID), { modeId: 'plan', options: {} });
      expect(ids(references.list(devenv, 'OpenCode', '/home/me/work'))).toEqual([SECOND_SESSION_ID, FIRST_SESSION_ID]);

      await references.used(address(FIRST_SESSION_ID));
      expect(ids(references.list(devenv, 'OpenCode', '/home/me/work'))).toEqual([FIRST_SESSION_ID, SECOND_SESSION_ID]);
    });

    it('creates a missing reference on any change to the session', async () => {
      const references = new SessionReferences(memoryStore(), ticking());

      await references.setTitle(address(FIRST_SESSION_ID), 'Titled');
      await references.saveSelections(address(SECOND_SESSION_ID), { options: { brave: true } });

      expect(references.list(devenv, 'OpenCode', '/home/me/work')).toEqual([
        expect.objectContaining({ sessionId: SECOND_SESSION_ID, selections: { options: { brave: true } } }),
        expect.objectContaining({ sessionId: FIRST_SESSION_ID, title: 'Titled' }),
      ]);
    });

    it('clears the cached title when the agent reports none', async () => {
      const references = new SessionReferences(memoryStore(), ticking());
      await references.setTitle(address(FIRST_SESSION_ID), 'Old title');

      await references.setTitle(address(FIRST_SESSION_ID), null);

      expect(references.get({ host: devenv, configuredName: 'OpenCode', sessionId: FIRST_SESSION_ID })).not.toHaveProperty('title');
    });

    it('replaces the saved selections as a whole', async () => {
      const references = new SessionReferences(memoryStore(), ticking());

      await references.saveSelections(address(FIRST_SESSION_ID), { modeId: 'plan', options: { model: 'big', effort: 'high' } });
      await references.saveSelections(address(FIRST_SESSION_ID), { options: { model: 'small' } });

      expect(references.get({ host: devenv, configuredName: 'OpenCode', sessionId: FIRST_SESSION_ID })?.selections)
        .toEqual({ options: { model: 'small' } });
    });

    it('keeps at most its capacity, dropping the least recently active', async () => {
      const references = new SessionReferences(memoryStore(), ticking(), 3);
      for (const id of [FIRST_SESSION_ID, SECOND_SESSION_ID, THIRD_SESSION_ID]) {
        await references.used(address(id));
      }
      await references.used(address(FIRST_SESSION_ID));

      await references.used(address(FOURTH_SESSION_ID, { workspaceUri: LOCAL }));

      expect(ids(references.list(devenv, 'OpenCode', '/home/me/work'))).toEqual([FIRST_SESSION_ID, THIRD_SESSION_ID]);
      expect(ids(references.list('local', 'OpenCode', '/home/me/work'))).toEqual([FOURTH_SESSION_ID]);
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
      await references.used(address(FIRST_SESSION_ID));
      await references.used(address(FIRST_SESSION_ID, { workspaceUri: LOCAL }));
      await references.used(address(SECOND_SESSION_ID));

      await references.remove({ host: devenv, configuredName: 'OpenCode', sessionId: FIRST_SESSION_ID });

      expect(ids(references.list(devenv, 'OpenCode', '/home/me/work'))).toEqual([SECOND_SESSION_ID]);
      expect(ids(references.list('local', 'OpenCode', '/home/me/work'))).toEqual([FIRST_SESSION_ID]);
    });

    it('announces each change it writes', async () => {
      const references = new SessionReferences(memoryStore(), ticking());
      let announced = 0;
      references.on('changed', () => { announced++; });

      await references.used(address(FIRST_SESSION_ID));
      await references.remove({ host: devenv, configuredName: 'OpenCode', sessionId: 'unknown' });

      expect(announced).toBe(1);
    });

    it('logs a failed write instead of failing the change', async () => {
      const errors: string[] = [];
      setLogSink({ error: (message: string) => { errors.push(message); } } as unknown as LogSink);
      const failing: KeyValueStore = { get: () => undefined, update: () => Promise.reject(new Error('disk full')) };

      await new SessionReferences(failing, ticking()).used(address(FIRST_SESSION_ID));

      expect(errors).toEqual(['Failed to save session references']);
    });
  });

  describe('rebinding', () => {
    it("moves one configuration's references on one host to its new name, with all they hold", async () => {
      const references = new SessionReferences(memoryStore(), ticking());
      const under = (configuredName: string, host = devenv) => ids(references.list(host, configuredName, '/home/me/work'));
      await references.used(address(FIRST_SESSION_ID));
      await references.setTitle(address(FIRST_SESSION_ID), 'Kept title');
      await references.saveSelections(address(FIRST_SESSION_ID), { options: { model: 'big' } });
      await references.used(address(SECOND_SESSION_ID, { workspaceUri: LOCAL }));
      await references.used(address(THIRD_SESSION_ID, { configuredName: 'Claude' }));
      const before = references.get(idOf(FIRST_SESSION_ID));

      await references.rebind(devenv, 'OpenCode', 'oc');

      expect([under('oc'), under('OpenCode'), under('OpenCode', 'local'), under('Claude')]).toEqual([[FIRST_SESSION_ID], [], [SECOND_SESSION_ID], [THIRD_SESSION_ID]]);
      expect(references.get({ ...idOf(FIRST_SESSION_ID), configuredName: 'oc' })).toEqual({ ...before, configuredName: 'oc' });
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

    it("moves only the one session named, with all it holds, leaving the configuration's others", async () => {
      const references = new SessionReferences(memoryStore(), ticking());
      await references.used(address(FIRST_SESSION_ID));
      await references.setTitle(address(SECOND_SESSION_ID), 'Kept title');
      await references.saveSelections(address(SECOND_SESSION_ID), { options: { model: 'big' } });
      const before = references.get(idOf(SECOND_SESSION_ID));

      await references.rebind(devenv, 'OpenCode', 'oc', SECOND_SESSION_ID);

      expect([ids(references.list(devenv, 'OpenCode', '/home/me/work')), ids(references.list(devenv, 'oc', '/home/me/work'))]).toEqual([[FIRST_SESSION_ID], [SECOND_SESSION_ID]]);
      expect(references.get({ ...idOf(SECOND_SESSION_ID), configuredName: 'oc' })).toEqual({ ...before, configuredName: 'oc' });
    });

    it('changes nothing when applied again', async () => {
      const references = new SessionReferences(memoryStore(), ticking());
      await references.used(address(FIRST_SESSION_ID));
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
      await references.setTitle(address(LISTED_SESSION_ID), 'Old title');
      await references.setTitle(address(UNTITLED_SESSION_ID), 'Had a title');
      await references.used(address('gone'));
      await references.used(address(OPEN_SESSION_ID));
      await references.used(address(FOURTH_SESSION_ID, { cwd: '/home/me/work/sub' }));
      await references.used(address(THIRD_SESSION_ID, { configuredName: 'Codex' }));
      await references.used(address('gone', { workspaceUri: LOCAL }));
      return references;
    }

    const listing = {
      host: devenv,
      configuredName: 'OpenCode',
      sessions: [
        { sessionId: LISTED_SESSION_ID, title: 'New title' },
        { sessionId: UNTITLED_SESSION_ID },
        { sessionId: UNREFERENCED_SESSION_ID, title: 'Not ours' },
      ],
    };

    it('refreshes the titles of referenced sessions, clearing those listed without one, and adds no others', async () => {
      const references = await seeded();

      await references.observeListing(listing);

      const listed = references.list(devenv, 'OpenCode', '/home/me/work');
      expect(listed.find((r) => r.sessionId === LISTED_SESSION_ID)?.title).toBe('New title');
      expect(listed.find((r) => r.sessionId === UNTITLED_SESSION_ID)).not.toHaveProperty('title');
      expect(ids(listed)).not.toContain(UNREFERENCED_SESSION_ID);
      expect(ids(listed)).toContain('gone');
    });

    it('prunes by a complete listing only within its host, configuration and cwd, keeping sessions open in this window', async () => {
      const references = await seeded();

      await references.observeListing({ ...listing, complete: { cwd: '/home/me/work', openInThisWindow: new Set([OPEN_SESSION_ID]) } });

      expect(ids(references.list(devenv, 'OpenCode', '/home/me/work')).sort()).toEqual([LISTED_SESSION_ID, OPEN_SESSION_ID, UNTITLED_SESSION_ID].sort());
      expect(ids(references.list(devenv, 'OpenCode', '/home/me/work/sub'))).toEqual([FOURTH_SESSION_ID]);
      expect(ids(references.list(devenv, 'Codex', '/home/me/work'))).toEqual([THIRD_SESSION_ID]);
      expect(ids(references.list('local', 'OpenCode', '/home/me/work'))).toEqual(['gone']);
    });

    it('writes nothing when the listing changes nothing', async () => {
      const globalState = memoryStore();
      const references = new SessionReferences(globalState, ticking());
      await references.setTitle(address(LISTED_SESSION_ID), 'New title');
      const saved = globalState.values.get(REFERENCES_KEY);

      await references.observeListing({ ...listing, complete: { cwd: '/home/me/work', openInThisWindow: new Set() } });

      expect(globalState.values.get(REFERENCES_KEY)).toBe(saved);
    });
  });

  describe('while an earlier value is served', () => {
    it('still shows its own changes', async () => {
      const globalState = revertibleStore();
      const references = new SessionReferences(globalState, ticking());
      await references.used(address(FIRST_SESSION_ID));
      await references.setTitle(address(FIRST_SESSION_ID), 'Named');

      globalState.serveEarlier(REFERENCES_KEY);

      expect(references.get(idOf(FIRST_SESSION_ID))?.title).toBe('Named');
    });

    it('writes no earlier value back', async () => {
      const globalState = revertibleStore();
      const references = new SessionReferences(globalState, ticking());
      await references.used(address(FIRST_SESSION_ID));
      await references.setTitle(address(FIRST_SESSION_ID), 'Named');

      globalState.serveEarlier(REFERENCES_KEY);
      await references.used(address(SECOND_SESSION_ID));

      const after = new SessionReferences(globalState);
      expect(listed(after)).toEqual([FIRST_SESSION_ID, SECOND_SESSION_ID]);
      expect(after.get(idOf(FIRST_SESSION_ID))?.title).toBe('Named');
    });

    it.each([
      ['removed', (references: SessionReferences) => references.remove(idOf(FIRST_SESSION_ID))],
      ['pruned by a complete listing', (references: SessionReferences) => references.observeListing({
        host: devenv,
        configuredName: 'OpenCode',
        sessions: [{ sessionId: SECOND_SESSION_ID }],
        complete: { cwd: '/home/me/work', openInThisWindow: new Set() },
      })],
    ])('does not bring back a reference it %s', async (_, removal) => {
      const globalState = revertibleStore();
      const references = new SessionReferences(globalState, ticking());
      await references.used(address(FIRST_SESSION_ID));
      await references.used(address(SECOND_SESSION_ID));
      await removal(references);

      globalState.serveEarlier(REFERENCES_KEY);
      expect(listed(references)).toEqual([SECOND_SESSION_ID]);
      await references.used(address(THIRD_SESSION_ID));

      expect(listed(new SessionReferences(globalState))).toEqual([SECOND_SESSION_ID, THIRD_SESSION_ID]);
    });

    it('does not bring back references it reset', async () => {
      const globalState = revertibleStore();
      const references = new SessionReferences(globalState, ticking());
      await references.used(address(FIRST_SESSION_ID));
      await references.reset();

      globalState.serveEarlier(REFERENCES_KEY);
      expect(listed(references)).toEqual([]);
      await references.used(address(SECOND_SESSION_ID));

      expect(listed(new SessionReferences(globalState))).toEqual([SECOND_SESSION_ID]);
      expect(globalState.values.get(REFERENCES_KEY)).toMatchObject({ epoch: 1 });
    });

    it('forgets its own change once it has read a later one made elsewhere', async () => {
      const globalState = revertibleStore();
      const one = new SessionReferences(globalState, ticking());
      const other = new SessionReferences(globalState, ticking());
      await one.setTitle(address(FIRST_SESSION_ID), 'One');
      await other.setTitle(address(FIRST_SESSION_ID), 'Other');
      expect(one.get(idOf(FIRST_SESSION_ID))?.title).toBe('Other');

      globalState.serveEarlier(REFERENCES_KEY, 2);

      expect(one.get(idOf(FIRST_SESSION_ID))).toBeUndefined();
    });

    it('stops showing its own changes a day after making them', async () => {
      const globalState = revertibleStore();
      const clock = stopped();
      const references = new SessionReferences(globalState, clock);
      await references.used(address(FIRST_SESSION_ID));
      globalState.serveEarlier(REFERENCES_KEY);

      clock.advance(DAY - 1);
      expect(listed(references)).toEqual([FIRST_SESSION_ID]);
      clock.advance(1);
      expect(listed(references)).toEqual([]);
    });
  });

  describe('across windows', () => {
    it('keeps both changes when two windows write from overlapping reads', async () => {
      const globalState = revertibleStore();
      const one = new SessionReferences(globalState, ticking());
      const other = new SessionReferences(globalState, ticking());
      await one.used(address(FIRST_SESSION_ID));

      globalState.serveEarlier(REFERENCES_KEY);
      await other.used(address(SECOND_SESSION_ID));
      expect(listed(one)).toEqual([FIRST_SESSION_ID, SECOND_SESSION_ID]);
      await one.used(address(THIRD_SESSION_ID));

      expect(listed(new SessionReferences(globalState))).toEqual([FIRST_SESSION_ID, SECOND_SESSION_ID, THIRD_SESSION_ID]);
    });

    it('settles a change and a removal made from the same revision on the removal, in every window', async () => {
      const globalState = revertibleStore();
      const one = new SessionReferences(globalState, ticking());
      const other = new SessionReferences(globalState, ticking());
      await one.used(address(FIRST_SESSION_ID));
      await other.remove(idOf(FIRST_SESSION_ID));

      globalState.serveEarlier(REFERENCES_KEY);
      await one.setTitle(address(FIRST_SESSION_ID), 'One');
      await other.used(address(SECOND_SESSION_ID));

      expect(one.get(idOf(FIRST_SESSION_ID))).toBeUndefined();
      expect(other.get(idOf(FIRST_SESSION_ID))).toBeUndefined();
      expect(new SessionReferences(globalState).get(idOf(FIRST_SESSION_ID))).toBeUndefined();
    });

    it('settles two changes made from the same revision on the same one, in every window', async () => {
      const globalState = revertibleStore();
      const one = new SessionReferences(globalState, ticking());
      const other = new SessionReferences(globalState, ticking());
      await one.used(address(FIRST_SESSION_ID));
      await other.setTitle(address(FIRST_SESSION_ID), 'Other');

      globalState.serveEarlier(REFERENCES_KEY);
      await one.setTitle(address(FIRST_SESSION_ID), 'One');
      await other.used(address(SECOND_SESSION_ID));

      expect(one.get(idOf(FIRST_SESSION_ID))?.title).toBe('Other');
      expect(other.get(idOf(FIRST_SESSION_ID))?.title).toBe('Other');
      expect(new SessionReferences(globalState).get(idOf(FIRST_SESSION_ID))?.title).toBe('Other');
    });

    it('drops its own earlier changes once it reads a reset made elsewhere', async () => {
      const globalState = revertibleStore();
      const one = new SessionReferences(globalState, ticking());
      const other = new SessionReferences(globalState, ticking());
      await one.used(address(FIRST_SESSION_ID));

      await other.reset();
      await one.used(address(SECOND_SESSION_ID));

      expect(listed(one)).toEqual([SECOND_SESSION_ID]);
      expect(listed(new SessionReferences(globalState))).toEqual([SECOND_SESSION_ID]);
    });
  });

  describe('removal records', () => {
    it('keeps a removal record for 30 days, then prunes it on a write', async () => {
      const globalState = memoryStore();
      const clock = stopped();
      const references = new SessionReferences(globalState, clock);
      await references.used(address(FIRST_SESSION_ID));
      await references.remove(idOf(FIRST_SESSION_ID));
      const removed = () => (globalState.values.get(REFERENCES_KEY) as { removed: unknown[] }).removed;

      clock.advance(30 * DAY - 1);
      await references.used(address(SECOND_SESSION_ID));
      expect(removed()).toEqual([{ host: devenv, configuredName: 'OpenCode', sessionId: FIRST_SESSION_ID, revision: 2, removedAt: '2026-10-29T10:00:00.000Z' }]);

      clock.advance(1);
      await references.used(address(THIRD_SESSION_ID));
      expect(removed()).toEqual([]);
    });

    it('leaves none for a reference evicted past its capacity', async () => {
      const globalState = memoryStore();
      const references = new SessionReferences(globalState, ticking(), 1);
      await references.used(address(FIRST_SESSION_ID));
      await references.used(address(SECOND_SESSION_ID));

      expect(globalState.values.get(REFERENCES_KEY)).toMatchObject({ references: [{ sessionId: SECOND_SESSION_ID }], removed: [] });
      expect(listed(references)).toEqual([SECOND_SESSION_ID]);
    });

    it('lets a session removed earlier be referenced again', async () => {
      const references = new SessionReferences(memoryStore(), ticking());
      await references.used(address(FIRST_SESSION_ID));
      await references.remove(idOf(FIRST_SESSION_ID));

      await references.used(address(FIRST_SESSION_ID));

      expect(listed(references)).toEqual([FIRST_SESSION_ID]);
    });
  });

  describe('settlement', () => {
    it('settles once every write it started has, as its callers do not wait for them', async () => {
      const globalState = heldStore();
      const references = new SessionReferences(globalState, ticking());
      const order: string[] = [];
      const first = references.used(address(FIRST_SESSION_ID));
      const second = references.setTitle(address(SECOND_SESSION_ID), 'Fix the build');
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
      const writing = references.used(address(FIRST_SESSION_ID));
      const disposed = references.dispose().then(() => order.push('disposed'));

      void references.used(address(SECOND_SESSION_ID));
      globalState.finish[0]?.();
      await writing;
      order.push('written');
      await disposed;

      expect(order).toEqual(['written', 'disposed']);
      expect(ids(references.list(devenv, 'OpenCode', '/home/me/work'))).toEqual([FIRST_SESSION_ID]);
      expect(announced).toBe(1);
    });
  });
});

describe('WorkspaceState', () => {
  it('reads back the last active session saved before', async () => {
    const workspaceState = memoryStore();
    await new WorkspaceState(workspaceState).setLastActiveSession({ ...address(FIRST_SESSION_ID), extra: 'dropped' } as SessionAddress);

    expect(new WorkspaceState(workspaceState).lastActiveSession()).toEqual(address(FIRST_SESSION_ID));
    expect(workspaceState.values.get(WORKSPACE_KEY)).toEqual({ schemaVersion: 3, lastActiveSession: address(FIRST_SESSION_ID) });
  });

  it.each([
    ['nothing', undefined],
    ['a malformed session', { schemaVersion: 2, lastActiveSession: { ...address(FIRST_SESSION_ID), cwd: 5 } }],
    ['a session without a host', { schemaVersion: 2, lastActiveSession: { ...address(FIRST_SESSION_ID), host: undefined } }],
    ['an earlier version', { schemaVersion: 0, lastActiveSession: address(FIRST_SESSION_ID) }],
    ['the first version, which derived hosts', { schemaVersion: 1, lastActiveSession: address(FIRST_SESSION_ID) }],
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
    expect(workspaceState.values.get(WORKSPACE_KEY)).toEqual({ schemaVersion: 3, workspaceTarget: onClient });
  });

  it('keeps the workspace target when the last active session changes, and the session when the target does', async () => {
    const workspaceState = memoryStore();
    const state = new WorkspaceState(workspaceState);

    await state.setWorkspaceTarget(onDevenv);
    await state.setLastActiveSession(address(FIRST_SESSION_ID));
    await state.setWorkspaceTarget(onClient);

    expect(workspaceState.values.get(WORKSPACE_KEY)).toEqual({ schemaVersion: 3, lastActiveSession: address(FIRST_SESSION_ID), workspaceTarget: onClient });
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
    const workspaceState = memoryStore({ [WORKSPACE_KEY]: { schemaVersion: 2, lastActiveSession: { ...address(FIRST_SESSION_ID), cwd: 5 }, workspaceTarget: onDevenv } });

    await new WorkspaceState(workspaceState).setLastActiveSession(address(SECOND_SESSION_ID));

    expect(workspaceState.values.get(WORKSPACE_KEY)).toEqual({ schemaVersion: 3, lastActiveSession: address(SECOND_SESSION_ID), workspaceTarget: onDevenv });
  });

  it('reads a later version as empty and never overwrites it', async () => {
    const later = { schemaVersion: 4, lastActiveSession: address(FIRST_SESSION_ID), workspaceTarget: onDevenv, tabLayout: { tabs: [address(FIRST_SESSION_ID)], selected: address(FIRST_SESSION_ID), mru: [address(FIRST_SESSION_ID)] } };
    const workspaceState = memoryStore({ [WORKSPACE_KEY]: later });
    const state = new WorkspaceState(workspaceState);

    await state.setLastActiveSession(address(SECOND_SESSION_ID));
    await state.setWorkspaceTarget(onClient);
    await state.setTabLayout({ tabs: [address(SECOND_SESSION_ID)], selected: address(SECOND_SESSION_ID), mru: [address(SECOND_SESSION_ID)] });
    await state.rebind('OpenCode', 'oc');

    expect(state.lastActiveSession()).toBeUndefined();
    expect(state.workspaceTarget()).toBeUndefined();
    expect(state.tabLayout()).toBeUndefined();
    expect(workspaceState.values.get(WORKSPACE_KEY)).toBe(later);
  });

  describe('tab layout', () => {
    it('saves ordered address-only tabs, selection and MRU independently of session references', async () => {
      const workspaceState = memoryStore();
      const a = { ...reference(FIRST_SESSION_ID), tabId: 'opaque', transcript: ['private'], activity: 'running' };
      await new WorkspaceState(workspaceState).setTabLayout({ tabs: [a, address(SECOND_SESSION_ID)], selected: a, mru: [address(SECOND_SESSION_ID), a] });

      expect(new WorkspaceState(workspaceState).tabLayout()).toEqual({
        tabs: [address(FIRST_SESSION_ID), address(SECOND_SESSION_ID)], selected: address(FIRST_SESSION_ID), mru: [address(SECOND_SESSION_ID), address(FIRST_SESSION_ID)],
      });
      expect(workspaceState.values.get(WORKSPACE_KEY)).toEqual({
        schemaVersion: 3, tabLayout: { tabs: [address(FIRST_SESSION_ID), address(SECOND_SESSION_ID)], selected: address(FIRST_SESSION_ID), mru: [address(SECOND_SESSION_ID), address(FIRST_SESSION_ID)] },
      });
      expect(workspaceState.values.has(REFERENCES_KEY)).toBe(false);
    });

    it('distinguishes an absent layout from explicitly closing every tab', async () => {
      const workspaceState = memoryStore();
      const state = new WorkspaceState(workspaceState);
      await state.setLastActiveSession(address(LEGACY_SESSION_ID));
      expect(state.tabLayout()).toBeUndefined();

      await state.setTabLayout({ tabs: [], selected: null, mru: [] });

      expect(new WorkspaceState(workspaceState).tabLayout()).toEqual({ tabs: [], selected: null, mru: [] });
      expect(state.lastActiveSession()).toEqual(address(LEGACY_SESSION_ID));
    });

    it('migrates version two fields on a layout write and preserves layout on other writes', async () => {
      const workspaceState = memoryStore({ [WORKSPACE_KEY]: {
        schemaVersion: 2, lastActiveSession: address(LEGACY_SESSION_ID), workspaceTarget: onDevenv,
      } });
      const state = new WorkspaceState(workspaceState);
      expect(state.lastActiveSession()).toEqual(address(LEGACY_SESSION_ID));
      expect(state.workspaceTarget()).toEqual(onDevenv);
      expect(state.tabLayout()).toBeUndefined();
      const layout = { tabs: [address(FIRST_SESSION_ID)], selected: address(FIRST_SESSION_ID), mru: [address(FIRST_SESSION_ID)] };

      await state.setTabLayout(layout);
      expect(workspaceState.values.get(WORKSPACE_KEY)).toEqual({
        schemaVersion: 3, lastActiveSession: address(LEGACY_SESSION_ID), workspaceTarget: onDevenv, tabLayout: layout,
      });
      await state.setLastActiveSession(address(SECOND_SESSION_ID));
      await state.setWorkspaceTarget(onClient);

      expect(workspaceState.values.get(WORKSPACE_KEY)).toEqual({
        schemaVersion: 3, lastActiveSession: address(SECOND_SESSION_ID), workspaceTarget: onClient, tabLayout: layout,
      });
    });

    it.each([0, 1, 2])('does not read a tab layout from schema %s', (schemaVersion) => {
      const state = new WorkspaceState(memoryStore({ [WORKSPACE_KEY]: {
        schemaVersion, tabLayout: { tabs: [address(FIRST_SESSION_ID)], selected: address(FIRST_SESSION_ID), mru: [address(FIRST_SESSION_ID)] },
      } }));

      expect(state.tabLayout()).toBeUndefined();
    });

    it('normalizes malformed tabs, selected addresses and MRU while keeping distinct workspace identities', () => {
      const otherHost = address('a', { host: 'local' });
      const otherWorkspace = address('a', { workspaceUri: CLIENT_WORKSPACE });
      const otherConfiguration = address('a', { configuredName: 'Codex' });
      const state = new WorkspaceState(memoryStore({ [WORKSPACE_KEY]: { schemaVersion: 3, tabLayout: {
        tabs: [address('a'), { ...address('a'), cwd: '/duplicate' }, null, { ...address('bad'), host: 5 }, address('b'), otherHost, otherWorkspace, otherConfiguration],
        selected: { ...address('b'), cwd: '/stale' },
        mru: [address('foreign'), otherWorkspace, otherWorkspace, { ...address('a'), cwd: '/stale' }, false],
      } } }));

      expect(state.tabLayout()).toEqual({
        tabs: [address('a'), address('b'), otherHost, otherWorkspace, otherConfiguration],
        selected: address('b'), mru: [otherWorkspace, address('a'), address('b'), otherHost, otherConfiguration],
      });
    });

    it.each([null, 5, [], {}, { tabs: false }, { tabs: [], selected: address('foreign'), mru: [address('foreign')] }].map((raw) => [raw]))(
      'treats a malformed present layout as empty without choosing a foreign session: %j', (tabLayout) => {
        const state = new WorkspaceState(memoryStore({ [WORKSPACE_KEY]: {
          schemaVersion: 3, lastActiveSession: address(LEGACY_SESSION_ID), tabLayout,
        } }));

        expect(state.tabLayout()).toEqual({ tabs: [], selected: null, mru: [] });
      },
    );

    it('clears a selection outside the tabs and completes a malformed MRU from tab order', () => {
      const state = new WorkspaceState(memoryStore({ [WORKSPACE_KEY]: { schemaVersion: 3, tabLayout: {
        tabs: [address(FIRST_SESSION_ID), address(SECOND_SESSION_ID)], selected: address('foreign'), mru: 'invalid',
      } } }));

      expect(state.tabLayout()).toEqual({ tabs: [address(FIRST_SESSION_ID), address(SECOND_SESSION_ID)], selected: null, mru: [address(FIRST_SESSION_ID), address(SECOND_SESSION_ID)] });
    });

    it('clones addresses and arrays when saving and reading a layout', async () => {
      const workspaceState = memoryStore();
      const state = new WorkspaceState(workspaceState);
      const a = { ...address(FIRST_SESSION_ID) };
      const layout = { tabs: [a], selected: a, mru: [a] };
      await state.setTabLayout(layout);
      a.sessionId = 'changed';
      layout.tabs.length = 0;
      layout.mru.length = 0;
      const read = state.tabLayout();
      expect(read).toEqual({ tabs: [address(FIRST_SESSION_ID)], selected: address(FIRST_SESSION_ID), mru: [address(FIRST_SESSION_ID)] });
      if (read) {
        (read.tabs as SessionAddress[]).length = 0;
        (read.selected as { sessionId: string }).sessionId = 'changed-again';
        (read.mru as SessionAddress[]).length = 0;
      }

      expect(state.tabLayout()).toEqual({ tabs: [address(FIRST_SESSION_ID)], selected: address(FIRST_SESSION_ID), mru: [address(FIRST_SESSION_ID)] });
    });

    it('rebinds layout addresses and its legacy pointer, deduplicating name collisions', async () => {
      const workspaceState = memoryStore();
      const state = new WorkspaceState(workspaceState);
      const renamed = address('a', { configuredName: 'oc' });
      await state.setLastActiveSession(address('a'));
      await state.setWorkspaceTarget(onDevenv);
      await state.setTabLayout({
        tabs: [address('a'), address('b', { configuredName: 'Claude' }), renamed],
        selected: address('a'), mru: [renamed, address('a'), address('b', { configuredName: 'Claude' })],
      });

      await state.rebind('OpenCode', 'oc');

      expect(new WorkspaceState(workspaceState).tabLayout()).toEqual({
        tabs: [renamed, address('b', { configuredName: 'Claude' })], selected: renamed,
        mru: [renamed, address('b', { configuredName: 'Claude' })],
      });
      expect(state.lastActiveSession()).toEqual(renamed);
      expect(state.workspaceTarget()).toEqual(onDevenv);
    });

    it('rebinds a layout without a legacy pointer and avoids writing unrelated renames', async () => {
      const workspaceState = memoryStore();
      const state = new WorkspaceState(workspaceState);
      await state.setTabLayout({ tabs: [address(FIRST_SESSION_ID)], selected: null, mru: [address(FIRST_SESSION_ID)] });
      const stored = workspaceState.values.get(WORKSPACE_KEY);
      await state.rebind('Claude', 'cc');
      expect(workspaceState.values.get(WORKSPACE_KEY)).toBe(stored);

      await state.rebind('OpenCode', 'oc');

      expect(state.tabLayout()).toEqual({
        tabs: [address(FIRST_SESSION_ID, { configuredName: 'oc' })], selected: null, mru: [address(FIRST_SESSION_ID, { configuredName: 'oc' })],
      });
    });

    it('tracks layout writes until disposal finishes and ignores later layout writes', async () => {
      const workspaceState = heldStore();
      const state = new WorkspaceState(workspaceState);
      const order: string[] = [];
      const writing = state.setTabLayout({ tabs: [address(FIRST_SESSION_ID)], selected: address(FIRST_SESSION_ID), mru: [address(FIRST_SESSION_ID)] });
      const settled = state.settled().then(() => order.push('settled'));
      const disposed = state.dispose().then(() => order.push('disposed'));
      await state.setTabLayout({ tabs: [], selected: null, mru: [] });
      expect(order).toEqual([]);
      workspaceState.finish[0]?.();
      await writing;
      await settled;
      await disposed;

      expect(order).toEqual(['settled', 'disposed']);
      expect(workspaceState.finish).toHaveLength(1);
      expect(state.tabLayout()).toEqual({ tabs: [address(FIRST_SESSION_ID)], selected: address(FIRST_SESSION_ID), mru: [address(FIRST_SESSION_ID)] });
    });
  });

  it('rebinds the last active session to the new name of its configuration, and no other', async () => {
    const workspaceState = memoryStore();
    const state = new WorkspaceState(workspaceState);
    await state.setLastActiveSession(address(FIRST_SESSION_ID));

    await state.rebind('Claude', 'cc');
    expect(state.lastActiveSession()).toEqual(address(FIRST_SESSION_ID));

    await state.rebind('OpenCode', 'oc');
    expect(state.lastActiveSession()).toEqual(address(FIRST_SESSION_ID, { configuredName: 'oc' }));
  });

  it('retires only explicitly listed workspace keys without reading their contents', async () => {
    const workspaceState = memoryStore({
      'your-turn.retired.v1': { schemaVersion: 1 },
      'acp.sessionHistory.v1': { version: 1 },
      [WORKSPACE_KEY]: { schemaVersion: 2, lastActiveSession: address(FIRST_SESSION_ID) },
    });
    await new WorkspaceState(workspaceState, ['your-turn.retired.v1']).discardRetired();
    expect([...workspaceState.values.keys()]).toEqual(['acp.sessionHistory.v1', WORKSPACE_KEY]);
    expect(new WorkspaceState(workspaceState).lastActiveSession()).toEqual(address(FIRST_SESSION_ID));
  });

  it('has no retired keys by default and leaves earlier extension data alone', async () => {
    const workspaceState = memoryStore({ 'acp.sessionHistory.v1': { version: 1 } });
    await new WorkspaceState(workspaceState).discardRetired();
    expect([...workspaceState.values.entries()]).toEqual([['acp.sessionHistory.v1', { version: 1 }]]);
  });

  it('settles once every write it started has, as its callers do not wait for them', async () => {
    const workspaceState = heldStore({ 'your-turn.retired.v1': {} });
    const state = new WorkspaceState(workspaceState, ['your-turn.retired.v1']);
    const order: string[] = [];
    const discarding = state.discardRetired();
    const setting = state.setLastActiveSession(address(FIRST_SESSION_ID));
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
    const workspaceState = heldStore({ 'your-turn.retired.v1': {} });
    const state = new WorkspaceState(workspaceState, ['your-turn.retired.v1']);
    const order: string[] = [];
    const writing = state.setLastActiveSession(address(FIRST_SESSION_ID));
    const disposed = state.dispose().then(() => order.push('disposed'));

    void state.setLastActiveSession(address(SECOND_SESSION_ID));
    void state.setWorkspaceTarget(onDevenv);
    void state.discardRetired();
    workspaceState.finish[0]?.();
    await writing;
    order.push('written');
    await disposed;

    expect(order).toEqual(['written', 'disposed']);
    expect(state.lastActiveSession()).toEqual(address(FIRST_SESSION_ID));
    expect(state.workspaceTarget()).toBeUndefined();
    expect([...workspaceState.values.keys()]).toEqual(['your-turn.retired.v1', WORKSPACE_KEY]);
  });
});

describe('StartupRequests', () => {
  const MINUTE = 60_000;
  const otherWorkspace = 'file:///home/me/other';

  it('hands a request to a window of its workspace once, across reloads', async () => {
    const globalState = memoryStore();
    await new StartupRequests(globalState).request(address(FIRST_SESSION_ID));

    const window = new StartupRequests(globalState);
    expect(await window.take(DEVENV)).toEqual(address(FIRST_SESSION_ID));
    expect(await window.take(DEVENV)).toBeUndefined();
    expect(await new StartupRequests(globalState).take(DEVENV)).toBeUndefined();
  });

  it('keeps only the fields of an address in a request, whatever else the caller passes', async () => {
    const globalState = memoryStore();
    await new StartupRequests(globalState).request({ ...address(FIRST_SESSION_ID), extra: 'dropped' } as SessionAddress);

    expect(await new StartupRequests(globalState).take(DEVENV)).toEqual(address(FIRST_SESSION_ID));
  });

  it('gives a window of another workspace nothing, leaving the request for its own', async () => {
    const globalState = memoryStore();
    await new StartupRequests(globalState).request(address(FIRST_SESSION_ID));

    expect(await new StartupRequests(globalState).take(otherWorkspace)).toBeUndefined();
    expect(await new StartupRequests(globalState).take(DEVENV)).toEqual(address(FIRST_SESSION_ID));
  });

  it('answers a request only once it is written', async () => {
    const globalState = heldStore();
    const order: string[] = [];
    const requesting = new StartupRequests(globalState).request(address(FIRST_SESSION_ID)).then(() => order.push('request answered'));
    const taking = new StartupRequests(globalState).take(DEVENV).then(() => order.push('take answered'));

    globalState.finish[1]?.();
    await taking;
    globalState.finish[0]?.();
    await requesting;

    expect(order).toEqual(['take answered', 'request answered']);
  });

  it('answers a take only once the take is written', async () => {
    const globalState = heldStore();
    const requesting = new StartupRequests(globalState).request(address(FIRST_SESSION_ID));
    globalState.finish[0]?.();
    await requesting;
    const order: string[] = [];
    const taking = new StartupRequests(globalState).take(DEVENV).then(() => order.push('take answered'));
    const requestingOther = new StartupRequests(globalState).request(address(SECOND_SESSION_ID, { workspaceUri: LOCAL }))
      .then(() => order.push('request answered'));

    globalState.finish[2]?.();
    await requestingOther;
    globalState.finish[1]?.();
    await taking;

    expect(order).toEqual(['request answered', 'take answered']);
  });

  it('replaces a request for the same workspace with a newer one, which a take of the older does not consume', async () => {
    const globalState = memoryStore();
    const clock = ticking();
    const source = new StartupRequests(globalState, clock);
    const window = new StartupRequests(globalState, clock);
    await source.request(address(FIRST_SESSION_ID));
    await source.request(address(SECOND_SESSION_ID));

    expect(await window.take(DEVENV)).toEqual(address(SECOND_SESSION_ID));
    expect(await window.take(DEVENV)).toBeUndefined();

    await source.request(address(THIRD_SESSION_ID));
    expect(await window.take(DEVENV)).toEqual(address(THIRD_SESSION_ID));
  });

  it.each([
    ['until', 10 * MINUTE - 1, address(FIRST_SESSION_ID)],
    ['not from', 10 * MINUTE, undefined],
  ])('hands a request out %s ten minutes after it was made', async (_, after, expected) => {
    const globalState = memoryStore();
    const clock = stopped();
    await new StartupRequests(globalState, clock).request(address(FIRST_SESSION_ID));

    clock.advance(after);

    expect(await new StartupRequests(globalState, clock).take(DEVENV)).toEqual(expected);
  });

  it('drops expired requests and the record of expired takes, writing nothing when none has expired', async () => {
    const globalState = memoryStore();
    const clock = stopped();
    const requests = new StartupRequests(globalState, clock);
    await requests.request(address(FIRST_SESSION_ID));
    await requests.take(DEVENV);
    clock.advance(5 * MINUTE);
    await requests.request(address(SECOND_SESSION_ID, { workspaceUri: LOCAL }));
    const before = globalState.values.get(STARTUP_REQUESTS_KEY);

    await new StartupRequests(globalState, clock).discardExpired();
    expect(globalState.values.get(STARTUP_REQUESTS_KEY)).toBe(before);

    clock.advance(5 * MINUTE);
    await new StartupRequests(globalState, clock).discardExpired();
    expect(globalState.values.get(STARTUP_REQUESTS_KEY)).toEqual({
      schemaVersion: 1,
      requests: [{ ...address(SECOND_SESSION_ID, { workspaceUri: LOCAL }), requestId: expect.any(String) as unknown, expiresAt: '2026-10-29T10:15:00.000Z' }],
      taken: [],
    });
  });

  it('does not hand out again a request it took while an earlier value is served, nor write that value back', async () => {
    const globalState = revertibleStore();
    const requests = new StartupRequests(globalState);
    await requests.request(address(FIRST_SESSION_ID));
    await requests.take(DEVENV);

    globalState.serveEarlier(STARTUP_REQUESTS_KEY);
    expect(await requests.take(DEVENV)).toBeUndefined();
    await requests.request(address(SECOND_SESSION_ID, { workspaceUri: LOCAL }));

    expect(await new StartupRequests(globalState).take(DEVENV)).toBeUndefined();
  });

  it('keeps its own request while an earlier value is served', async () => {
    const globalState = revertibleStore();
    const requests = new StartupRequests(globalState);
    await requests.request(address(FIRST_SESSION_ID));

    globalState.serveEarlier(STARTUP_REQUESTS_KEY);
    await requests.request(address(SECOND_SESSION_ID, { workspaceUri: LOCAL }));

    expect(await new StartupRequests(globalState).take(DEVENV)).toEqual(address(FIRST_SESSION_ID));
  });

  it('drops malformed requests and takes, keeping the rest', async () => {
    const valid = { ...address(FIRST_SESSION_ID), requestId: 'one', expiresAt: '2026-10-29T10:10:00.000Z' };
    const globalState = memoryStore({
      [STARTUP_REQUESTS_KEY]: {
        schemaVersion: 1,
        requests: [valid, { ...valid, requestId: 2 }, { ...valid, cwd: undefined }, 'request'],
        taken: [{ requestId: 'one' }, null],
      },
    });

    expect(await new StartupRequests(globalState, stopped()).take(DEVENV)).toEqual(address(FIRST_SESSION_ID));
  });

  it('reads a later version as empty and never overwrites it', async () => {
    const later = { schemaVersion: 2, requests: [] };
    const globalState = memoryStore({ [STARTUP_REQUESTS_KEY]: later });
    const requests = new StartupRequests(globalState);

    await requests.request(address(FIRST_SESSION_ID));
    await requests.discardExpired();

    expect(await requests.take(DEVENV)).toBeUndefined();
    expect(globalState.values.get(STARTUP_REQUESTS_KEY)).toBe(later);
  });
});
