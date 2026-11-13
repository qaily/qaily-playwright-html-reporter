import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_FIELDS, getPath, isBucketConnectionPath, resolveSettings, setPath } from '../src/index.ts';

describe('settings fields', () => {
  it('every default value passes its own schema', () => {
    for (const f of SETTINGS_FIELDS) {
      const result = f.schema.safeParse(getPath(DEFAULT_SETTINGS, f.path));
      expect(result.success, f.path).toBe(true);
    }
  });

  it('cover every leaf group of the defaults', () => {
    const paths = SETTINGS_FIELDS.map((f) => f.path);
    const covered = (p: string) => paths.some((f) => f === p || p.startsWith(`${f}.`) || f.startsWith(`${p}.`));
    const walk = (obj: object, prefix: string): string[] =>
      Object.entries(obj).flatMap(([k, v]) => {
        const p = prefix ? `${prefix}.${k}` : k;
        return v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length ? walk(v, p) : [p];
      });
    for (const leaf of walk(DEFAULT_SETTINGS, '').filter((p) => p !== 'version')) expect(covered(leaf), leaf).toBe(true);
  });
});

describe('resolveSettings', () => {
  it('merges default < team < personal and reports sources', () => {
    const team = { thresholds: { passRate: [{ level: 'good' as const, min: 95 }, { level: 'bad' as const }] }, display: { defaultRangeDays: 30 } };
    const personal = { display: { defaultRangeDays: 7 } };
    const r = resolveSettings(DEFAULT_SETTINGS, team, personal);
    expect(r.settings.thresholds.passRate[0].min).toBe(95);
    expect(r.settings.display.defaultRangeDays).toBe(7);
    expect(r.sources['thresholds.passRate']).toBe('team');
    expect(r.sources['display.defaultRangeDays']).toBe('personal');
    expect(r.sources['display.historyChips']).toBe('default');
    expect(r.warnings).toEqual([]);
  });

  it('drops invalid values and values in a layer the scope does not allow', () => {
    const r = resolveSettings(
      DEFAULT_SETTINGS,
      { display: { colorScheme: 'dark' } }, // personal-only
      { lanes: [], display: { defaultRangeDays: -3 } }, // team-only, invalid
    );
    expect(r.settings.display.colorScheme).toBe('auto');
    expect(r.settings.lanes).toEqual(DEFAULT_SETTINGS.lanes);
    expect(r.settings.display.defaultRangeDays).toBe(DEFAULT_SETTINGS.display.defaultRangeDays);
    expect(r.warnings).toHaveLength(3);
  });

  it('survives garbage layers', () => {
    const r = resolveSettings(DEFAULT_SETTINGS, 'nope' as never, null);
    expect(r.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('does not mutate the defaults', () => {
    const before = structuredClone(DEFAULT_SETTINGS);
    resolveSettings(DEFAULT_SETTINGS, { display: { historyChips: 9 } }, null);
    expect(DEFAULT_SETTINGS).toEqual(before);
  });
});

describe('setPath', () => {
  it('sets and removes nested keys immutably, pruning empty objects', () => {
    const a = setPath({}, 'display.views', { monitoring: 'x' });
    expect(a).toEqual({ display: { views: { monitoring: 'x' } } });
    expect(setPath(a, 'display.views', undefined)).toEqual({});
  });
});

describe('bucket team settings', () => {
  it('leaves out only the bucket connection', () => {
    expect(isBucketConnectionPath('connections.s3.bucket')).toBe(true);
    expect(isBucketConnectionPath('connections.s3.dataPrefix')).toBe(true);
    expect(isBucketConnectionPath('connections.s3')).toBe(true);
    expect(isBucketConnectionPath('connections.github.owner')).toBe(false);
    expect(isBucketConnectionPath('connections.s3x')).toBe(false);
    expect(isBucketConnectionPath('lanes')).toBe(false);
  });
});
