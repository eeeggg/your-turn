/** A text and the text an agent might have made of it. */
export interface EditedText {
  readonly original: string;
  readonly modified: string;
}

// Lines that invite equally valid alignments: blanks, closing brackets, repeats.
const VOCABULARY = [
  '', '', '', '}', '  }', '    }', '});', ']', 'return x;', '  return x;', 'x++;', '  x++;',
  'function f() {', 'function g() {', '  if (x) {', '    y();', 'const a = 1;', 'const b = 2;', '// note', ' ',
];

/** `count` texts from `seed`, each with one to three agent-like edits: blocks added, copied, deleted, replaced or reindented, and the final line break. */
export function editedTexts(seed: number, count: number): EditedText[] {
  let state = seed >>> 0;
  const next = (below: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % below;
  };
  const block = (length: number) => Array.from({ length }, () => VOCABULARY[next(VOCABULARY.length)] as string);
  const texts: EditedText[] = [];
  for (let i = 0; i < count; i++) {
    const lines = block(next(40));
    const endsWithBreak = next(4) > 0;
    const edited = [...lines];
    let editedEndsWithBreak = endsWithBreak;
    for (let edits = 1 + next(3); edits > 0; edits--) {
      const at = next(edited.length + 1);
      const length = 1 + next(5);
      switch (next(6)) {
        case 0: edited.splice(at, 0, ...block(length)); break;
        case 1: edited.splice(at, 0, ...edited.slice(next(edited.length + 1), next(edited.length + 1))); break;
        case 2: edited.splice(at, length); break;
        case 3: edited.splice(at, length, ...block(1 + next(5))); break;
        case 4: edited.splice(at, length, ...edited.slice(at, at + length).map((line) => '  ' + line)); break;
        default: editedEndsWithBreak = !editedEndsWithBreak;
      }
    }
    texts.push({ original: text(lines, endsWithBreak), modified: text(edited, editedEndsWithBreak) });
  }
  return texts;
}

function text(lines: readonly string[], endsWithBreak: boolean): string {
  return lines.length === 0 ? '' : lines.join('\n') + (endsWithBreak ? '\n' : '');
}
