import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  compileMatch,
  describeMatch,
  discoverLaneValues,
  isCatchAll,
  laneCoverage,
  laneFor,
  laneOf,
  patternMatches,
  startHours,
  suggestLanes,
  timeMatches,
  type Lane,
  type MatchMode,
} from '../src/index.ts';

const run = (category: string | null, environment: string | null, branch: string | null = 'main', started_at = '2026-11-01T00:00:00Z') => ({
  category,
  environment,
  branch,
  started_at,
});

describe('compileMatch / describeMatch', () => {
  const cases: [MatchMode, string[], string][] = [
    ['is', ['ui:web'], '^ui:web$'],
    ['is', ['ui:web.v2'], '^ui:web\\.v2$'],
    ['oneOf', ['ui:web', 'ui:admin'], '^(?:ui:web|ui:admin)$'],
    ['oneOf', ['a|b', 'c'], '^(?:a\\|b|c)$'],
    ['startsWith', ['release/'], '^release\\/'],
    ['endsWith', ['batch'], 'batch$'],
    ['contains', ['nightly'], 'nightly'],
  ];
  for (const [mode, values, source] of cases) {
    it(`${mode} ${values.join(',')} round-trips`, () => {
      expect(compileMatch(mode, values)).toBe(source);
      expect(describeMatch(source)).toEqual({ mode, values, source });
      for (const v of values) if (mode !== 'contains') expect(patternMatches(source, v)).toBe(true);
    });
  }

  it('treats escaped characters as plain text', () => {
    expect(patternMatches(compileMatch('is', ['ui:web.v2']), 'ui:webXv2')).toBe(false);
    expect(describeMatch('^a\\$')).toEqual({ mode: 'startsWith', values: ['a$'], source: '^a\\$' });
  });

  it('is empty for "any" and for modes with no value yet', () => {
    expect(compileMatch('any', ['x'])).toBeUndefined();
    expect(compileMatch('is', [])).toBeUndefined();
    expect(compileMatch('regex', [], '  ')).toBeUndefined();
    expect(describeMatch(undefined).mode).toBe('any');
    expect(describeMatch('').mode).toBe('any');
  });

  it('falls back to regex mode for real regex syntax', () => {
    for (const s of ['^ui:(web|admin)$', 'a.*b', '^feat-\\d+', '(']) expect(describeMatch(s).mode).toBe('regex');
  });

  it('reads every default lane as a builder condition', () => {
    for (const l of DEFAULT_SETTINGS.lanes) expect(describeMatch(l.match.category).mode).not.toBe('regex');
  });
});

describe('discoverLaneValues', () => {
  it('counts distinct values, most used first, and runs without category', () => {
    const v = discoverLaneValues([
      run('ui:web', 'dev', 'main', '2026-11-01T00:00:00Z'),
      run('ui:web', 'staging', 'main', '2026-11-03T00:00:00Z'),
      run('api', 'dev', 'feat-x'),
      run(null, null, null),
    ]);
    expect(v.category).toEqual([
      { value: 'ui:web', runs: 2, lastSeen: '2026-11-03T00:00:00Z' },
      { value: 'api', runs: 1, lastSeen: '2026-11-01T00:00:00Z' },
    ]);
    expect(v.environment.map((e) => e.value)).toEqual(['dev', 'staging']);
    expect(v.branch.map((e) => e.value)).toEqual(['main', 'feat-x']);
    expect(v.total).toBe(4);
    expect(v.withoutCategory).toBe(1);
  });
});

describe('laneCoverage', () => {
  const lanes: Lane[] = [
    { id: 'web-dev', label: 'Web · Dev', match: { category: '^ui:web$', environment: 'dev' } },
    { id: 'web', label: 'Web', match: { category: '^ui:web$' } },
    { id: 'admin', label: 'Admin', match: { category: '^ui:admin$' } },
  ];
  const runs = [run('ui:web', 'dev'), run('ui:web', 'dev'), run('ui:web', 'staging'), run('api', 'dev', 'a'), run('api', 'dev', 'b')];

  it('counts runs per lane, first match wins', () => {
    const c = laneCoverage(lanes, runs);
    expect(c.lanes.map((l) => l.runs)).toEqual([2, 1, 0]);
    expect(c.lanes[1].matches).toBe(3);
    expect(c.lanes[1].takenBy).toEqual([{ index: 0, runs: 2 }]);
    expect(c.lanes[1].groups).toEqual([{ category: 'ui:web', environment: 'staging', runs: 1 }]);
  });

  it('lists runs no lane catches', () => {
    expect(laneCoverage(lanes, runs).unmatched).toEqual([{ category: 'api', environment: 'dev', runs: 2, branches: ['a', 'b'] }]);
  });
});

