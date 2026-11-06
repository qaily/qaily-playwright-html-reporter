// Period view models shared by Weekly and Monthly: runs bucketed per day, KPIs, and test statistics from the
// tests rollup (top failing / flaky / slowest, and each day's problem tests).

import type { DayProblem, PageContext, PeriodDay, PeriodKpis, PeriodRun, RunRow, TestStat, TopTests } from '@qaily/contracts';
import { laneOf, passRate } from '@qaily/contracts';
import { addDays, dayKey, dayParts } from './format.ts';
import { sumCounts } from './runs.ts';

type Ctx = Pick<PageContext, 'settings' | 'health' | 'now'>;

/** Hour of day with fractions, in the display time zone. */
export function hourOf(iso: string, ctx: Pick<PageContext, 'settings'>): number {
  const d = new Date(iso);
  return ctx.settings.display.timeZone === 'UTC'
    ? d.getUTCHours() + d.getUTCMinutes() / 60
    : d.getHours() + d.getMinutes() / 60;
}

export function toPeriodRun(run: RunRow, ctx: Ctx): PeriodRun {
  const rate = passRate(run, ctx.settings.metrics);
  return {
    run,
    rate,
    level: run.ended_at ? ctx.health('passRate', rate) : 'none',
    running: !run.ended_at,
    hour: hourOf(run.started_at, ctx),
    laneLabel: laneOf(ctx.settings.lanes, run)?.label ?? null,
  };
}

/** Each run placed within [from, to) as a fraction 0–1 (for a chart column that spans a month). */
export function periodPoints(runs: readonly RunRow[], from: Date, to: Date, ctx: Ctx): { x: number; run: PeriodRun }[] {
  const span = to.getTime() - from.getTime();
  return runs
    .filter((r) => {
      const t = Date.parse(r.started_at);
      return t >= from.getTime() && t < to.getTime();
    })
    .map((r) => ({ x: (Date.parse(r.started_at) - from.getTime()) / span, run: toPeriodRun(r, ctx) }));
}

/** nDays calendar days from `from`, each with its runs (oldest first) and totals over finished runs. */
export function buildPeriodDays(runs: readonly RunRow[], from: Date, nDays: number, ctx: Ctx): PeriodDay[] {
  const { settings } = ctx;
  const now = ctx.now();
  const todayKey = dayKey(now, settings);
  const byDay = new Map<string, RunRow[]>();
  for (const r of runs) {
    const k = dayKey(r.started_at, settings);
    byDay.set(k, [...(byDay.get(k) ?? []), r]);
  }
  const days: PeriodDay[] = [];
  for (let i = 0; i < nDays; i++) {
    const start = addDays(from, i, settings);
    const key = dayKey(start, settings);
    const list = (byDay.get(key) ?? []).slice().sort((a, b) => a.started_at.localeCompare(b.started_at));
    const totals = sumCounts(list.filter((r) => r.ended_at));
    const rate = passRate(totals, settings.metrics);
    const weekday = dayParts(start, settings).weekday;
    days.push({
      key,
      start: start.toISOString(),
      isToday: key === todayKey,
      isFuture: start > now,
      isWeekend: weekday === 0 || weekday === 6,
      runs: list.map((r) => toPeriodRun(r, ctx)),
      rate,
      level: totals.total ? ctx.health('passRate', rate) : 'none',
      failed: totals.failed,
      flaky: totals.flaky,
      executed: totals.total - totals.skipped,
    });
  }
  return days;
}

export function periodKpis(days: readonly PeriodDay[], ctx: Ctx): PeriodKpis {
  const finished = days.flatMap((d) => d.runs.filter((r) => !r.running).map((r) => r.run));
  const totals = sumCounts(finished);
  const rate = passRate(totals, ctx.settings.metrics);
  const worst = days.reduce<PeriodDay | null>((w, d) => (d.rate != null && (!w || w.rate! > d.rate) ? d : w), null);
  return {
    passRate: rate,
    passLevel: ctx.health('passRate', rate),
    runs: days.reduce((n, d) => n + d.runs.length, 0),
    executed: totals.total - totals.skipped,
    failed: totals.failed,
    flaky: totals.flaky,
    worstDay: worst ? { key: worst.key, start: worst.start, rate: worst.rate! } : null,
  };
}

