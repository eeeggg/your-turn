import { randomUUID } from 'node:crypto';
import { onTestFinished, vi } from 'vitest';
import type { AgentApp, SessionConfigOption } from '@agentclientprotocol/sdk';
import { methods } from '@agentclientprotocol/sdk';
import type { ConfigOption, FileLink, SessionRoots, SessionUpdate } from '@/core/acp/AcpDriver';
import { ConnectionManager } from '@/core/acp/ConnectionManager';
import { AgentTerminals } from '@/core/AgentTerminals';
import { ChatViewController } from '@/core/ChatViewController';
import {
  SessionReferences,
  WorkspaceState,
  type KeyValueStore,
  type SessionAddress,
  type WorkspaceTarget
} from '@/core/PersistedState';
import {
  SessionManager,
  type AuthPrompt,
  type SessionEnvironment,
  type SessionManagerEvents,
} from '@/core/SessionManager';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';
import type { ExtensionToWebviewMessage } from '@/shared/WebviewMessages';
import {
  fakeAgent,
  InProcessAgents,
  unusedEditor,
  unusedHandlers,
  work,
  type AgentScript
} from '@tests/unit/core/InProcessAgents';

function memoryStore(): KeyValueStore {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key, value) => { values.set(key, value); },
  };
}

/** A remote window's workspace file saved on the client, so its URI and host differ. */
export const WORKSPACE: WorkspaceTarget = { uri: 'file:///Users/me/work.code-workspace', host: 'vscode-remote://ssh-remote+devenv' };
export const FIRST_SESSION = randomUUID();
export const SECOND_SESSION = randomUUID();
export const OLD_SESSION = 'e433d36b-13b3-44ed-b1a9-17ee39183713';
export const OLDER_SESSION = '03849432-6f6e-4610-90bf-e648b0cd874f';
export const LOADED_SESSION = '5a50d2aa-0fc1-4b1d-9147-ae7e0ace52c4';
export const RESUMED_SESSION = '783b2764-8d4e-4618-b3d3-014d6e6f685d';

/** Where session `sessionId` of agent `fake` lives in the test workspace. */
export const address = (sessionId: string): SessionAddress =>
  ({ configuredName: 'fake', sessionId, cwd: '/work', host: WORKSPACE.host, workspaceUri: WORKSPACE.uri });

const EVENTS = [
  'session-added',
  'session-removed',
  'active-session-changed',
  'clear-transcript',
  'mode-changed',
  'session-load-start',
  'session-load-end',
  'session-ended',
  'agent-closed',
] as const satisfies readonly (keyof SessionManagerEvents)[];

export function modelOption(currentValue: string): SessionConfigOption {
  return {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue,
    options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }],
  };
}

/** {@link modelOption} as the session holds it. */
export function modelConfig(current: string): ConfigOption {
  return {
    kind: 'select',
    id: 'model',
    name: 'Model',
    description: null,
    category: 'model',
    current,
    groups: [{ header: null, values: [{ id: 'a', name: 'A', description: null }, { id: 'b', name: 'B', description: null }] }],
  };
}

