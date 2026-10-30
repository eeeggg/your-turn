import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { methods } from '@agentclientprotocol/sdk';
import { AgentTerminals } from '@/core/AgentTerminals';
import { ChatViewController } from '@/core/ChatViewController';
import { ConnectionManager } from '@/core/acp/ConnectionManager';
import { SessionManager } from '@/core/SessionManager';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import type { WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import { initialState, update } from '@/webview/state/RootState';
import { createStore } from '@/webview/state/Store';
import { showsEmptyState } from '@/webview/state/Transcript';
import { fakeAgent, InProcessAgents, unusedEditor, unusedHandlers, work, type ExitOrder } from './InProcessAgents';

/** The extension and the chat view's store, wired as `extension.ts` wires them, with a real agent behind them. */
function setup() {
  const prompts: string[] = [];
  const waitingForPrompt: (() => void)[] = [];
  const agents = new InProcessAgents({
    fake: () => fakeAgent()
      .onRequest(methods.agent.session.new, () => ({ sessionId: 's1' }))
      .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
        prompts.push(params.prompt.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(''));
        waitingForPrompt.shift()?.();
        await client.notify(methods.client.session.update, { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } } });
        return new Promise(() => {});
      }),
  });
  const updates = new SessionUpdateHandler();
  const manager = new SessionManager(
    agents,
    new ConnectionManager(updates, '0.0.0-test', () => unusedHandlers),
    { workspaceRoots: () => work, workspaceTarget: () => undefined, workspaceTargetKnown: () => Promise.resolve(undefined), agentConfigs: () => ({ fake: { command: 'fake' } }), activeFileLink: () => undefined },
    { chooseAuthMethod: vi.fn() },
  );
  onTestFinished(async () => { await manager.dispose(); });
  const turnInProgress: unknown[] = [];
  const toExtension = (message: WebviewToExtensionMessage) => setImmediate(() => void controller.handleMessage(message));
  const store = createStore(initialState, update, toExtension, () => 0);
  const terminals = new AgentTerminals({ open: () => ({ write: () => {}, show: () => {} }) });
  onTestFinished(async () => { await terminals.dispose(); });
  const controller = new ChatViewController(manager, {
    post: (message) => store.dispatch(message),
    executeCommand: async (...args) => { turnInProgress.push(args[2]); },
    showsToolCallDiffs: () => false,
  }, unusedEditor, terminals);
  onTestFinished(async () => { updates.dispose(); await controller.dispose(); });
  updates.addListener((sessionId, update) => controller.handleSessionUpdate(sessionId, update));
  updates.addListener((sessionId, update) => terminals.handleSessionUpdate(sessionId, update));
  manager.on('session-removed', (sessionId) => {
    terminals.endSession(sessionId);
    controller.notifySessionRemoved(sessionId);
  });
  manager.on('active-session-changed', () => controller.notifyActiveSessionChanged());
  manager.on('session-ended', (sessionId, reason) => controller.notifySessionEnded(sessionId, reason));

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
  const summary = () => store.getSnapshot().transcript.entries.map((entry) => (entry.kind === 'turn' ? 'turn' : `${entry.kind}: ${entry.text}`));
  return { agents, manager, store, controller, prompts, turnInProgress, prompt, nextPrompt, stateChanged, summary };
}

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
