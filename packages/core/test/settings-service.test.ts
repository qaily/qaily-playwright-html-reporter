import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { overlayLayer, resolveSettings, DEFAULT_SETTINGS, withoutBucketConnection, type SettingsLayer } from '@qaily/contracts';
import { PERSONAL_SETTINGS_KEY, SettingsService, personalSettingsKey, type TeamSettingsWriter } from '../src/settings-service.ts';

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
    items,
  };
}

const SITE: SettingsLayer = {
  lanes: [{ id: 'site', label: 'Site lane', match: {} }],
  display: { refreshSeconds: 30 },
  connections: { s3: { bucket: 'acme', prefix: 'runs', dataSource: 'bucket', dataPrefix: 'data' } },
};
const BUCKET: SettingsLayer = { lanes: [{ id: 'bucket', label: 'Bucket lane', match: {} }] };

describe('settings layers', () => {
  let storage: ReturnType<typeof memoryStorage>;
  beforeEach(() => {
    storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lets the bucket location be set personally', () => {
    const personal = { connections: { s3: { prefix: 'other/runs', dataPrefix: 'other/data', dataSource: 'bucket' as const, bucket: 'evil' } } };
    const { settings, sources } = resolveSettings(DEFAULT_SETTINGS, SITE, personal);
    expect(settings.connections.s3).toMatchObject({ prefix: 'other/runs', dataPrefix: 'other/data', bucket: 'acme' });
    expect(sources['connections.s3.dataPrefix']).toBe('personal');
    // The bucket itself stays a team setting.
    expect(sources['connections.s3.bucket']).toBe('team');
  });

  it('puts team settings from the bucket over the site, and never takes the bucket connection from there', () => {
    expect(withoutBucketConnection({ ...BUCKET, connections: { s3: { bucket: 'elsewhere' }, github: { owner: 'o' } } })).toEqual({
      ...BUCKET,
      connections: { github: { owner: 'o' } },
    });
    const s = new SettingsService(SITE, null);
    s.setDataLayer(BUCKET);
    expect(s.settings.lanes[0].id).toBe('bucket');
    expect(s.settings.display.refreshSeconds).toBe(30);
    expect(s.settings.connections.s3.bucket).toBe('acme');
    expect(s.team).toEqual(overlayLayer(SITE, BUCKET));
    s.setDataLayer(null);
    expect(s.settings.lanes[0].id).toBe('site');
  });

  it('saves to the layer its writer owns', async () => {
    const saved: SettingsLayer[] = [];
    const writer: TeamSettingsWriter = { label: 'bucket', target: 'data', save: async (l) => void saved.push(l) };
    const s = new SettingsService(SITE, writer);
    expect(s.teamTarget).toBe('data');
    await s.saveTeam({ ...s.team, lanes: [{ id: 'new', label: 'New', match: {} }] });
    expect(s.settings.lanes[0].id).toBe('new');
    // The site still says where the bucket is.
    expect(s.settings.connections.s3.dataPrefix).toBe('data');
  });

  it('keeps personal settings per report path, starting from the shared ones', () => {
    expect(personalSettingsKey('/')).toBe(PERSONAL_SETTINGS_KEY);
    expect(personalSettingsKey('/site/bucket/')).toBe(`${PERSONAL_SETTINGS_KEY}:/site/bucket`);
    storage.setItem(PERSONAL_SETTINGS_KEY, JSON.stringify({ display: { theme: 'classic' } }));

    const bucket = new SettingsService(SITE, null, DEFAULT_SETTINGS, personalSettingsKey('/site/bucket/'));
    expect(bucket.settings.display.theme).toBe('classic');
    bucket.setPersonalMany({ 'connections.s3.dataPrefix': 'other/data', 'display.theme': undefined });

    const root = new SettingsService(SITE, null, DEFAULT_SETTINGS, personalSettingsKey('/site/'));
    expect(root.settings.connections.s3.dataPrefix).toBe('data');
    expect(root.settings.display.theme).toBe('classic');

    const again = new SettingsService(SITE, null, DEFAULT_SETTINGS, personalSettingsKey('/site/bucket/'));
    expect(again.settings.connections.s3.dataPrefix).toBe('other/data');
    expect(again.settings.display.theme).not.toBe('classic');

    again.setPersonal('connections.s3.dataPrefix', undefined);
    // Cleared, not fallen back to the shared key.
    expect(new SettingsService(SITE, null, DEFAULT_SETTINGS, personalSettingsKey('/site/bucket/')).personal).toEqual({});
  });
});
