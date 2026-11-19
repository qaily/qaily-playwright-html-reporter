import type {
  AttachmentRecord,
  DateRange,
  ErrorRecord,
  HealthLevel,
  PageContext,
  RouteParams,
  RunDetail,
  RunRow,
  TestDetailsRecord,
  TestStatus,
  TestSummaryRecord,
} from '@qaily/contracts';
import { issueKey, laneOf } from '@qaily/contracts';
import { passRate, rangeFromDays, runPassesFilters } from '@qaily/core';

export interface Attempt {
  detail: TestDetailsRecord | null;
  errors: ErrorRecord[];
  attachments: AttachmentRecord[];
}

export interface TestItem {
  summary: TestSummaryRecord;
  spec: string;
  groups: string[];
  line: number | null;
  attempts: Attempt[];
  /** Issue key of the first failing attempt, for "same failure" grouping. */
  issueKey: string | null;
}

export interface SpecNode {
  spec: string;
  tests: TestItem[];
  counts: Record<TestStatus, number>;
}

export interface RunOption {
  run: RunRow;
  lane: string | null;
  rate: number | null;
  level: HealthLevel | 'none';
}

/** One execution of a test in "All runs in range". */
export interface RangeExecution {
  run_id: string;
  status: TestStatus;
  started_ms: number;
  dur_ms: number;
  err_summary: string | null;
  failed_step: string | null;
  attempts: number;
}

/** A test across every run in the range. */
export interface RangeTest {
  test_id: string;
  title: string;
  file: string;
  spec: string;
  project: string;
  tags: string[];
  /** Worst status in the range (failed > flaky > passed > skipped): what the status chips filter on. */
  worst: TestStatus;
  /** Executions per status. */
  counts: Record<TestStatus, number>;
  total: number;
  /** Newest first, at most MAX_EXECUTIONS. */
  executions: RangeExecution[];
}

export interface RangeSpec {
  spec: string;
  tests: RangeTest[];
  /** Tests per worst status. */
  counts: Record<TestStatus, number>;
}

export interface RangeView {
  tests: RangeTest[];
  specs: RangeSpec[];
  /** Tests per worst status. */
  counts: Record<TestStatus, number>;
  projects: string[];
  /** Set when the tests rollup could not be queried. */
  error: string | null;
}

/** Executions kept per test in range scope (the newest). */
export const MAX_EXECUTIONS = 50;

export interface TestsModel {
  /** "range": every run in the range (the default); "run": one run, picked in Scope or linked. */
  scope: 'range' | 'run';
  /** The tests of all runs in the range, when scope is "range". */
  range: RangeView | null;
  runs: RunOption[];
  current: RunOption | null;
  specs: SpecNode[];
  tests: TestItem[];
  counts: Record<TestStatus, number>;
  projects: string[];
  /** Common path prefix removed from spec paths. */
  pathPrefix: string;
}

const STATUSES: TestStatus[] = ['failed', 'flaky', 'passed', 'skipped'];

export function emptyCounts(): Record<TestStatus, number> {
  return { failed: 0, flaky: 0, passed: 0, skipped: 0 };
}

/** Longest common directory prefix, so spec paths read "tasks/create.spec.ts", not the CI runner path. */
export function commonDirPrefix(paths: string[]): string {
  if (!paths.length) return '';
  let prefix = paths[0].slice(0, paths[0].lastIndexOf('/') + 1);
  for (const p of paths) {
    while (prefix && !p.startsWith(prefix)) {
      const cut = prefix.lastIndexOf('/', prefix.length - 2);
      prefix = cut < 0 ? '' : prefix.slice(0, cut + 1);
    }
  }
  return prefix;
}

/** " > project > file > Describe > Outline > Title" → describe groups between the file and the title. */
export function groupsFromFullTitle(fullTitle: string | undefined, title: string): string[] {
  if (!fullTitle) return [];
  const parts = fullTitle.split(' > ').map((p) => p.trim()).filter(Boolean);
  const inner = parts.slice(2, -1);
  return parts[parts.length - 1] === title ? inner : parts.slice(2);
}

export function runOption(run: RunRow, ctx: PageContext): RunOption {
  const rate = passRate(run, ctx.settings.metrics);
  return {
    run,
    lane: laneOf(ctx.settings.lanes, run)?.label ?? null,
    rate,
    level: run.ended_at ? ctx.health('passRate', rate) : 'none',
  };
}

