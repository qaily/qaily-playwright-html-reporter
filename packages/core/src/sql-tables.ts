export const ROLLUP_TABLES = ['tests', 'issues', 'steps'] as const;
export type RollupTable = (typeof ROLLUP_TABLES)[number];

/** Rollup tables a query names. A match inside a string only loads an extra file, which is harmless. */
export function tablesInQuery(sql: string): Set<RollupTable> {
  return new Set(ROLLUP_TABLES.filter((t) => new RegExp(`\\b${t}\\b`, 'i').test(sql)));
}
