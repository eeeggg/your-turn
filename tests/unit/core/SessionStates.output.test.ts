import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { SessionUpdate, ToolCallContent, ToolKind } from '@/core/acp/AcpDriver';
import { AgentTerminals } from '@/core/AgentTerminals';
import { Cleaner, type ShownOutput } from '@/core/CommandOutput';
import { SessionStates } from '@/core/SessionStates';

const identity = { configuredName: 'fake', sessionId: 'session' };
const registration = { agentName: 'fake', agentId: 'source', sessionId: identity.sessionId };
const other = { ...registration, agentName: 'other', sessionId: 'other-session' };
const texts = (...items: string[]): ToolCallContent[] => items.map((text) => ({ kind: 'text', text }));
const output = (text: string, truncated = false) => ({ kind: 'commandOutput', output: { text, truncated } });
const chunk = (terminalId: string, text: string): SessionUpdate => ({ kind: 'terminalOutput', terminalId, data: new TextEncoder().encode(text) });

function setup() {
  const changed = vi.fn();
  const written: string[] = [];
  const states = new SessionStates(changed, { open: () => ({ write: (text) => written.push(text), show() {} }) });
  states.attach(registration);
  states.attach(other);
  onTestFinished(async () => {
    const disposed = states.dispose().catch(() => {});
    if (vi.isFakeTimers()) { await vi.runAllTimersAsync(); }
    await disposed;
  });
  const call = (id: string, toolKind?: ToolKind, content?: ToolCallContent[], owner = registration) => {
    states.accept(owner, { kind: 'toolCall', toolCallId: id, ...(toolKind === undefined ? {} : { toolKind }), ...(content === undefined ? {} : { content }) }, 0);
  };
  const content = (id: string, owner = registration) => states.view({ configuredName: owner.agentName, sessionId: owner.sessionId })?.content.entries
    .flatMap((entry) => entry.kind === 'turn' ? entry.parts : [])
    .flatMap((part) => part.kind === 'toolCalls' ? part.toolCalls : []).find((candidate) => candidate.toolCallId === id)?.content;
  return { states, changed, written, call, content };
}

beforeEach(() => { onTestFinished(() => { vi.useRealTimers(); }); });

