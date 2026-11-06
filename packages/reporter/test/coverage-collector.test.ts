import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CoverageCollector } from '../src/playwright/coverage-collector.ts';
import { coverage } from '../src/playwright/coverage.ts';

const step = (title: string, annotations: { type: string; description?: string }[] = [], steps: any[] = [], error?: unknown) =>
  ({ title, annotations, steps, error }) as any;

describe('CoverageCollector', () => {
  it('records labelled top-level steps (labels on nested steps count for their parent) per attempt', () => {
    const c = new CoverageCollector();
    const labels = (feature: string, area: string) => [
      { type: 'Component', description: 'Permissions' },
      { type: 'Scenario', description: 'Owners' },
      { type: 'Feature', description: feature },
      { type: 'Area', description: area },
    ];
    c.onTestEnd({ id: 't1' } as any, {
      retry: 1,
      steps: [
        step('Before Hooks'),
        step('Archive board', labels('Boards', 'Archive'), [step('inner', labels('Boards', 'Archive'))], new Error('x')),
        step('Edit flow', [], [step('nested', labels('Boards', 'Edit'))]),
        step('Feature only', [{ type: 'Feature', description: 'Boards' }]),
      ],
    } as any);
    const dir = mkdtempSync(join(tmpdir(), 'cov-'));
    try {
      const file = c.write(join(dir, 'run1'), 'run1', { archived: true })!;
      const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(rows).toEqual([
        { run_id: 'run1', test_id: 't1', attempt: 1, idx: 1, title: 'Archive board', status: 'failed', component: 'Permissions', scenario: 'Owners', feature: 'Boards', area: 'Archive' },
        { run_id: 'run1', test_id: 't1', attempt: 1, idx: 2, title: 'Edit flow', status: 'passed', component: 'Permissions', scenario: 'Owners', feature: 'Boards', area: 'Edit' },
      ]);
      expect(existsSync(`${file}.gz`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes nothing when no step is labelled, and honours custom level names', () => {
    const c = new CoverageCollector({ levels: ['Module', 'Journey', 'Feature', 'Area'] });
    c.onTestEnd({ id: 't' } as any, { retry: 0, steps: [step('a', [{ type: 'Component', description: 'x' }])] } as any);
    expect(c.write('/nonexistent', 'r')).toBeNull();
    c.onTestEnd({ id: 't' } as any, { retry: 0, steps: [step('a', [{ type: 'Module', description: 'Tasks' }])] } as any);
    expect(c.size).toBe(1);
  });
});

describe('coverage() helper', () => {
  it('pushes one annotation per given level, and fails clearly on old Playwright', () => {
    const info = { annotations: [] as { type: string; description?: string }[] };
    coverage(info, { component: 'Permissions', feature: 'Boards', area: 'Archive' });
    expect(info.annotations).toEqual([
      { type: 'Component', description: 'Permissions' },
      { type: 'Feature', description: 'Boards' },
      { type: 'Area', description: 'Archive' },
    ]);
    expect(() => coverage({}, { component: 'x' })).toThrow(/1\.58/);
  });
});
