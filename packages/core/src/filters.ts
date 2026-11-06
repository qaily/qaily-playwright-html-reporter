import type { DateRange, Filters, RouteParams, Settings } from '@qaily/contracts';

/** Route params owned by the shell's filter bar. Pages must not reuse these names. */
export const FILTER_PARAMS = ['range', 'branch', 'lanes'] as const;

export function filtersFromParams(params: RouteParams, settings: Settings): Filters {
  const days = Number(params.range);
  return {
    rangeDays: Number.isInteger(days) && days > 0 && days <= 366 ? days : settings.display.defaultRangeDays,
    branch: params.branch === 'all' ? 'all' : 'main',
    lanes: params.lanes ? params.lanes.split(',').filter(Boolean) : [],
  };
}

export function filtersToParams(f: Filters, settings: Settings): RouteParams {
  const p: RouteParams = {};
  if (f.rangeDays !== settings.display.defaultRangeDays) p.range = String(f.rangeDays);
  if (f.branch !== 'main') p.branch = f.branch;
  if (f.lanes.length) p.lanes = f.lanes.join(',');
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