export function setup(scripts: Record<string, AgentScript>) {
  const agents = new InProcessAgents(scripts);
  const updates = new SessionUpdateHandler();
  let fileLink: FileLink | undefined;
  let target: WorkspaceTarget | undefined = WORKSPACE;
  let known: Promise<WorkspaceTarget | undefined> | undefined;
  let roots: SessionRoots = work;
  const environment: SessionEnvironment = {
    workspaceRoots: () => roots,
    workspaceTarget: () => target,
    workspaceTargetKnown: () => known ?? Promise.resolve(target),
    agentConfigs: () => Object.fromEntries(Object.keys(scripts).map((name) => [name, { command: name }])),
    activeFileLink: () => fileLink,
  };
  const authPrompt = { chooseAuthMethod: vi.fn<AuthPrompt['chooseAuthMethod']>(async () => undefined) };
  const connections = new ConnectionManager('0.0.0-test', () => ({
    ...unusedHandlers,
    permissions: { ...unusedHandlers.permissions, cancelSession: () => {} },
  }));
  const manager = new SessionManager(agents, connections, environment, authPrompt, updates);
  onTestFinished(async () => { await manager.dispose(); });
  const references = new SessionReferences(memoryStore(), () => Date.now());
  const workspace = new WorkspaceState(memoryStore());
  manager.setPersistedState(references, workspace);

  // As in the extension, runtime applies metadata before the chat view projects it.
  const terminals = new AgentTerminals({ open: () => ({ write: () => {}, show: () => {} }) });
  const executeCommand = vi.fn(async () => {});
  const posted: ExtensionToWebviewMessage[] = [];
  onTestFinished(async () => { await terminals.dispose(); });
  const chatView = new ChatViewController(
    manager,
    { post: (message) => posted.push(message), executeCommand, showsToolCallDiffs: () => false, visible: true, reveal: async () => {}, showInformationMessage: async () => undefined },
    unusedEditor,
    terminals,
    environment,
  );
  manager.on('session-opened', ({ sessionId }) => chatView.notifySessionOpened(sessionId));
  onTestFinished(async () => { updates.dispose(); await chatView.dispose(); });
  const received: [string, SessionUpdate][] = [];
  const receivedWaiters: { count: number; resolve: () => void }[] = [];
  updates.addListener((delivery) => {
    const { input: { origin, update } } = delivery;
    const { sessionId } = origin.identity;
    received.push([sessionId, update]);
    chatView.handleSessionUpdate(delivery);
    for (const waiter of receivedWaiters.splice(0)) {
      if (received.length >= waiter.count) {
        waiter.resolve();
      } else {
        receivedWaiters.push(waiter);
      }
    }
  });

  const events: unknown[][] = [];
  for (const name of EVENTS) {
    manager.on(name, (...args: unknown[]) => events.push([name, ...args]));
  }

  return {
    agents,
    connections,
    manager,
    updates,
    posted,
    chatView,
    executeCommand,
    references,
    workspace,
    /** The reference to session `sessionId` of agent `fake` on the test workspace's host. */
    reference: (sessionId: string) => references.get({ host: WORKSPACE.host, configuredName: 'fake', sessionId }),
    authPrompt,
    received,
    events,
    linkActiveFile(link: FileLink) { fileLink = link; },
    /** As in a multi-root workspace whose other folders are these. */
    withOtherFolders(...additionalDirectories: string[]) { roots = { ...work, additionalDirectories }; },
    /** As in a window with no folder, or an untitled multi-root workspace. */
    withoutWorkspaceTarget() { target = undefined; },
    /** As in a remote window that has yet to learn its workspace URI; the function returned makes it known. */
    withPendingWorkspaceTarget(): () => void {
      target = undefined;
      let learn: () => void = () => {};
      known = new Promise((resolve) => {
        learn = () => {
          target = WORKSPACE;
          known = undefined;
          resolve(WORKSPACE);
        };
      });
      return learn;
    },
    receivedAtLeast(count: number): Promise<void> {
      if (received.length >= count) { return Promise.resolve(); }
      return new Promise((resolve) => receivedWaiters.push({ count, resolve }));
    },
    /** Events emitted since the last call. */
    takeEvents(): unknown[][] { return events.splice(0); },
  };
}

/**
 * Explicit IDs support exact protocol assertions and deliberate collisions; defaults model fresh creations.
 * shortcut: request handlers are scripted. For Slice 1 authority and Slice 2 routing tests that need session
 * validation, track known sessions across launches and reject requests for the wrong session.
 */
export function sessionAgent(ids?: string | readonly string[], extend: (app: AgentApp) => AgentApp = (app) => app, init = {}) {
  const sessions = typeof ids === 'string' ? [ids] : ids;
  let created = 0;
  const requests: { method: string; params: unknown }[] = [];
  const script: AgentScript = () => extend(fakeAgent(init)
    .onRequest(methods.agent.session.new, ({ params }) => {
      requests.push({ method: 'session/new', params });
      const sessionId = sessions ? sessions[created++] : randomUUID();
      if (!sessionId) { throw new Error('No further session ID supplied to the fixture'); }
      return { sessionId, configOptions: [modelOption('a')] };
    }));
  return { script, requests };
}
