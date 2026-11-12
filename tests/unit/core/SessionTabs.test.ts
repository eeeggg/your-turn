import { describe, expect, it } from 'vitest';
import { SessionTabs, type TabReference } from '@/core/SessionTabs';
import { SessionReferences, WorkspaceState, type KeyValueStore, type SessionAddress } from '@/core/PersistedState';

const first: TabReference = { sessionId: 's1', agentName: 'configured', agentDisplayName: 'Agent', cwd: '/work', title: 'First' };

function memoryStore(): KeyValueStore {
  const values = new Map<string, unknown>();
  return { get: <T>(key: string) => values.get(key) as T | undefined, update: async (key, value) => { values.set(key, value); } };
}

const target = { uri: 'file:///work', host: 'file://' };
const address = (sessionId: string): SessionAddress => ({
  configuredName: 'configured', sessionId, cwd: '/work', workspaceUri: target.uri, host: target.host,
});

function durableTabs(workspace: WorkspaceState, references = new SessionReferences(memoryStore())): SessionTabs {
  return new SessionTabs({
    workspace, references,
    environment: { workspaceTarget: () => target, workspaceTargetKnown: async () => target },
  });
}

describe('SessionTabs', () => {
  it('upserts by configuration and session ID without moving a tab in display order', () => {
    const tabs = new SessionTabs();
    const a = tabs.open(first);
    const b = tabs.open({ ...first, sessionId: 's2' });
    expect(tabs.open({ ...first, title: 'Renamed' })).toBe(a);
    expect(tabs.snapshot()).toEqual({ tabs: [{ ...first, tabId: a, title: 'Renamed' }, { ...first, sessionId: 's2', tabId: b }], selectedTabId: a });
    expect(a).not.toBe(b);
  });

  it('keeps equal session IDs from different configurations distinct', () => {
    const tabs = new SessionTabs();
    const a = tabs.open(first);
    const b = tabs.open({ ...first, agentName: 'other' });
    expect(a).not.toBe(b);
    expect(tabs.snapshot().tabs.map(({ agentName }) => agentName)).toEqual(['configured', 'other']);
  });

  it('returns the most recently selected remaining reference without pretending it opened', () => {
    const tabs = new SessionTabs();
    const a = tabs.open(first);
    const b = tabs.open({ ...first, sessionId: 's2' });
    const c = tabs.open({ ...first, sessionId: 's3' });
    tabs.select(a);
    expect(tabs.close(a)).toEqual({ ...first, sessionId: 's3', tabId: c });
    expect(tabs.snapshot().selectedTabId).toBeNull();
    tabs.select(c);
    expect(tabs.close(b)).toBeUndefined();
    expect(tabs.snapshot()).toEqual({ tabs: [{ ...first, sessionId: 's3', tabId: c }], selectedTabId: c });
    expect(tabs.close(c)).toBeUndefined();
    expect(tabs.snapshot()).toEqual({ tabs: [], selectedTabId: null });
  });

  it('updates titles without opening or selecting and isolates returned snapshots', () => {
    const tabs = new SessionTabs();
    const a = tabs.open(first);
    const old = tabs.snapshot();
    tabs.open({ ...first, sessionId: 's2' });
    const { title: _title, ...untitled } = first;
    tabs.update(untitled);
    tabs.update({ ...first, sessionId: 'missing' });
    tabs.select('missing');
    tabs.close('missing');
    expect(tabs.snapshot().tabs).toHaveLength(2);
    expect(tabs.snapshot().tabs[0]?.title).toBeUndefined();
    expect(old).toEqual({ tabs: [{ ...first, tabId: a }], selectedTabId: a });
  });

  it('starts a new activation with no tabs and does not reuse closed identities', () => {
    const tabs = new SessionTabs();
    const a = tabs.open(first);
    tabs.close(a);
    expect(tabs.open(first)).not.toBe(a);
    expect(new SessionTabs().snapshot()).toEqual({ tabs: [], selectedTabId: null });
  });

  it('reports membership changes when a session tab opens and closes', () => {
    const tabs = new SessionTabs();
    let changes = 0;
    tabs.on('changed', () => { changes++; });

    const tabId = tabs.open(first);
    expect(tabs.has('configured', 's1')).toBe(true);
    expect(tabs.has('other', 's1')).toBe(false);
    expect(changes).toBe(1);

    tabs.open(first);
    expect(changes).toBe(1);

    tabs.close(tabId);
    expect(tabs.has('configured', 's1')).toBe(false);
    expect(changes).toBe(2);
  });

  it('announces completed selection and removal transitions to layout observers', () => {
    const tabs = new SessionTabs();
    const selected: (string | null)[] = [];
    tabs.on('changed', () => { selected.push(tabs.snapshot().selectedTabId); });
    const a = tabs.open(first);
    const b = tabs.open({ ...first, sessionId: 's2' });
    tabs.select(a);
    tabs.close(a);
    expect(selected).toEqual([a, b, a, null]);
  });

  it('reconstructs display order, selection and MRU after a new activation without loading sessions', async () => {
    const workspace = new WorkspaceState(memoryStore());
    const references = new SessionReferences(memoryStore());
    await references.setTitle(address('s1'), 'Stored title');
    const tabs = durableTabs(workspace, references);
    const a = tabs.open(first);
    tabs.open({ ...first, sessionId: 's2', title: 'Second' });
    tabs.open({ ...first, sessionId: 's3', title: 'Third' });
    tabs.select(a);
    await workspace.settled();

    const restored = durableTabs(workspace, references);
    const snapshot = restored.snapshot();
    expect(snapshot.tabs.map(({ sessionId }) => sessionId)).toEqual(['s1', 's2', 's3']);
    expect(snapshot.tabs[0]?.title).toBe('Stored title');
    expect(snapshot.selectedTabId).toBe(snapshot.tabs[0]?.tabId);
    const selected = snapshot.tabs[0];
    if (!selected) { throw new Error('Missing restored tab'); }
    const next = restored.close(selected.tabId);
    expect(next?.sessionId).toBe('s3');
  });

  it('migrates a legacy last session only when no layout exists and preserves an explicitly empty layout', async () => {
    const workspace = new WorkspaceState(memoryStore());
    await workspace.setLastActiveSession(address('s1'));
    const migrated = durableTabs(workspace);
    expect(migrated.snapshot().tabs.map(({ sessionId }) => sessionId)).toEqual(['s1']);
    await workspace.setTabLayout({ tabs: [], selected: null, mru: [] });
    expect(durableTabs(workspace).snapshot()).toEqual({ tabs: [], selectedTabId: null });
  });

  it('persists closing all tabs so the legacy pointer cannot reopen one on reload', async () => {
    const workspace = new WorkspaceState(memoryStore());
    await workspace.setLastActiveSession(address('s1'));
    const tabs = durableTabs(workspace);
    const firstTab = tabs.snapshot().tabs[0];
    if (!firstTab) { throw new Error('Missing migrated tab'); }
    tabs.close(firstTab.tabId);
    await workspace.settled();
    expect(durableTabs(workspace).snapshot()).toEqual({ tabs: [], selectedTabId: null });
  });

  it('keeps restored tabs within this window workspace and host', async () => {
    const workspace = new WorkspaceState(memoryStore());
    await workspace.setTabLayout({
      tabs: [address('s1'), { ...address('elsewhere'), workspaceUri: 'file:///elsewhere' }, { ...address('remote'), host: 'vscode-remote://other' }],
      selected: address('s1'), mru: [],
    });
    expect(durableTabs(workspace).snapshot().tabs.map(({ sessionId }) => sessionId)).toEqual(['s1']);
  });

  it('reconciles restored references when a remote window learns a different host', async () => {
    const workspace = new WorkspaceState(memoryStore());
    await workspace.setTabLayout({ tabs: [address('s1')], selected: address('s1'), mru: [address('s1')] });
    let reveal: (value: typeof target) => void = () => { throw new Error('Target observation was not installed'); };
    const ready = new Promise<typeof target>((resolve) => { reveal = resolve; });
    const tabs = new SessionTabs({
      workspace, references: new SessionReferences(memoryStore()),
      environment: { workspaceTarget: () => undefined, workspaceTargetKnown: () => ready },
    });
    reveal({ ...target, host: 'vscode-remote://different' });
    await tabs.settled();
    expect(tabs.snapshot()).toEqual({ tabs: [], selectedTabId: null });
    await tabs.dispose();
  });

  it('saves the latest layout once a remote target becomes known without resurrecting a closed tab', async () => {
    const workspace = new WorkspaceState(memoryStore());
    let known: typeof target | undefined = undefined;
    let reveal: (value: typeof target) => void = () => { throw new Error('Target observation was not installed'); };
    const ready = new Promise<typeof target>((resolve) => { reveal = resolve; });
    const tabs = new SessionTabs({
      workspace, references: new SessionReferences(memoryStore()),
      environment: { workspaceTarget: () => known, workspaceTargetKnown: () => ready },
    });
    const firstId = tabs.open(first);
    expect(workspace.tabLayout()).toBeUndefined();
    tabs.close(firstId);
    const remaining = tabs.open({ ...first, sessionId: 's2' });
    known = target;
    reveal(target);
    await tabs.settled();
    expect(workspace.tabLayout()).toEqual({ tabs: [address('s2')], selected: address('s2'), mru: [address('s2')] });
    expect(tabs.address(remaining)).toEqual(address('s2'));
    await tabs.dispose();
  });

  it('ends a pending remote layout write on disposal without writing after shutdown', async () => {
    const workspace = new WorkspaceState(memoryStore());
    const tabs = new SessionTabs({
      workspace, references: new SessionReferences(memoryStore()),
      environment: { workspaceTarget: () => undefined, workspaceTargetKnown: () => new Promise(() => {}) },
    });
    tabs.open(first);
    await tabs.dispose();
    expect(workspace.tabLayout()).toBeUndefined();
    tabs.close(tabs.snapshot().selectedTabId ?? 'missing');
    expect(workspace.tabLayout()).toBeUndefined();
  });

  it('keeps running-session reports on the renamed tab and persists its new configuration identity', async () => {
    const workspace = new WorkspaceState(memoryStore());
    const tabs = durableTabs(workspace);
    const firstId = tabs.open(first);
    tabs.agentsChanged({ configured: { command: 'agent' } }, { renamed: { command: 'agent' } });
    tabs.open({ ...first, title: 'Reported after rename' });
    expect(tabs.snapshot().tabs).toEqual([{ ...first, title: 'Reported after rename', agentName: 'renamed', tabId: firstId }]);
    expect(tabs.selectedAddress()?.configuredName).toBe('renamed');
    await tabs.settled();
    expect(workspace.tabLayout()?.tabs).toEqual([{ ...address('s1'), configuredName: 'renamed' }]);
  });
});
