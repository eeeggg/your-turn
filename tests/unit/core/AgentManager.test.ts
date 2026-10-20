import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentManager, findOnPath, type AgentConfigEntry, type AgentProcess } from '@/core/AgentManager';

/** Launch a Node script as the agent and record what the launcher reports. */
function launch(script: string, options: { env?: Record<string, string>; cwd?: string } = {}) {
  const reports: string[] = [];
  let reportExit: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolve) => { reportExit = resolve; });
  const config: AgentConfigEntry = {
    command: process.execPath,
    args: ['-e', script],
    ...(options.env ? { env: options.env } : {}),
  };
  const agent = new AgentManager().launch('test-agent', config, options.cwd ?? process.cwd(), {
    error: (error) => reports.push(`error: ${error.message}`),
    exit: (code) => {
      reports.push(`exit: ${String(code)}`);
      reportExit(code);
    },
  });
  return { agent, reports, exited };
}

/** Read the agent's output until `done` holds for everything read so far. */
async function readUntil(agent: AgentProcess, done: (text: string) => boolean): Promise<string> {
  const reader = agent.output.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (!done(text)) {
      const { value, done: ended } = await reader.read();
      if (ended) {
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('AgentManager', () => {
  it('carries messages over the agent\'s stdin and stdout', async () => {
    const { agent } = launch('process.stdin.pipe(process.stdout)');

    const writer = agent.input.getWriter();
    await writer.write(new TextEncoder().encode('{"jsonrpc":"2.0"}\n'));
    writer.releaseLock();

    expect(await readUntil(agent, (text) => text.includes('\n'))).toBe('{"jsonrpc":"2.0"}\n');
    agent.kill();
  });

  it('reports the exit code of an agent that exits', async () => {
    const { reports, exited } = launch('process.exitCode = 3');

    expect(await exited).toBe(3);
    expect(reports).toEqual(['exit: 3']);
  });

  it('runs the agent with its configured environment in the working directory', async () => {
    const cwd = realpathSync(tmpdir());
    const { agent } = launch('process.stdout.write(process.env.ACP_TEST + " " + process.cwd())', {
      env: { ACP_TEST: 'set' },
      cwd,
    });

    expect(await readUntil(agent, () => false)).toBe(`set ${cwd}`);
  });

  it('reports an agent that cannot start, then its exit with no code', async () => {
    const { reports, exited } = launch('', { cwd: '/nonexistent/acp-test' });

    expect(await exited).toBeNull();
    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatch(/^error: .*ENOENT/s);
    expect(reports[1]).toBe('exit: null');
  });

  it('stops the agent and every process it started when killed', async () => {
    const { agent, exited } = launch(
      "const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);" +
      "process.stdout.write(child.pid + '\\n'); setInterval(() => {}, 1000)",
    );
    const pid = Number(await readUntil(agent, (text) => text.includes('\n')));
    expect(isRunning(pid)).toBe(true);

    agent.kill();

    expect(await exited).toBeNull();
    await until(() => !isRunning(pid));
  });
});

describe('findOnPath', () => {
  let bin: string;

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), 'acp-path-'));
    vi.stubEnv('PATH', ['/nonexistent/acp-test', bin].join(delimiter));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(bin, { recursive: true, force: true });
  });

  it('gives the full path of an executable on the PATH VS Code sees', async () => {
    writeFileSync(join(bin, 'opencode'), '#!/bin/sh\n', { mode: 0o755 });

    expect(await findOnPath('opencode')).toBe(join(bin, 'opencode'));
  });

  it('finds nothing for a command missing from the PATH, or a file there that is not executable', async () => {
    writeFileSync(join(bin, 'notes'), 'not a program', { mode: 0o644 });

    expect(await findOnPath('opencode')).toBeUndefined();
    expect(await findOnPath('notes')).toBeUndefined();
  });
});
