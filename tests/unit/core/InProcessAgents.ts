import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { AgentApp, InitializeResponse } from '@agentclientprotocol/sdk';
import * as V2 from '@agentclientprotocol/sdk/experimental/v2';
import type { AcpDriver, SessionUpdate } from '@/core/acp/AcpDriver';
import { ConnectionManager } from '@/core/acp/ConnectionManager';
import { V2Driver } from '@/core/acp/V2Driver';
import type { AgentConfigEntry, AgentLauncher, AgentProcess, AgentProcessEvents } from '@/core/AgentManager';
import type { ClientHandlers } from '@/core/ClientHandlers';
import { SessionUpdateHandler } from '@/core/SessionUpdateHandler';

/** Builds the agent a launch talks to; called once per launch. */
export type AgentScript = () => AgentApp;

const unused = (): never => {
  throw new Error('not used by these tests');
};

/** Client handlers for agents that never call them. */
export const unusedHandlers: ClientHandlers = {
  permissions: { requestPermission: unused },
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
  /** The process dies on its own, without being killed; a null code is a death by signal. */
  crash(code?: number | null, order?: ExitOrder): void;
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
    script().connect(ndJsonStream(toClient.writable, toAgent.readable));

    // Like a process's stdio, both streams close when the agent exits.
    const exit = (code: number | null, order: ExitOrder = 'output-then-exit') => {
      if (launched.exited) { return; }
      launched.exited = true;
      const closeOutput = () => { for (const close of closers) { close(); } };
      if (order === 'output-then-exit') {
        closeOutput();
        setImmediate(() => events.exit(code));
      } else {
        setImmediate(() => {
          events.exit(code);
          setImmediate(closeOutput);
        });
      }
    };
    const process: AgentProcess = {
      id: `agent_${this.nextId++}`,
      input: toAgent.writable,
      output: toClient.readable,
      kill: () => {
        launched.killed = true;
        exit(null);
      },
    };
    const launched: LaunchedAgent = { name, cwd, process, killed: false, exited: false, crash: (code = 1, order) => exit(code, order) };
    this.launched.push(launched);
    return process;
  }

  /** The agents with this name that are still running. */
  running(name: string): LaunchedAgent[] {
    return this.launched.filter((l) => l.name === name && !l.exited);
  }
}

/** A driver connected to the agent `script` builds, and the session updates it passes up, as session ID and update. */
export async function connectedDriver(
  script: AgentScript,
  handlers: ClientHandlers = unusedHandlers,
): Promise<{ driver: AcpDriver; updates: [string, SessionUpdate][] }> {
  const agents = new InProcessAgents({ fake: script });
  const sessionUpdates = new SessionUpdateHandler();
  const updates: [string, SessionUpdate][] = [];
  sessionUpdates.addListener((sessionId, update) => updates.push([sessionId, update]));
  const manager = new ConnectionManager(sessionUpdates, '0.0.0-test', () => handlers);
  const driver = await manager.connect('fake', agents.launch('fake', { command: 'fake' }, '/work', { error() {}, exit() {} }));
  return { driver, updates };
}

/** Builds the ACP v2 agent a test talks to. */
export type V2AgentScript = () => V2.AgentApp;

/** An ACP v2 SDK agent with sessions that answers `initialize`; add the requests a test needs. */
export function fakeV2Agent(init: Partial<V2.InitializeResponse> = {}): V2.AgentApp {
  return V2.agent({ name: 'fake-agent' }).onRequest(V2.methods.agent.initialize, () => ({
    protocolVersion: V2.PROTOCOL_VERSION,
    info: { name: 'fake-agent', title: 'Fake Agent', version: '0.0.1' },
    capabilities: { session: {} },
    ...init,
  }));
}

/**
 * A v2 driver connected to the agent `script` builds, over in-memory newline-delimited streams; the session updates it
 * passes up, as session ID and update; and `exit`, which closes both streams as the agent's exit would.
 */
export async function connectedV2Driver(
  script: V2AgentScript,
): Promise<{ driver: AcpDriver; updates: [string, SessionUpdate][]; exit: () => void }> {
  const sessionUpdates = new SessionUpdateHandler();
  const updates: [string, SessionUpdate][] = [];
  sessionUpdates.addListener((sessionId, update) => updates.push([sessionId, update]));
  const closers: (() => void)[] = [];
  const pipe = () => new TransformStream<Uint8Array, Uint8Array>({
    start: (controller) => { closers.push(() => controller.terminate()); },
  });
  const toAgent = pipe();
  const toClient = pipe();
  script().connect(V2.ndJsonStream(toClient.writable, toAgent.readable));
  const driver = await V2Driver.connect('fake', V2.ndJsonStream(toAgent.writable, toClient.readable), '0.0.0-test', sessionUpdates);
  return { driver, updates, exit: () => { for (const close of closers) { close(); } } };
}
