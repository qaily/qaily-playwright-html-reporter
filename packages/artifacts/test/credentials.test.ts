import { describe, expect, it } from 'vitest';
import { isExpired, isTemporary, maskKeyId, parseCredentials } from '../src/credentials.ts';

const future = new Date(Date.now() + 3600_000).toISOString();

describe('parseCredentials', () => {
  it('reads the export-credentials JSON', () => {
    const c = parseCredentials(JSON.stringify({ Version: 1, AccessKeyId: 'ASIAEXAMPLEKEY123456', SecretAccessKey: 'secretsecretsecret1', SessionToken: 'tok', Expiration: future }));
    expect(c).toEqual({ accessKeyId: 'ASIAEXAMPLEKEY123456', secretAccessKey: 'secretsecretsecret1', sessionToken: 'tok', expiration: future });
    expect(isTemporary(c)).toBe(true);
  });

  it('reads bash, PowerShell and cmd lines', () => {
    for (const [prefix, quote] of [['export ', ''], ['$Env:', '"'], ['set ', '']]) {
      const c = parseCredentials(
        [`${prefix}AWS_ACCESS_KEY_ID=${quote}AKIAEXAMPLEKEY123456${quote}`, `${prefix}AWS_SECRET_ACCESS_KEY=${quote}secretsecretsecret1${quote}`].join('\n'),
      );
      expect(c.accessKeyId).toBe('AKIAEXAMPLEKEY123456');
      expect(c.sessionToken).toBeUndefined();
      expect(isTemporary(c)).toBe(false);
    }
  });

  it('accepts keys from S3-compatible services', () => {
    for (const id of ['GOOG1EXAMPLEHMACKEY', 'minioadmin']) {
      const c = parseCredentials(`export AWS_ACCESS_KEY_ID=${id}\nexport AWS_SECRET_ACCESS_KEY=minioadmin`);
      expect(c.accessKeyId).toBe(id);
      expect(isTemporary(c)).toBe(false);
    }
  });

  it('rejects garbage, missing secrets and expired credentials', () => {
    expect(() => parseCredentials('hello')).toThrow(/access key/);
    expect(() => parseCredentials('export AWS_ACCESS_KEY_ID=AKIAEXAMPLEKEY123456')).toThrow(/secret/);
    expect(() =>
      parseCredentials(JSON.stringify({ AccessKeyId: 'ASIAEXAMPLEKEY123456', SecretAccessKey: 'secretsecretsecret1', Expiration: '2020-01-01T00:00:00Z' })),
    ).toThrow(/expired/);
  });
});

describe('helpers', () => {
  it('treats credentials expiring within a minute as expired', () => {
    const c = { accessKeyId: 'x', secretAccessKey: 'y', expiration: new Date(Date.now() + 30_000).toISOString() };
    expect(isExpired(c)).toBe(true);
    expect(isExpired({ ...c, expiration: undefined })).toBe(false);
  });
  it('masks key ids', () => expect(maskKeyId('AKIAEXAMPLEKEY123456')).toBe('AKIA…3456'));
});
