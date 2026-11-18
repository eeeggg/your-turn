import { EventEmitter } from 'node:events';
import { renamesBetween, type AgentConfigEntry } from '@/core/AgentManager';
import { Writes, type SessionAddress, type SessionReferences, type WorkspaceState, type WorkspaceTarget } from '@/core/PersistedState';
import type { SessionEnvironment, SessionInfo } from '@/core/sessions/Manager';

export type TabReference = Pick<SessionInfo, 'sessionId' | 'agentName' | 'agentDisplayName' | 'cwd' | 'title'>;

export interface OpenTab extends TabReference {
  readonly tabId: string;
}

interface TabPersistence {
  readonly workspace: Pick<WorkspaceState, 'tabLayout' | 'setTabLayout' | 'lastActiveSession'>;
  readonly references: Pick<SessionReferences, 'get'>;
  readonly environment: Pick<SessionEnvironment, 'workspaceTarget' | 'workspaceTargetKnown'>;
}

/** This workspace window's navigation references, independent of live connections. */
export class SessionTabs extends EventEmitter<{ changed: [] }> {
  private tabs: OpenTab[] = [];
  private selectedTabId: string | null = null;
  private mru: string[] = [];
  private nextId = 0;
  private readonly addresses = new Map<string, SessionAddress>();
  private readonly renamedTo = new Map<string, string>();
  private readonly writes = new Writes();
  private waiting: Promise<void> | undefined;
  private restoring: Promise<void> | undefined;
  private knownTarget: WorkspaceTarget | undefined;
  private endWait: (() => void) | undefined;
  private readonly stopped = new Promise<undefined>((resolve) => { this.endWait = () => resolve(undefined); });

  constructor(private readonly persistence?: TabPersistence) {
    super();
    if (!persistence) { return; }
    const saved = persistence.workspace.tabLayout();
    const legacy = saved === undefined ? persistence.workspace.lastActiveSession() : undefined;
    const layout = saved ?? { tabs: legacy ? [legacy] : [], selected: legacy ?? null, mru: legacy ? [legacy] : [] };
    const target = persistence.environment.workspaceTarget();
    for (const address of layout.tabs) {
      if (target && (address.host !== target.host || address.workspaceUri !== target.uri)) { continue; }
      const tabId = `tab-${++this.nextId}`;
      const title = persistence.references.get(address)?.title;
      this.tabs.push(tabOf({
        agentName: address.configuredName, agentDisplayName: address.configuredName,
        sessionId: address.sessionId, cwd: address.cwd, ...(title === undefined ? {} : { title }),
      }, tabId));
      this.addresses.set(tabId, { ...address });
    }
    const tabFor = (address: SessionAddress) => this.tabs.find((tab) => {
      const stored = this.addresses.get(tab.tabId);
      return stored?.configuredName === address.configuredName && stored.sessionId === address.sessionId
        && stored.host === address.host && stored.workspaceUri === address.workspaceUri;
    });
    this.selectedTabId = layout.selected ? tabFor(layout.selected)?.tabId ?? null : null;
    this.mru = layout.mru.flatMap((address) => {
      const tab = tabFor(address);
      return tab ? [tab.tabId] : [];
    });
    if (!target && this.tabs.length > 0) {
      this.restoring = Promise.race([persistence.environment.workspaceTargetKnown(), this.stopped]).then((known) => {
        if (!known || this.writes.disposed) { return; }
        this.knownTarget = known;
        const retained = this.tabs.filter((tab) => {
          const address = this.addresses.get(tab.tabId);
          return !address || (address.host === known.host && address.workspaceUri === known.uri);
        });
        if (retained.length === this.tabs.length) { return; }
        const ids = new Set(retained.map((tab) => tab.tabId));
        for (const id of this.addresses.keys()) { if (!ids.has(id)) { this.addresses.delete(id); } }
        this.tabs = retained;
        this.mru = this.mru.filter((id) => ids.has(id));
        if (this.selectedTabId !== null && !ids.has(this.selectedTabId)) { this.selectedTabId = null; }
        this.announce();
      });
    }
  }

  open(reference: TabReference): string {
    reference = this.current(reference);
    const existing = this.find(reference);
    const tabId = existing?.tabId ?? `tab-${++this.nextId}`;
    const next = tabOf(reference, tabId);
    const changed = !existing || !sameReference(existing, next) || this.selectedTabId !== tabId;
    if (existing) { this.tabs = this.tabs.map((tab) => tab === existing ? next : tab); }
    else { this.tabs.push(next); }
    this.selectedTabId = tabId;
    this.mru = [tabId, ...this.mru.filter((id) => id !== tabId)];
    if (changed) { this.announce(); }
    return tabId;
  }

  update(reference: TabReference): void {
    reference = this.current(reference);
    const existing = this.find(reference);
    if (!existing) { return; }
    const next = tabOf(reference, existing.tabId);
    if (sameReference(existing, next)) { return; }
    this.tabs = this.tabs.map((tab) => tab === existing ? next : tab);
    this.announce();
  }

  select(tabId: string): void {
    if (this.selectedTabId === tabId || !this.tabs.some((tab) => tab.tabId === tabId)) { return; }
    this.selectedTabId = tabId;
    this.mru = [tabId, ...this.mru.filter((id) => id !== tabId)];
    this.announce();
  }

  /** Removing the selection offers a candidate; only a successful open may select it. */
  close(tabId: string): OpenTab | undefined {
    if (!this.tabs.some((tab) => tab.tabId === tabId)) { return undefined; }
    const selected = this.selectedTabId === tabId;
    this.tabs = this.tabs.filter((tab) => tab.tabId !== tabId);
    this.addresses.delete(tabId);
    this.mru = this.mru.filter((id) => id !== tabId);
    if (selected) { this.selectedTabId = null; }
    const next = this.tabs.find((tab) => tab.tabId === this.mru[0]);
    this.announce();
    return selected && next ? { ...next } : undefined;
  }

