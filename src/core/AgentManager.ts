import { Readable, Writable } from 'node:stream';
import { execa } from 'execa';
import { log, logError } from './Log';

/**
 * Configuration for a single ACP agent.
 */
export interface AgentConfigEntry {
  /** NPX package to run (e.g., "@anthropic-ai/claude-code@latest") */
  command: string;
  /** Command-line arguments */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Display name */
  displayName?: string;
}

/** A running agent's stdin and stdout, which carry newline-delimited ACP messages. */
export interface AgentStreams {
  readonly input: WritableStream<Uint8Array>;
  readonly output: ReadableStream<Uint8Array>;
}

export interface AgentProcess extends AgentStreams {
  readonly id: string;
  /** Ask the agent to stop; its `exit` event follows. */
  kill(): void;
}

/** What happens to one launched agent. */
export interface AgentProcessEvents {
  error(error: Error): void;
  exit(code: number | null): void;
}

export interface AgentLauncher {
  launch(name: string, config: AgentConfigEntry, cwd: string, events: AgentProcessEvents): AgentProcess;
}

/**
 * Launches agents as child processes, talking to them over stdio.
 *
 * The command runs directly, without a shell. Its `PATH` is the extension
 * host's, which VS Code resolves from the user's login shell, so tools installed
 * through nvm or Homebrew are found.
 */
export class AgentManager implements AgentLauncher {
  private nextId = 1;

  launch(name: string, config: AgentConfigEntry, cwd: string, events: AgentProcessEvents): AgentProcess {
    const id = `agent_${this.nextId++}`;
    log(`Spawning agent "${name}" (${id}): ${config.command} ${(config.args || []).join(' ')}`);

    const subprocess = execa(config.command, config.args ?? [], {
      cwd,
      env: config.env ?? {},
      // An agent runs for as long as its session; its stdout is the connection, not a result.
      buffer: false,
      reject: false,
      killDescendants: true,
    });

    subprocess.stderr.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        log(`[${name} stderr] ${line}`);
      }
    });

    void subprocess.then((result) => {
      if (result.exitCode === undefined && result.signal === undefined) {
        const error = new Error(result.shortMessage);
        logError(`Agent "${name}" failed to start`, error);
        events.error(error);
      }
      log(`Agent "${name}" exited (code=${result.exitCode}, signal=${result.signal})`);
      events.exit(result.exitCode ?? null);
    });

    return {
      id,
      input: Writable.toWeb(subprocess.stdin) as WritableStream<Uint8Array>,
      output: Readable.toWeb(subprocess.stdout) as ReadableStream<Uint8Array>,
      kill: () => {
        log(`Killing agent "${name}"`);
        subprocess.kill();
      },
    };
  }
}
