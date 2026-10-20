import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionHistoryStore, type KeyValueStore, type PersistedSessionEntry } from '@/core/SessionHistoryStore';

const STATE_KEY = 'acp.sessionHistory.v1';

/** Stands in for `workspaceState`, which outlives the extension: a new store over the same one is a restart. */
function memoryStore(saved: Record<string, unknown> = {}): KeyValueStore {
  const values = new Map<string, unknown>(Object.entries(saved));
  return {
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key, value) => { values.set(key, value); },
  };
}

function entry(sessionId: string, fields: Partial<PersistedSessionEntry> = {}): PersistedSessionEntry {
  return { agentName: 'fake', cwd: '/work', sessionId, createdAt: '2026-10-18T10:00:00Z', lastActiveAt: '2026-10-18T10:00:00Z', ...fields };
}

const ids = (entries: PersistedSessionEntry[]) => entries.map((e) => e.sessionId);

describe('SessionHistoryStore', () => {
  beforeEach(() => vi.useFakeTimers({ now: Date.parse('2026-10-18T10:00:00Z'), toFake: ['Date'] }));
  afterEach(() => vi.useRealTimers());

  /** Move the clock on, so each change is later than the one before. */
  const later = () => vi.setSystemTime(Date.now() + 60_000);

  describe('across restarts', () => {
    it('reads back what the store saved before', () => {
      const workspaceState = memoryStore();
      const before = new SessionHistoryStore(workspaceState);
      before.upsertNew('fake', '/work', 'a');
      later();
      before.upsertNew('fake', '/work', 'b');
      before.setTitle('fake', 'b', 'Fix the build');
      before.setFirstPromptIfMissing('fake', 'a', 'hello');

      const after = new SessionHistoryStore(workspaceState);

      expect(after.list('fake')).toEqual(before.list('fake'));
      expect(after.list('fake')).toMatchObject([
        { sessionId: 'b', title: 'Fix the build' },
        { sessionId: 'a', firstPrompt: 'hello' },
      ]);
    });

    it('starts empty without saved history, or with history saved in another version', () => {
      expect(new SessionHistoryStore(memoryStore()).list('fake')).toEqual([]);
      const otherVersion = memoryStore({ [STATE_KEY]: { version: 2, entries: [entry('a')] } });
      expect(new SessionHistoryStore(otherVersion).list('fake')).toEqual([]);
    });
  });

  describe('the cap per agent', () => {
    it('drops the least recently active sessions of that agent only', () => {
      const store = new SessionHistoryStore(memoryStore(), 2);
      store.upsertNew('other', '/work', 'x');
      store.upsertNew('fake', '/work', 'a');
      later();
      store.upsertNew('fake', '/work', 'b');
      later();
      store.touch('fake', 'a');
      later();

      store.upsertNew('fake', '/work', 'c');

      expect(ids(store.list('fake'))).toEqual(['c', 'a']);
      expect(ids(store.list('other'))).toEqual(['x']);
    });

    it('is 50 by default', () => {
      const store = new SessionHistoryStore(memoryStore());
      for (let i = 0; i <= 50; i++) {
        later();
        store.upsertNew('fake', '/work', `s${i}`);
      }

      expect(store.list('fake')).toHaveLength(50);
      expect(store.get('fake', 's0')).toBeUndefined();
    });
  });

  describe('malformed saved data', () => {
    it('drops the entries that are not sessions and keeps the rest', () => {
      const saved = memoryStore({
        [STATE_KEY]: {
          version: 1,
          entries: [
            null,
            'not an entry',
            { agentName: 'fake', sessionId: 'no-cwd', createdAt: '2026-10-18T10:00:00Z', lastActiveAt: '2026-10-18T10:00:00Z' },
            { agentName: 'fake', cwd: '/work', createdAt: '2026-10-18T10:00:00Z', lastActiveAt: '2026-10-18T10:00:00Z' },
            entry('numeric-time', { lastActiveAt: 5 as unknown as string }),
            entry('numeric-title', { title: 5 as unknown as string }),
            entry('good'),
          ],
        },
      });

      const store = new SessionHistoryStore(saved);

      expect(ids(store.list('fake'))).toEqual(['good']);
    });
  });
});
