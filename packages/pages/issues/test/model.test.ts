import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, setPath, type Filters, type RunRow } from '@qaily/contracts';
import { loadIssues } from '../src/model.ts';

const settings = setPath(DEFAULT_SETTINGS, 'display.timeZone', 'UTC');
const NOW = new Date('2026-11-02T12:00:00Z');

const run = (id: string, category: string, environment: string): RunRow => ({
  run_id: id,
  started_at: '2026-11-01T10:00:00Z',
  ended_at: '2026-11-01T10:10:00Z',
  dur_ms: 1,
  total: 1,
  passed: 0,
  failed: 1,
  flaky: 0,
  skipped: 0,
  category,
  environment,
  branch: 'main',
  tag: null,
  commit: null,
  ci_url: null,
  pw_version: null,
});

const runs = [run('web-dev', 'ui:web', 'dev'), run('web-staging', 'ui:web', 'staging'), run('admin-dev', 'ui:admin', 'dev')];

/** One failure per run, all with the same signature. */
const rows = runs.map((r) => ({
  issue_sig: 'sig-1',
  err_type: 'assertion',
  err_msg: 'expected true',
  failed_step: null,
  err_file: null,
  err_line: null,
  locator: null,
  run_id: r.run_id,
  test_id: `t-${r.run_id}`,
  title: 'a test',
  status: 'failed',
  project: 'chromium',
  file: 'a.spec.ts',
  started_at: Date.parse(r.started_at),
  branch: r.branch,
  environment: r.environment,
  category: r.category,
  suite: null,
}));

function ctx(filters: Partial<Filters>) {
  return {
    settings,
    filters: { rangeDays: 7, branch: 'main', lanes: [], environments: [], ...filters },
    now: () => NOW,
    data: {
      runs: async () => runs,
      run: async (id: string) => runs.find((r) => r.run_id === id) ?? null,
      query: async (sql: string) => (sql.includes("i.run_id = 'web-staging'") ? rows.filter((r) => r.run_id === 'web-staging') : rows),
    },
  } as never;
}

const signal = new AbortController().signal;
const failingRuns = async (filters: Partial<Filters>, params = {}) =>
  (await loadIssues(ctx(filters), params, signal)).issues.flatMap((i) => i.occurrences.map((o) => o.run_id)).sort();

describe('loadIssues with lane and environment filters', () => {
  it('counts every run without them', async () => {
    expect(await failingRuns({})).toEqual(['admin-dev', 'web-dev', 'web-staging']);
  });

  it('keeps only failures from runs in the chosen environments', async () => {
    expect(await failingRuns({ environments: ['dev'] })).toEqual(['admin-dev', 'web-dev']);
  });

  it('keeps only failures from runs in the chosen lanes', async () => {
    expect(await failingRuns({ lanes: ['admin-dev'] })).toEqual(['admin-dev']);
    expect(await failingRuns({ lanes: ['web-dev', 'web-staging'], environments: ['staging'] })).toEqual(['web-staging']);
  });

  it('offers only matching runs in the run picker', async () => {
    const m = await loadIssues(ctx({ environments: ['staging'] }), {}, signal);
    expect(m.runs.map((r) => r.run_id)).toEqual(['web-staging']);
  });

  it('still shows a run opened by link, whatever the filters', async () => {
    expect(await failingRuns({ environments: ['dev'] }, { run: 'web-staging' })).toEqual(['web-staging']);
  });
});
