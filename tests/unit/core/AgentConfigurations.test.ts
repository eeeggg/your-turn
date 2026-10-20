import { describe, expect, it } from 'vitest';
import type { AgentConfigEntry } from '@/core/AgentManager';
import { AgentConfigurations } from '@/core/AgentConfigurations';
import { ConnectionManager } from '@/core/ConnectionManager';
import type { RegistryAgent } from '@/core/RegistryClient';
import { SessionManager } from '@/core/SessionManager';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import { ConfigurationTarget, type WorkspaceConfiguration } from '@/core/VsCodeApi';
import { fakeAgent, InProcessAgents, unusedHandlers } from './InProcessAgents';
import { ScriptedUser } from './ScriptedUser';

type Agents = Record<string, AgentConfigEntry>;

/** The `acp` settings, recording each update with its target. */
class MemoryConfiguration implements WorkspaceConfiguration {
  readonly updates: { section: string; value: unknown; target: number }[] = [];

  constructor(private agents: Agents) {}

  get<T>(section: string): T | undefined {
    return section === 'agents' ? this.agents as T : undefined;
  }

  async update(section: string, value: unknown, target: number): Promise<void> {
    this.updates.push({ section, value, target });
    if (section === 'agents') {
      this.agents = value as Agents;
    }
  }
}

function setup(agents: Agents, registry: () => Promise<readonly RegistryAgent[]> = async () => []) {
  const configuration = new MemoryConfiguration(agents);
  const launcher = new InProcessAgents({ one: () => fakeAgent(), two: () => fakeAgent() });
  const manager = new SessionManager(
    launcher,
    new ConnectionManager(new SessionUpdateHandler(), '0.0.0-test', () => unusedHandlers),
    { workspaceCwd: () => '/work', agentConfigs: () => configuration.get<Agents>('agents') ?? {}, activeFileLink: () => undefined },
    { chooseAuthMethod: async () => undefined },
  );
  const user = new ScriptedUser();
  const configurations = new AgentConfigurations(() => configuration, manager, user, registry);
  return { configuration, launcher, manager, user, configurations };
}

const askName = { call: 'showInputBox', options: { prompt: 'Agent name', placeHolder: 'my-agent', title: 'Add ACP Agent' } };
const askCommand = { call: 'showInputBox', options: { prompt: 'Command to launch the agent', placeHolder: 'npx', title: 'Agent Command' } };
const askArgs = { call: 'showInputBox', options: { prompt: 'Arguments (space-separated)', placeHolder: '-y @my-org/agent', title: 'Agent Arguments' } };

