import { describe, expect, it, vi } from 'vitest';
import { methods, RequestError } from '@agentclientprotocol/sdk';
import type { AgentApp, InitializeResponse } from '@agentclientprotocol/sdk';
import { ConnectionManager } from '@/core/acp/ConnectionManager';
import { SessionCommands } from '@/core/SessionCommands';
import { SessionManager } from '@/core/SessionManager';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import { ProgressLocation } from '@/core/VsCodeApi';
import { fakeAgent, InProcessAgents, unusedHandlers, type AgentScript } from './InProcessAgents';
import { ScriptedUser, type Call } from './ScriptedUser';

const progress = (title: string): Call => ({ call: 'withProgress', options: { location: ProgressLocation.Notification, title, cancellable: false } });
const focusChatView: Call = { call: 'executeCommand', command: 'acp-chat.focus' };

/**
 * An agent that numbers the sessions it creates across all its launches
 * (`one-1`, `one-2`, ...) and records the other requests it receives.
 */
function sessionAgent(name: string, init: Partial<InitializeResponse> = {}, extend: (app: AgentApp) => AgentApp = (app) => app) {
  let created = 0;
  const requests: { method: string; params: unknown }[] = [];
  const script: AgentScript = () => extend(fakeAgent(init)
    .onRequest(methods.agent.session.new, () => ({ sessionId: `${name}-${++created}` }))
    .onRequest(methods.agent.session.load, ({ params }) => {
      requests.push({ method: 'session/load', params });
      return {};
    })
    .onRequest(methods.agent.session.resume, ({ params }) => {
      requests.push({ method: 'session/resume', params });
      return {};
    })
    .onRequest(methods.agent.session.setMode, ({ params }) => {
      requests.push({ method: 'session/set_mode', params });
      return {};
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      requests.push({ method: 'session/cancel', params });
    }));
  return { script, requests };
}

function setup(scripts: Record<string, AgentScript>) {
  const agents = new InProcessAgents(scripts);
  const manager = new SessionManager(
    agents,
    new ConnectionManager(new SessionUpdateHandler(), '0.0.0-test', () => unusedHandlers),
    {
      workspaceCwd: () => '/work',
      agentConfigs: () => Object.fromEntries(Object.keys(scripts).map((name) => [name, { command: name }])),
      activeFileLink: () => undefined,
    },
    { chooseAuthMethod: async () => undefined },
  );
  const transcript = {
    hasTranscript: false,
    clearTranscript: vi.fn(() => { transcript.hasTranscript = false; }),
  };
  const user = new ScriptedUser();
  const commands = new SessionCommands(manager, transcript, user, user, () => Object.keys(scripts));
  return { agents, manager, transcript, user, commands };
}

