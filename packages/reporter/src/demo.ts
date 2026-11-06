// Synthetic run folders in the reporter's JSONL format, for demos and tests.
// Deterministic for a given seed; dates are relative to `now` so dashboards look current.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CatalogCell,
  CoverageCatalog,
  CoverageRule,
  ErrorRecord,
  ManifestRunEnd,
  ManifestRunStart,
  TestDetailsRecord,
  TestStatus,
  TestSummaryRecord,
} from '@qaily/contracts';

export interface DemoOptions {
  runs: number;
  days: number;
  seed?: number;
  now?: Date;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FEATURES = [
  { file: 'tasks/tasks.feature.spec.js', tests: ['Create task', 'Assign task', 'Close task', 'Edit task due date'] },
  { file: 'boards/boards.feature.spec.js', tests: ['Archive board', 'Delete board column', 'Duplicate board column'] },
  { file: 'templates/templates.feature.spec.js', tests: ['Create template', 'Edit template', 'Use template for a task'] },
  { file: 'search/search.feature.spec.js', tests: ['Search by date range', 'Export results as PDF'] },
  { file: 'auth/login.feature.spec.js', tests: ['Login with code', 'Select workspace', 'Switch workspace'] },
];

const ERRORS = [
  { type: 'timeout', msg: 'Error: Timeout 15000ms exceeded while waiting on the predicate', step: 'And I submit the form' },
  { type: 'assertion', msg: 'Error: expect(received).toHaveText(expected) Expected: "Done" Received: "In progress"', step: 'Then the task has status "Done"' },
  { type: 'element_not_found', msg: 'Error: locator.click: Element not found getByRole(\'button\', { name: \'Archive\' })', step: 'And I archive the board' },
  { type: 'network', msg: 'Error: Request failed with status 502 for POST /api/tasks', step: 'When I create a task' },
] as const;

// Which suite (manifest tag) each demo run ran, so suite badges have something to show.
const DEMO_SUITES = ['@regression', '@regression', '@smoke', '@regression', '@nightly'];

const LANES = [
  { category: 'ui:web', environment: 'dev' },
  { category: 'ui:web', environment: 'staging' },
  { category: 'ui:admin', environment: 'dev' },
  { category: 'ui:admin', environment: 'staging' },
];

/** The step that does what the test is named after, e.g. "When I archive board". */
const mainStep = (title: string) => `When I ${title.charAt(0).toLowerCase()}${title.slice(1)}`;

/** Heat map rules for the demo data: tests give Component and Scenario, steps give Feature and Area. */
export const DEMO_COVERAGE_RULES: CoverageRule[] = [
  { title: 'template', ignoreCase: true, component: 'Tasks', scenario: 'Templates' },
  { title: '^(Create|Assign|Close|Edit) task', component: 'Tasks', scenario: 'Task lifecycle' },
  { title: 'board', ignoreCase: true, component: 'Boards', scenario: 'Board management' },
  { title: '^(Search|Export)', component: 'Search', scenario: 'Search and export' },
  { title: '^(Login|Select|Switch)', component: 'Accounts', scenario: 'Sign-in' },
  { step: 'logged in', ignoreCase: true, feature: 'Authentication', area: 'Login' },
  { step: 'create (a )?task', ignoreCase: true, feature: 'Tasks', area: 'Create' },
  { step: 'assign task', ignoreCase: true, feature: 'Tasks', area: 'Assign' },
  { step: 'close task', ignoreCase: true, feature: 'Tasks', area: 'Close' },
  { step: 'due date', ignoreCase: true, feature: 'Tasks', area: 'Due date' },
  { step: 'has status', ignoreCase: true, feature: 'Tasks', area: 'Status' },
  { step: 'archive (the )?board', ignoreCase: true, feature: 'Boards', area: 'Archive' },
  { step: 'board column', ignoreCase: true, feature: 'Boards', area: 'Columns' },
  { step: '(create|edit) template', ignoreCase: true, feature: 'Templates', area: 'Edit' },
  { step: 'use template', ignoreCase: true, feature: 'Templates', area: 'Apply' },
  { step: 'search by date range', ignoreCase: true, feature: 'Search', area: 'Date range' },
  { step: 'export results', ignoreCase: true, feature: 'Search', area: 'Export' },
  { step: 'login with code', ignoreCase: true, feature: 'Authentication', area: 'Code' },
  { step: '(select|switch) workspace', ignoreCase: true, feature: 'Workspaces', area: 'Switch' },
  // "And I submit the form" is left unmapped on purpose, so the Unmapped steps list has something to show.
];

const planned = (component: string, scenario: string, rows: [string, string][]): CatalogCell[] =>
  rows.map(([feature, area]) => ({ component, scenario, feature, area }));

/** The planned matrix for the demo data. Each scenario has one cell no test covers, to show gaps. */
export const DEMO_COVERAGE_CATALOG: CoverageCatalog = {
  levels: ['Component', 'Scenario', 'Feature', 'Area'],
  cells: [
    ...planned('Tasks', 'Task lifecycle', [['Authentication', 'Login'], ['Tasks', 'Create'], ['Tasks', 'Assign'], ['Tasks', 'Close'], ['Tasks', 'Due date'], ['Tasks', 'Status'], ['Tasks', 'Delete']]),
    ...planned('Tasks', 'Templates', [['Authentication', 'Login'], ['Templates', 'Edit'], ['Templates', 'Apply'], ['Templates', 'Share']]),
    ...planned('Boards', 'Board management', [['Authentication', 'Login'], ['Boards', 'Archive'], ['Boards', 'Columns'], ['Boards', 'Rename']]),
    ...planned('Search', 'Search and export', [['Authentication', 'Login'], ['Search', 'Date range'], ['Search', 'Export'], ['Search', 'Saved searches']]),
    ...planned('Accounts', 'Sign-in', [['Authentication', 'Login'], ['Authentication', 'Code'], ['Workspaces', 'Switch'], ['Authentication', 'Logout']]),
  ],
};

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
const hex = (rand: () => number, n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');

export function writeDemoRuns(outDir: string, opts: DemoOptions): void {
  const rand = rng(opts.seed ?? 4512);
  const now = opts.now ?? new Date();
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const tests = FEATURES.flatMap((f, fi) =>
    f.tests.map((title, ti) => ({ id: `demo${fi}${ti}-${hex(rand, 8)}`, title, file: f.file, flakiness: rand() * 0.15 })),
  );
  // A few tests are persistently broken for a stretch of days, like real incidents.
  const broken = new Set(tests.filter(() => rand() < 0.12).map((t) => t.id));

  for (let i = 0; i < opts.runs; i++) {
    const started = new Date(now.getTime() - rand() * opts.days * 86_400_000);
    const lane = LANES[i % LANES.length];
    const branch = rand() < 0.85 ? 'main' : `feature/TASK-${1000 + Math.floor(rand() * 9000)}`;
    const commit = hex(rand, 40);
    const runId = `${started.toISOString().replace(/[:.]/g, '-').replace('Z', '')}_${commit.slice(0, 7)}_${1000 + i}`;
    const dir = join(outDir, runId);
    mkdirSync(dir, { recursive: true });

    const summaries: TestSummaryRecord[] = [];
    const details: TestDetailsRecord[] = [];
    const errors: ErrorRecord[] = [];
    let t = started.getTime() + 1000;
    const incident = rand() < 0.1; // whole-run environment trouble

    for (const test of tests) {
      const roll = rand();
      let status: TestStatus = 'passed';
      if (roll < 0.06) status = 'skipped';
      else if (broken.has(test.id) && rand() < 0.7) status = 'failed';
      else if (incident && rand() < 0.5) status = 'failed';
      else if (roll < 0.06 + test.flakiness) status = rand() < 0.5 ? 'flaky' : 'failed';

      const err = status === 'failed' || status === 'flaky' ? ERRORS[Math.floor(rand() * ERRORS.length)] : null;
      const dur = Math.floor(20_000 + rand() * 150_000);
      const attempts = status === 'failed' || status === 'flaky' ? 2 : 1;
      const base = { run_id: runId, test_id: test.id, started_at: new Date(t).toISOString() };
      summaries.push({
        ...base, title: test.title, status, tags: ['regression', `TASK-${test.id.slice(4, 8)}`], dur_ms: dur,
        project: 'chromium', file: `/runner/_work/demo/.features-gen/e2e-tests/${test.file}`,
        err_summary: status === 'failed' ? err!.msg : null, err_type: status === 'failed' ? err!.type : null,
        failed_step: status === 'failed' ? err!.step : null,
      });
      for (let attempt = 0; attempt < attempts; attempt++) {
        const failedAttempt = status === 'failed' || (status === 'flaky' && attempt === 0);
        details.push({
          ...base, attempt, worker_idx: i % 4, parallel_idx: i % 4, status: failedAttempt ? 'failed' : status === 'skipped' ? 'skipped' : 'passed',
          dur_ms: dur, step_cnt: 3, failed_step_idx: failedAttempt ? 1 : null,
          steps: [
            { idx: 0, title: 'Given I am logged in', dur_ms: 4000, status: 'passed' },
            { idx: 1, title: err?.step ?? mainStep(test.title), dur_ms: dur - 6000, status: failedAttempt ? 'failed' : 'passed' },
            { idx: 2, title: 'After Hooks', dur_ms: 2000, status: 'passed' },
          ],
          full_title: ` > chromium > ${test.file} > ${test.title}`, line_num: 10,
        });
        if (failedAttempt && err) {
          errors.push({
            ...base, attempt, err_msg: err.msg, err_type: err.type, stack: `${err.msg}\n    at demo (${test.file}:10:5)`,
            err_file: test.file, err_line: 10, err_col: 5, snippet: null, failed_step: err.step, locator: null,
          });
        }
      }
      t += dur / 4;
    }

    const count = (s: TestStatus) => summaries.filter((x) => x.status === s).length;
    const start: ManifestRunStart = {
      schema_version: '1.0', run_id: runId, type: 'run_start', started_at: started.toISOString(), git_commit: commit,
      git_branch: branch, ci_url: `https://github.com/example/tests/actions/runs/${9000 + i}`, pw_version: '1.63.0',
      environment: lane.environment, tag: DEMO_SUITES[i % DEMO_SUITES.length], category: lane.category,
    };
    const running = started.getTime() > now.getTime() - 20 * 60_000;
    const end: ManifestRunEnd = {
      run_id: runId, type: 'run_end', ended_at: new Date(t).toISOString(), dur_ms: t - started.getTime(),
      test_cnt: summaries.length, passed_cnt: count('passed'), failed_cnt: count('failed'), flaky_cnt: count('flaky'),
      skipped_cnt: count('skipped'),
    };
    writeFileSync(join(dir, 'manifest.jsonl'), jsonl(running ? [start] : [start, end]));
    writeFileSync(join(dir, 'test-summary.jsonl'), jsonl(summaries));
    writeFileSync(join(dir, 'test_details.jsonl'), jsonl(details));
    writeFileSync(join(dir, 'errors.jsonl'), jsonl(errors));
    writeFileSync(join(dir, 'attachments-index.jsonl'), '');
    writeFileSync(join(dir, '.sync-complete'), JSON.stringify({ complete: true }));
  }
}
