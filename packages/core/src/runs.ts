import type { RunCounts, RunRow, Settings } from '@qaily/contracts';
import { laneOf } from '@qaily/contracts';

export function sumCounts(runs: readonly RunRow[]): RunCounts {
  const acc: RunCounts = { total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 };
  for (const r of runs) {
    acc.total += r.total;
    acc.passed += r.passed;
    acc.failed += r.failed;
    acc.flaky += r.flaky;
    acc.skipped += r.skipped;
  }
  return acc;
}

/** Runs per lane id, in settings order. Runs that match no lane are left out. */
export function groupByLane(runs: readonly RunRow[], settings: Settings): Map<string, RunRow[]> {
  const groups = new Map<string, RunRow[]>(settings.lanes.map((l) => [l.id, []]));
  for (const run of runs) {
    const lane = laneOf(settings.lanes, run);
    if (lane) groups.get(lane.id)!.push(run);
  }
  return groups;
}

/** A lane with an empty match catches everything; hide it when it has no runs. */
export function isCatchAllLane(lane: Settings['lanes'][number]): boolean {
  return !lane.match.category && !lane.match.environment && !lane.match.branch;
}
