import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { TerminalExitStatus, ToolCallContent } from '@/core/acp/AcpDriver';
import { AgentTerminals } from '@/core/AgentTerminals';
import { Cleaner, type ShownOutput } from '@/core/CommandOutput';
import { CommandOutputFeed, type ShownContent } from '@/core/CommandOutputFeed';

type Sent =
  | ['toolCallContent', string, string, ShownContent[]]
  | ['terminal', string, string, ShownOutput, TerminalExitStatus | null];

function setup() {
  const written: string[] = [];
  const terminals = new AgentTerminals({ open: () => ({ write: (text) => written.push(text), show: () => {} }) });
  onTestFinished(async () => {
    const disposed = terminals.dispose();
    if (vi.isFakeTimers()) { await vi.runAllTimersAsync(); }
    await disposed;
  });
  const sent: Sent[] = [];
  const feed = new CommandOutputFeed(terminals, {
    toolCallContent: (sessionId, toolCallId, content) => sent.push(['toolCallContent', sessionId, toolCallId, content]),
    terminal: (sessionId, terminalId, output, exitStatus) => sent.push(['terminal', sessionId, terminalId, output, exitStatus]),
  });
  onTestFinished(async () => {
    const disposed = feed.dispose();
    if (vi.isFakeTimers()) { await vi.runAllTimersAsync(); }
    await disposed;
  });
  return { terminals, feed, sent, written };
}

const texts = (...items: string[]): ToolCallContent[] => items.map((text) => ({ kind: 'text', text }));
const output = (text: string, truncated = false): ShownContent => ({ kind: 'commandOutput', output: { text, truncated } });
const chunk = (terminalId: string, text: string) => ({ kind: 'terminalOutput' as const, terminalId, data: new TextEncoder().encode(text) });

/** Applies every task the terminal cleaner queued. */
const cleaningDone = () => vi.runAllTimersAsync();

