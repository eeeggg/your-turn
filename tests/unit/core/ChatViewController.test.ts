import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentBlock, PromptResponse, SessionConfigOption, SessionModeState, SessionNotification, SessionUpdate } from '@agentclientprotocol/sdk';
import { ChatViewController, type ChatSessions, type ChatViewEnvironment } from '@/core/ChatViewController';
import type { SessionInfo } from '@/core/SessionManager';
import type { ExtensionToWebviewMessage, Picker } from '@/shared/WebviewMessages';

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

const modelOption: SessionConfigOption = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'a',
  options: [{ value: 'a', name: 'Model A' }, { value: 'b', name: 'Model B', description: 'The big one' }],
};

/** {@link modelOption} as the webview gets it. */
const modelPicker: Picker = {
  id: 'model',
  category: 'model',
  name: 'Model',
  description: null,
  current: 'a',
  groups: [{ header: null, values: [{ id: 'a', name: 'Model A', description: null }, { id: 'b', name: 'Model B', description: 'The big one' }] }],
};

const modes: SessionModeState = {
  currentModeId: 'ask',
  availableModes: [{ id: 'ask', name: 'Ask', description: 'Asks first' }, { id: 'code', name: 'Code' }],
};

/** {@link modes} as the webview gets it. */
const modePicker: Picker = {
  id: 'mode',
  category: 'mode',
  name: 'Mode',
  description: null,
  current: 'ask',
  groups: [{ header: null, values: [{ id: 'ask', name: 'Ask', description: 'Asks first' }, { id: 'code', name: 'Code', description: null }] }],
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
  applyConfigOptions = vi.fn<ChatSessions['applyConfigOptions']>((sessionId, options) => {
    if (this.session?.sessionId === sessionId) {
      this.session.configOptions = options;
    }
  });
  applyCurrentMode = vi.fn<ChatSessions['applyCurrentMode']>((sessionId, modeId) => {
    if (this.session?.sessionId === sessionId && this.session.modes) {
      this.session.modes.currentModeId = modeId;
    }
  });
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

  post(message: ExtensionToWebviewMessage): void {
    this.posted.push(message);
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

const toolCall = (sessionId: string): SessionNotification => ({
  sessionId,
  update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read' },
});

describe('ChatViewController', () => {
  describe('session state', () => {
    it('describes the active session when the webview is ready', async () => {
      const { sessions, environment, controller } = setup();
      sessions.session = sessionInfo({
        title: 'Fix the build',
        availableCommands: [{ name: 'init', description: 'Init' }, { name: 'review', description: 'Review', input: { hint: 'what to review' } }],
      });

      await controller.handleMessage({ type: 'ready' });

      expect(environment.take()).toEqual([{
        type: 'state',
        activeSessionId: 's1',
        session: {
          sessionId: 's1',
          agentName: 'Fake Agent',
          title: 'Fix the build',
          cwd: '/work/project',
          pickers: [modelPicker],
          commands: [
            { name: 'init', description: 'Init', takesInput: false, hint: null },
            { name: 'review', description: 'Review', takesInput: true, hint: 'what to review' },
          ],
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

    it('passes on replays and changes to the pickers', () => {
      const { environment, controller } = setup();

      controller.notifyLoadSessionStart();
      controller.notifyLoadSessionEnd(false);
      controller.notifyPickersChanged();

      expect(environment.take()).toEqual([
        { type: 'loadSessionStart' },
        { type: 'loadSessionEnd', ok: false },
        { type: 'pickers', pickers: [modelPicker] },
      ]);
    });

    it('says nothing about pickers when no session is active', () => {
      const { sessions, environment, controller } = setup();
      sessions.activeId = null;

      controller.notifyPickersChanged();

      expect(environment.take()).toEqual([]);
    });
  });

  describe('pickers', () => {
    function pickers(session: SessionInfo): Picker[] {
      const { sessions, environment, controller } = setup();
      sessions.session = session;
      controller.notifyPickersChanged();
      const [message] = environment.take();
      return message?.type === 'pickers' ? message.pickers : [];
    }

    it('shows the modes as a picker for a session without config options', () => {
      expect(pickers(sessionInfo({ configOptions: null, modes: structuredClone(modes) }))).toEqual([modePicker]);
      expect(pickers(sessionInfo({ configOptions: [], modes: structuredClone(modes) }))).toEqual([modePicker]);
    });

    it('shows only the config options when the session has both, as they replace modes', () => {
      expect(pickers(sessionInfo({ configOptions: [modelOption], modes: structuredClone(modes) }))).toEqual([modelPicker]);
    });

    it('shows no picker for modes without any, or for config options other than selects with values', () => {
      expect(pickers(sessionInfo({ configOptions: null, modes: { currentModeId: 'ask', availableModes: [] } }))).toEqual([]);
      const unpickable: SessionConfigOption[] = [
        { id: 'fast', name: 'Fast', type: 'boolean', currentValue: false },
        { id: 'empty', name: 'Empty', type: 'select', currentValue: '', options: [] },
      ];
      expect(pickers(sessionInfo({ configOptions: unpickable, modes: structuredClone(modes) }))).toEqual([]);
    });

    it('keeps the groups of grouped values, headed by their names', () => {
      const grouped: SessionConfigOption = {
        id: 'model',
        name: 'Model',
        type: 'select',
        currentValue: 'b',
        options: [
          { group: 'fast', name: 'Fast models', options: [{ value: 'a', name: 'A' }] },
          { group: 'slow', name: '', options: [{ value: 'b', name: 'B' }] },
        ],
      };

      expect(pickers(sessionInfo({ configOptions: [grouped] }))[0]?.groups).toEqual([
        { header: 'Fast models', values: [{ id: 'a', name: 'A', description: null }] },
        { header: 'slow', values: [{ id: 'b', name: 'B', description: null }] },
      ]);
    });

    it.each([
      ['mode', 'mode'],
      ['model', 'model'],
      ['thought_level', 'thought_level'],
      ['model_config', 'other'],
      [null, 'other'],
    ] as const)('gives a config option of category %s the category %s', (category, expected) => {
      const option: SessionConfigOption = { ...modelOption, category };
      expect(pickers(sessionInfo({ configOptions: [option] }))[0]?.category).toBe(expected);
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

    it('runs a turn and reports its end', async () => {
      const { sessions, environment, controller } = setup();

      const turn = sendPrompt(controller, 'hello');
      expect(sessions.sendPrompt).toHaveBeenCalledExactlyOnceWith('s1', 'hello');
      expect(sessions.recordFirstPrompt).toHaveBeenCalledExactlyOnceWith('s1', 'hello');
      expect(environment.take()).toEqual([{ type: 'promptStart' }]);
      expect(controller.hasTranscript).toBe(true);

      sessions.answer({ stopReason: 'end_turn' });
      await turn;

      expect(sessions.touchHistory).toHaveBeenCalledExactlyOnceWith('s1');
      expect(environment.take()).toStrictEqual([{ type: 'promptEnd' }]);
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
        { type: 'promptEnd' },
      ]);
    });

    it('uses a generic message when the failure has none', async () => {
      const { sessions, environment, controller } = setup();

      const turn = sendPrompt(controller, 'hello');
      sessions.fail({});
      await turn;

      expect(environment.take()).toContainEqual({ type: 'error', message: 'Prompt failed' });
    });

    it('tells the editor a turn is in progress until it ends, also when it fails', async () => {
      const { sessions, environment, controller } = setup();
      const inProgress = (value: boolean) => ['setContext', 'acp.turnInProgress', value];

      const turn = sendPrompt(controller, 'hello');
      expect(environment.executeCommand.mock.calls).toEqual([inProgress(true)]);
      sessions.answer();
      await turn;
      expect(environment.executeCommand.mock.calls).toEqual([inProgress(true), inProgress(false)]);

      const failing = sendPrompt(controller, 'again');
      sessions.fail(new Error('agent crashed'));
      await failing;
      expect(environment.executeCommand.mock.calls).toEqual([inProgress(true), inProgress(false), inProgress(true), inProgress(false)]);
    });

    it('tells a chat view that opens during a turn that the turn is running, so it holds the next prompt', async () => {
      const { sessions, environment, controller } = setup();
      const turn = sendPrompt(controller, 'hello');
      environment.take();

      await controller.handleMessage({ type: 'ready' });
      expect(environment.take().map((message) => message.type)).toEqual(['state', 'promptStart']);

      sessions.answer();
      await turn;
      environment.take();
      await controller.handleMessage({ type: 'ready' });
      expect(environment.take().map((message) => message.type)).toEqual(['state']);
    });

    describe('in a session the chat view no longer shows', () => {
      function switchTo(sessions: FakeSessions, controller: ChatViewController, sessionId: string): void {
        sessions.activeId = sessionId;
        controller.notifyActiveSessionChanged();
      }

      it('does not tell the chat view when the turn ends or fails, so it cannot end a turn of the session shown now', async () => {
        const outcomes: [string, (sessions: FakeSessions) => void][] = [
          ['ends', (sessions) => sessions.answer()],
          ['fails', (sessions) => sessions.fail(new Error('agent crashed'))],
        ];
        for (const [name, outcome] of outcomes) {
          const { sessions, environment, controller } = setup();
          const turn = sendPrompt(controller, 'hello');
          switchTo(sessions, controller, 's2');
          environment.take();

          outcome(sessions);
          await turn;

          expect(environment.take(), name).toEqual([]);
        }
      });

      it('takes the Cancel button off the title bar while another session is shown, and puts it back on return', async () => {
        const { sessions, environment, controller } = setup();
        void sendPrompt(controller, 'hello');
        environment.executeCommand.mockClear();

        switchTo(sessions, controller, 's2');
        switchTo(sessions, controller, 's1');

        expect(environment.executeCommand.mock.calls).toEqual([
          ['setContext', 'acp.turnInProgress', false],
          ['setContext', 'acp.turnInProgress', true],
        ]);
      });

      it('tells the chat view the turn is still running when it shows that session again', () => {
        const { sessions, environment, controller } = setup();
        void sendPrompt(controller, 'hello');
        switchTo(sessions, controller, 's2');
        expect(environment.take().map((message) => message.type)).toEqual(['promptStart', 'state']);

        switchTo(sessions, controller, 's1');

        expect(environment.take().map((message) => message.type)).toEqual(['state', 'promptStart']);
      });
    });

    it('does not tell the chat view again that a turn is running when the same session is reported again', async () => {
      const { environment, controller } = setup();
      await controller.handleMessage({ type: 'ready' });
      void sendPrompt(controller, 'hello');
      environment.take();

      controller.notifyActiveSessionChanged();

      expect(environment.take().map((message) => message.type)).toEqual(['state']);
    });

    describe('when the agent of a session exits', () => {
      it('tells the chat view why its session ended, which ends the turn', async () => {
        const { environment, controller } = setup();
        await controller.handleMessage({ type: 'ready' });
        void sendPrompt(controller, 'hello');
        environment.take();

        controller.notifySessionEnded('s1', 'Fake Agent exited unexpectedly (code 1).');

        expect(environment.take()).toEqual([{ type: 'sessionEnded', message: 'Fake Agent exited unexpectedly (code 1).' }]);
      });

      it('says nothing more when the turn then fails, the session being gone', async () => {
        const { sessions, environment, controller } = setup();
        await controller.handleMessage({ type: 'ready' });
        const turn = sendPrompt(controller, 'hello');
        controller.notifySessionEnded('s1', 'Fake Agent exited unexpectedly (code 1).');
        sessions.activeId = null;
        controller.notifyActiveSessionChanged();
        environment.take();

        sessions.fail(new Error('ACP connection closed'));
        await turn;

        expect(environment.take()).toEqual([]);
      });

      it('forgets the turn, so the chat view is not told it is running when it opens again', async () => {
        const { environment, controller } = setup();
        await controller.handleMessage({ type: 'ready' });
        void sendPrompt(controller, 'hello');

        controller.notifySessionEnded('s1', 'Fake Agent exited unexpectedly (code 1).');
        environment.take();
        await controller.handleMessage({ type: 'ready' });

        expect(environment.take().map((message) => message.type)).toEqual(['state']);
      });

      it('does not tell the chat view about a session it does not show', async () => {
        const { environment, controller } = setup();
        await controller.handleMessage({ type: 'ready' });
        environment.take();

        controller.notifySessionEnded('s2', 'Other exited unexpectedly (code 1).');

        expect(environment.take()).toEqual([]);
      });
    });

    it('forgets that a prompt was sent when the transcript is cleared', () => {
      const { environment, controller } = setup();
      void sendPrompt(controller, 'hello');

      controller.clearTranscript();

      expect(controller.hasTranscript).toBe(false);
      expect(environment.take()).toContainEqual({ type: 'clearTranscript' });
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

    it("sets the mode when the session's picker stands for its modes, leaving the pickers to the session's report", async () => {
      const { sessions, environment, controller } = setup();
      sessions.session = sessionInfo({ configOptions: null, modes: structuredClone(modes) });

      await controller.handleMessage({ type: 'pickerValueChosen', pickerId: 'mode', value: 'code' });

      expect(sessions.setMode).toHaveBeenCalledExactlyOnceWith('s1', 'code');
      expect(sessions.setConfigOption).not.toHaveBeenCalled();
      expect(environment.take()).toEqual([]);
    });

    it('reports a mode that cannot be set, and rolls the picker back', async () => {
      const { sessions, environment, controller } = setup();
      sessions.session = sessionInfo({ configOptions: null, modes: structuredClone(modes) });
      sessions.setMode.mockRejectedValueOnce(new Error('unknown mode'));

      await controller.handleMessage({ type: 'pickerValueChosen', pickerId: 'mode', value: 'nope' });

      expect(environment.take()).toEqual([
        { type: 'error', message: 'Failed to set mode: unknown mode' },
        { type: 'pickers', pickers: [modePicker] },
      ]);
    });

    it('sets a config option, then re-sends the pickers from every option the agent returns', async () => {
      const { sessions, environment, controller } = setup();
      sessions.setConfigOption.mockImplementationOnce(async (sessionId, _configId, _value) => {
        const returned: SessionConfigOption[] = [{ ...modelOption, currentValue: 'b' }];
        sessions.applyConfigOptions(sessionId, returned);
        return returned;
      });

      await controller.handleMessage({ type: 'pickerValueChosen', pickerId: 'model', value: 'b' });

      expect(sessions.setConfigOption).toHaveBeenCalledExactlyOnceWith('s1', 'model', 'b');
      expect(sessions.setMode).not.toHaveBeenCalled();
      expect(environment.take()).toEqual([{ type: 'pickers', pickers: [{ ...modelPicker, current: 'b' }] }]);
    });

    it("rolls the picker back to the session's options when setting one fails", async () => {
      const { sessions, environment, controller } = setup();
      sessions.setConfigOption.mockRejectedValueOnce(new Error('rejected'));

      await controller.handleMessage({ type: 'pickerValueChosen', pickerId: 'model', value: 'b' });

      expect(environment.take()).toEqual([
        { type: 'error', message: 'Failed to set model: rejected' },
        { type: 'pickers', pickers: [modelPicker] },
      ]);
    });

    it('ignores a choice when no session is active', async () => {
      const { sessions, environment, controller } = setup();
      sessions.activeId = null;

      await controller.handleMessage({ type: 'pickerValueChosen', pickerId: 'model', value: 'b' });

      expect(sessions.setConfigOption).not.toHaveBeenCalled();
      expect(environment.take()).toEqual([]);
    });
  });

  describe('session updates', () => {
    function translated(update: SessionUpdate, session: SessionInfo = sessionInfo()): ExtensionToWebviewMessage[] {
      const { sessions, environment, controller } = setup();
      sessions.session = session;
      vi.useFakeTimers();
      try {
        controller.handleSessionUpdate({ sessionId: 's1', update });
        vi.advanceTimersByTime(16);
      } finally {
        vi.useRealTimers();
      }
      return environment.take().filter((message) => message.type !== 'sessionInfoUpdate');
    }

    it('tells the webview about updates to the active session only', () => {
      const { environment, controller } = setup();

      controller.handleSessionUpdate(toolCall('s1'));
      controller.handleSessionUpdate(toolCall('other'));

      expect(environment.take()).toEqual([{ type: 'toolCall', toolCallId: 't1', title: 'Read' }]);
    });

    it("passes on the agent's answer, thinking and replayed prompts as text, with their message IDs", () => {
      expect(translated({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'Hi' } })).toEqual([
        { type: 'agentText', messageId: 'm1', text: 'Hi' },
      ]);
      expect(translated({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Hm' } })).toEqual([
        { type: 'thoughtText', messageId: null, text: 'Hm' },
      ]);
      expect(translated({ sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'Fix it' } })).toEqual([
        { type: 'promptText', text: 'Fix it' },
      ]);
    });

    it('drops text meant for the model alone, content other than text, and empty answer text', () => {
      const forModel: ContentBlock = { type: 'text', text: 'file contents', annotations: { audience: ['assistant'] } };
      const image: ContentBlock = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
      for (const sessionUpdate of ['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk'] as const) {
        expect(translated({ sessionUpdate, content: forModel }), sessionUpdate).toEqual([]);
        expect(translated({ sessionUpdate, content: image }), sessionUpdate).toEqual([]);
      }
      expect(translated({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } })).toEqual([]);
      expect(translated({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'both', annotations: { audience: ['user', 'assistant'] } } })).toEqual([
        { type: 'agentText', messageId: null, text: 'both' },
      ]);
    });

    it('reports a new tool call and its updates alike, with its status, title and text output', () => {
      expect(translated({
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'Run tests',
        status: 'in_progress',
        content: [
          { type: 'content', content: { type: 'text', text: 'ok' } },
          { type: 'diff', path: '/work/a.ts', oldText: 'a', newText: 'b' },
          { type: 'terminal', terminalId: 'term-1' },
          { type: 'content', content: { type: 'text', text: '' } },
        ],
      })).toEqual([{ type: 'toolCall', toolCallId: 't1', title: 'Run tests', status: 'running', texts: ['ok'] }]);

      expect(translated({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' })).toEqual([
        { type: 'toolCall', toolCallId: 't1', status: 'completed' },
      ]);
      expect(translated({ sessionUpdate: 'tool_call_update', toolCallId: 't1', title: null, status: 'failed', content: [] })).toEqual([
        { type: 'toolCall', toolCallId: 't1', status: 'failed', texts: [] },
      ]);
      expect(translated({ sessionUpdate: 'tool_call_update', toolCallId: 't1', title: '', status: null, content: null })).toEqual([
        { type: 'toolCall', toolCallId: 't1' },
      ]);
      expect(translated({ sessionUpdate: 'tool_call', toolCallId: 't2', title: '', status: 'pending' })).toEqual([
        { type: 'toolCall', toolCallId: 't2', status: 'pending' },
      ]);
    });

    it('reports the plan as steps', () => {
      expect(translated({
        sessionUpdate: 'plan',
        entries: [
          { content: 'Read', priority: 'high', status: 'completed' },
          { content: 'Edit', priority: 'medium', status: 'in_progress' },
          { content: 'Test', priority: 'low', status: 'pending' },
        ],
      })).toEqual([{
        type: 'plan',
        steps: [{ text: 'Read', status: 'completed' }, { text: 'Edit', status: 'running' }, { text: 'Test', status: 'pending' }],
      }]);
    });

    it('reports slash commands, and pickers from the session once it has applied the change', () => {
      expect(translated({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'init', description: 'Init' }] })).toEqual([
        { type: 'commands', commands: [{ name: 'init', description: 'Init', takesInput: false, hint: null }] },
      ]);
      expect(translated({ sessionUpdate: 'config_option_update', configOptions: [{ ...modelOption, currentValue: 'b' }] })).toEqual([
        { type: 'pickers', pickers: [{ ...modelPicker, current: 'b' }] },
      ]);
      expect(translated({ sessionUpdate: 'current_mode_update', currentModeId: 'code' }, sessionInfo({ configOptions: null, modes: structuredClone(modes) }))).toEqual([
        { type: 'pickers', pickers: [{ ...modePicker, current: 'code' }] },
      ]);
    });

    it('drops the updates the chat view has no place for', () => {
      const unshown: SessionUpdate[] = [
        { sessionUpdate: 'usage_update', used: 1000, size: 200000 },
        { sessionUpdate: 'session_info_update', updatedAt: '2026-10-20T00:00:00Z' },
      ];
      for (const update of unshown) {
        expect(translated(update), update.sessionUpdate).toEqual([]);
      }
    });

    it('applies commands, config options, the mode and session info even before the session is active', () => {
      const { sessions, environment, controller } = setup();
      sessions.activeId = null;
      const commands = [{ name: 'init', description: 'Init' }];

      controller.handleSessionUpdate({ sessionId: 's2', update: { sessionUpdate: 'available_commands_update', availableCommands: commands } });
      controller.handleSessionUpdate({ sessionId: 's2', update: { sessionUpdate: 'config_option_update', configOptions: [modelOption] } });
      controller.handleSessionUpdate({ sessionId: 's2', update: { sessionUpdate: 'current_mode_update', currentModeId: 'code' } });
      controller.handleSessionUpdate({ sessionId: 's2', update: { sessionUpdate: 'session_info_update', title: 'Title' } });

      expect(sessions.applyAvailableCommands).toHaveBeenCalledExactlyOnceWith('s2', commands);
      expect(sessions.applyConfigOptions).toHaveBeenCalledExactlyOnceWith('s2', [modelOption]);
      expect(sessions.applyCurrentMode).toHaveBeenCalledExactlyOnceWith('s2', 'code');
      expect(sessions.applySessionInfoUpdate).toHaveBeenCalledExactlyOnceWith('s2', expect.objectContaining({ title: 'Title' }));
      expect(environment.take()).toEqual([]);
    });
  });

  describe('text chunks', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    type ChunkKind = 'agent_message_chunk' | 'agent_thought_chunk' | 'user_message_chunk';
    const chunk = (sessionUpdate: ChunkKind, text: string, fields: { messageId?: string; _meta?: Record<string, unknown> } = {}): SessionNotification => ({
      sessionId: 's1',
      update: { sessionUpdate, content: { type: 'text', text }, ...fields },
    });
    const answer = (text: string, messageId: string | null = null): ExtensionToWebviewMessage => ({ type: 'agentText', messageId, text });

    it('joins the text of a frame into one message', () => {
      const { environment, controller } = setup();

      for (const text of ['Hel', 'lo', ' world']) {
        controller.handleSessionUpdate(chunk('agent_message_chunk', text));
      }
      vi.advanceTimersByTime(15);
      expect(environment.take()).toEqual([]);

      vi.advanceTimersByTime(1);
      expect(environment.take()).toEqual([answer('Hello world')]);

      controller.handleSessionUpdate(chunk('agent_message_chunk', '!'));
      vi.advanceTimersByTime(16);
      expect(environment.take()).toEqual([answer('!')]);
    });

    it('sends the text before anything that follows it, without waiting', async () => {
      const { sessions, environment, controller } = setup();
      const turn = sendPrompt(controller, 'hello');
      environment.take();

      controller.handleSessionUpdate(chunk('agent_message_chunk', 'reading'));
      controller.handleSessionUpdate(toolCall('s1'));
      controller.handleSessionUpdate(chunk('agent_message_chunk', 'done'));
      sessions.answer();
      await turn;

      expect(environment.take()).toEqual([
        answer('reading'),
        { type: 'toolCall', toolCallId: 't1', title: 'Read' },
        answer('done'),
        { type: 'promptEnd' },
      ]);
      vi.advanceTimersByTime(16);
      expect(environment.take()).toEqual([]);
    });

    it('keeps text of different kinds or messages apart', () => {
      const { environment, controller } = setup();

      controller.handleSessionUpdate(chunk('user_message_chunk', 'q'));
      controller.handleSessionUpdate(chunk('agent_thought_chunk', 'hm'));
      controller.handleSessionUpdate(chunk('agent_thought_chunk', 'm'));
      controller.handleSessionUpdate(chunk('agent_message_chunk', 'a', { messageId: 'm1' }));
      controller.handleSessionUpdate(chunk('agent_message_chunk', 'b', { messageId: 'm2' }));
      vi.advanceTimersByTime(16);

      expect(environment.take()).toEqual([
        { type: 'promptText', text: 'q' },
        { type: 'thoughtText', messageId: null, text: 'hmm' },
        answer('a', 'm1'),
        answer('b', 'm2'),
      ]);
    });

    it('joins the text around a chunk meant for the model alone, which is dropped, and chunks with metadata', () => {
      const { environment, controller } = setup();
      const forModel: SessionNotification = {
        sessionId: 's1',
        update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'file', annotations: { audience: ['assistant'] } } },
      };

      controller.handleSessionUpdate(chunk('user_message_chunk', 'q'));
      controller.handleSessionUpdate(forModel);
      controller.handleSessionUpdate(chunk('user_message_chunk', ' more', { _meta: { source: 'agent' } }));
      controller.handleSessionUpdate(chunk('user_message_chunk', ' again'));
      vi.advanceTimersByTime(16);

      expect(environment.take()).toEqual([{ type: 'promptText', text: 'q more again' }]);
    });

    it('shows only what the user typed when the agent replays an attached file read into the prompt', () => {
      const { environment, controller } = setup();
      const forModel = (text: string): SessionNotification => ({
        sessionId: 's1',
        update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text, annotations: { audience: ['assistant'] } } },
      });

      for (const prompt of ['q1', 'q2']) {
        controller.handleSessionUpdate(chunk('user_message_chunk', prompt));
        controller.handleSessionUpdate(forModel('Called the Read tool with the following input: {"filePath":"/work/a.ts"}'));
        controller.handleSessionUpdate(forModel('export const a = 1;'));
        controller.handleSessionUpdate({
          sessionId: 's1',
          update: { sessionUpdate: 'user_message_chunk', content: { type: 'resource_link', uri: 'file:///work/a.ts', name: 'a.ts' } },
        });
        controller.handleSessionUpdate(chunk('agent_message_chunk', `answer to ${prompt}`));
      }
      vi.advanceTimersByTime(16);

      expect(environment.take()).toEqual([
        { type: 'promptText', text: 'q1' },
        answer('answer to q1'),
        { type: 'promptText', text: 'q2' },
        answer('answer to q2'),
      ]);
    });
  });
});
