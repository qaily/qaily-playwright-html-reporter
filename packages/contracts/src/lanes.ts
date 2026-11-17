// Lanes group runs for dashboards (e.g. "Web · Dev"). Matching is config, never parsed from folder names.

export interface LaneMatch {
  /** Regular expression source matched against the manifest category, e.g. "^ui:web". */
  category?: string;
  /** Exact environment, e.g. "sys". */
  environment?: string;
  /** Regular expression source matched against the git branch. */
  branch?: string;
  /** Time of day the run started, e.g. nightly runs: { from: '22:00', to: '06:00' }. */
  time?: LaneTimeWindow;
}

/**
 * A daily window on the run's start time. `from` is inclusive and `to` exclusive (both "HH:MM").
 * A window with `from` after `to` wraps past midnight. The time zone is part of the lane, not the
 * viewer's display setting, so every viewer puts a run in the same lane.
 */
export interface LaneTimeWindow {
  from: string;
  to: string;
  /** IANA time zone, e.g. "Europe/Vilnius". Default UTC. */
  zone?: string;
}

export interface Lane {
  id: string;
  label: string;
  match: LaneMatch;
}

interface LaneSubject {
  category: string | null;
  environment: string | null;
  branch: string | null;
  /** The run's start (ISO 8601). Needed only by lanes with a time window. */
  started_at?: string | null;
}

const clockFormats = new Map<string, Intl.DateTimeFormat>();

/** Minutes since midnight of an instant in a time zone. Throws for an unknown zone. */
export function minuteOfDay(iso: string, zone = 'UTC'): number {
  let fmt = clockFormats.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    clockFormats.set(zone, fmt);
  }
  const parts = fmt.formatToParts(new Date(iso));
  const num = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return num('hour') * 60 + num('minute');
}

/** "HH:MM" to minutes since midnight, or null when malformed. */
export function parseClock(text: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Whether a run that started at `startedAt` falls in the window. No window matches any run. */
export function timeMatches(window: LaneTimeWindow | undefined, startedAt: string | null | undefined): boolean {
  if (!window) return true;
  if (!startedAt) return false;
  const from = parseClock(window.from);
  const to = parseClock(window.to);
  if (from === null || to === null) return false;
  let m: number;
  try {
    m = minuteOfDay(startedAt, window.zone || 'UTC');
  } catch {
    return false;
  }
  if (from === to) return true;
  return from < to ? m >= from && m < to : m >= from || m < to;
}

function regexMatches(source: string | undefined, value: string | null): boolean {
  if (source === undefined || source === '') return true;
  if (value == null) return false;
  try {
    return new RegExp(source).test(value);
  } catch {
    return false;
  }
}

export function laneMatches(lane: Lane, run: LaneSubject): boolean {
  const m = lane.match;
  return (
    regexMatches(m.category, run.category) &&
    (m.environment === undefined || m.environment === '' || m.environment === run.environment) &&
    regexMatches(m.branch, run.branch) &&
    timeMatches(m.time, run.started_at)
  );
}

/** First matching lane wins, so order lanes from specific to general. */
export function laneOf(lanes: readonly Lane[], run: LaneSubject): Lane | null {
  return lanes.find((lane) => laneMatches(lane, run)) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Lane builder helpers: the settings editor shows simple conditions ("is", "starts with", …) and
// stores them as the same regex strings as above, so settings files keep their shape.

/** Builder modes for the category and branch conditions. */
export type MatchMode = 'any' | 'is' | 'oneOf' | 'startsWith' | 'endsWith' | 'contains' | 'regex';

export interface MatchSpec {
  mode: MatchMode;
  /** Plain values for every mode except `any` and `regex`. */
  values: string[];
  /** The stored regex source ('' for `any`). */
  source: string;
}

const SPECIAL = new Set([...'.*+?^${}()|[]\\/']);

export function escapeRegex(value: string): string {
  return [...value].map((c) => (SPECIAL.has(c) ? `\\${c}` : c)).join('');
}

/** The plain text a regex source stands for, or null when it uses any regex syntax. */
function literal(source: string): string | null {
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') {
      const next = source[i + 1];
      if (next === undefined || !SPECIAL.has(next)) return null;
      out += next;
      i++;
    } else if (SPECIAL.has(c)) return null;
    else out += c;
  }
  return out;
}

