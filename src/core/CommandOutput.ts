import { Terminal, type IBuffer } from '@xterm/headless';

/** How much of a command's output the chat view shows: its last lines, up to a number of characters. */
const SHOWN_LINES = 2_000;
const SHOWN_CHARACTERS = 20_000;

/**
 * Wide enough that most lines do not wrap; each row costs memory by its width, whatever it holds, so the cleaner's
 * rows (a screen plus its scrollback, `SHOWN_LINES` in all) cost about 3.6 MB once full.
 */
const COLUMNS = 120;
const ROWS = 24;

/** The end of a command's output as a terminal shows it, cleaned of control sequences. */
export interface ShownOutput {
  text: string;
  /** Earlier output is not in `text`. */
  truncated: boolean;
}

/**
 * Applies a command's output as VS Code's terminal would, through its engine run headless, so a progress bar or a
 * redrawn line shows its last state only. Writes are applied in order, after they return.
 */
export class Cleaner {
  private readonly terminal = new Terminal({
    cols: COLUMNS,
    rows: ROWS,
    scrollback: SHOWN_LINES - ROWS,
    convertEol: true,
    // The headless build's buffer, which the text is read from, is a proposed API there.
    allowProposedApi: true,
  });

  write(text: string): void {
    this.terminal.write(text);
  }

  /** Once every write so far is applied: the last `SHOWN_LINES` rows, up to `SHOWN_CHARACTERS`. */
  async shown(): Promise<ShownOutput> {
    await new Promise<void>((resolve) => this.terminal.write('', resolve));
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    let length = 0;
    let row = lastRowWithText(buffer);
    while (row >= 0 && length <= SHOWN_CHARACTERS) {
      let line = '';
      for (let wrapped = true; wrapped && row >= 0; row--) {
        const bufferLine = buffer.getLine(row);
        wrapped = bufferLine?.isWrapped ?? false;
        // Trimming drops only cells never written, as a wide character that did not fit leaves; spaces written stay.
        line = (bufferLine?.translateToString(true) ?? '') + line;
      }
      lines.unshift(line);
      length += line.length + 1;
    }
    const text = lines.join('\n');
    // A buffer whose rows are all used has dropped, or is about to drop, its first.
    const full = buffer.length >= SHOWN_LINES;
    return text.length > SHOWN_CHARACTERS
      ? { text: text.slice(-SHOWN_CHARACTERS), truncated: true }
      : { text, truncated: full || row >= 0 };
  }

  dispose(): void {
    this.terminal.dispose();
  }
}

/** The last row holding anything: the screen's rows below the cursor are empty. */
function lastRowWithText(buffer: IBuffer): number {
  let row = buffer.length - 1;
  while (row >= 0 && buffer.getLine(row)?.translateToString(true) === '') {
    row--;
  }
  return row;
}

/** A command's whole output, cleaned once, as the chat view shows a command's text that no terminal carries. */
export async function cleaned(text: string): Promise<ShownOutput> {
  const cleaner = new Cleaner();
  try {
    cleaner.write(text);
    return await cleaner.shown();
  } finally {
    cleaner.dispose();
  }
}

/**
 * Output as a VS Code terminal must be written it: VS Code writes a pseudoterminal's text as it is, so a line ending
 * a pipe wrote, `\n` alone, would start the next line where the last one ended. A `\r` and its `\n` split between two
 * writes become `\r\r\n`, which shows the same.
 */
export function forTerminal(text: string): string {
  return text.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n');
}
