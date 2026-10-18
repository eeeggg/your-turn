import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
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
 * Escape a single argument for safe inclusion in a shell command string.
 * Wraps in single quotes, escaping any embedded single quotes.
 */
function shellEscape(arg: string): string {
  // Replace ' with '\'' (end quote, escaped quote, start quote)
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Determine the appropriate shell and whether it supports the -l (login) flag
 * on macOS/Linux. A login shell sources the user's profile (~/.zshrc,
 * ~/.bash_profile, etc.) so that PATH includes nvm, Homebrew, and other
 * user-installed tool directories.
 *
 * Shell support:
 *   zsh, bash, ksh  →  -l supported
 *   fish, sh, dash  →  use as-is without -l (fish auto-loads config;
 *                      sh/dash don't support -l reliably)
 *   csh, tcsh, etc. →  not POSIX-compatible; fall back to bash or /bin/sh
 */
function resolveUnixShell(): { shell: string; useLoginFlag: boolean } {
  const userShell = process.env['SHELL'];

  if (userShell) {
    const base = userShell.split('/').pop() || '';

    // POSIX-compatible shells that support -l (login) flag
    if (['zsh', 'bash', 'ksh'].includes(base)) {
      return { shell: userShell, useLoginFlag: true };
    }

    // fish auto-loads config without -l; sh/dash are POSIX-compatible but
    // don't support -l reliably
    if (['fish', 'sh', 'dash'].includes(base)) {
      return { shell: userShell, useLoginFlag: false };
    }

    // Non-POSIX shells (csh, tcsh, etc.) — fall back to a known POSIX shell
    log(`User shell "${userShell}" is not POSIX-compatible, falling back to bash/sh`);
  }

  // $SHELL not set or not POSIX-compatible — probe for common shells
  if (existsSync('/bin/bash')) {
    return { shell: '/bin/bash', useLoginFlag: true };
  }
  if (existsSync('/usr/bin/bash')) {
    return { shell: '/usr/bin/bash', useLoginFlag: true };
  }
  // Ultimate fallback
  return { shell: '/bin/sh', useLoginFlag: false };
}

function spawnAgent(config: AgentConfigEntry, cwd: string) {
  const env = { ...process.env, ...(config.env || {}) };
  if (process.platform === 'win32') {
    // On Windows, commands like npx are batch scripts (.cmd) that require
    // shell resolution via cmd.exe.
    return spawn(config.command, config.args || [], { stdio: ['pipe', 'pipe', 'pipe'], env, cwd, shell: true });
  }

  // On macOS/Linux, use the user's login shell so that PATH includes
  // nvm, Homebrew, and other user-installed tool directories.
  const { shell, useLoginFlag } = resolveUnixShell();
  const commandStr = [config.command, ...(config.args || [])].map(shellEscape).join(' ');
  const shellArgs = useLoginFlag ? ['-l', '-c', commandStr] : ['-c', commandStr];

  log(`Using shell: ${shell} ${shellArgs.join(' ')}`);
  return spawn(shell, shellArgs, { stdio: ['pipe', 'pipe', 'pipe'], env, cwd });
}

function stop(name: string, child: ChildProcess): void {
  log(`Killing agent "${name}"`);
  try {
    child.kill('SIGTERM');
    // Force kill after 5s if still running
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }, 5000);
  } catch (e) {
    logError(`Failed to kill agent "${name}"`, e);
  }
}

/** Launches agents as child processes, talking to them over stdio. */
export class AgentManager implements AgentLauncher {
  private nextId = 1;

  launch(name: string, config: AgentConfigEntry, cwd: string, events: AgentProcessEvents): AgentProcess {
    const id = `agent_${this.nextId++}`;
    log(`Spawning agent "${name}" (${id}): ${config.command} ${(config.args || []).join(' ')}`);

    const child = spawnAgent(config, cwd);

    child.stderr.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        log(`[${name} stderr] ${line}`);
      }
    });

    child.on('error', (err) => {
      logError(`Agent "${name}" process error`, err);
      events.error(err);
    });

    child.on('close', (code, signal) => {
      log(`Agent "${name}" exited (code=${code}, signal=${signal})`);
      events.exit(code);
    });

    return {
      id,
      input: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      output: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      kill: () => stop(name, child),
    };
  }
}
