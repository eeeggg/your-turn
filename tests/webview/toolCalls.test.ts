import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hookClasses } from '@tests/hookClasses';
import { connect, loadChatPage, texts, toolCall, type ChatPage } from './chatPage';

let page: ChatPage;

beforeEach(() => {
  page = loadChatPage();
  connect(page);
  page.send({ type: 'promptStart' });
});

afterEach(() => {
  expect(page.errors).toEqual([]);
  page.close();
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

  it("draws an open tool call's diffs, a section per file with its lines numbered", () => {
    const patch = [
      'diff --git /work/project/a.ts /work/project/a.ts',
      '--- /work/project/a.ts',
      '+++ /work/project/a.ts',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-old',
      '+new',
      '@@ -10,1 +10,2 @@',
      ' ten',
      '+eleven',
      'diff --git /work/project/b.ts /work/project/b.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ /work/project/b.ts',
      '@@ -0,0 +1 @@',
      '+b',
      '',
    ].join('\n');
    toolCall(page, { toolCallId: 't1', title: 'Apply patch', status: 'failed', content: [{ kind: 'diff', diff: { kind: 'changes', changes: [
      { operation: 'modify', path: '/work/project/a.ts', fileType: 'text', mimeType: null },
      { operation: 'add', path: '/work/project/b.ts', fileType: 'text', mimeType: null },
    ], patch: { format: 'git_patch', text: patch } } }] });

    const files = [...shown('t1').querySelectorAll('.tc-diff-file')];
    expect(files.map((file) => file.querySelector('.tc-diff-header')?.textContent)).toEqual(['Modifieda.ts+2−1', 'Addedb.ts+1']);
    expect(files.map((file) => file.querySelectorAll('tbody.diff-hunk').length)).toEqual([2, 1]);
    expect([...(files[0]?.querySelectorAll('td.diff-gutter-insert') ?? [])].map((cell) => cell.textContent).filter(Boolean)).toEqual(['2', '11']);
  });

  it('answers a click on a diff\'s path, and a choice from the context menu, with the file as the agent reported it', () => {
    const file = { path: '/work/project/a.ts', operation: 'modify', lines: { kind: 'wholeFile', oldText: 'a\n', newText: 'b\n' } } as const;
    toolCall(page, { toolCallId: 't1', title: 'Edit', status: 'failed', content: [{ kind: 'diff', diff: { kind: 'wholeFile', path: file.path, oldText: 'a\n', newText: 'b\n' } }] });
    page.takePosted();

    shown('t1').querySelector<HTMLElement>('.tc-diff-link')?.click();
    page.send({ type: 'diffFileChosen', toolCallId: 't1', file: 0, open: 'changes' });

    expect(page.takePosted()).toEqual([{ type: 'openFile', file }, { type: 'openChanges', file }]);
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
