import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';

// Three equal-width character cells; the lowercase v starts below the brace tops.
const leftBrace = 'M7 5H6C5 5 5 6 5 7V9C5 11 4 12 3 12C4 12 5 13 5 15V17C5 18 5 19 6 19H7';
const letterV = 'M9 9L12 17L15 9';
const rightBrace = 'M17 5H18C19 5 19 6 19 7V9C19 11 20 12 21 12C20 12 19 13 19 15V17C19 18 19 19 18 19H17';
const paths = [leftBrace, letterV, rightBrace].map((d) => `<path d="${d}"/>`).join('');

/** @param {string} directory */
export async function generateIcons(directory) {
  const attributes = 'fill="none" stroke-linecap="square" stroke-linejoin="miter"';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g ${attributes} stroke="black" stroke-width="2">${paths}</g></svg>\n`;
  const pngSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 24 24"><rect width="24" height="24" fill="#1E1E1E"/><g ${attributes} stroke="#F0F0F0" stroke-width="2">${paths}</g></svg>`;
  const png = new Resvg(pngSvg, { font: { loadSystemFonts: false } }).render().asPng();
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(join(directory, 'icon.svg'), svg),
    writeFile(join(directory, 'icon.png'), png),
  ]);
}
