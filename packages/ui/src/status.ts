import type { AttemptStatus, TestStatus } from '@qaily/contracts';
import { html, nothing, styleMap } from './lit.ts';

export type AnyStatus = TestStatus | AttemptStatus | 'running';

export const STATUS_GLYPH: Record<AnyStatus, string> = {
  passed: '✓',
  failed: '✕',
  flaky: '↻',
  skipped: '–',
  running: '◌',
  timedOut: '⏱',
  interrupted: '⏸',
};

/** CSS colour token for a status. */
export const STATUS_COLOR: Record<AnyStatus, string> = {
  passed: 'var(--q-pass)',
  failed: 'var(--q-fail)',
  flaky: 'var(--q-flaky)',
  skipped: 'var(--q-skip)',
  running: 'var(--q-running)',
  timedOut: 'var(--q-fail)',
  interrupted: 'var(--q-skip)',
};

// Suite badges: the run's manifest tag (@regression, @smoke, …), so it is clear which suite produced a result.
// Series colours, skipping the ones themes use for pass/fail (3, 4).
const SUITE_SERIES = [1, 2, 5, 7, 8, 6];
const SUITE_FALLBACK: Record<number, string> = { 1: '#4e79a7', 2: '#f28e2b', 5: '#76b7b2', 6: '#edc948', 7: '#b07aa1', 8: '#ff9da7' };

/** A stable colour per suite name (same tag, same colour, on every page and theme). */
export function suiteColor(tag: string): string {
  let h = 0;
  for (const ch of tag) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  const n = SUITE_SERIES[Math.abs(h) % SUITE_SERIES.length];
  return `var(--q-series-${n}, ${SUITE_FALLBACK[n]})`;
}

/** Small pill with the suite tag; nothing when there is no tag. Styled inline so it works in any shadow root. */
export function suiteBadge(tag: string | null | undefined) {
  if (!tag) return nothing;
  const c = suiteColor(tag);
  return html`<span class="suite" title="Suite: ${tag}" style=${styleMap({
    display: 'inline-block',
    font: '600 0.72em/1.5 var(--q-font-mono, ui-monospace, monospace)',
    padding: '0 6px',
    borderRadius: '999px',
    color: c,
    border: `1px solid color-mix(in srgb, ${c} 55%, transparent)`,
    // Opaque, so it stays readable on status-coloured cards.
    background: `color-mix(in srgb, ${c} 14%, var(--q-surface, #fff))`,
    whiteSpace: 'nowrap',
    verticalAlign: 'middle',
  })}>${tag}</span>`;
}

/** One badge per suite. */
export function suiteBadges(tags: readonly string[] | null | undefined) {
  return (tags ?? []).map((t, i) => html`${i ? ' ' : ''}${suiteBadge(t)}`);
}
