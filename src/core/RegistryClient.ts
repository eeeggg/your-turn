import * as z from 'zod';
import type { AgentConfigEntry } from './AgentManager';
import { logDebug, logInfo, logWarning } from './Log';

/** An agent in the ACP registry, with what Add Agent needs to configure it. */
export interface RegistryAgent {
  id: string;
  name: string;
  version: string;
  description: string;
  /** How Add Agent would run it: through `npx` or `uvx`, or, for an agent distributed only as a binary, not at all. */
  runs: { through: 'npx' | 'uvx'; config: AgentConfigEntry } | { through: 'binary' };
  /** What its binary runs from inside the archive, as `./opencode`, by platform as {@link registryPlatform} names them. */
  binary?: Readonly<Record<string, BinaryCommand>>;
}

type BinaryCommand = z.infer<typeof binaryCommand>;

/** This machine as the registry names platforms (`linux-x86_64`), or undefined for one it does not list. */
export function registryPlatform(platform: string = process.platform, arch: string = process.arch): string | undefined {
  const os = ({ linux: 'linux', darwin: 'darwin', win32: 'windows' } as Record<string, string | undefined>)[platform];
  const cpu = ({ x64: 'x86_64', arm64: 'aarch64' } as Record<string, string | undefined>)[arch];
  return os && cpu && `${os}-${cpu}`;
}

interface Registry {
  agents: RegistryAgent[];
}

/** A package distribution, as the registry's `FORMAT.md` defines `npx` and `uvx`; the package names its version. */
const packageDistribution = z.object({
  package: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const binaryCommand = z.object({
  cmd: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const registryEntry = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  distribution: z.object({
    binary: z.record(z.string(), binaryCommand).optional(),
    npx: packageDistribution.optional(),
    uvx: packageDistribution.optional(),
  }),
});

const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';

let cachedRegistry: Registry | null = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetches the ACP agent registry from the CDN.
 * Results are cached for 5 minutes. When the fetch fails, returns the last
 * copy fetched, if any.
 */
export async function fetchRegistry(): Promise<RegistryAgent[]> {
  const now = Date.now();
  if (cachedRegistry && (now - cacheTime) < CACHE_TTL) {
    return cachedRegistry.agents;
  }

  try {
    logDebug('Fetching ACP agent registry');
    const response = await fetch(REGISTRY_URL);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = registryFrom(await response.json());
    cachedRegistry = data;
    cacheTime = now;
    logInfo('Registry fetched', { agentCount: data.agents.length });
    return data.agents;
  } catch (e) {
    if (!cachedRegistry) {
      throw e;
    }
    logWarning('Failed to fetch registry; using the last copy', { error: e });
    return cachedRegistry.agents;
  }
}

/** The registry changes several times a day under other people's hands, so an entry this code cannot read is skipped. */
function registryFrom(json: unknown): Registry {
  const entries = typeof json === 'object' && json !== null && 'agents' in json && Array.isArray(json.agents) ? json.agents : [];
  return { agents: entries.flatMap((raw) => agentFrom(raw) ?? []) };
}

function agentFrom(raw: unknown): RegistryAgent | undefined {
  const parsed = registryEntry.safeParse(raw);
  if (!parsed.success) { return undefined; }
  const { id, name, version, description, distribution } = parsed.data;
  const runs = runsFrom(distribution);
  return runs && { id, name, version, description, runs, ...(distribution.binary ? { binary: distribution.binary } : {}) };
}

function runsFrom({ npx, uvx, binary }: z.infer<typeof registryEntry>['distribution']): RegistryAgent['runs'] | undefined {
  if (npx) { return { through: 'npx', config: packageConfig('npx', ['--yes'], npx) }; }
  if (uvx) { return { through: 'uvx', config: packageConfig('uvx', [], uvx) }; }
  if (binary) { return { through: 'binary' }; }
  return undefined;
}

/** The command the registry's own CI runs to check the agent (`verify_agents.py`). */
function packageConfig(command: string, flags: string[], { package: pkg, args = [], env }: z.infer<typeof packageDistribution>): AgentConfigEntry {
  return { command, args: [...flags, pkg, ...args], ...(env ? { env } : {}) };
}

/**
 * Clear the registry cache.
 */
export function clearRegistryCache(): void {
  cachedRegistry = null;
  cacheTime = 0;
}
