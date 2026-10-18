import { describe, expect, it, vi } from 'vitest';
import type { PromptResponse, SessionConfigOption, SessionNotification } from '@agentclientprotocol/sdk';
import {
  ChatViewController,
  type ChatSessions,
  type ChatViewEnvironment,
  type MidTurnPrompt,
} from '@/core/ChatViewController';
import type { SessionInfo } from '@/core/SessionManager';
import type { ExtensionToWebviewMessage } from '@/shared/WebviewMessages';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let pending promise callbacks run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const modelOption: SessionConfigOption = {
  id: 'model',
  name: 'Model',
  type: 'select',
  currentValue: 'a',
  options: [{ value: 'a', name: 'Model A' }, { value: 'b', name: 'Model B' }],
};

function sessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: 's1',
    agentId: 'fake',
    agentName: 'fake',
    agentDisplayName: 'Fake Agent',
    cwd: '/work/project',
    createdAt: '2026-10-18T00:00:00Z',
    initResponse: { protocolVersion: 1 },
    modes: null,
    configOptions: [modelOption],
    availableCommands: [],
    ...overrides,
  };
}

/** Sessions whose prompts stay in flight until the test answers them. */
class FakeSessions implements ChatSessions {
  activeId: string | null = 's1';
  session: SessionInfo | undefined = sessionInfo();
  readonly prompts: { text: string; reply: Deferred<PromptResponse> }[] = [];

  getActiveSessionId = () => this.activeId;
  getSession = (sessionId: string) => (this.session?.sessionId === sessionId ? this.session : undefined);
  sendPrompt = vi.fn<ChatSessions['sendPrompt']>((_sessionId, text) => {
    const reply = deferred<PromptResponse>();
    this.prompts.push({ text, reply });
    return reply.promise;
  });
  cancelTurn = vi.fn<ChatSessions['cancelTurn']>(async () => {});
  setMode = vi.fn<ChatSessions['setMode']>(async () => {});
  setConfigOption = vi.fn<ChatSessions['setConfigOption']>(async () => null);
  recordFirstPrompt = vi.fn<ChatSessions['recordFirstPrompt']>();
  touchHistory = vi.fn<ChatSessions['touchHistory']>();
  applyAvailableCommands = vi.fn<ChatSessions['applyAvailableCommands']>();
  applyConfigOptions = vi.fn<ChatSessions['applyConfigOptions']>();
  /** As ACP defines it: a null title clears it, a missing one leaves it unchanged. */
  applySessionInfoUpdate = vi.fn<ChatSessions['applySessionInfoUpdate']>((sessionId, update) => {
    if (this.session?.sessionId !== sessionId) { return; }
    if (update.title === null) {
      delete this.session.title;
    } else if (update.title !== undefined) {
      this.session.title = update.title;
    }
  });

  /** Answer the oldest prompt still in flight. */
  answer(response: PromptResponse = { stopReason: 'end_turn' }): void {
    const prompt = this.prompts.shift();
    if (!prompt) {
      throw new Error('no prompt in flight');
    }
    prompt.reply.resolve(response);
  }

  fail(error: unknown): void {
    const prompt = this.prompts.shift();
    if (!prompt) {
      throw new Error('no prompt in flight');
    }
    prompt.reply.reject(error);
  }
}

class FakeEnvironment implements ChatViewEnvironment {
  posted: ExtensionToWebviewMessage[] = [];
  midTurn: MidTurnPrompt = 'queue';

  post(message: ExtensionToWebviewMessage): void {
    this.posted.push(message);
  }
  midTurnPrompt(): MidTurnPrompt {
    return this.midTurn;
  }
  executeCommand = vi.fn<ChatViewEnvironment['executeCommand']>(async () => {});

  /** Messages posted since the last call. */
  take(): ExtensionToWebviewMessage[] {
    const taken = this.posted;
    this.posted = [];
    return taken;
  }
}

function setup() {
  const sessions = new FakeSessions();
  const environment = new FakeEnvironment();
  const controller = new ChatViewController(sessions, environment);
  return { sessions, environment, controller };
}

function sendPrompt(controller: ChatViewController, text: string): Promise<void> {
  return controller.handleMessage({ type: 'sendPrompt', text });
}