/** Splits "a|b\|c" on bare pipes. */
function alternatives(source: string): string[] {
  const parts: string[] = [];
  let cur = '';
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\\') {
      cur += source.slice(i, i + 2);
      i++;
    } else if (source[i] === '|') {
      parts.push(cur);
      cur = '';
    } else cur += source[i];
  }
  parts.push(cur);
  return parts;
}

/** Builds the regex source for a builder condition. Returns undefined for "any" (or no values yet). */
export function compileMatch(mode: MatchMode, values: readonly string[], raw = ''): string | undefined {
  const vals = values.map((v) => v.trim()).filter(Boolean);
  if (mode === 'any') return undefined;
  if (mode === 'regex') return raw.trim() || undefined;
  if (vals.length === 0) return undefined;
  const one = escapeRegex(vals[0]);
  switch (mode) {
    case 'is':
      return `^${one}$`;
    case 'oneOf':
      return vals.length === 1 ? `^${one}$` : `^(?:${[...new Set(vals)].map(escapeRegex).join('|')})$`;
    case 'startsWith':
      return `^${one}`;
    case 'endsWith':
      return `${one}$`;
    case 'contains':
      return one;
  }
}

/** Reads a stored regex back into the simplest builder condition that produces it. */
export function describeMatch(source: string | undefined): MatchSpec {
  const s = source ?? '';
  if (s === '') return { mode: 'any', values: [], source: '' };
  const spec = (mode: MatchMode, values: string[]): MatchSpec => ({ mode, values, source: s });
  if (s.startsWith('^') && s.endsWith('$')) {
    const inner = s.slice(1, -1);
    const is = literal(inner);
    if (is !== null && is !== '') return spec('is', [is]);
    if (inner.startsWith('(?:') && inner.endsWith(')')) {
      const vals = alternatives(inner.slice(3, -1)).map(literal);
      if (vals.every((v): v is string => v !== null && v !== '')) return spec('oneOf', vals);
    }
  }
  if (s.startsWith('^')) {
    const v = literal(s.slice(1));
    if (v) return spec('startsWith', [v]);
  }
  if (s.endsWith('$')) {
    const v = literal(s.slice(0, -1));
    if (v) return spec('endsWith', [v]);
  }
  const v = literal(s);
  if (v) return spec('contains', [v]);
  return spec('regex', []);
}

/** True when a regex source matches the value; an empty source means "any". Invalid regexes never match. */
export function patternMatches(source: string | undefined, value: string | null): boolean {
  return regexMatches(source, value);
}

export interface LaneValue {
  value: string;
  runs: number;
  lastSeen: string;
}

export interface LaneValues {
  category: LaneValue[];
  environment: LaneValue[];
  branch: LaneValue[];
  /** Runs looked at. */
  total: number;
  /** Runs with no category set in the reporter options. */
  withoutCategory: number;
}

type RunLike = LaneSubject & { started_at: string };

/** Distinct category / environment / branch values seen in runs, most used first. */
export function discoverLaneValues(runs: readonly RunLike[]): LaneValues {
  const tally = (key: keyof LaneSubject): LaneValue[] => {
    const map = new Map<string, LaneValue>();
    for (const r of runs) {
      const v = r[key];
      if (v == null || v === '') continue;
      const cur = map.get(v);
      if (cur) {
        cur.runs++;
        if (r.started_at > cur.lastSeen) cur.lastSeen = r.started_at;
      } else map.set(v, { value: v, runs: 1, lastSeen: r.started_at });
    }
    return [...map.values()].sort((a, b) => b.runs - a.runs || a.value.localeCompare(b.value));
  };
  return {
    category: tally('category'),
    environment: tally('environment'),
    branch: tally('branch'),
    total: runs.length,
    withoutCategory: runs.filter((r) => !r.category).length,
  };
}

export interface LaneGroup {
  category: string | null;
  environment: string | null;
  runs: number;
}

export interface LaneReport {
  /** Runs that land in this lane (first match wins). */
  runs: number;
  /** Runs this lane's conditions match, including ones an earlier lane takes. */
  matches: number;
  /** Earlier lanes (by index) that take runs this lane also matches. */
  takenBy: { index: number; runs: number }[];
  /** What the lane's runs are, by category and environment, most first. */
  groups: LaneGroup[];
}

export interface LaneCoverage {
  lanes: LaneReport[];
  /** Runs no lane matches, by category and environment. */
  unmatched: (LaneGroup & { branches: string[] })[];
}