  snapshot(): { tabs: readonly OpenTab[]; selectedTabId: string | null } {
    return { tabs: this.tabs.map((tab) => ({ ...tab })), selectedTabId: this.selectedTabId };
  }

  has(agentName: string, sessionId: string): boolean {
    return this.tabs.some((tab) => tab.agentName === agentName && tab.sessionId === sessionId);
  }

  matches(tabId: string, reference: Pick<TabReference, 'agentName' | 'sessionId'> | undefined): boolean {
    if (!reference) { return false; }
    const name = this.renamedTo.get(reference.agentName) ?? reference.agentName;
    return this.tabs.some((tab) => tab.tabId === tabId && tab.agentName === name && tab.sessionId === reference.sessionId);
  }

  address(tabId: string): SessionAddress | undefined {
    const stored = this.addresses.get(tabId);
    if (stored) { return { ...stored }; }
    const tab = this.tabs.find((tab) => tab.tabId === tabId);
    const target = this.persistence?.environment.workspaceTarget() ?? this.knownTarget;
    return tab && target ? {
      configuredName: tab.agentName, sessionId: tab.sessionId, cwd: tab.cwd,
      host: target.host, workspaceUri: target.uri,
    } : undefined;
  }

  selectedAddress(): SessionAddress | undefined {
    return this.selectedTabId === null ? undefined : this.address(this.selectedTabId);
  }

  rebind(from: string, to: string, sessionId?: string): void {
    if (from === to) { return; }
    const replacements = new Map<string, string>();
    const kept: OpenTab[] = [];
    let changed = false;
    for (const tab of this.tabs) {
      const moving = tab.agentName === from && (sessionId === undefined || tab.sessionId === sessionId);
      const next = moving ? { ...tab, agentName: to } : tab;
      changed ||= moving;
      const address = this.address(tab.tabId);
      if (address && moving) { this.addresses.set(tab.tabId, { ...address, configuredName: to }); }
      const duplicate = kept.find((other) => other.agentName === next.agentName && other.sessionId === next.sessionId);
      if (!duplicate) { kept.push(next); }
      else {
        replacements.set(tab.tabId, duplicate.tabId);
        kept[kept.indexOf(duplicate)] = { ...next, tabId: duplicate.tabId };
        const latestAddress = this.addresses.get(tab.tabId);
        if (latestAddress) { this.addresses.set(duplicate.tabId, latestAddress); }
        this.addresses.delete(tab.tabId);
      }
    }
    if (!changed) { return; }
    this.tabs = kept;
    this.selectedTabId = this.selectedTabId === null ? null : replacements.get(this.selectedTabId) ?? this.selectedTabId;
    this.mru = [...new Set(this.mru.map((id) => replacements.get(id) ?? id))];
    this.announce();
  }

  agentsChanged(before: Readonly<Record<string, AgentConfigEntry>>, after: Readonly<Record<string, AgentConfigEntry>>): void {
    for (const { from, to } of renamesBetween(before, after)) {
      for (const [name, current] of this.renamedTo) {
        if (current === from) { this.renamedTo.set(name, to); }
      }
      this.renamedTo.set(from, to);
      this.rebind(from, to);
    }
    for (const name of Object.keys(after)) { this.renamedTo.delete(name); }
  }

  async settled(): Promise<void> {
    await this.restoring;
    await this.waiting;
    await this.writes.settled();
  }

  async dispose(): Promise<void> {
    this.endWait?.();
    await this.writes.dispose();
    await this.waiting;
    await this.restoring;
  }

  private current(reference: TabReference): TabReference {
    return { ...reference, agentName: this.renamedTo.get(reference.agentName) ?? reference.agentName };
  }

  private announce(): void {
    this.save();
    this.emit('changed');
  }

  private save(): void {
    if (!this.persistence || this.writes.disposed) { return; }
    const tabs = this.tabs.map((tab) => this.address(tab.tabId));
    if (tabs.some((address) => address === undefined)) {
      this.waiting ??= Promise.race([this.persistence.environment.workspaceTargetKnown(), this.stopped]).then((target) => {
        this.waiting = undefined;
        if (target && !this.writes.disposed) { this.knownTarget = target; this.save(); }
      });
      return;
    }
    const addresses = tabs as SessionAddress[];
    this.tabs.forEach((tab, index) => {
      const address = addresses[index];
      if (address) { this.addresses.set(tab.tabId, address); }
    });
    void this.writes.track(this.persistence.workspace.setTabLayout({
      tabs: addresses,
      selected: this.selectedAddress() ?? null,
      mru: this.mru.flatMap((id) => {
        const address = this.address(id);
        return address ? [address] : [];
      }),
    }));
  }

  private find(reference: TabReference): OpenTab | undefined {
    return this.tabs.find((tab) => tab.agentName === reference.agentName && tab.sessionId === reference.sessionId);
  }
}

function sameReference(a: TabReference, b: TabReference): boolean {
  return a.agentName === b.agentName && a.sessionId === b.sessionId && a.agentDisplayName === b.agentDisplayName
    && a.cwd === b.cwd && a.title === b.title;
}

function tabOf(reference: TabReference, tabId: string): OpenTab {
  return {
    tabId, sessionId: reference.sessionId, agentName: reference.agentName,
    agentDisplayName: reference.agentDisplayName, cwd: reference.cwd,
    ...(reference.title === undefined ? {} : { title: reference.title }),
  };
}
