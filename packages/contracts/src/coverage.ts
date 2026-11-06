// Step coverage: which (Component, Scenario, Feature, Area) cells each test step exercised.
// Two label sources: explicit Playwright step annotations (written by the reporter as step-coverage.jsonl)
// and mapping rules (team settings) applied to existing step titles, so historical runs work too.

/** The four levels, in order. Their display names are settings (coverage.levels). */
export const COVERAGE_LEVELS = ['component', 'scenario', 'feature', 'area'] as const;
export type CoverageLevel = (typeof COVERAGE_LEVELS)[number];

export const UNSPECIFIED = '(unspecified)';

export interface CoverageCell {
  component: string;
  scenario: string;
  feature: string;
  area: string;
}

/**
 * A mapping rule. Conditions are regular expressions (all given ones must match); assignments set levels.
 * Each level takes its value from the first rule (top to bottom) that matches and assigns it.
 * A step counts as a coverage hit only when a rule with a `step` condition matches it,
 * so rules without `step` just add Component/Scenario to the steps other rules match.
 */
export interface CoverageRule {
  /** Step title, e.g. "I archive the board". */
  step?: string;
  /** Any of the test's tags (without @), e.g. "^recurring$". */
  tag?: string;
  /** Test title. */
  title?: string;
  /** Spec file path. */
  file?: string;
  ignoreCase?: boolean;
  component?: string;
  scenario?: string;
  feature?: string;
  area?: string;
}

/** One row of step-coverage.jsonl: an annotated top-level step of one attempt. */
export interface StepCoverageRecord extends CoverageCell {
  run_id: string;
  test_id: string;
  attempt: number;
  /** Index of the top-level step, same numbering as StepRecord.idx in test_details. */
  idx: number;
  title: string;
  status: string;
}

/** A planned cell from data/coverage-catalog.json (the spreadsheet turned into rows). */
export type CatalogCell = CoverageCell;

export interface CoverageCatalog {
  generatedAt?: string;
  levels?: string[];
  cells: CatalogCell[];
}

/** Checks a rule's regular expressions. Returns an error message, or null when the rule is usable. */
export function checkCoverageRule(rule: CoverageRule): string | null {
  const conds = (['step', 'tag', 'title', 'file'] as const).filter((k) => rule[k]);
  if (!conds.length) return 'A rule needs at least one condition (step, tag, title or file).';
  if (!COVERAGE_LEVELS.some((l) => rule[l])) return 'A rule must set at least one level.';
  for (const k of conds) {
    try {
      new RegExp(rule[k]!, rule.ignoreCase ? 'i' : '');
    } catch {
      return `"${rule[k]}" is not a valid regular expression (${k}).`;
    }
    // DuckDB evaluates the rules with RE2, which has no lookaround or backreferences.
    if (/\(\?[=!<]|\\[1-9]/.test(rule[k]!)) return `"${rule[k]}" uses lookaround or a backreference, which the heat map can't evaluate.`;
  }
  return null;
}

export interface RuleSubject {
  step: string;
  title?: string;
  file?: string;
  tags?: string[];
}

/**
 * JavaScript version of the heat map's rule evaluation (the SQL in pages/heatmap/src/sql.ts), for previews:
 * null when the step is not a hit, else the cell with '(unspecified)' for levels no rule sets.
 */
export function evaluateRules(rules: CoverageRule[], s: RuleSubject): CoverageCell | null {
  const test = (re: string | undefined, value: string | undefined, ci?: boolean) => {
    if (!re) return true;
    try {
      return new RegExp(re, ci ? 'i' : '').test(value ?? '');
    } catch {
      return false;
    }
  };
  const matches = (r: CoverageRule) =>
    test(r.step, s.step, r.ignoreCase) &&
    test(r.title, s.title, r.ignoreCase) &&
    test(r.file, s.file, r.ignoreCase) &&
    (!r.tag || (s.tags ?? []).some((t) => test(r.tag, t, r.ignoreCase)));
  const usable = rules.filter((r) => !checkCoverageRule(r));
  if (!usable.some((r) => r.step && matches(r))) return null;
  const cell = {} as CoverageCell;
  for (const level of COVERAGE_LEVELS) cell[level] = usable.find((r) => r[level] && matches(r))?.[level] ?? UNSPECIFIED;
  return cell;
}
