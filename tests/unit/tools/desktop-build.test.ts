import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { expect, it, onTestFinished } from 'vitest';

it('prepares a self-contained desktop artifact without replacing ordinary development output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-build-'));
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, 'tools'));
  await cp(resolve('esbuild.mjs'), join(root, 'esbuild.mjs'));
  await cp(resolve('tools/icons.mjs'), join(root, 'tools/icons.mjs'));
  await symlink(resolve('node_modules'), join(root, 'node_modules'));
  const manifest = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as Record<string, unknown>;
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
  for (const [path, text] of Object.entries({
    'src/extension.ts': 'export const identity = "ordinary";',
    'tests/ui/instrumentation/extension.ts': 'export const identity = "desktop";',
    'src/webview/Main.tsx': 'globalThis.webviewReady = true;',
    'src/webview/chat.css': 'body { color: black; }',
    'tests/integration/sample.test.ts': 'export const integration = true;',
    'tests/integration/fixtures/fakeAgent-v1.ts': 'console.log("fake v1");',
    'tests/integration/fixtures/fakeAgent-v2.ts': 'console.log("fake v2");',
  })) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  }
  async function bundle(args: string[]) {
    const child = spawn(process.execPath, ['esbuild.mjs', ...args], { cwd: root });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (text: string) => { output += text; });
    child.stderr.setEncoding('utf8').on('data', (text: string) => { output += text; });
    const code = await new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', resolveExit);
    });
    expect(code, output).toBe(0);
  }
  await bundle([]);
  const ordinary = await readFile(join(root, 'dist/extension.js'), 'utf8');
  await writeFile(join(root, 'dist/extension.js'), ordinary + '\n// Retained development output\n');
  const ordinaryIcon = await readFile(join(root, 'resources/icon.png'));
  await bundle(['--ui']);
  expect(await readFile(join(root, 'dist/extension.js'), 'utf8')).toBe(ordinary + '\n// Retained development output\n');
  expect(await readFile(join(root, 'resources/icon.png'))).toEqual(ordinaryIcon);
  const artifact = join(root, 'test-results/ui-extension');
  expect(await readFile(join(artifact, 'dist/extension.js'), 'utf8')).toContain('desktop');
  const desktop = JSON.parse(await readFile(join(artifact, 'package.json'), 'utf8')) as Record<string, unknown>;
  expect(desktop).toEqual({ ...manifest, main: './dist/extension.js', yourTurnDesktopTest: true });
  for (const path of ['dist/webview/chat.js', 'dist/webview/chat.css', 'resources/icon.svg', 'resources/icon.png', 'dist/test/fixtures/fakeAgent-v1.js', 'dist/test/fixtures/fakeAgent-v2.js']) {
    expect((await readFile(join(artifact, path))).byteLength, path).toBeGreaterThan(0);
  }
  await bundle([]);
  expect(await readFile(join(artifact, 'package.json'), 'utf8')).toBe(JSON.stringify(desktop, undefined, 2) + '\n');
});

it('bundles ordinary activation without desktop controls and composes desktop decorators explicitly', async () => {
  for (const minify of [false, true]) {
    const ordinary = await build({ entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false, metafile: true, minify });
    expect(Object.keys(ordinary.metafile.inputs).filter((path) => path.startsWith('tests/'))).toEqual([]);
    expect(ordinary.outputFiles[0]?.text).not.toContain('UI_TREE_REFRESH_PORT');
    expect(ordinary.outputFiles[0]?.text).not.toContain('UI_REVIEW_PRESENTATION_PORT');
  }
  const desktop = await build({ entryPoints: ['tests/ui/instrumentation/extension.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false, metafile: true });
  expect(Object.keys(desktop.metafile.inputs)).toEqual(expect.arrayContaining([
    'src/adapters/ExtensionActivation.ts',
    'src/adapters/SessionTreeProvider.ts',
    'src/adapters/review/ReviewPresenters.ts',
    'tests/ui/instrumentation/SessionTreeProvider.ts',
    'tests/ui/instrumentation/ReviewPresenters.ts',
    'tests/ui/instrumentation/ControlChannel.ts',
  ]));
  expect(desktop.outputFiles[0]?.text).toContain('UI_TREE_REFRESH_PORT');
  expect(desktop.outputFiles[0]?.text).toContain('UI_REVIEW_PRESENTATION_PORT');
});
