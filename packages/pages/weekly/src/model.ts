import type { DayProblem, HealthLevel, PageContext, PeriodDay, PeriodKpis, RouteParams, RunRow, TopTests } from '@qaily/contracts';
import {
  addDays,
  branchMatches,
  buildPeriodDays,
  dayKey,
  groupByLane,
  isCatchAllLane,
  loadDayProblems,
  loadTopTests,
  passRate,
  periodKpis,
  startOfWeek,
  sumCounts,
} from '@qaily/core';

export interface WeekRun {
  run: RunRow;
  rate: number | null;
  level: HealthLevel | 'none';
  running: boolean;
}

export interface WeekDay {
  key: string; // YYYY-MM-DD
  start: string; // ISO
  isToday: boolean;
  isFuture: boolean;
  byLane: Record<string, WeekRun[]>; // oldest first, like a timeline
  rate: number | null;
  level: HealthLevel | 'none';
  runCount: number;
}

export interface WeeklyModel {
  week: number; // 0 = this week, -1 = last week, …
  from: string;
  to: string;
  lanes: { id: string; label: string; rate: number | null; level: HealthLevel | 'none' }[];
  days: WeekDay[];
  totalRuns: number;
  /** Runs with AI results (published or draft). */
  aiRuns: Set<string>;
  /** The same week as days with all lanes' runs, for the timeline views. */
  period: PeriodDay[];
  summary: PeriodKpis;
  top: TopTests;
  /** Day key → that day's failed and flaky tests. */
  problems: Record<string, DayProblem[]>;
}

export function weekOffset(params: RouteParams): number {
  const n = Number(params.week);
  return Number.isInteger(n) && n <= 0 && n > -520 ? n : 0;
}

export async function loadWeekly(ctx: PageContext, params: RouteParams): Promise<WeeklyModel> {
  const { settings, filters } = ctx;
  const week = weekOffset(params);
  const now = ctx.now();
  const from = addDays(startOfWeek(now, settings), week * 7, settings);
  const to = addDays(from, 7, settings);

  const [allRuns, aiRuns, top, problems] = await Promise.all([
    ctx.data.runs({ from, to }),
    ctx.ai.runsWithResults().catch(() => new Set<string>()),
    loadTopTests(ctx, from, to),
    loadDayProblems(ctx, from, to),
  ]);
  const runs = allRuns.filter((r) => branchMatches(r.branch, filters, settings));
  const toWeekRun = (run: RunRow): WeekRun => {
    const rate = passRate(run, settings.metrics);
    return { run, rate, level: run.ended_at ? ctx.health('passRate', rate) : 'none', running: !run.ended_at };
  };

  const groups = groupByLane(runs, settings);
  const lanes = settings.lanes
    .filter((l) => !filters.lanes.length || filters.lanes.includes(l.id))
    .filter((l) => (groups.get(l.id)?.length ?? 0) > 0 || !isCatchAllLane(l))
    .map((l) => {
      const rate = passRate(sumCounts((groups.get(l.id) ?? []).filter((r) => r.ended_at)), settings.metrics);
      return { id: l.id, label: l.label, rate, level: ctx.health('passRate', rate) };
    });

  const todayKey = dayKey(now, settings);
  const days: WeekDay[] = [];
  for (let i = 0; i < 7; i++) {
    const start = addDays(from, i, settings);
    const key = dayKey(start, settings);
    const byLane: Record<string, WeekRun[]> = {};
    const dayRuns: RunRow[] = [];
    for (const lane of lanes) {
      const list = (groups.get(lane.id) ?? []).filter((r) => dayKey(r.started_at, settings) === key).reverse();
      byLane[lane.id] = list.map(toWeekRun);
      dayRuns.push(...list);
    }
    const rate = passRate(sumCounts(dayRuns.filter((r) => r.ended_at)), settings.metrics);
    days.push({
      key,
      start: start.toISOString(),
      isToday: key === todayKey,
      isFuture: start > now,
      byLane,
      rate,
      level: ctx.health('passRate', rate),
      runCount: dayRuns.length,
    });
  }
  // Only runs in the lanes shown, like the classic grid.
  const period = buildPeriodDays(lanes.flatMap((l) => groups.get(l.id) ?? []), from, 7, ctx);
  return {
    week,
    from: from.toISOString(),
    to: to.toISOString(),
    lanes,
    days,
    totalRuns: runs.length,
    aiRuns,
    period,
    summary: periodKpis(period, ctx),
    top,
    problems,
  };
}
