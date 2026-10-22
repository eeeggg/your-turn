import type { SessionUpdate, TerminalExitStatus } from '@/core/acp/AcpDriver';
import { Cleaner, forTerminal, type ShownOutput } from './CommandOutput';
import { log, messageOf } from './Log';

/** How much of a command's output is kept, the most recent. */
const KEPT_CHARACTERS = 10 * 1024 * 1024;

const EARLIER_NOT_KEPT = '[Earlier output was not kept]\r\n';
/** A full reset, which clears a VS Code terminal's screen and scrollback and the modes earlier output set. */
const RESET = '\x1bc';

/** What an agent has said of how one of its terminals' command ended. */
export interface TerminalInfo {
  exitStatus: TerminalExitStatus | null;
  /** Its session ended before the agent said its command ended. */
  disconnected: boolean;
}

/** One of an agent's terminals changed. */
export type TerminalListener = (sessionId: string, terminalId: string) => void;

/** Where a command's output comes from: an agent's terminal, or an `execute` tool call's text, which no terminal carries. */
export type CommandSource = { kind: 'terminal'; terminalId: string } | { kind: 'toolCall'; toolCallId: string };

/** A read-only VS Code terminal, which shows what it is written. */
interface TerminalDisplay {
  write(text: string): void;
  /** Brings it forward. */
  show(): void;
}

export interface TerminalDisplays {
  /** Opens a VS Code terminal and shows it; `closed` is called once the user closes it. */
  open(name: string, closed: () => void): TerminalDisplay;
}

type TerminalUpdate = Extract<SessionUpdate, { kind: 'terminal' }>;

/** A session's command output by source, and the VS Code terminals open on it, by `sourceKey`. */
interface SessionOutput {
  readonly terminals: Map<string, AgentTerminal>;
  readonly texts: Map<string, KeptOutput>;
  readonly displays: Map<string, TerminalDisplay>;
  ended: boolean;
}

/**
 * Commands' output by session: the terminals agents own, by ID, whether a tool call or the terminal's own updates
 * came first, and the text of `execute` tool calls; and the VS Code terminals the user opened on them, written live.
 */
export class AgentTerminals {
  private readonly sessions = new Map<string, SessionOutput>();
  private readonly listeners = new Set<TerminalListener>();

  constructor(private readonly displays: TerminalDisplays) {}

  addListener(listener: TerminalListener): void {
    this.listeners.add(listener);
  }

  handleSessionUpdate(sessionId: string, update: SessionUpdate): void {
    if (update.kind !== 'terminal' && update.kind !== 'terminalOutput') { return; }
    const terminal = this.terminal(sessionId, update.terminalId);
    const written = update.kind === 'terminal' ? terminal.update(update) : terminal.append(update.data);
    this.changed(sessionId, update.terminalId, written);
  }

  /** An `execute` tool call's text, all of its command's output so far, replacing what was kept. */
  keepCommandText(sessionId: string, toolCallId: string, text: string): void {
    const output = new KeptOutput();
    output.add(text);
    this.session(sessionId).texts.set(toolCallId, output);
    this.write(sessionId, { kind: 'toolCall', toolCallId }, RESET + output.written());
  }

  /** The session is gone, and with it its agent's word on the commands still running. */
  endSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) { return; }
    session.ended = true;
    for (const [terminalId, terminal] of session.terminals) {
      if (terminal.end()) {
        this.changed(sessionId, terminalId, '');
      }
    }
  }

  /** Forgets the sessions that ended, once nothing shows them for their output to be opened from. */
  forgetEndedSessions(): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.ended) {
        this.forgetSession(sessionId);
      }
    }
  }

  /** Forgets a session's output; VS Code terminals open on it stay, showing what they were written. */
  forgetSession(sessionId: string): void {
    for (const terminal of this.sessions.get(sessionId)?.terminals.values() ?? []) {
      terminal.dispose();
    }
    this.sessions.delete(sessionId);
  }

  info(sessionId: string, terminalId: string): TerminalInfo | undefined {
    return this.sessions.get(sessionId)?.terminals.get(terminalId)?.info;
  }

  /** What the chat view shows of a terminal's output. */
  shown(sessionId: string, terminalId: string): Promise<ShownOutput> | undefined {
    return this.sessions.get(sessionId)?.terminals.get(terminalId)?.shown();
  }

  /**
   * Opens a VS Code terminal showing all the output kept from a source, written live as it changes, or brings forward
   * the one open already; false when none is kept.
   */
  open(sessionId: string, source: CommandSource, name: string): boolean {
    const session = this.sessions.get(sessionId);
    const output = source.kind === 'terminal' ? session?.terminals.get(source.terminalId) : session?.texts.get(source.toolCallId);
    if (!session || !output) { return false; }
    const key = sourceKey(source);
    const open = session.displays.get(key);
    if (open) {
      open.show();
      return true;
    }
    const display = this.displays.open(name, () => {
      if (session.displays.get(key) === display) {
        session.displays.delete(key);
      }
    });
    display.write(output.written());
    session.displays.set(key, display);
    return true;
  }

  dispose(): void {
    for (const sessionId of this.sessions.keys()) {
      this.forgetSession(sessionId);
    }
    this.listeners.clear();
  }

  private session(sessionId: string): SessionOutput {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { terminals: new Map(), texts: new Map(), displays: new Map(), ended: false };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private terminal(sessionId: string, terminalId: string): AgentTerminal {
    const { terminals } = this.session(sessionId);
    let terminal = terminals.get(terminalId);
    if (!terminal) {
      terminal = new AgentTerminal();
      terminals.set(terminalId, terminal);
    }
    return terminal;
  }

  private changed(sessionId: string, terminalId: string, written: string): void {
    this.write(sessionId, { kind: 'terminal', terminalId }, written);
    for (const listener of this.listeners) {
      try {
        listener(sessionId, terminalId);
      } catch (e) {
        log(`Error in terminal listener: ${messageOf(e)}`);
      }
    }
  }

  private write(sessionId: string, source: CommandSource, written: string): void {
    if (written) {
      this.sessions.get(sessionId)?.displays.get(sourceKey(source))?.write(written);
    }
  }
}

