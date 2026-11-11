import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataAccessError, DataService, monthsInRange } from '../src/data-service.ts';
import { filtersFromParams, filtersToParams } from '../src/filters.ts';
import { tablesInQuery } from '../src/sql-tables.ts';
import { formatHash, parseHash } from '../src/router.ts';
import { DEFAULT_SETTINGS } from '@qaily/contracts';

describe('monthsInRange', () => {
  it('lists every month the range touches, end exclusive', () => {
    expect(monthsInRange({ from: new Date('2026-09-20T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z') })).toEqual(['2026-09', '2026-10']);
    expect(monthsInRange({ from: new Date('2026-12-31T00:00:00Z'), to: new Date('2027-01-02T00:00:00Z') })).toEqual(['2026-12', '2027-01']);
  });
});

describe('where data is read from', () => {
  const DATA_URL = new URL('https://example.test/data/');
  const CATALOG = { schemaVersion: 2, generatedAt: 'x', runCount: 1, latestRunAt: null, runsPath: 'runs', months: [{ month: '2026-10', runs: 1, hash: 'abc', files: { runs: 'rollups/runs-2026-10.json' } }] };
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const range = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z') };

  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(answer: (url: string) => Response | Promise<Response>) {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      return answer(url);
    });
    return calls;
  }

  it('reads from the website by default', async () => {
    const calls = stubFetch((url) => (url.includes('catalog') ? json(CATALOG) : json([])));
    const data = new DataService(DATA_URL);
    expect(data.readsFromBucket).toBe(false);
    await data.runs(range);
    await data.runDetail('2026-10-01T00-00-00-000_a b_1').catch(() => undefined);
    expect(calls).toContain('https://example.test/data/catalog.json');
    expect(calls).toContain('https://example.test/data/rollups/runs-2026-10.json?v=abc');
    expect(calls).toContain('https://example.test/data/runs/2026-10-01T00-00-00-000_a%20b_1/errors.jsonl.gz');
  });

  it('signs every file when reading from the bucket, without the cache-busting suffix', async () => {
    const signed: string[] = [];
    const calls = stubFetch((url) => (url.includes('catalog') ? json(CATALOG) : json([])));
    const data = new DataService(DATA_URL, {
      scope: 'b/data',
      keepOnDevice: () => false,
      signedUrl: async (path) => {
        signed.push(path);
        return `https://bucket.test/${path}?sig=1`;
      },
    });
    await data.runs(range);
    await data.runDetail('run-1').catch(() => undefined);
    expect(signed).toEqual(expect.arrayContaining(['catalog.json', 'rollups/runs-2026-10.json', 'runs/run-1/errors.jsonl.gz']));
    expect(calls.every((u) => u.startsWith('https://bucket.test/'))).toBe(true);
  });

  it('asks for credentials, then works once they exist', async () => {
    let connected = false;
    stubFetch(() => json(CATALOG));
    const data = new DataService(DATA_URL, { scope: 'b/data', keepOnDevice: () => false, signedUrl: async (path) => (connected ? `https://bucket.test/${path}` : null) });
    await expect(data.catalog()).rejects.toThrow(DataAccessError);
    expect(data.accessProblem).toBeInstanceOf(DataAccessError);
    connected = true;
    await expect(data.catalog()).resolves.toMatchObject({ runCount: 1 });
    expect(data.accessProblem).toBeNull();
  });

  it('keeps the loaded catalog when access ends, and reports the problem', async () => {
    let connected = true;
    stubFetch(() => json(CATALOG));
    const data = new DataService(DATA_URL, { scope: 'b/data', keepOnDevice: () => false, signedUrl: async (path) => (connected ? `https://bucket.test/${path}` : null) });
    await data.catalog();
    connected = false;
    await expect(data.catalog({ refresh: true })).resolves.toMatchObject({ runCount: 1 });
    expect(data.accessProblem).toBeInstanceOf(DataAccessError);
  });

  it('only keeps rollups on the device when allowed', async () => {
    const stored = new Map<string, Response>();
    const cache = {
      match: async (k: string) => stored.get(k)?.clone(),
      put: async (k: string, r: Response) => void stored.set(k, r),
      keys: async () => [...stored.keys()].map((url) => ({ url })),
      delete: async (r: { url: string }) => stored.delete(r.url),
    };
    vi.stubGlobal('caches', { open: async () => cache, delete: async () => stored.clear() });
    vi.stubGlobal('location', { origin: 'https://example.test' });
    const calls = stubFetch((url) => (url.includes('catalog') ? json(CATALOG) : json([])));
    const open = (keep: boolean) => new DataService(DATA_URL, { scope: 'b/data', keepOnDevice: () => keep, signedUrl: async (path) => `https://bucket.test/${path}` });
    const rollupReads = () => calls.filter((u) => u.includes('rollups/')).length;

    await open(false).runs(range);
    expect(stored.size).toBe(0);
    expect(rollupReads()).toBe(1);

    await open(true).runs(range);
    expect(stored.size).toBe(1);
    expect(rollupReads()).toBe(2);

    await open(true).runs(range); // a new page load: served from the device
    expect(rollupReads()).toBe(2);

    await open(false).runs(range); // credentials not remembered: the stored copy isn't used
    expect(rollupReads()).toBe(3);
  });

  it('explains a refused read without showing the signed link', async () => {
    stubFetch(() => new Response('denied', { status: 403 }));
    const data = new DataService(DATA_URL, { scope: 'b/data', keepOnDevice: () => false, signedUrl: async (path) => `https://bucket.test/${path}?X-Amz-Signature=secret` });
    const err = await data.catalog().catch((e: Error) => e);
    expect(err).toBeInstanceOf(DataAccessError);
    expect((err as Error).message).toContain('403');
    expect((err as Error).message).not.toContain('X-Amz-Signature');
  });
});

describe('tablesInQuery', () => {
  it('finds only the tables a query names', () => {
    expect([...tablesInQuery('SELECT * FROM tests t JOIN ISSUES i USING (run_id)')].sort()).toEqual(['issues', 'tests']);
    expect([...tablesInQuery('select title from steps')]).toEqual(['steps']);
    expect([...tablesInQuery('select test_id, latest_tests_x from other')]).toEqual([]);
  });
});

describe('routes and filters', () => {
  it('round-trips hashes', () => {
    const hash = formatHash('tests', { run: 'a b', test: 'x' });
    expect(parseHash(hash)).toEqual({ page: 'tests', params: { run: 'a b', test: 'x' } });
    expect(parseHash('')).toEqual({ page: '', params: {} });
  });

  it('omits default filters from the URL and rejects bad values', () => {
    const f = filtersFromParams({ range: '7', branch: 'all' }, DEFAULT_SETTINGS);
    expect(f).toEqual({ rangeDays: 7, branch: 'all', lanes: [] });
    expect(filtersToParams({ ...f, rangeDays: DEFAULT_SETTINGS.display.defaultRangeDays, branch: 'main' }, DEFAULT_SETTINGS)).toEqual({});
    expect(filtersFromParams({ range: '-1', branch: 'weird' }, DEFAULT_SETTINGS).rangeDays).toBe(DEFAULT_SETTINGS.display.defaultRangeDays);
  });
});
