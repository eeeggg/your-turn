import { describe, expect, it, onTestFinished, vi } from 'vitest';
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

    it.each([
      { name: '4 KiB', sizes: [4 * 1024] },
      { name: '10 MiB', sizes: [10 * 1024 * 1024] },
      { name: '50 MiB stress case', sizes: [50 * 1024 * 1024] },
      { name: 'five growing snapshots, 1–5 MiB (15 MiB total)', sizes: [1, 2, 3, 4, 5].map((size) => size * 1024 * 1024) },
    ])('finishes queued parsing and preserves the final output: $name', async ({ sizes }) => {
      const line = `${ESC}[32mPASS${ESC}[0m command output ${'x'.repeat(80)}\n`;
      const ending = '\nfinal output';
      const inputs = sizes.map((size) =>
        line.repeat(Math.ceil(size / line.length)).slice(0, size - ending.length) + ending,
      );
      const pending = inputs.map(cleaned);
      const outputs = await Promise.all(pending);

      expect(outputs).toHaveLength(sizes.length);
      for (const [index, output] of outputs.entries()) {
        expect(output.text.endsWith('\nfinal output')).toBe(true);
        expect(output.text).not.toContain(ESC);
        expect(output.text.length).toBeLessThanOrEqual(20_000);
        expect(output.truncated).toBe((sizes[index] ?? 0) > 20_000);
      }
    });
  });

  describe('Cleaner', () => {
    it('applies an escape sequence split between writes, and shows what has been written so far each time', async () => {
      const cleaner = new Cleaner();
      onTestFinished(async () => { await cleaner.dispose(); });
      try {
        cleaner.write(`${ESC}[3`);
        cleaner.write(`1mred${ESC}[0m\nnext`);
        expect(await cleaner.shown()).toEqual({ text: 'red\nnext', truncated: false });
        cleaner.write('\rlast');
        expect(await cleaner.shown()).toEqual({ text: 'red\nlast', truncated: false });
      } finally {
        await cleaner.dispose();
      }
    });

    it('drains accepted writes and reads before disposal, once, without accepting more work', async () => {
      vi.useFakeTimers();
      onTestFinished(() => { vi.useRealTimers(); });
      const cleaner = new Cleaner();
      onTestFinished(async () => {
        const disposed = cleaner.dispose();
        await vi.runAllTimersAsync();
        await disposed;
      });
      cleaner.write('first\n');
      const first = cleaner.shown();
      cleaner.write('last');
      const last = cleaner.shown();
      const completed: string[] = [];
      void first.then(() => completed.push('first'));
      void last.then(() => completed.push('last'));
      const disposed = cleaner.dispose();
      const completedAtDisposal = disposed.then(() => [...completed]);
      expect(cleaner.dispose()).toBe(disposed);
      expect(() => cleaner.write('too late')).toThrow('disposed');
      await vi.runAllTimersAsync();
      await disposed;

      expect(await completedAtDisposal).toEqual(['first', 'last']);
      expect(await first).toEqual({ text: 'first', truncated: false });
      expect(await last).toEqual({ text: 'first\nlast', truncated: false });
      expect(vi.getTimerCount()).toBe(0);
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
