// Pure maths for the Chronoscope chart and the timeline cards (ported from the Observatory design,
// renderChrono / buildCarousel), so they can be unit-tested. Rates are fractions (0.97 = 97%).

import type { HealthLevel } from '@qaily/contracts';

/** The original design's hues per health band (hueFor); the bands themselves come from the Settings thresholds. */
export const LEVEL_HUE: Record<HealthLevel | 'none', number> = { good: 158, warn: 38, bad: 345, none: 192 };
export const LEVEL_LABEL: Record<HealthLevel | 'none', string> = { good: 'Stable', warn: 'Degraded', bad: 'Incident', none: 'No data' };

/**
 * Lowest y-axis value: 5% steps below the worst run. The original design never went under 50%, but real runs do,
 * and their dots would land in the bar band, so the floor is 0.
 */
export function chronoY0(rates: readonly number[]): number {
  const mn = rates.reduce((m, r) => Math.min(m, r), 1);
  return Math.max(0, Math.floor((mn - 0.02) * 20) / 20);
}

/** Grid step: 5% as in the original design, 10% once the axis spans more than half the scale. */
export function gridStep(y0: number): number {
  return 1 - y0 > 0.5 ? 0.1 : 0.05;
}

export interface ChronoFrame {
  W: number;
  H: number;
  narrow: boolean;
  m: { l: number; r: number; t: number };
  iw: number;
  ih: number;
  y0: number;
  X(d: number): number;
  Y(r: number): number;
  /** Top of the failed/flaky bar band and its height. */
  bTop: number;
  bH: number;
}

export function chronoFrame(W: number, nDays: number, rates: readonly number[]): ChronoFrame {
  const narrow = W < 600;
  const H = narrow ? 250 : 300;
  const m = { l: 40, r: 10, t: 12 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - 96;
  const y0 = chronoY0(rates);
  return {
    W, H, narrow, m, iw, ih, y0,
    X: (d) => m.l + (d / nDays) * iw,
    Y: (r) => m.t + (1 - (r - y0) / (1 - y0)) * ih,
    bTop: m.t + ih + 14,
    bH: 40,
  };
}

/** The smooth daily line: horizontal-tangent cubic segments between points, as in the original design. */
export function smoothPath(pts: readonly [number, number][]): string {
  let path = '';
  pts.forEach((p, i) => {
    if (!i) path = `M${p[0]},${p[1]}`;
    else {
      const q = pts[i - 1];
      const cx = (q[0] + p[0]) / 2;
      path += ` C${cx},${q[1]} ${cx},${p[1]} ${p[0]},${p[1]}`;
    }
  });
  return path;
}

/** Stacked bar heights per day (failed below, flaky on top), scaled to the busiest day. */
export function barHeights(days: readonly { failed: number; flaky: number }[], bH: number): { hf: number; hl: number }[] {
  const maxF = days.reduce((m, d) => Math.max(m, d.failed + d.flaky), 1);
  return days.map((d) => ({ hf: (d.failed / maxF) * bH, hl: (d.flaky / maxF) * bH }));
}

/** Card bar height in %, from a pass rate in % (original design: max(6, (pass - .75) / .25 * 100)). */
export function cardBarHeight(ratePct: number | null): number {
  return Math.max(6, (((ratePct ?? 0) / 100 - 0.75) / 0.25) * 100);
}

/** Carousel geometry: how card i sits on the cylinder when the carousel is at position pos. */
export function carouselCard(i: number, pos: number, cardW: number, perspective = 900) {
  const radius = perspective * 1.18;
  const th = (i - pos) * ((cardW + 26) / radius);
  const a = Math.abs(th);
  return {
    visible: a <= 1.15,
    transform: `translate(-50%, -50%) translateZ(${perspective}px) rotateY(${-th}rad) translateZ(${-radius}px)`,
    opacity: Math.max(0, 1 - Math.pow(a / 1.15, 3)),
    zIndex: 100 - Math.round(Math.abs(i - pos) * 2),
  };
}

/** Where a flick lands: momentum carries the carousel on in the direction of travel. */
export function flickTarget(pos: number, velocityPxPerMs: number, cardW: number, count: number): number {
  return Math.max(0, Math.min(count - 1, Math.round(pos - (velocityPxPerMs * 260) / cardW)));
}
