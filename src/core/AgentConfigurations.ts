import { basename } from 'node:path';

import { launchPath, type AgentConfigEntry } from './AgentManager';
import { logError, messageOf } from './Log';
import type { PackageRunner, PackageRunnerCheck } from './PackageRunners';
import type { RegistryAgent } from './RegistryClient';
import type { SessionManager } from './SessionManager';
import { ConfigurationTarget, QuickPickItemKind, type QuickPickItem, type Window, type WorkspaceConfiguration } from './VsCodeApi';

type AgentConfigs = Record<string, AgentConfigEntry>;

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

/** The commands that add and remove agent configurations, kept in the user's `acp.agents` setting. */
export class AgentConfigurations {
  constructor(
    /** The `acp` section of the settings; VS Code's configuration objects are snapshots, so it is read fresh each time. */
    private readonly configuration: () => WorkspaceConfiguration,
    private readonly sessions: SessionManager,
    private readonly window: Window,
    private readonly sources: AgentSources,
  ) {}

  /** Add an agent configuration, entered by hand or picked from the agent registry. */
  async add(): Promise<void> {
    const source = await this.pickSource();
    if (source === 'custom') {
      await this.addByHand();
    } else if (source && 'cannotAdd' in source) {
      void this.window.showInformationMessage(source.cannotAdd);
    } else if (source) {
      await this.addFromRegistry(source);
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
      logError('Failed to fetch the ACP registry', fetched.error);
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
  private async addFromRegistry({ name, version, config }: Extract<Source, { config: AgentConfigEntry }>): Promise<void> {
    if (this.inWorkspace(name)) {
      this.sayDefinedInWorkspace(name);
      return;
    }
    const replacing = Object.hasOwn(this.agents(), name);
    const runs = `It runs: ${commandLine(config)}`;
    const choice = replacing
      ? await this.window.showWarningMessage(
        `Replace agent "${name}" with ${name} ${version} from the ACP registry? Its configuration is overwritten, and the agent is stopped if it is running. ${runs}`,
        { modal: true },
        'Replace',
      )
      : await this.window.showInformationMessage(`Add ${name} ${version} from the ACP registry? ${runs}`, { modal: true }, 'Add');
    if (choice === undefined) { return; }
    await this.saveAgent(name, config, replacing);
  }

  /** Ask for a name, command, and arguments, and save them as an agent configuration. */
  private async addByHand(): Promise<void> {
    const name = (await this.window.showInputBox({
      prompt: 'Agent name',
      placeHolder: 'my-agent',
      title: 'Add ACP Agent',
    }))?.trim();
    if (!name) { return; }

    if (this.inWorkspace(name)) {
      this.sayDefinedInWorkspace(name);
      return;
    }

    const replacing = Object.hasOwn(this.agents(), name);
    if (replacing) {
      const choice = await this.window.showWarningMessage(
        `Replace agent "${name}"? Its configuration is overwritten, and the agent is stopped if it is running.`,
        { modal: true },
        'Replace',
      );
      if (choice !== 'Replace') { return; }
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

    await this.saveAgent(name, { command, args: splitArguments(args) }, replacing);
  }

  /**
   * Look on the PATH for the commands the agent registry's binaries run on
   * this machine, and add those the user picks. An agent whose command is
   * already configured, under any name or by its full path, is left out.
   */
  async detect(): Promise<void> {
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

    const configured = new Set(Object.values(this.agents()).map((config) => basename(config.command)));
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
      if (this.inWorkspace(name)) {
        this.sayDefinedInWorkspace(name);
        continue;
      }
      if (Object.hasOwn(this.agents(), name)) {
        const choice = await this.window.showWarningMessage(
          `Replace agent "${name}"? Its configuration is overwritten, and the agent is stopped if it is running. It runs: ${commandLine(config)}`,
          { modal: true },
          'Replace',
        );
        if (choice !== 'Replace') { continue; }
        replacing.push(name);
      }
      adding[name] = config;
    }
    const names = Object.keys(adding);
    if (names.length === 0) { return; }

    await Promise.all(replacing.map((name) => this.sessions.disconnectAgent(name)));
    await this.save({ ...this.userAgents(), ...adding });
    const quoted = names.map((name) => `"${name}"`).join(', ');
    void this.window.showInformationMessage(names.length === 1 ? `Agent ${quoted} added.` : `Agents added: ${quoted}.`);
  }

  private async saveAgent(name: string, config: AgentConfigEntry, replacing: boolean): Promise<void> {
    if (replacing) {
      await this.sessions.disconnectAgent(name);
    }
    await this.save({ ...this.userAgents(), [name]: config });
    void this.window.showInformationMessage(replacing ? `Agent "${name}" replaced.` : `Agent "${name}" added.`);
  }

  private sayDefinedInWorkspace(name: string): void {
    void this.window.showInformationMessage(`Agent "${name}" is defined in the workspace settings; edit them to change it.`);
  }

  /** Stop an agent and remove its configuration, asking which when none is given. */
  async remove(agentName?: string): Promise<void> {
    const agentNames = Object.keys(this.agents());
    if (agentNames.length === 0) {
      void this.window.showInformationMessage('No agents configured.');
      return;
    }

    const name = agentName ?? await this.window.showQuickPick(agentNames, {
      placeHolder: 'Select agent to remove',
      title: 'Remove ACP Agent',
    });
    if (!name) { return; }

    const { [name]: inUser, ...remaining } = this.userAgents();
    const inWorkspace = this.inWorkspace(name);
    if (!inUser && inWorkspace) {
      void this.window.showInformationMessage(`Agent "${name}" is defined in the workspace settings; edit them to remove it.`);
      return;
    }

    const choice = await this.window.showWarningMessage(`Remove agent "${name}"?`, { modal: true }, 'Remove');
    if (choice !== 'Remove') { return; }

    await this.sessions.disconnectAgent(name);
    await this.save(remaining);
    void this.window.showInformationMessage(inWorkspace
      ? `Agent "${name}" removed from the user settings; the workspace settings still define it.`
      : `Agent "${name}" removed.`);
  }

  /** Every configured agent, merged from the defaults, the user settings and the workspace settings. */
  private agents(): AgentConfigs {
    return this.configuration().get<AgentConfigs>('agents') ?? {};
  }

  /** The agents in the user settings alone, the only ones these commands write. */
  private userAgents(): AgentConfigs {
    return this.inspected()?.globalValue ?? {};
  }

  /** Whether the workspace settings define the agent, overriding any of that name in the user settings. */
  private inWorkspace(name: string): boolean {
    return Object.hasOwn(this.inspected()?.workspaceValue ?? {}, name);
  }

  private inspected() {
    return this.configuration().inspect<AgentConfigs>('agents');
  }

  private async save(agents: AgentConfigs): Promise<void> {
    await this.configuration().update('agents', agents, ConfigurationTarget.Global);
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
