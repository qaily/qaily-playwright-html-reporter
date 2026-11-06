// View models shared by period pages (Weekly, Monthly) and the theme views that render them.
// Pages build them with the helpers in @qaily/core (period.ts); themes only read them.

import type { HealthLevel } from './health.ts';
import type { RunRow } from './rollups.ts';

/** One test aggregated over a period. */
export interface TestStat {
  test_id: string;
  title: string;
  file: string;
  /** Test runs that were not skipped (one per execution and project). */
  runs: number;
  /** Executions (CI runs) the test ran in, not skipped. */
  execs: number;
  failed: number;
  flaky: number;
  avg_ms: number;
  last_run_id: string;
  /** The suites (run tags) the test ran in during the period. */
  suites: string[];
}

export interface TopTests {
  topFailing: TestStat[];
  topFlaky: TestStat[];
  slowest: TestStat[];
  /** Set when the tests rollup could not be queried; the run-based parts still work. */
  statsError: string | null;
}

export interface PeriodRun {
  run: RunRow;
  rate: number | null;
  level: HealthLevel | 'none';
  running: boolean;
  /** Hour of day it started, with fractions (09:30 → 9.5), in the display time zone. */
  hour: number;
  laneLabel: string | null;
}

export interface PeriodDay {
  key: string; // YYYY-MM-DD
  start: string; // ISO
  isToday: boolean;
  isFuture: boolean;
  isWeekend: boolean;
  /** Oldest first. */
  runs: PeriodRun[];
  rate: number | null;
  level: HealthLevel | 'none';
  failed: number;
  flaky: number;
  executed: number;
}

/** A test that failed or was flaky on one day. */
export interface DayProblem {
  test_id: string;
  title: string;
  file: string;
  project: string;
  failed: number;
  flaky: number;
  last_run_id: string;
  suites: string[];
}

export interface PeriodKpis {
  passRate: number | null;
  passLevel: HealthLevel | 'none';
  runs: number;
  executed: number;
  failed: number;
  flaky: number;
  /** Key of the day with the lowest pass rate, and that rate. */
  worstDay: { key: string; start: string; rate: number } | null;
}