export async function loadTests(ctx: PageContext, params: RouteParams): Promise<TestsModel> {
  const { settings, filters, data } = ctx;
  const runs = (await data.runs(rangeFromDays(filters.rangeDays, ctx.now(), settings))).filter((r) => runPassesFilters(r, filters, settings));
  let options = runs.map((r) => runOption(r, ctx));
  const none = { specs: [], tests: [], counts: emptyCounts(), projects: [], pathPrefix: '' };

  if (!params.run) {
    const range = await loadRange(ctx, runs, rangeFromDays(filters.rangeDays, ctx.now(), settings));
    return { scope: 'range', range, runs: options, current: null, ...none };
  }

  let current = options.find((o) => o.run.run_id === params.run) ?? null;
  if (!current) {
    // Deep link to a run outside the current filters: still show it.
    const run = await data.run(params.run);
    if (!run) throw new Error(`Run ${params.run} was not found`);
    current = runOption(run, ctx);
    options = [current, ...options];
  }

  const { tests, counts, pathPrefix } = runTestItems(await data.runDetail(current.run.run_id));

  const bySpec = new Map<string, TestItem[]>();
  for (const t of tests) bySpec.set(t.spec, [...(bySpec.get(t.spec) ?? []), t]);
  const severity = (n: SpecNode) => n.counts.failed * 1000 + n.counts.flaky;
  const specs = [...bySpec.entries()]
    .map(([spec, list]) => {
      const c = emptyCounts();
      for (const t of list) c[t.summary.status]++;
      return { spec, tests: list.sort((a, b) => STATUSES.indexOf(a.summary.status) - STATUSES.indexOf(b.summary.status) || (a.line ?? 0) - (b.line ?? 0)), counts: c };
    })
    .sort((a, b) => severity(b) - severity(a) || a.spec.localeCompare(b.spec));

  return {
    scope: 'run',
    range: null,
    runs: options,
    current,
    specs,
    tests,
    counts,
    projects: [...new Set(tests.map((t) => t.summary.project))].sort(),
    pathPrefix,
  };
}

/** Every test of one run with its attempts, errors and attachments: what the test details panel shows. */
export function runTestItems(detail: RunDetail): { tests: TestItem[]; counts: Record<TestStatus, number>; pathPrefix: string } {
  const key = (testId: string, attempt: number) => `${testId}#${attempt}`;
  const errorsBy = new Map<string, ErrorRecord[]>();
  for (const e of detail.errors) errorsBy.set(key(e.test_id, e.attempt), [...(errorsBy.get(key(e.test_id, e.attempt)) ?? []), e]);
  const attachmentsBy = new Map<string, AttachmentRecord[]>();
  for (const a of detail.attachments) attachmentsBy.set(key(a.test_id, a.attempt), [...(attachmentsBy.get(key(a.test_id, a.attempt)) ?? []), a]);
  const detailsBy = new Map<string, TestDetailsRecord[]>();
  for (const d of detail.details) detailsBy.set(d.test_id, [...(detailsBy.get(d.test_id) ?? []), d]);

  const pathPrefix = commonDirPrefix(detail.summaries.map((s) => s.file));
  const counts = emptyCounts();
  const tests: TestItem[] = detail.summaries.map((s) => {
    counts[s.status] = (counts[s.status] ?? 0) + 1;
    const ds = (detailsBy.get(s.test_id) ?? []).sort((a, b) => a.attempt - b.attempt);
    const attemptNumbers = ds.length ? ds.map((d) => d.attempt) : [0];
    const attempts = attemptNumbers.map((n) => ({
      detail: ds.find((d) => d.attempt === n) ?? null,
      errors: errorsBy.get(key(s.test_id, n)) ?? [],
      attachments: attachmentsBy.get(key(s.test_id, n)) ?? [],
    }));
    const firstError = attempts.flatMap((a) => a.errors)[0];
    return {
      summary: s,
      spec: s.file.slice(pathPrefix.length) || s.file,
      groups: groupsFromFullTitle(ds[0]?.full_title, s.title),
      line: ds[0]?.line_num ?? null,
      attempts,
      issueKey: firstError ? issueKey(firstError.err_msg, firstError.failed_step) : null,
    };
  });
  return { tests, counts, pathPrefix };
}

