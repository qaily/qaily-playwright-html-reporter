// Formatting helpers shared by pages.

import type { Settings } from '@qaily/contracts';

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '–';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '–';
  return `${value === 100 ? '100' : value.toFixed(digits)}%`;
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat().format(n);
}

function zone(settings: Settings): string | undefined {
  return settings.display.timeZone === 'UTC' ? 'UTC' : undefined;
}

export function formatTime(iso: string | Date, settings: Settings): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone: zone(settings) });
}

export function formatDate(iso: string | Date, settings: Settings, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }): string {
  return new Date(iso).toLocaleDateString(undefined, { ...opts, timeZone: zone(settings) });
}

export function formatDateTime(iso: string | Date, settings: Settings): string {
  return `${formatDate(iso, settings)} ${formatTime(iso, settings)}`;
}

export function formatRelative(iso: string | Date, now: Date): string {
  const diff = (now.getTime() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)} h ago`;
  return `${Math.floor(diff / 86_400)} d ago`;
}

/** Calendar parts of a date in the configured time zone (local or UTC). */
export function dayParts(d: Date, settings: Settings): { y: number; m: number; d: number; weekday: number } {
  if (settings.display.timeZone === 'UTC') {
    return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), weekday: d.getUTCDay() };
  }
  return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), weekday: d.getDay() };
}

/** YYYY-MM-DD in the configured time zone. */
export function dayKey(d: Date | string, settings: Settings): string {
  const p = dayParts(new Date(d), settings);
  return `${p.y}-${String(p.m + 1).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

function fromParts(y: number, m: number, d: number, settings: Settings): Date {
  return settings.display.timeZone === 'UTC' ? new Date(Date.UTC(y, m, d)) : new Date(y, m, d);
}

export function startOfDay(d: Date, settings: Settings): Date {
  const p = dayParts(d, settings);
  return fromParts(p.y, p.m, p.d, settings);
}

/** Calendar-day arithmetic (DST-safe in local time). */
export function addDays(d: Date, days: number, settings: Settings): Date {
  const p = dayParts(d, settings);
  return fromParts(p.y, p.m, p.d + days, settings);
}

export function startOfWeek(d: Date, settings: Settings): Date {
  const day = startOfDay(d, settings);
  const diff = (dayParts(day, settings).weekday - settings.display.weekStartsOn + 7) % 7;
  return addDays(day, -diff, settings);
}
