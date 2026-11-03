import { constants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageSize } from 'image-size';

const limit = 10 * 1024 * 1024;

function contained(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

/** Read through anchored directory descriptors, never through a path checked before opening it. */
export async function readMarkdownImage(root: string | undefined, source: string, signal: AbortSignal): Promise<{ data: string; mimeType: string }> {
  if (!root || !isAbsolute(root)) { throw new Error('Session image directory is unknown'); }
  // Node has no portable openat API. Other platforms fail closed rather than using a racy path read.
  if (process.platform !== 'linux') { throw new Error('Safe local image reads are unavailable on this platform'); }
  const handles: FileHandle[] = [];
  try {
    signal.throwIfAborted();
    let path: string;
    if (/^file:/i.test(source)) {
      const url = new URL(source);
      if (url.host || url.search || url.hash) { throw new Error('Unsupported image file URL'); }
      path = fileURLToPath(url);
    } else {
      if (/^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith('//') || source.includes('\\')) {
        throw new Error('Image source not supported');
      }
      path = decodeURIComponent(source);
    }
    const boundary = await realpath(root);
    const requested = resolve(root, path);
    if (!contained(root, requested)) { throw new Error('Image file is outside the session directory'); }
    const target = await realpath(requested);
    if (!contained(boundary, target)) { throw new Error('Image file is outside the session directory'); }
    const directory = await open(boundary, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(directory);
    if (await realpath(`/proc/self/fd/${directory.fd}`) !== boundary) { throw new Error('Image directory changed during access'); }
    let parent = directory;
    const parts = relative(boundary, target).split(sep).filter(Boolean);
    if (parts.length === 0) { throw new Error('Image file is not a regular file'); }
    for (const [index, part] of parts.entries()) {
      signal.throwIfAborted();
      const last = index === parts.length - 1;
      const handle = await open(`/proc/self/fd/${parent.fd}/${part}`, constants.O_RDONLY | constants.O_NOFOLLOW
        | (last ? constants.O_NONBLOCK : constants.O_DIRECTORY));
      handles.push(handle);
      parent = handle;
    }
    const file = parent;
    const before = await file.stat();
    if (!before.isFile()) { throw new Error('Image file is not a regular file'); }
    if (before.size > limit) { throw new Error('Image file is too large'); }
    const openedRoot = await realpath(`/proc/self/fd/${directory.fd}`);
    const openedFile = await realpath(`/proc/self/fd/${file.fd}`);
    if (!contained(openedRoot, openedFile)) { throw new Error('Image file is outside the session directory'); }
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      signal.throwIfAborted();
      const buffer = Buffer.alloc(Math.min(64 * 1024, limit + 1 - size));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) { break; }
      size += bytesRead;
      if (size > limit) { throw new Error('Image file is too large'); }
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('Image file changed during read');
    }
    signal.throwIfAborted();
    const bytes = Buffer.concat(chunks, size);
    let type: string | undefined;
    try { type = imageSize(bytes).type; } catch { throw new Error('Unsupported image format'); }
    const mimeType = ({ png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as Record<string, string>)[type ?? ''];
    if (!mimeType) { throw new Error('Unsupported image format'); }
    return { data: bytes.toString('base64'), mimeType };
  } catch (error) {
    if (error instanceof Error && !('code' in error) && !(error instanceof URIError)) { throw error; }
    throw new Error('Could not read image file');
  } finally {
    await Promise.all(handles.reverse().map((handle) => handle.close()));
  }
}
