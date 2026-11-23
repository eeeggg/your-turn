import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Zero-based lines. A missing end line means place the cursor at the start. */
export interface FileLanding {
  startLine: number;
  endLine?: number;
}

export function resolveTranscriptFile(destination: string, cwd: string | undefined): { path: string; fragment: string } {
  if (!destination || /^[#?]|^\/\/|[\x00-\x1f\x7f]/.test(destination)) { throw new Error('Unsupported file link'); }
  const nativeAbsolute = isAbsolute(destination);
  const fileUrl = !nativeAbsolute && /^file:/i.test(destination);
  if (!fileUrl && !nativeAbsolute && /^[a-z][a-z\d+.-]*:/i.test(destination)) { throw new Error('Unsupported file link'); }
  if (fileUrl && !/^file:\/\/\/[^/\\]/i.test(destination)) { throw new Error('Hostless absolute file URL required'); }
  // An opaque path keeps relative segments and native separators intact for node:path.
  const url = new URL(fileUrl ? destination : `transcript-path:!${destination}`);
  if (url.search || (fileUrl && url.host)) { throw new Error('Unsupported file URL'); }
  const path = fileUrl ? fileURLToPath(url) : decodeURIComponent(url.pathname.slice(1));
  if (!path || /[\x00-\x1f\x7f]/.test(path)) { throw new Error('Invalid file path'); }
  if (!isAbsolute(path) && (!cwd || !isAbsolute(cwd))) { throw new Error('Session directory is unknown'); }
  let fragment = '';
  try { fragment = decodeURIComponent(url.hash.slice(1)); } catch { /* An invalid fragment does not prevent opening the file. */ }
  return { path: isAbsolute(path) ? resolve(path) : resolve(cwd ?? '', path), fragment };
}
