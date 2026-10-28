import { Readable, Writable } from 'node:stream';
import { execa } from 'execa';
import which from 'which';
import { logDebug, logError, logTrace } from './Log';

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

/**
 * An agent that could not start. `code` is Node's error code: `ENOENT` when
 * the command is not on the `PATH`, though also when the working directory
 * does not exist.
 */
export class LaunchError extends Error {
  constructor(message: string | undefined, readonly code: string | undefined) {
    super(message);
    this.name = 'LaunchError';
  }
}

/** The `PATH` agents are launched with: the extension host's, which can differ from a terminal's. */
export function launchPath(): string {
  return process.env['PATH'] ?? '';
}

/** Where `command` is on the {@link launchPath}, searched as launching it would search, if it is there. */
export async function findOnPath(command: string): Promise<string | undefined> {
  return (await which(command, { nothrow: true, path: launchPath() })) ?? undefined;
}

/**
 * Why a command cannot start, the same whether a package runner is checked
 * before an agent is added through it or an agent's command is launched.
 */
export function commandNotFound(command: string): string {
  return `"${command}" was not found: it is not installed, or it is installed where VS Code does not see it. The PATH VS Code sees: ${launchPath()}`;
}

/** What happens to one launched agent. */
export interface AgentProcessEvents {
  error(error: LaunchError): void;
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
    logDebug('Spawning agent', { agentName: name, processId: id, command: config.command, args: config.args ?? [] });

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
        logTrace('Agent stderr', { agentName: name, line });
      }
    });

    void subprocess.then((result) => {
      if (result.exitCode === undefined && result.signal === undefined) {
        const error = new LaunchError(result.shortMessage, result.code);
        logError(`Agent "${name}" failed to start`, error);
        events.error(error);
      }
      logDebug('Agent process exited', { agentName: name, exitCode: result.exitCode, signal: result.signal });
      events.exit(result.exitCode ?? null);
    });

    return {
      id,
      input: Writable.toWeb(subprocess.stdin) as WritableStream<Uint8Array>,
      output: Readable.toWeb(subprocess.stdout) as ReadableStream<Uint8Array>,
      kill: () => {
        logDebug('Killing agent', { agentName: name });
        subprocess.kill();
      },
    };
  }
}
