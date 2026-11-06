import type { HealthLevel, PageContext, PeriodDay, PeriodKpis, PeriodRun, RouteParams, RunRow, TestStat } from '@qaily/contracts';
import {
  addDays,
  branchMatches,
  buildPeriodDays,
  dayKey,
  dayParts,
  groupByLane,
  isCatchAllLane,
  loadTopTests,
  passRate,
  periodKpis,
  periodPoints,
  startOfDay,
  startOfWeek,
  sumCounts,
} from '@qaily/core';

export interface DayCell {
  key: string;
  date: string; // ISO start of day
  inMonth: boolean;
  isFuture: boolean;
  runs: number;
  rate: number | null;
  level: HealthLevel | 'none';
  /** Weekly page offset for the week containing this day. */
  weekOffset: number;
}

export type { TestStat } from '@qaily/contracts';

/** One month on the Observatory carousel. */
export interface MonthCard {
  month: string; // YYYY-MM
  start: string;
  isCurrent: boolean;
  runs: number;
  rate: number | null;
  level: HealthLevel | 'none';
  failed: number;
  flaky: number;
  /** Pass rate per day of the month (null = no runs), for the card's bars. */
  dayRates: (number | null)[];
  /** Every execution of the month, placed by start time (x = 0–1 through the month), for the months chart. */
  points: { x: number; run: PeriodRun }[];
}

export interface MonthlyModel {
  month: string; // YYYY-MM
  isCurrent: boolean;
  start: string;
  end: string;
  kpis: {
    runs: number;
    executed: number;
    passRate: number | null;
    passLevel: HealthLevel | 'none';
    flakyRate: number | null;
    flakyLevel: HealthLevel | 'none';
    failed: number;
    worstDay: DayCell | null;
  };
  weeks: DayCell[][];
  dayLabels: string[]; // x labels for the trend (days of the month so far)
  trend: { laneId: string; label: string; values: (number | null)[] }[];
  overall: (number | null)[];
  topFailing: TestStat[];
  topFlaky: TestStat[];
  slowest: TestStat[];
  /** Set when the tests rollup could not be queried; the run-based parts still work. */
  statsError: string | null;
  /** Every day of the month with its runs, for the timeline views. */
  period: PeriodDay[];
  summary: PeriodKpis;
  /** Twelve months for the carousel, oldest first; always includes this month. */
  months: MonthCard[];
}

export function parseMonth(params: RouteParams, now: Date, ctx: PageContext): { y: number; m: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(params.month ?? '');
  if (match) return { y: Number(match[1]), m: Number(match[2]) - 1 };
  const p = dayParts(now, ctx.settings);
  return { y: p.y, m: p.m };
}

