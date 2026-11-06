import type { HealthLevel, PageContext, RunRow } from '@qaily/contracts';
import { branchMatches, groupByLane, isCatchAllLane, passRate, rangeFromDays, sumCounts } from '@qaily/core';

export interface RunCard {
  run: RunRow;
  laneId: string | null;
  rate: number | null;
  level: HealthLevel | 'none';
  running: boolean;
}

export interface LaneCard {
  id: string;
  label: string;
  latest: RunCard | null;
  history: RunCard[];
  runCount: number;
  /** Pass rate over all tests of all runs in the range. */
  rate: number | null;
  level: HealthLevel | 'none';
}

export interface MonitoringModel {
  lanes: LaneCard[];
  /** Every run in range that belongs to a shown lane, newest first (for timeline views). */
  runs: RunCard[];
  /** Runs with AI results (published or draft). */
  aiRuns: Set<string>;
  rangeDays: number;
  totalRuns: number;
}

export function runCard(run: RunRow, ctx: PageContext, laneId: string | null = null): RunCard {
  const rate = passRate(run, ctx.settings.metrics);
  return { run, laneId, rate, level: run.ended_at ? ctx.health('passRate', rate) : 'none', running: !run.ended_at };
}

export async function loadMonitoring(ctx: PageContext): Promise<MonitoringModel> {
  const { settings, filters } = ctx;
  const [all, aiRuns] = await Promise.all([
    ctx.data.runs(rangeFromDays(filters.rangeDays, ctx.now())),
    ctx.ai.runsWithResults().catch(() => new Set<string>()),
  ]);
  const runs = all.filter((r) => branchMatches(r.branch, filters, settings));
  const groups = groupByLane(runs, settings);

  const lanes: LaneCard[] = [];
  for (const lane of settings.lanes) {
    if (filters.lanes.length && !filters.lanes.includes(lane.id)) continue;
    const laneRuns = groups.get(lane.id) ?? [];
    // A catch-all lane with nothing in it is noise.
    if (!laneRuns.length && isCatchAllLane(lane)) continue;
    const finished = laneRuns.filter((r) => r.ended_at);
    const rate = passRate(sumCounts(finished), settings.metrics);
    const cards = laneRuns.map((r) => runCard(r, ctx, lane.id));
    lanes.push({
      id: lane.id,
      label: lane.label,
      latest: cards[0] ?? null,
      history: cards.slice(1, 1 + settings.display.historyChips),
      runCount: laneRuns.length,
      rate,
      level: ctx.health('passRate', rate),
    });
  }
  const timeline = lanes
    .flatMap((l) => (groups.get(l.id) ?? []).map((r) => runCard(r, ctx, l.id)))
    .sort((a, b) => b.run.started_at.localeCompare(a.run.started_at));
  return { lanes, runs: timeline, aiRuns, rangeDays: filters.rangeDays, totalRuns: runs.length };
}