// --- All runs in range ------------------------------------------------------------------------------------------

const WORST_FIRST: TestStatus[] = ['failed', 'flaky', 'passed', 'skipped'];

/** One row per test from the tests rollup, with its executions in the range. */
export interface RangeRow {
  test_id: string;
  title: string;
  file: string;
  project: string;
  tags: string[] | null;
  total: number;
  failed: number;
  flaky: number;
  passed: number;
  skipped: number;
  executions: RangeExecution[] | null;
}

const q = (s: string) => `'${s.replaceAll("'", "''")}'`;

export function rangeSql(runIds: readonly string[], range: DateRange): string {
  return `SELECT test_id, any_value(title) AS title, any_value(file) AS file, any_value(project) AS project,
      any_value(tags) AS tags, count(*) AS total,
      count(*) FILTER (WHERE status = 'failed') AS failed, count(*) FILTER (WHERE status = 'flaky') AS flaky,
      count(*) FILTER (WHERE status = 'passed') AS passed, count(*) FILTER (WHERE status = 'skipped') AS skipped,
      list(struct_pack(run_id := run_id, status := status, started_ms := epoch_ms(started_at), dur_ms := dur_ms,
        err_summary := err_summary, failed_step := failed_step, attempts := attempts)
        ORDER BY started_at DESC)[1:${MAX_EXECUTIONS}] AS executions
    FROM tests
    WHERE epoch_ms(started_at) >= ${range.from.getTime()} AND epoch_ms(started_at) < ${range.to.getTime()}
      AND run_id IN (${runIds.map(q).join(', ')})
    GROUP BY test_id`;
}

/** Groups rollup rows into specs, worst first, the same way a single run is shown. */
export function buildRange(rows: readonly RangeRow[]): Omit<RangeView, 'error'> {
  const prefix = commonDirPrefix(rows.map((r) => r.file));
  const tests: RangeTest[] = rows.map((r) => {
    const counts = { failed: Number(r.failed), flaky: Number(r.flaky), passed: Number(r.passed), skipped: Number(r.skipped) };
    return {
      test_id: r.test_id,
      title: r.title,
      file: r.file,
      spec: r.file.slice(prefix.length) || r.file,
      project: r.project,
      tags: r.tags ?? [],
      worst: WORST_FIRST.find((s) => counts[s] > 0) ?? 'skipped',
      counts,
      total: Number(r.total),
      executions: (r.executions ?? []).map((e) => ({ ...e, started_ms: Number(e.started_ms), dur_ms: Number(e.dur_ms), attempts: Number(e.attempts) })),
    };
  });
  const counts = emptyCounts();
  const bySpec = new Map<string, RangeTest[]>();
  for (const t of tests) {
    counts[t.worst]++;
    bySpec.set(t.spec, [...(bySpec.get(t.spec) ?? []), t]);
  }
  const severity = (c: Record<TestStatus, number>) => c.failed * 1000 + c.flaky;
  const specs = [...bySpec.entries()]
    .map(([spec, list]) => {
      const c = emptyCounts();
      for (const t of list) c[t.worst]++;
      const sorted = list.sort((a, b) => WORST_FIRST.indexOf(a.worst) - WORST_FIRST.indexOf(b.worst) || b.counts.failed - a.counts.failed || a.title.localeCompare(b.title));
      return { spec, tests: sorted, counts: c };
    })
    .sort((a, b) => severity(b.counts) - severity(a.counts) || a.spec.localeCompare(b.spec));
  return { tests, specs, counts, projects: [...new Set(tests.map((t) => t.project))].sort() };
}

async function loadRange(ctx: PageContext, runs: readonly RunRow[], range: DateRange): Promise<RangeView> {
  if (!runs.length) return { tests: [], specs: [], counts: emptyCounts(), projects: [], error: null };
  try {
    const rows = await ctx.data.query<RangeRow>(rangeSql(runs.map((r) => r.run_id), range), range);
    return { ...buildRange(rows), error: null };
  } catch (err) {
    return { tests: [], specs: [], counts: emptyCounts(), projects: [], error: err instanceof Error ? err.message : String(err) };
  }
}
