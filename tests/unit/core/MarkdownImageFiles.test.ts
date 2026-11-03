import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { readMarkdownImage } from '@/core/MarkdownImageFiles';

vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof fs>(), open: vi.fn((await original<typeof fs>()).open) }));

afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const directory = await fs.mkdtemp('/tmp/opencode/image-file-race-');
  onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'session');
  await fs.mkdir(root);
  const bytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
  await fs.writeFile(join(root, 'tiny.gif'), bytes);
  await fs.writeFile(join(directory, 'outside.gif'), bytes);
  return { directory, root };
}

describe('local image descriptor containment', () => {
  it('rejects a symlink swapped in after resolved-path checks before reading any payload', async () => {
    const { directory, root } = await fixture();
    const original = await vi.importActual<typeof fs>('node:fs/promises');
    let swapped = false;
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      if (String(path).startsWith('/proc/self/fd/') && String(path).endsWith('/tiny.gif')) {
        swapped = true;
        await fs.rename(join(root, 'tiny.gif'), join(root, 'original.gif'));
        await fs.symlink(join(directory, 'outside.gif'), join(root, 'tiny.gif'));
      }
      return original.open(path, flags, mode);
    });
    await expect(readMarkdownImage(root, 'tiny.gif', new AbortController().signal)).rejects.toThrow('Could not read image file');
    expect(swapped).toBe(true);
  });

  it('rejects a directory moved outside the pinned boundary during descriptor traversal', async () => {
    const { directory, root } = await fixture();
    const original = await vi.importActual<typeof fs>('node:fs/promises');
    await fs.mkdir(join(root, 'nested'));
    await fs.rename(join(root, 'tiny.gif'), join(root, 'nested', 'tiny.gif'));
    let moved = false;
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      if (String(path).startsWith('/proc/self/fd/') && String(path).endsWith('/tiny.gif')) {
        moved = true;
        await fs.rename(join(root, 'nested'), join(directory, 'moved'));
      }
      return original.open(path, flags, mode);
    });
    await expect(readMarkdownImage(root, 'nested/tiny.gif', new AbortController().signal)).rejects.toThrow('outside');
    expect(moved).toBe(true);
  });

  it('rejects a FIFO without opening a blocking reader', async () => {
    const { root } = await fixture();
    execFileSync('mkfifo', [join(root, 'pipe.gif')]);
    await expect(readMarkdownImage(root, 'pipe.gif', new AbortController().signal)).rejects.toThrow('not a regular file');
  });

  it.each([undefined, '', 'relative'])('fails closed when the originating directory is %s', async (root) => {
    await expect(readMarkdownImage(root, 'tiny.gif', new AbortController().signal)).rejects.toThrow('unknown');
  });

  it.each(['file://other/image.gif', 'vscode-remote://other/image.gif', '//other/image.gif', '..%2Foutside.gif'])('blocks unsupported or outside reference %s', async (source) => {
    const { root } = await fixture();
    await expect(readMarkdownImage(root, source, new AbortController().signal)).rejects.toThrow();
  });
});
