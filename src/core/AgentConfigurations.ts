import { basename } from 'node:path';

import {
  activeAgents,
  nameConflict,
  scopeConflict,
  withActiveAgents,
  type AgentConfigs,
  type AgentScope,
  type WritableScope
} from '@/core/AgentConfigScope';
import { launchPath, type AgentConfigEntry } from '@/core/AgentManager';
import { logError, logWarning, messageOf } from '@/core/Log';
import type { PackageRunner, PackageRunnerCheck } from '@/core/PackageRunners';
import type { RegistryAgent } from '@/core/RegistryClient';
import type { SessionManager } from '@/core/sessions/Manager';
import {
  ConfigurationTarget,
  QuickPickItemKind,
  type QuickPickItem,
  type Window,
  type WorkspaceConfiguration
} from '@/core/VsCodeApi';

/** Where Add Agent and Detect Agents learn what agents there are and what this machine can run. */
export interface AgentSources {
  fetchRegistry(): Promise<readonly RegistryAgent[]>;
  checkRunner(runner: PackageRunner): Promise<PackageRunnerCheck>;
  /** The full path of a command on the PATH VS Code sees, if it is there. */
  findOnPath(command: string): Promise<string | undefined>;
  /** This machine, as the registry names platforms: `linux-x86_64`. */
  readonly platform: string | undefined;
}

/** An agent from the agent registry whose binary was found on the PATH. */
interface Found {
  agent: RegistryAgent;
  config: AgentConfigEntry;
  path: string;
}

/** What an item in Add Agent's quick pick leads to: entering an agent by hand, adding one from the agent registry, or why nothing can be added. */
type Source = 'custom' | { name: string; version: string; config: AgentConfigEntry } | { cannotAdd: string };

const CUSTOM: QuickPickItem = { label: 'Custom…', detail: 'Enter a name, the command that starts the agent, and its arguments' };

/** The commands that add and remove agent configurations, kept in the active list of the `your-turn.agents` setting. */
export class AgentConfigurations {
  constructor(
    /** The `your-turn` section of the settings; VS Code's configuration objects are snapshots, so it is read fresh each time. */
    private readonly configuration: () => WorkspaceConfiguration,
    /** Where the active list is: local, the group for a known remote authority, or unknown while that is not yet learned. */
    private readonly scope: () => AgentScope,
    private readonly sessions: SessionManager,
    private readonly window: Window,
    private readonly sources: AgentSources,
  ) {}

  /** Add an agent configuration, entered by hand or picked from the agent registry. */
  async add(): Promise<void> {
    const scope = this.scope();
    if (scope.kind === 'unknown') {
      this.sayAuthorityUnknown();
      return;
    }
    const conflict = scopeConflict(this.rawAgents(), scope);
    if (conflict) {
      this.sayScopeConflict(scope, conflict);
      return;
    }
    const source = await this.pickSource();
    if (source === 'custom') {
      await this.addByHand(scope);
    } else if (source && 'cannotAdd' in source) {
      void this.window.showInformationMessage(source.cannotAdd);
    } else if (source) {
      await this.addFromRegistry(scope, source);
    }
  }

  /**
   * Custom is offered at once and the registry's agents as they arrive, so
   * adding by hand never waits on the network.
   */
  private pickSource(): Promise<Source | undefined> {
    const pick = this.window.createQuickPick();
    pick.title = 'Add ACP Agent';
    pick.placeholder = 'Pick an agent from the ACP registry, or Custom to enter one';
    const sources = new Map<QuickPickItem, Source>([[CUSTOM, 'custom']]);
    let open = true;
    return new Promise((resolve) => {
      pick.onDidAccept(() => {
        const [item] = pick.selectedItems;
        const source = item && sources.get(item);
        if (source) {
          resolve(source);
          pick.dispose();
        }
      });
      pick.onDidHide(() => {
        open = false;
        resolve(undefined);
        pick.dispose();
      });
      pick.items = [CUSTOM];
      pick.busy = true;
      pick.show();
      void this.registryItems(sources).then((items) => {
        if (!open) { return; }
        pick.items = [CUSTOM, ...items];
        pick.busy = false;
      });
    });
  }

