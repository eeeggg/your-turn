import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

export interface ImageNetwork {
  lookup(hostname: string): Promise<{ address: string; family: number }[]>;
  request(url: URL, address: { address: string; family: number }, signal: AbortSignal): Promise<{
    status: number; headers: Record<string, string | string[] | undefined>; body: Readable;
  }>;
}

const limit = 10 * 1024 * 1024;

const network: ImageNetwork = {
  lookup: (hostname) => lookup(hostname, { all: true, order: 'verbatim' }),
  request: (url, address, signal) => new Promise((resolve, reject) => {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    // Connect to the approved literal, retaining the original Host and TLS identity. No second DNS lookup.
    const req = request({
      protocol: 'https:', hostname: address.address, family: address.family, port: url.port || 443,
      servername: isIP(hostname) ? undefined : hostname, path: `${url.pathname}${url.search}`,
      method: 'GET', agent: false, signal, rejectUnauthorized: true,
      headers: { Host: url.host, Accept: 'image/png, image/jpeg, image/gif, image/webp', 'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': 'Your-Turn (https://github.com/eeeggg/your-turn)' },
    }, (response) => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: response }));
    req.on('error', () => reject(new Error('Could not download image')));
    req.end();
  }),
};

export function publicImageAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127
      || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 88 && c === 99)
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) !== 6 || address.includes('%')) { return false; }
  const [first = '', second = ''] = address.toLowerCase().split(':');
  const a = parseInt(first, 16);
  const b = parseInt(second || '0', 16);
  // Allow global unicast only; deny transition mechanisms and IANA special-purpose/documentation ranges.
  return a >= 0x2000 && a <= 0x3fff && a !== 0x2002
    && !(a === 0x2001 && (b <= 0x1ff || b === 0xdb8)) && !(a === 0x3fff && b <= 0xfff);
}

function destination(source: string): URL {
  let url: URL;
  try { url = new URL(source); } catch { throw new Error('Invalid image URL'); }
  if (url.protocol !== 'https:') { throw new Error('Only HTTPS image URLs are allowed'); }
  if (url.username || url.password) { throw new Error('Image URL credentials are not allowed'); }
  url.hash = '';
  return url;
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

export async function fetchMarkdownImage(source: string, signal: AbortSignal, io: ImageNetwork = network): Promise<{ data: string; mimeType: string }> {
  let url = destination(source);
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted();
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const family = isIP(hostname);
    const addresses = family ? [{ address: hostname, family }] : await io.lookup(hostname);
    signal.throwIfAborted();
    if (!addresses.length || addresses.some(({ address, family }) => !publicImageAddress(address) || isIP(address) !== family)) {
      throw new Error('Image destination must use public addresses');
    }
    const address = addresses[0];
    if (!address) { throw new Error('Image destination has no public address'); }
    const response = await io.request(url, address, signal);
    const { body } = response;
    const cancel = () => { body.destroy(new Error('Image loading cancelled')); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      signal.throwIfAborted();
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = header(response.headers, 'location');
        if (redirects === 5 || !location) { throw new Error('Image redirect limit exceeded or missing destination'); }
        url = destination(new URL(location, url).href);
        continue;
      }
      if (response.status !== 200) { throw new Error(`Image server returned HTTP ${response.status}`); }
      const mimeType = header(response.headers, 'content-type')?.split(';')[0]?.trim().toLowerCase();
      if (!mimeType || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType)) {
        throw new Error('Unsupported or missing image Content-Type');
      }
      const encoding = header(response.headers, 'content-encoding')?.toLowerCase().trim();
      if (encoding && !['identity', 'gzip', 'deflate', 'br'].includes(encoding)) { throw new Error('Unsupported image content encoding'); }
      let transferred = 0;
      const bounded = Readable.from((async function* () {
        for await (const chunk of body) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          transferred += bytes.length;
          if (transferred > limit) { throw new Error('Image transfer is too large'); }
          signal.throwIfAborted();
          yield bytes;
        }
      })());
      const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate()
        : encoding === 'br' ? createBrotliDecompress() : null;
      const stream = decoder ? bounded.pipe(decoder) : bounded;
      const forwardError = (error: Error) => { decoder?.destroy(error); };
      bounded.on('error', forwardError);
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const chunk of stream) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          size += bytes.length;
          if (size > limit) { throw new Error('Decoded image is too large'); }
          signal.throwIfAborted();
          chunks.push(bytes);
        }
        return { data: Buffer.concat(chunks, size).toString('base64'), mimeType };
      } finally {
        bounded.destroy();
        decoder?.destroy();
      }
    } finally {
      signal.removeEventListener('abort', cancel);
      body.destroy();
    }
  }
  throw new Error('Image redirect limit exceeded');
}
