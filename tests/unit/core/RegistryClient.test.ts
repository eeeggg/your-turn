import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRegistryCache, fetchRegistry, registryPlatform } from '@/core/RegistryClient';

const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';

/** `registry.json` as fetched on 2026-10-20. */
const recorded = JSON.parse(readFileSync(new URL('./fixtures/registry.json', import.meta.url), 'utf8')) as { agents: { id: string }[] };

const entry = {
  id: 'claude-acp',
  name: 'Claude Agent',
  version: '0.94.0',
  description: 'ACP wrapper for Anthropic\'s Claude',
  distribution: { npx: { package: '@agentclientprotocol/claude-agent-acp@0.94.0' } },
};
const agent = {
  id: 'claude-acp',
  name: 'Claude Agent',
  version: '0.94.0',
  description: 'ACP wrapper for Anthropic\'s Claude',
  runs: { through: 'npx', config: { command: 'npx', args: ['--yes', '@agentclientprotocol/claude-agent-acp@0.94.0'] } },
};

function respond(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) {
    fetch.mockResolvedValueOnce(response);
  }
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const ok = () => Response.json({ agents: [entry] });
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

    expect(await fetchRegistry()).toEqual([agent]);
    vi.advanceTimersByTime(5 * 60 * 1000 - 1);
    expect(await fetchRegistry()).toEqual([agent]);
    vi.advanceTimersByTime(1);
    expect(await fetchRegistry()).toEqual([agent]);

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

    expect(await fetchRegistry()).toEqual([agent]);
  });

  it('lists no agents from a registry without an agent list, fetched or cached', async () => {
    respond(Response.json({}));

    expect(await fetchRegistry()).toEqual([]);
    expect(await fetchRegistry()).toEqual([]);
  });

  describe('reads a recorded copy of the registry', () => {
    async function recordedAgent(id: string) {
      respond(Response.json(recorded));
      return (await fetchRegistry()).find((a) => a.id === id);
    }

    it('reads every entry', async () => {
      respond(Response.json(recorded));

      expect((await fetchRegistry()).map((a) => a.id)).toEqual(recorded.agents.map((a) => a.id));
    });

    it('runs an npx agent through npx, with its pinned package, arguments and environment', async () => {
      expect(await recordedAgent('auggie')).toEqual({
        id: 'auggie',
        name: 'Auggie CLI',
        version: '0.36.0',
        description: 'Augment Code\'s powerful software agent, backed by industry-leading context engine',
        runs: {
          through: 'npx',
          config: { command: 'npx', args: ['--yes', '@augmentcode/auggie@0.36.0', '--acp'], env: { AUGMENT_DISABLE_AUTO_UPDATE: '1' } },
        },
      });
    });

    it('runs a uvx agent through uvx, with its pinned package, arguments and environment', async () => {
      expect((await recordedAgent('fast-agent'))?.runs).toEqual({
        through: 'uvx',
        config: { command: 'uvx', args: ['fast-agent-acp==0.10.1', '-x'], env: { FAST_AGENT_MODEL: 'codexplan' } },
      });
    });

    it('runs nothing for an agent distributed only as a binary', async () => {
      const opencode = await recordedAgent('opencode');

      expect(opencode?.version).toBe('1.19.3');
      expect(opencode?.runs).toEqual({ through: 'binary' });
    });

    it('keeps the command each platform\'s binary runs, with its arguments and environment', async () => {
      expect((await recordedAgent('opencode'))?.binary?.['linux-x86_64']).toEqual({ cmd: './opencode', args: ['acp'] });
      expect((await recordedAgent('vtcode'))?.binary?.['linux-x86_64']).toEqual({
        cmd: './vtcode',
        args: ['acp'],
        env: { VT_ACP_ENABLED: '1', VT_ACP_ZED_ENABLED: '1' },
      });
      expect((await recordedAgent('auggie'))?.binary).toBeUndefined();
    });

    it('runs an agent distributed both as a binary and through npx through npx', async () => {
      expect((await recordedAgent('kilo'))?.runs).toEqual({
        through: 'npx',
        config: { command: 'npx', args: ['--yes', '@kilocode/cli@7.8.15', 'acp'] },
      });
    });
  });

  it.each([
    ['linux', 'x64', 'linux-x86_64'],
    ['linux', 'arm64', 'linux-aarch64'],
    ['darwin', 'arm64', 'darwin-aarch64'],
    ['darwin', 'x64', 'darwin-x86_64'],
    ['win32', 'x64', 'windows-x86_64'],
    ['win32', 'arm64', 'windows-aarch64'],
  ] as const)('names %s on %s as the registry does', (platform, arch, name) => {
    expect(registryPlatform(platform, arch)).toBe(name);
  });

  it('has no name for a platform the registry does not list', () => {
    expect(registryPlatform('freebsd', 'x64')).toBeUndefined();
    expect(registryPlatform('linux', 'ia32')).toBeUndefined();
  });

  it('skips an entry it cannot read, keeping the rest', async () => {
    respond(Response.json({
      agents: [
        { ...entry, id: 'nameless', name: undefined },
        { ...entry, id: 'no-distribution', distribution: {} },
        { ...entry, id: 'bad-args', distribution: { npx: { package: 'x', args: '--acp' } } },
        entry,
      ],
    }));

    expect(await fetchRegistry()).toEqual([agent]);
  });
});
