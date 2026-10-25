import { describe, expect, it } from 'vitest';
import type { SessionUpdate } from '@/core/acp/AcpDriver';
import { Reviews } from '@/core/review/Reviews';
import { Takeovers, type DocumentEdit } from '@/core/review/Takeovers';

const text = (...lines: string[]) => lines.map((line) => `${line}\n`).join('');

const baseline = text('one', 'two', 'three');
const agents = text('one', 'TWO', 'three');

/** Line `line` of `before` replaced by `replacement`. */
function lineEdited(before: string, line: number, replacement: string): { after: string; edits: DocumentEdit[] } {
  const lines = before.split('\n');
  const start = lines.slice(0, line).join('\n').length + (line > 0 ? 1 : 0);
  const end = start + (lines[line] ?? '').length;
  return { after: before.slice(0, start) + replacement + before.slice(end), edits: [{ first: line, last: line, addedLines: 0, start, end, text: replacement }] };
}

/** Takeovers over session `s1`'s review, shown, with `/w/a.ts` changed by the agent from `baseline` to `agents`. */
async function takeovers() {
  const reviews = new Reviews({ read: async () => agents, restore: async () => {}, watch: () => ({ dispose: () => {} }) });
  reviews.activeSessionChanged('s1');
  const update: SessionUpdate = {
    kind: 'toolCall',
    toolCallId: 't1',
    status: 'completed',
    content: [{ kind: 'diff', diff: { kind: 'wholeFile', path: '/w/a.ts', oldText: baseline, newText: agents } }],
  };
  await reviews.handleSessionUpdate('s1', update, 'v1');
  return { subject: new Takeovers(reviews), reviews, baselineOf: () => reviews.shown()?.file('/w/a.ts')?.baseline };
}

describe('Takeovers', () => {
  it("takes over the change the user's edit touched", async () => {
    const { subject, baselineOf } = await takeovers();
    const { after, edits } = lineEdited(agents, 1, 'TWO!');
    subject.edited('/w/a.ts', 'user', agents, after, edits);
    expect(baselineOf()).toBe(after);
  });

  it("leaves the baseline alone for the review's own edit and for a reload", async () => {
    const { subject, baselineOf } = await takeovers();
    const { after, edits } = lineEdited(agents, 1, 'two');
    subject.edited('/w/a.ts', 'review', agents, after, edits);
    subject.edited('/w/a.ts', 'reload', after, text('one', 'TWO', 'three', 'four'), []);
    expect(baselineOf()).toBe(baseline);
  });

  it("takes a save's edit touching no change into the baseline, and leaves a change it touches under review", async () => {
    const { subject, baselineOf } = await takeovers();
    const outside = lineEdited(agents, 2, 'THREE');
    subject.edited('/w/a.ts', 'save', agents, outside.after, outside.edits);
    const inside = lineEdited(outside.after, 1, 'TWO;');
    subject.edited('/w/a.ts', 'save', outside.after, inside.after, inside.edits);
    expect(baselineOf()).toBe(text('one', 'two', 'THREE'));
  });

  it('brings back the baseline a text had when an undo or a revert brings the text back', async () => {
    const { subject, baselineOf } = await takeovers();
    const typed = lineEdited(agents, 1, 'TWO!');
    subject.edited('/w/a.ts', 'user', agents, typed.after, typed.edits);
    subject.edited('/w/a.ts', 'undo', typed.after, agents, lineEdited(typed.after, 1, 'TWO').edits);
    expect(baselineOf()).toBe(baseline);

    subject.edited('/w/a.ts', 'user', agents, typed.after, typed.edits);
    subject.edited('/w/a.ts', 'revert', typed.after, agents, lineEdited(typed.after, 1, 'TWO').edits);
    expect(baselineOf()).toBe(baseline);
  });

  it('leaves the baseline alone when the agent writes a text the document had, as a reload is the disk\'s new text', async () => {
    const { subject, baselineOf } = await takeovers();
    const typed = lineEdited(agents, 0, 'ONE');
    subject.edited('/w/a.ts', 'user', agents, typed.after, typed.edits);
    expect(baselineOf()).toBe(text('ONE', 'two', 'three'));
    subject.edited('/w/a.ts', 'reload', typed.after, agents, lineEdited(typed.after, 0, 'one').edits);
    expect(baselineOf()).toBe(text('ONE', 'two', 'three'));
  });

  it('forgets a file\'s history once it leaves the review, so a later round brings back no baseline of an earlier one', async () => {
    const { subject, reviews, baselineOf } = await takeovers();
    const typed = lineEdited(agents, 0, 'ONE');
    subject.edited('/w/a.ts', 'user', agents, typed.after, typed.edits);
    reviews.shown()?.keepFile('/w/a.ts');
    expect(baselineOf()).toBeUndefined();
    await reviews.handleSessionUpdate('s1', {
      kind: 'toolCall',
      toolCallId: 't2',
      status: 'completed',
      content: [{ kind: 'diff', diff: { kind: 'wholeFile', path: '/w/a.ts', oldText: typed.after, newText: agents } }],
    }, 'v1');
    expect(baselineOf()).toBe(typed.after);
    subject.edited('/w/a.ts', 'undo', typed.after, agents, lineEdited(typed.after, 0, 'one').edits);
    expect(baselineOf()).toBeUndefined();
  });

  it("brings a change back for review on Ctrl+Z after the review's Undo", async () => {
    const { subject, baselineOf } = await takeovers();
    const undone = lineEdited(agents, 1, 'two');
    subject.edited('/w/a.ts', 'review', agents, undone.after, undone.edits);
    const redone = lineEdited(undone.after, 1, 'TWO');
    subject.edited('/w/a.ts', 'undo', undone.after, redone.after, redone.edits);
    expect(baselineOf()).toBe(baseline);
  });

  it('takes an undo to a text never seen as the user\'s edit', async () => {
    const { subject, baselineOf } = await takeovers();
    const { after, edits } = lineEdited(agents, 1, 'TWO?');
    subject.edited('/w/a.ts', 'undo', agents, after, edits);
    expect(baselineOf()).toBe(after);
  });

  it('does nothing for a file not under review', async () => {
    const { subject, baselineOf } = await takeovers();
    const { after, edits } = lineEdited(agents, 1, 'TWO!');
    subject.edited('/w/b.ts', 'user', agents, after, edits);
    expect(baselineOf()).toBe(baseline);
  });
});
