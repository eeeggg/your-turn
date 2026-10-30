import { existsSync, mkdtempSync, realpathSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { AgentManager, findOnPath, renamesBetween, type AgentConfigEntry, type AgentProcess } from '@/core/AgentManager';

/** Launch a Node script as the agent and record what the launcher reports. */
function launch(script: string, options: { env?: Record<string, string>; cwd?: string } = {}) {
  const reports: string[] = [];
  let finished = false;
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
      finished = true;
      reports.push(`exit: ${String(code)}`);
      reportExit(code);
    },
  });
  onTestFinished(async () => {
    if (!finished) { agent.kill(); }
    await exited;
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

describe('AgentManager', () => {
  it('carries messages over the agent\'s stdin and stdout', async () => {
    const { agent, exited } = launch('process.stdin.pipe(process.stdout)');

    const writer = agent.input.getWriter();
    try {
      await writer.write(new TextEncoder().encode('{"jsonrpc":"2.0"}\n'));
    } finally {
      writer.releaseLock();
    }

    expect(await readUntil(agent, (text) => text.includes('\n'))).toBe('{"jsonrpc":"2.0"}\n');
    agent.kill();
    await exited;
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
    const directory = mkdtempSync(join(tmpdir(), 'acp-process-group-'));
    const watchers: { close(): void }[] = [];
    // Finish processes before removing their files, including after a failed or timed-out test.
    onTestFinished(() => {
      for (const watcher of watchers) { watcher.close(); }
      rmSync(directory, { recursive: true, force: true });
    });
    const created = (name: string) => new Promise<void>((resolve) => {
      const watcher = watch(directory, (_event, file) => {
        if (file?.toString() === name && existsSync(join(directory, name))) {
          watcher.close();
          resolve();
        }
      });
      watchers.push(watcher);
    });
    const ready = created('ready');
    const stopped = created('stopped');
    const child = [
      "const fs = require('node:fs');",
      `process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(join(directory, 'stopped'))}, ''); process.exit(0); });`,
      `fs.writeFileSync(${JSON.stringify(join(directory, 'ready'))}, '');`,
      'setInterval(() => {}, 1000);',
    ].join('');
    // Inherited pipes keep the launcher's completion pending until the descendant exits too.
    const { agent, exited } = launch(
      `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: ['ignore', 'inherit', 'inherit'] }); setInterval(() => {}, 1000)`,
    );
    await ready;

    agent.kill();

    expect(await exited).toBeNull();
    await stopped;
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

describe('renamesBetween', () => {
  const opencode: AgentConfigEntry = { command: 'opencode', args: ['acp'], env: { A: '1', B: '2' } };
  const claude: AgentConfigEntry = { command: 'claude-code-acp' };

  it('finds a rename in a removed and an added name with the same command, arguments and environment', () => {
    const renamed = { command: 'opencode', args: ['acp'], env: { B: '2', A: '1' }, displayName: 'OpenCode' };

    expect(renamesBetween({ OpenCode: opencode, Claude: claude }, { Claude: claude, oc: renamed })).toEqual([{ from: 'OpenCode', to: 'oc' }]);
  });

  it('finds a rename beside an unchanged name with the same entry', () => {
    expect(renamesBetween({ OpenCode: opencode, other: opencode }, { oc: opencode, other: opencode })).toEqual([{ from: 'OpenCode', to: 'oc' }]);
  });

  it.each<[string, Record<string, AgentConfigEntry>, Record<string, AgentConfigEntry>]>([
    ['the command changed', { OpenCode: opencode }, { oc: { ...opencode, command: 'opencode-beta' } }],
    ['the arguments changed', { OpenCode: opencode }, { oc: { ...opencode, args: ['acp', '--verbose'] } }],
    ['the environment changed', { OpenCode: opencode }, { oc: { ...opencode, env: { A: '1', B: '3' } } }],
    ['two names take the entry', { OpenCode: opencode }, { oc: opencode, oc2: opencode }],
    ['two names with the entry are removed', { OpenCode: opencode, other: opencode }, { oc: opencode }],
    ['a name is only removed', { OpenCode: opencode, Claude: claude }, { Claude: claude }],
    ['a name is only added', { Claude: claude }, { Claude: claude, OpenCode: opencode }],
    ['a name resolves to another entry', { OpenCode: opencode }, { OpenCode: claude }],
  ])('finds none when %s', (_, before, after) => {
    expect(renamesBetween(before, after)).toEqual([]);
  });
});
