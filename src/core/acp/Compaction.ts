import type { CompactionContent } from './AcpDriver';

/** Copies schema-validated ACP content into the version-neutral JSON contract. */
export function compactionContent(value: unknown): CompactionContent {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(compactionContent);
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, child]) => child === undefined ? [] : [[key, compactionContent(child)]]),
    );
  }
  throw new TypeError('ACP compaction content must contain only JSON values');
}
