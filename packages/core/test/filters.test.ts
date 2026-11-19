import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, NO_ENVIRONMENT, RANGE_TODAY, rangeLabel, type Filters, type Lane, type RunRow, type Settings } from '@qaily/contracts';
import { filtersFromParams, filtersToParams, pageFilters, rangeFromDays, runIdsSql, runPassesFilters } from '../src/filters.ts';
import { loadDayProblems, loadTopTests } from '../src/period.ts';

const lanes: Lane[] = [
  { id: 'nightly', label: 'Nightly', match: { category: '^ui:web$', time: { from: '22:00', to: '06:00', zone: 'UTC' } } },
  { id: 'web', label: 'Web', match: { category: '^ui:web$' } },
  { id: 'other', label: 'Other', match: {} },
];
const settings: Settings = { ...DEFAULT_SETTINGS, lanes };

const run = (id: string, started_at: string, environment: string | null, extra: Partial<RunRow> = {}): RunRow => ({
  run_id: id,
  started_at,
  ended_at: started_at,
  dur_ms: 1,
  total: 1,
  passed: 1,
  failed: 0,
  flaky: 0,
  skipped: 0,
  category: 'ui:web',
  environment,
  branch: 'main',
  tag: null,
  commit: null,
  ci_url: null,
  pw_version: null,
  ...extra,
});

const runs = [
  run('night-dev', '2026-11-01T23:00:00Z', 'dev'),
  run('day-dev', '2026-11-01T10:00:00Z', 'dev'),
  run('day-staging', '2026-11-01T11:00:00Z', 'staging'),
  run('day-none', '2026-11-01T12:00:00Z', null),
  run('api-feature', '2026-11-01T13:00:00Z', 'dev', { category: 'api', branch: 'feat-x' }),
];
const base: Filters = { rangeDays: 7, branch: 'all', lanes: [], environments: [] };
const kept = (f: Partial<Filters>) => runs.filter((r) => runPassesFilters(r, { ...base, ...f }, settings)).map((r) => r.run_id);

describe('filter URL params', () => {
  it('reads and writes lanes and environments', () => {
    const f = filtersFromParams({ lanes: 'web,nightly,web', env: 'dev,(none)' }, settings);
    expect(f.lanes).toEqual(['web', 'nightly']);
    expect(f.environments).toEqual(['dev', NO_ENVIRONMENT]);
    expect(filtersToParams(f, settings)).toMatchObject({ lanes: 'web,nightly', env: 'dev,(none)' });
    expect(filtersToParams({ ...f, lanes: [], environments: [] }, settings)).not.toHaveProperty('env');
  });
});

describe('runPassesFilters', () => {
  it('keeps everything without filters', () => {
    expect(kept({})).toHaveLength(runs.length);
  });
  it('filters by environment, with "(none)" for runs that set none', () => {
    expect(kept({ environments: ['dev'] })).toEqual(['night-dev', 'day-dev', 'api-feature']);
    expect(kept({ environments: ['staging', NO_ENVIRONMENT] })).toEqual(['day-staging', 'day-none']);
  });
  it('filters by lane, first match wins (time windows included)', () => {
    expect(kept({ lanes: ['nightly'] })).toEqual(['night-dev']);
    expect(kept({ lanes: ['web'] })).toEqual(['day-dev', 'day-staging', 'day-none']);
    expect(kept({ lanes: ['other'] })).toEqual(['api-feature']);
  });
  it('combines lane, environment and branch', () => {
    expect(kept({ lanes: ['web'], environments: ['dev'] })).toEqual(['day-dev']);
    expect(kept({ branch: 'main', environments: ['dev'] })).toEqual(['night-dev', 'day-dev']);
  });
});

describe('pageFilters', () => {
  it('drops lane and environment filters a page does not declare', () => {
    const f = { ...base, lanes: ['web'], environments: ['dev'] };
    expect(pageFilters(f, { filters: ['rangeDays', 'branch'] })).toEqual({ ...f, lanes: [], environments: [] });
    expect(pageFilters(f, { filters: ['branch', 'lanes', 'environments'] })).toEqual(f);
  });
  it("uses the page's own default range only while none is picked", () => {
    const today = { ...base, rangeDays: RANGE_TODAY };
    const monitoring = { filters: ['rangeDays', 'branch'] as (keyof Filters)[], defaultRangeDays: 14 };
    expect(pageFilters(today, monitoring, false).rangeDays).toBe(14);
    expect(pageFilters(today, monitoring, true).rangeDays).toBe(RANGE_TODAY);
    expect(pageFilters(today, { filters: ['rangeDays'] }, false).rangeDays).toBe(RANGE_TODAY);
  });
});

describe('Today range', () => {
  const utc: Settings = { ...settings, display: { ...settings.display, timeZone: 'UTC' } };
  it('is the default and round-trips as range=today', () => {
    expect(filtersFromParams({}, DEFAULT_SETTINGS).rangeDays).toBe(RANGE_TODAY);
    const week = { ...DEFAULT_SETTINGS, display: { ...DEFAULT_SETTINGS.display, defaultRangeDays: 7 } };
    expect(filtersFromParams({ range: 'today' }, week).rangeDays).toBe(RANGE_TODAY);
    expect(filtersToParams({ ...base, rangeDays: RANGE_TODAY }, week)).toMatchObject({ range: 'today' });
    expect(filtersFromParams({ range: 'nonsense' }, week).rangeDays).toBe(7);
  });
  it('starts at midnight in the display time zone', () => {
    const r = rangeFromDays(RANGE_TODAY, new Date('2026-11-18T09:30:00Z'), utc);
    expect(r.from.toISOString()).toBe('2026-11-18T00:00:00.000Z');
    expect(r.to.getTime()).toBe(Date.parse('2026-11-18T09:30:00Z') + 1);
  });
  it('is labelled for the Range dropdown', () => {
    expect([RANGE_TODAY, 1, 7].map(rangeLabel)).toEqual(['Today', 'Last 24 hours', 'Last 7 days']);
  });
});

describe('runIdsSql', () => {
  it('quotes ids and is false for none', () => {
    expect(runIdsSql(["a'b", 'c'])).toBe("run_id IN ('a''b', 'c')");
    expect(runIdsSql([])).toBe('false');
  });
});

describe('period queries with lane and environment filters', () => {
  const fakeCtx = (filters: Partial<Filters>) => {
    const sql: string[] = [];
    const ctx = {
      settings,
      filters: { ...base, ...filters },
      data: {
        runs: async () => runs,
        query: async (q: string) => {
          sql.push(q);
          return [];
        },
      },
    } as never;
    return { ctx, sql };
  };
  const from = new Date('2026-11-01T00:00:00Z');
  const to = new Date('2026-11-02T00:00:00Z');

  it('limits test rows to the runs that pass the filters', async () => {
    const { ctx, sql } = fakeCtx({ environments: ['staging'] });
    await loadTopTests(ctx, from, to);
    await loadDayProblems(ctx, from, to);
    expect(sql).toHaveLength(2);
    for (const q of sql) expect(q).toContain("run_id IN ('day-staging')");
  });

  it('keeps the plain branch condition without them', async () => {
    const { ctx, sql } = fakeCtx({ branch: 'main' });
    await loadTopTests(ctx, from, to);
    expect(sql[0]).toContain("branch IN ('main')");
    expect(sql[0]).not.toContain('run_id IN');
  });
});
