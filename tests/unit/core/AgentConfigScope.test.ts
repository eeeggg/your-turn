import { describe, expect, it } from 'vitest';
import {
  activeAgents,
  agentScopeOf,
  nameConflict,
  sameAgentScope,
  scopeConflict,
  slotStatus,
  withActiveAgents,
} from '@/core/AgentConfigScope';

describe('agentScopeOf', () => {
  it('is local when there is no remote extension host', () => {
    expect(agentScopeOf(undefined, 'file://')).toEqual({ kind: 'local' });
    expect(agentScopeOf(undefined, undefined)).toEqual({ kind: 'local' });
  });

  it('is remote, keyed by the host authority, for a remote extension host with a known host', () => {
    expect(agentScopeOf('ssh-remote', 'vscode-remote://ssh-remote+devenv')).toEqual({ kind: 'remote', authority: 'ssh-remote+devenv' });
  });

  it('is unknown for a remote extension host with no host yet, and is never treated as local', () => {
    const scope = agentScopeOf('ssh-remote', undefined);
    expect(scope).toEqual({ kind: 'unknown' });
    expect(scope.kind).not.toBe('local');
  });
});

describe('sameAgentScope', () => {
  it('treats two local scopes as the same', () => {
    expect(sameAgentScope({ kind: 'local' }, { kind: 'local' })).toBe(true);
  });

  it('treats two remote scopes of the same authority as the same', () => {
    expect(sameAgentScope({ kind: 'remote', authority: 'ssh-remote+devenv' }, { kind: 'remote', authority: 'ssh-remote+devenv' })).toBe(true);
  });

  it('treats remote scopes of different authorities as different', () => {
    expect(sameAgentScope({ kind: 'remote', authority: 'ssh-remote+devenv' }, { kind: 'remote', authority: 'ssh-remote+other' })).toBe(false);
  });

  it('treats local, remote, and unknown as all different from one another', () => {
    expect(sameAgentScope({ kind: 'local' }, { kind: 'unknown' })).toBe(false);
    expect(sameAgentScope({ kind: 'local' }, { kind: 'remote', authority: 'ssh-remote+devenv' })).toBe(false);
    expect(sameAgentScope({ kind: 'unknown' }, { kind: 'remote', authority: 'ssh-remote+devenv' })).toBe(false);
    expect(sameAgentScope({ kind: 'unknown' }, { kind: 'unknown' })).toBe(true);
  });
});

describe('activeAgents', () => {
  const local = { kind: 'local' } as const;
  const devenv = { kind: 'remote', authority: 'ssh-remote+devenv' } as const;

  it('reads top-level entries for local scope', () => {
    const raw = { one: { command: 'one' }, two: { command: 'two' } };
    expect(activeAgents(raw, local)).toEqual({ one: { command: 'one' }, two: { command: 'two' } });
  });

  it('reads the matching remote group for remote scope', () => {
    const raw = {
      one: { command: 'one' },
      'ssh-remote+devenv': { two: { command: 'two' } },
    };
    expect(activeAgents(raw, devenv)).toEqual({ two: { command: 'two' } });
  });

  it('is empty for a missing remote group, never falling back to top-level entries', () => {
    const raw = { one: { command: 'one' } };
    expect(activeAgents(raw, devenv)).toEqual({});
  });

  it('is empty for an empty remote group', () => {
    const raw = { 'ssh-remote+devenv': {} };
    expect(activeAgents(raw, devenv)).toEqual({});
  });

  it('is empty for an unknown authority, never falling back to top-level entries', () => {
    const raw = { one: { command: 'one' } };
    expect(activeAgents(raw, { kind: 'unknown' })).toEqual({});
  });

  it('does not let an empty group in one layer erase entries merged in from another', () => {
    // The effective map VS Code hands back already merges layers; an empty default/workspace layer for this group
    // must not be visible separately from one with entries, so there is nothing for activeAgents to do differently.
    // This test documents that activeAgents only ever sees the already-merged result.
    const merged = { 'ssh-remote+devenv': { one: { command: 'one' } } };
    expect(activeAgents(merged, devenv)).toEqual({ one: { command: 'one' } });
  });

  it('ignores a malformed active group rather than falling back', () => {
    const raw = { 'ssh-remote+devenv': 'not an object' };
    expect(activeAgents(raw, devenv)).toEqual({});
  });

  it('ignores a malformed top-level value, as it classifies as neither agent nor group entry', () => {
    const raw = { stray: 'not an object', one: { command: 'one' } };
    expect(activeAgents(raw, local)).toEqual({ one: { command: 'one' } });
  });

  it('does not classify a group by a key prefix or by having a command-named member that is itself a group', () => {
    const raw = {
      'ssh-remote+devenv': {
        command: { command: 'nested-command-named-agent' },
      },
    };
    expect(activeAgents(raw, devenv)).toEqual({ command: { command: 'nested-command-named-agent' } });
  });

  it('treats the same agent name in different lists as unrelated', () => {
    const raw = {
      one: { command: 'local-one' },
      'ssh-remote+devenv': { one: { command: 'remote-one' } },
    };
    expect(activeAgents(raw, local)).toEqual({ one: { command: 'local-one' } });
    expect(activeAgents(raw, devenv)).toEqual({ one: { command: 'remote-one' } });
  });
});