  private async registryItems(sources: Map<QuickPickItem, Source>): Promise<QuickPickItem[]> {
    const leadsTo = (item: QuickPickItem, source: Source) => {
      sources.set(item, source);
      return item;
    };
    const separator: QuickPickItem = { label: 'ACP registry', kind: QuickPickItemKind.Separator };
    const [fetched, npx, uvx] = await Promise.all([
      this.sources.fetchRegistry().then((agents) => ({ agents }), (error: unknown) => ({ error })),
      this.sources.checkRunner('npx'),
      this.sources.checkRunner('uvx'),
    ]);
    if ('error' in fetched) {
      logWarning('Failed to fetch the ACP registry', { error: fetched.error });
      const reason = messageOf(fetched.error);
      return [separator, leadsTo(
        { label: '$(warning) The ACP registry could not be fetched', detail: reason },
        { cannotAdd: `Could not fetch the ACP registry: ${reason}` },
      )];
    }
    const { agents } = fetched;
    if (agents.length === 0) {
      return [separator, leadsTo({ label: 'The ACP registry lists no agents' }, { cannotAdd: 'The ACP registry lists no agents.' })];
    }

    const runners = { npx, uvx };
    const unavailable = (['npx', 'uvx'] as const).flatMap((runner) => {
      const check = runners[runner];
      return !check.works && agents.some((a) => a.runs.through === runner)
        ? [leadsTo({ label: `$(warning) ${runner} is not available`, detail: check.reason }, { cannotAdd: check.reason })]
        : [];
    });
    return [separator, ...unavailable, ...agents.map((agent) => {
      const item = { label: agent.name, description: agent.version };
      const { runs } = agent;
      if (runs.through === 'binary') {
        return leadsTo(
          { ...item, detail: `${agent.description} — distributed only as a binary, which Add Agent does not download; if it is installed, Detect Agents finds it` },
          { cannotAdd: `${agent.name} is distributed only as a binary, which Add Agent does not download. If it is installed, Detect Agents finds it; otherwise install it, then add it with Custom.` },
        );
      }
      const check = runners[runs.through];
      if (!check.works) {
        return leadsTo(
          { ...item, detail: `${agent.description} — needs ${runs.through}, which is not available` },
          { cannotAdd: `${agent.name} needs ${runs.through}, which is not available: ${check.reason}` },
        );
      }
      return leadsTo(
        { ...item, detail: `${agent.description} — runs ${commandLine(runs.config)}` },
        { name: agent.name, version: agent.version, config: runs.config },
      );
    })];
  }

  /** Confirm and save an agent from the agent registry; nothing connects to it. */
  private async addFromRegistry(scope: WritableScope, { name, version, config }: Extract<Source, { config: AgentConfigEntry }>): Promise<void> {
    if (this.inActiveWorkspace(scope, name)) {
      this.sayDefinedInWorkspace(name);
      return;
    }
    if (nameConflict(this.rawAgents(), scope, name)) {
      this.sayNameConflict(name);
      return;
    }
    const replacing = Object.hasOwn(this.activeList(scope), name);
    const runs = `It runs: ${commandLine(config)}`;
    const action = replacing ? 'Replace' : 'Add';
    const choice = await this.window.showQuickPick([
      {
        label: action,
        detail: replacing ? `Its configuration is overwritten, and the agent is stopped if it is running. ${runs}` : runs,
      },
      { label: 'Cancel' },
    ], {
      title: 'Add ACP Agent',
      placeHolder: replacing
        ? `Replace agent "${name}" with ${name} ${version} from the ACP registry?`
        : `Add ${name} ${version} from the ACP registry?`,
    });
    if (choice?.label !== action) { return; }
    await this.saveAgent(scope, name, config, replacing);
  }

