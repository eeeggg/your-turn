import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import * as https from 'node:https';
import * as dns from 'node:dns/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchMarkdownImage } from '@/core/MarkdownImageNetwork';

vi.mock('node:https', async (original) => ({ ...await original<typeof https>(), request: vi.fn() }));
vi.mock('node:dns/promises', async (original) => ({ ...await original<typeof dns>(), lookup: vi.fn() }));

afterEach(() => vi.resetAllMocks());

describe('production image HTTPS request boundary', () => {
  it('pins the connection address, retains TLS identity, and sends no ambient credentials or referrer', async () => {
    vi.mocked(dns.lookup).mockImplementation((async () => [{ address: '93.184.216.34', family: 4 }]) as unknown as typeof dns.lookup);
    const bytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
    let options: https.RequestOptions | undefined;
    vi.mocked(https.request).mockImplementation(((given: https.RequestOptions, callback: (response: unknown) => void) => {
      options = given;
      const req = new EventEmitter();
      return Object.assign(req, { end() { callback(Object.assign(Readable.from([bytes]), { statusCode: 200, headers: { 'content-type': 'image/gif' } })); } });
    }) as typeof https.request);
    const signal = new AbortController().signal;
    expect(await fetchMarkdownImage('https://images.example/a?secret=token', signal)).toEqual({ data: bytes.toString('base64'), mimeType: 'image/gif' });
    expect(options).toEqual({
      protocol: 'https:', hostname: '93.184.216.34', family: 4, port: 443, servername: 'images.example',
      path: '/a?secret=token', method: 'GET', agent: false, signal, rejectUnauthorized: true,
      headers: { Host: 'images.example', Accept: 'image/png, image/jpeg, image/gif, image/webp', 'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': 'Your-Turn (https://github.com/eeeggg/your-turn)' },
    });
    expect(dns.lookup).toHaveBeenCalledExactlyOnceWith('images.example', { all: true, verbatim: true });
  });

  it('redacts transport errors rather than exposing a signed source URL', async () => {
    vi.mocked(dns.lookup).mockImplementation((async () => [{ address: '93.184.216.34', family: 4 }]) as unknown as typeof dns.lookup);
    vi.mocked(https.request).mockImplementation((() => {
      const req = new EventEmitter();
      return Object.assign(req, { end() { req.emit('error', new Error('https://images.example/?secret=token')); } });
    }) as unknown as typeof https.request);
    await expect(fetchMarkdownImage('https://images.example/?secret=token', new AbortController().signal)).rejects.toThrow(/^Could not download image$/);
  });
});
