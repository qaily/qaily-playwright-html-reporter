import type {
  AttachmentRecord,
  ErrorRecord,
  HealthLevel,
  PageContext,
  RouteParams,
  RunRow,
  TestDetailsRecord,
  TestStatus,
  TestSummaryRecord,
} from '@qaily/contracts';
import { issueKey, laneOf } from '@qaily/contracts';
import { branchMatches, passRate, rangeFromDays } from '@qaily/core';

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

export interface TestsModel {
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
  const runs = (await data.runs(rangeFromDays(filters.rangeDays, ctx.now()))).filter((r) => branchMatches(r.branch, filters, settings));
  let options = runs.map((r) => runOption(r, ctx));

  let current = params.run ? options.find((o) => o.run.run_id === params.run) ?? null : options.find((o) => o.run.ended_at) ?? options[0] ?? null;
  if (params.run && !current) {
    // Deep link to a run outside the current filters: still show it.
    const run = await data.run(params.run);
    if (!run) throw new Error(`Run ${params.run} was not found`);
    current = runOption(run, ctx);
    options = [current, ...options];
  }
  if (!current) return { runs: options, current: null, specs: [], tests: [], counts: emptyCounts(), projects: [], pathPrefix: '' };

  const detail = await data.runDetail(current.run.run_id);
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
    runs: options,
    current,
    specs,
    tests,
    counts,
    projects: [...new Set(tests.map((t) => t.summary.project))].sort(),
    pathPrefix,
  };
}
