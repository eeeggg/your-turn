import { beforeEach, describe, expect, it } from 'vitest';
import { hookClasses } from '@tests/hookClasses';
import { connect, loadChatPage, texts, toolCall, type ChatPage } from './chatPage';

let page: ChatPage;

beforeEach(() => {
  page = loadChatPage();
  connect(page);
  page.send({ type: 'promptStart' });
});

function shown(id: string): HTMLDetailsElement {
  return page.byId<HTMLDetailsElement>(`tc-${id}`);
}

function blocks(id: string): string[] {
  return [...shown(id).querySelectorAll('.tc-body-block')].map((el) => el.textContent);
}

describe('tool calls', () => {
  it('adds a tool call to the current turn with its title and status', () => {
    toolCall(page, { toolCallId: 't1', title: 'Read file', status: 'pending' });

    const el = shown('t1');
    expect(el.closest('.turn .turn-tools-list')).not.toBeNull();
    expect(el.querySelector('.tc-title')?.textContent).toBe('Read file');
    expect(hookClasses(el.querySelector('.tc-icon'))).toBe('tc-icon pending');
    expect(el.querySelector('.tc-icon')?.textContent).toBe('…');
    expect(page.document.querySelector('.turn-tools-summary')?.textContent).toBe('▾ 1 tool call');
  });

  it('shows a tool call as pending when the agent omits the status', () => {
    toolCall(page, { toolCallId: 't1', title: 'Run' });

    expect(hookClasses(shown('t1').querySelector('.tc-icon'))).toBe('tc-icon pending');
  });

  it('shows a tool call first reported without a title as "Tool Call" until the agent names it', () => {
    toolCall(page, { toolCallId: 't1', status: 'running' });
    expect(shown('t1').querySelector('.tc-title')?.textContent).toBe('Tool Call');
    expect(hookClasses(shown('t1').querySelector('.tc-icon'))).toBe('tc-icon running');

    toolCall(page, { toolCallId: 't1', title: 'Read foo.ts' });
    expect(shown('t1').querySelector('.tc-title')?.textContent).toBe('Read foo.ts');
  });

  it('reflects status updates in the icon', () => {
    toolCall(page, { toolCallId: 't1', title: 'Run', status: 'pending' });
    const icon = (): Element | null => shown('t1').querySelector('.tc-icon');

    toolCall(page, { toolCallId: 't1', status: 'running' });
    expect(hookClasses(icon())).toBe('tc-icon running');
    expect(icon()?.textContent).toBe('⟳');

    toolCall(page, { toolCallId: 't1', status: 'completed' });
    expect(hookClasses(icon())).toBe('tc-icon completed');
    expect(icon()?.textContent).toBe('✓');
    expect(shown('t1').open).toBe(false);
  });

  it('expands a failed tool call', () => {
    toolCall(page, { toolCallId: 't1', title: 'Run', status: 'pending' });
    toolCall(page, { toolCallId: 't1', status: 'failed' });

    expect(shown('t1').querySelector('.tc-icon')?.textContent).toBe('✗');
    expect(shown('t1').open).toBe(true);
  });

  it('expands a tool call the agent reports as failed from the start', () => {
    toolCall(page, { toolCallId: 't1', title: 'Run', status: 'failed' });

    expect(shown('t1').open).toBe(true);
  });

  it('keeps the status when a report carries none', () => {
    toolCall(page, { toolCallId: 't1', title: 'Run', status: 'running' });
    toolCall(page, { toolCallId: 't1', content: texts('partial output') });

    expect(hookClasses(shown('t1').querySelector('.tc-icon'))).toBe('tc-icon running');
    expect(blocks('t1')).toEqual(['partial output']);
  });

  it('updates a tool call the agent reports again instead of adding a second one', () => {
    toolCall(page, { toolCallId: 't1', title: 'Read', status: 'pending' });
    toolCall(page, { toolCallId: 't1', title: 'Read foo.ts', status: 'completed' });

    expect(page.document.querySelectorAll('.tool-call-inline')).toHaveLength(1);
    expect(shown('t1').querySelector('.tc-title')?.textContent).toBe('Read foo.ts');
    expect(hookClasses(shown('t1').querySelector('.tc-icon'))).toBe('tc-icon completed');
    expect(page.document.querySelector('.turn-tools-summary')?.textContent).toBe('▾ 1 tool call');
  });

  it('updates the title when the report carries one', () => {
    toolCall(page, { toolCallId: 't1', title: 'Edit', status: 'pending' });
    toolCall(page, { toolCallId: 't1', status: 'running', title: 'Edit foo.ts' });

    expect(shown('t1').querySelector('.tc-title')?.textContent).toBe('Edit foo.ts');
  });

  it('shows the text output in blocks', () => {
    toolCall(page, { toolCallId: 't1', title: 'Edit foo.ts', status: 'pending' });
    toolCall(page, { toolCallId: 't1', status: 'completed', content: texts('first', 'second') });

    expect(blocks('t1')).toEqual(['first', 'second']);
    expect(shown('t1').querySelector<HTMLElement>('.tc-body')?.style.display).toBe('');
  });

  it('keeps existing output when a report has none', () => {
    toolCall(page, { toolCallId: 't1', title: 'Run', status: 'running', content: texts('output') });
    toolCall(page, { toolCallId: 't1', status: 'completed' });

    expect(blocks('t1')).toEqual(['output']);
  });

  it('hides the body when there is no text output', () => {
    toolCall(page, { toolCallId: 't1', title: 'Run', status: 'pending' });

    expect(shown('t1').querySelector<HTMLElement>('.tc-body')?.style.display).toBe('none');
  });

  it('truncates output beyond 20,000 characters', () => {
    toolCall(page, { toolCallId: 't1', title: 'Run', status: 'pending' });
    toolCall(page, { toolCallId: 't1', status: 'completed', content: texts('a'.repeat(15_000), 'b'.repeat(10_000)) });

    expect(blocks('t1').join('')).toHaveLength(20_000);
    expect(shown('t1').querySelector('.tc-body-truncated')?.textContent).toBe('... (output truncated)');
  });

  it("shows a command's terminal in its tool call, spinning while it runs, and how it failed once it ends", () => {
    toolCall(page, { toolCallId: 't1', title: 'npm test', status: 'completed', content: [{ kind: 'terminal', terminalId: 'term' }] });
    page.send({ type: 'terminal', terminalId: 'term', text: 'running', truncated: false, exitStatus: null });
    expect(shown('t1').querySelector('summary .tc-running')).not.toBeNull();

    page.send({ type: 'terminal', terminalId: 'term', text: '1 failed', truncated: true, exitStatus: { exitCode: 1, signal: null } });

    expect(shown('t1').querySelector('.tc-running')).toBeNull();
    expect([...shown('t1').querySelectorAll('.tc-command > *')].map((part) => part.textContent)).toEqual([
      'Earlier output not shown',
      '1 failed',
      'Exit code 1',
    ]);
    for (const selector of ['.tc-command', 'summary']) {
      expect(JSON.parse(shown('t1').querySelector<HTMLElement>(selector)?.dataset['vscodeContext'] ?? 'null')).toMatchObject({
        webviewSection: 'commandOutput',
        acpTitle: 'npm test',
        acpTerminalId: 'term',
      });
    }
  });

  it("draws an open tool call's diffs, a section per file with its lines numbered", () => {
    const file = { oldPath: null, removed: 0, note: null, opens: 'fileAndChanges' } as const;
    toolCall(page, { toolCallId: 't1', title: 'Apply patch', status: 'failed', content: [{ kind: 'diff', files: [
      {
        ...file,
        operation: 'modify',
        path: 'a.ts',
        added: 2,
        removed: 1,
        hunks: [
          { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' keep', '-old', '+new'] },
          { oldStart: 10, oldLines: 1, newStart: 10, newLines: 2, lines: [' ten', '+eleven'] },
        ],
      },
      { ...file, operation: 'add', path: 'b.ts', added: 1, hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+b'] }] },
    ] }] });

    const files = [...shown('t1').querySelectorAll('.tc-diff-file')];
    expect(files.map((file) => file.querySelector('.tc-diff-header')?.textContent)).toEqual(['Modifieda.ts+2−1', 'Addedb.ts+1']);
    expect(files.map((file) => file.querySelectorAll('tbody.diff-hunk').length)).toEqual([2, 1]);
    expect([...(files[0]?.querySelectorAll('td.diff-gutter-insert') ?? [])].map((cell) => cell.textContent).filter(Boolean)).toEqual(['2', '11']);
  });

  it("answers a click on a diff's path by asking the extension to open the file, by its place across the tool call's diffs", () => {
    toolCall(page, { toolCallId: 't1', title: 'Edit', status: 'failed', content: [{ kind: 'diff', files: [{
      operation: 'modify',
      path: 'a.ts',
      oldPath: null,
      added: 1,
      removed: 1,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
      note: null,
      opens: 'fileAndChanges',
    }] }] });
    page.takePosted();

    shown('t1').querySelector<HTMLElement>('.tc-diff-link')?.click();

    expect(page.takePosted()).toEqual([{ type: 'openFile', toolCallId: 't1', file: 0 }]);
  });

  it('collapses more than three tool calls when the turn ends, and toggles on click', () => {
    for (const id of ['t1', 't2', 't3', 't4']) {
      toolCall(page, { toolCallId: id, title: id, status: 'completed' });
    }
    page.send({ type: 'promptEnd' });

    const summary = page.document.querySelector<HTMLElement>('.turn-tools-summary');
    const list = page.document.querySelector('.turn-tools-list');
    expect(summary?.textContent).toBe('▸ 4 tool calls');
    expect(list?.classList.contains('collapsed')).toBe(true);

    summary?.click();
    expect(summary?.textContent).toBe('▾ 4 tool calls');
    expect(list?.classList.contains('collapsed')).toBe(false);
  });

  it('leaves three or fewer tool calls expanded when the turn ends', () => {
    for (const id of ['t1', 't2', 't3']) {
      toolCall(page, { toolCallId: id, title: id, status: 'completed' });
    }
    page.send({ type: 'promptEnd' });

    expect(page.document.querySelector('.turn-tools-summary')?.textContent).toBe('▾ 3 tool calls');
    expect(page.document.querySelector('.turn-tools-list')?.classList.contains('collapsed')).toBe(false);
  });
});