describe('slotStatus', () => {
  it('reports absent for a key that is not present', () => {
    expect(slotStatus({}, 'ssh-remote+devenv')).toEqual({ kind: 'absent' });
  });

  it('reports agent for a plain object with a string command', () => {
    expect(slotStatus({ one: { command: 'one' } }, 'one')).toEqual({ kind: 'agent', config: { command: 'one' } });
  });

  it('reports group, including an empty group, for a plain object without a string command', () => {
    expect(slotStatus({ g: {} }, 'g')).toEqual({ kind: 'group', agents: {} });
    expect(slotStatus({ g: { one: { command: 'one' } } }, 'g')).toEqual({ kind: 'group', agents: { one: { command: 'one' } } });
  });

  it('reports other for an array, a primitive, or null', () => {
    expect(slotStatus({ k: [] }, 'k')).toEqual({ kind: 'other' });
    expect(slotStatus({ k: 'x' }, 'k')).toEqual({ kind: 'other' });
    expect(slotStatus({ k: null }, 'k')).toEqual({ kind: 'other' });
  });
});

describe('nameConflict', () => {
  it('reports no conflict adding a new local agent name', () => {
    expect(nameConflict({ one: { command: 'one' } }, { kind: 'local' }, 'two')).toBeUndefined();
  });

  it('reports no conflict replacing an existing local agent of the same name', () => {
    expect(nameConflict({ one: { command: 'one' } }, { kind: 'local' }, 'one')).toBeUndefined();
  });

  it('reports a conflict adding a local agent whose name is already a group', () => {
    expect(nameConflict({ 'ssh-remote+devenv': {} }, { kind: 'local' }, 'ssh-remote+devenv')).toBe('name-is-group');
  });

  it('reports a conflict adding a local agent whose name holds a malformed value', () => {
    expect(nameConflict({ stray: 'keep this value' }, { kind: 'local' }, 'stray')).toBe('name-is-malformed');
  });

  it('does not treat a top-level key as a name collision when adding a remote agent', () => {
    const raw = { 'ssh-remote+devenv': {} };
    expect(nameConflict(raw, { kind: 'remote', authority: 'ssh-remote+devenv' }, 'ssh-remote+devenv')).toBeUndefined();
  });
});

describe('scopeConflict', () => {
  it('never reports a conflict for local scope, which has no single key of its own', () => {
    expect(scopeConflict({ 'ssh-remote+devenv': { command: 'already-an-agent' } }, { kind: 'local' })).toBeUndefined();
  });

  it('reports no conflict writing to a remote group that does not exist yet', () => {
    expect(scopeConflict({}, { kind: 'remote', authority: 'ssh-remote+devenv' })).toBeUndefined();
  });

  it('reports no conflict writing to a remote group that already exists', () => {
    const raw = { 'ssh-remote+devenv': { one: { command: 'one' } } };
    expect(scopeConflict(raw, { kind: 'remote', authority: 'ssh-remote+devenv' })).toBeUndefined();
  });

  it('reports a conflict writing to a remote authority key that is already a local agent configuration', () => {
    const raw = { 'ssh-remote+devenv': { command: 'already-an-agent' } };
    expect(scopeConflict(raw, { kind: 'remote', authority: 'ssh-remote+devenv' })).toBe('authority-is-agent');
  });

  it('reports a conflict writing to a remote authority key holding a malformed value, rather than allowing it to be silently replaced', () => {
    const raw = { 'ssh-remote+devenv': 'not an object' };
    expect(scopeConflict(raw, { kind: 'remote', authority: 'ssh-remote+devenv' })).toBe('authority-malformed');
  });
});

describe('withActiveAgents', () => {
  const local = { kind: 'local' } as const;
  const devenv = { kind: 'remote', authority: 'ssh-remote+devenv' } as const;

  it('replaces the complete set of top-level agent configurations locally, preserving unrelated groups', () => {
    const raw = {
      one: { command: 'one' },
      'ssh-remote+devenv': { two: { command: 'two' } },
    };
    const result = withActiveAgents(raw, local, { one: { command: 'one' }, mine: { command: 'npx' } });
    expect(result).toEqual({
      one: { command: 'one' },
      mine: { command: 'npx' },
      'ssh-remote+devenv': { two: { command: 'two' } },
    });
  });

  it('replaces only the named remote group, preserving local entries and other groups', () => {
    const raw = {
      one: { command: 'one' },
      'ssh-remote+devenv': { two: { command: 'two' } },
      'ssh-remote+other': { three: { command: 'three' } },
    };
    const result = withActiveAgents(raw, devenv, { two: { command: 'two' }, mine: { command: 'npx' } });
    expect(result).toEqual({
      one: { command: 'one' },
      'ssh-remote+devenv': { two: { command: 'two' }, mine: { command: 'npx' } },
      'ssh-remote+other': { three: { command: 'three' } },
    });
  });

  it('creates the remote group when it was absent', () => {
    const raw = { one: { command: 'one' } };
    const result = withActiveAgents(raw, devenv, { mine: { command: 'npx' } });
    expect(result).toEqual({ one: { command: 'one' }, 'ssh-remote+devenv': { mine: { command: 'npx' } } });
  });

  it('keeps an empty group after removing its last entry', () => {
    const raw = { 'ssh-remote+devenv': { one: { command: 'one' } } };
    const result = withActiveAgents(raw, devenv, {});
    expect(result).toEqual({ 'ssh-remote+devenv': {} });
  });

  it('leaves a malformed or unrelated top-level value untouched when writing locally', () => {
    const raw = { stray: 'not an object', one: { command: 'one' } };
    const result = withActiveAgents(raw, local, { two: { command: 'two' } });
    expect(result).toEqual({ stray: 'not an object', two: { command: 'two' } });
  });
});