describe('AgentConfigurations', () => {
  describe('add', () => {
    it('saves the agent configuration in the user settings', async () => {
      const { configuration, user, configurations } = setup({ one: { command: 'one' } });
      user.answer('mine', 'npx', '-y @my-org/agent');

      await configurations.add();

      expect(configuration.updates).toEqual([{
        section: 'agents',
        value: { one: { command: 'one' }, mine: { command: 'npx', args: ['-y', '@my-org/agent'] } },
        target: ConfigurationTarget.Global,
      }]);
      expect(user.take()).toEqual([askName, askCommand, askArgs, { call: 'showInformationMessage', message: 'Agent "mine" added.' }]);
    });

    it('ignores extra spaces around and between arguments', async () => {
      const { configuration, user, configurations } = setup({});
      user.answer('mine', 'npx', '  -y   @my-org/agent ');

      await configurations.add();

      expect(configuration.get<Agents>('agents')).toEqual({ mine: { command: 'npx', args: ['-y', '@my-org/agent'] } });
    });

    it('saves no arguments when none are entered', async () => {
      const { configuration, user, configurations } = setup({});
      user.answer('mine', 'my-agent', '');

      await configurations.add();

      expect(configuration.get<Agents>('agents')).toEqual({ mine: { command: 'my-agent', args: [] } });
    });

    it('trims the name and the command', async () => {
      const { configuration, user, configurations } = setup({});
      user.answer(' mine ', ' npx ', '');

      await configurations.add();

      expect(configuration.get<Agents>('agents')).toEqual({ mine: { command: 'npx', args: [] } });
    });

    it.each([
      ['the name', [undefined]],
      ['a blank name', ['  ']],
      ['the command', ['mine', undefined]],
      ['the arguments', ['mine', 'npx', undefined]],
    ])('saves nothing when the user dismisses %s', async (_step, answers) => {
      const { configuration, user, configurations } = setup({});
      user.answer(...answers);

      await configurations.add();

      expect(configuration.updates).toEqual([]);
      expect(user.take().map((c) => c.call)).toEqual(answers.map(() => 'showInputBox'));
    });

    it('asks before replacing an agent configuration, and stops the agent', async () => {
      const { configuration, launcher, manager, user, configurations } = setup({ one: { command: 'one', args: ['--old'] } });
      await manager.ensureConnected('one');
      user.answer('one', 'Replace', 'one', '--new');

      await configurations.add();

      expect(configuration.get<Agents>('agents')).toEqual({ one: { command: 'one', args: ['--new'] } });
      expect(launcher.running('one')).toEqual([]);
      expect(user.take()).toEqual([
        askName,
        {
          call: 'showWarningMessage',
          message: 'Replace agent "one"? Its configuration is overwritten, and the agent is stopped if it is running.',
          options: { modal: true },
          items: ['Replace'],
        },
        askCommand,
        askArgs,
        { call: 'showInformationMessage', message: 'Agent "one" replaced.' },
      ]);
    });

    it('keeps the agent configuration and the agent when the user declines to replace it', async () => {
      const { configuration, launcher, manager, user, configurations } = setup({ one: { command: 'one' } });
      await manager.ensureConnected('one');
      user.answer('one', undefined);

      await configurations.add();

      expect(configuration.updates).toEqual([]);
      expect(launcher.running('one')).toHaveLength(1);
    });
  });

  describe('remove', () => {
    const confirmRemove = (name: string) => ({
      call: 'showWarningMessage',
      message: `Remove agent "${name}"?`,
      options: { modal: true },
      items: ['Remove'],
    });

    it('stops the agent and removes its configuration', async () => {
      const { configuration, launcher, manager, user, configurations } = setup({ one: { command: 'one' }, two: { command: 'two' } });
      await manager.ensureConnected('one');
      user.answer('Remove');

      await configurations.remove('one');

      expect(launcher.running('one')).toEqual([]);
      expect(configuration.updates).toEqual([{ section: 'agents', value: { two: { command: 'two' } }, target: ConfigurationTarget.Global }]);
      expect(user.take()).toEqual([confirmRemove('one'), { call: 'showInformationMessage', message: 'Agent "one" removed.' }]);
    });

    it('asks which agent to remove when none is given', async () => {
      const { configuration, user, configurations } = setup({ one: { command: 'one' }, two: { command: 'two' } });
      user.answer('two', 'Remove');

      await configurations.remove();

      expect(configuration.get<Agents>('agents')).toEqual({ one: { command: 'one' } });
      expect(user.take().slice(0, 2)).toEqual([
        { call: 'showQuickPick', items: ['one', 'two'], options: { placeHolder: 'Select agent to remove', title: 'Remove ACP Agent' } },
        confirmRemove('two'),
      ]);
    });

    it('keeps the configuration when the user declines', async () => {
      const { configuration, user, configurations } = setup({ one: { command: 'one' } });
      user.answer(undefined);

      await configurations.remove('one');

      expect(configuration.updates).toEqual([]);
    });

    it('says so when no agent is configured', async () => {
      const { user, configurations } = setup({});

      await configurations.remove();

      expect(user.take()).toEqual([{ call: 'showInformationMessage', message: 'No agents configured.' }]);
    });
  });

  describe('browse the registry', () => {
    it('lists the agents in the registry', async () => {
      const { user, configurations } = setup({}, async () => [
        { name: 'Claude Code', command: 'npx', description: 'Anthropic' },
        { name: 'Bare', command: 'bare' },
      ]);
      user.answer(undefined);

      await configurations.browseRegistry();

      expect(user.take()).toEqual([{
        call: 'showQuickPick',
        items: [{ label: 'Claude Code', description: 'npx', detail: 'Anthropic' }, { label: 'Bare', description: 'bare' }],
        options: { placeHolder: 'ACP Agent Registry', title: 'Available ACP Agents' },
      }]);
    });

    it('says so when the registry is empty', async () => {
      const { user, configurations } = setup({});

      await configurations.browseRegistry();

      expect(user.take()).toEqual([{ call: 'showInformationMessage', message: 'No agents found in registry.' }]);
    });

    it('reports a registry it cannot fetch', async () => {
      const { user, configurations } = setup({}, async () => {
        throw new Error('HTTP 503: Service Unavailable');
      });

      await configurations.browseRegistry();

      expect(user.take()).toEqual([{ call: 'showErrorMessage', message: 'Failed to fetch registry: HTTP 503: Service Unavailable' }]);
    });
  });
});
