import { execa, ExecaError, type Subprocess } from 'execa';
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  TerminalExitStatus,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
} from '@agentclientprotocol/sdk';
import type { Terminals } from './ClientHandlers';
import { log } from './Log';

/** Shows one terminal's output to the user as it arrives. */
export interface TerminalDisplay {
  write(text: string): void;
  dispose(): void;
}

export interface TerminalDisplays {
  /** Open a display named `title` that starts by showing the command line it runs. */
  open(title: string, commandLine: string): TerminalDisplay;
}

const DEFAULT_OUTPUT_BYTE_LIMIT = 1024 * 1024;

/** The most recent output, at most a byte limit, cut at a UTF-8 character boundary. */
class OutputBuffer {
  private bytes = Buffer.alloc(0);
  truncated = false;

  constructor(private readonly byteLimit: number) {}

  append(chunk: Buffer): void {
    let bytes = Buffer.concat([this.bytes, chunk]);
    if (bytes.length > this.byteLimit) {
      let start = bytes.length - this.byteLimit;
      while (start < bytes.length && isContinuationByte(bytes.readUInt8(start))) {
        start++;
      }
      bytes = bytes.subarray(start);
      this.truncated = true;
    }
    this.bytes = bytes;
  }

  text(): string {
    return this.bytes.toString('utf8');
  }
}

function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

interface Terminal {
  readonly subprocess: Pick<Subprocess, 'kill'>;
  readonly output: OutputBuffer;
  readonly display: TerminalDisplay;
  readonly exited: Promise<TerminalExitStatus>;
  exitStatus?: TerminalExitStatus;
}

/**
 * Terminals the agent creates, each a command run in a child process. The agent
 * reads the output; the user watches it in a display.
 *
 * A command sent with arguments is a program, run with exactly those arguments.
 * A command sent alone is a whole command line, such as `npm test && npm run lint`,
 * and runs in the shell as written.
 */
export class ProcessTerminals implements Terminals {
  private readonly terminals = new Map<string, Terminal>();
  private nextId = 1;

  constructor(private readonly displays: TerminalDisplays) {}

  async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    const terminalId = `term_${this.nextId++}`;
    const args = params.args ?? [];
    const commandLine = [params.command, ...args].join(' ');
    log(`createTerminal: ${commandLine} (id=${terminalId})`);

    const subprocess = execa(params.command, args, {
      ...(params.cwd ? { cwd: params.cwd } : {}),
      env: Object.fromEntries((params.env ?? []).map((variable) => [variable.name, variable.value])),
      shell: args.length === 0,
      // A long-running command must not be stopped for its output size; OutputBuffer keeps what the agent reads.
      buffer: false,
      reject: false,
      killDescendants: true,
    });
    const output = new OutputBuffer(params.outputByteLimit ?? DEFAULT_OUTPUT_BYTE_LIMIT);
    const display = this.displays.open(`ACP: ${params.command}`, commandLine);

    for (const stream of [subprocess.stdout, subprocess.stderr]) {
      const decoder = new TextDecoder();
      stream.on('data', (chunk: Buffer) => {
        output.append(chunk);
        display.write(decoder.decode(chunk, { stream: true }));
      });
    }

    const exited = subprocess.then((result) => {
      if (result instanceof ExecaError && result.exitCode === undefined && result.signal === undefined) {
        log(`Terminal ${terminalId} failed to start: ${result.shortMessage}`);
        output.append(Buffer.from(`${result.shortMessage}\n`));
        display.write(`${result.shortMessage}\n`);
      }
      const exitStatus = { exitCode: result.exitCode ?? null, signal: result.signal ?? null };
      terminal.exitStatus = exitStatus;
      return exitStatus;
    });

    const terminal: Terminal = { subprocess, output, display, exited };
    this.terminals.set(terminalId, terminal);
    return { terminalId };
  }

  async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    const terminal = this.get(params.terminalId);
    return {
      output: terminal.output.text(),
      truncated: terminal.output.truncated,
      ...(terminal.exitStatus ? { exitStatus: terminal.exitStatus } : {}),
    };
  }

  async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    return this.get(params.terminalId).exited;
  }

  /** Stop the command and every process it started, forcibly if it is still running after five seconds. */
  async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    this.get(params.terminalId).subprocess.kill();
    return {};
  }

  /** Stop the command if it is still running and forget the terminal; its display stays open. */
  async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    log(`releaseTerminal: ${params.terminalId}`);
    this.get(params.terminalId).subprocess.kill();
    this.terminals.delete(params.terminalId);
    return {};
  }

  dispose(): void {
    for (const terminal of this.terminals.values()) {
      terminal.subprocess.kill('SIGKILL');
    }
    this.terminals.clear();
  }

  private get(terminalId: string): Terminal {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }
    return terminal;
  }
}