describe('retained command output', () => {
  it('drains accepted cleaning without publishing after disposal and rejects new output', async () => {
    vi.useFakeTimers();
    const { states, changed, call } = setup();
    call('c1', 'execute', texts('pending'));
    states.accept(registration, chunk('t1', 'pending terminal'), 0);
    const disposed = states.dispose();
    expect(states.dispose()).toBe(disposed);
    states.accept(registration, chunk('t1', ' after disposal'), 0);
    call('late', 'execute', texts('late'));
    await vi.runAllTimersAsync();
    await disposed;
    expect(changed).not.toHaveBeenCalled();
    expect(states.view(identity)).toBeUndefined();
    expect(states.openCommandOutput(identity, { kind: 'toolCall', toolCallId: 'late' }, 'late')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('awaits terminal reads already started when disposed', async () => {
    vi.useFakeTimers();
    const { states, changed } = setup();
    let finish!: (value: ShownOutput) => void;
    const held = new Promise<ShownOutput>((resolve) => { finish = resolve; });
    const read = vi.spyOn(AgentTerminals.prototype, 'shown').mockReturnValueOnce(held);
    onTestFinished(() => read.mockRestore());
    states.accept(registration, chunk('t1', 'pending'), 0);
    vi.advanceTimersByTime(250);
    expect(read).toHaveBeenCalledOnce();
    let disposed = false;
    const disposal = states.dispose().then(() => { disposed = true; });
    await vi.runAllTimersAsync();
    expect(disposed).toBe(false);
    finish({ text: 'pending', truncated: false });
    await disposal;
    expect(changed).not.toHaveBeenCalled();
  });

  it('drains sibling cleaners even when one output cannot be read', async () => {
    vi.useFakeTimers();
    const { states, changed, call } = setup();
    const read = vi.spyOn(Cleaner.prototype, 'shown').mockRejectedValueOnce(new Error('cannot read output'));
    onTestFinished(() => read.mockRestore());
    const dispose = Cleaner.prototype.dispose;
    let released = 0;
    const release = vi.spyOn(Cleaner.prototype, 'dispose').mockImplementation(function (this: Cleaner) {
      return dispose.call(this).then(() => { released++; });
    });
    onTestFinished(() => release.mockRestore());
    call('c1', 'execute', texts('broken', 'still parsing'));
    const disposal = states.dispose().catch((error: unknown) => ({ error, released }));
    await vi.runAllTimersAsync();
    const result = await disposal;
    expect(released).toBe(2);
    expect(result?.released).toBe(2);
    expect(result?.error).toBeInstanceOf(AggregateError);
    expect(changed).not.toHaveBeenCalled();
  });

  it('cleans execute text as a terminal shows it without changing sibling content', async () => {
    vi.useFakeTimers();
    const { call, content } = setup();
    const diff: ToolCallContent = { kind: 'diff', diff: { kind: 'wholeFile', path: '/work/a.ts', oldText: null, newText: 'a' } };
    call('c1', 'execute', [...texts('\x1b[32mok\x1b[0m\nDownloading 5%\rDownloading done\n'), diff]);
    await vi.runAllTimersAsync();
    expect(content('c1')).toEqual([output('ok\nDownloading done'), diff]);
  });

  it('retains omitted tool kind and isolates equal call IDs in other sessions', async () => {
    vi.useFakeTimers();
    const { call, content } = setup();
    call('c1', 'execute');
    call('c1', undefined, texts('ran'));
    call('c1', undefined, texts('other session'), other);
    await vi.runAllTimersAsync();
    expect(content('c1')).toEqual([output('ran')]);
    expect(content('c1', other)).toEqual(texts('other session'));
    call('c1', 'other', texts('not a command now'));
    await vi.runAllTimersAsync();
    expect(content('c1')).toEqual(texts('not a command now'));
  });

  it('keeps non-execute text and command terminal references unchanged', () => {
    const { call, content } = setup();
    const terminal: ToolCallContent = { kind: 'terminal', terminalId: 't1' };
    call('read', 'read', texts('file'));
    call('run', 'execute', [terminal]);
    call('run');
    expect(content('read')).toEqual(texts('file'));
    expect(content('run')).toEqual([terminal]);
  });

  it('drops cleaned text superseded by newer content including empty content', async () => {
    vi.useFakeTimers();
    const { call, content } = setup();
    call('c1', 'execute', texts('first'));
    call('c1', undefined, texts('second'));
    call('c2', 'execute', texts('dropped'));
    call('c2', undefined, []);
    await vi.runAllTimersAsync();
    expect(content('c1')).toEqual([output('second')]);
    expect(content('c2')).toEqual([]);
  });

  it('keeps uncleaned execute text for native output without retaining non-command text', () => {
    const { states, call, written } = setup();
    call('c1', 'execute', [...texts('\x1b[32mok\x1b[0m', 'next'), { kind: 'terminal', terminalId: 't1' }]);
    call('read', 'read', texts('a file'));
    expect(states.openCommandOutput(identity, { kind: 'toolCall', toolCallId: 'c1' }, 'ls')).toBe(true);
    expect(written).toEqual(['\x1b[32mok\x1b[0m\r\nnext']);
    expect(states.openCommandOutput(identity, { kind: 'toolCall', toolCallId: 'read' }, 'Read')).toBe(false);
  });

  it('releases only the closed session and rejects its old registration', async () => {
    vi.useFakeTimers();
    const { states, call, content } = setup();
    call('c1', 'execute');
    call('c1', 'execute', undefined, other);
    states.release(identity);
    call('c1', undefined, texts('ran'));
    call('c1', undefined, texts('ran'), other);
    await vi.runAllTimersAsync();
    expect(states.view(identity)).toBeUndefined();
    expect(content('c1', other)).toEqual([output('ran')]);
  });

  it('drops pending content from a closed owner when the address and call IDs are reused', async () => {
    vi.useFakeTimers();
    const { states, call, content } = setup();
    call('c1', 'execute', texts('old session'));
    states.release(identity);
    const replacement = { ...registration };
    states.attach(replacement);
    call('c1', 'execute', texts('new session'), replacement);
    await vi.runAllTimersAsync();
    expect(content('c1', replacement)).toEqual([output('new session')]);
  });

  it('shows the last command output lines and marks omitted earlier output', async () => {
    vi.useFakeTimers();
    const { call, content } = setup();
    const lines = Array.from({ length: 3_000 }, (_, index) => `${index + 1}`);
    call('c1', 'execute', texts(lines.join('\n')));
    await vi.runAllTimersAsync();
    expect(content('c1')).toEqual([output(lines.slice(-2_000).join('\n'), true)]);
  });

  it('drops an old terminal read after closing and reopening the same address', async () => {
    vi.useFakeTimers();
    const { states } = setup();
    let finish!: (value: ShownOutput) => void;
    const held = new Promise<ShownOutput>((resolve) => { finish = resolve; });
    const read = vi.spyOn(AgentTerminals.prototype, 'shown').mockReturnValueOnce(held)
      .mockResolvedValueOnce({ text: 'replacement output', truncated: false });
    onTestFinished(() => read.mockRestore());
    states.accept(registration, chunk('t1', 'old output'), 0);
    vi.advanceTimersByTime(250);
    states.release(identity);
    const replacement = { ...registration };
    states.attach(replacement);
    states.accept(replacement, chunk('t1', 'replacement output'), 0);
    finish({ text: 'old output', truncated: false });
    await vi.runAllTimersAsync();
    expect(states.view(identity)?.terminals.get('t1')).toEqual({ text: 'replacement output', truncated: false, exitStatus: null });
  });

  it('coalesces terminal changes for 250 ms and retains exit status', async () => {
    vi.useFakeTimers();
    const { states, changed } = setup();
    states.accept(registration, chunk('t1', 'one\n'), 0);
    states.accept(registration, chunk('t1', 'two\n'), 0);
    await vi.advanceTimersByTimeAsync(249);
    expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(states.view(identity)?.terminals.get('t1')).toEqual({ text: 'one\ntwo', truncated: false, exitStatus: null });
    expect(changed).toHaveBeenCalledTimes(1);
    states.accept(registration, { kind: 'terminal', terminalId: 't1', exitStatus: { exitCode: 2, signal: null } }, 0);
    await vi.advanceTimersByTimeAsync(250);
    expect(states.view(identity)?.terminals.get('t1')?.exitStatus).toEqual({ exitCode: 2, signal: null });
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('coalesces each terminal independently across sessions', async () => {
    vi.useFakeTimers();
    const { states } = setup();
    states.accept(registration, chunk('t1', 'first'), 0);
    await vi.advanceTimersByTimeAsync(100);
    states.accept(other, chunk('t1', 'second'), 0);
    await vi.advanceTimersByTimeAsync(150);
    expect(states.view(identity)?.terminals.get('t1')?.text).toBe('first');
    expect(states.view({ configuredName: other.agentName, sessionId: other.sessionId })?.terminals.size).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(states.view({ configuredName: other.agentName, sessionId: other.sessionId })?.terminals.get('t1')?.text).toBe('second');
  });

  it('publishes nothing for an owner closed before its terminal changes are read', async () => {
    vi.useFakeTimers();
    const { states, changed } = setup();
    states.accept(registration, chunk('t1', 'replayed'), 0);
    states.release(identity);
    await vi.runAllTimersAsync();
    expect(states.view(identity)).toBeUndefined();
    expect(changed).not.toHaveBeenCalled();
  });
});