function groupKey(r: LaneSubject): string {
  return JSON.stringify([r.category, r.environment]);
}

/** How the runs spread over the lanes. Lanes are addressed by index, since ids may clash while editing. */
export function laneCoverage(lanes: readonly Lane[], runs: readonly LaneSubject[]): LaneCoverage {
  const reports: LaneReport[] = lanes.map(() => ({ runs: 0, matches: 0, takenBy: [], groups: [] }));
  const groups = lanes.map(() => new Map<string, LaneGroup>());
  const taken = lanes.map(() => new Map<number, number>());
  const unmatched = new Map<string, LaneGroup & { branches: string[] }>();
  for (const r of runs) {
    let winner = -1;
    lanes.forEach((lane, i) => {
      if (!laneMatches(lane, r)) return;
      reports[i].matches++;
      if (winner === -1) {
        winner = i;
        reports[i].runs++;
        const k = groupKey(r);
        const g = groups[i].get(k) ?? { category: r.category, environment: r.environment, runs: 0 };
        g.runs++;
        groups[i].set(k, g);
      } else taken[i].set(winner, (taken[i].get(winner) ?? 0) + 1);
    });
    if (winner === -1) {
      const k = groupKey(r);
      const g = unmatched.get(k) ?? { category: r.category, environment: r.environment, runs: 0, branches: [] };
      g.runs++;
      if (r.branch && !g.branches.includes(r.branch)) g.branches.push(r.branch);
      unmatched.set(k, g);
    }
  }
  const byRuns = <T extends { runs: number }>(a: T, b: T) => b.runs - a.runs;
  reports.forEach((rep, i) => {
    rep.groups = [...groups[i].values()].sort(byRuns);
    rep.takenBy = [...taken[i]].map(([index, n]) => ({ index, runs: n })).sort(byRuns);
  });
  return { lanes: reports, unmatched: [...unmatched.values()].sort(byRuns) };
}

/** A lane with no conditions catches every run. */
export function isCatchAll(lane: Lane): boolean {
  return !lane.match.category && !lane.match.environment && !lane.match.branch && !lane.match.time;
}

/** How many runs started in each hour of the day (0–23) in a time zone. */
export function startHours(runs: readonly { started_at: string }[], zone = 'UTC'): number[] {
  const hours = new Array<number>(24).fill(0);
  for (const r of runs) {
    try {
      hours[Math.floor(minuteOfDay(r.started_at, zone) / 60)]++;
    } catch {
      return hours;
    }
  }
  return hours;
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'lane'
  );
}

/** `base`, or `base-2`, `base-3`, … whichever is not taken yet. */
export function uniqueId(base: string, taken: Iterable<string>): string {
  const ids = new Set(taken);
  if (!ids.has(base)) return base;
  let n = 2;
  while (ids.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** A lane for one category (and optionally one environment), labelled after them. */
export function laneFor(category: string | null, environment: string | null, taken: Iterable<string>): Lane {
  const label = [category, environment].filter(Boolean).join(' · ') || 'No category';
  const match: LaneMatch = {};
  const cat = category ? compileMatch('is', [category]) : undefined;
  if (cat) match.category = cat;
  if (environment) match.environment = environment;
  return { id: uniqueId(slugify(label), taken), label, match };
}

/** Starter lanes from the runs: one per category (or per category and environment), then a catch-all. */
export function suggestLanes(runs: readonly LaneSubject[], byEnvironment: boolean): Lane[] {
  const seen = new Map<string, LaneSubject>();
  for (const r of runs) {
    if (!r.category && !(byEnvironment && r.environment)) continue;
    const env = byEnvironment ? r.environment : null;
    const key = JSON.stringify([r.category, env]);
    if (!seen.has(key)) seen.set(key, { category: r.category, environment: env, branch: null });
  }
  const combos = [...seen.values()].sort(
    (a, b) => (a.category ?? '').localeCompare(b.category ?? '') || (a.environment ?? '').localeCompare(b.environment ?? ''),
  );
  const lanes: Lane[] = [];
  for (const c of combos) lanes.push(laneFor(c.category, c.environment, lanes.map((l) => l.id)));
  lanes.push({ id: uniqueId('other', lanes.map((l) => l.id)), label: 'Other', match: {} });
  return lanes;
}
