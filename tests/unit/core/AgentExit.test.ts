import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { methods, RequestError } from '@agentclientprotocol/sdk';
import { ChatViewController } from '@/core/ChatViewController';
import { ConnectionManager } from '@/core/acp/ConnectionManager';
import { SessionManager } from '@/core/sessions/Manager';
import { SessionUpdateHandler } from '@/core/sessions/UpdateHandler';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import { initialState, update } from '@/webview/state/RootState';
import { createStore } from '@/webview/state/Store';
import { showsEmptyState } from '@/webview/state/Transcript';
import {
  fakeAgent,
  InProcessAgents,
  unusedEditor,
  unusedHandlers,
  work,
  type ExitOrder
} from '@tests/unit/core/InProcessAgents';

/** The extension and the chat view's store, wired as `extension.ts` wires them, with a real agent behind them. */
function setup(controlledPrompts = false) {
  const prompts: string[] = [];
  const replies: { resolve: () => void; reject: (error: unknown) => void }[] = [];
  const waitingForPrompt: (() => void)[] = [];
  const agents = new InProcessAgents({
    fake: () => fakeAgent()
      .onRequest(methods.agent.session.new, () => ({ sessionId: randomUUID() }))
      .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
        prompts.push(params.prompt.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(''));
        if (controlledPrompts) {
          const reply = new Promise<void>((resolve, reject) => replies.push({ resolve, reject }));
          waitingForPrompt.shift()?.();
          await reply;
          return { stopReason: 'end_turn' };
        }
        waitingForPrompt.shift()?.();
        await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } } });
        return new Promise(() => {});
      }),
  });
  const updates = new SessionUpdateHandler();
  const manager = new SessionManager(
    agents,
    new ConnectionManager('0.0.0-test', () => unusedHandlers),
    { workspaceRoots: () => work, workspaceTarget: () => undefined, workspaceTargetKnown: () => Promise.resolve(undefined), agentConfigs: () => ({ fake: { command: 'fake' } }), activeFileLink: () => undefined },
    { chooseAuthMethod: vi.fn() },
    updates,
  );
  onTestFinished(async () => { await manager.dispose(); });
  const turnInProgress: unknown[] = [];
  const messages: ExtensionToWebviewMessage[] = [];
  const toExtension = (message: WebviewToExtensionMessage) => setImmediate(() => void controller.handleMessage(message));
  const store = createStore(initialState, update, toExtension, () => 0);
  const controller = new ChatViewController(manager, {
    post: (message) => { messages.push(message); store.dispatch(message); },
    executeCommand: async (...args) => { turnInProgress.push(args[2]); },
    showsToolCallDiffs: () => false,
    visible: true, reveal: async () => {}, showInformationMessage: async () => undefined,
  }, unusedEditor);
  onTestFinished(async () => { updates.dispose(); await controller.dispose(); });
  updates.addListener((delivery) => controller.handleSessionUpdate(delivery));
  manager.on('session-removed', (registration) => {
    controller.notifySessionRemoved(registration);
  });
  manager.on('active-session-changed', () => controller.notifyActiveSessionChanged());
  manager.on('session-ended', (registration, reason) => controller.notifySessionEnded(registration, reason));

  const prompt = (text: string) => {
    store.dispatch({ type: 'promptEdited', text });
    store.dispatch({ type: 'promptSent' });
  };
  const nextPrompt = () => new Promise<void>((resolve) => waitingForPrompt.push(resolve));
  const stateChanged = (condition: () => boolean) => new Promise<void>((resolve) => {
    if (condition()) {
      resolve();
      return;
    }
    const unsubscribe = store.subscribe(() => {
      if (condition()) {
        unsubscribe();
        resolve();
      }
    });
  });
  const summary = () => store.getSnapshot().transcript.entries.map((entry) => (entry.kind === 'turn' ? 'turn' : entry.kind === 'compaction' ? `compaction: ${entry.compactionId}` : entry.kind === 'question' ? `question: ${entry.record.interactionId}` : `${entry.kind}: ${entry.text}`));
  return { agents, manager, store, controller, prompts, replies, messages, turnInProgress, prompt, nextPrompt, stateChanged, summary };
}

