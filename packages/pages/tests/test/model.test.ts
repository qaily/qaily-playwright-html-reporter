import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, healthLevel, type Filters, type RunRow } from '@qaily/contracts';
import {
  MAX_EXECUTIONS,
  commonDirPrefix,
  groupsFromFullTitle,
  loadTests,
  rangeSql,
  type RangeExecution,
  type RangeRow,
} from '../src/model.ts';

describe('loadTests with lane and environment filters', () => {
  const run = (id: string, started_at: string, environment: string): RunRow => ({
    run_id: id,
    started_at,
    ended_at: started_at,
    dur_ms: 1,
    total: 0,
    passed: 0,
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
  });
  // Newest first, as data.runs returns them.
  const runs = [run('staging-2', '2026-11-02T10:00:00Z', 'staging'), run('dev-1', '2026-11-01T10:00:00Z', 'dev')];
  const ctx = (filters: Partial<Filters>) =>
    ({
      settings: DEFAULT_SETTINGS,
      filters: { rangeDays: 7, branch: 'main', lanes: [], environments: [], ...filters },
      now: () => new Date('2026-11-02T12:00:00Z'),
      health: (metric: keyof typeof DEFAULT_SETTINGS.thresholds, v: number | null | undefined) => healthLevel(DEFAULT_SETTINGS.thresholds[metric], v),
      data: {
        runs: async () => runs,
        run: async (id: string) => runs.find((r) => r.run_id === id) ?? null,
        runDetail: async () => ({ summaries: [], details: [], errors: [], attachments: [] }),
        query: async (sql: string) => {
          queries.push(sql);
          return rangeRows;
        },
      },
    }) as never;
  const queries: string[] = [];
  const exec = (run_id: string, status: string, started_ms: number) =>
    ({ run_id, status, started_ms, dur_ms: 1000, err_summary: status === 'failed' ? 'boom' : null, failed_step: null, attempts: 1 }) as RangeExecution;
  const rangeRows: RangeRow[] = [
    { test_id: 'a', title: 'Login', file: '/ci/e2e/auth/login.spec.ts', project: 'chromium', tags: ['smoke'], total: 2, failed: 1, flaky: 0, passed: 1, skipped: 0,
      executions: [exec('staging-2', 'failed', 2), exec('dev-1', 'passed', 1)] },
    { test_id: 'b', title: 'Logout', file: '/ci/e2e/auth/login.spec.ts', project: 'chromium', tags: null, total: 2, failed: 0, flaky: 1, passed: 1, skipped: 0,
      executions: [exec('staging-2', 'flaky', 2), exec('dev-1', 'passed', 1)] },
    { test_id: 'c', title: 'Search', file: '/ci/e2e/search.spec.ts', project: 'chromium', tags: null, total: 2, failed: 0, flaky: 0, passed: 2, skipped: 0,
      executions: [exec('staging-2', 'passed', 2), exec('dev-1', 'passed', 1)] },
  ];

  it('shows all runs in range by default, limited to the filters', async () => {
    queries.length = 0;
    const m = await loadTests(ctx({ environments: ['dev'] }), {});
    expect(m.scope).toBe('range');
    expect(m.current).toBeNull();
    expect(m.runs.map((o) => o.run.run_id)).toEqual(['dev-1']);
    expect(queries[0]).toContain("run_id IN ('dev-1')");
  });

  it('groups the range by spec and counts each test by its worst result', async () => {
    const range = (await loadTests(ctx({}), {})).range!;
    expect(range.counts).toEqual({ failed: 1, flaky: 1, passed: 1, skipped: 0 });
    expect(range.specs.map((s) => s.spec)).toEqual(['auth/login.spec.ts', 'search.spec.ts']);
    expect(range.specs[0].tests.map((t) => [t.title, t.worst])).toEqual([['Login', 'failed'], ['Logout', 'flaky']]);
    expect(range.specs[0].tests[0].executions[0]).toMatchObject({ run_id: 'staging-2', status: 'failed', err_summary: 'boom' });
  });

  it('has no runs and does not query when nothing matches', async () => {
    queries.length = 0;
    const m = await loadTests(ctx({ environments: ['prod'] }), {});
    expect(m.runs).toEqual([]);
    expect(m.range?.tests).toEqual([]);
    expect(queries).toEqual([]);
  });

  it('opens one run when asked, even outside the filters', async () => {
    const m = await loadTests(ctx({ environments: ['dev'] }), { run: 'staging-2' });
    expect(m.scope).toBe('run');
    expect(m.current?.run.run_id).toBe('staging-2');
  });
});

describe('rangeSql', () => {
  it('limits rows to the runs and the range, newest executions first', () => {
    const sql = rangeSql(["r'1", 'r2'], { from: new Date(1000), to: new Date(2000) });
    expect(sql).toContain("run_id IN ('r''1', 'r2')");
    expect(sql).toContain('epoch_ms(started_at) >= 1000 AND epoch_ms(started_at) < 2000');
    expect(sql).toContain(`ORDER BY started_at DESC)[1:${MAX_EXECUTIONS}]`);
  });
});

describe('commonDirPrefix', () => {
  it('finds the shared directory of spec paths', () => {
    expect(commonDirPrefix(['/runner/w/e2e/a/x.spec.js', '/runner/w/e2e/b/y.spec.js'])).toBe('/runner/w/e2e/');
    expect(commonDirPrefix(['/runner/w/e2e/a/x.spec.js'])).toBe('/runner/w/e2e/a/');
  });
  it('terminates on relative and unrelated paths', () => {
    expect(commonDirPrefix(['a/x.spec.ts', 'b/y.spec.ts'])).toBe('');
    expect(commonDirPrefix(['x.spec.ts', '/abs/y.spec.ts'])).toBe('');
    expect(commonDirPrefix([])).toBe('');
  });
});

describe('groupsFromFullTitle', () => {
  it('keeps the describe blocks between file and title', () => {
    const full = ' > chromium-web > e2e/features/a.feature.spec.js > Recurring tasks > Outline <x> > Create recurring task';
    expect(groupsFromFullTitle(full, 'Create recurring task')).toEqual(['Recurring tasks', 'Outline <x>']);
  });
  it('handles a missing title or full title', () => {
    expect(groupsFromFullTitle(undefined, 'T')).toEqual([]);
    expect(groupsFromFullTitle(' > p > f.spec.ts > T', 'T')).toEqual([]);
  });
});
