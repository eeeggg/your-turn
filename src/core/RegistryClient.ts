import { log, logError } from './Log';

export interface RegistryAgent {
  name: string;
  description?: string;
  command: string;
  args?: string[];
  homepage?: string;
}

interface Registry {
  agents: RegistryAgent[];
}

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
    log('Fetching ACP agent registry...');
    const response = await fetch(REGISTRY_URL);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = registryFrom(await response.json());
    cachedRegistry = data;
    cacheTime = now;
    log(`Registry fetched: ${data.agents.length} agents`);
    return data.agents;
  } catch (e) {
    if (!cachedRegistry) {
      throw e;
    }
    logError('Failed to fetch registry; using the last copy', e);
    return cachedRegistry.agents;
  }
}

function registryFrom(json: unknown): Registry {
  const agents = typeof json === 'object' && json !== null && 'agents' in json ? json.agents : undefined;
  return { agents: Array.isArray(agents) ? agents as RegistryAgent[] : [] };
}

/**
 * Clear the registry cache.
 */
export function clearRegistryCache(): void {
  cachedRegistry = null;
  cacheTime = 0;
}
