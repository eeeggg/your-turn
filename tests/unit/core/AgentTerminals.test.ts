import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionUpdate } from '@/core/acp/AcpDriver';
import { AgentTerminals, type CommandSource, type TerminalDisplays } from '@/core/AgentTerminals';
import { Cleaner } from '@/core/CommandOutput';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const chunk = (terminalId: string, data: Uint8Array | string): SessionUpdate =>
  ({ kind: 'terminalOutput', terminalId, data: typeof data === 'string' ? bytes(data) : data });
const exited = { exitCode: 0, signal: null };
const terminal = (terminalId: string): CommandSource => ({ kind: 'terminal', terminalId });
const toolCall = (toolCallId: string): CommandSource => ({ kind: 'toolCall', toolCallId });

/** A VS Code terminal as the tests see it: its name, what it was written, how often it was shown, and the user closing it. */
interface OpenedTerminal {
  name: string;
  written: string[];
  shown: number;
  close(): void;
}

/** Agent terminals fed the updates, by session, with what their listener heard and the VS Code terminals opened. */
function fed(...updates: [string, SessionUpdate][]) {
  const opened: OpenedTerminal[] = [];
  const displays: TerminalDisplays = {
    open(name, closed) {
      const display: OpenedTerminal = { name, written: [], shown: 1, close: closed };
      opened.push(display);
      return { write: (text) => display.written.push(text), show: () => display.shown++ };
    },
  };
  const terminals = new AgentTerminals(displays);
  const heard: [string, string][] = [];
  terminals.addListener((sessionId, terminalId) => heard.push([sessionId, terminalId]));
  for (const [sessionId, update] of updates) {
    terminals.handleSessionUpdate(sessionId, update);
  }
  /** Opens a source's output in a new VS Code terminal, and gives what it was written. */
  const openNew = (sessionId: string, source: CommandSource): string[] => {
    const count = opened.length;
    expect(terminals.open(sessionId, source, 'npm test')).toBe(true);
    expect(opened).toHaveLength(count + 1);
    return opened[count]?.written ?? [];
  };
  return { terminals, heard, opened, openNew };
}

