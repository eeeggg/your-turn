import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { fetchMarkdownImage, publicImageAddress, type ImageNetwork } from '@/core/MarkdownImageNetwork';

const bytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');

function network(replies: { status?: number; headers?: Record<string, string>; chunks?: Buffer[] }[] = [{}]) {
  const requests: { url: string; address: string; family: number }[] = [];
  const resolved: string[] = [];
  const io: ImageNetwork = {
    async lookup(hostname) { resolved.push(hostname); return [{ address: '93.184.216.34', family: 4 }]; },
    async request(url, address, signal) {
      signal.throwIfAborted();
      requests.push({ url: url.href, ...address });
      const next = replies.shift();
      if (!next) { throw new Error('Unexpected image request'); }
      return { status: next.status ?? 200, headers: next.headers ?? { 'content-type': 'image/gif' }, body: Readable.from(next.chunks ?? [bytes]) };
    },
  };
  return { io, requests, resolved };
}

describe('Markdown HTTPS image policy', () => {
  it.each([403, 404, 429, 503])('reports HTTP %i without exposing response content or the source URL', async (status) => {
    const { io } = network([{ status, chunks: [Buffer.from('sensitive server response')] }]);
    await expect(fetchMarkdownImage('https://images.example/a?secret=token', new AbortController().signal, io))
      .rejects.toThrow(new Error(`Image server returned HTTP ${status}`));
  });
  it.each(['127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.1.2', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '192.0.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:93.184.216.34', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '64:ff9b::7f00:1', '2002:7f00:1::', 'invalid'])('rejects non-public address %s', (address) => {
    expect(publicImageAddress(address)).toBe(false);
  });

  it.each(['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111'])('accepts public address %s', (address) => {
    expect(publicImageAddress(address)).toBe(true);
  });

  it('connects only to the approved DNS address and follows a validated cross-origin redirect', async () => {
    const { io, requests, resolved } = network([{ status: 302, headers: { location: 'https://cdn.example/image.gif' } }, {}]);
    const result = await fetchMarkdownImage('https://images.example/a?secret=token', new AbortController().signal, io);
    expect(result).toEqual({ data: bytes.toString('base64'), mimeType: 'image/gif' });
    expect(resolved).toEqual(['images.example', 'cdn.example']);
    expect(requests).toEqual([
      { url: 'https://images.example/a?secret=token', address: '93.184.216.34', family: 4 },
      { url: 'https://cdn.example/image.gif', address: '93.184.216.34', family: 4 },
    ]);
  });

  it.each(['http://images.example/a', 'https://user:password@images.example/a', 'https://127.0.0.1/a', 'file:///a'])('rejects unsafe initial destination %s without a request', async (url) => {
    const { io, requests } = network();
    await expect(fetchMarkdownImage(url, new AbortController().signal, io)).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it('rejects DNS containing a private address before connecting', async () => {
    const { io, requests } = network();
    io.lookup = async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }];
    await expect(fetchMarkdownImage('https://images.example/a', new AbortController().signal, io)).rejects.toThrow('public');
    expect(requests).toEqual([]);
  });

  it.each(['http://cdn.example/a', 'https://user:password@cdn.example/a', 'https://[::ffff:127.0.0.1]/a'])('rejects unsafe redirect %s before another request', async (location) => {
    const { io, requests } = network([{ status: 302, headers: { location } }]);
    await expect(fetchMarkdownImage('https://images.example/a', new AbortController().signal, io)).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  it('permits five redirects but rejects a sixth', async () => {
    const { io, requests } = network(Array.from({ length: 6 }, () => ({ status: 302, headers: { location: '/again' } })));
    await expect(fetchMarkdownImage('https://images.example/a', new AbortController().signal, io)).rejects.toThrow('redirect');
    expect(requests).toHaveLength(6);
  });

  it.each([{}, { 'content-type': 'image/svg+xml' }, { 'content-type': 'text/plain' }, { 'content-type': 'image/gif, image/png' }])('requires a supported unambiguous Content-Type %j', async (headers) => {
    const { io } = network([{ headers }]);
    await expect(fetchMarkdownImage('https://images.example/a', new AbortController().signal, io)).rejects.toThrow('Content-Type');
  });

  it('bounds uncompressed streaming bodies without Content-Length', async () => {
    const { io } = network([{ chunks: [Buffer.alloc(6 * 1024 * 1024), Buffer.alloc(5 * 1024 * 1024)] }]);
    await expect(fetchMarkdownImage('https://images.example/a', new AbortController().signal, io)).rejects.toThrow('large');
  });

  it('bounds decompressed bytes independently of the compressed transfer', async () => {
    const { io } = network([{ headers: { 'content-type': 'image/gif', 'content-encoding': 'gzip' }, chunks: [gzipSync(Buffer.alloc(11 * 1024 * 1024))] }]);
    await expect(fetchMarkdownImage('https://images.example/a', new AbortController().signal, io)).rejects.toThrow('large');
  });

  it('decodes a bounded compressed response', async () => {
    const { io } = network([{ headers: { 'content-type': 'image/gif; charset=binary', 'content-encoding': 'gzip' }, chunks: [gzipSync(bytes)] }]);
    expect(await fetchMarkdownImage('https://images.example/a', new AbortController().signal, io)).toEqual({ data: bytes.toString('base64'), mimeType: 'image/gif' });
  });
});
