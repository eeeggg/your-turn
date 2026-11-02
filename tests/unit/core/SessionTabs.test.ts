import { describe, expect, it } from 'vitest';
import { SessionTabs, type TabReference } from '@/core/SessionTabs';

const first: TabReference = { sessionId: 's1', agentName: 'configured', agentDisplayName: 'Agent', cwd: '/work', title: 'First' };

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
});
