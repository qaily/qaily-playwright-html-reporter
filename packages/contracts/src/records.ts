// Raw JSONL records written by @qaily/playwright-jsonl-reporter (schema_version 1.0).

export type TestStatus = 'passed' | 'failed' | 'skipped' | 'flaky';
export type AttemptStatus = 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
export type ErrorType = 'timeout' | 'assertion' | 'element_not_found' | 'network' | 'unknown';

export interface ManifestRunStart {
  schema_version: string;
  run_id: string;
  type: 'run_start';
  started_at: string;
  git_commit?: string;
  git_branch?: string;
  ci_url?: string;
  pw_version?: string;
  environment?: string;
  tag?: string;
  category?: string;
}

export interface ManifestRunEnd {
  run_id: string;
  type: 'run_end';
  ended_at: string;
  dur_ms: number;
  test_cnt: number;
  passed_cnt: number;
  failed_cnt: number;
  flaky_cnt: number;
  skipped_cnt: number;
}

export type ManifestRecord = ManifestRunStart | ManifestRunEnd | { type: 'file_index'; run_id: string };

export interface TestSummaryRecord {
  run_id: string;
  test_id: string;
  started_at: string;
  title: string;
  status: TestStatus;
  tags: string[];
  dur_ms: number;
  project: string;
  file: string;
  err_summary: string | null;
  err_type: ErrorType | null;
  failed_step: string | null;
}

export interface StepRecord {
  idx: number;
  title: string;
  dur_ms: number;
  status: AttemptStatus;
}

export interface TestDetailsRecord {
  run_id: string;
  test_id: string;
  started_at: string;
  attempt: number;
  worker_idx: number;
  parallel_idx: number;
  status: AttemptStatus;
  dur_ms: number;
  step_cnt: number;
  failed_step_idx: number | null;
  steps: StepRecord[];
  full_title: string;
  line_num: number;
  annotations?: { type: string; description?: string }[];
}

export interface ErrorRecord {
  run_id: string;
  test_id: string;
  attempt: number;
  err_msg: string;
  err_type: ErrorType;
  stack: string | null;
  err_file: string | null;
  err_line: number | null;
  err_col: number | null;
  snippet: string | null;
  failed_step: string | null;
  locator: string | null;
}

export interface AttachmentRecord {
  run_id: string;
  test_id: string;
  attempt: number;
  name: string;
  type: string;
  path: string;
  size: number;
  hash: string | null;
}

/** Raw per-run files, in the order the reporter writes them. */
export const RUN_FILES = ['manifest', 'test-summary', 'test_details', 'errors', 'attachments-index', 'step-coverage'] as const;
export type RunFile = (typeof RUN_FILES)[number];