export async function loadMonthly(ctx: PageContext, params: RouteParams): Promise<MonthlyModel> {
  const { settings, filters, data } = ctx;
  const now = ctx.now();
  const { y, m } = parseMonth(params, now, ctx);
  const utc = settings.display.timeZone === 'UTC';
  const start = utc ? new Date(Date.UTC(y, m, 1)) : new Date(y, m, 1);
  const end = utc ? new Date(Date.UTC(y, m + 1, 1)) : new Date(y, m + 1, 1);
  const monthKey = `${y}-${String(m + 1).padStart(2, '0')}`;

  // One runs read covers this month and the carousel's months (the runs rollup is small).
  const current = parseMonth({}, now, ctx);
  // Twelve months ending at the current month, or starting at the selected one when that is older.
  const sel = y * 12 + m;
  const lastKey = Math.min(Math.max(sel, current.y * 12 + current.m), sel + 11);
  const firstKey = lastKey - 11;
  const monthStart = (k: number) => (utc ? new Date(Date.UTC(Math.floor(k / 12), k % 12, 1)) : new Date(Math.floor(k / 12), k % 12, 1));
  const [allRuns, top] = await Promise.all([
    data.runs({ from: monthStart(firstKey), to: monthStart(lastKey + 1) }),
    loadTopTests(ctx, start, end),
  ]);
  const visible = allRuns.filter((r) => branchMatches(r.branch, filters, settings));
  const runs = visible.filter((r) => new Date(r.started_at) >= start && new Date(r.started_at) < end);
  const finished = runs.filter((r) => r.ended_at);

  // Runs per day.
  const byDay = new Map<string, RunRow[]>();
  for (const r of finished) {
    const k = dayKey(r.started_at, settings);
    byDay.set(k, [...(byDay.get(k) ?? []), r]);
  }
  const thisWeek = startOfWeek(now, settings);
  const cell = (d: Date): DayCell => {
    const key = dayKey(d, settings);
    const list = byDay.get(key) ?? [];
    const rate = passRate(sumCounts(list), settings.metrics);
    const weekStart = startOfWeek(d, settings);
    return {
      key,
      date: d.toISOString(),
      inMonth: d >= start && d < end,
      isFuture: d > now,
      runs: list.length,
      rate,
      level: list.length ? ctx.health('passRate', rate) : 'none',
      weekOffset: Math.round((weekStart.getTime() - thisWeek.getTime()) / (7 * 86_400_000)),
    };
  };

  const weeks: DayCell[][] = [];
  for (let d = startOfWeek(start, settings); d < end; ) {
    const week: DayCell[] = [];
    for (let i = 0; i < 7; i++, d = addDays(d, 1, settings)) week.push(cell(d));
    weeks.push(week);
  }

  // Trend: one value per day up to today.
  const lastDay = now < end ? startOfDay(now, settings) : addDays(end, -1, settings);
  const days: Date[] = [];
  for (let d = start; d <= lastDay; d = addDays(d, 1, settings)) days.push(d);
  const groups = groupByLane(finished, settings);
  const trend = settings.lanes
    .filter((l) => (groups.get(l.id)?.length ?? 0) > 0 || !isCatchAllLane(l))
    .filter((l) => !filters.lanes.length || filters.lanes.includes(l.id))
    .map((l) => {
      const laneRuns = groups.get(l.id) ?? [];
      return {
        laneId: l.id,
        label: l.label,
        values: days.map((d) => {
          const k = dayKey(d, settings);
          const list = laneRuns.filter((r) => dayKey(r.started_at, settings) === k);
          return list.length ? passRate(sumCounts(list), settings.metrics) : null;
        }),
      };
    })
    .filter((s) => s.values.some((v) => v != null));
  const overall = days.map((d) => {
    const list = byDay.get(dayKey(d, settings)) ?? [];
    return list.length ? passRate(sumCounts(list), settings.metrics) : null;
  });

  const totals = sumCounts(finished);
  const executed = totals.total - totals.skipped;
  const rate = passRate(totals, settings.metrics);
  const flakyRate = executed > 0 ? (totals.flaky / executed) * 100 : null;
  const inMonth = weeks.flat().filter((c) => c.inMonth && c.runs > 0);
  const worstDay = inMonth.reduce<DayCell | null>((w, c) => (c.rate != null && (!w || (w.rate ?? 101) > c.rate) ? c : w), null);

  const months: MonthCard[] = [];
  for (let k = firstKey; k <= lastKey; k++) {
    const from = monthStart(k);
    const to = monthStart(k + 1);
    const list = visible.filter((r) => r.ended_at && new Date(r.started_at) >= from && new Date(r.started_at) < to);
    const sum = sumCounts(list);
    const r = passRate(sum, settings.metrics);
    const nDays = Math.round((to.getTime() - from.getTime()) / 86_400_000);
    const perDay = new Map<number, RunRow[]>();
    for (const run of list) {
      const d = dayParts(new Date(run.started_at), settings).d;
      perDay.set(d, [...(perDay.get(d) ?? []), run]);
    }
    months.push({
      month: `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, '0')}`,
      start: from.toISOString(),
      isCurrent: now >= from && now < to,
      runs: list.length,
      rate: r,
      level: list.length ? ctx.health('passRate', r) : 'none',
      failed: sum.failed,
      flaky: sum.flaky,
      dayRates: Array.from({ length: nDays }, (_, i) => {
        const day = perDay.get(i + 1);
        return day ? passRate(sumCounts(day), settings.metrics) : null;
      }),
      points: periodPoints(list, from, to, ctx),
    });
  }

  const nDays = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  const period = buildPeriodDays(runs, start, nDays, ctx);

  return {
    month: monthKey,
    isCurrent: now >= start && now < end,
    start: start.toISOString(),
    end: end.toISOString(),
    kpis: {
      runs: runs.length,
      executed,
      passRate: rate,
      passLevel: ctx.health('passRate', rate),
      flakyRate,
      flakyLevel: ctx.health('flakyRate', flakyRate),
      failed: totals.failed,
      worstDay,
    },
    weeks,
    dayLabels: days.map((d) => String(dayParts(d, settings).d)),
    trend,
    overall,
    topFailing: top.topFailing,
    topFlaky: top.topFlaky,
    slowest: top.slowest,
    statsError: top.statsError,
    period,
    summary: periodKpis(period, ctx),
    months,
  };
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}
