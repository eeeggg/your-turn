import { describe, expect, it, vi } from 'vitest';
import { methods } from '@agentclientprotocol/sdk';
import { ChatViewController } from '@/core/ChatViewController';
import { ConnectionManager } from '@/core/ConnectionManager';
import { SessionManager } from '@/core/SessionManager';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import type { WebviewToExtensionMessage } from '@/shared/WebviewMessages';
import { initialState, update } from '@/webview/state/RootState';
import { createStore } from '@/webview/state/Store';
import { showsWelcome } from '@/webview/state/Transcript';
import { fakeAgent, InProcessAgents, unusedHandlers, type ExitOrder } from './InProcessAgents';

/** Let pending callbacks, agent exits and webview messages included, run. */
const settle = async () => {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

/** The extension and the chat view's store, wired as `extension.ts` wires them, with a real agent behind them. */
function setup() {
  const prompts: string[] = [];
  const agents = new InProcessAgents({
    fake: () => fakeAgent()
      .onRequest(methods.agent.session.new, () => ({ sessionId: 's1' }))
      .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
        prompts.push(params.prompt.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(''));
        await client.notify(methods.client.session.update, { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } } });
        return new Promise(() => {});
      }),
  });
  const updates = new SessionUpdateHandler();
  const manager = new SessionManager(
    agents,
    new ConnectionManager(updates, '0.0.0-test', () => unusedHandlers),
    { workspaceCwd: () => '/work', agentConfigs: () => ({ fake: { command: 'fake' } }), activeFileLink: () => undefined },
    { chooseAuthMethod: vi.fn() },
  );
  const turnInProgress: unknown[] = [];
  const toExtension = (message: WebviewToExtensionMessage) => setImmediate(() => void controller.handleMessage(message));
  const store = createStore(initialState, update, toExtension, () => 0);
  const controller = new ChatViewController(manager, {
    post: (message) => store.dispatch(message),
    executeCommand: async (...args) => { turnInProgress.push(args[2]); },
  });
  updates.addListener((notification) => controller.handleSessionUpdate(notification));
  manager.on('active-session-changed', () => controller.notifyActiveSessionChanged());
  manager.on('session-ended', (sessionId, reason) => controller.notifySessionEnded(sessionId, reason));

  const prompt = (text: string) => {
    store.dispatch({ type: 'promptEdited', text });
    store.dispatch({ type: 'promptSent' });
  };
  const summary = () => store.getSnapshot().transcript.entries.map((entry) => (entry.kind === 'turn' ? 'turn' : `${entry.kind}: ${entry.text}`));
  return { agents, manager, store, controller, prompts, turnInProgress, prompt, summary };
}

describe('an agent that exits during a turn', () => {
  for (const order of ['output-then-exit', 'exit-then-output'] as ExitOrder[]) {
    it(`leaves the conversation in the chat view with why, and sends no queued prompt (${order})`, async () => {
      const { agents, manager, store, controller, prompts, turnInProgress, prompt, summary } = setup();
      await controller.handleMessage({ type: 'ready' });
      await manager.connectToAgent('fake');
      prompt('first');
      await settle();
      prompt('second');

      agents.launched[0]?.crash(1, order);
      await settle();

      expect(prompts).toEqual(['first']);
      expect(summary()).toEqual(['prompt: first', 'turn', 'error: Fake Agent exited unexpectedly (code 1).']);
      const { activeSession, transcript } = store.getSnapshot();
      expect(activeSession).toBeNull();
      expect(transcript.currentTurn).toBeNull();
      expect(transcript.queued).toEqual([]);
      expect(showsWelcome(transcript, activeSession)).toBe(false);
      expect(turnInProgress.at(-1)).toBe(false);
    });
  }
});
