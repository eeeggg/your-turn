import { describe, expect, it, onTestFinished } from 'vitest';
import { ChatViewController } from '@/core/ChatViewController';
import { initialState, update } from '@/webview/state/RootState';
import {
  SESSION_ID,
  OTHER_SESSION_ID,
  setup,
  sendPrompt,
  type FakeSessions,
} from '@tests/unit/core/ChatViewControllerTestSupport';

describe('ChatViewController', () => {
  it('keeps the next submission active when autonomous idle releases the queue synchronously', async () => {
    const { controller, sessions, environment } = setup();
    controller.handleSessionUpdate(SESSION_ID, { kind: 'foreground', state: 'running' });
    let next: Promise<void> | undefined;
    const post = environment.post.bind(environment);
    environment.post = (message) => {
      post(message);
      if (message.type === 'foregroundActivity' && !message.running) { next = sendPrompt(controller, sessions, 'next'); }
    };
    controller.handleSessionUpdate(SESSION_ID, { kind: 'foreground', state: 'idle' });
    environment.post = post;
    expect(controller.hasRunningTurn).toBe(true);
    expect(environment.executeCommand).toHaveBeenLastCalledWith('setContext', 'your-turn.turnInProgress', true);
    sessions.answer();
    await next;
  });

  it('does not clear work submitted synchronously when an idle notification releases the queue', async () => {
    const { controller, sessions, environment } = setup();
    const first = sendPrompt(controller, sessions, 'first');
    let next: Promise<void> | undefined;
    const post = environment.post.bind(environment);
    environment.post = (message) => {
      post(message);
      if (message.type === 'promptEnd') { next = sendPrompt(controller, sessions, 'next'); }
    };
    sessions.answer();
    await first;
    environment.post = post;
    expect(controller.hasRunningTurn).toBe(true);
    expect(environment.executeCommand).toHaveBeenLastCalledWith('setContext', 'your-turn.turnInProgress', true);
    sessions.answer();
    await next;
  });

  it.each(['resolve', 'reject'] as const)('does not end older outstanding work when a newer submission settles by %s', async (settle) => {
    const { controller, sessions, environment } = setup();
    const first = sendPrompt(controller, sessions, 'first');
    const second = sendPrompt(controller, sessions, 'steer');
    environment.take();
    const newer = sessions.prompts.pop();
    if (!newer) { throw new Error('missing steering submission'); }
    if (settle === 'resolve') { newer.reply.resolve(undefined); }
    else { newer.reply.reject(new Error('refused')); }
    await second;
    expect(controller.hasRunningTurn).toBe(true);
    expect(environment.take().filter((message) => message.type === 'promptEnd')).toEqual([]);
    sessions.answer();
    await first;
    expect(controller.hasRunningTurn).toBe(false);
    expect(environment.take()).toEqual([{ type: 'promptEnd' }]);
  });

  describe('turns', () => {
    it('restores foreground state and review context when a controller is recreated during autonomous work', async () => {
      const { sessions, controller, environment, editor, terminals } = setup();
      controller.handleSessionUpdate(SESSION_ID, { kind: 'foreground', state: 'requiresAction' });
      await controller.dispose();
      environment.take();
      environment.executeCommand.mockClear();
      const replacement = new ChatViewController(sessions, environment, editor, terminals);
      onTestFinished(() => replacement.dispose());
      await replacement.handleMessage({ type: 'ready' });
      expect(replacement.hasRunningTurn).toBe(true);
      const messages = environment.take();
      const first = messages[0];
      if (!first) { throw new Error('Missing session state'); }
      const opened = update(initialState, first, 0).state;
      const streaming = update(opened, { type: 'agentText', messageId: 'autonomous', text: 'Working' }, 1).state;
      const state = messages.reduce((state, message) => update(state, message, 2).state, streaming);
      expect(state.activeSession?.turnRunning).toBe(true);
      expect(state.transcript.currentTurn).toBe(streaming.transcript.currentTurn);
      expect(state.transcript.entries).toEqual(streaming.transcript.entries);
      expect(messages.map((message) => message.type)).toEqual(['state', 'sessionTabs', 'foregroundActivity']);
      expect(environment.executeCommand.mock.calls).toEqual([['setContext', 'your-turn.turnInProgress', true]]);
    });

    it.each(['answer', 'fail'] as const)('does not end newer autonomous work when an older prompt settles via %s', async (outcome) => {
      const { sessions, controller, environment } = setup();
      const turn = sendPrompt(controller, sessions, 'go');
      controller.handleSessionUpdate(SESSION_ID, { kind: 'foreground', state: 'running' });
      controller.handleSessionUpdate(SESSION_ID, { kind: 'foreground', state: 'idle' });
      controller.handleSessionUpdate(SESSION_ID, { kind: 'foreground', state: 'running' });
      environment.take();
      if (outcome === 'answer') { sessions.answer(); } else { sessions.fail(new Error('Rejected')); }
      await turn;
      expect(controller.hasRunningTurn).toBe(true);
      expect(environment.take()).toEqual(outcome === 'answer' ? [] : [{ type: 'error', message: 'Rejected' }]);
    });

    it('holds queued prompts until prompt acceptance settles and does not release twice for repeated idle', async () => {
      const { sessions, controller, environment } = setup();
      const turn = sendPrompt(controller, sessions, 'go');
      controller.handleSessionUpdate(SESSION_ID, { kind: 'foreground', state: 'running' });
      environment.take();
      controller.handleSessionUpdate(SESSION_ID, { kind: 'foreground', state: 'idle' });
      controller.handleSessionUpdate(SESSION_ID, { kind: 'foreground', state: 'idle' });
      expect(environment.take()).toEqual([]);
      expect(controller.hasRunningTurn).toBe(true);
      sessions.answer();
      await turn;
      expect(environment.take()).toEqual([{ type: 'promptEnd' }]);
    });

    it('keeps immediate submission feedback through an initial idle snapshot until foreground work starts', async () => {
      const { sessions, controller, environment } = setup();
      const turn = sendPrompt(controller, sessions, 'go');
      environment.take();
      controller.handleSessionUpdate(SESSION_ID, { kind: 'foreground', state: 'idle' });
      expect(controller.hasRunningTurn).toBe(true);
      expect(environment.take()).toEqual([]);
      sessions.fail(new Error('Rejected'));
      await turn;
      expect(controller.hasRunningTurn).toBe(false);
    });

    it('refuses a prompt when no session is active', async () => {
      const { sessions, environment, controller } = setup();
      sessions.activeId = null;

      await sendPrompt(controller, sessions, 'hello');

      expect(sessions.sendPrompt).not.toHaveBeenCalled();
      expect(environment.take()).toEqual([{ type: 'error', message: 'No active session. Create a session first.' }]);
    });

    it('runs a turn and reports its end', async () => {
      const { sessions, environment, controller } = setup();

      const turn = sendPrompt(controller, sessions, 'hello');
      expect(sessions.sendPrompt).toHaveBeenCalledExactlyOnceWith(SESSION_ID, 'hello');
      expect(environment.take()).toEqual([{ type: 'promptStart' }]);
      expect(controller.hasRunningTurn).toBe(true);

      sessions.answer();
      await turn;

      expect(sessions.recordTurnEnded).toHaveBeenCalledExactlyOnceWith(SESSION_ID);
      expect(environment.take()).toStrictEqual([{ type: 'promptEnd' }]);
      expect(controller.hasRunningTurn).toBe(false);
    });

    it('reports a failed prompt as an error that ends the turn', async () => {
      const { sessions, environment, controller } = setup();

      const turn = sendPrompt(controller, sessions, 'hello');
      sessions.fail(new Error('agent crashed'));
      await turn;

      expect(controller.hasRunningTurn).toBe(false);
      expect(sessions.recordTurnEnded).not.toHaveBeenCalled();
      expect(environment.take()).toEqual([
        { type: 'promptStart' },
        { type: 'error', message: 'agent crashed' },
        { type: 'promptEnd' },
      ]);
    });

    it('uses a generic message when the failure has none', async () => {
      const { sessions, environment, controller } = setup();

      const turn = sendPrompt(controller, sessions, 'hello');
      sessions.fail({});
      await turn;

      expect(environment.take()).toContainEqual({ type: 'error', message: 'Prompt failed' });
    });

    it('tells the editor a turn is in progress until it ends, also when it fails', async () => {
      const { sessions, environment, controller } = setup();
      const inProgress = (value: boolean) => ['setContext', 'your-turn.turnInProgress', value];

      const turn = sendPrompt(controller, sessions, 'hello');
      expect(environment.executeCommand.mock.calls).toEqual([inProgress(true)]);
      sessions.answer();
      await turn;
      expect(environment.executeCommand.mock.calls).toEqual([inProgress(true), inProgress(false)]);

      const failing = sendPrompt(controller, sessions, 'again');
      sessions.fail(new Error('agent crashed'));
      await failing;
      expect(environment.executeCommand.mock.calls).toEqual([inProgress(true), inProgress(false), inProgress(true), inProgress(false)]);
    });

    it('tells its turn listeners each time it tells the editor, for the review to pause', async () => {
      const { sessions, controller } = setup();
      const heard: boolean[] = [];
      controller.addTurnListener((inProgress) => heard.push(inProgress));

      const turn = sendPrompt(controller, sessions, 'hello');
      sessions.answer();
      await turn;
      expect(heard).toEqual([true, false]);
    });

    it('tells a chat view that opens during a turn that the turn is running, so it holds the next prompt', async () => {
      const { sessions, environment, controller } = setup();
      const turn = sendPrompt(controller, sessions, 'hello');
      environment.take();

      await controller.handleMessage({ type: 'ready' });
      expect(environment.take().map((message) => message.type)).toEqual(['state', 'sessionTabs', 'foregroundActivity']);

      sessions.answer();
      await turn;
      environment.take();
      await controller.handleMessage({ type: 'ready' });
      expect(environment.take().map((message) => message.type)).toEqual(['state', 'sessionTabs']);
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
          const turn = sendPrompt(controller, sessions, 'hello');
          switchTo(sessions, controller, OTHER_SESSION_ID);
          environment.take();

          outcome(sessions);
          await turn;

          expect(environment.take(), name).toEqual([]);
        }
      });

      it('takes the Cancel button off the title bar while another session is shown, and puts it back on return', async () => {
        const { sessions, environment, controller } = setup();
        const turn = sendPrompt(controller, sessions, 'hello');
        environment.executeCommand.mockClear();

        switchTo(sessions, controller, OTHER_SESSION_ID);
        switchTo(sessions, controller, SESSION_ID);

        expect(environment.executeCommand.mock.calls).toEqual([
          ['setContext', 'your-turn.turnInProgress', false],
          ['setContext', 'your-turn.turnInProgress', true],
        ]);
        sessions.answer();
        await turn;
      });

      it('tells the chat view the turn is still running when it shows that session again', async () => {
        const { sessions, environment, controller } = setup();
        const turn = sendPrompt(controller, sessions, 'hello');
        switchTo(sessions, controller, OTHER_SESSION_ID);
        expect(environment.take().map((message) => message.type)).toEqual(['promptStart', 'state']);

        switchTo(sessions, controller, SESSION_ID);

        expect(environment.take().map((message) => message.type)).toEqual(['state', 'foregroundActivity']);
        sessions.answer();
        await turn;
      });

      it("says no turn is running while another session is active, and the left session's turn is again on return", async () => {
        const { sessions, controller } = setup();
        const turn = sendPrompt(controller, sessions, 'hello');

        switchTo(sessions, controller, OTHER_SESSION_ID);
        expect(controller.hasRunningTurn).toBe(false);
        switchTo(sessions, controller, SESSION_ID);
        expect(controller.hasRunningTurn).toBe(true);
        sessions.answer();
        await turn;
      });
    });

    it('does not tell the chat view again that a turn is running when the same session is reported again', async () => {
      const { sessions, environment, controller } = setup();
      await controller.handleMessage({ type: 'ready' });
      const turn = sendPrompt(controller, sessions, 'hello');
      environment.take();

      controller.notifyActiveSessionChanged();

      expect(environment.take().map((message) => message.type)).toEqual(['state']);
      sessions.answer();
      await turn;
    });

    describe('when the agent of a session exits', () => {
      it('tells the chat view why its session ended, which ends the turn', async () => {
        const { sessions, environment, controller } = setup();
        await controller.handleMessage({ type: 'ready' });
        const turn = sendPrompt(controller, sessions, 'hello');
        environment.take();

        controller.notifySessionEnded(SESSION_ID, 'Fake Agent exited unexpectedly (code 1).');

        expect(environment.take()).toEqual([{ type: 'sessionEnded', message: 'Fake Agent exited unexpectedly (code 1).' }]);
        sessions.fail(new Error('ACP connection closed'));
        await turn;
      });

      it('says nothing more when the turn then fails, the session being gone', async () => {
        const { sessions, environment, controller } = setup();
        await controller.handleMessage({ type: 'ready' });
        const turn = sendPrompt(controller, sessions, 'hello');
        controller.notifySessionEnded(SESSION_ID, 'Fake Agent exited unexpectedly (code 1).');
        sessions.activeId = null;
        controller.notifyActiveSessionChanged();
        environment.take();

        sessions.fail(new Error('ACP connection closed'));
        await turn;

        expect(environment.take()).toEqual([]);
      });

      it('forgets the turn, so the chat view is not told it is running when it opens again', async () => {
        const { sessions, environment, controller } = setup();
        await controller.handleMessage({ type: 'ready' });
        const turn = sendPrompt(controller, sessions, 'hello');

        controller.notifySessionEnded(SESSION_ID, 'Fake Agent exited unexpectedly (code 1).');
        environment.take();
        await controller.handleMessage({ type: 'ready' });

        expect(environment.take().map((message) => message.type)).toEqual(['state', 'sessionTabs']);
        expect(controller.hasRunningTurn).toBe(false);
        sessions.fail(new Error('ACP connection closed'));
        await turn;
      });

      it('does not tell the chat view about a session it does not show', async () => {
        const { environment, controller } = setup();
        await controller.handleMessage({ type: 'ready' });
        environment.take();

        controller.notifySessionEnded(OTHER_SESSION_ID, 'Other exited unexpectedly (code 1).');

        expect(environment.take()).toEqual([]);
      });
    });

    it('knows how many prompts the chat view holds, none once a chat view opens anew', async () => {
      const { controller } = setup();
      expect(controller.queuedPrompts).toBe(0);

      await controller.handleMessage({ type: 'queuedPrompts', count: 2 });
      expect(controller.queuedPrompts).toBe(2);

      await controller.handleMessage({ type: 'ready' });
      expect(controller.queuedPrompts).toBe(0);
    });

    it('tells the chat view to clear the transcript', () => {
      const { environment, controller } = setup();

      controller.clearTranscript();

      expect(environment.take()).toEqual([{ type: 'clearTranscript' }]);
    });
  });
});
