import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ download: vi.fn<() => Promise<string>>() }));
vi.mock('@vscode/test-electron', () => ({ downloadAndUnzipVSCode: boundary.download }));
const { prepareVSCode } = await import(resolve(import.meta.dirname, '../../../tools/vscode-test.mjs')) as {
  prepareVSCode(root: string, options?: { recordIdentity: boolean }): Promise<string>;
};

afterEach(() => { vi.restoreAllMocks(); boundary.download.mockReset(); });

async function editor(executable: string, app: string, product: object = { commit: '0123456789abcdef0123456789abcdef01234567' }) {
  const root = await mkdtemp(join(tmpdir(), 'editor-identity-'));
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });
  const installation = join(root, '.vscode-test', 'extracted-editor');
  const executablePath = join(installation, executable);
  await mkdir(dirname(executablePath), { recursive: true });
  await writeFile(executablePath, '');
  await mkdir(join(installation, app), { recursive: true });
  await writeFile(join(installation, app, 'package.json'), JSON.stringify({ version: '9.8.7-extracted' }));
  await writeFile(join(installation, app, 'product.json'), JSON.stringify(product));
  boundary.download.mockResolvedValue(executablePath);
  return { root, executablePath };
}

it.each([
  ['Linux', 'code', 'resources/app'],
  ['Windows', 'Code.exe', 'resources/app'],
  ['versioned Windows', 'Code.exe', '0123456789/resources/app'],
  ['macOS', 'Visual Studio Code.app/Contents/MacOS/Code', 'Visual Studio Code.app/Contents/Resources/app'],
])('records the extracted %s editor identity without changing the executable result', async (_platform, executable, app) => {
  const { root, executablePath } = await editor(executable, app);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const result = await prepareVSCode(root, { recordIdentity: true });
  expect(result).toBe(executablePath);
  const identity = JSON.parse(await readFile(join(root, 'test-results/ui-editor.json'), 'utf8')) as unknown;
  expect(identity).toEqual({ version: '9.8.7-extracted', commit: '0123456789abcdef0123456789abcdef01234567', executablePath });
  expect(log.mock.calls.flat().join('\n')).toContain('9.8.7-extracted');
  expect(log.mock.calls.flat().join('\n')).toContain('0123456789abcdef0123456789abcdef01234567');
});

it('rejects an extracted editor without a commit rather than recording an incomplete identity', async () => {
  const { root } = await editor('code', 'resources/app', {});
  await expect(prepareVSCode(root, { recordIdentity: true })).rejects.toThrow('commit');
});

it('keeps identity recording optional for existing preparation callers', async () => {
  const { root, executablePath } = await editor('code', 'resources/app');
  await rm(join(dirname(executablePath), 'resources'), { recursive: true });
  expect(await prepareVSCode(root)).toBe(executablePath);
  await expect(readFile(join(root, 'test-results/ui-editor.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});
