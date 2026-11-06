import { describe, expect, it } from 'vitest';
import { nothing } from 'lit';
import { suiteBadge, suiteColor } from '../src/status.ts';

describe('suite badges', () => {
  it('give the same suite the same colour, never a pass/fail series colour', () => {
    expect(suiteColor('@regression')).toBe(suiteColor('@regression'));
    const used = ['@regression', '@smoke', '@nightly', '@visual', '@batch', '@verify'].map(suiteColor);
    expect(used.some((c) => /series-[34],/.test(c))).toBe(false);
    expect(new Set(used).size).toBeGreaterThan(1);
  });

  it('render nothing without a tag', () => {
    expect(suiteBadge(null)).toBe(nothing);
    expect(suiteBadge('')).toBe(nothing);
  });
});
