import { describe, expect, it } from 'vitest';
import { BucketTeamSettings, TEAM_SETTINGS_FILE } from '../src/team-settings.ts';

/** A bucket with one optional file, behind fake signed links. */
function bucket(initial: string | null, opts: { putStatus?: number; connected?: boolean } = {}) {
  let file = initial;
  const requests: { method: string; url: string; body?: string; type?: string }[] = [];
  const artifacts = {
    credentials: () => (opts.connected === false ? null : ({ keyId: 'AKIA…', temporary: false, expiration: null, persistence: 'session' } as const)),
    dataFileUrl: async (path: string, method: 'GET' | 'PUT' = 'GET') => (opts.connected === false ? null : `https://bucket.test/data/${path}?m=${method}`),
  };
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    requests.push({ method, url, body: init?.body as string | undefined, type: (init?.headers as Record<string, string> | undefined)?.['Content-Type'] });
    if (method === 'PUT') {
      const status = opts.putStatus ?? 200;
      if (status === 200) file = init!.body as string;
      return new Response(null, { status });
    }
    return file === null ? new Response('missing', { status: 404 }) : new Response(file, { status: 200 });
  }) as typeof fetch;
  const store = new BucketTeamSettings(artifacts, () => 'acme/data', fetchFn);
  return { store, requests, set: (v: string | null) => (file = v), get: () => file };
}

describe('team settings in the bucket', () => {
  it('reads them without the bucket connection, and nothing when there are none', async () => {
    const b = bucket(JSON.stringify({ lanes: [{ id: 'x', label: 'X', match: {} }], connections: { s3: { bucket: 'elsewhere' } } }));
    expect(await b.store.load()).toEqual({ lanes: [{ id: 'x', label: 'X', match: {} }] });
    expect(b.requests[0].url).toContain(TEAM_SETTINGS_FILE);
    expect(await bucket(null).store.load()).toBeNull();
    expect(await bucket('not json').store.load()).toBeNull();
    expect(await bucket('{}', { connected: false }).store.load()).toBeNull();
  });

  it('saves as JSON with a signed PUT, leaving the bucket connection out', async () => {
    const b = bucket(null);
    await b.store.load();
    await b.store.save({ display: { refreshSeconds: 60 }, connections: { s3: { bucket: 'acme' } } });
    const put = b.requests.find((r) => r.method === 'PUT')!;
    expect(put.url).toContain('m=PUT');
    expect(put.type).toBe('application/json');
    expect(JSON.parse(b.get()!)).toEqual({ display: { refreshSeconds: 60 } });
    // Saving again after its own save is fine.
    await b.store.save({ display: { refreshSeconds: 90 } });
  });

  it('refuses to overwrite a change someone else saved meanwhile', async () => {
    const b = bucket('{"display":{"refreshSeconds":30}}\n');
    await b.store.load();
    b.set('{"display":{"refreshSeconds":45}}\n');
    await expect(b.store.save({})).rejects.toThrow(/Someone else changed/);
    expect(b.requests.some((r) => r.method === 'PUT')).toBe(false);
  });

  it('explains a read-only key', async () => {
    const b = bucket(null, { putStatus: 403 });
    await expect(b.store.save({})).rejects.toThrow(/write access to acme\/data\/team-settings\.json/);
    expect(bucket(null, { connected: false }).store.available()).toBe(false);
  });
});
