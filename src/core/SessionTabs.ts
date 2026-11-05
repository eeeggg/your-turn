import type { SessionInfo } from '@/core/SessionManager';

export type TabReference = Pick<SessionInfo, 'sessionId' | 'agentName' | 'agentDisplayName' | 'cwd' | 'title'>;

export interface OpenTab extends TabReference {
  readonly tabId: string;
}

/** Activation-local references in this window's workspace and host scope. */
export class SessionTabs {
  private tabs: OpenTab[] = [];
  private selectedTabId: string | null = null;
  private mru: string[] = [];
  private nextId = 0;

  open(reference: TabReference): string {
    const existing = this.find(reference);
    const tabId = existing?.tabId ?? `tab-${++this.nextId}`;
    if (existing) { this.update(reference); }
    else { this.tabs.push(tabOf(reference, tabId)); }
    this.select(tabId);
    return tabId;
  }

  update(reference: TabReference): void {
    const existing = this.find(reference);
    if (!existing) { return; }
    this.tabs = this.tabs.map((tab) => tab === existing ? tabOf(reference, tab.tabId) : tab);
  }

  select(tabId: string): void {
    if (!this.tabs.some((tab) => tab.tabId === tabId)) { return; }
    this.selectedTabId = tabId;
    this.mru = [tabId, ...this.mru.filter((id) => id !== tabId)];
  }

  /** Removing the selection offers a candidate; only a successful open may select it. */
  close(tabId: string): OpenTab | undefined {
    this.tabs = this.tabs.filter((tab) => tab.tabId !== tabId);
    this.mru = this.mru.filter((id) => id !== tabId);
    if (this.selectedTabId !== tabId) { return undefined; }
    this.selectedTabId = null;
    const next = this.tabs.find((tab) => tab.tabId === this.mru[0]);
    return next && { ...next };
  }

  snapshot(): { tabs: readonly OpenTab[]; selectedTabId: string | null } {
    return { tabs: this.tabs.map((tab) => ({ ...tab })), selectedTabId: this.selectedTabId };
  }

  private find(reference: TabReference): OpenTab | undefined {
    return this.tabs.find((tab) => tab.agentName === reference.agentName && tab.sessionId === reference.sessionId);
  }
}

function tabOf(reference: TabReference, tabId: string): OpenTab {
  return {
    tabId, sessionId: reference.sessionId, agentName: reference.agentName,
    agentDisplayName: reference.agentDisplayName, cwd: reference.cwd,
    ...(reference.title === undefined ? {} : { title: reference.title }),
  };
}