  /** Ask for a name, command, and arguments, and save them as an agent configuration. */
  private async addByHand(scope: WritableScope): Promise<void> {
    const name = (await this.window.showInputBox({
      prompt: 'Agent name',
      placeHolder: 'my-agent',
      title: 'Add ACP Agent',
    }))?.trim();
    if (!name) { return; }

    if (this.inActiveWorkspace(scope, name)) {
      this.sayDefinedInWorkspace(name);
      return;
    }
    if (nameConflict(this.rawAgents(), scope, name)) {
      this.sayNameConflict(name);
      return;
    }

    const replacing = Object.hasOwn(this.activeList(scope), name);
    if (replacing) {
      const choice = await this.window.showQuickPick([
        { label: 'Replace', detail: 'Its configuration is overwritten, and the agent is stopped if it is running.' },
        { label: 'Cancel' },
      ], {
        title: 'Add ACP Agent',
        placeHolder: `Replace agent "${name}"?`,
      });
      if (choice?.label !== 'Replace') { return; }
    }

    const command = (await this.window.showInputBox({
      prompt: 'Command to launch the agent',
      placeHolder: 'npx',
      title: 'Agent Command',
    }))?.trim();
    if (!command) { return; }

    const args = await this.window.showInputBox({
      prompt: 'Arguments (space-separated)',
      placeHolder: '-y @my-org/agent',
      title: 'Agent Arguments',
    });
    if (args === undefined) { return; }

    await this.saveAgent(scope, name, { command, args: splitArguments(args) }, replacing);
  }

  /**
   * Look on the PATH for the commands the agent registry's binaries run on
   * this machine, and add those the user picks. An agent whose command is
   * already configured, under any name or by its full path, is left out.
   */
  async detect(): Promise<void> {
    const scope = this.scope();
    if (scope.kind === 'unknown') {
      this.sayAuthorityUnknown();
      return;
    }
    const conflict = scopeConflict(this.rawAgents(), scope);
    if (conflict) {
      this.sayScopeConflict(scope, conflict);
      return;
    }

    let registry: readonly RegistryAgent[];
    try {
      registry = await this.sources.fetchRegistry();
    } catch (error) {
      logError('Failed to fetch the ACP registry', error);
      void this.window.showErrorMessage(`Could not fetch the ACP registry, which says what to look for: ${messageOf(error)}`);
      return;
    }

    const { platform } = this.sources;
    const candidates = registry.flatMap((agent) => {
      const binary = platform === undefined ? undefined : agent.binary?.[platform];
      if (!binary) { return []; }
      const config: AgentConfigEntry = {
        command: basename(binary.cmd),
        ...(binary.args ? { args: binary.args } : {}),
        ...(binary.env ? { env: binary.env } : {}),
      };
      return [{ agent, config }];
    });
    const found = (await Promise.all(candidates.map(async (candidate): Promise<Found | undefined> => {
      const path = await this.sources.findOnPath(candidate.config.command);
      return path === undefined ? undefined : { ...candidate, path };
    }))).filter((f) => f !== undefined);
    if (found.length === 0) {
      void this.window.showInformationMessage(
        `No agent from the ACP registry was found: looked for ${candidates.length} commands on the PATH VS Code sees: ${launchPath()}`,
      );
      return;
    }

    const configured = new Set(Object.values(this.activeList(scope)).map((config) => basename(config.command)));
    const offered = found.filter((f) => !configured.has(f.config.command));
    if (offered.length === 0) {
      void this.window.showInformationMessage('Every agent from the ACP registry found on the PATH VS Code sees is already configured.');
      return;
    }

    const items = new Map<QuickPickItem, Found>(offered.map((f) => [{
      label: f.agent.name,
      description: commandLine(f.config),
      detail: `${f.agent.description}. Found at ${f.path}; the registry lists ${f.agent.version}, yours may differ`,
    }, f]));
    const picked = await this.window.showQuickPick([...items.keys()], {
      title: 'Detect ACP Agents',
      placeHolder: 'Agents from the ACP registry found on the PATH VS Code sees; pick those to add',
      canPickMany: true,
    });
    if (!picked || picked.length === 0) { return; }

    const adding: AgentConfigs = {};
    const replacing: string[] = [];
    for (const { agent: { name }, config } of picked.flatMap((item) => items.get(item) ?? [])) {
      if (this.inActiveWorkspace(scope, name)) {
        this.sayDefinedInWorkspace(name);
        continue;
      }
      if (nameConflict(this.rawAgents(), scope, name)) {
        this.sayNameConflict(name);
        continue;
      }
      if (Object.hasOwn(this.activeList(scope), name)) {
        const choice = await this.window.showQuickPick([
          { label: 'Replace', detail: `Its configuration is overwritten, and the agent is stopped if it is running. It runs: ${commandLine(config)}` },
          { label: 'Skip' },
        ], {
          title: 'Detect ACP Agents',
          placeHolder: `Replace agent "${name}"?`,
        });
        if (choice?.label !== 'Replace') { continue; }
        replacing.push(name);
      }
      adding[name] = config;
    }
    const names = Object.keys(adding);
    if (names.length === 0) { return; }

    const saved = await this.saveAdditions(scope, adding, new Set(replacing));
    const quoted = saved.map((name) => `"${name}"`).join(', ');
    if (quoted) {
      void this.window.showInformationMessage(saved.length === 1 ? `Agent ${quoted} added.` : `Agents added: ${quoted}.`);
    }
  }