describe('CommandOutputFeed', () => {
  it('drains accepted cleaning without posting after disposal and detaches from terminals', async () => {
    vi.useFakeTimers();
    const { feed, terminals, sent } = setup();
    feed.toolCallContent('s1', 'c1', 'execute', texts('pending'));
    terminals.handleSessionUpdate('s1', chunk('t1', 'pending terminal'));
    const disposed = feed.dispose();
    expect(feed.dispose()).toBe(disposed);
    terminals.handleSessionUpdate('s1', chunk('t1', ' after disposal'));
    expect(feed.toolCallContent('s1', 'late', 'execute', texts('late'))).toBeUndefined();
    await vi.runAllTimersAsync();
    await disposed;

    expect(sent).toEqual([]);
    expect(terminals.open('s1', { kind: 'toolCall', toolCallId: 'late' }, 'late')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('awaits terminal reads already started when disposed', async () => {
    vi.useFakeTimers();
    const { feed, terminals, sent } = setup();
    const read = vi.spyOn(terminals, 'shown');
    onTestFinished(() => { read.mockRestore(); });
    terminals.handleSessionUpdate('s1', chunk('t1', 'pending'));
    vi.advanceTimersByTime(250);
    expect(read).toHaveBeenCalledOnce();
    const disposed = feed.dispose();
    await vi.runAllTimersAsync();
    await disposed;
    expect(sent).toEqual([]);
  });

  it('drains sibling cleaners even when one output cannot be read', async () => {
    vi.useFakeTimers();
    const terminals = new AgentTerminals({ open: () => ({ write() {}, show() {} }) });
    const feed = new CommandOutputFeed(terminals, { toolCallContent() {}, terminal() {} });
    onTestFinished(async () => {
      const disposal = Promise.allSettled([feed.dispose(), terminals.dispose()]);
      await vi.runAllTimersAsync();
      await disposal;
    });
    const failure = new Error('cannot read output');
    const read = vi.spyOn(Cleaner.prototype, 'shown').mockRejectedValueOnce(failure);
    onTestFinished(() => { read.mockRestore(); });
    let siblingReleased = false;
    const dispose = Cleaner.prototype.dispose;
    const released = vi.spyOn(Cleaner.prototype, 'dispose').mockImplementation(function (this: Cleaner) {
      const completion = dispose.call(this);
      if (released.mock.calls.length === 2) {
        return completion.then(() => { siblingReleased = true; });
      }
      return completion;
    });
    onTestFinished(() => { released.mockRestore(); });
    feed.toolCallContent('s1', 'c1', 'execute', texts('broken', 'still parsing'));
    const disposed = feed.dispose();
    const checked = disposed.catch((error: unknown) => ({ error, siblingReleased }));
    await vi.runAllTimersAsync();
    const result = await checked;
    expect(result?.siblingReleased).toBe(true);
    expect(result?.error).toBeInstanceOf(AggregateError);
  });

  beforeEach(() => { onTestFinished(() => { vi.useRealTimers(); }); });

  describe("an execute tool call's text", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('holds it back, then sends it cleaned, as a terminal shows it', async () => {
      const { feed, sent } = setup();
      const diff: ToolCallContent = { kind: 'diff', diff: { kind: 'wholeFile', path: '/work/a.ts', oldText: null, newText: 'a' } };

      expect(feed.toolCallContent('s1', 'c1', 'execute', [...texts('\x1b[32mok\x1b[0m\nDownloading 5%\rDownloading done\n'), diff])).toBeUndefined();
      await cleaningDone();

      expect(sent).toEqual([['toolCallContent', 's1', 'c1', [output('ok\nDownloading done'), diff]]]);
    });

    it("remembers the kind when later updates leave it out, and forgets it when one changes it", async () => {
      const { feed, sent } = setup();

      feed.toolCallContent('s1', 'c1', 'execute', undefined);
      expect(feed.toolCallContent('s1', 'c1', undefined, texts('ran'))).toBeUndefined();
      expect(feed.toolCallContent('s2', 'c1', undefined, texts('other session'))).toEqual(texts('other session'));
      expect(feed.toolCallContent('s1', 'c1', 'other', texts('not a command now'))).toEqual(texts('not a command now'));
      await cleaningDone();

      expect(sent).toEqual([['toolCallContent', 's1', 'c1', [output('ran')]]]);
    });

    it('passes on at once what another tool call reports, or a command with no text', () => {
      const { feed, sent } = setup();
      const terminal: ToolCallContent = { kind: 'terminal', terminalId: 't1' };

      expect(feed.toolCallContent('s1', 'read', 'read', texts('file'))).toEqual(texts('file'));
      expect(feed.toolCallContent('s1', 'run', 'execute', [terminal])).toEqual([terminal]);
      expect(feed.toolCallContent('s1', 'run', undefined, undefined)).toBeUndefined();
      expect(sent).toEqual([]);
    });

    it('drops text cleaned after newer content came, even content with nothing to clean', async () => {
      const { feed, sent } = setup();

      feed.toolCallContent('s1', 'c1', 'execute', texts('first'));
      feed.toolCallContent('s1', 'c1', undefined, texts('second'));
      feed.toolCallContent('s1', 'c2', 'execute', texts('dropped'));
      expect(feed.toolCallContent('s1', 'c2', undefined, [])).toEqual([]);
      await cleaningDone();

      expect(sent).toEqual([['toolCallContent', 's1', 'c1', [output('second')]]]);
    });

    it('keeps all its text, uncleaned, for a terminal to open, and only the text', () => {
      const { feed, terminals, written } = setup();
      const terminal: ToolCallContent = { kind: 'terminal', terminalId: 't1' };

      feed.toolCallContent('s1', 'c1', 'execute', [...texts('\x1b[32mok\x1b[0m', 'next'), terminal]);
      feed.toolCallContent('s1', 'read', 'read', texts('a file'));

      expect(terminals.open('s1', { kind: 'toolCall', toolCallId: 'c1' }, 'ls')).toBe(true);
      expect(written).toEqual(['\x1b[32mok\x1b[0m\r\nnext']);
      expect(terminals.open('s1', { kind: 'toolCall', toolCallId: 'read' }, 'Read')).toBe(false);
    });

    it("forgets a session's commands once it is removed", async () => {
      const { feed, sent } = setup();
      feed.toolCallContent('s1', 'c1', 'execute', undefined);
      feed.toolCallContent('s2', 'c1', 'execute', undefined);

      feed.forgetSession('s1');

      expect(feed.toolCallContent('s1', 'c1', undefined, texts('ran'))).toEqual(texts('ran'));
      expect(feed.toolCallContent('s2', 'c1', undefined, texts('ran'))).toBeUndefined();
      await cleaningDone();
      expect(sent.map(([, sessionId]) => sessionId)).toEqual(['s2']);
    });

    it('drops pending content from a forgotten session even when its ID is reused', async () => {
      const { feed, sent } = setup();
      feed.toolCallContent('s1', 'c1', 'execute', texts('old session'));
      feed.forgetSession('s1');
      feed.toolCallContent('s1', 'c1', 'execute', texts('new session'));
      await cleaningDone();

      expect(sent).toEqual([['toolCallContent', 's1', 'c1', [output('new session')]]]);
    });

    it("shows a command's last characters, and says when earlier ones are not shown", async () => {
      const { feed, sent } = setup();
      const lines = Array.from({ length: 3_000 }, (_, i) => `${i + 1}`);

      feed.toolCallContent('s1', 'c1', 'execute', texts(lines.join('\n')));
      await cleaningDone();

      expect(sent).toEqual([['toolCallContent', 's1', 'c1', [output(lines.slice(-2_000).join('\n'), true)]]]);
    });
  });

  describe('terminals', () => {
    it("sends a terminal's changes within 250 ms once, with what it shows then", async () => {
      vi.useFakeTimers();
      const { terminals, sent } = setup();

      terminals.handleSessionUpdate('s1', chunk('t1', 'one\n'));
      terminals.handleSessionUpdate('s1', chunk('t1', 'two\n'));
      await vi.advanceTimersByTimeAsync(249);
      expect(sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toEqual([['terminal', 's1', 't1', { text: 'one\ntwo', truncated: false }, null]]);

      terminals.handleSessionUpdate('s1', { kind: 'terminal', terminalId: 't1', exitStatus: { exitCode: 2, signal: null } });
      await vi.advanceTimersByTimeAsync(250);
      expect(sent.at(-1)).toEqual(['terminal', 's1', 't1', { text: 'one\ntwo', truncated: false }, { exitCode: 2, signal: null }]);
      expect(sent).toHaveLength(2);
    });

    it('sends each terminal on its own time, by session', async () => {
      vi.useFakeTimers();
      const { terminals, sent } = setup();

      terminals.handleSessionUpdate('s1', chunk('t1', 'first'));
      await vi.advanceTimersByTimeAsync(100);
      terminals.handleSessionUpdate('s2', chunk('t1', 'second'));
      await vi.advanceTimersByTimeAsync(150);
      expect(sent.map(([, sessionId]) => sessionId)).toEqual(['s1']);
      await vi.advanceTimersByTimeAsync(100);
      expect(sent.map(([, sessionId]) => sessionId)).toEqual(['s1', 's2']);
    });

    it('sends nothing for a session forgotten before its changes were sent', async () => {
      vi.useFakeTimers();
      const { terminals, sent } = setup();

      terminals.handleSessionUpdate('s1', chunk('t1', 'replayed'));
      terminals.forgetSession('s1');
      await vi.advanceTimersByTimeAsync(250);

      expect(sent).toEqual([]);
    });
  });
});