describe('runtime prompt queue wiring', () => {
  it('preserves queue order through overlapping steering, an error, and repeated idle reports', async () => {
    const { manager, store, controller, prompts, replies, messages, prompt, nextPrompt, stateChanged, summary } = setup(true);
    await controller.handleMessage({ type: 'ready' });
    const session = await manager.connectToAgent('fake');
    const completed = (message: ExtensionToWebviewMessage) => message.type === 'promptEnd' || message.type === 'foregroundActivity' && !message.running;
    const firstSent = nextPrompt();
    prompt('first');
    await firstSent;
    prompt('steer');
    prompt('second');
    prompt('third');
    await stateChanged(() => store.getSnapshot().transcript.queued.length === 3);
    const head = store.getSnapshot().transcript.queued[0];
    if (!head) { throw new Error('Missing steering prompt'); }
    const steeringSent = nextPrompt();
    store.dispatch({ type: 'steerNowChosen', id: head.id });
    await steeringSent;
    expect(prompts).toEqual(['first', 'steer']);
    manager.applyForegroundState({ configuredName: session.agentName, sessionId: session.sessionId }, 'running');
    manager.applyForegroundState({ configuredName: session.agentName, sessionId: session.sessionId }, 'idle');
    expect(store.getSnapshot().transcript.queued.map((queued) => queued.text)).toEqual(['second', 'third']);
    expect(messages.filter((message) => message.type === 'promptEnd')).toEqual([]);

    const secondSent = nextPrompt();
    replies[0]?.resolve();
    replies[1]?.reject(RequestError.internalError(undefined, 'Steering refused'));
    await secondSent;
    expect(prompts).toEqual(['first', 'steer', 'second']);
    const completion = messages.findIndex(completed);
    const error = messages.findIndex((_, index) => messages.slice(0, index + 1)
      .reduce((state, message) => update(state, message, 0).state, initialState).transcript.entries.some((entry) => entry.kind === 'error'));
    expect(error).toBeGreaterThan(-1);
    expect(completion).toBeGreaterThan(error);
    expect(messages.filter(completed)).toHaveLength(1);
    expect(summary()).toEqual(['prompt: first', 'prompt: steer', 'error: Internal error: Steering refused', 'prompt: second']);

    manager.applyForegroundState({ configuredName: session.agentName, sessionId: session.sessionId }, 'idle');
    manager.applyForegroundState({ configuredName: session.agentName, sessionId: session.sessionId }, 'idle');
    expect(store.getSnapshot().transcript.queued.map((queued) => queued.text)).toEqual(['third']);
    const thirdSent = nextPrompt();
    replies[2]?.resolve();
    await thirdSent;
    expect(prompts).toEqual(['first', 'steer', 'second', 'third']);
    expect(messages.filter(completed)).toHaveLength(2);
    const finished = stateChanged(() => !store.getSnapshot().activeSession?.turnRunning);
    replies[3]?.resolve();
    await finished;
    expect(messages.filter(completed)).toHaveLength(3);
    expect(store.getSnapshot().transcript.queued).toEqual([]);
    expect(manager.resolutionBlocked()).toBe(false);
  });
});

describe('an agent that exits during a turn', () => {
  for (const order of ['output-then-exit', 'exit-then-output'] as ExitOrder[]) {
    it(`leaves the conversation in the chat view with why, and sends no queued prompt (${order})`, async () => {
      const { agents, manager, store, controller, prompts, turnInProgress, prompt, nextPrompt, stateChanged, summary } = setup();
      await controller.handleMessage({ type: 'ready' });
      await manager.connectToAgent('fake');
      const firstSent = nextPrompt();
      const turnShown = stateChanged(() => store.getSnapshot().transcript.entries.some((entry) => entry.kind === 'turn'));
      prompt('first');
      await Promise.all([firstSent, turnShown]);
      prompt('second');
      const ended = stateChanged(() => store.getSnapshot().activeSession === null);

      await agents.launched[0]?.crash(1, order);
      await ended;

      expect(prompts).toEqual(['first']);
      expect(summary()).toEqual(['prompt: first', 'turn', 'error: Fake Agent exited unexpectedly (code 1).']);
      const { activeSession, transcript } = store.getSnapshot();
      expect(activeSession).toBeNull();
      expect(transcript.currentTurn).toBeNull();
      expect(transcript.queued).toEqual([]);
      expect(showsEmptyState(transcript, activeSession)).toBe(false);
      expect(turnInProgress.at(-1)).toBe(false);
    });
  }
});
