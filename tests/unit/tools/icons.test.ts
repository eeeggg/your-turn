import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageSize } from 'image-size';
import { Resvg } from '@resvg/resvg-js';
import { generateIcons } from '@tools/icons.mjs';
import { expect, it, onTestFinished } from 'vitest';

it('generates font-independent transparent icons reproducibly for the build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'icons-test-'));
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });
  const directory = join(root, 'resources');
  await generateIcons(directory);
  const svg = await readFile(join(directory, 'icon.svg'), 'utf8');
  const png = await readFile(join(directory, 'icon.png'));
  expect(imageSize(png)).toMatchObject({ width: 256, height: 256, type: 'png' });
  expect(svg).not.toMatch(/<text|font-family|<image/);
  const rendered = new Resvg(svg, { font: { loadSystemFonts: false } }).render();
  expect([rendered.width, rendered.height]).toEqual([24, 24]);
  const alpha = Array.from(rendered.pixels).filter((_, index) => index % 4 === 3);
  expect(alpha).toContain(0);
  expect(alpha).toContain(255);
  await generateIcons(directory);
  expect(await readFile(join(directory, 'icon.svg'), 'utf8')).toBe(svg);
  expect(await readFile(join(directory, 'icon.png'))).toEqual(png);
});
