import type { DateRange, ErrorType, PageContext, RouteParams, RunRow, TestStatus } from '@qaily/contracts';
import { laneOf } from '@qaily/contracts';
import { addDays, branchMatches, dayKey, rangeFromDays, startOfDay } from '@qaily/core';

export interface Occurrence {
  run_id: string;
  test_id: string;
  title: string;
  status: TestStatus;
  project: string;
  file: string;
  started_at: number;
  err_msg: string;
  /** The suite (run tag) of the run it failed in. */
  suite: string | null;
}

export interface IssueGroup {
  sig: string;
  errType: ErrorType;
  message: string;
  failedStep: string | null;
  location: string | null;
  locator: string | null;
  occurrences: Occurrence[];
  testCount: number;
  runCount: number;
  /** Recovered on retry (the test ended flaky). */
  flakyCount: number;
  firstSeen: number;
  lastSeen: number;
  /** Occurrences per day across the range, oldest first. */
  perDay: number[];
}

export interface IssuesModel {
  scope: 'run' | 'range';
  run: RunRow | null;
  runs: RunRow[];
  range: { from: string; to: string };
  days: string[];
  issues: IssueGroup[];
  affectedTests: number;
  failingExecutions: number;
  errTypes: ErrorType[];
}

interface Row extends Occurrence {
  issue_sig: string;
  err_type: ErrorType;
  failed_step: string | null;
  err_file: string | null;
  err_line: number | null;
  locator: string | null;
  branch: string | null;
  environment: string | null;
  category: string | null;
}

const q = (s: string) => `'${s.replaceAll("'", "''")}'`;

export async function loadIssues(ctx: PageContext, params: RouteParams, signal: AbortSignal): Promise<IssuesModel> {
  const { settings, filters, data } = ctx;
  const window = rangeFromDays(filters.rangeDays, ctx.now());
  const runs = (await data.runs(window)).filter((r) => branchMatches(r.branch, filters, settings));

  let run: RunRow | null = null;
  let range: DateRange = window;
  if (params.run) {
    run = runs.find((r) => r.run_id === params.run) ?? (await data.run(params.run));
    if (!run) throw new Error(`Run ${params.run} was not found`);
    const start = new Date(run.started_at);
    range = { from: start, to: new Date(start.getTime() + 1) };
  }

  const where: string[] = [];
  if (run) where.push(`i.run_id = ${q(run.run_id)}`);
  else {
    where.push(`epoch_ms(t.started_at) >= ${range.from.getTime()}`, `epoch_ms(t.started_at) < ${range.to.getTime()}`);
    if (filters.branch === 'main') where.push(`t.branch IN (${settings.data.mainBranches.map(q).join(', ')})`);
  }

  const rows = await data.query<Row>(
    `SELECT i.issue_sig, i.err_type, i.err_msg, i.failed_step, i.err_file, i.err_line, i.locator,
       i.run_id, i.test_id, t.title, t.status, t.project, t.file, epoch_ms(t.started_at) AS started_at,
       t.branch, t.environment, t.category, t.suite
     FROM issues i JOIN tests t USING (run_id, test_id)
     WHERE ${where.join(' AND ')}`,
    // Which monthly files to read. A run's month is its start month, so the run's own range is enough.
    range,
  );
  if (signal.aborted) throw new Error('aborted');

  const lanes = filters.lanes;
  const kept = lanes.length ? rows.filter((r) => lanes.includes(laneOf(settings.lanes, r)?.id ?? '')) : rows;

  // Day buckets for the per-issue bars (range scope only).
  const days: string[] = [];
  if (!run) {
    for (let d = startOfDay(range.from, settings); d < range.to; d = addDays(d, 1, settings)) days.push(dayKey(d, settings));
  }
  const dayIndex = new Map(days.map((d, i) => [d, i]));

  const groups = new Map<string, IssueGroup>();
  for (const r of kept) {
    let g = groups.get(r.issue_sig);
    if (!g) {
      g = {
        sig: r.issue_sig,
        errType: r.err_type,
        message: r.err_msg,
        failedStep: r.failed_step,
        location: r.err_file ? `${r.err_file}${r.err_line ? `:${r.err_line}` : ''}` : null,
        locator: r.locator,
        occurrences: [],
        testCount: 0,
        runCount: 0,
        flakyCount: 0,
        firstSeen: r.started_at,
        lastSeen: r.started_at,
        perDay: days.map(() => 0),
      };
      groups.set(r.issue_sig, g);
    }
    g.occurrences.push(r);
    g.firstSeen = Math.min(g.firstSeen, r.started_at);
    g.lastSeen = Math.max(g.lastSeen, r.started_at);
    if (r.status === 'flaky') g.flakyCount++;
    const di = dayIndex.get(dayKey(new Date(r.started_at), settings));
    if (di !== undefined) g.perDay[di]++;
  }
  for (const g of groups.values()) {
    g.testCount = new Set(g.occurrences.map((o) => o.test_id)).size;
    g.runCount = new Set(g.occurrences.map((o) => o.run_id)).size;
    g.occurrences.sort((a, b) => b.started_at - a.started_at);
  }

  const issues = [...groups.values()].sort((a, b) => b.occurrences.length - a.occurrences.length || b.lastSeen - a.lastSeen);
  return {
    scope: run ? 'run' : 'range',
    run,
    runs,
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    days,
    issues,
    affectedTests: new Set(kept.map((r) => r.test_id)).size,
    failingExecutions: kept.length,
    errTypes: [...new Set(issues.map((i) => i.errType))].sort(),
  };
}