  private async saveAgent(scope: WritableScope, name: string, config: AgentConfigEntry, replacing: boolean): Promise<void> {
    const saved = await this.saveAdditions(scope, { [name]: config }, replacing ? new Set([name]) : new Set());
    if (saved.includes(name)) {
      void this.window.showInformationMessage(replacing ? `Agent "${name}" replaced.` : `Agent "${name}" added.`);
    }
  }

  /** Recheck additions against fresh effective and writable maps after every picker and disconnect has completed. */
  private async saveAdditions(scope: WritableScope, additions: AgentConfigs, confirmedReplacements: ReadonlySet<string>): Promise<string[]> {
    const accepted = (effective: unknown): AgentConfigs => {
      const result: AgentConfigs = {};
      const conflict = scopeConflict(effective, scope);
      if (conflict) {
        this.sayScopeConflict(scope, conflict);
        return result;
      }
      const active = activeAgents(effective, scope);
      for (const [name, config] of Object.entries(additions)) {
        if (this.inActiveWorkspace(scope, name)) {
          this.sayDefinedInWorkspace(name);
        } else if (nameConflict(effective, scope, name)) {
          this.sayNameConflict(name);
        } else if (Object.hasOwn(active, name) && !confirmedReplacements.has(name)) {
          void this.window.showInformationMessage(`Cannot add "${name}": it was configured while the picker was open. Confirm the replacement and try again.`);
        } else {
          result[name] = config;
        }
      }
      return result;
    };

    let current = accepted(this.rawAgents());
    if (Object.keys(current).length === 0) { return []; }
    const replacing = Object.keys(current).filter((name) => confirmedReplacements.has(name));
    await Promise.all(replacing.map((name) => this.sessions.disconnectAgent(name)));

    // Settings can change while disconnecting an agent. Recheck names and group collisions before applying the edit.
    current = accepted(this.rawAgents());
    if (Object.keys(current).length === 0) { return []; }
    const userRaw = this.rawUserAgents();
    const userConflict = scopeConflict(userRaw, scope);
    if (userConflict) {
      this.sayScopeConflict(scope, userConflict);
      return [];
    }
    const writable = Object.fromEntries(Object.entries(current).filter(([name]) => {
      if (nameConflict(userRaw, scope, name)) {
        this.sayNameConflict(name);
        return false;
      }
      return true;
    }));
    if (Object.keys(writable).length === 0) { return []; }
    const updated = withActiveAgents(userRaw, scope, { ...activeAgents(userRaw, scope), ...writable });
    await this.configuration().update('agents', updated, ConfigurationTarget.Global);
    return Object.keys(writable);
  }

  private sayDefinedInWorkspace(name: string): void {
    void this.window.showInformationMessage(`Agent "${name}" is defined in the workspace settings; edit them to change it.`);
  }

  private sayAuthorityUnknown(): void {
    void this.window.showInformationMessage('The remote authority is not yet known; agent configurations are unavailable until it is.');
  }

  private sayNameConflict(name: string): void {
    void this.window.showInformationMessage(`Cannot add "${name}": that name already holds another value in the settings.`);
  }

  /** `scope` is always remote here, as `scopeConflict` never reports a conflict for local scope. */
  private sayScopeConflict(scope: WritableScope, conflict: 'authority-is-agent' | 'authority-malformed'): void {
    if (scope.kind !== 'remote') { return; }
    const problem = conflict === 'authority-is-agent'
      ? 'a single agent configuration there, not a group'
      : 'not a valid group of agent configurations there';
    void this.window.showInformationMessage(`Cannot change agents for "${scope.authority}": its entry in the user settings is ${problem}.`);
  }