describe('time windows', () => {
  const at = (iso: string) => ({ category: 'ui:web', environment: 'dev', branch: 'main', started_at: iso });
  const nightly: Lane = { id: 'nightly', label: 'Nightly', match: { category: '^ui:web$', time: { from: '22:00', to: '06:00', zone: 'UTC' } } };

  it('wraps past midnight, from inclusive and to exclusive', () => {
    expect(timeMatches(nightly.match.time, '2026-11-01T22:00:00Z')).toBe(true);
    expect(timeMatches(nightly.match.time, '2026-11-01T02:30:00Z')).toBe(true);
    expect(timeMatches(nightly.match.time, '2026-11-01T06:00:00Z')).toBe(false);
    expect(timeMatches(nightly.match.time, '2026-11-01T12:00:00Z')).toBe(false);
  });

  it('handles a same-day window', () => {
    const w = { from: '09:00', to: '17:30' };
    expect(timeMatches(w, '2026-11-01T17:29:00Z')).toBe(true);
    expect(timeMatches(w, '2026-11-01T17:30:00Z')).toBe(false);
  });

  it('uses the lane time zone, not the viewer', () => {
    const w = { from: '00:00', to: '06:00', zone: 'Europe/Vilnius' }; // UTC+2 in November
    expect(timeMatches(w, '2026-11-01T23:00:00Z')).toBe(true); // 01:00 in Vilnius
    expect(timeMatches(w, '2026-11-01T05:00:00Z')).toBe(false); // 07:00 in Vilnius
  });

  it('never matches without a start time or with a bad zone', () => {
    expect(timeMatches(nightly.match.time, null)).toBe(false);
    expect(timeMatches({ from: '22:00', to: '06:00', zone: 'Mars/Base' }, '2026-11-01T23:00:00Z')).toBe(false);
    expect(timeMatches(undefined, null)).toBe(true);
  });

  it('puts nightly runs in a nightly lane above the general one', () => {
    const lanes: Lane[] = [nightly, { id: 'web', label: 'Web', match: { category: '^ui:web$' } }];
    expect(laneOf(lanes, at('2026-11-01T23:10:00Z'))?.id).toBe('nightly');
    expect(laneOf(lanes, at('2026-11-01T10:10:00Z'))?.id).toBe('web');
    expect(isCatchAll({ id: 'x', label: 'X', match: { time: { from: '22:00', to: '06:00' } } })).toBe(false);
  });

  it('counts runs by start hour', () => {
    const h = startHours([at('2026-11-01T02:10:00Z'), at('2026-11-02T02:50:00Z'), at('2026-11-01T23:00:00Z')]);
    expect(h[2]).toBe(2);
    expect(h[23]).toBe(1);
    expect(h.reduce((a, b) => a + b, 0)).toBe(3);
  });
});

describe('suggestLanes / laneFor', () => {
  const runs = [run('ui:web', 'dev'), run('ui:web', 'staging'), run('api', 'dev'), run(null, 'dev')];

  it('makes one lane per category, then a catch-all', () => {
    expect(suggestLanes(runs, false)).toEqual([
      { id: 'api', label: 'api', match: { category: '^api$' } },
      { id: 'ui-web', label: 'ui:web', match: { category: '^ui:web$' } },
      { id: 'other', label: 'Other', match: {} },
    ]);
  });

  it('splits by environment when asked', () => {
    expect(suggestLanes(runs, true).map((l) => l.label)).toEqual(['dev', 'api · dev', 'ui:web · dev', 'ui:web · staging', 'Other']);
  });

  it('keeps ids unique', () => {
    expect(laneFor('ui:web', null, ['ui-web']).id).toBe('ui-web-2');
  });
});
