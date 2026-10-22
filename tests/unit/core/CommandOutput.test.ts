import { describe, expect, it } from 'vitest';
import { Cleaner, cleaned, forTerminal } from '@/core/CommandOutput';

const ESC = '\x1b';

describe('CommandOutput', () => {
  describe('cleaned', () => {
    it('shows output as a terminal does once done: colours, links and titles gone, each redrawn line in its last state', async () => {
      const output = [
        `${ESC}]0;npm test${ESC}\\${ESC}[32m✓${ESC}[0m passed ${ESC}]8;;https://example.com${ESC}\\café 😀${ESC}]8;;${ESC}\\`,
        'Downloading 10%\rDownloading 55%\rDownloading done',
        'layer 1: waiting',
        `layer 2: waiting${ESC}[1A\r${ESC}[2Klayer 1: done\n${ESC}[2Klayer 2: done`,
        '',
      ].join('\n');

      expect(await cleaned(output)).toEqual({
        text: '✓ passed café 😀\nDownloading done\nlayer 1: done\nlayer 2: done',
        truncated: false,
      });
    });

    it("keeps a line longer than the cleaner's width whole, and the blank lines between others", async () => {
      const long = `${'a'.repeat(119)} ${'b'.repeat(200)}`;
      expect(await cleaned(`${long}\n\n\nend\n\n`)).toEqual({ text: `${long}\n\n\nend`, truncated: false });
    });

    it('joins a line wrapped where a wide character did not fit, adding no space for the cell it left empty', async () => {
      const long = `${'a'.repeat(119)}中 trailing spaces written   `;
      expect(await cleaned(long)).toEqual({ text: long, truncated: false });
    });

    it('shows the last 2,000 lines, and says earlier ones are not shown', async () => {
      const lines = Array.from({ length: 10_000 }, (_, i) => `${i + 1}`);
      const { text, truncated } = await cleaned(lines.join('\n'));
      expect(text).toBe(lines.slice(-2_000).join('\n'));
      expect(truncated).toBe(true);
    });

    it('shows the last 20,000 characters, and says earlier ones are not shown', async () => {
      const lines = Array.from({ length: 300 }, (_, i) => `${i}`.padStart(99, '.'));
      const { text, truncated } = await cleaned(lines.join('\n'));
      expect(text).toBe(lines.join('\n').slice(-20_000));
      expect(truncated).toBe(true);
    });

    it('shows output of just under the caps whole', async () => {
      const lines = Array.from({ length: 1_000 }, (_, i) => `${i}`.padStart(19, '.'));
      expect(await cleaned(lines.join('\n'))).toEqual({ text: lines.join('\n'), truncated: false });
    });
  });

  describe('Cleaner', () => {
    it('applies an escape sequence split between writes, and shows what has been written so far each time', async () => {
      const cleaner = new Cleaner();
      try {
        cleaner.write(`${ESC}[3`);
        cleaner.write(`1mred${ESC}[0m\nnext`);
        expect(await cleaner.shown()).toEqual({ text: 'red\nnext', truncated: false });
        cleaner.write('\rlast');
        expect(await cleaner.shown()).toEqual({ text: 'red\nlast', truncated: false });
      } finally {
        cleaner.dispose();
      }
    });
  });

  describe('forTerminal', () => {
    it('ends each line as a terminal needs, leaving a line already ended so and a carriage return alone as they are', () => {
      expect(forTerminal('pipe\nwritten\n')).toBe('pipe\r\nwritten\r\n');
      expect(forTerminal('pty\r\nwritten\r\n')).toBe('pty\r\nwritten\r\n');
      expect(forTerminal('10%\r55%\rdone\n')).toBe('10%\r55%\rdone\r\n');
    });
  });
});
