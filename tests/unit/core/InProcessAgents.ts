import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { AgentApp, AgentConnector, InitializeResponse } from '@agentclientprotocol/sdk';
import * as V2 from '@agentclientprotocol/sdk/experimental/v2';
import { onTestFinished } from 'vitest';
import type { AcpDriver, AcpSchema, SessionUpdate } from '@/core/acp/AcpDriver';
import { ConnectionManager } from '@/core/acp/ConnectionManager';
import type { AgentConfigEntry, AgentLauncher, AgentProcess, AgentProcessEvents } from '@/core/AgentManager';
import type { ClientHandlers } from '@/core/ClientHandlers';
import type { FileEditor } from '@/core/ReportedFiles';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';

/** Builds the agent a launch talks to, an SDK agent of either version or a router; called once per launch. */
export type AgentScript = () => AgentConnector;

const unused = (): never => {
  throw new Error('not used by these tests');
};

/** Client handlers for agents that never call them. */
export const unusedHandlers: ClientHandlers = {
  permissions: { requestPermission: unused },
};

/** An editor for chat views that never open a tool call's files. */
export const unusedEditor: FileEditor = {
  exists: unused,
  readText: unused,
  open: unused,
  showChanges: unused,
  showInformationMessage: unused,
};

/** A real process's output can close before its exit is reported, or after. */
export type ExitOrder = 'output-then-exit' | 'exit-then-output';

/**
 * An SDK agent that answers `initialize`; add the requests a test needs. The
 * SDK keeps the first handler registered for a method, so a test that answers
 * `initialize` itself starts from the SDK's `agent()` instead.
 */
export function fakeAgent(init: Partial<InitializeResponse> = {}): AgentApp {
  return agent({ name: 'fake-agent' }).onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: { name: 'fake-agent', title: 'Fake Agent', version: '0.0.1' },
    ...init,
  }));
}

export interface LaunchedAgent {
  readonly name: string;
  readonly cwd: string;
  readonly process: AgentProcess;
  killed: boolean;
  exited: boolean;
  /** Settles after output has closed and the process exit was reported. */
  readonly exitReported: Promise<void>;
  /** The process dies on its own, without being killed; a null code is a death by signal. */
  crash(code?: number | null, order?: ExitOrder): Promise<void>;
}

/**
 * Launches agents as SDK agents in this process, speaking newline-delimited
 * ACP over in-memory streams, as a spawned agent would over stdio.
 */
export class InProcessAgents implements AgentLauncher {
  readonly launched: LaunchedAgent[] = [];
  private nextId = 1;

  constructor(private readonly scripts: Record<string, AgentScript>) {}

  launch(name: string, _config: AgentConfigEntry, cwd: string, events: AgentProcessEvents): AgentProcess {
    const script = this.scripts[name];
    if (!script) {
      throw new Error(`no script for agent ${name}`);
    }
    // Coffee is for closers.
    const closers: (() => void)[] = [];
    const pipe = () => new TransformStream<Uint8Array, Uint8Array>({
      start: (controller) => { closers.push(() => controller.terminate()); },
    });
    const toAgent = pipe();
    const toClient = pipe();
    let connection: unknown;
    try { connection = script().connect(ndJsonStream(toClient.writable, toAgent.readable)); }
    catch (error) { for (const close of closers) { close(); } throw error; }
    const closed = connection && typeof connection === 'object' && 'closed' in connection && connection.closed instanceof Promise
      ? connection.closed as Promise<void> : undefined;

    // Like a process's stdio, both streams close when the agent exits.
    let finishExit: () => void = () => {};
    const exitReported = new Promise<void>((resolve) => { finishExit = resolve; });
    const exit = async (code: number | null, order: ExitOrder = 'output-then-exit'): Promise<void> => {
      if (launched.exited) { return launched.exitReported; }
      launched.exited = true;
      const closeOutput = () => { for (const close of closers) { close(); } };
      if (order === 'output-then-exit') {
        closeOutput();
        await new Promise<void>((resolve) => {
          setImmediate(() => {
            events.exit(code);
            resolve();
          });
        });
      } else {
        await new Promise<void>((resolve) => {
          setImmediate(() => {
            events.exit(code);
            setImmediate(() => {
              closeOutput();
              resolve();
            });
          });
        });
      }
      await closed;
      finishExit();
    };
    const process: AgentProcess = {
      id: `agent_${this.nextId++}`,
      input: toAgent.writable,
      output: toClient.readable,
      kill: () => {
        launched.killed = true;
        void exit(null);
      },
    };
    const launched: LaunchedAgent = { name, cwd, process, killed: false, exited: false, exitReported, crash: (code = 1, order) => exit(code, order) };
    this.launched.push(launched);
    return process;
  }

  /** The agents with this name that are still running. */
  running(name: string): LaunchedAgent[] {
    return this.launched.filter((l) => l.name === name && !l.exited);
  }
}

/**
 * A driver connected to the agent `script` builds, of the version they negotiate; the session updates it passes up,
 * as session ID and update, and the schema each was tagged with; and `exit`, which ends the agent as its process's
 * death would.
 */
export async function connectedDriver(
  script: AgentScript,
  handlers: ClientHandlers = unusedHandlers,
): Promise<{ driver: AcpDriver; updates: [string, SessionUpdate][]; schemas: AcpSchema[]; exit: () => Promise<void> }> {
  const agents = new InProcessAgents({ fake: script });
  const sessionUpdates = new SessionUpdateHandler();
  const exit = async () => {
    sessionUpdates.dispose();
    await Promise.all(agents.launched.map((agent) => agent.crash()));
  };
  onTestFinished(exit);
  const updates: [string, SessionUpdate][] = [];
  const schemas: AcpSchema[] = [];
  sessionUpdates.addListener((sessionId, update, schema) => {
    updates.push([sessionId, update]);
    schemas.push(schema);
  });
  const manager = new ConnectionManager(sessionUpdates, '0.0.0-test', () => handlers);
  const driver = await manager.connect('fake', agents.launch('fake', { command: 'fake' }, '/work', { error() {}, exit() {} }));
  return { driver, updates, schemas, exit };
}

/** An ACP v2 SDK agent with sessions that answers `initialize`; add the requests a test needs. */
export function fakeV2Agent(init: Partial<V2.InitializeResponse> = {}): V2.AgentApp {
  return V2.agent({ name: 'fake-agent' }).onRequest(V2.methods.agent.initialize, () => ({
    protocolVersion: V2.PROTOCOL_VERSION,
    info: { name: 'fake-agent', title: 'Fake Agent', version: '0.0.1' },
    capabilities: { session: {} },
    ...init,
  }));
}
