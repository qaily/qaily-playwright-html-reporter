import { describe, expect, it } from 'vitest';
import { TAU, arcShares, bucketRuns, dayArc, hourArc, runProgress, timeParts, waveFrom } from '../src/dial-math.ts';

describe('hourArc', () => {
  it('puts minute 0 at the back (+y) and runs clockwise', () => {
    expect(hourArc(0, 600_000).a0).toBeCloseTo(Math.PI / 2);
    expect(hourArc(15, 600_000).a0).toBeCloseTo(0);
  });
  it('makes length proportional to duration, between a minimum and 85% of the dial', () => {
    expect(hourArc(0, 30 * 60_000).len).toBeCloseTo(TAU / 2);
    expect(hourArc(0, 1000).len).toBe(0.24);
    expect(hourArc(0, 5 * 3_600_000).len).toBeCloseTo(TAU * 0.85);
  });
});

describe('dayArc', () => {
  it('puts midnight at the back and 06:00 a quarter turn clockwise', () => {
    expect(dayArc(0, 0, 0).a0).toBeCloseTo(Math.PI / 2);
    expect(dayArc(6, 0, 0).a0).toBeCloseTo(0);
    expect(dayArc(0, 0, 6 * 3_600_000).len).toBeCloseTo(TAU / 4);
    expect(dayArc(0, 0, 1000).len).toBe(0.07);
  });
});

describe('arcShares', () => {
  it('splits passed / failed / flaky over the total; the rest is skipped', () => {
    expect(arcShares({ total: 10, passed: 6, failed: 2, flaky: 1 })).toEqual({ p: 0.6, f: 0.2, k: 0.1 });
  });
});

describe('runProgress', () => {
  it('is elapsed over typical duration, clamped', () => {
    expect(runProgress(0, 300, 600)).toBe(0.5);
    expect(runProgress(0, 6000, 600)).toBe(0.97);
    expect(runProgress(0, 300, null)).toBe(0.5);
  });
});

describe('waveFrom', () => {
  it('draws 100% high and the low bound at the bottom', () => {
    const [hi, lo] = waveFrom([100, 50]);
    expect(hi).toBeCloseTo(0.08);
    expect(lo).toBeCloseTo(0.92);
    expect(waveFrom([null, 75])).toHaveLength(2);
  });
});

describe('bucketRuns', () => {
  const at = (iso: string) => ({ iso });
  it('buckets by hour and day in the chosen zone, newest first, with day indexes', () => {
    const { hours, days } = bucketRuns(
      [at('2026-10-13T23:30:00Z'), at('2026-10-14T00:30:00Z'), at('2026-10-14T00:10:00Z'), at('2026-10-14T10:00:00Z')],
      (t) => new Date(t.iso),
      true,
    );
    expect(days.map((d) => [d.key, d.items.length])).toEqual([
      ['2026-10-14', 3],
      ['2026-10-13', 1],
    ]);
    expect(hours.map((h) => [h.key, h.day, h.items.length])).toEqual([
      ['2026-10-14T10', 0, 1],
      ['2026-10-14T00', 0, 2],
      ['2026-10-13T23', 1, 1],
    ]);
  });
  it('formats keys with zero padding', () => {
    expect(timeParts(new Date('2026-02-03T05:00:00Z'), true).hourKey).toBe('2026-02-03T05');
  });
});
