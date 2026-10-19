import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hookClasses } from '@tests/hookClasses';
import { connect, loadChatPage, textChunk, update, type ChatPage } from './chatPage';

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

function toolCall(id: string): HTMLDetailsElement {
  return page.byId<HTMLDetailsElement>(`tc-${id}`);
}

function blocks(id: string): string[] {
  return [...toolCall(id).querySelectorAll('.tc-body-block')].map((el) => el.textContent ?? '');
}

describe('tool calls', () => {
  it('adds a tool call to the current turn with its title and status', () => {
    update(page, 'tool_call', { toolCallId: 't1', title: 'Read file', kind: 'read', status: 'pending' });

    const el = toolCall('t1');
    expect(el.closest('.turn .turn-tools-list')).not.toBeNull();
    expect(el.querySelector('.tc-title')?.textContent).toBe('Read file');
    expect(hookClasses(el.querySelector('.tc-icon'))).toBe('tc-icon pending');
    expect(el.querySelector('.tc-icon')?.textContent).toBe('…');
    expect(page.document.querySelector('.turn-tools-summary')?.textContent).toBe('▾ 1 tool call');
  });

  it('shows a tool call as pending when the agent omits the status', () => {
    update(page, 'tool_call', { toolCallId: 't1', title: 'Run' });

    expect(hookClasses(toolCall('t1').querySelector('.tc-icon'))).toBe('tc-icon pending');
  });

  it('reflects status updates in the icon', () => {
    update(page, 'tool_call', { toolCallId: 't1', title: 'Run', status: 'pending' });
    const icon = (): Element | null => toolCall('t1').querySelector('.tc-icon');

    update(page, 'tool_call_update', { toolCallId: 't1', status: 'in_progress' });
    expect(hookClasses(icon())).toBe('tc-icon running');
    expect(icon()?.textContent).toBe('⟳');

    update(page, 'tool_call_update', { toolCallId: 't1', status: 'completed' });
    expect(hookClasses(icon())).toBe('tc-icon completed');
    expect(icon()?.textContent).toBe('✓');
    expect(toolCall('t1').open).toBe(false);
  });

  it('expands a failed tool call', () => {
    update(page, 'tool_call', { toolCallId: 't1', title: 'Run', status: 'pending' });
    update(page, 'tool_call_update', { toolCallId: 't1', status: 'failed' });

    expect(toolCall('t1').querySelector('.tc-icon')?.textContent).toBe('✗');
    expect(toolCall('t1').open).toBe(true);
  });

  it('expands a tool call the agent reports as failed from the start', () => {
    update(page, 'tool_call', { toolCallId: 't1', title: 'Run', status: 'failed' });

    expect(toolCall('t1').open).toBe(true);
  });

  it('keeps the status when an update carries none', () => {
    update(page, 'tool_call', { toolCallId: 't1', title: 'Run', status: 'in_progress' });
    update(page, 'tool_call_update', {
      toolCallId: 't1',
      content: [{ type: 'content', content: { type: 'text', text: 'partial output' } }],
    });

    expect(hookClasses(toolCall('t1').querySelector('.tc-icon'))).toBe('tc-icon running');
    expect(blocks('t1')).toEqual(['partial output']);
  });

  it('updates a tool call the agent reports again instead of adding a second one', () => {
    update(page, 'tool_call', { toolCallId: 't1', title: 'Read', status: 'pending' });
    update(page, 'tool_call', { toolCallId: 't1', title: 'Read foo.ts', status: 'completed' });

    expect(page.document.querySelectorAll('.tool-call-inline')).toHaveLength(1);
    expect(toolCall('t1').querySelector('.tc-title')?.textContent).toBe('Read foo.ts');
    expect(hookClasses(toolCall('t1').querySelector('.tc-icon'))).toBe('tc-icon completed');
    expect(page.document.querySelector('.turn-tools-summary')?.textContent).toBe('▾ 1 tool call');
  });

  it('updates the title when the update carries one', () => {
    update(page, 'tool_call', { toolCallId: 't1', title: 'Edit', status: 'pending' });
    update(page, 'tool_call_update', { toolCallId: 't1', status: 'in_progress', title: 'Edit foo.ts' });

    expect(toolCall('t1').querySelector('.tc-title')?.textContent).toBe('Edit foo.ts');
  });

  it('shows text content and does not render diff content', () => {
    update(page, 'tool_call', { toolCallId: 't1', title: 'Edit foo.ts', kind: 'edit', status: 'pending' });
    update(page, 'tool_call_update', {
      toolCallId: 't1',
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: 'first' } },
        { type: 'diff', path: '/work/project/foo.ts', oldText: 'a', newText: 'b' },
        { type: 'content', content: { type: 'text', text: 'second' } },
      ],
    });

    expect(blocks('t1')).toEqual(['first', 'second']);
    expect(toolCall('t1').querySelector<HTMLElement>('.tc-body')?.style.display).toBe('');
  });

  it('keeps existing content when an update has none', () => {
    update(page, 'tool_call', {
      toolCallId: 't1',
      title: 'Run',
      status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text: 'output' } }],
    });
    update(page, 'tool_call_update', { toolCallId: 't1', status: 'completed' });

    expect(blocks('t1')).toEqual(['output']);
  });

  it('hides the body when there is no text content', () => {
    update(page, 'tool_call', { toolCallId: 't1', title: 'Run', status: 'pending' });

    expect(toolCall('t1').querySelector<HTMLElement>('.tc-body')?.style.display).toBe('none');
  });

  it('truncates content beyond 20,000 characters', () => {
    update(page, 'tool_call', { toolCallId: 't1', title: 'Run', status: 'pending' });
    update(page, 'tool_call_update', {
      toolCallId: 't1',
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: 'a'.repeat(15_000) } },
        { type: 'content', content: { type: 'text', text: 'b'.repeat(10_000) } },
      ],
    });

    expect(blocks('t1').join('')).toHaveLength(20_000);
    expect(toolCall('t1').querySelector('.tc-body-truncated')?.textContent).toBe('... (output truncated)');
  });

  it('places the answer above the tool calls of the same turn', () => {
    update(page, 'tool_call', { toolCallId: 't1', title: 'Read', status: 'completed' });
    update(page, 'agent_message_chunk', textChunk('done'));

    const turn = page.document.querySelector('.turn');
    expect([...(turn?.children ?? [])].map((el) => hookClasses(el))).toEqual(['message agent', 'turn-tools']);
  });

  it('collapses more than three tool calls when the turn ends, and toggles on click', () => {
    for (const id of ['t1', 't2', 't3', 't4']) {
      update(page, 'tool_call', { toolCallId: id, title: id, status: 'completed' });
    }
    page.send({ type: 'promptEnd', stopReason: 'end_turn' });

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
      update(page, 'tool_call', { toolCallId: id, title: id, status: 'completed' });
    }
    page.send({ type: 'promptEnd', stopReason: 'end_turn' });

    expect(page.document.querySelector('.turn-tools-summary')?.textContent).toBe('▾ 3 tool calls');
    expect(page.document.querySelector('.turn-tools-list')?.classList.contains('collapsed')).toBe(false);
  });
});