describe('SessionCommands', () => {
  describe('connect', () => {
    it('makes a session with the named agent the active session', async () => {
      const { manager, user, commands } = setup({ one: sessionAgent('one').script });

      await commands.connect('one');

      expect(manager.getActiveSessionId()).toBe('one-1');
      expect(user.take()).toEqual([progress('Connecting to one...')]);
    });

    it('asks which configured agent to connect when none is named', async () => {
      const { manager, user, commands } = setup({ one: sessionAgent('one').script, two: sessionAgent('two').script });
      user.answer('two');

      await commands.connect();

      expect(manager.getActiveSessionId()).toBe('two-1');
      expect(user.take()).toEqual([
        { call: 'showQuickPick', items: ['one', 'two'], options: { placeHolder: 'Select an agent to connect', title: 'Connect to Agent' } },
        progress('Connecting to two...'),
      ]);
    });

    it('does nothing when the user dismisses the choice of agent', async () => {
      const { agents, user, commands } = setup({ one: sessionAgent('one').script });
      user.answer(undefined);

      await commands.connect();

      expect(agents.launched).toEqual([]);
      expect(user.take().map((c) => c.call)).toEqual(['showQuickPick']);
    });

    it('warns when no agent is configured', async () => {
      const { user, commands } = setup({});

      await commands.connect();

      expect(user.take()).toEqual([
        { call: 'showWarningMessage', message: 'No ACP agents configured. Add agents in Settings > ACP > Agents.' },
      ]);
    });

    it('asks before switching agents while there is a transcript, and clears it', async () => {
      const { manager, transcript, user, commands } = setup({ one: sessionAgent('one').script, two: sessionAgent('two').script });
      await manager.connectToAgent('one');
      transcript.hasTranscript = true;
      user.answer('Switch Agent');

      await commands.connect('two');

      expect(manager.getActiveSessionId()).toBe('two-1');
      expect(manager.hasSession('one')).toBe(false);
      expect(transcript.clearTranscript).toHaveBeenCalledOnce();
      expect(user.take()).toEqual([
        {
          call: 'showWarningMessage',
          message: 'Switch to two? This will disconnect one and clear the transcript.',
          items: ['Switch Agent', 'Cancel'],
        },
        progress('Connecting to two...'),
      ]);
    });

    it('keeps the session and the transcript when the user declines to switch', async () => {
      const { manager, transcript, user, commands } = setup({ one: sessionAgent('one').script, two: sessionAgent('two').script });
      await manager.connectToAgent('one');
      transcript.hasTranscript = true;
      user.answer('Cancel');

      await commands.connect('two');

      expect(manager.getActiveSessionId()).toBe('one-1');
      expect(transcript.clearTranscript).not.toHaveBeenCalled();
    });

    it('does not ask when connecting the agent that already has the active session', async () => {
      const { manager, transcript, user, commands } = setup({ one: sessionAgent('one').script });
      await manager.connectToAgent('one');
      transcript.hasTranscript = true;

      await commands.connect('one');

      expect(manager.getActiveSessionId()).toBe('one-1');
      expect(user.take()).toEqual([progress('Connecting to one...')]);
    });

    it('reports a failure to connect', async () => {
      const { user, commands } = setup({
        broken: () => fakeAgent().onRequest(methods.agent.session.new, () => {
          throw RequestError.internalError(undefined, 'no model configured');
        }),
      });

      await commands.connect('broken');

      expect(user.take()).toEqual([
        progress('Connecting to broken...'),
        { call: 'showErrorMessage', message: 'Failed to connect: Internal error: no model configured' },
      ]);
    });
  });

  describe('new session', () => {
    it("starts a new session with the active session's agent", async () => {
      const { manager, user, commands } = setup({ one: sessionAgent('one').script });
      await manager.connectToAgent('one');

      await commands.newSession();

      expect(manager.getActiveSessionId()).toBe('one-2');
      expect(user.take()).toEqual([progress('Starting new session with Fake Agent...')]);
    });

    it('asks first while there is a transcript', async () => {
      const { agents, manager, transcript, user, commands } = setup({ one: sessionAgent('one').script });
      await manager.connectToAgent('one');
      transcript.hasTranscript = true;
      user.answer('Cancel');

      await commands.newSession();

      expect(agents.launched).toHaveLength(1);
      expect(manager.getActiveSessionId()).toBe('one-1');
      expect(user.take()).toEqual([
        { call: 'showWarningMessage', message: 'Start a new session? This will clear the current transcript.', items: ['New Session', 'Cancel'] },
      ]);
    });

    it('connects an agent when there is no active session', async () => {
      const { manager, user, commands } = setup({ one: sessionAgent('one').script });
      user.answer('one');

      await commands.newSession();

      expect(manager.getActiveSessionId()).toBe('one-1');
      expect(user.take().map((c) => c.call)).toEqual(['showQuickPick', 'withProgress']);
    });

    it('reports a failure to start the session', async () => {
      let created = 0;
      const { manager, user, commands } = setup({
        flaky: () => fakeAgent().onRequest(methods.agent.session.new, () => {
          if (++created > 1) {
            throw RequestError.internalError(undefined, 'out of quota');
          }
          return { sessionId: 'flaky-1' };
        }),
      });
      await manager.connectToAgent('flaky');

      await commands.newSession();

      expect(user.take()).toEqual([
        progress('Starting new session with Fake Agent...'),
        { call: 'showErrorMessage', message: 'Failed to start new session: Internal error: out of quota' },
      ]);
    });
  });

  describe('disconnect', () => {
    it("stops the active session's agent", async () => {
      const { agents, manager, user, commands } = setup({ one: sessionAgent('one').script });
      await manager.connectToAgent('one');

      await commands.disconnect();

      expect(agents.running('one')).toEqual([]);
      expect(manager.getActiveSessionId()).toBeNull();
      expect(user.take()).toEqual([{ call: 'showInformationMessage', message: 'Disconnected from one.' }]);
    });

    it('stops the named agent', async () => {
      const { agents, manager, user, commands } = setup({ one: sessionAgent('one').script });
      await manager.ensureConnected('one');

      await commands.disconnect('one');

      expect(agents.running('one')).toEqual([]);
      expect(user.take()).toEqual([{ call: 'showInformationMessage', message: 'Disconnected from one.' }]);
    });

    it('says so when there is no session to disconnect', async () => {
      const { user, commands } = setup({ one: sessionAgent('one').script });

      await commands.disconnect();

      expect(user.take()).toEqual([{ call: 'showInformationMessage', message: 'No active session.' }]);
    });
  });

  describe('restart', () => {
    it("restarts the active session's agent on a new process with a new session", async () => {
      const { agents, manager, user, commands } = setup({ one: sessionAgent('one').script });
      await manager.connectToAgent('one');
      const [first] = agents.launched;

      await commands.restart();

      expect(first?.killed).toBe(true);
      expect(agents.running('one')).toHaveLength(1);
      expect(manager.getActiveSessionId()).toBe('one-2');
      expect(user.take()).toEqual([
        progress('Restarting Fake Agent...'),
        { call: 'showInformationMessage', message: 'Restarted one' },
      ]);
    });

    it('restarts the agent it is given', async () => {
      const { manager, user, commands } = setup({ one: sessionAgent('one').script, two: sessionAgent('two').script });
      await manager.connectToAgent('one');

      await commands.restart('two');

      expect(manager.getActiveAgentName()).toBe('two');
      expect(user.take()).toEqual([
        progress('Restarting two...'),
        { call: 'showInformationMessage', message: 'Restarted two' },
      ]);
    });

    it('does nothing without an agent', async () => {
      const { agents, user, commands } = setup({ one: sessionAgent('one').script });

      await commands.restart();

      expect(agents.launched).toEqual([]);
      expect(user.take()).toEqual([]);
    });

    it('reports a failure to restart', async () => {
      let created = 0;
      const { manager, user, commands } = setup({
        flaky: () => fakeAgent().onRequest(methods.agent.session.new, () => {
          if (++created > 1) {
            throw RequestError.internalError(undefined, 'out of quota');
          }
          return { sessionId: 'flaky-1' };
        }),
      });
      await manager.connectToAgent('flaky');

      await commands.restart();

      expect(user.take()).toEqual([
        progress('Restarting Fake Agent...'),
        { call: 'showErrorMessage', message: 'Failed to restart: Internal error: out of quota' },
      ]);
    });
  });

  describe('turns and session controls', () => {
    it("cancels the active session's turn", async () => {
      const one = sessionAgent('one');
      const { manager, commands } = setup({ one: one.script });
      await manager.connectToAgent('one');

      await commands.cancelTurn();

      await vi.waitFor(() => expect(one.requests).toEqual([{ method: 'session/cancel', params: { sessionId: 'one-1' } }]));
    });

    it('sets the mode it is given', async () => {
      const one = sessionAgent('one');
      const { manager, user, commands } = setup({ one: one.script });
      await manager.connectToAgent('one');

      await commands.setMode('plan');

      expect(one.requests).toEqual([{ method: 'session/set_mode', params: { sessionId: 'one-1', modeId: 'plan' } }]);
      expect(user.take()).toEqual([]);
    });

    it('asks for the mode when none is given, and does nothing when dismissed', async () => {
      const one = sessionAgent('one');
      const { manager, user, commands } = setup({ one: one.script });
      await manager.connectToAgent('one');
      user.answer('code', undefined);

      await commands.setMode();
      await commands.setMode();

      const ask: Call = { call: 'showInputBox', options: { placeHolder: 'Enter mode ID (e.g., "plan", "code")', title: 'Set Agent Mode' } };
      expect(one.requests).toEqual([{ method: 'session/set_mode', params: { sessionId: 'one-1', modeId: 'code' } }]);
      expect(user.take()).toEqual([ask, ask]);
    });

    it('reports a model the agent cannot set', async () => {
      const { manager, user, commands } = setup({ one: sessionAgent('one').script });
      await manager.connectToAgent('one');
      user.answer('gpt-9');

      await commands.setModel();

      expect(user.take()).toEqual([
        { call: 'showInputBox', options: { placeHolder: 'Enter model ID', title: 'Set Agent Model' } },
        { call: 'showErrorMessage', message: 'Failed to set model: Fake Agent does not expose a model config option' },
      ]);
    });

    it('does nothing without an active session', async () => {
      const { user, commands } = setup({ one: sessionAgent('one').script });

      await commands.cancelTurn();
      await commands.setMode('plan');
      await commands.setModel('gpt-9');

      expect(user.take()).toEqual([]);
    });
  });

  describe('open a session', () => {
    const loads = { agentCapabilities: { loadSession: true } };
    const resumes = { agentCapabilities: { sessionCapabilities: { resume: {} } } };

    it('loads the session in the chat view when the agent can load', async () => {
      const one = sessionAgent('one', loads);
      const { manager, user, commands } = setup({ one: one.script });

      await commands.open('one', 'old');

      expect(manager.getActiveSessionId()).toBe('old');
      expect(one.requests).toEqual([{ method: 'session/load', params: { sessionId: 'old', cwd: '/work', mcpServers: [] } }]);
      expect(user.take()).toEqual([focusChatView, progress('Loading session…')]);
    });

    it('resumes the session when the agent can only resume', async () => {
      const one = sessionAgent('one', resumes);
      const { manager, user, commands } = setup({ one: one.script });

      await commands.open('one', 'old');

      expect(manager.getActiveSessionId()).toBe('old');
      expect(one.requests.map((r) => r.method)).toEqual(['session/resume']);
      expect(user.take()).toEqual([focusChatView, { call: 'showInformationMessage', message: 'Resumed session (history not replayed).' }]);
    });

    it('reports an agent that can neither load nor resume', async () => {
      const { user, commands } = setup({ one: sessionAgent('one').script });

      await commands.open('one', 'old');

      expect(user.take()).toEqual([
        focusChatView,
        { call: 'showErrorMessage', message: 'Agent "one" does not support loading or resuming sessions.' },
      ]);
    });

    it('only shows the chat view when the session is already active', async () => {
      const one = sessionAgent('one', loads);
      const { manager, transcript, user, commands } = setup({ one: one.script });
      await manager.loadSession('one', 'old');
      transcript.hasTranscript = true;

      await commands.open('one', 'old');

      expect(one.requests).toHaveLength(1);
      expect(user.take()).toEqual([focusChatView]);
    });

    it('asks first while there is a transcript, and stays when declined', async () => {
      const one = sessionAgent('one', loads);
      const { manager, transcript, user, commands } = setup({ one: one.script });
      await manager.connectToAgent('one');
      transcript.hasTranscript = true;
      user.answer('Cancel');

      await commands.open('one', 'old');

      expect(manager.getActiveSessionId()).toBe('one-1');
      expect(one.requests).toEqual([]);
      expect(user.take()).toEqual([
        { call: 'showWarningMessage', message: 'Open a different session? This will replace the current transcript.', items: ['Open Session', 'Cancel'] },
      ]);
    });

    it('reports a session the agent fails to load', async () => {
      const { user, commands } = setup({
        one: () => fakeAgent(loads).onRequest(methods.agent.session.load, () => {
          throw RequestError.invalidParams(undefined, 'Session not found');
        }),
      });

      await commands.open('one', 'gone');

      expect(user.take()).toEqual([
        focusChatView,
        progress('Loading session…'),
        { call: 'showErrorMessage', message: 'Failed to open session: Invalid params: Session not found' },
      ]);
    });

    it('reports a missing agent or session', async () => {
      const { user, commands } = setup({ one: sessionAgent('one').script });

      await commands.open(undefined, 'old');
      await commands.open('one', undefined);

      const missing: Call = { call: 'showErrorMessage', message: 'Open Session: missing agentName/sessionId.' };
      expect(user.take()).toEqual([missing, missing]);
    });
  });
});
