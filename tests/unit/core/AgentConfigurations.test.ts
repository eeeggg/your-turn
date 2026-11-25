import { describe, expect, it, vi } from 'vitest';
import { activeAgents, type AgentScope } from '@/core/AgentConfigScope';
import type { AgentConfigEntry } from '@/core/AgentManager';
import { AgentConfigurations } from '@/core/AgentConfigurations';
import { ConnectionManager } from '@/core/acp/ConnectionManager';
import type { PackageRunner, PackageRunnerCheck } from '@/core/PackageRunners';
import type { RegistryAgent } from '@/core/RegistryClient';
import { SessionManager } from '@/core/sessions/Manager';
import { SessionUpdateHandler } from '@/core/sessions/UpdateHandler';
import { ConfigurationTarget, QuickPickItemKind, type InputBoxOptions, type WorkspaceConfiguration } from '@/core/VsCodeApi';
import { fakeAgent, InProcessAgents, unusedHandlers, work } from '@tests/unit/core/InProcessAgents';
import { ScriptedUser } from '@tests/unit/core/ScriptedUser';

const LOCAL: AgentScope = { kind: 'local' };

type Agents = Record<string, AgentConfigEntry>;

/**
 * The `agents` settings in the default, user and workspace scopes, read merged as VS Code merges an object setting,
 * recording each update with its target. Raw rather than typed as `Agents`, so a remote authority's group, nested
 * inside the top-level map, can be set up the same way VS Code would hold it.
 */
class MemoryConfiguration implements WorkspaceConfiguration {
  readonly updates: { section: string; value: unknown; target: number }[] = [];

  constructor(private user: Record<string, unknown>, private readonly workspace: Record<string, unknown>, private readonly defaults: Record<string, unknown>) {}

  get<T>(section: string): T | undefined {
    return section === 'agents' ? { ...this.defaults, ...this.user, ...this.workspace } as T : undefined;
  }

  inspect<T>(section: string): { globalValue?: T; workspaceValue?: T } | undefined {
    return section === 'agents' ? { globalValue: this.user as T, workspaceValue: this.workspace as T } : undefined;
  }

  async update(section: string, value: unknown, target: number): Promise<void> {
    this.updates.push({ section, value, target });
    if (section === 'agents') {
      this.user = value as Record<string, unknown>;
    }
  }

  setUser(value: Record<string, unknown>): void { this.user = value; }
}

interface Scopes {
  workspace?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  registry?: () => Promise<readonly RegistryAgent[]>;
  runners?: Partial<Record<PackageRunner, PackageRunnerCheck>>;
  /** The commands on the `PATH`, by name, with where each is. */
  onPath?: Record<string, string>;
  scriptedUser?: ScriptedUser;
  /** Where the active list is; defaults to local, as most tests predate authority scoping. */
  scope?: AgentScope;
}

function setup(userAgents: Record<string, unknown>, { workspace = {}, defaults = {}, registry = async () => [], runners = {}, onPath = {}, scope = LOCAL, scriptedUser }: Scopes = {}) {
  const configuration = new MemoryConfiguration(userAgents, workspace, defaults);
  const launcher = new InProcessAgents({ one: () => fakeAgent(), two: () => fakeAgent() });
  const manager = new SessionManager(
    launcher,
    new ConnectionManager('0.0.0-test', () => unusedHandlers),
    { workspaceRoots: () => work, workspaceTarget: () => undefined, workspaceTargetKnown: () => Promise.resolve(undefined), agentConfigs: () => activeAgents(configuration.get('agents'), scope), activeFileLink: () => undefined },
    { chooseAuthMethod: async () => undefined },
    new SessionUpdateHandler(),
  );
  const user = scriptedUser ?? new ScriptedUser();
  const lookedFor: string[] = [];
  const configurations = new AgentConfigurations(() => configuration, () => scope, manager, user, {
    fetchRegistry: registry,
    checkRunner: async (runner) => runners[runner] ?? { works: true },
    findOnPath: async (command) => {
      lookedFor.push(command);
      return onPath[command];
    },
    platform: 'linux-x86_64',
  });
  return { configuration, launcher, manager, user, configurations, lookedFor };
}

const CUSTOM = 'Custom…';
const customItem = { label: CUSTOM, detail: 'Enter a name, the command that starts the agent, and its arguments' };
const pickSource = { call: 'createQuickPick', title: 'Add ACP Agent', placeholder: 'Pick an agent from the ACP registry, or Custom to enter one' };
/** Custom picked at once, while the registry is still arriving. */
const pickedCustom = { ...pickSource, busy: true, items: [customItem] };
const registrySeparator = { label: 'ACP registry', kind: QuickPickItemKind.Separator };

const askName = { call: 'showInputBox', options: { prompt: 'Agent name', placeHolder: 'my-agent', title: 'Add ACP Agent' } };
const askCommand = { call: 'showInputBox', options: { prompt: 'Command to launch the agent', placeHolder: 'npx', title: 'Agent Command' } };
const askArgs = { call: 'showInputBox', options: { prompt: 'Arguments (space-separated)', placeHolder: '-y @my-org/agent', title: 'Agent Arguments' } };

