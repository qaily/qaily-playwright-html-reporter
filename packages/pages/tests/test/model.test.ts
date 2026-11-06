import { describe, expect, it } from 'vitest';
import { commonDirPrefix, groupsFromFullTitle } from '../src/model.ts';

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
