import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { AgentApp, InitializeResponse } from '@agentclientprotocol/sdk';
import type { AgentConfigEntry, AgentLauncher, AgentProcess, AgentProcessEvents } from '@/core/AgentManager';

/** Builds the agent a launch talks to; called once per launch. */
export type AgentScript = () => AgentApp;

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
  /** The process dies on its own, without being killed. */
  crash(code?: number): void;
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
    const closers: (() => void)[] = [];
    const pipe = () => new TransformStream<Uint8Array, Uint8Array>({
      start: (controller) => { closers.push(() => controller.terminate()); },
    });
    const toAgent = pipe();
    const toClient = pipe();
    script().connect(ndJsonStream(toClient.writable, toAgent.readable));

    // Like a process's stdio, both streams close when the agent exits.
    const exit = (code: number | null) => {
      if (launched.exited) { return; }
      launched.exited = true;
      for (const close of closers) { close(); }
      setImmediate(() => events.exit(code));
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
    const launched: LaunchedAgent = { name, cwd, process, killed: false, exited: false, crash: (code = 1) => exit(code) };
    this.launched.push(launched);
    return process;
  }

  /** The agents with this name that are still running. */
  running(name: string): LaunchedAgent[] {
    return this.launched.filter((l) => l.name === name && !l.exited);
  }
}
