import type { AgentConfigEntry } from '@/core/AgentManager';

export type AgentConfigs = Record<string, AgentConfigEntry>;

/**
 * Where the active agent list comes from in the `your-turn.agents` map: the top level locally, or the group keyed by
 * the current remote authority. `unknown` is a remote window that has not yet learned its authority: it has no active
 * list and accepts no writes, and is never treated as `local`.
 */
export type AgentScope =
  | { readonly kind: 'local' }
  | { readonly kind: 'remote'; readonly authority: string }
  | { readonly kind: 'unknown' };

/** A scope whose key in the map can be written to: every `AgentScope` except `unknown`. */
export type WritableScope = Extract<AgentScope, { kind: 'local' | 'remote' }>;

/** What one key of `your-turn.agents` holds, classified by shape, never by its key or a key prefix. */
export type AgentMapSlot =
  | { readonly kind: 'absent' }
  /** A plain object with a string `command`: an agent configuration, wherever it appears. */
  | { readonly kind: 'agent'; readonly config: AgentConfigEntry }
  /** A plain object without a string `command`: a group of agent configurations; `{}` is an empty one. */
  | { readonly kind: 'group'; readonly agents: AgentConfigs }
  /** Neither shape: an array, a primitive, or `null`. Left alone; never a fallback source for an active list. */
  | { readonly kind: 'other' };

/**
 * Where this window reads and writes agent configurations: local entries when there is no remote extension host;
 * otherwise the group for `host`'s authority, the same host `workspaceTarget` and session addresses carry, or
 * `unknown` while a remote window has yet to learn it. Never derived from `remoteName` beyond this local/remote
 * distinction, and never from `machineId` or SSH-specific parsing.
 */
export function agentScopeOf(remoteName: string | undefined, host: string | undefined): AgentScope {
  if (remoteName === undefined) { return { kind: 'local' }; }
  return host === undefined ? { kind: 'unknown' } : { kind: 'remote', authority: authorityOf(host) };
}

/** The authority portion of a `scheme://authority` host string, as `hostOf` produces it. Treated as opaque. */
function authorityOf(host: string): string {
  return host.slice(host.indexOf('://') + 3);
}

/** Whether two scopes select the same active list: same kind, and for `remote`, the same authority. */
export function sameAgentScope(a: AgentScope, b: AgentScope): boolean {
  return a.kind === 'remote' && b.kind === 'remote' ? a.authority === b.authority : a.kind === b.kind;
}

/** `raw`, the full `your-turn.agents` value from one settings layer or the effective merge, as a plain object. Any other shape has no entries. */
function asMap(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

/**
 * Classifies one value found in `your-turn.agents`: a string `command` makes it an agent configuration; any other
 * plain object is a group, whose own agent-configuration entries are collected the same way. An agent inside a group
 * can itself be named `command` without being mistaken for one, as only the shape of the value at that key matters,
 * never its key or a key prefix.
 */
function classify(value: unknown): AgentMapSlot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'other' };
  }
  const record = value as Record<string, unknown>;
  if (typeof record['command'] === 'string') {
    return { kind: 'agent', config: record as unknown as AgentConfigEntry };
  }
  return { kind: 'group', agents: agentEntries(record) };
}

function agentEntries(entries: Record<string, unknown>): AgentConfigs {
  const agents: AgentConfigs = {};
  for (const [name, entry] of Object.entries(entries)) {
    const nested = classify(entry);
    if (nested.kind === 'agent') {
      agents[name] = nested.config;
    }
  }
  return agents;
}

/** What occupies `key` at the top level of `raw`. */
export function slotStatus(raw: unknown, key: string): AgentMapSlot {
  const map = asMap(raw);
  return Object.hasOwn(map, key) ? classify(map[key]) : { kind: 'absent' };
}

/**
 * The agent configurations `scope` selects out of `raw`. Local scope reads the top-level agent configurations;
 * remote scope reads the group keyed by its authority. Never falls back to another scope, even when the selected
 * group is missing, empty, or malformed.
 */
export function activeAgents(raw: unknown, scope: AgentScope): AgentConfigs {
  switch (scope.kind) {
    case 'unknown':
      return {};
    case 'local':
      return agentEntries(asMap(raw));
    case 'remote': {
      const slot = slotStatus(raw, scope.authority);
      return slot.kind === 'group' ? slot.agents : {};
    }
  }
}

/**
 * Replace the valid agent configurations in the selected list with the complete set in `agents`.
 * Keep other lists and malformed entries. Callers check scope and name conflicts before writing.
 */
export function withActiveAgents(raw: unknown, scope: WritableScope, agents: AgentConfigs): Record<string, unknown> {
  const map = asMap(raw);
  const entries = scope.kind === 'local' ? map : asMap(map[scope.authority]);
  const kept = Object.fromEntries(Object.entries(entries).filter(([, value]) => classify(value).kind !== 'agent'));
  const updated = { ...kept, ...agents };
  return scope.kind === 'local' ? updated : { ...map, [scope.authority]: updated };
}

/**
 * Whether `scope`'s own key can be written to at all, independent of any particular agent name: only meaningful for a
 * remote scope, whose single authority key can itself already be a local agent configuration (`authority-is-agent`)
 * or hold neither a group nor an agent configuration (`authority-malformed`), such as an array, a string, or `null`.
 * `undefined` means the write is clear to proceed; a malformed or occupied active group is left alone rather than
 * silently replaced. Local scope has no such whole-scope key, so this is always `undefined` for it; its per-name
 * collisions are `nameConflict`.
 */
export function scopeConflict(raw: unknown, scope: WritableScope): 'authority-is-agent' | 'authority-malformed' | undefined {
  if (scope.kind === 'local') { return undefined; }
  const slot = slotStatus(raw, scope.authority).kind;
  if (slot === 'agent') { return 'authority-is-agent'; }
  if (slot === 'other') { return 'authority-malformed'; }
  return undefined;
}

/**
 * Whether adding `name` would overwrite a value that is outside the active agent list.
 * A local name can collide with a group. In either scope, a name can collide with a malformed entry.
 */
export function nameConflict(raw: unknown, scope: WritableScope, name: string): 'name-is-group' | 'name-is-malformed' | undefined {
  const map = asMap(raw);
  const entries = scope.kind === 'local' ? map : asMap(map[scope.authority]);
  const slot = slotStatus(entries, name).kind;
  if (slot === 'absent' || slot === 'agent') { return undefined; }
  return scope.kind === 'local' && slot === 'group' ? 'name-is-group' : 'name-is-malformed';
}
