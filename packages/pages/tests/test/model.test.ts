import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, healthLevel, type Filters, type RunRow } from '@qaily/contracts';
import { commonDirPrefix, groupsFromFullTitle, loadTests } from '../src/model.ts';

describe('loadTests with lane and environment filters', () => {
  const run = (id: string, started_at: string, environment: string): RunRow => ({
    run_id: id,
    started_at,
    ended_at: started_at,
    dur_ms: 1,
    total: 0,
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    category: 'ui:web',
    environment,
    branch: 'main',
    tag: null,
    commit: null,
    ci_url: null,
    pw_version: null,
  });
  // Newest first, as data.runs returns them.
  const runs = [run('staging-2', '2026-11-02T10:00:00Z', 'staging'), run('dev-1', '2026-11-01T10:00:00Z', 'dev')];
  const ctx = (filters: Partial<Filters>) =>
    ({
      settings: DEFAULT_SETTINGS,
      filters: { rangeDays: 7, branch: 'main', lanes: [], environments: [], ...filters },
      now: () => new Date('2026-11-02T12:00:00Z'),
      health: (metric: keyof typeof DEFAULT_SETTINGS.thresholds, v: number | null | undefined) => healthLevel(DEFAULT_SETTINGS.thresholds[metric], v),
      data: {
        runs: async () => runs,
        run: async (id: string) => runs.find((r) => r.run_id === id) ?? null,
        runDetail: async () => ({ summaries: [], details: [], errors: [], attachments: [] }),
      },
    }) as never;

  it('offers only matching runs and opens the newest of them', async () => {
    const m = await loadTests(ctx({ environments: ['dev'] }), {});
    expect(m.runs.map((o) => o.run.run_id)).toEqual(['dev-1']);
    expect(m.current?.run.run_id).toBe('dev-1');
    expect((await loadTests(ctx({ lanes: ['web-staging'] }), {})).current?.run.run_id).toBe('staging-2');
  });

  it('has no run when nothing matches', async () => {
    expect((await loadTests(ctx({ environments: ['prod'] }), {})).current).toBeNull();
  });

  it('still opens a run linked directly, whatever the filters', async () => {
    expect((await loadTests(ctx({ environments: ['dev'] }), { run: 'staging-2' })).current?.run.run_id).toBe('staging-2');
  });
});

describe('commonDirPrefix', () => {
  it('finds the shared directory of spec paths', () => {
    expect(commonDirPrefix(['/runner/w/e2e/a/x.spec.js', '/runner/w/e2e/b/y.spec.js'])).toBe('/runner/w/e2e/');
    expect(commonDirPrefix(['/runner/w/e2e/a/x.spec.js'])).toBe('/runner/w/e2e/a/');
  });
  it('terminates on relative and unrelated paths', () => {
    expect(commonDirPrefix(['a/x.spec.ts', 'b/y.spec.ts'])).toBe('');
    expect(commonDirPrefix(['x.spec.ts', '/abs/y.spec.ts'])).toBe('');
    expect(commonDirPrefix([])).toBe('');
  });
});

describe('groupsFromFullTitle', () => {
  it('keeps the describe blocks between file and title', () => {
    const full = ' > chromium-web > e2e/features/a.feature.spec.js > Recurring tasks > Outline <x> > Create recurring task';
    expect(groupsFromFullTitle(full, 'Create recurring task')).toEqual(['Recurring tasks', 'Outline <x>']);
  });
  it('handles a missing title or full title', () => {
    expect(groupsFromFullTitle(undefined, 'T')).toEqual([]);
    expect(groupsFromFullTitle(' > p > f.spec.ts > T', 'T')).toEqual([]);
  });
});
