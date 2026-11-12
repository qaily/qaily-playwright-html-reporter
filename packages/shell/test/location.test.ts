import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, resolveSettings, withoutBucketConnection, type SettingsLayer } from '@qaily/contracts';
import { locationOf, personalFolder } from '../src/location.ts';

// The site's team settings: a Google Cloud Storage bucket.
const team: SettingsLayer = {
  connections: {
    s3: { bucket: 'report-storage-eu', region: 'auto', endpoint: 'https://storage.googleapis.com', prefix: 'fw/jsonl-report', dataSource: 'bucket', dataPrefix: 'fw/qaily-data' },
  },
};
const resolve = (personal: SettingsLayer) => resolveSettings(DEFAULT_SETTINGS, team, personal);

describe('a viewer looking at another bucket', () => {
  it('replaces the whole storage location, an empty endpoint (AWS) included', () => {
    const r = resolve({
      connections: {
        s3: { bucket: 'aws-bucket', region: 'eu-north-1', endpoint: '', pathStyle: false, prefix: 'reports/jsonl-report', dataPrefix: 'reports/data' },
      },
    });
    expect(locationOf(r.settings.connections.s3)).toEqual({
      bucket: 'aws-bucket',
      region: 'eu-north-1',
      endpoint: '',
      pathStyle: false,
      dataSource: 'bucket',
      prefix: 'reports/jsonl-report',
      dataPrefix: 'reports/data',
    });
    expect(personalFolder(r.settings.connections.s3, r.sources)).toBe('aws-bucket/reports/data');
  });

  it('names only the folder when the bucket is the report\'s own', () => {
    const r = resolve({ connections: { s3: { dataPrefix: 'test-data' } } });
    expect(personalFolder(r.settings.connections.s3, r.sources)).toBe('test-data');
    expect(personalFolder(resolve({}).settings.connections.s3, resolve({}).sources)).toBeNull();
  });

  it('never takes the bucket from team settings stored in a bucket', () => {
    expect(withoutBucketConnection({ connections: { s3: { bucket: 'elsewhere', endpoint: 'https://evil.example' } } })).toEqual({});
  });
});
