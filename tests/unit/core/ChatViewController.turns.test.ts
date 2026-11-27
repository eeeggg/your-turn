import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ChatViewController } from '@/core/ChatViewController';
import { contentApplied, initialState, update } from '@/webview/state/RootState';
import {
  SESSION_ID,
  OTHER_SESSION_ID,
  setup,
  sessionInfo,
  sendPrompt,
  issuedTarget,
  FakeEnvironment,
  type FakeSessions,
} from '@tests/unit/core/ChatViewControllerTestSupport';

describe('ChatViewController', () => {
  it('projects settlement through a replacement controller without effects from the disposed controller', async () => {
    const { controller, sessions, environment, editor } = setup();
    const turn = sendPrompt(controller, sessions, 'retained submission');
    await controller.dispose();
    const replacementEnvironment = new FakeEnvironment();
    const replacement = new ChatViewController(sessions, replacementEnvironment, editor);
    onTestFinished(() => replacement.dispose());
    await replacement.handleMessage({ type: 'ready' });
    replacementEnvironment.take();
    environment.executeCommand.mockClear();
    replacementEnvironment.executeCommand.mockClear();
    const retiredEffects: boolean[] = [];
    controller.addTurnListener((running) => retiredEffects.push(running));
    sessions.fail(new Error('Refused after recreation'));
    await turn;
    expect(replacementEnvironment.transcript().entries.at(-1)).toEqual({ kind: 'error', id: 2, text: 'Refused after recreation' });
    expect(replacementEnvironment.take()).toEqual([expect.objectContaining({ type: 'contentPatch' }), { type: 'promptEnd' }]);
    expect(replacementEnvironment.executeCommand.mock.calls).toEqual([['setContext', 'your-turn.turnInProgress', false]]);
    expect(environment.executeCommand.mock.calls).toEqual([]);
    expect(retiredEffects).toEqual([]);
  });

  function steer(controller: ChatViewController, sessions: FakeSessions, text: string): Promise<void> {
    void sendPrompt(controller, sessions, text);
    const registration = sessions.getActiveSession();
    if (!registration) { throw new Error('Missing registration'); }
    const identity = { configuredName: registration.agentName, sessionId: registration.sessionId };
    const state = sessions.sessionState(identity);
    const head = state?.queue[0];
    if (!head) { throw new Error('Missing steering head'); }
    sessions.changeQueuedPrompt(identity, state.generation, { kind: 'steer', id: head.id });
    const result = sessions.sendPrompt.mock.results.at(-1);
    if (result?.type !== 'return') { throw new Error('Missing steering submission'); }
    return result.value.catch(() => {});
  }

  it('rejects a prompt captured before page recreation without submitting or retaining it', async () => {
    const parts = setup();
    const target = await issuedTarget(parts);
    await parts.controller.handleMessage({ type: 'ready' });
    parts.environment.take();
    const request = { type: 'sendPrompt' as const, target, text: 'obsolete' };
    const turn = parts.controller.handleMessage(request);
    try {
      expect(parts.sessions.retained.view(target)?.content.entries).toEqual([]);
      expect(parts.environment.take()).toEqual([]);
    } finally {
      for (const prompt of parts.sessions.prompts.splice(0)) { prompt.reply.resolve(undefined); }
      await turn;
    }
  });

  it('accepts a prompt in flight during recovery of the same session', async () => {
    const parts = setup();
    const { controller, sessions, environment } = parts;
    const target = await issuedTarget(parts);
    const post = environment.post.bind(environment);
    environment.post = (message) => { if (message.type !== 'viewSnapshot') { post(message); } };
    controller.notifyActiveSessionChanged();
    await controller.handleMessage({ type: 'composerEdited', target, revision: 1, text: 'In flight' });
    const turn = controller.handleMessage({ type: 'sendPrompt', target, text: 'In flight' });
    try {
      expect(sessions.prompts.map(({ text }) => text)).toEqual(['In flight']);
      expect(sessions.sessionState(target)?.composer.text).toBe('In flight');
    } finally {
      for (const prompt of sessions.prompts.splice(0)) { prompt.reply.resolve(undefined); }
      await turn;
    }
  });

  it('stops retrying when a duplicate patch recovers a lost acknowledgment', async () => {
    const parts = setup();
    const { controller, environment } = parts;
    await issuedTarget(parts);
    const acknowledge = environment.acknowledge;
    vi.useFakeTimers();
    try {
      delete environment.acknowledge;
      controller.handleSessionUpdate(SESSION_ID, { kind: 'promptMessage', messageId: 'p', text: 'Delivered once' });
      expect(environment.transcript().entries).toMatchObject([{ kind: 'prompt', text: 'Delivered once' }]);
      environment.take();
      if (acknowledge) { environment.acknowledge = acknowledge; }
      await vi.advanceTimersByTimeAsync(2_000);
      expect(environment.take()).toHaveLength(1);
      expect(environment.transcript().entries).toMatchObject([{ kind: 'prompt', text: 'Delivered once' }]);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(environment.take()).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('recovers a lost grandchild completion only in its immediate parent’s transcript', async () => {
    const { controller, environment, sessions } = setup();
    const root = sessions.requireSession();
    const origin = (sessionId: string) => ({ identity: { configuredName: root.agentName, sessionId }, sourceId: root.agentId });
    sessions.retained.accept(root, { kind: 'childSession', childId: 'child' }, 0);
    sessions.retained.acceptChild(origin('child'), { kind: 'childSession', childId: 'grandchild' }, 0, () => true);
    sessions.retained.acceptChild(origin('grandchild'), { kind: 'foreground', state: 'running' }, 0, () => true);

    vi.useFakeTimers();
    try {
      let view = initialState;
      const sent: Parameters<typeof environment.post>[0][] = [];
      environment.post = (message) => { sent.push(message); };
      const dispatch = (action: Parameters<typeof update>[1]) => {
        const result = update(view, action, 0);
        view = result.state;
        for (const reply of result.outgoing) { void controller.handleMessage(reply); }
      };
      const deliver = () => {
        while (sent.length) {
          for (const message of sent.splice(0)) {
            dispatch(message);
            const applied = contentApplied(view, message);
            if (applied) { void controller.handleMessage(applied); }
          }
        }
      };
      await controller.handleMessage({ type: 'ready' });
      deliver();
      const rootTarget = view.transcript.projection?.target;
      dispatch({ type: 'childOpened', id: 'child' });
      const snapshot = sent.find((message) => message.type === 'contentSnapshot' && message.target.sessionId === 'child');
      expect(snapshot).toBeDefined();
      expect(snapshot).not.toHaveProperty('composer');
      expect(snapshot).not.toHaveProperty('queue');
      deliver();
      expect(view.inspection?.received).toBe(true);

      // Drop the completion delivery. Do not send any more child updates.
      sessions.retained.acceptChild(origin('grandchild'), { kind: 'foreground', state: 'idle', stopReason: 'cancelled' }, 0, () => true);
      await vi.advanceTimersByTimeAsync(100);
      expect(sent.splice(0)).toMatchObject([{ type: 'contentPatch', target: { sessionId: 'child' } }]);
      expect(view.inspection?.transcript.entries).toEqual([]);
      await vi.advanceTimersByTimeAsync(2_000);
      deliver();

      expect(view.inspection?.transcript.entries).toMatchObject([
        { kind: 'childCompletion', childId: 'grandchild', stopReason: 'cancelled' },
      ]);
      expect(view.transcript.entries).toEqual([]);
      expect(view.transcript.projection?.target).toEqual(rootTarget);
      expect(view.activeSession?.sessionId).toBe(root.sessionId);
    } finally { vi.useRealTimers(); }
  });

  it.each(['revision gap', 'invalid base'] as const)('recovers a quiet transcript with a contiguous journal after %s', async (failure) => {
    const parts = setup();
    const { controller, environment } = parts;
    await issuedTarget(parts);
    vi.useFakeTimers();
    try {
      let view = initialState;
      const sent: Parameters<typeof environment.post>[0][] = [];
      const deliver = () => {
        for (const message of sent.splice(0)) {
          const result = update(view, message, 0);
          view = result.state;
          for (const reply of result.outgoing) { void controller.handleMessage(reply); }
          const applied = contentApplied(view, message);
          if (applied) { void controller.handleMessage(applied); }
        }
      };
      environment.post = (message) => { sent.push(message); };
      await controller.handleMessage({ type: 'ready' });
      deliver();
      controller.handleSessionUpdate(SESSION_ID, { kind: 'agentMessage', messageId: 'm', text: 'First' });
      const first = sent.find((message) => message.type === 'contentPatch');
      if (!first) { throw new Error('Missing first patch'); }
      if (failure === 'invalid base') {
        deliver();
        expect(view.transcript.projection?.versions?.entries).toHaveLength(1);
        view = update(view, { type: 'loadSessionStart' }, 0).state;
      } else { sent.splice(0); }
      controller.handleSessionUpdate(SESSION_ID, { kind: 'agentText', messageId: 'm', text: ' answer' });
      await vi.advanceTimersByTimeAsync(100);
      const next = sent.find((message) => message.type === 'contentPatch');
      if (!next) { throw new Error('Missing second patch'); }
      expect(next.patches).toMatchObject([{ kind: 'appendText' }]);
      deliver();
      expect(view.transcript.entries).toEqual([]);
      if (failure === 'invalid base') {
        expect(sent.splice(0)).toEqual([expect.objectContaining({ type: 'contentPatch', patches: [expect.objectContaining({ kind: 'insert' })] })]);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(sent.map(({ type }) => type)).toEqual(['contentManifestRequested']);
        deliver();
        expect(sent.map(({ type }) => type)).toEqual(['contentPatch']);
      } else {
        expect(sent).toEqual([]);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(sent).toEqual([first, next]);
      }
      deliver();
      expect(view.transcript.entries).toMatchObject([{ kind: 'turn', parts: [{ kind: 'message', text: 'First answer' }] }]);
      expect(view.transcript.projection?.revision).toBe(next.revision);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(sent).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it.each(['unchanged', 'reprojected'] as const)('recovers a missed switch to a quiet %s session', async (selection) => {
    const parts = setup();
    const { controller, sessions, environment } = parts;
    const original = await issuedTarget(parts);
    const post = environment.post.bind(environment);
    const quiet = sessionInfo({ sessionId: OTHER_SESSION_ID });
    vi.useFakeTimers();
    try {
      const dropped: Parameters<typeof post>[0][] = [];
      environment.post = (message) => { dropped.push(message); };
      sessions.session = quiet;
      sessions.activeId = quiet.sessionId;
      sessions.retained.attach(quiet);
      controller.notifyActiveSessionChanged();
      const delayed = dropped.find((message) => message.type === 'viewSnapshot');
      if (!delayed?.content) { throw new Error('Missing selection snapshot'); }
      expect(delayed.content).toMatchObject({ target: { sessionId: quiet.sessionId }, revision: 0 });
      if (selection === 'reprojected') { controller.notifyActiveSessionChanged(); }
      await controller.handleMessage({ type: 'contentApplied', target: original, revision: 0 });
      expect(environment.transcript().projection?.target).toEqual(original);

      environment.post = (message) => {
        post(message);
        if (message.type === 'contentManifestRequested') {
          const view = { ...initialState, transcript: environment.transcript() };
          for (const reply of update(view, message, 0).outgoing) { void controller.handleMessage(reply); }
        }
      };
      await vi.advanceTimersByTimeAsync(2_000);
      expect(environment.take().map((message) => message.type)).toEqual(selection === 'reprojected'
        ? ['viewSnapshot', 'contentManifestRequested', 'contentPatch'] : ['viewSnapshot']);
      expect(environment.transcript().projection?.target.sessionId).toBe(quiet.sessionId);
      expect(environment.transcript().projection?.revision).toBe(selection === 'reprojected' ? 1 : 0);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(environment.take()).toEqual([]);

      const later = sessionInfo({ sessionId: 'later-session' });
      sessions.session = later;
      sessions.activeId = later.sessionId;
      sessions.retained.attach(later);
      controller.notifyActiveSessionChanged();
      post(delayed);
      expect(environment.transcript().projection?.target.sessionId).toBe(later.sessionId);
    } finally { vi.useRealTimers(); }
  });

  it('defers replay while hidden and resumes retrying when visible without more agent output', async () => {
    const parts = setup();
    const { controller, environment } = parts;
    await issuedTarget(parts);
    const post = environment.post.bind(environment);
    environment.post = (message) => { if (environment.visible) { post(message); } };
    vi.useFakeTimers();
    try {
      environment.visible = false;
      controller.handleSessionUpdate(SESSION_ID, { kind: 'promptMessage', messageId: 'p', text: 'While hidden' });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(environment.take()).toEqual([]);
      expect(environment.transcript().entries).toEqual([]);
      environment.visible = true;
      await vi.advanceTimersByTimeAsync(8_000);
      expect(environment.take().map(({ type }) => type)).toEqual(['contentPatch']);
      expect(environment.transcript().entries).toMatchObject([{ kind: 'prompt', text: 'While hidden' }]);
    } finally { vi.useRealTimers(); }
  });

  it('reports overlapping errors before one completion when submissions settle together', async () => {
    const { controller, sessions, environment } = setup();
    const first = sendPrompt(controller, sessions, 'first');
    const second = steer(controller, sessions, 'steer');
    environment.take();
    sessions.answer();
    sessions.fail(new Error('Refused'));
    await Promise.all([first, second]);
    expect(environment.take()).toEqual([
      expect.objectContaining({ type: 'contentPatch', patches: [expect.objectContaining({ kind: 'insert', entries: [{ kind: 'error', id: 3, text: 'Refused' }] })] }),
      expect.objectContaining({ type: 'contentPatch', running: false, patches: [] }),
      { type: 'promptEnd' },
    ]);
    expect(environment.transcript().entries.at(-1)).toEqual({ kind: 'error', id: 3, text: 'Refused' });
  });

  it('reports the final overlapping prompt error before releasing queued prompts', async () => {
    const { controller, sessions, environment } = setup();
    const first = sendPrompt(controller, sessions, 'first');
    const second = steer(controller, sessions, 'second');
    sessions.answer();
    await first;
    environment.take();
    sessions.fail(new Error('Refused'));
    await second;
    expect(environment.take()).toEqual([expect.objectContaining({ type: 'contentPatch' }), { type: 'promptEnd' }]);
    expect(environment.transcript().entries.at(-1)).toEqual({ kind: 'error', id: 3, text: 'Refused' });
  });

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
    const second = steer(controller, sessions, 'steer');
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
    expect(environment.take()).toEqual([expect.objectContaining({ type: 'contentPatch', running: false, patches: [] }), { type: 'promptEnd' }]);
  });

  describe('turns', () => {
    it('records completion against the captured registration after its configuration is renamed', async () => {
      const { sessions, controller } = setup();
      const turn = sendPrompt(controller, sessions, 'Continue');
      const registration = sessions.session;
      if (!registration) { throw new Error('Missing registration'); }
      registration.agentName = 'renamed';
      sessions.retained.rename('fake', 'renamed');
      sessions.answer();
      await turn;

      expect(sessions.recordTurnEnded).toHaveBeenCalledExactlyOnceWith({ configuredName: 'renamed', sessionId: SESSION_ID });
    });

    it('restores foreground state and review context when a controller is recreated during autonomous work', async () => {
      const { sessions, controller, environment, editor } = setup();
      controller.handleSessionUpdate(SESSION_ID, { kind: 'foreground', state: 'requiresAction' });
      controller.handleSessionUpdate(SESSION_ID, { kind: 'agentText', messageId: 'autonomous', text: 'Working' });
      await controller.dispose();
      environment.take();
      environment.executeCommand.mockClear();
      const replacement = new ChatViewController(sessions, environment, editor);
      onTestFinished(() => replacement.dispose());
      await replacement.handleMessage({ type: 'ready' });
      expect(replacement.hasRunningTurn).toBe(true);
      const messages = environment.take();
      const state = messages.reduce((state, message) => update(state, message, 2).state, initialState);
      expect(state.activeSession?.turnRunning).toBe(true);
      expect(state.transcript.currentTurn).toBe(1);
      expect(state.transcript.entries).toEqual([{ kind: 'turn', id: 1, parts: [{ kind: 'message', messageId: 'autonomous', text: 'Working' }] }]);
      expect(messages.map((message) => message.type)).toEqual(['viewSnapshot']);
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
      expect(environment.take().map((message) => message.type)).toEqual(outcome === 'answer' ? [] : ['contentPatch']);
      if (outcome === 'fail') { expect(environment.transcript().entries.at(-1)).toEqual({ kind: 'error', id: 2, text: 'Rejected' }); }
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
      expect(environment.take()).toEqual([expect.objectContaining({ type: 'contentPatch', running: false, patches: [] }), { type: 'promptEnd' }]);
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
      expect(environment.take()).toEqual([]);
      expect(environment.transcript().entries).toEqual([]);
    });

    it('runs a turn and reports its end', async () => {
      const { sessions, environment, controller } = setup();

      const turn = sendPrompt(controller, sessions, 'hello');
      expect(sessions.sendPrompt).toHaveBeenCalledExactlyOnceWith({ configuredName: 'fake', sessionId: SESSION_ID }, 'hello');
      expect(environment.take().map((message) => message.type)).toEqual(['contentPatch', 'promptStart']);
      expect(environment.transcript().entries).toEqual([{ kind: 'prompt', id: 1, text: 'hello' }]);
      expect(controller.hasRunningTurn).toBe(true);

      sessions.answer();
      await turn;

      expect(sessions.recordTurnEnded).toHaveBeenCalledExactlyOnceWith({ configuredName: 'fake', sessionId: SESSION_ID });
      expect(environment.take()).toEqual([expect.objectContaining({ type: 'contentPatch', running: false, patches: [] }), { type: 'promptEnd' }]);
      expect(controller.hasRunningTurn).toBe(false);
    });

    it('reports a failed prompt as an error that ends the turn', async () => {
      const { sessions, environment, controller } = setup();

      const turn = sendPrompt(controller, sessions, 'hello');
      expect(environment.take().map((message) => message.type)).toEqual(['contentPatch', 'promptStart']);
      sessions.fail(new Error('agent crashed'));
      await turn;

      expect(controller.hasRunningTurn).toBe(false);
      expect(sessions.recordTurnEnded).not.toHaveBeenCalled();
      expect(environment.take().map((message) => message.type)).toEqual(['contentPatch', 'promptEnd']);
      expect(environment.transcript().entries.at(-1)).toEqual({ kind: 'error', id: 2, text: 'agent crashed' });
    });

    it('uses a generic message when the failure has none', async () => {
      const { sessions, environment, controller } = setup();

      const turn = sendPrompt(controller, sessions, 'hello');
      sessions.fail({});
      await turn;

      expect(environment.transcript().entries.at(-1)).toEqual({ kind: 'error', id: 2, text: 'Prompt failed' });
    });

    it('tells the editor a turn is in progress until it ends, also when it fails', async () => {
      const parts = setup();
      const { sessions, environment, controller } = parts;
      await issuedTarget(parts);
      environment.executeCommand.mockClear();
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
      const parts = setup();
      const { sessions, controller } = parts;
      await issuedTarget(parts);
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
      expect(environment.take().map((message) => message.type)).toEqual(['viewSnapshot']);

      sessions.answer();
      await turn;
      environment.take();
      await controller.handleMessage({ type: 'ready' });
      expect(environment.take().map((message) => message.type)).toEqual(['viewSnapshot']);
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
        expect(environment.take().map((message) => message.type)).toEqual(['contentPatch', 'promptStart', 'viewSnapshot']);

        switchTo(sessions, controller, SESSION_ID);

        expect(environment.take().map((message) => message.type)).toEqual(['viewSnapshot']);
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

      expect(environment.take().map((message) => message.type)).toEqual(['viewSnapshot']);
      sessions.answer();
      await turn;
    });

    describe('when the agent of a session exits', () => {
      it('tells the chat view why its session ended, which ends the turn', async () => {
        const { sessions, environment, controller } = setup();
        await controller.handleMessage({ type: 'ready' });
        const turn = sendPrompt(controller, sessions, 'hello');
        environment.take();

        controller.notifySessionEnded(sessions.requireSession(), 'Fake Agent exited unexpectedly (code 1).');

        expect(environment.take()).toEqual([{ type: 'sessionEnded', message: 'Fake Agent exited unexpectedly (code 1).' }]);
        sessions.fail(new Error('ACP connection closed'));
        await turn;
      });

      it('says nothing more when the turn then fails, the session being gone', async () => {
        const { sessions, environment, controller } = setup();
        await controller.handleMessage({ type: 'ready' });
        const turn = sendPrompt(controller, sessions, 'hello');
        controller.notifySessionEnded(sessions.requireSession(), 'Fake Agent exited unexpectedly (code 1).');
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

        sessions.retireSession(SESSION_ID);
        controller.notifySessionEnded(sessions.requireSession(), 'Fake Agent exited unexpectedly (code 1).');
        environment.take();
        await controller.handleMessage({ type: 'ready' });

        expect(environment.take().map((message) => message.type)).toEqual(['viewSnapshot']);
        expect(controller.hasRunningTurn).toBe(false);
        sessions.fail(new Error('ACP connection closed'));
        await turn;
      });

      it('does not tell the chat view about a session it does not show', async () => {
        const { environment, controller } = setup();
        await controller.handleMessage({ type: 'ready' });
        environment.take();

        controller.notifySessionEnded(sessionInfo({ sessionId: OTHER_SESSION_ID }), 'Other exited unexpectedly (code 1).');

        expect(environment.take()).toEqual([]);
      });
    });

    it('reads the retained queue count and preserves it when a chat view opens anew', async () => {
      const { controller, sessions } = setup();
      expect(controller.queuedPrompts).toBe(0);
      const turn = sendPrompt(controller, sessions, 'running');
      await sendPrompt(controller, sessions, 'head');
      await sendPrompt(controller, sessions, 'tail');
      expect(controller.queuedPrompts).toBe(2);
      await controller.handleMessage({ type: 'ready' });
      expect(controller.queuedPrompts).toBe(2);
      sessions.answer();
      await turn;
    });

    it('tells the chat view to clear the transcript', () => {
      const { environment, controller } = setup();

      controller.clearTranscript();

      expect(environment.take()).toEqual([{ type: 'clearTranscript' }]);
    });
  });
});