function sourceKey(source: CommandSource): string {
  return source.kind === 'terminal' ? `terminal:${source.terminalId}` : `toolCall:${source.toolCallId}`;
}

/** A command's output, kept to the cap: the most recent. */
class KeptOutput {
  private kept: string[] = [];
  private keptLength = 0;
  private droppedEarlier = false;

  /** Earlier output was dropped to keep within the cap. */
  get dropped(): boolean {
    return this.droppedEarlier;
  }

  add(text: string): void {
    if (!text) { return; }
    this.kept.push(text);
    this.keptLength += text.length;
    while (this.keptLength > KEPT_CHARACTERS) {
      const over = this.keptLength - KEPT_CHARACTERS;
      const first = this.kept[0] ?? '';
      if (first.length <= over) {
        this.kept.shift();
        this.keptLength -= first.length;
      } else {
        this.kept[0] = first.slice(over);
        this.keptLength -= over;
      }
      this.droppedEarlier = true;
    }
  }

  text(): string {
    return this.kept.join('');
  }

  /** What a VS Code terminal opened now is written, to show all of it. */
  written(): string {
    return (this.droppedEarlier ? EARLIER_NOT_KEPT : '') + forTerminal(this.text());
  }
}

/**
 * One terminal: its output decoded as it streams, so a character split between chunks is joined, and kept to a cap;
 * cleaned for the chat view by a cleaner of its own while its command runs, which ends once it has given its last.
 */
class AgentTerminal {
  readonly info: TerminalInfo = { exitStatus: null, disconnected: false };
  private decoder = new TextDecoder();
  private output = new KeptOutput();
  private cleaner: Cleaner | null = null;
  private last: Promise<ShownOutput> = Promise.resolve({ text: '', truncated: false });

  /** Applies an update, a field left out staying as it was, and returns what an open VS Code terminal is written. */
  update(update: TerminalUpdate): string {
    const written = update.output !== undefined ? this.replace(update.output ?? new Uint8Array()) : '';
    if (update.exitStatus !== undefined) {
      this.info.exitStatus = update.exitStatus;
      if (!this.running()) { this.finish(); }
    }
    return written;
  }

  append(data: Uint8Array): string {
    const text = this.decoder.decode(data, { stream: true });
    this.output.add(text);
    this.clean(text);
    return forTerminal(text);
  }

  /** Whether the terminal's command was still running, which it now never will be as far as anyone can tell. */
  end(): boolean {
    if (!this.running()) { return false; }
    this.info.disconnected = true;
    this.finish();
    return true;
  }

  async shown(): Promise<ShownOutput> {
    const dropped = this.output.dropped;
    const shown = await (this.cleaner?.shown() ?? this.last);
    return dropped ? { ...shown, truncated: true } : shown;
  }

  written(): string {
    return this.output.written();
  }

  dispose(): void {
    this.cleaner?.dispose();
    this.cleaner = null;
  }

  private running(): boolean {
    return this.info.exitStatus === null && !this.info.disconnected;
  }

  /** A snapshot: all the output so far, so it starts afresh, decoder and cleaner too. */
  private replace(data: Uint8Array): string {
    this.decoder = new TextDecoder();
    this.output = new KeptOutput();
    this.dispose();
    const text = this.decoder.decode(data, { stream: true });
    this.output.add(text);
    this.clean(text);
    return RESET + this.written();
  }

  /** A cleaner made after its terminal's start is fed all the output kept, which ends with `added`. */
  private clean(added: string): void {
    if (this.cleaner) {
      this.cleaner.write(added);
    } else {
      this.cleaner = new Cleaner();
      this.cleaner.write(this.output.text());
    }
    if (!this.running()) { this.finish(); }
  }

  private finish(): void {
    const cleaner = this.cleaner;
    if (!cleaner) { return; }
    this.cleaner = null;
    this.last = cleaner.shown().finally(() => cleaner.dispose());
  }
}