describe('ChatViewController', () => {
  describe('session state', () => {
    it('describes the active session when the webview is ready', async () => {
      const { sessions, environment, controller } = setup();
      sessions.session = sessionInfo({ title: 'Fix the build', availableCommands: [{ name: 'init', description: 'Init' }] });

      await controller.handleMessage({ type: 'ready' });

      expect(environment.take()).toEqual([{
        type: 'state',
        activeSessionId: 's1',
        session: {
          sessionId: 's1',
          agentName: 'Fake Agent',
          title: 'Fix the build',
          cwd: '/work/project',
          modes: null,
          configOptions: [modelOption],
          availableCommands: [{ name: 'init', description: 'Init' }],
        },
      }]);
    });

    it('leaves the title out when the session has none', () => {
      const { environment, controller } = setup();

      controller.notifyActiveSessionChanged();

      const [state] = environment.take();
      expect(state).toMatchObject({ type: 'state', session: { sessionId: 's1' } });
      expect(state?.type === 'state' ? state.session : undefined).not.toHaveProperty('title');
    });

    it('reports no session when none is active', async () => {
      const { sessions, environment, controller } = setup();
      sessions.activeId = null;

      await controller.handleMessage({ type: 'ready' });

      expect(environment.take()).toEqual([{ type: 'state', activeSessionId: null, session: null }]);
    });

    it('passes on replays and mode changes', () => {
      const { environment, controller } = setup();
      const modes = { availableModes: [{ id: 'ask', name: 'Ask' }], currentModeId: 'ask' };

      controller.notifyLoadSessionStart();
      controller.notifyLoadSessionEnd(false);
      controller.notifyModesUpdate(modes);

      expect(environment.take()).toEqual([
        { type: 'loadSessionStart' },
        { type: 'loadSessionEnd', ok: false },
        { type: 'modesUpdate', modes },
      ]);
    });

  });

  describe('session title', () => {
    function infoUpdate(fields: { title?: string | null; updatedAt?: string }): SessionNotification {
      return { sessionId: 's1', update: { sessionUpdate: 'session_info_update', ...fields } };
    }

    function titles(environment: FakeEnvironment): (string | null)[] {
      return environment.take().flatMap((m) => (m.type === 'sessionInfoUpdate' ? [m.title] : []));
    }

    it('shows the title the agent sets', () => {
      const { environment, controller } = setup();

      controller.handleSessionUpdate(infoUpdate({ title: 'New title' }));

      expect(titles(environment)).toEqual(['New title']);
    });

    it('keeps the title when an update carries none', () => {
      const { sessions, environment, controller } = setup();
      sessions.session = sessionInfo({ title: 'Fix the build' });

      controller.handleSessionUpdate(infoUpdate({ updatedAt: '2026-10-18T12:00:00Z' }));

      expect(titles(environment)).toEqual(['Fix the build']);
    });

    it('removes the title when the agent clears it', () => {
      const { sessions, environment, controller } = setup();
      sessions.session = sessionInfo({ title: 'Fix the build' });

      controller.handleSessionUpdate(infoUpdate({ title: null }));

      expect(titles(environment)).toEqual([null]);
    });
  });

  describe('turns', () => {
    it('refuses a prompt when no session is active', async () => {
      const { sessions, environment, controller } = setup();
      sessions.activeId = null;

      await sendPrompt(controller, 'hello');

      expect(sessions.sendPrompt).not.toHaveBeenCalled();
      expect(environment.take()).toEqual([{ type: 'error', message: 'No active session. Create a session first.' }]);
    });

    it('runs a turn and reports its stop reason and usage', async () => {
      const { sessions, environment, controller } = setup();
      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

      const turn = sendPrompt(controller, 'hello');
      expect(sessions.sendPrompt).toHaveBeenCalledExactlyOnceWith('s1', 'hello');
      expect(sessions.recordFirstPrompt).toHaveBeenCalledExactlyOnceWith('s1', 'hello');
      expect(environment.take()).toEqual([{ type: 'promptStart' }]);
      expect(controller.hasChatContent).toBe(true);

      sessions.answer({ stopReason: 'end_turn', usage });
      await turn;

      expect(sessions.touchHistory).toHaveBeenCalledExactlyOnceWith('s1');
      expect(environment.take()).toEqual([{ type: 'promptEnd', stopReason: 'end_turn', usage }]);
    });

    it('leaves usage out when the agent reports none', async () => {
      const { sessions, environment, controller } = setup();

      const turn = sendPrompt(controller, 'hello');
      sessions.answer({ stopReason: 'cancelled' });
      await turn;

      expect(environment.take().at(-1)).toStrictEqual({ type: 'promptEnd', stopReason: 'cancelled' });
    });

    it('reports a failed prompt as an error that ends the turn', async () => {
      const { sessions, environment, controller } = setup();

      const turn = sendPrompt(controller, 'hello');
      sessions.fail(new Error('agent crashed'));
      await turn;

      expect(sessions.touchHistory).not.toHaveBeenCalled();
      expect(environment.take()).toEqual([
        { type: 'promptStart' },
        { type: 'error', message: 'agent crashed' },
        { type: 'promptEnd', stopReason: 'error' },
      ]);
    });

    it('uses a generic message when the failure has none', async () => {
      const { sessions, environment, controller } = setup();

      const turn = sendPrompt(controller, 'hello');
      sessions.fail({});
      await turn;

      expect(environment.take()).toContainEqual({ type: 'error', message: 'Prompt failed' });
    });
  });

  describe('mid-turn prompts', () => {
    it('queues a mid-turn prompt until the running turn ends', async () => {
      const { sessions, environment, controller } = setup();

      const first = sendPrompt(controller, 'first');
      await sendPrompt(controller, 'second');
      expect(sessions.sendPrompt.mock.calls.map(([, text]) => text)).toEqual(['first']);

      sessions.answer();
      await first;
      expect(sessions.sendPrompt.mock.calls.map(([, text]) => text)).toEqual(['first', 'second']);

      sessions.answer();
      await settle();
      expect(environment.take()).toEqual([
        { type: 'promptStart' },
        { type: 'promptEnd', stopReason: 'end_turn' },
        { type: 'promptStart' },
        { type: 'promptEnd', stopReason: 'end_turn' },
      ]);
    });

    it('sends queued prompts in the order they were typed', async () => {
      const { sessions, controller } = setup();

      void sendPrompt(controller, 'first');
      await sendPrompt(controller, 'second');
      await sendPrompt(controller, 'third');
      sessions.answer();
      await settle();
      sessions.answer();
      await settle();

      expect(sessions.sendPrompt.mock.calls.map(([, text]) => text)).toEqual(['first', 'second', 'third']);
    });

    it('sends a mid-turn prompt straight to the agent when set to send', async () => {
      const { sessions, environment, controller } = setup();
      environment.midTurn = 'send';

      void sendPrompt(controller, 'first');
      void sendPrompt(controller, 'second');

      expect(sessions.sendPrompt.mock.calls.map(([, text]) => text)).toEqual(['first', 'second']);
      expect(environment.take()).toEqual([{ type: 'promptStart' }]);
    });

    it('ends the turn only once every prompt sent mid-turn has returned', async () => {
      const { sessions, environment, controller } = setup();
      environment.midTurn = 'send';
      void sendPrompt(controller, 'first');
      void sendPrompt(controller, 'second');
      environment.take();

      sessions.answer({ stopReason: 'cancelled' });
      await settle();
      expect(environment.take()).toEqual([]);

      sessions.answer({ stopReason: 'end_turn' });
      await settle();
      expect(environment.take()).toEqual([{ type: 'promptEnd', stopReason: 'end_turn' }]);
    });

    it('drops queued prompts when the chat is cleared', async () => {
      const { sessions, environment, controller } = setup();
      const first = sendPrompt(controller, 'first');
      await sendPrompt(controller, 'second');

      controller.clearChat();
      expect(controller.hasChatContent).toBe(false);
      sessions.answer();
      await first;

      expect(sessions.sendPrompt).toHaveBeenCalledTimes(1);
      expect(environment.take()).toContainEqual({ type: 'clearChat' });
    });
  });

  describe('session controls', () => {
    it('cancels the active turn', async () => {
      const { sessions, controller } = setup();

      await controller.handleMessage({ type: 'cancelTurn' });

      expect(sessions.cancelTurn).toHaveBeenCalledExactlyOnceWith('s1');
    });

    it('ignores cancel when no session is active and keeps quiet when cancel fails', async () => {
      const { sessions, environment, controller } = setup();
      sessions.activeId = null;
      await controller.handleMessage({ type: 'cancelTurn' });
      expect(sessions.cancelTurn).not.toHaveBeenCalled();

      sessions.activeId = 's1';
      sessions.cancelTurn.mockRejectedValueOnce(new Error('gone'));
      await controller.handleMessage({ type: 'cancelTurn' });
      expect(environment.take()).toEqual([]);
    });

    it('sets the mode and reports a failure', async () => {
      const { sessions, environment, controller } = setup();

      await controller.handleMessage({ type: 'setMode', modeId: 'code' });
      expect(sessions.setMode).toHaveBeenCalledExactlyOnceWith('s1', 'code');

      sessions.setMode.mockRejectedValueOnce(new Error('unknown mode'));
      await controller.handleMessage({ type: 'setMode', modeId: 'nope' });
      expect(environment.take()).toEqual([{ type: 'error', message: 'Failed to set mode: unknown mode' }]);
    });

    it('re-sends every config option the agent returns', async () => {
      const { sessions, environment, controller } = setup();
      const returned: SessionConfigOption[] = [{ ...modelOption, currentValue: 'b' }];
      sessions.setConfigOption.mockResolvedValueOnce(returned);

      await controller.handleMessage({ type: 'setConfigOption', configId: 'model', value: 'b' });

      expect(sessions.setConfigOption).toHaveBeenCalledExactlyOnceWith('s1', 'model', 'b');
      expect(environment.take()).toEqual([{ type: 'configOptionsUpdate', configOptions: returned }]);
    });

    it("rolls the picker back to the session's options when setting one fails", async () => {
      const { sessions, environment, controller } = setup();
      sessions.setConfigOption.mockRejectedValueOnce(new Error('rejected'));

      await controller.handleMessage({ type: 'setConfigOption', configId: 'model', value: 'b' });

      expect(environment.take()).toEqual([
        { type: 'error', message: 'Failed to set model: rejected' },
        { type: 'configOptionsUpdate', configOptions: [modelOption] },
      ]);
    });

    it('runs slash-menu commands in the editor, ignoring empty ones', async () => {
      const { environment, controller } = setup();

      await controller.handleMessage({ type: 'executeCommand', command: 'acp.newSession' });
      await controller.handleMessage({ type: 'executeCommand', command: '' });

      expect(environment.executeCommand).toHaveBeenCalledExactlyOnceWith('acp.newSession');
    });
  });

  it('renders agent messages as markdown for the webview', async () => {
    const { environment, controller } = setup();

    await controller.handleMessage({ type: 'renderMarkdown', items: [{ index: 3, text: '**bold**' }] });

    expect(environment.take()).toEqual([
      { type: 'markdownRendered', items: [{ index: 3, html: '<p><strong>bold</strong></p>\n' }] },
    ]);
  });

  describe('session updates', () => {
    const chunk = (sessionId: string): SessionNotification => ({
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
    });

    it('forwards updates for the active session only', () => {
      const { environment, controller } = setup();

      controller.handleSessionUpdate(chunk('s1'));
      controller.handleSessionUpdate(chunk('other'));

      expect(environment.take()).toEqual([{ type: 'sessionUpdate', sessionId: 's1', update: chunk('s1').update }]);
    });

    it('applies commands, config options and session info even before the session is active', () => {
      const { sessions, environment, controller } = setup();
      sessions.activeId = null;
      const commands = [{ name: 'init', description: 'Init' }];

      controller.handleSessionUpdate({ sessionId: 's2', update: { sessionUpdate: 'available_commands_update', availableCommands: commands } });
      controller.handleSessionUpdate({ sessionId: 's2', update: { sessionUpdate: 'config_option_update', configOptions: [modelOption] } });
      controller.handleSessionUpdate({ sessionId: 's2', update: { sessionUpdate: 'session_info_update', title: 'Title' } });

      expect(sessions.applyAvailableCommands).toHaveBeenCalledExactlyOnceWith('s2', commands);
      expect(sessions.applyConfigOptions).toHaveBeenCalledExactlyOnceWith('s2', [modelOption]);
      expect(sessions.applySessionInfoUpdate).toHaveBeenCalledExactlyOnceWith('s2', expect.objectContaining({ title: 'Title' }));
      expect(environment.take()).toEqual([]);
    });

    it('treats null config options from the agent as none', () => {
      const { sessions, controller } = setup();
      const update = { sessionUpdate: 'config_option_update', configOptions: null } as unknown as SessionNotification['update'];

      controller.handleSessionUpdate({ sessionId: 's1', update });

      expect(sessions.applyConfigOptions).toHaveBeenCalledExactlyOnceWith('s1', []);
    });
  });
});
