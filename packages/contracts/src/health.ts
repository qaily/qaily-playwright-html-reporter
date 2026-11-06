// Health bands: an ordered list evaluated top-down; the first band whose bounds match wins.

export type HealthLevel = 'good' | 'warn' | 'bad';

export interface Band {
  level: HealthLevel;
  /** Inclusive lower bound. Omit for "no lower bound". */
  min?: number;
  /** Inclusive upper bound. Omit for "no upper bound". */
  max?: number;
}

export function healthLevel(bands: readonly Band[], value: number | null | undefined): HealthLevel | 'none' {
  if (value == null || Number.isNaN(value)) return 'none';
  for (const band of bands) {
    if ((band.min === undefined || value >= band.min) && (band.max === undefined || value <= band.max)) {
      return band.level;
    }
  }
  return 'none';
}

export interface RunCounts {
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
}

export interface PassRateOptions {
  flakyCountsAsPassed: boolean;
  excludeSkipped: boolean;
}

/** Pass rate in percent (0–100), or null when nothing was executed. */
export function passRate(c: RunCounts, opts: PassRateOptions): number | null {
  const denominator = opts.excludeSkipped ? c.total - c.skipped : c.total;
  if (denominator <= 0) return null;
  const ok = c.passed + (opts.flakyCountsAsPassed ? c.flaky : 0);
  return (ok / denominator) * 100;
}
