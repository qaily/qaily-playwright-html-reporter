// SQL for the heat map, run by DuckDB over the `tests` and `steps` rollups. Pure string building, so the same
// queries are tested in Node against real build output (test/sql.test.ts).
//
// Counting:
// - a cell counts once per test per attempt, however many steps hit it; the worst step status wins
// - only the deciding (final) attempt counts as a hit; "flaky" = failed on an earlier attempt, passed on the final one
// - explicit annotations on a step replace the rules for that step
// - skipped steps never ran, so they are not hits

import { COVERAGE_LEVELS, UNSPECIFIED, checkCoverageRule, type CoverageCell, type CoverageRule } from '@qaily/contracts';

export interface CoverageScope {
  runId?: string;
  fromMs?: number;
  toMs?: number;
  /** Only these branches (when given). */
  branches?: string[];
}

/** Steps the framework adds around every test; never coverage. */
export const HOOK_STEPS = ['Before Hooks', 'After Hooks', 'Worker Cleanup'];

export const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;

function cond(rule: CoverageRule): string {
  const re = (field: string, value: string) => `regexp_matches(${field}, ${lit(value)}${rule.ignoreCase ? ", 'i'" : ''})`;
  const parts: string[] = [];
  if (rule.step) parts.push(re('title', rule.step));
  if (rule.title) parts.push(re('test_title', rule.title));
  if (rule.file) parts.push(re('file', rule.file));
  if (rule.tag) {
    const tag = `regexp_matches(x, ${lit(rule.tag)}${rule.ignoreCase ? ", 'i'" : ''})`;
    parts.push(`len(list_filter(tags, x -> ${tag})) > 0`);
  }
  return parts.length ? `(${parts.join(' AND ')})` : 'FALSE';
}

/** Rules that pass checkCoverageRule; the others are reported to the user and ignored. */
export function usableRules(rules: CoverageRule[]): { rules: CoverageRule[]; errors: string[] } {
  const ok: CoverageRule[] = [];
  const errors: string[] = [];
  rules.forEach((r, i) => {
    const e = checkCoverageRule(r);
    if (e) errors.push(`Rule ${i + 1}: ${e}`);
    else ok.push(r);
  });
  return { rules: ok, errors };
}

/** CASE expression giving one level from the first matching rule that sets it. */
export function levelSql(rules: CoverageRule[], level: (typeof COVERAGE_LEVELS)[number]): string {
  const whens = rules.filter((r) => r[level]).map((r) => `WHEN ${cond(r)} THEN ${lit(r[level]!)}`);
  return whens.length ? `CASE ${whens.join(' ')} ELSE NULL END` : 'NULL';
}

/** True when a rule with a step condition matches: that makes the step a coverage hit. */
export function matchedSql(rules: CoverageRule[]): string {
  const stepRules = rules.filter((r) => r.step);
  return stepRules.length ? `(${stepRules.map(cond).join(' OR ')})` : 'FALSE';
}

function scopeWhere(scope: CoverageScope): string {
  const where: string[] = [];
  if (scope.runId) where.push(`run_id = ${lit(scope.runId)}`);
  if (scope.fromMs !== undefined) where.push(`epoch_ms(started_at) >= ${Math.floor(scope.fromMs)}`);
  if (scope.toMs !== undefined) where.push(`epoch_ms(started_at) < ${Math.floor(scope.toMs)}`);
  if (scope.branches?.length) where.push(`branch IN (${scope.branches.map(lit).join(', ')})`);
  return where.length ? `WHERE ${where.join(' AND ')}` : '';
}

