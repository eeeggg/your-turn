import type { TerminalExitStatus, ToolCallContent, ToolKind } from '@/core/acp/AcpDriver';
import type { AgentTerminals } from '@/core/AgentTerminals';
import { cleaned, type ShownOutput } from '@/core/CommandOutput';
import { logError } from '@/core/Log';

/** A terminal's changes within this many milliseconds reach the chat view as one message. */
const TERMINAL_POST_INTERVAL_MS = 250;

/** A tool call's content as the chat view shows it: a command's text is its output, cleaned. */
export type ShownContent = ToolCallContent | { kind: 'commandOutput'; output: ShownOutput };

/** Where the feed sends what it has cleaned; the chat view drops what is not about the session it shows. */
export interface CommandOutputSink {
  /** A command's content with its text cleaned, replacing what its tool call shows. */
  toolCallContent(sessionId: string, toolCallId: string, content: ShownContent[]): void;
  /** A terminal changed: the end of its output as the chat view shows it, and how its command ended, if it has. */
  terminal(sessionId: string, terminalId: string, output: ShownOutput, exitStatus: TerminalExitStatus | null): void;
}

/** A session's `execute` tool calls, as later updates leave the kind out. */
interface SessionCommands {
  readonly toolCalls: Set<string>;
  /** How many times each command's content was given, so text cleaned late is sent only if still the latest. */
  readonly contentVersions: Map<string, number>;
}

/**
 * Feeds the chat view commands' output, cleaned as a terminal shows it: agents' terminals as they change, and the
 * text of `execute` tool calls, which is a command's output whichever way the agent sent it, kept for Open too.
 */
export class CommandOutputFeed {
  private readonly sessions = new Map<string, SessionCommands>();
  private readonly pendingTerminals = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pending = new Set<Promise<void>>();
  private disposed = false;
  private disposal: Promise<void> | undefined;
  private readonly terminalListener = (sessionId: string, terminalId: string) => this.terminalChanged(sessionId, terminalId);

  constructor(
    private readonly terminals: AgentTerminals,
    private readonly sink: CommandOutputSink,
  ) {
    terminals.addListener(this.terminalListener);
  }

  /**
   * The content to show with a tool call now; undefined, leaving it out, when it holds a command's text, which goes to
   * the sink once cleaned, unless newer content came meanwhile.
   */
  toolCallContent(
    sessionId: string,
    toolCallId: string,
    toolKind: ToolKind | undefined,
    content: ToolCallContent[] | undefined,
  ): ShownContent[] | undefined {
    if (this.disposed) { return undefined; }
    const { toolCalls, contentVersions } = this.commandsOf(sessionId);
    if (toolKind !== undefined) {
      if (toolKind === 'execute') { toolCalls.add(toolCallId); } else { toolCalls.delete(toolCallId); }
    }
    if (content === undefined || !toolCalls.has(toolCallId)) {
      return content;
    }
    const version = (contentVersions.get(toolCallId) ?? 0) + 1;
    contentVersions.set(toolCallId, version);
    const texts = content.flatMap((item) => (item.kind === 'text' ? [item.text] : []));
    if (texts.length === 0) {
      return content;
    }
    this.terminals.keepCommandText(sessionId, toolCallId, texts.join('\n'));
    const posting = Promise.allSettled(content.map(commandOutput)).then(
      (results) => {
        const shown = results.map((result) => {
          if (result.status === 'rejected') { throw result.reason; }
          return result.value;
        });
        if (!this.disposed && contentVersions.get(toolCallId) === version) {
          this.sink.toolCallContent(sessionId, toolCallId, shown);
        }
      },
    );
    this.track(posting, `Failed to clean the output of tool call ${toolCallId}`);
    return undefined;
  }

  /** The session is gone, and its tool calls with it. */
  forgetSession(sessionId: string): void {
    this.sessions.get(sessionId)?.contentVersions.clear();
    this.sessions.delete(sessionId);
  }

  dispose(): Promise<void> {
    if (this.disposal) { return this.disposal; }
    this.disposed = true;
    this.terminals.removeListener(this.terminalListener);
    for (const timer of this.pendingTerminals.values()) { clearTimeout(timer); }
    this.pendingTerminals.clear();
    this.sessions.clear();
    this.disposal = Promise.allSettled(this.pending).then((results) => {
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length > 0) {
        throw new AggregateError(failures.map((result) => result.reason as unknown), 'Failed to dispose command output');
      }
    });
    return this.disposal;
  }

  private track(work: Promise<void>, failure: string): void {
    this.pending.add(work);
    void work.then(
      () => this.pending.delete(work),
      (e: unknown) => { logError(failure, e); this.pending.delete(work); },
    );
  }

  private commandsOf(sessionId: string): SessionCommands {
    let commands = this.sessions.get(sessionId);
    if (!commands) {
      commands = { toolCalls: new Set(), contentVersions: new Map() };
      this.sessions.set(sessionId, commands);
    }
    return commands;
  }

  private terminalChanged(sessionId: string, terminalId: string): void {
    if (this.disposed) { return; }
    const pendingKey = JSON.stringify([sessionId, terminalId]);
    if (this.pendingTerminals.has(pendingKey)) { return; }
    this.pendingTerminals.set(pendingKey, setTimeout(() => {
      this.pendingTerminals.delete(pendingKey);
      this.track(this.sendTerminal(sessionId, terminalId), `Failed to show terminal ${terminalId}`);
    }, TERMINAL_POST_INTERVAL_MS));
  }

  private async sendTerminal(sessionId: string, terminalId: string): Promise<void> {
    const info = this.terminals.info(sessionId, terminalId);
    const shown = this.terminals.shown(sessionId, terminalId);
    if (!info || !shown) { return; }
    const output = await shown;
    if (!this.disposed) { this.sink.terminal(sessionId, terminalId, output, info.exitStatus); }
  }
}

async function commandOutput(item: ToolCallContent): Promise<ShownContent> {
  return item.kind === 'text' ? { kind: 'commandOutput', output: await cleaned(item.text) } : item;
}