  /** Stop an agent and remove its configuration, asking which when none is given. */
  async remove(agentName?: string): Promise<void> {
    const scope = this.scope();
    if (scope.kind === 'unknown') {
      this.sayAuthorityUnknown();
      return;
    }

    const agentNames = Object.keys(this.activeList(scope));
    if (agentNames.length === 0) {
      void this.window.showInformationMessage('No agents configured.');
      return;
    }

    const name = agentName ?? await this.window.showQuickPick(agentNames, {
      placeHolder: 'Select agent to remove',
      title: 'Remove ACP Agent',
    });
    if (!name) { return; }

    if (!this.canRemove(scope, name, this.rawUserAgents())) { return; }

    const choice = await this.window.showQuickPick([
      { label: 'Remove', detail: 'Remove its configuration from the user settings and stop the agent if it is running.' },
      { label: 'Cancel' },
    ], {
      title: 'Remove ACP Agent',
      placeHolder: `Remove agent "${name}"?`,
    });
    if (choice?.label !== 'Remove' || !this.canRemove(scope, name, this.rawUserAgents())) { return; }

    await this.sessions.disconnectAgent(name);
    const userRaw = this.rawUserAgents();
    if (!this.canRemove(scope, name, userRaw)) { return; }
    const { [name]: _removed, ...remaining } = activeAgents(userRaw, scope);
    await this.configuration().update('agents', withActiveAgents(userRaw, scope, remaining), ConfigurationTarget.Global);

    let message = `Agent "${name}" removed.`;
    if (Object.hasOwn(this.activeList(scope), name)) {
      const source = this.inActiveWorkspace(scope, name)
        ? 'the workspace settings still define it.'
        : 'it is still configured in another settings layer.';
      message = `Agent "${name}" removed from the user settings; ${source}`;
    }
    void this.window.showInformationMessage(message);
  }

  private canRemove(scope: WritableScope, name: string, userRaw: unknown): boolean {
    const effective = this.rawAgents();
    const conflict = scopeConflict(effective, scope) ?? scopeConflict(userRaw, scope);
    if (conflict) {
      this.sayScopeConflict(scope, conflict);
      return false;
    }
    if (!Object.hasOwn(activeAgents(effective, scope), name)) {
      void this.window.showInformationMessage(`Agent "${name}" is no longer configured.`);
      return false;
    }
    if (Object.hasOwn(activeAgents(userRaw, scope), name)) { return true; }
    const source = this.inActiveWorkspace(scope, name)
      ? 'the workspace settings; edit them to remove it.'
      : 'another settings layer.';
    void this.window.showInformationMessage(`Agent "${name}" is defined in ${source}`);
    return false;
  }

  /** The active list's agents, merged from the defaults, the user settings and the workspace settings. */
  private activeList(scope: AgentScope): AgentConfigs {
    return activeAgents(this.rawAgents(), scope);
  }

  /** Whether the workspace settings define the agent in the active list, overriding any of that name in the user settings. */
  private inActiveWorkspace(scope: AgentScope, name: string): boolean {
    return Object.hasOwn(activeAgents(this.rawWorkspaceAgents(), scope), name);
  }

  /** The effective `your-turn.agents` value, merged from the defaults, the user settings and the workspace settings. */
  private rawAgents(): unknown {
    return this.configuration().get<unknown>('agents');
  }

  private rawUserAgents(): unknown {
    return this.inspected()?.globalValue;
  }

  private rawWorkspaceAgents(): unknown {
    return this.inspected()?.workspaceValue;
  }

  private inspected() {
    return this.configuration().inspect<unknown>('agents');
  }
}

/** An agent configuration as a shell would write it, environment first. */
function commandLine({ command, args = [], env = {} }: AgentConfigEntry): string {
  return [...Object.entries(env).map(([key, value]) => `${key}=${value}`), command, ...args].join(' ');
}

/** Arguments typed into one box, separated by whitespace; quoting is not supported. */
function splitArguments(text: string): string[] {
  return text.split(/\s+/).filter((arg) => arg !== '');
}
