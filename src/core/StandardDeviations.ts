import { logWarning } from '@/core/Log';

/**
 * What the extension accepts from agents against the ACP standard, each under a code of our own, and what it does
 * instead. A repair is made where the agent's message first reaches our code, so nothing past it sees the deviation,
 * and logs its code every time, so this catalog and the log record every departure from the standard.
 *
 * Deviations apply to every agent, by decision, not to any agent by name; one may be narrowed to the agents that need
 * it later.
 */
const deviations = {
  'ACP-DEV-001':
    "a v2 git_patch names files with Git's a/ and b/ prefixes, which ACP forbids, as its paths must be absolute; the prefixes are removed, leaving the absolute paths",
} as const;

export type DeviationCode = keyof typeof deviations;

/** At warn level, every time a repair is made. */
export function logDeviation(code: DeviationCode, where: string): void {
  logWarning(`${code}, deviating from the ACP standard in ${where}: ${deviations[code]}`);
}
