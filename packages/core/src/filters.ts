import { NO_ENVIRONMENT, laneOf, type DateRange, type Filters, type RouteParams, type RunRow, type Settings } from '@qaily/contracts';

/** Route params owned by the shell's filter bar. Pages must not reuse these names. */
export const FILTER_PARAMS = ['range', 'branch', 'lanes', 'env'] as const;

const list = (raw: string | undefined) => (raw ? [...new Set(raw.split(',').filter(Boolean))] : []);

export function filtersFromParams(params: RouteParams, settings: Settings): Filters {
  const days = Number(params.range);
  return {
    rangeDays: Number.isInteger(days) && days > 0 && days <= 366 ? days : settings.display.defaultRangeDays,
    branch: params.branch === 'all' ? 'all' : 'main',
    lanes: list(params.lanes),
    environments: list(params.env),
  };
}

export function filtersToParams(f: Filters, settings: Settings): RouteParams {
  const p: RouteParams = {};
  if (f.rangeDays !== settings.display.defaultRangeDays) p.range = String(f.rangeDays);
  if (f.branch !== 'main') p.branch = f.branch;
  if (f.lanes.length) p.lanes = f.lanes.join(',');
  if (f.environments?.length) p.env = f.environments.join(',');
  return p;
}

/** The last `days` days up to now (exclusive end a millisecond after now). */
export function rangeFromDays(days: number, now: Date): DateRange {
  const to = new Date(now.getTime() + 1);
  const from = new Date(now.getTime() - days * 86_400_000);
  return { from, to };
}

export function branchMatches(branch: string | null, filters: Filters, settings: Settings): boolean {
  return filters.branch === 'all' || (branch != null && settings.data.mainBranches.includes(branch));
}

/**
 * The filters a page gets: lane and environment filters only when the page declares them. They stay in the URL
 * while you visit a page without them, but don't quietly filter a page that shows no control for them.
 */
export function pageFilters(filters: Filters, declared: readonly (keyof Filters)[] | undefined): Filters {
  const has = new Set(declared ?? []);
  return {
    ...filters,
    lanes: has.has('lanes') ? filters.lanes : [],
    environments: has.has('environments') ? filters.environments : [],
  };
}

/** Whether a lane or environment filter is set (these can't be expressed as a plain SQL condition). */
export function hasRunFilters(filters: Filters): boolean {
  return (filters.lanes?.length ?? 0) > 0 || (filters.environments?.length ?? 0) > 0;
}

export function environmentMatches(environment: string | null, filters: Filters): boolean {
  const envs = filters.environments ?? [];
  return envs.length === 0 || envs.includes(environment || NO_ENVIRONMENT);
}

/** The filter bar's branch, lane and environment filters, applied to one run. Every page uses this one check. */
export function runPassesFilters(run: RunRow, filters: Filters, settings: Settings): boolean {
  if (!branchMatches(run.branch, filters, settings)) return false;
  if (!environmentMatches(run.environment, filters)) return false;
  const lanes = filters.lanes ?? [];
  if (lanes.length && !lanes.includes(laneOf(settings.lanes, run)?.id ?? '')) return false;
  return true;
}

const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** A SQL condition limiting rows to these runs (`false` when there are none). */
export function runIdsSql(runIds: readonly string[], column = 'run_id'): string {
  return runIds.length ? `${column} IN (${runIds.map(quote).join(', ')})` : 'false';
}