/** CTEs ending in per_test: one row per (run, test, cell) from the deciding attempt, with flaky. */
export function baseSql(rules: CoverageRule[], scope: CoverageScope): string {
  const un = lit(UNSPECIFIED);
  const levels = COVERAGE_LEVELS.map((l) => `${levelSql(rules, l)} AS r_${l}`).join(',\n      ');
  return `
  WITH t AS (
    SELECT run_id, test_id, title AS test_title, file, tags, epoch_ms(started_at) AS started_ms FROM tests ${scopeWhere(scope)}
  ),
  s AS (
    SELECT st.run_id, st.test_id, st.attempt, st.final_attempt, st.idx, st.title, st.status, st.dur_ms, st.cells,
      t.test_title, t.file, t.tags, t.started_ms
    FROM steps st JOIN t USING (run_id, test_id)
    WHERE st.status <> 'skipped'
  ),
  ruled AS (
    SELECT s.*, ${matchedSql(rules)} AS matched,
      ${levels}
    FROM s
  ),
  hits AS (
    SELECT run_id, test_id, attempt, final_attempt, idx, title, status, dur_ms, test_title, started_ms,
      coalesce(r_component, ${un}) AS component, coalesce(r_scenario, ${un}) AS scenario,
      coalesce(r_feature, ${un}) AS feature, coalesce(r_area, ${un}) AS area
    FROM ruled WHERE matched AND cells IS NULL
    UNION ALL
    SELECT run_id, test_id, attempt, final_attempt, idx, title, status, dur_ms, test_title, started_ms,
      coalesce(c.component, ${un}), coalesce(c.scenario, ${un}), coalesce(c.feature, ${un}), coalesce(c.area, ${un})
    FROM (SELECT *, unnest(cells) AS c FROM s WHERE cells IS NOT NULL)
  ),
  per_attempt AS (
    SELECT run_id, test_id, attempt, final_attempt, component, scenario, feature, area,
      max(CASE WHEN status = 'passed' THEN 0 ELSE 2 END) AS rank,
      any_value(test_title) AS test_title, any_value(started_ms) AS started_ms,
      list({'idx': idx, 'title': title, 'status': status, 'dur_ms': dur_ms} ORDER BY idx) AS steps
    FROM hits GROUP BY ALL
  ),
  per_test AS (
    SELECT run_id, test_id, component, scenario, feature, area,
      max(rank) FILTER (WHERE final_attempt) AS final_rank,
      bool_or(NOT final_attempt AND rank = 2) AND bool_or(final_attempt AND rank = 0) AS flaky
    FROM per_attempt GROUP BY ALL
    HAVING count(*) FILTER (WHERE final_attempt) > 0
  )`;
}

export interface CellRow extends CoverageCell {
  hits: number;
  passed: number;
  failed: number;
  flaky: number;
  tests: number;
  runs: number;
}

export function cellsSql(rules: CoverageRule[], scope: CoverageScope): string {
  return `${baseSql(rules, scope)}
  SELECT component, scenario, feature, area,
    count(*) AS hits,
    count(*) FILTER (WHERE final_rank = 0) AS passed,
    count(*) FILTER (WHERE final_rank = 2) AS failed,
    count(*) FILTER (WHERE flaky) AS flaky,
    count(DISTINCT test_id) AS tests,
    count(DISTINCT run_id) AS runs
  FROM per_test GROUP BY ALL`;
}

export interface CellDetailRow {
  run_id: string;
  test_id: string;
  test_title: string;
  started_ms: number;
  final_rank: number;
  flaky: boolean;
  steps: { idx: number; title: string; status: string; dur_ms: number }[];
}

export function cellDetailSql(rules: CoverageRule[], scope: CoverageScope, cell: CoverageCell, limit = 200): string {
  const match = COVERAGE_LEVELS.map((l) => `pt.${l} = ${lit(cell[l])}`).join(' AND ');
  return `${baseSql(rules, scope)}
  SELECT pt.run_id, pt.test_id, pa.test_title, pa.started_ms, pt.final_rank, pt.flaky, pa.steps
  FROM per_test pt
  JOIN per_attempt pa ON pa.run_id = pt.run_id AND pa.test_id = pt.test_id AND pa.final_attempt
    AND pa.component = pt.component AND pa.scenario = pt.scenario AND pa.feature = pt.feature AND pa.area = pt.area
  WHERE ${match}
  ORDER BY pt.final_rank DESC, pa.started_ms DESC
  LIMIT ${Math.floor(limit)}`;
}

export interface UnmappedRow {
  title: string;
  steps: number;
  tests: number;
}

/** The most common steps no rule or annotation maps yet, to help write rules. Quoted values are folded. */
export function unmappedSql(rules: CoverageRule[], scope: CoverageScope, limit = 40): string {
  return `${baseSql(rules, scope)}
  SELECT regexp_replace(title, '"[^"]*"', '"…"', 'g') AS title, count(*) AS steps, count(DISTINCT test_id) AS tests
  FROM ruled
  WHERE NOT matched AND cells IS NULL AND final_attempt AND title NOT IN (${HOOK_STEPS.map(lit).join(', ')})
  GROUP BY 1 ORDER BY steps DESC LIMIT ${Math.floor(limit)}`;
}

/** Regex for a step title, with folded quoted values ("…") matching anything quoted. */
export function ruleForTitle(title: string): string {
  return `^${title
    .split('"…"')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('"[^"]*"')}$`;
}
