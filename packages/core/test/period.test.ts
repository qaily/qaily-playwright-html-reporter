import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, healthLevel, setPath, type RunRow } from '@qaily/contracts';
import { buildPeriodDays, groupProblems, loadTopTests, periodKpis, periodPoints, type ProblemRow } from '../src/period.ts';

const settings = setPath(DEFAULT_SETTINGS, 'display.timeZone', 'UTC');
const ctx = {
  settings,
  now: () => new Date('2026-10-14T12:00:00Z'),
  health: (metric: keyof typeof settings.thresholds, v: number | null | undefined) => healthLevel(settings.thresholds[metric], v),
};

const run = (id: string, started: string, counts: Partial<RunRow> = {}): RunRow => ({
  run_id: id, started_at: started, ended_at: started, dur_ms: 1, total: 10, passed: 10, failed: 0, flaky: 0, skipped: 0,
  category: 'ui:web', environment: 'dev', branch: 'main', tag: '@regression', commit: null, ci_url: null, pw_version: null, ...counts,
});

describe('buildPeriodDays', () => {
  const runs = [
    run('b', '2026-10-13T09:30:00Z', { passed: 8, failed: 2 }),
    run('a', '2026-10-13T06:00:00Z'),
    run('c', '2026-10-14T23:45:00Z', { passed: 9, flaky: 1 }),
    { ...run('d', '2026-10-14T11:00:00Z'), ended_at: null },
  ];
  const days = buildPeriodDays(runs, new Date('2026-10-12T00:00:00Z'), 4, ctx);

  it('buckets runs by day in the display time zone, oldest first, with the hour of day', () => {
    expect(days.map((d) => [d.key, d.runs.map((r) => r.run.run_id)])).toEqual([
      ['2026-10-12', []],
      ['2026-10-13', ['a', 'b']],
      ['2026-10-14', ['d', 'c']],
      ['2026-10-15', []],
    ]);
    expect(days[1].runs[1].hour).toBe(9.5);
    expect(days[1].runs[0].laneLabel).toBe('Web · Dev');
    expect(days.map((d) => [d.isToday, d.isFuture])).toEqual([[false, false], [false, false], [true, false], [false, true]]);
  });

  it('totals only finished runs and marks a running one', () => {
    expect(days[1]).toMatchObject({ failed: 2, flaky: 0, executed: 20, rate: 90 });
    expect(days[2]).toMatchObject({ failed: 0, flaky: 1, executed: 10 });
    expect(days[2].runs[0]).toMatchObject({ running: true, level: 'none' });
    expect(days[0]).toMatchObject({ rate: null, level: 'none' });
  });

  it('summarises the period with the worst day', () => {
    const k = periodKpis(days, ctx);
    expect(k).toMatchObject({ runs: 4, executed: 30, failed: 2, flaky: 1 });
    expect(k.worstDay?.key).toBe('2026-10-13');
  });
});

describe('groupProblems', () => {
  const row = (test_id: string, status: 'failed' | 'flaky', iso: string, run_id: string, suite: string | null = '@regression'): ProblemRow => ({
    test_id, title: test_id, file: 'f.spec.ts', project: 'chromium', status, run_id, started_ms: Date.parse(iso), suite,
  });

  it('groups per day and test, ranks failures 3× over flaky, keeps the latest run and the suites', () => {
    const out = groupProblems(
      [
        row('t1', 'flaky', '2026-10-13T08:00:00Z', 'r1'),
        row('t1', 'flaky', '2026-10-13T10:00:00Z', 'r2', '@smoke'),
        row('t2', 'failed', '2026-10-13T09:00:00Z', 'r1'),
        row('t1', 'failed', '2026-10-14T09:00:00Z', 'r3'),
      ],
      ctx,
      7,
    );
    expect(out['2026-10-13'].map((p) => [p.test_id, p.failed, p.flaky, p.last_run_id, p.suites])).toEqual([
      ['t2', 1, 0, 'r1', ['@regression']],
      ['t1', 0, 2, 'r2', ['@regression', '@smoke']],
    ]);
    expect(out['2026-10-14']).toHaveLength(1);
  });

  it('keeps only the top N per day', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`t${i}`, 'failed', '2026-10-13T08:00:00Z', 'r'));
    expect(groupProblems(rows, ctx, 7)['2026-10-13']).toHaveLength(7);
  });
});

describe('periodPoints', () => {
  it('places each execution within its month as 0–1, leaving out others', () => {
    const from = new Date('2026-10-01T00:00:00Z');
    const to = new Date('2026-11-01T00:00:00Z');
    const pts = periodPoints(
      [run('a', '2026-10-01T00:00:00Z'), run('b', '2026-10-16T12:00:00Z'), run('c', '2026-11-01T00:00:00Z'), run('d', '2026-09-30T23:59:00Z')],
      from,
      to,
      ctx,
    );
    expect(pts.map((p) => [p.run.run.run_id, Number(p.x.toFixed(3))])).toEqual([['a', 0], ['b', 0.5]]);
  });
});

describe('loadTopTests', () => {
  it('counts the executions a test ran in, and ranks each list', async () => {
    let sql = '';
    const stat = (test_id: string, failed: number, flaky: number, avg_ms: number) =>
      ({ test_id, title: test_id, file: 'f', runs: 23, execs: 23, failed, flaky, avg_ms, last_run_id: 'r', suites: [] });
    const data = { query: async (q: string) => ((sql = q), [stat('a', 1, 5, 10), stat('b', 7, 0, 30), stat('c', 0, 0, 20)]) };
    const top = await loadTopTests({ settings, filters: { branch: 'all' }, data } as never, new Date(0), new Date(1));
    expect(sql).toContain("count(DISTINCT run_id) FILTER (WHERE status <> 'skipped') AS execs");
    expect(top.topFailing.map((s) => s.test_id)).toEqual(['b', 'a']);
    expect(top.topFlaky.map((s) => s.test_id)).toEqual(['a']);
    expect(top.slowest.map((s) => s.test_id)).toEqual(['b', 'c', 'a']);
  });
});
