import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

export const vscodeVersion = '1.144.1';

/** @param {string} root @param {{ recordIdentity?: boolean }} [options] */
export async function prepareVSCode(root, options = {}) {
  const cachePath = join(root, '.vscode-test');
  await mkdir(cachePath, { recursive: true });
  const executablePath = await downloadAndUnzipVSCode({ version: vscodeVersion, cachePath });
  if (options.recordIdentity) {
    const directory = dirname(executablePath);
    let app = basename(directory) === 'MacOS'
      ? join(dirname(directory), 'Resources', 'app')
      : join(directory, 'resources', 'app');
    if (executablePath.endsWith('.exe') && !(await stat(app).catch(() => undefined))?.isDirectory()) {
      const entries = await readdir(directory);
      const versioned = entries.filter((entry) => /^[0-9a-f]{10}$/.test(entry));
      for (const entry of versioned) {
        const candidate = join(directory, entry, 'resources', 'app');
        if ((await stat(candidate).catch(() => undefined))?.isDirectory()) { app = candidate; break; }
      }
    }
    /** @type {unknown} */
    const packageJson = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'));
    /** @type {unknown} */
    const productJson = JSON.parse(await readFile(join(app, 'product.json'), 'utf8'));
    const metadata = /** @type {{ version?: unknown }} */ (packageJson);
    const product = /** @type {{ commit?: unknown }} */ (productJson);
    if (typeof metadata.version !== 'string' || !metadata.version.trim()) { throw new Error(`Extracted VS Code package.version is missing: ${app}`); }
    if (typeof product.commit !== 'string' || !product.commit.trim()) { throw new Error(`Extracted VS Code product.commit is missing: ${app}`); }
    const identity = { version: metadata.version, commit: product.commit, executablePath };
    await mkdir(join(root, 'test-results'), { recursive: true });
    await writeFile(join(root, 'test-results', 'ui-editor.json'), `${JSON.stringify(identity, null, 2)}\n`);
    console.log(`UI editor: VS Code ${identity.version}, commit ${identity.commit}, executable ${executablePath}`);
  }
  return executablePath;
}
