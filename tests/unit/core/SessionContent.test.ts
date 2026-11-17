import { describe, expect, it } from 'vitest';
import { initialContent, updateContent } from '@/core/SessionContent';

describe('retained session content', () => {
  it('replaces replayed rich prompts and thoughts without losing surrounding content', () => {
    let state = updateContent(initialContent, { kind: 'promptImage', messageId: 'p1', data: 'aW1hZ2U=', mimeType: 'image/png' }, 0);
    state = updateContent(state, { kind: 'thoughtText', messageId: 'r1', text: 'Old thought' }, 1000);
    state = updateContent(state, { kind: 'agentText', messageId: 'm1', text: 'Answer' }, 2000);
    state = updateContent(state, { kind: 'thoughtRichMessage', messageId: 'r1', content: [
      { kind: 'text', text: 'New thought' }, { kind: 'image', data: 'dGhvdWdodA==', mimeType: 'image/png' },
    ] }, 3000);
    state = updateContent(state, { kind: 'promptRichMessage', messageId: 'p1', content: [{ kind: 'text', text: 'Question' }] }, 4000);

    expect(state.entries).toEqual([
      { kind: 'prompt', id: 3, messageId: 'p1', text: 'Question' },
      { kind: 'turn', id: 2, parts: [
        { kind: 'thought', messageId: 'r1', text: 'New thought', startedAt: 3000, endedAt: null, markdownRevision: 1 },
        { kind: 'thought', messageId: 'r1', text: '', startedAt: 3000, endedAt: null, markdownRevision: 1,
          image: { data: 'dGhvdWdodA==', mimeType: 'image/png' } },
        { kind: 'message', messageId: 'm1', text: 'Answer' },
      ] },
    ]);
    state = updateContent(state, { kind: 'thoughtMessage', messageId: 'r1', text: 'Only thought' }, 5000);
    state = updateContent(state, { kind: 'promptMessage', messageId: 'p1', text: 'Revised question' }, 5000);
    expect(state.entries).toMatchObject([
      { kind: 'prompt', text: 'Revised question' },
      { kind: 'turn', parts: [{ kind: 'thought', text: 'Only thought' }, { kind: 'message', text: 'Answer' }] },
    ]);
  });

  it('replaces rich content by message ID and keeps compaction patches at their first position', () => {
    let state = updateContent(initialContent, { kind: 'agentText', messageId: 'm1', text: 'Old' }, 0);
    state = updateContent(state, { kind: 'agentRichMessage', messageId: 'm1', content: [
      { kind: 'text', text: 'New' }, { kind: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }, { kind: 'text', text: 'Tail' },
    ] }, 1000);
    state = updateContent(state, { kind: 'compactionSummaryChunk', compactionId: 'c1', content: { type: 'text', text: 'Summary' } }, 2000);
    state = updateContent(state, { kind: 'promptText', messageId: null, text: 'Next' }, 3000);
    state = updateContent(state, { kind: 'compactionUpdate', compactionId: 'c1', status: 'failed', summary: { present: false }, error: { present: true, value: 'Failure' } }, 4000);

    expect(state.entries).toMatchObject([
      { kind: 'turn', id: 1, parts: [
        { kind: 'message', messageId: 'm1', text: 'New', markdownRevision: 1 },
        { kind: 'image', messageId: 'm1', data: 'aW1hZ2U=', mimeType: 'image/png' },
        { kind: 'message', messageId: 'm1', text: 'Tail', markdownRevision: 1 },
        { kind: 'compaction', compactionId: 'c1', status: 'failed', summary: [{ type: 'text', text: 'Summary' }], error: 'Failure', startedAt: 2000, endedAt: 4000 },
      ] },
      { kind: 'prompt', text: 'Next' },
    ]);
    state = updateContent(state, { kind: 'agentMessage', messageId: 'm1', text: 'Only text' }, 5000);
    expect(state.entries[0]).toMatchObject({ parts: [
      { kind: 'message', messageId: 'm1', text: 'Only text' },
      { kind: 'compaction', compactionId: 'c1' },
    ] });
  });

  it('retains tool patches and plans at their first position across later turns', () => {
    let state = updateContent(initialContent, { kind: 'toolCall', toolCallId: 't1', title: 'Read', status: 'running', content: [{ kind: 'text', text: 'Body' }] }, 0);
    state = updateContent(state, { kind: 'agentText', messageId: 'm1', text: 'Between' }, 0);
    state = updateContent(state, { kind: 'plan', steps: [{ text: 'First', status: 'pending' }] }, 0);
    state = updateContent(state, { kind: 'plan', steps: [{ text: 'Done', status: 'completed' }] }, 0);
    state = updateContent(state, { kind: 'promptText', messageId: 'p1', text: 'Next' }, 0);
    state = updateContent(state, { kind: 'agentText', messageId: 'm2', text: 'Later' }, 0);
    state = updateContent(state, { kind: 'toolCall', toolCallId: 't1', title: '', status: 'completed' }, 0);

    expect(state.entries).toEqual([
      { kind: 'turn', id: 1, parts: [
        { kind: 'toolCalls', toolCalls: [{ toolCallId: 't1', title: 'Read', status: 'completed', content: [{ kind: 'text', text: 'Body' }] }] },
        { kind: 'message', messageId: 'm1', text: 'Between' },
        { kind: 'plan', steps: [{ text: 'Done', status: 'completed' }] },
      ] },
      { kind: 'prompt', id: 2, messageId: 'p1', text: 'Next' },
      { kind: 'turn', id: 3, parts: [{ kind: 'message', messageId: 'm2', text: 'Later' }] },
    ]);
  });

  it('finishes a thought when a whitespace-only message becomes visible', () => {
    const thinking = updateContent(initialContent, { kind: 'thoughtText', messageId: 'r1', text: 'Thinking' }, 1000);
    const whitespace = updateContent(thinking, { kind: 'agentText', messageId: 'm1', text: '\n ' }, 2000);
    const visible = updateContent(whitespace, { kind: 'agentText', messageId: 'm1', text: 'Answer' }, 3000);

    expect(visible.entries).toEqual([{ kind: 'turn', id: 1, parts: [
      { kind: 'thought', messageId: 'r1', text: 'Thinking', startedAt: 1000, endedAt: 3000 },
      { kind: 'message', messageId: 'm1', text: '\n Answer' },
    ] }]);
    expect(whitespace.entries[0]).toMatchObject({ parts: [{ endedAt: null }, { text: '\n ' }] });
  });

  it('preserves unrelated entries and parts when streaming into the latest message', () => {
    const prompt = updateContent(initialContent, { kind: 'promptText', messageId: 'p1', text: 'Question' }, 0);
    const first = updateContent(prompt, { kind: 'agentText', messageId: 'm1', text: 'First' }, 0);
    const second = updateContent(first, { kind: 'agentText', messageId: 'm2', text: 'Second' }, 0);
    const streamed = updateContent(second, { kind: 'agentText', messageId: 'm2', text: ' partial' }, 0);
    expect(streamed.entries[0]).toBe(second.entries[0]);
    const before = second.entries[1];
    const after = streamed.entries[1];
    expect(before?.kind).toBe('turn');
    expect(after?.kind).toBe('turn');
    if (before?.kind !== 'turn' || after?.kind !== 'turn') { throw new Error('Expected retained turns'); }
    expect(after.parts[0]).toBe(before.parts[0]);
    expect(after.parts[1]).toEqual({ kind: 'message', messageId: 'm2', text: 'Second partial' });
    expect(updateContent(streamed, { kind: 'agentText', messageId: 'm2', text: '' }, 0)).toBe(streamed);
  });

  it('appends null-ID chunks and replaces only the latest matching message across turns', () => {
    let state = updateContent(initialContent, { kind: 'agentText', messageId: 'm1', text: 'Before' }, 0);
    state = updateContent(state, { kind: 'agentText', messageId: null, text: ' tail' }, 0);
    state = updateContent(state, { kind: 'promptText', messageId: 'p1', text: 'Next' }, 0);
    state = updateContent(state, { kind: 'agentText', messageId: 'm2', text: 'After' }, 0);
    state = updateContent(state, { kind: 'agentMessage', messageId: 'm1', text: 'Replacement' }, 0);
    expect(state.entries).toEqual([
      { kind: 'turn', id: 1, parts: [{ kind: 'message', messageId: 'm1', text: 'Replacement', markdownRevision: 1 }] },
      { kind: 'prompt', id: 2, messageId: 'p1', text: 'Next' },
      { kind: 'turn', id: 3, parts: [{ kind: 'message', messageId: 'm2', text: 'After' }] },
    ]);
  });
});