describe('AgentConfigurations', () => {
  describe('add by hand', () => {
    const confirmReplaceOne = {
      call: 'showQuickPick',
      items: [
        { label: 'Replace', detail: 'Its configuration is overwritten, and the agent is stopped if it is running.' },
        { label: 'Cancel' },
      ],
      options: { title: 'Add ACP Agent', placeHolder: 'Replace agent "one"?' },
    };

    it('saves the agent configuration in the user settings', async () => {
      const { configuration, user, configurations } = setup({ one: { command: 'one' } });
      user.answer(CUSTOM, 'mine', 'npx', '-y @my-org/agent');

      await configurations.add();

      expect(configuration.updates).toEqual([{
        section: 'agents',
        value: { one: { command: 'one' }, mine: { command: 'npx', args: ['-y', '@my-org/agent'] } },
        target: ConfigurationTarget.Global,
      }]);
      expect(user.take()).toEqual([pickedCustom, askName, askCommand, askArgs, { call: 'showInformationMessage', message: 'Agent "mine" added.' }]);
    });

    it('preserves existing local agents when a malformed entry is named command', async () => {
      const { configuration, user, configurations } = setup({ command: 'stray', one: { command: 'one' } });
      user.answer(CUSTOM, 'mine', 'npx', '');

      await configurations.add();

      expect(configuration.get('agents')).toEqual({
        command: 'stray', one: { command: 'one' }, mine: { command: 'npx', args: [] },
      });
    });

    it('saves only the user settings\' own agents, not the workspace\'s or the defaults', async () => {
      const { configuration, user, configurations } = setup(
        { one: { command: 'one' } },
        { workspace: { two: { command: 'two' } }, defaults: { three: { command: 'three' } } },
      );
      user.answer(CUSTOM, 'mine', 'npx', '');

      await configurations.add();

      expect(configuration.updates).toEqual([{
        section: 'agents',
        value: { one: { command: 'one' }, mine: { command: 'npx', args: [] } },
        target: ConfigurationTarget.Global,
      }]);
    });

    it('ignores extra spaces around and between arguments', async () => {
      const { configuration, user, configurations } = setup({});
      user.answer(CUSTOM, 'mine', 'npx', '  -y   @my-org/agent ');

      await configurations.add();

      expect(configuration.get<Agents>('agents')).toEqual({ mine: { command: 'npx', args: ['-y', '@my-org/agent'] } });
    });

    it('saves no arguments when none are entered', async () => {
      const { configuration, user, configurations } = setup({});
      user.answer(CUSTOM, 'mine', 'my-agent', '');

      await configurations.add();

      expect(configuration.get<Agents>('agents')).toEqual({ mine: { command: 'my-agent', args: [] } });
    });

    it('trims the name and the command', async () => {
      const { configuration, user, configurations } = setup({});
      user.answer(CUSTOM, ' mine ', ' npx ', '');

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
      user.answer(CUSTOM, ...answers);

      await configurations.add();

      expect(configuration.updates).toEqual([]);
      expect(user.take().map((c) => c.call)).toEqual(['createQuickPick', ...answers.map(() => 'showInputBox')]);
    });

    it('asks before replacing an agent configuration, and stops the agent', async () => {
      const { configuration, launcher, manager, user, configurations } = setup({ one: { command: 'one', args: ['--old'] } });
      await manager.ensureConnected('one');
      user.answer(CUSTOM, 'one', 'Replace', 'one', '--new');

      await configurations.add();

      expect(configuration.get<Agents>('agents')).toEqual({ one: { command: 'one', args: ['--new'] } });
      expect(launcher.running('one')).toEqual([]);
      expect(user.take()).toEqual([
        pickedCustom,
        askName,
        confirmReplaceOne,
        askCommand,
        askArgs,
        { call: 'showInformationMessage', message: 'Agent "one" replaced.' },
      ]);
    });

    it('says where an agent the workspace settings define is, and leaves it and the agent', async () => {
      const { configuration, launcher, manager, user, configurations } = setup({}, { workspace: { one: { command: 'one' } } });
      await manager.ensureConnected('one');
      user.answer(CUSTOM, 'one');

      await configurations.add();

      expect(configuration.updates).toEqual([]);
      expect(launcher.running('one')).toHaveLength(1);
      expect(user.take()).toEqual([
        pickedCustom,
        askName,
        { call: 'showInformationMessage', message: 'Agent "one" is defined in the workspace settings; edit them to change it.' },
      ]);
    });

    it.each([
      ['dismisses the confirmation', undefined],
      ['chooses Cancel', 'Cancel'],
    ])('keeps the configuration and running agent when the user %s', async (_action, answer) => {
      const { configuration, launcher, manager, user, configurations } = setup({ one: { command: 'one', args: ['--old'] } });
      await manager.ensureConnected('one');
      user.answer(CUSTOM, 'one', answer);

      await configurations.add();

      expect(configuration.updates).toEqual([]);
      expect(configuration.get<Agents>('agents')).toEqual({ one: { command: 'one', args: ['--old'] } });
      expect(launcher.running('one')).toHaveLength(1);
      expect(user.take()).toEqual([pickedCustom, askName, confirmReplaceOne]);
    });

    it.each([
      ['the command', [undefined], [askCommand]],
      ['a blank command', ['  '], [askCommand]],
      ['the arguments', ['one', undefined], [askCommand, askArgs]],
    ])('keeps the configuration and running agent when the user cancels at %s after choosing Replace', async (_step, answers, inputs) => {
      const { configuration, launcher, manager, user, configurations } = setup({ one: { command: 'one', args: ['--old'] } });
      await manager.ensureConnected('one');
      user.answer(CUSTOM, 'one', 'Replace', ...answers);

      await configurations.add();

      expect(configuration.updates).toEqual([]);
      expect(configuration.get<Agents>('agents')).toEqual({ one: { command: 'one', args: ['--old'] } });
      expect(launcher.running('one')).toHaveLength(1);
      expect(user.take()).toEqual([pickedCustom, askName, confirmReplaceOne, ...inputs]);
    });
  });

  describe('add from the registry', () => {
    const claude: RegistryAgent = {
      id: 'claude-acp',
      name: 'Claude Agent',
      version: '0.94.0',
      description: 'ACP wrapper for Anthropic\'s Claude',
      runs: { through: 'npx', config: { command: 'npx', args: ['--yes', '@agentclientprotocol/claude-agent-acp@0.94.0'] } },
    };
    const auggie: RegistryAgent = {
      id: 'auggie',
      name: 'Auggie CLI',
      version: '0.36.0',
      description: 'Augment Code',
      runs: {
        through: 'npx',
        config: { command: 'npx', args: ['--yes', '@augmentcode/auggie@0.36.0', '--acp'], env: { AUGMENT_DISABLE_AUTO_UPDATE: '1' } },
      },
    };
    const fastAgent: RegistryAgent = {
      id: 'fast-agent',
      name: 'fast-agent',
      version: '0.10.1',
      description: 'Multi-provider agents',
      runs: { through: 'uvx', config: { command: 'uvx', args: ['fast-agent-acp==0.10.1', '-x'] } },
    };
    const opencode: RegistryAgent = { id: 'opencode', name: 'OpenCode', version: '1.19.3', description: 'The open source coding agent', runs: { through: 'binary' } };
    const registry = async () => [claude, auggie, fastAgent, opencode];

    const claudeItem = {
      label: 'Claude Agent',
      description: '0.94.0',
      detail: 'ACP wrapper for Anthropic\'s Claude — runs npx --yes @agentclientprotocol/claude-agent-acp@0.94.0',
    };
    const confirmClaude = {
      call: 'showQuickPick',
      items: [
        { label: 'Add', detail: 'It runs: npx --yes @agentclientprotocol/claude-agent-acp@0.94.0' },
        { label: 'Cancel' },
      ],
      options: { title: 'Add ACP Agent', placeHolder: 'Add Claude Agent 0.94.0 from the ACP registry?' },
    };
    const confirmReplaceOne = {
      call: 'showQuickPick',
      items: [
        { label: 'Replace', detail: 'Its configuration is overwritten, and the agent is stopped if it is running. It runs: npx --yes @agentclientprotocol/claude-agent-acp@0.94.0' },
        { label: 'Cancel' },
      ],
      options: { title: 'Add ACP Agent', placeHolder: 'Replace agent "one" with one 0.94.0 from the ACP registry?' },
    };

    it('offers Custom at once, before the registry arrives', async () => {
      const { user, configurations } = setup({}, { registry: () => new Promise(() => {}) });
      user.answer(CUSTOM, undefined);

      await configurations.add();

      expect(user.take()[0]).toEqual(pickedCustom);
    });

    it('lists each agent with its version, its description and the command it runs, or why it cannot be added', async () => {
      const missing = '"uvx" was not found: it is not installed, or it is installed where VS Code does not see it. The PATH VS Code sees: /usr/bin';
      const { user, configurations } = setup({}, { registry, runners: { uvx: { works: false, reason: missing } } });
      user.answer(undefined);

      await configurations.add();

      expect(user.take()).toEqual([{
        ...pickSource,
        busy: false,
        items: [
          customItem,
          registrySeparator,
          { label: '$(warning) uvx is not available', detail: missing },
          claudeItem,
          {
            label: 'Auggie CLI',
            description: '0.36.0',
            detail: 'Augment Code — runs AUGMENT_DISABLE_AUTO_UPDATE=1 npx --yes @augmentcode/auggie@0.36.0 --acp',
          },
          { label: 'fast-agent', description: '0.10.1', detail: 'Multi-provider agents — needs uvx, which is not available' },
          {
            label: 'OpenCode',
            description: '1.19.3',
            detail: 'The open source coding agent — distributed only as a binary, which Add Agent does not download; if it is installed, Detect Agents finds it',
          },
        ],
      }]);
    });

    it('adds the agent under its registry name once the user confirms, without connecting to it', async () => {
      const { configuration, launcher, user, configurations } = setup({ one: { command: 'one' } }, { registry });
      user.answer('Claude Agent', 'Add');

      await configurations.add();

      expect(configuration.updates).toEqual([{
        section: 'agents',
        value: { one: { command: 'one' }, 'Claude Agent': { command: 'npx', args: ['--yes', '@agentclientprotocol/claude-agent-acp@0.94.0'] } },
        target: ConfigurationTarget.Global,
      }]);
      expect(launcher.running('Claude Agent')).toEqual([]);
      expect(user.take().slice(1)).toEqual([confirmClaude, { call: 'showInformationMessage', message: 'Agent "Claude Agent" added.' }]);
    });

    it('saves the agent\'s environment', async () => {
      const { configuration, user, configurations } = setup({}, { registry });
      user.answer('Auggie CLI', 'Add');

      await configurations.add();

      expect(configuration.get<Agents>('agents')).toEqual({
        'Auggie CLI': { command: 'npx', args: ['--yes', '@augmentcode/auggie@0.36.0', '--acp'], env: { AUGMENT_DISABLE_AUTO_UPDATE: '1' } },
      });
    });

    it.each([
      ['dismisses the confirmation', undefined],
      ['chooses Cancel', 'Cancel'],
    ])('adds nothing and leaves the running agent when the user %s', async (_action, answer) => {
      const { configuration, launcher, manager, user, configurations } = setup({ one: { command: 'one' } }, { registry });
      await manager.ensureConnected('one');
      user.answer('Claude Agent', answer);

      await configurations.add();

      expect(configuration.updates).toEqual([]);
      expect(configuration.get<Agents>('agents')).toEqual({ one: { command: 'one' } });
      expect(launcher.running('one')).toHaveLength(1);
      expect(launcher.running('Claude Agent')).toEqual([]);
      expect(user.take().slice(1)).toEqual([confirmClaude]);
    });

    it.each([
      [
        'OpenCode',
        'OpenCode is distributed only as a binary, which Add Agent does not download. If it is installed, Detect Agents finds it; otherwise install it, then add it with Custom.',
      ],
      ['fast-agent', 'fast-agent needs uvx, which is not available: uvx is missing'],
      ['$(warning) uvx is not available', 'uvx is missing'],
    ])('says why, once %s is picked, it cannot be added', async (label, message) => {
      const { configuration, user, configurations } = setup({}, { registry, runners: { uvx: { works: false, reason: 'uvx is missing' } } });
      user.answer(label);

      await configurations.add();

      expect(configuration.updates).toEqual([]);
      expect(user.take().slice(1)).toEqual([{ call: 'showInformationMessage', message }]);
    });

    it('asks before replacing an agent of the same name, and stops it', async () => {
      const one: RegistryAgent = { ...claude, name: 'one' };
      const { configuration, launcher, manager, user, configurations } = setup({ one: { command: 'one' } }, { registry: async () => [one] });
      await manager.ensureConnected('one');
      user.answer('one', 'Replace');

      await configurations.add();

      expect(configuration.get<Agents>('agents')).toEqual({ one: { command: 'npx', args: ['--yes', '@agentclientprotocol/claude-agent-acp@0.94.0'] } });
      expect(launcher.running('one')).toEqual([]);
      expect(user.take().slice(1)).toEqual([
        confirmReplaceOne,
        { call: 'showInformationMessage', message: 'Agent "one" replaced.' },
      ]);
    });

    it.each([
      ['dismisses the confirmation', undefined],
      ['chooses Cancel', 'Cancel'],
    ])('keeps the configuration and running agent when the user %s instead of replacing', async (_action, answer) => {
      const one: RegistryAgent = { ...claude, name: 'one' };
      const { configuration, launcher, manager, user, configurations } = setup(
        { one: { command: 'one', args: ['--old'] } },
        { registry: async () => [one] },
      );
      await manager.ensureConnected('one');
      user.answer('one', answer);

      await configurations.add();

      expect(configuration.updates).toEqual([]);
      expect(configuration.get<Agents>('agents')).toEqual({ one: { command: 'one', args: ['--old'] } });
      expect(launcher.running('one')).toHaveLength(1);
      expect(user.take().slice(1)).toEqual([confirmReplaceOne]);
    });

    it('says where an agent of the same name the workspace settings define is, and adds nothing', async () => {
      const { configuration, user, configurations } = setup({}, { registry, workspace: { 'Claude Agent': { command: 'claude' } } });
      user.answer('Claude Agent');

      await configurations.add();

      expect(configuration.updates).toEqual([]);
      expect(user.take().slice(1)).toEqual([
        { call: 'showInformationMessage', message: 'Agent "Claude Agent" is defined in the workspace settings; edit them to change it.' },
      ]);
    });

    it('still offers Custom, and says why, when the registry cannot be fetched', async () => {
      const { user, configurations } = setup({}, {
        registry: async () => { throw new Error('HTTP 503: Service Unavailable'); },
      });
      user.answer('$(warning) The ACP registry could not be fetched');

      await configurations.add();

      expect(user.take()).toEqual([
        {
          ...pickSource,
          busy: true,
          items: [customItem, registrySeparator, { label: '$(warning) The ACP registry could not be fetched', detail: 'HTTP 503: Service Unavailable' }],
        },
        { call: 'showInformationMessage', message: 'Could not fetch the ACP registry: HTTP 503: Service Unavailable' },
      ]);
    });

    it('says so when the registry lists no agents', async () => {
      const { user, configurations } = setup({});
      user.answer('The ACP registry lists no agents');

      await configurations.add();

      expect(user.take()).toEqual([
        { ...pickSource, busy: true, items: [customItem, registrySeparator, { label: 'The ACP registry lists no agents' }] },
        { call: 'showInformationMessage', message: 'The ACP registry lists no agents.' },
      ]);
    });
  });

  describe('detect', () => {
    const opencode: RegistryAgent = {
      id: 'opencode',
      name: 'OpenCode',
      version: '1.19.3',
      description: 'The open source coding agent',
      runs: { through: 'binary' },
      binary: { 'linux-x86_64': { cmd: './opencode', args: ['acp'] }, 'windows-x86_64': { cmd: './opencode.exe', args: ['acp'] } },
    };
    const kilo: RegistryAgent = {
      id: 'kilo',
      name: 'Kilo',
      version: '7.8.15',
      description: 'Kilo Code',
      runs: { through: 'npx', config: { command: 'npx', args: ['--yes', '@kilocode/cli@7.8.15', 'acp'] } },
      binary: { 'linux-x86_64': { cmd: './kilo', args: ['acp'] } },
    };
    const vtcode: RegistryAgent = {
      id: 'vtcode',
      name: 'VT Code',
      version: '0.96.14',
      description: 'VT Code',
      runs: { through: 'binary' },
      binary: { 'linux-x86_64': { cmd: './vtcode', args: ['acp'], env: { VT_ACP_ENABLED: '1' } } },
    };
    const macOnly: RegistryAgent = {
      id: 'mac-only',
      name: 'Mac Only',
      version: '1.0.0',
      description: 'Runs on macOS',
      runs: { through: 'binary' },
      binary: { 'darwin-aarch64': { cmd: './mac-only' } },
    };
    const claude: RegistryAgent = {
      id: 'claude-acp',
      name: 'Claude Agent',
      version: '0.94.0',
      description: 'ACP wrapper for Anthropic\'s Claude',
      runs: { through: 'npx', config: { command: 'npx', args: ['--yes', '@agentclientprotocol/claude-agent-acp@0.94.0'] } },
    };
    const registry = async () => [opencode, kilo, vtcode, macOnly, claude];
    const onPath = { opencode: '/home/me/.opencode/bin/opencode', vtcode: '/usr/local/bin/vtcode' };

    const opencodeItem = {
      label: 'OpenCode',
      description: 'opencode acp',
      detail: 'The open source coding agent. Found at /home/me/.opencode/bin/opencode; the registry lists 1.19.3, yours may differ',
    };
    const vtcodeItem = {
      label: 'VT Code',
      description: 'VT_ACP_ENABLED=1 vtcode acp',
      detail: 'VT Code. Found at /usr/local/bin/vtcode; the registry lists 0.96.14, yours may differ',
    };
    const offer = (items: object[]) => ({
      call: 'showQuickPick',
      items,
      options: { title: 'Detect ACP Agents', placeHolder: 'Agents from the ACP registry found on the PATH VS Code sees; pick those to add', canPickMany: true },
    });
    const confirmReplaceOne = {
      call: 'showQuickPick',
      items: [
        { label: 'Replace', detail: 'Its configuration is overwritten, and the agent is stopped if it is running. It runs: opencode acp' },
        { label: 'Skip' },
      ],
      options: { title: 'Detect ACP Agents', placeHolder: 'Replace agent "one"?' },
    };

    it('looks for the command each binary runs on this platform, and offers those found with where and what they would save', async () => {
      const { user, configurations, lookedFor } = setup({}, { registry, onPath });
      user.answer(undefined);

      await configurations.detect();

      expect(lookedFor).toEqual(['opencode', 'kilo', 'vtcode']);
      expect(user.take()).toEqual([offer([opencodeItem, vtcodeItem])]);
    });

    it('adds the agents picked under their registry names, without connecting to them', async () => {
      const { configuration, user, configurations } = setup({ one: { command: 'one' } }, { registry, onPath });
      user.answer(['OpenCode', 'VT Code']);

      await configurations.detect();

      expect(configuration.updates).toEqual([{
        section: 'agents',
        value: {
          one: { command: 'one' },
          OpenCode: { command: 'opencode', args: ['acp'] },
          'VT Code': { command: 'vtcode', args: ['acp'], env: { VT_ACP_ENABLED: '1' } },
        },
        target: ConfigurationTarget.Global,
      }]);
      expect(user.take().slice(1)).toEqual([{ call: 'showInformationMessage', message: 'Agents added: "OpenCode", "VT Code".' }]);
    });

    it.each([[undefined], [[]]])('adds nothing when the user picks %j', async (answer) => {
      const { configuration, user, configurations } = setup({}, { registry, onPath });
      user.answer(answer);

      await configurations.detect();

      expect(configuration.updates).toEqual([]);
    });

    it('leaves out an agent whose command is already configured, even by its full path', async () => {
      const { user, configurations } = setup({ mine: { command: '/home/me/.opencode/bin/opencode', args: ['acp'] } }, { registry, onPath });
      user.answer(undefined);

      await configurations.detect();

      expect(user.take()).toEqual([offer([vtcodeItem])]);
    });

    it('says so when every agent it finds is already configured', async () => {
      const { user, configurations } = setup({ OpenCode: { command: 'opencode' }, vt: { command: 'vtcode' } }, { registry, onPath });

      await configurations.detect();

      expect(user.take()).toEqual([{
        call: 'showInformationMessage',
        message: 'Every agent from the ACP registry found on the PATH VS Code sees is already configured.',
      }]);
    });

    it('says how many commands it looked for, and on which PATH, when it finds none', async () => {
      vi.stubEnv('PATH', '/usr/bin:/bin');
      try {
        const { user, configurations } = setup({}, { registry });

        await configurations.detect();

        expect(user.take()).toEqual([{
          call: 'showInformationMessage',
          message: 'No agent from the ACP registry was found: looked for 3 commands on the PATH VS Code sees: /usr/bin:/bin',
        }]);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('asks before replacing an agent of the same name, and stops it', async () => {
      const renamed: RegistryAgent = { ...opencode, name: 'one' };
      const { configuration, launcher, manager, user, configurations } = setup({ one: { command: 'one' } }, { registry: async () => [renamed], onPath });
      await manager.ensureConnected('one');
      user.answer(['one'], 'Replace');

      await configurations.detect();

      expect(configuration.get<Agents>('agents')).toEqual({ one: { command: 'opencode', args: ['acp'] } });
      expect(launcher.running('one')).toEqual([]);
      expect(user.take().slice(1)).toEqual([
        confirmReplaceOne,
        { call: 'showInformationMessage', message: 'Agent "one" added.' },
      ]);
    });

    it.each([
      ['dismisses the confirmation', undefined],
      ['chooses Skip', 'Skip'],
    ])('keeps the configuration and running agent when the user %s, adding the rest', async (_action, answer) => {
      const renamed: RegistryAgent = { ...opencode, name: 'one' };
      const { configuration, launcher, manager, user, configurations } = setup({ one: { command: 'one' } }, { registry: async () => [renamed, vtcode], onPath });
      await manager.ensureConnected('one');
      user.answer(['one', 'VT Code'], answer);

      await configurations.detect();

      expect(configuration.get<Agents>('agents')).toEqual({ one: { command: 'one' }, 'VT Code': { command: 'vtcode', args: ['acp'], env: { VT_ACP_ENABLED: '1' } } });
      expect(launcher.running('one')).toHaveLength(1);
      expect(user.take().slice(1)).toEqual([
        confirmReplaceOne,
        { call: 'showInformationMessage', message: 'Agent "VT Code" added.' },
      ]);
    });

    it.each([
      ['dismisses the confirmation', undefined],
      ['chooses Skip', 'Skip'],
    ])('saves nothing and leaves the running agent when the only selection collides and the user %s', async (_action, answer) => {
      const renamed: RegistryAgent = { ...opencode, name: 'one' };
      const { configuration, launcher, manager, user, configurations } = setup(
        { one: { command: 'one', args: ['--old'] } },
        { registry: async () => [renamed], onPath },
      );
      await manager.ensureConnected('one');
      user.answer(['one'], answer);

      await configurations.detect();

      expect(configuration.updates).toEqual([]);
      expect(configuration.get<Agents>('agents')).toEqual({ one: { command: 'one', args: ['--old'] } });
      expect(launcher.running('one')).toHaveLength(1);
      expect(user.take().slice(1)).toEqual([confirmReplaceOne]);
    });

    it('says where an agent of the same name the workspace settings define is, and adds the rest', async () => {
      const { configuration, user, configurations } = setup({}, { registry, onPath, workspace: { OpenCode: { command: 'npx' } } });
      user.answer(['OpenCode', 'VT Code']);

      await configurations.detect();

      expect(configuration.get<Agents>('agents')).toEqual({ OpenCode: { command: 'npx' }, 'VT Code': { command: 'vtcode', args: ['acp'], env: { VT_ACP_ENABLED: '1' } } });
      expect(user.take().slice(1)).toEqual([
        { call: 'showInformationMessage', message: 'Agent "OpenCode" is defined in the workspace settings; edit them to change it.' },
        { call: 'showInformationMessage', message: 'Agent "VT Code" added.' },
      ]);
    });

    it('reports a registry it cannot fetch', async () => {
      const { user, configurations } = setup({}, { registry: async () => { throw new Error('HTTP 503: Service Unavailable'); } });

      await configurations.detect();

      expect(user.take()).toEqual([{ call: 'showErrorMessage', message: 'Could not fetch the ACP registry, which says what to look for: HTTP 503: Service Unavailable' }]);
    });
  });

  describe('remove', () => {
    const confirmRemove = (name: string) => ({
      call: 'showQuickPick',
      items: [
        { label: 'Remove', detail: 'Remove its configuration from the user settings and stop the agent if it is running.' },
        { label: 'Cancel' },
      ],
      options: { title: 'Remove ACP Agent', placeHolder: `Remove agent "${name}"?` },
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

    it('removes it from the user settings\' own agents, leaving the workspace\'s and the defaults out', async () => {
      const { configuration, user, configurations } = setup(
        { one: { command: 'one' }, two: { command: 'two' } },
        { workspace: { three: { command: 'three' } }, defaults: { four: { command: 'four' } } },
      );
      user.answer('Remove');

      await configurations.remove('one');

      expect(configuration.updates).toEqual([{ section: 'agents', value: { two: { command: 'two' } }, target: ConfigurationTarget.Global }]);
    });

    it('says where an agent defined only in the workspace settings is, and leaves it and the agent', async () => {
      const { configuration, launcher, manager, user, configurations } = setup({}, { workspace: { one: { command: 'one' } } });
      await manager.ensureConnected('one');

      await configurations.remove('one');

      expect(configuration.updates).toEqual([]);
      expect(launcher.running('one')).toHaveLength(1);
      expect(user.take()).toEqual([{
        call: 'showInformationMessage',
        message: 'Agent "one" is defined in the workspace settings; edit them to remove it.',
      }]);
    });

    it('removes the user settings\' copy of an agent the workspace settings also define, and says so', async () => {
      const { configuration, user, configurations } = setup(
        { one: { command: 'one' } },
        { workspace: { one: { command: 'one', args: ['--workspace'] } } },
      );
      user.answer('Remove');

      await configurations.remove('one');

      expect(configuration.updates).toEqual([{ section: 'agents', value: {}, target: ConfigurationTarget.Global }]);
      expect(user.take()).toEqual([
        confirmRemove('one'),
        { call: 'showInformationMessage', message: 'Agent "one" removed from the user settings; the workspace settings still define it.' },
      ]);
    });

    it('reports when an agent remains available from defaults after removing the user entry', async () => {
      const { configuration, user, configurations } = setup(
        { one: { command: 'one' } },
        { defaults: { one: { command: 'default-one' } } },
      );
      user.answer('Remove');

      await configurations.remove('one');

      expect(configuration.inspect('agents')?.globalValue).toEqual({});
      expect(configuration.get('agents')).toEqual({ one: { command: 'default-one' } });
      const message = user.take().at(-1);
      expect(message?.call === 'showInformationMessage' && message.message).toContain('still configured');
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

    it.each([
      ['dismisses the confirmation', undefined],
      ['chooses Cancel', 'Cancel'],
    ])('keeps the configuration and running agent when the user %s', async (_action, answer) => {
      const { configuration, launcher, manager, user, configurations } = setup({ one: { command: 'one' } });
      await manager.ensureConnected('one');
      user.answer(answer);

      await configurations.remove('one');

      expect(configuration.updates).toEqual([]);
      expect(configuration.get<Agents>('agents')).toEqual({ one: { command: 'one' } });
      expect(launcher.running('one')).toHaveLength(1);
      expect(user.take()).toEqual([confirmRemove('one')]);
    });

    it('says so when no agent is configured', async () => {
      const { user, configurations } = setup({});

      await configurations.remove();

      expect(user.take()).toEqual([{ call: 'showInformationMessage', message: 'No agents configured.' }]);
    });
  });

  describe('remote authority scope', () => {
    const DEVENV: AgentScope = { kind: 'remote', authority: 'ssh-remote+devenv' };
    const UNKNOWN: AgentScope = { kind: 'unknown' };
    const unknownMessage = 'The remote authority is not yet known; agent configurations are unavailable until it is.';

    it('removes only the selected agent when another entry changes during confirmation', async () => {
      const { configuration, user, configurations } = setup(
        { 'ssh-remote+devenv': { one: { command: 'one' }, two: { command: 'old' } } },
        { scope: DEVENV },
      );
      user.answer('Remove');

      const removing = configurations.remove('one');
      expect(user.calls.at(-1)).toMatchObject({ call: 'showQuickPick', options: { placeHolder: 'Remove agent "one"?' } });
      configuration.setUser({
        'ssh-remote+devenv': { one: { command: 'one' }, two: { command: 'new' }, stray: null },
      });
      await removing;

      expect(configuration.get('agents')).toEqual({
        'ssh-remote+devenv': { two: { command: 'new' }, stray: null },
      });
    });

    it('leaves an authority key alone when it becomes occupied during removal confirmation', async () => {
      const { configuration, user, configurations } = setup(
        { 'ssh-remote+devenv': { one: { command: 'one' } } },
        { scope: DEVENV },
      );
      user.answer('Remove');

      const removing = configurations.remove('one');
      const changed = { 'ssh-remote+devenv': { command: 'local-agent' } };
      configuration.setUser(changed);
      await removing;

      expect(configuration.get('agents')).toEqual(changed);
      expect(configuration.updates).toEqual([]);
    });

    it('preserves malformed entries when adding an agent to the remote group', async () => {
      const { configuration, user, configurations } = setup(
        { 'ssh-remote+devenv': { stray: 'keep me' } },
        { scope: DEVENV },
      );
      user.answer(CUSTOM, 'mine', 'npx', '');

      await configurations.add();

      expect(configuration.get('agents')).toEqual({
        'ssh-remote+devenv': { stray: 'keep me', mine: { command: 'npx', args: [] } },
      });
    });

    it('reports a malformed name collision in Detect and saves the other selection', async () => {
      const { configuration, user, configurations } = setup(
        { 'ssh-remote+devenv': { Stray: 'keep me' } },
        {
          scope: DEVENV,
          registry: async () => [
            { id: 'stray', name: 'Stray', version: '1.0.0', description: '', runs: { through: 'binary' }, binary: { 'linux-x86_64': { cmd: './stray' } } },
            { id: 'valid', name: 'Valid', version: '1.0.0', description: '', runs: { through: 'binary' }, binary: { 'linux-x86_64': { cmd: './valid' } } },
          ],
          onPath: { stray: '/bin/stray', valid: '/bin/valid' },
        },
      );
      user.answer(['Stray', 'Valid']);

      await configurations.detect();

      expect(configuration.get('agents')).toEqual({
        'ssh-remote+devenv': { Stray: 'keep me', Valid: { command: 'valid' } },
      });
      expect(user.take()).toContainEqual({
        call: 'showInformationMessage',
        message: 'Cannot add "Stray": that name already holds another value in the settings.',
      });
    });

    it('saves an agent into the group for the current authority, creating it if absent', async () => {
      const { configuration, user, configurations } = setup({ one: { command: 'one' } }, { scope: DEVENV });
      user.answer(CUSTOM, 'mine', 'npx', '');

      await configurations.add();

      expect(configuration.updates).toEqual([{
        section: 'agents',
        value: { one: { command: 'one' }, 'ssh-remote+devenv': { mine: { command: 'npx', args: [] } } },
        target: ConfigurationTarget.Global,
      }]);
    });

    it('reads and replaces only the matching authority group, leaving local entries and other authorities untouched', async () => {
      const userAgents = {
        one: { command: 'local-one' },
        'ssh-remote+devenv': { one: { command: 'remote-one', args: ['--old'] } },
        'ssh-remote+other': { two: { command: 'two' } },
      };
      const { configuration, launcher, manager, user, configurations } = setup(userAgents, { scope: DEVENV });
      await manager.ensureConnected('one');
      user.answer(CUSTOM, 'one', 'Replace', 'remote-one', '--new');

      await configurations.add();

      expect(configuration.get('agents')).toEqual({
        one: { command: 'local-one' },
        'ssh-remote+devenv': { one: { command: 'remote-one', args: ['--new'] } },
        'ssh-remote+other': { two: { command: 'two' } },
      });
      // "one" was connected through the active (remote) scope's configuration, so replacing it stops it.
      expect(launcher.running('one')).toEqual([]);
    });

    it('detects agents into the group for the current authority', async () => {
      const opencode: RegistryAgent = {
        id: 'opencode',
        name: 'OpenCode',
        version: '1.19.3',
        description: 'The open source coding agent',
        runs: { through: 'binary' },
        binary: { 'linux-x86_64': { cmd: './opencode', args: ['acp'] } },
      };
      const { configuration, user, configurations } = setup({}, {
        scope: DEVENV,
        registry: async () => [opencode],
        onPath: { opencode: '/home/me/.opencode/bin/opencode' },
      });
      user.answer(['OpenCode']);

      await configurations.detect();

      expect(configuration.get('agents')).toEqual({ 'ssh-remote+devenv': { OpenCode: { command: 'opencode', args: ['acp'] } } });
    });

    it('removes an agent from the group for the current authority, keeping it after its last entry is gone', async () => {
      const userAgents = { 'ssh-remote+devenv': { one: { command: 'one' } } };
      const { configuration, user, configurations } = setup(userAgents, { scope: DEVENV });
      user.answer('Remove');

      await configurations.remove('one');

      expect(configuration.get('agents')).toEqual({ 'ssh-remote+devenv': {} });
    });

    it('treats the same agent name in another authority\'s group as no conflict', async () => {
      const userAgents = { 'ssh-remote+other': { one: { command: 'other-one' } } };
      const { configuration, user, configurations } = setup(userAgents, { scope: DEVENV });
      user.answer(CUSTOM, 'one', 'npx', '');

      await configurations.add();

      expect(configuration.get('agents')).toEqual({
        'ssh-remote+other': { one: { command: 'other-one' } },
        'ssh-remote+devenv': { one: { command: 'npx', args: [] } },
      });
    });

    it.each([
      ['add', (c: ReturnType<typeof setup>['configurations']) => c.add()],
      ['detect', (c: ReturnType<typeof setup>['configurations']) => c.detect()],
      ['remove', (c: ReturnType<typeof setup>['configurations']) => c.remove('one')],
    ])('says the authority is not yet known for %s, and makes no changes', async (_command, run) => {
      const { configuration, user, configurations } = setup({ one: { command: 'one' } }, { scope: UNKNOWN });

      await run(configurations);

      expect(configuration.updates).toEqual([]);
      expect(user.take()).toEqual([{ call: 'showInformationMessage', message: unknownMessage }]);
    });

    it('reports a collision adding a local agent whose name already holds a remote authority\'s group, and leaves the map unchanged', async () => {
      const userAgents = { 'ssh-remote+devenv': { one: { command: 'one' } } };
      const { configuration, user, configurations } = setup(userAgents, { scope: LOCAL });
      user.answer(CUSTOM, 'ssh-remote+devenv', 'npx', '');

      await configurations.add();

      expect(configuration.updates).toEqual([]);
      expect(user.take()).toEqual([
        pickedCustom,
        askName,
        { call: 'showInformationMessage', message: 'Cannot add "ssh-remote+devenv": that name already holds another value in the settings.' },
      ]);
    });

    it.each([
      ['add', (c: ReturnType<typeof setup>['configurations']) => c.add()],
      ['detect', (c: ReturnType<typeof setup>['configurations']) => c.detect()],
    ])('reports a collision for %s when the current authority\'s key already holds a local agent configuration, and leaves the map unchanged', async (_command, run) => {
      const userAgents = { 'ssh-remote+devenv': { command: 'already-an-agent' } };
      const { configuration, user, configurations } = setup(userAgents, { scope: DEVENV, registry: async () => [] });

      await run(configurations);

      expect(configuration.updates).toEqual([]);
      expect(user.take()).toEqual([{
        call: 'showInformationMessage',
        message: 'Cannot change agents for "ssh-remote+devenv": its entry in the user settings is a single agent configuration there, not a group.',
      }]);
    });

    it('reports a collision when the current authority\'s key holds a malformed value, and leaves the map unchanged', async () => {
      const userAgents = { 'ssh-remote+devenv': 'not an object' };
      const { configuration, user, configurations } = setup(userAgents, { scope: DEVENV });

      await configurations.add();

      expect(configuration.updates).toEqual([]);
      expect(user.take()).toEqual([{
        call: 'showInformationMessage',
        message: 'Cannot change agents for "ssh-remote+devenv": its entry in the user settings is not a valid group of agent configurations there.',
      }]);
    });
  });

  it('does not overwrite an agent added while the custom configuration picker is open', async () => {
    const configurationRef: { current?: MemoryConfiguration } = {};
    class RacingUser extends ScriptedUser {
      private inputCount = 0;
      override async showInputBox(options?: InputBoxOptions): Promise<string | undefined> {
        const answer = await super.showInputBox(options);
        this.inputCount += 1;
        if (this.inputCount === 3) {
          configurationRef.current?.setUser({ mine: { command: 'concurrent-edit' } });
        }
        return answer;
      }
    }
    const user = new RacingUser().answer(CUSTOM, 'mine', 'npx', '');
    const setupResult = setup({}, { scriptedUser: user });
    configurationRef.current = setupResult.configuration;

    await setupResult.configurations.add();

    expect(setupResult.configuration.get('agents')).toEqual({ mine: { command: 'concurrent-edit' } });
    expect(setupResult.configuration.updates).toEqual([]);
    expect(user.take().at(-1)).toEqual({
      call: 'showInformationMessage',
      message: 'Cannot add "mine": it was configured while the picker was open. Confirm the replacement and try again.',
    });
  });

  it('does not overwrite a malformed local setting whose key matches a new agent name', async () => {
    const malformed = { mine: 'preserve this' };
    const { configuration, user, configurations } = setup(malformed);
    user.answer(CUSTOM, 'mine', 'npx', '');

    await configurations.add();

    expect(configuration.get('agents')).toEqual(malformed);
    expect(configuration.updates).toEqual([]);
    expect(user.take().at(-1)).toEqual({
      call: 'showInformationMessage',
      message: 'Cannot add "mine": that name already holds another value in the settings.',
    });
  });
});