describe('AgentTerminals', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies each update's exit status, one left out staying as it was and null clearing it", () => {
    const { terminals } = fed(
      ['s1', { kind: 'terminal', terminalId: 't1', command: 'npm test', cwd: '/work' }],
      ['s1', { kind: 'terminal', terminalId: 't1', exitStatus: { exitCode: 1, signal: null } }],
      ['s1', { kind: 'terminal', terminalId: 't1', cwd: null }],
      ['s1', { kind: 'terminal', terminalId: 't2', exitStatus: { exitCode: null, signal: 'SIGTERM' } }],
      ['s1', { kind: 'terminal', terminalId: 't2', exitStatus: null }],
    );

    expect(terminals.info('s1', 't1')).toEqual({ exitStatus: { exitCode: 1, signal: null }, disconnected: false });
    expect(terminals.info('s1', 't2')).toEqual({ exitStatus: null, disconnected: false });
  });

  it('keeps each terminal by session and ID, from whichever update comes first', async () => {
    const { terminals } = fed(
      ['s1', chunk('t1', 'first')],
      ['s2', chunk('t1', 'other session')],
      ['s1', { kind: 'terminal', terminalId: 't1', exitStatus: exited }],
    );

    expect(terminals.info('s1', 't1')?.exitStatus).toEqual(exited);
    expect(terminals.info('s2', 't1')?.exitStatus).toBeNull();
    expect(await terminals.shown('s1', 't1')).toEqual({ text: 'first', truncated: false });
    expect(await terminals.shown('s2', 't1')).toEqual({ text: 'other session', truncated: false });
    expect(terminals.info('s1', 'unknown')).toBeUndefined();
    expect(terminals.shown('s1', 'unknown')).toBeUndefined();
  });

  it('joins a character split between chunks, and writes it to an open terminal once whole', async () => {
    const e = bytes('é');
    const { terminals, openNew } = fed(['s1', chunk('t1', 'caf')]);
    const written = openNew('s1', terminal('t1'));

    terminals.handleSessionUpdate('s1', chunk('t1', e.slice(0, 1)));
    terminals.handleSessionUpdate('s1', chunk('t1', e.slice(1)));

    expect(await terminals.shown('s1', 't1')).toEqual({ text: 'café', truncated: false });
    expect(written).toEqual(['caf', 'é']);
  });

  it("turns invalid bytes into the replacement character", async () => {
    const { terminals } = fed(['s1', chunk('t1', new Uint8Array([0x61, 0xff, 0x62]))]);
    expect(await terminals.shown('s1', 't1')).toEqual({ text: 'a\ufffdb', truncated: false });
  });

  it('writes an open terminal the output with the line endings a terminal needs, and all of it to one opened later', () => {
    const { terminals, opened, openNew } = fed(['s1', chunk('t1', 'one\ntwo\n')]);
    const first = openNew('s1', terminal('t1'));
    terminals.handleSessionUpdate('s1', chunk('t1', 'three\n'));

    expect(first).toEqual(['one\r\ntwo\r\n', 'three\r\n']);
    opened[0]?.close();
    expect(openNew('s1', terminal('t1'))).toEqual(['one\r\ntwo\r\nthree\r\n']);
  });

  it('replaces all the output with a snapshot, resetting an open terminal, and appends chunks after it', async () => {
    const { terminals, openNew } = fed(['s1', chunk('t1', 'old\n')]);
    const written = openNew('s1', terminal('t1'));

    terminals.handleSessionUpdate('s1', { kind: 'terminal', terminalId: 't1', output: bytes('new\n') });
    terminals.handleSessionUpdate('s1', chunk('t1', 'more'));

    expect(await terminals.shown('s1', 't1')).toEqual({ text: 'new\nmore', truncated: false });
    expect(written).toEqual(['old\r\n', '\x1bcnew\r\n', 'more']);
  });

  it('clears the output when an update clears it, and writes nothing for an update that leaves it out', async () => {
    const { terminals, heard, openNew } = fed(['s1', chunk('t1', 'old')]);
    const written = openNew('s1', terminal('t1'));

    terminals.handleSessionUpdate('s1', { kind: 'terminal', terminalId: 't1', output: null });
    terminals.handleSessionUpdate('s1', { kind: 'terminal', terminalId: 't1', command: 'ls' });

    expect(await terminals.shown('s1', 't1')).toEqual({ text: '', truncated: false });
    expect(written).toEqual(['old', '\x1bc']);
    expect(heard).toHaveLength(3);
  });

  it('shows a snapshot sent with its exit status, cleaned, as Codex sends a command', async () => {
    const { terminals } = fed(
      ['s1', { kind: 'terminal', terminalId: 't1', command: '"git status"', cwd: '/work' }],
      ['s1', { kind: 'terminal', terminalId: 't1', output: bytes('On branch master\n\x1b[32mclean\x1b[0m\n'), exitStatus: exited }],
    );

    expect(await terminals.shown('s1', 't1')).toEqual({ text: 'On branch master\nclean', truncated: false });
  });

  it("lets a terminal's cleaner go once its command ends, and still shows its output, and any that comes after", async () => {
    const dispose = vi.spyOn(Cleaner.prototype, 'dispose');
    const { terminals } = fed(['s1', chunk('t1', 'running\n')], ['s1', { kind: 'terminal', terminalId: 't1', exitStatus: exited }]);

    expect(await terminals.shown('s1', 't1')).toEqual({ text: 'running', truncated: false });
    expect(dispose).toHaveBeenCalledTimes(1);

    terminals.handleSessionUpdate('s1', chunk('t1', 'late'));
    expect(await terminals.shown('s1', 't1')).toEqual({ text: 'running\nlate', truncated: false });
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("keeps the most recent 10 MB of a terminal's output, and says so when earlier output is dropped", async () => {
    const tenMegabytes = 10 * 1024 * 1024;
    const { terminals, opened, openNew } = fed(['s1', chunk('t1', 'dropped\n')], ['s1', chunk('t1', `${'x'.repeat(tenMegabytes - 8)}\nend`)]);

    const written = openNew('s1', terminal('t1')).join('');
    expect(written.startsWith('[Earlier output was not kept]\r\nped\r\nxxx')).toBe(true);
    expect(written.endsWith('x\r\nend')).toBe(true);
    expect((await terminals.shown('s1', 't1'))?.truncated).toBe(true);

    terminals.handleSessionUpdate('s1', { kind: 'terminal', terminalId: 't1', output: bytes('fresh') });
    opened[0]?.close();
    expect(openNew('s1', terminal('t1'))).toEqual(['fresh']);
    expect(await terminals.shown('s1', 't1')).toEqual({ text: 'fresh', truncated: false });
  });

  it("keeps an execute tool call's text apart from the terminals, each text replacing the last, and writes it as a terminal's", async () => {
    const { terminals, heard, openNew } = fed(['s1', chunk('c1', 'a terminal named as the tool call')]);
    terminals.keepCommandText('s1', 'c1', 'first\nrun');
    const written = openNew('s1', toolCall('c1'));

    terminals.keepCommandText('s1', 'c1', 'second run\n');

    expect(written).toEqual(['first\r\nrun', '\x1bcsecond run\r\n']);
    expect(openNew('s1', terminal('c1'))).toEqual(['a terminal named as the tool call']);
    expect(await terminals.shown('s1', 'c1')).toEqual({ text: 'a terminal named as the tool call', truncated: false });
    expect(heard).toEqual([['s1', 'c1']]);
  });

  it('keeps no cleaner for a tool call\'s text, which no exit status would ever let go', () => {
    const write = vi.spyOn(Cleaner.prototype, 'write');
    const { terminals } = fed();

    terminals.keepCommandText('s1', 'c1', 'output');

    expect(write).not.toHaveBeenCalled();
  });

  it('opens one VS Code terminal per source, named as asked, brings it forward when opened again, and a new one once the user closed it', () => {
    const { terminals, opened } = fed(['s1', chunk('t1', 'output')]);

    expect(terminals.open('s1', terminal('t1'), 'npm test')).toBe(true);
    expect(terminals.open('s1', terminal('t1'), 'another title')).toBe(true);
    expect(opened.map(({ name, shown }) => [name, shown])).toEqual([['npm test', 2]]);

    opened[0]?.close();
    terminals.handleSessionUpdate('s1', chunk('t1', ' more'));
    expect(terminals.open('s1', terminal('t1'), 'another title')).toBe(true);

    expect(opened.map(({ name, written }) => [name, written])).toEqual([['npm test', ['output']], ['another title', ['output more']]]);
  });

  it('opens nothing for output not kept', () => {
    const { terminals, opened } = fed(['s1', chunk('t1', 'output')]);
    terminals.keepCommandText('s1', 'c1', 'text');

    expect(terminals.open('s2', terminal('t1'), 'npm test')).toBe(false);
    expect(terminals.open('s1', terminal('c1'), 'npm test')).toBe(false);
    expect(terminals.open('s1', toolCall('t1'), 'npm test')).toBe(false);
    expect(opened).toEqual([]);
  });

  it('marks the commands still running when their session ends, telling the listener, and leaves those that ended', async () => {
    const { terminals, heard } = fed(
      ['s1', chunk('running', 'building')],
      ['s1', { kind: 'terminal', terminalId: 'done', exitStatus: exited }],
      ['s2', chunk('elsewhere', 'still going')],
    );
    heard.length = 0;

    terminals.endSession('s1');

    expect(terminals.info('s1', 'running')?.disconnected).toBe(true);
    expect(terminals.info('s1', 'done')?.disconnected).toBe(false);
    expect(terminals.info('s2', 'elsewhere')?.disconnected).toBe(false);
    expect(heard).toEqual([['s1', 'running']]);
    expect(await terminals.shown('s1', 'running')).toEqual({ text: 'building', truncated: false });
  });

  it("forgets a session's output, so a load's replay builds it afresh without writing terminals open on the old, and leaves other sessions' alone", async () => {
    const { terminals, openNew } = fed(['s1', chunk('t1', 'before the load')], ['s2', chunk('t1', 'elsewhere')]);
    terminals.keepCommandText('s1', 'c1', 'text');
    const written = openNew('s1', terminal('t1'));

    terminals.forgetSession('s1');
    expect(terminals.info('s1', 't1')).toBeUndefined();
    expect(terminals.open('s1', toolCall('c1'), 'ls')).toBe(false);
    terminals.handleSessionUpdate('s1', chunk('t1', 'replayed'));

    expect(written).toEqual(['before the load']);
    expect(await terminals.shown('s1', 't1')).toEqual({ text: 'replayed', truncated: false });
    expect(await terminals.shown('s2', 't1')).toEqual({ text: 'elsewhere', truncated: false });
  });

  it('forgets the sessions that ended, and only those', () => {
    const { terminals } = fed(['s1', chunk('t1', 'ended')], ['s2', chunk('t1', 'live')]);
    terminals.keepCommandText('s3', 'c1', 'ended too');
    terminals.endSession('s1');
    terminals.endSession('s3');

    terminals.forgetEndedSessions();

    expect(terminals.info('s1', 't1')).toBeUndefined();
    expect(terminals.open('s3', toolCall('c1'), 'ls')).toBe(false);
    expect(terminals.info('s2', 't1')).toBeDefined();
  });

  it('passes on updates to every listener, though one throws', () => {
    const { terminals } = fed();
    const heard: string[] = [];
    terminals.addListener(() => { throw new Error('broken'); });
    terminals.addListener((_, terminalId) => heard.push(terminalId));

    terminals.handleSessionUpdate('s1', chunk('t1', 'x'));

    expect(heard).toEqual(['t1']);
  });
});
