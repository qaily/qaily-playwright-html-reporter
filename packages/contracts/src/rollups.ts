// Files produced by `qaily-report build` and read by the browser.

import type { ErrorType, TestStatus } from './records.ts';

export const CATALOG_SCHEMA_VERSION = 2;

/** One row per run, built from the run_start/run_end manifest records. */
export interface RunRow {
  run_id: string;
  started_at: string; // ISO 8601
  ended_at: string | null; // null while the run is still going (no run_end yet)
  dur_ms: number | null;
  total: number;
  passed: number; // excludes flaky
  failed: number;
  flaky: number;
  skipped: number;
  category: string | null;
  environment: string | null;
  branch: string | null;
  tag: string | null;
  commit: string | null;
  ci_url: string | null;
  pw_version: string | null;
}

/** One row per (run, test): test-summary plus attempt count and first-attempt issue signature. */
export interface TestRow {
  run_id: string;
  test_id: string;
  started_at: string;
  title: string;
  status: TestStatus;
  tags: string[];
  dur_ms: number;
  project: string;
  file: string;
  err_type: ErrorType | null;
  err_summary: string | null;
  failed_step: string | null;
  attempts: number;
  issue_sig: string | null;
  // Copied from the run so test queries need no join.
  branch: string | null;
  environment: string | null;
  category: string | null;
  /** The run's manifest tag: which suite was run (e.g. @regression). */
  suite: string | null;
}

/** One row per first-attempt error, grouped in the UI by issue_sig. */
export interface IssueRow {
  run_id: string;
  test_id: string;
  issue_sig: string;
  err_type: ErrorType;
  err_msg: string;
  norm_msg: string;
  failed_step: string | null;
  norm_step: string | null;
  err_file: string | null;
  err_line: number | null;
  locator: string | null;
}

export interface CatalogMonth {
  month: string; // YYYY-MM
  runs: number;
  hash: string; // changes whenever the month's content changes; used as a cache buster
  /** steps is absent in data built before the heat map existed; rebuild to get it. */
  files: { runs: string; tests: string; issues: string; steps?: string };
}

export interface Catalog {
  schemaVersion: number;
  generatedAt: string;
  runCount: number;
  latestRunAt: string | null;
  months: CatalogMonth[]; // newest first
  /** Per-run raw files live at runs/<run_id>/<file>.jsonl.gz */
  runsPath: string;
}
