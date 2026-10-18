import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRegistryCache, fetchRegistry } from '@/core/RegistryClient';

const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
const agents = [{ name: 'Claude Code', command: 'npx' }];

function respond(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) {
    fetch.mockResolvedValueOnce(response);
  }
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const ok = () => Response.json({ agents });
const unavailable = () => new Response(null, { status: 503, statusText: 'Service Unavailable' });

describe('fetchRegistry', () => {
  beforeEach(() => {
    clearRegistryCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fetches the registry once every five minutes', async () => {
    const fetch = respond(ok(), ok());

    expect(await fetchRegistry()).toEqual(agents);
    vi.advanceTimersByTime(5 * 60 * 1000 - 1);
    expect(await fetchRegistry()).toEqual(agents);
    vi.advanceTimersByTime(1);
    expect(await fetchRegistry()).toEqual(agents);

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([REGISTRY_URL, REGISTRY_URL]);
  });

  it('fails when the registry cannot be fetched and no earlier copy exists', async () => {
    respond(unavailable());

    await expect(fetchRegistry()).rejects.toThrow('HTTP 503: Service Unavailable');
  });

  it('falls back to the last copy it fetched', async () => {
    respond(ok(), unavailable());

    await fetchRegistry();
    vi.advanceTimersByTime(5 * 60 * 1000);

    expect(await fetchRegistry()).toEqual(agents);
  });
});
