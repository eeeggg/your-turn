import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

export const vscodeVersion = '1.144.1';

/** @param {string} root */
export async function prepareVSCode(root) {
  const cachePath = join(root, '.vscode-test');
  await mkdir(cachePath, { recursive: true });
  return downloadAndUnzipVSCode({ version: vscodeVersion, cachePath });
}
