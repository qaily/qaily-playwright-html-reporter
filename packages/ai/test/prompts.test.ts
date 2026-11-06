import { describe, expect, it } from 'vitest';
import { buildTestContext, mapPaths, packSections } from '../src/prompts.ts';

describe('mapPaths', () => {
  it('rewrites CI prefixes, longest first', () => {
    const map = [
      { from: '/runner/_work/', to: '/x/' },
      { from: '/runner/_work/REPO/REPO/', to: '/Users/me/repo/' },
    ];
    expect(mapPaths('at /runner/_work/REPO/REPO/pages/a.ts:3', map)).toBe('at /Users/me/repo/pages/a.ts:3');
  });
});

describe('packSections', () => {
  it('keeps important sections whole and trims the least important first', () => {
    const out = packSections(
      [
        { title: 'Error', body: 'E'.repeat(500), priority: 0, min: 500 },
        { title: 'Log', body: 'L'.repeat(5000), priority: 5, min: 100, keep: 'tail' },
      ],
      1500,
    );
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out).toContain('E'.repeat(500));
    expect(out).toContain('earlier characters');
  });
});

describe('buildTestContext', () => {
  it('includes the error, marks the failed step, strips ANSI and maps paths', () => {
    const ctx = buildTestContext({
      run: null,
      summary: { run_id: 'r', test_id: 't', started_at: '', title: 'Archive board', status: 'failed', tags: ['regression'], dur_ms: 1000,
        project: 'chromium', file: '/runner/_work/R/R/tests/board.spec.ts', err_summary: null, err_type: 'timeout', failed_step: null },
      attempts: [{
        detail: { run_id: 'r', test_id: 't', started_at: '', attempt: 0, worker_idx: 0, parallel_idx: 0, status: 'failed', dur_ms: 1000,
          step_cnt: 2, failed_step_idx: 1, full_title: 'x', line_num: 7,
          steps: [{ idx: 0, title: 'Given login', dur_ms: 5, status: 'passed' }, { idx: 1, title: 'When I archive', dur_ms: 9, status: 'failed' }] },
        errors: [{ run_id: 'r', test_id: 't', attempt: 0, err_msg: '\u001b[31mTimeout 5000ms\u001b[39m', err_type: 'timeout', stack: null,
          err_file: '/runner/_work/R/R/pages/board.ts', err_line: 12, err_col: 1, snippet: null, failed_step: 'When I archive', locator: null }],
      }],
      history: [{ started_at: 1, status: 'passed', branch: 'main' }, { started_at: 2, status: 'failed', branch: 'main' }],
      pathMap: [{ from: '/runner/_work/R/R/', to: '/repo/' }],
      capBytes: 30_000,
    });
    expect(ctx).toContain('Timeout 5000ms');
    expect(ctx).not.toContain('\u001b');
    expect(ctx).toContain('>> 1. [failed] When I archive');
    expect(ctx).toContain('File: /repo/tests/board.spec.ts:7');
    expect(ctx).toContain('At: /repo/pages/board.ts:12');
    expect(ctx).toContain('PF\nPassed 1 of 2');
  });
});
