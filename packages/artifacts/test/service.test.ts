import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type SecretsApi } from '@qaily/contracts';
import { ArtifactService } from '../src/service.ts';

const START = new Date('2026-11-05T12:00:00Z');
const MINUTE = 60_000;

function service(creds: object | null = { accessKeyId: 'AKIAEXAMPLEKEY', secretAccessKey: 'example-secret-value' }, dataPrefix = '/qaily-data/') {
  const stored = creds ? JSON.stringify(creds) : null;
  const secrets = { get: () => stored, set: () => {}, forget: () => {}, persistence: () => 'session' } as unknown as SecretsApi;
  return new ArtifactService({
    baseUrl: new URL('https://example.test/'),
    dataUrl: new URL('https://example.test/data/'),
    localServer: false,
    secrets,
    s3: () => ({ ...DEFAULT_SETTINGS.connections.s3, bucket: 'b', region: 'auto', endpoint: 'https://storage.example.test', dataPrefix }),
  });
}

describe('signed link lifetimes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: START });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('signs attachments for 1 hour and reuses a link for 30 minutes', async () => {
    const s = service();
    const first = (await s.url('run', 'attachments/a.png'))!;
    expect(new URL(first).searchParams.get('X-Amz-Expires')).toBe('3600');

    vi.setSystemTime(START.getTime() + 29 * MINUTE);
    expect(await s.url('run', 'attachments/a.png')).toBe(first);

    vi.setSystemTime(START.getTime() + 31 * MINUTE);
    expect(await s.url('run', 'attachments/a.png')).not.toBe(first);
  });

  it('never reuses a link past the credentials expiry', async () => {
    const expiration = new Date(START.getTime() + 11 * MINUTE).toISOString();
    const s = service({ accessKeyId: 'ASIAEXAMPLEKEY', secretAccessKey: 'example-secret-value', sessionToken: 'token', expiration });
    const first = await s.url('run', 'attachments/a.png');

    vi.setSystemTime(START.getTime() + 9 * MINUTE);
    expect(await s.url('run', 'attachments/a.png')).toBe(first);

    vi.setSystemTime(START.getTime() + 10.5 * MINUTE);
    expect(await s.url('run', 'attachments/a.png')).not.toBe(first);
  });

  it('signs report data for 10 minutes under the data prefix, fresh every time', async () => {
    const s = service();
    const first = new URL((await s.dataFileUrl('rollups/tests-2026-10.parquet'))!);
    expect(first.pathname).toBe('/qaily-data/rollups/tests-2026-10.parquet');
    expect(first.searchParams.get('X-Amz-Expires')).toBe('600');

    vi.setSystemTime(START.getTime() + MINUTE);
    expect((await s.dataFileUrl('rollups/tests-2026-10.parquet'))).not.toBe(first.href);
  });
});

describe('fresh links and forgetting', () => {
  it('signs a new link on request, even within the reuse window', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: START });
    try {
      const s = service();
      const first = await s.url('run', 'attachments/a.png');
      vi.setSystemTime(START.getTime() + 1000);
      const again = await s.url('run', 'attachments/a.png', { fresh: true });
      expect(again).not.toBe(first);
      expect(await s.url('run', 'attachments/a.png')).toBe(again);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs onForget only when the viewer forgets the credentials', () => {
    const forgot = vi.fn();
    const secrets = { get: () => null, set: () => {}, forget: () => {}, persistence: () => null } as unknown as SecretsApi;
    const s = new ArtifactService({
      baseUrl: new URL('https://example.test/'),
      dataUrl: new URL('https://example.test/data/'),
      localServer: false,
      secrets,
      s3: () => ({ ...DEFAULT_SETTINGS.connections.s3, bucket: 'b' }),
      onForget: forgot,
    });
    s.status();
    expect(forgot).not.toHaveBeenCalled();
    s.disconnect();
    expect(forgot).toHaveBeenCalledOnce();
  });

  it('knows whether credentials are kept on this device', () => {
    const creds = JSON.stringify({ accessKeyId: 'AKIAEXAMPLEKEY', secretAccessKey: 'example-secret-value' });
    const withPersistence = (p: string) =>
      new ArtifactService({
        baseUrl: new URL('https://example.test/'),
        dataUrl: new URL('https://example.test/data/'),
        localServer: false,
        secrets: { get: () => creds, set: () => {}, forget: () => {}, persistence: () => p } as unknown as SecretsApi,
        s3: () => ({ ...DEFAULT_SETTINGS.connections.s3, bucket: 'b' }),
      });
    expect(withPersistence('local').keepsCredentialsOnDevice()).toBe(true);
    expect(withPersistence('session').keepsCredentialsOnDevice()).toBe(false);
  });
});

describe('dataFileUrl', () => {
  it('returns null without credentials', async () => {
    expect(await service(null).dataFileUrl('catalog.json')).toBeNull();
  });

  it('refuses paths that leave the data prefix', async () => {
    await expect(service().dataFileUrl('runs/../../secret.txt')).rejects.toThrow('Invalid');
  });
});

describe('attachment check', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks storage for one byte and reads the answer from the status', async () => {
    const seen: { url: string; range: string | null }[] = [];
    let status = 404;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      seen.push({ url, range: new Headers(init?.headers).get('Range') });
      return new Response(null, { status });
    });
    const s = service();
    expect(await s.check('run', 'attachments/a.png')).toBe('missing');
    expect(seen[0].url).toContain('/run/attachments/a.png');
    expect(seen[0].range).toBe('bytes=0-0');
    status = 206;
    expect(await s.check('run', 'attachments/a.png')).toBe('ok');
    status = 403;
    expect(await s.check('run', 'attachments/a.png')).toBe('denied');
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await s.check('run', 'attachments/a.png')).toBe('unknown');
  });

  it('cannot tell without credentials', async () => {
    expect(await service(null).check('run', 'attachments/a.png')).toBe('unknown');
  });
});

describe('whole attachments (for the trace viewer)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('downloads the file with a fresh signed link, and explains failures', async () => {
    const urls: string[] = [];
    let respond = () => new Response('zip-bytes', { status: 200 });
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return respond();
    });
    const s = service();
    expect(await (await s.blob('run', 'attachments/trace.zip')).text()).toBe('zip-bytes');
    expect(urls[0]).toContain('/run/attachments/trace.zip');
    respond = () => new Response(null, { status: 404 });
    await expect(s.blob('run', 'attachments/trace.zip')).rejects.toThrow('not found');
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(s.blob('run', 'attachments/trace.zip')).rejects.toThrow('CORS');
    await expect(service(null).blob('run', 'attachments/trace.zip')).rejects.toThrow('Connect credentials');
  });
});