const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** The same branch restriction the runs get from the filter bar. */
function branchSql(ctx: Pick<PageContext, 'settings' | 'filters'>): string {
  return ctx.filters.branch === 'main' ? `AND branch IN (${ctx.settings.data.mainBranches.map(quote).join(', ')})` : '';
}

const range = (from: Date, to: Date) => `epoch_ms(started_at) >= ${from.getTime()} AND epoch_ms(started_at) < ${to.getTime()}`;

/** Most failing, most flaky and slowest tests in [from, to). */
export async function loadTopTests(ctx: Pick<PageContext, 'settings' | 'filters' | 'data'>, from: Date, to: Date, limit = 10): Promise<TopTests> {
  try {
    const stats = await ctx.data.query<TestStat>(
      `SELECT test_id, any_value(title) AS title, any_value(file) AS file,
         count(*) FILTER (WHERE status <> 'skipped') AS runs,
         count(DISTINCT run_id) FILTER (WHERE status <> 'skipped') AS execs,
         count(*) FILTER (WHERE status = 'failed') AS failed,
         count(*) FILTER (WHERE status = 'flaky') AS flaky,
         coalesce(avg(dur_ms) FILTER (WHERE status IN ('passed', 'flaky')), 0) AS avg_ms,
         arg_max(run_id, started_at) AS last_run_id,
         list_sort(list(DISTINCT suite) FILTER (WHERE suite IS NOT NULL)) AS suites
       FROM tests
       WHERE ${range(from, to)} ${branchSql(ctx)}
       GROUP BY test_id`,
      { from, to },
    );
    const top = (key: 'failed' | 'flaky' | 'avg_ms') =>
      stats.filter((s) => Number(s[key]) > 0).sort((a, b) => Number(b[key]) - Number(a[key])).slice(0, limit);
    return { topFailing: top('failed'), topFlaky: top('flaky'), slowest: top('avg_ms'), statsError: null };
  } catch (err) {
    return { topFailing: [], topFlaky: [], slowest: [], statsError: err instanceof Error ? err.message : String(err) };
  }
}

/** One failed or flaky execution, as read from the tests rollup. */
export interface ProblemRow {
  test_id: string;
  title: string;
  file: string;
  project: string;
  status: 'failed' | 'flaky';
  run_id: string;
  started_ms: number;
  suite: string | null;
}

/** Per day: the tests that failed or were flaky, worst first (failures weigh 3×, as in the Observatory design). */
export async function loadDayProblems(
  ctx: Pick<PageContext, 'settings' | 'filters' | 'data'>,
  from: Date,
  to: Date,
  limit = 7,
): Promise<Record<string, DayProblem[]>> {
  // Bucketed here rather than in SQL, because days follow the display time zone.
  const rows = await ctx.data
    .query<ProblemRow>(
      `SELECT test_id, title, file, project, status, run_id, epoch_ms(started_at) AS started_ms, suite
       FROM tests
       WHERE status IN ('failed', 'flaky') AND ${range(from, to)} ${branchSql(ctx)}`,
      { from, to },
    )
    .catch(() => []);
  return groupProblems(rows, ctx, limit);
}

export function groupProblems(rows: readonly ProblemRow[], ctx: Pick<PageContext, 'settings'>, limit: number): Record<string, DayProblem[]> {
  const out: Record<string, (DayProblem & { lastMs: number })[]> = {};
  for (const r of rows) {
    const ms = Number(r.started_ms);
    const list = (out[dayKey(new Date(ms), ctx.settings)] ??= []);
    let p = list.find((x) => x.test_id === r.test_id);
    if (!p) {
      p = { test_id: r.test_id, title: r.title, file: r.file, project: r.project, failed: 0, flaky: 0, last_run_id: r.run_id, suites: [], lastMs: ms };
      list.push(p);
    }
    if (r.status === 'failed') p.failed++;
    else p.flaky++;
    if (ms >= p.lastMs) {
      p.lastMs = ms;
      p.last_run_id = r.run_id;
    }
    if (r.suite && !p.suites.includes(r.suite)) p.suites = [...p.suites, r.suite].sort();
  }
  const result: Record<string, DayProblem[]> = {};
  for (const [k, list] of Object.entries(out)) {
    result[k] = list
      .sort((a, b) => b.failed * 3 + b.flaky - (a.failed * 3 + a.flaky))
      .slice(0, limit)
      .map(({ lastMs: _, ...p }) => p);
  }
  return result;
}
