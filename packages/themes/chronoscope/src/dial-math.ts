// Pure helpers for the Chronoscope view (no three.js, no DOM), so they can be unit-tested.

export const TAU = Math.PI * 2;

export interface TimeParts {
  dayKey: string;
  hourKey: string;
  h: number;
  min: number;
  dom: number;
  /** 0 = Sunday. */
  dow: number;
  month: number;
  year: number;
}

export function timeParts(d: Date, utc: boolean): TimeParts {
  const year = utc ? d.getUTCFullYear() : d.getFullYear();
  const month = utc ? d.getUTCMonth() : d.getMonth();
  const dom = utc ? d.getUTCDate() : d.getDate();
  const h = utc ? d.getUTCHours() : d.getHours();
  const min = utc ? d.getUTCMinutes() : d.getMinutes();
  const dow = utc ? d.getUTCDay() : d.getDay();
  const dayKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(dom).padStart(2, '0')}`;
  return { dayKey, hourKey: `${dayKey}T${String(h).padStart(2, '0')}`, h, min, dom, dow, month, year };
}

/**
 * Arc on a 60-minute dial (Hourly view): starts at its start minute, minute 0 at +y (the back of the tilted
 * dial), running clockwise (decreasing angle). Length is the duration, kept between a visible minimum and 85%.
 */
export function hourArc(min: number, durMs: number | null): { a0: number; len: number } {
  const a0 = Math.PI / 2 - (min / 60) * TAU;
  const len = Math.max(0.24, Math.min(TAU * 0.85, ((durMs ?? 0) / 3_600_000) * TAU));
  return { a0, len };
}

/** Arc on a 24-hour dial (Daily view): midnight at +y, clockwise. */
export function dayArc(h: number, min: number, durMs: number | null): { a0: number; len: number } {
  const a0 = Math.PI / 2 - ((h + min / 60) / 24) * TAU;
  const len = Math.min(TAU, Math.max(0.07, ((durMs ?? 0) / 86_400_000) * TAU));
  return { a0, len };
}

/** Shares of the arc's colour split (shader uniforms uP / uF / uK; the rest is skipped). `passed` excludes flaky. */
export function arcShares(c: { total: number; passed: number; failed: number; flaky: number }): { p: number; f: number; k: number } {
  const t = c.total || 1;
  return { p: c.passed / t, f: c.failed / t, k: c.flaky / t };
}

/** How far along a running run probably is: elapsed time over the lane's typical duration. */
export function runProgress(startedMs: number, nowMs: number, typicalMs: number | null): number {
  if (!typicalMs || typicalMs <= 0) return 0.5;
  return Math.max(0.02, Math.min(0.97, (nowMs - startedMs) / typicalMs));
}

/**
 * The card's wave: the lane's pass rate over its runs up to this one, as y fractions (0 = top, so a high pass
 * rate draws high). Rates at or below `lo` touch the bottom; a single point is drawn flat.
 */
export function waveFrom(rates: Array<number | null>, lo = 50): number[] {
  const v = rates.filter((r): r is number => r != null).map((r) => 0.08 + 0.84 * (1 - (Math.max(lo, Math.min(100, r)) - lo) / (100 - lo)));
  if (!v.length) return [0.5, 0.5];
  return v.length === 1 ? [v[0], v[0]] : v;
}

export interface Bucket<T> {
  key: string;
  /** Index of the bucket's calendar day, 0 = newest day. */
  day: number;
  parts: TimeParts;
  items: T[];
}

/**
 * Runs bucketed by hour and by day (in the chosen time zone), newest first. Only buckets with runs exist.
 */
export function bucketRuns<T>(items: T[], startOf: (t: T) => Date, utc: boolean): { hours: Bucket<T>[]; days: Bucket<T>[] } {
  const sorted = [...items].sort((a, b) => startOf(b).getTime() - startOf(a).getTime());
  const hours: Bucket<T>[] = [];
  const days: Bucket<T>[] = [];
  for (const t of sorted) {
    const parts = timeParts(startOf(t), utc);
    let day = days[days.length - 1];
    if (!day || day.key !== parts.dayKey) {
      day = { key: parts.dayKey, day: days.length, parts, items: [] };
      days.push(day);
    }
    day.items.push(t);
    let hour = hours[hours.length - 1];
    if (!hour || hour.key !== parts.hourKey) {
      hour = { key: parts.hourKey, day: day.day, parts, items: [] };
      hours.push(hour);
    }
    hour.items.push(t);
  }
  return { hours, days };
}
