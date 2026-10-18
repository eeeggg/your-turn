import type { AgentConfigEntry } from './AgentManager';
import { logError } from './Log';
import type { RegistryAgent } from './RegistryClient';
import type { SessionManager } from './SessionManager';
import { ConfigurationTarget, type QuickPickItem, type Window, type WorkspaceConfiguration } from './VsCodeApi';

type AgentConfigs = Record<string, AgentConfigEntry>;

/** The commands that add, remove, and discover agent configurations, kept in the user's `acp.agents` setting. */
export class AgentConfigurations {
  constructor(
    /** The `acp` section of the settings; VS Code's configuration objects are snapshots, so it is read fresh each time. */
    private readonly configuration: () => WorkspaceConfiguration,
    private readonly sessions: SessionManager,
    private readonly window: Window,
    private readonly fetchRegistry: () => Promise<readonly RegistryAgent[]>,
  ) {}

  /** Ask for a name, command, and arguments, and save them as an agent configuration. */
  async add(): Promise<void> {
    const name = (await this.window.showInputBox({
      prompt: 'Agent name',
      placeHolder: 'my-agent',
      title: 'Add ACP Agent',
    }))?.trim();
    if (!name) { return; }

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

    if (replacing) {
      await this.sessions.disconnectAgent(name);
    }
    await this.save({ ...this.agents(), [name]: { command, args: splitArguments(args) } });
    void this.window.showInformationMessage(replacing ? `Agent "${name}" replaced.` : `Agent "${name}" added.`);
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

    const choice = await this.window.showWarningMessage(`Remove agent "${name}"?`, { modal: true }, 'Remove');
    if (choice !== 'Remove') { return; }

    await this.sessions.disconnectAgent(name);
    const remaining = { ...this.agents() };
    delete remaining[name];
    await this.save(remaining);
    void this.window.showInformationMessage(`Agent "${name}" removed.`);
  }

  /** Show the agents in the agent registry. */
  async browseRegistry(): Promise<void> {
    let agents: readonly RegistryAgent[];
    try {
      agents = await this.fetchRegistry();
    } catch (e) {
      logError('Failed to fetch registry', e);
      void this.window.showErrorMessage(`Failed to fetch registry: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (agents.length === 0) {
      void this.window.showInformationMessage('No agents found in registry.');
      return;
    }
    const items: QuickPickItem[] = agents.map((a) => ({
      label: a.name,
      description: a.command,
      ...(a.description ? { detail: a.description } : {}),
    }));
    await this.window.showQuickPick(items, {
      placeHolder: 'ACP Agent Registry',
      title: 'Available ACP Agents',
    });
  }

  private agents(): AgentConfigs {
    return this.configuration().get<AgentConfigs>('agents') ?? {};
  }

  private async save(agents: AgentConfigs): Promise<void> {
    await this.configuration().update('agents', agents, ConfigurationTarget.Global);
  }
}

/** Arguments typed into one box, separated by whitespace; quoting is not supported. */
function splitArguments(text: string): string[] {
  return text.split(/\s+/).filter((arg) => arg !== '');
}
