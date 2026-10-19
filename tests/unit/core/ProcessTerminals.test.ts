import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { CreateTerminalRequest } from '@agentclientprotocol/sdk';
import { ProcessTerminals, type TerminalDisplays } from '@/core/ProcessTerminals';

const node = process.execPath;

interface RecordedDisplay {
  title: string;
  commandLine: string;
  written: string[];
  disposed: boolean;
}

function setup() {
  const displays: RecordedDisplay[] = [];
  const recording: TerminalDisplays = {
    open(title, commandLine) {
      const display: RecordedDisplay = { title, commandLine, written: [], disposed: false };
      displays.push(display);
      return {
        write: (text) => display.written.push(text),
        dispose: () => { display.disposed = true; },
      };
    },
  };
  const terminals = new ProcessTerminals(recording);
  const create = async (request: Omit<CreateTerminalRequest, 'sessionId'>) =>
    (await terminals.createTerminal({ sessionId: 's1', ...request })).terminalId;
  const output = (terminalId: string) => terminals.terminalOutput({ sessionId: 's1', terminalId });
  const waitForExit = (terminalId: string) => terminals.waitForTerminalExit({ sessionId: 's1', terminalId });
  return { terminals, displays, create, output, waitForExit };
}

/** Run a Node script as the command, the way an agent would run a program with arguments. */
function nodeScript(script: string, ...args: string[]): Omit<CreateTerminalRequest, 'sessionId'> {
  return { command: node, args: ['-e', script, ...args] };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (done(value)) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out; last value: ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A shell command that starts a background `sleep`, prints its pid, and waits for it. */
const SLEEPER = 'sleep 30 & echo $!; wait';

// The command lines here are POSIX shell syntax.
describe.runIf(process.platform !== 'win32')('ProcessTerminals on POSIX', () => {
  it('reports the output and exit code of a command', async () => {
    const { create, output, waitForExit } = setup();
    const id = await create(nodeScript("process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 3"));

    expect(await waitForExit(id)).toEqual({ exitCode: 3, signal: null });
    const result = await output(id);
    expect(result.output).toContain('out');
    expect(result.output).toContain('err');
    expect(result).toMatchObject({ truncated: false, exitStatus: { exitCode: 3, signal: null } });
  });

  it('passes each argument to the program unchanged', async () => {
    const { create, output, waitForExit } = setup();
    const args = ["it's", 'a | b', '$HOME', ''];
    const id = await create(nodeScript('process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args));

    await waitForExit(id);
    expect(JSON.parse((await output(id)).output)).toEqual(args);
  });

  it('runs a whole command line sent as the command', async () => {
    const { create, output, waitForExit } = setup();
    const id = await create({ command: 'echo one && echo two' });

    await waitForExit(id);
    expect((await output(id)).output).toBe('one\ntwo\n');
  });

  it('runs a command sent with arguments as a program, not through the shell', async () => {
    const { create, output, waitForExit } = setup();
    const id = await create({ command: 'echo one && echo', args: ['two'] });

    expect(await waitForExit(id)).toEqual({ exitCode: null, signal: null });
    expect((await output(id)).output).toContain('ENOENT');
  });

  it('sets the requested environment variables and working directory', async () => {
    const { create, output, waitForExit } = setup();
    const cwd = realpathSync(tmpdir());
    const id = await create({
      ...nodeScript('process.stdout.write(process.env.ACP_TEST + " " + process.cwd())'),
      env: [{ name: 'ACP_TEST', value: 'set' }],
      cwd,
    });

    await waitForExit(id);
    expect((await output(id)).output).toBe(`set ${cwd}`);
  });

  it('leaves out the exit status while the command runs', async () => {
    const { terminals, create, output, waitForExit } = setup();
    const id = await create(nodeScript('setTimeout(() => {}, 30000)'));

    expect(await output(id)).not.toHaveProperty('exitStatus');

    await terminals.killTerminal({ sessionId: 's1', terminalId: id });
    expect(await waitForExit(id)).toEqual({ exitCode: null, signal: 'SIGTERM' });
    expect((await output(id)).exitStatus).toEqual({ exitCode: null, signal: 'SIGTERM' });
  });

  it('kills every process the command started', async () => {
    const { terminals, create, output, waitForExit } = setup();
    const id = await create({ command: SLEEPER });
    const pid = Number((await until(() => output(id), (r) => r.output.trim() !== '')).output);
    expect(isRunning(pid)).toBe(true);

    await terminals.killTerminal({ sessionId: 's1', terminalId: id });
    await waitForExit(id);

    await until(async () => isRunning(pid), (running) => !running);
  });

  it('keeps only the most recent output within the byte limit', async () => {
    const { create, output, waitForExit } = setup();
    const id = await create({ ...nodeScript("process.stdout.write('abcdef')"), outputByteLimit: 3 });

    await waitForExit(id);
    expect(await output(id)).toMatchObject({ output: 'def', truncated: true });
  });

  it('never splits a character when truncating', async () => {
    const { create, output, waitForExit } = setup();
    // Each é is two bytes; the last 5 bytes start halfway through one.
    const id = await create({ ...nodeScript("process.stdout.write('é'.repeat(10))"), outputByteLimit: 5 });

    await waitForExit(id);
    expect(await output(id)).toMatchObject({ output: 'éé', truncated: true });
  });

  it('shows the command line and its output in a display', async () => {
    const { displays, create, waitForExit } = setup();
    const id = await create({ command: 'echo', args: ['hello world'] });

    await waitForExit(id);
    expect(displays).toEqual([{ title: 'ACP: echo', commandLine: 'echo hello world', written: ['hello world\n'], disposed: false }]);
  });

  it('reports a command that cannot start, with no exit code', async () => {
    const { create, output, waitForExit } = setup();
    const id = await create({ command: 'echo', args: ['never'], cwd: '/nonexistent/acp-test' });

    expect(await waitForExit(id)).toEqual({ exitCode: null, signal: null });
    expect((await output(id)).output).toContain('ENOENT');
  });

  it('stops a running command on release, forgets the terminal and keeps its display', async () => {
    const { terminals, displays, create, output } = setup();
    const id = await create({ command: SLEEPER });
    const pid = Number((await until(() => output(id), (r) => r.output.trim() !== '')).output);

    await terminals.releaseTerminal({ sessionId: 's1', terminalId: id });

    await expect(output(id)).rejects.toThrow(`Terminal not found: ${id}`);
    await until(async () => isRunning(pid), (running) => !running);
    expect(displays[0]?.disposed).toBe(false);
  });

  it('stops every running command on dispose', async () => {
    const { terminals, create, output } = setup();
    const first = await create({ command: SLEEPER });
    const second = await create({ command: SLEEPER });
    const pids = await Promise.all([first, second].map(async (id) =>
      Number((await until(() => output(id), (r) => r.output.trim() !== '')).output)));

    terminals.dispose();

    await expect(output(first)).rejects.toThrow('Terminal not found');
    for (const pid of pids) {
      await until(async () => isRunning(pid), (running) => !running);
    }
  });

  it('rejects requests for a terminal it does not have', async () => {
    const { terminals } = setup();

    await expect(terminals.killTerminal({ sessionId: 's1', terminalId: 'term_9' })).rejects.toThrow('Terminal not found: term_9');
  });
});
