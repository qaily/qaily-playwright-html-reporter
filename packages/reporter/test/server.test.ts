import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHandler } from '../src/server.ts';
import { LocalSigner } from '../src/s3-signer.ts';

let dir: string;
let server: Server;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'qaily-serve-'));
  mkdirSync(join(dir, 'data'));
  mkdirSync(join(dir, 'raw/run1/attachments'), { recursive: true });
  writeFileSync(join(dir, 'data/catalog.json'), '0123456789');
  writeFileSync(join(dir, 'raw/run1/attachments/shot.png'), 'png');
  writeFileSync(join(dir, 'secret.txt'), 'nope');
  const handler = createHandler({ dataDir: join(dir, 'data'), attachmentsDir: join(dir, 'raw') });
  server = createServer((req, res) => void handler(req, res, () => res.writeHead(404).end()));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('report server', () => {
  it('serves byte ranges (DuckDB-WASM reads parquet this way)', async () => {
    const res = await fetch(`${base}/data/catalog.json`, { headers: { Range: 'bytes=2-4' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-4/10');
    expect(await res.text()).toBe('234');
  });

  it('falls back to raw run folders for attachments', async () => {
    const res = await fetch(`${base}/data/runs/run1/attachments/shot.png`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('png');
  });

  it('blocks path traversal', async () => {
    const res = await fetch(`${base}/data/%2e%2e/secret.txt`);
    expect(res.status).toBe(404);
  });

  it('writes team settings from this machine, as JSON objects only', async () => {
    const put = (body: string, headers: Record<string, string> = {}) =>
      fetch(`${base}/__qaily/settings`, { method: 'PUT', body, headers: { 'Content-Type': 'application/json', ...headers } });
    expect((await put('{"display":{"historyChips":3}}')).status).toBe(200);
    expect(JSON.parse(readFileSync(join(dir, 'data/settings.json'), 'utf8'))).toEqual({ display: { historyChips: 3 } });
    expect((await put('[1,2]')).status).toBe(400);
    expect((await put('{}', { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
  });
});

describe('artifact route', () => {
  let dir2: string;
  let server2: Server;
  let base2: string;
  const execCalls: string[][] = [];

  beforeAll(async () => {
    dir2 = mkdtempSync(join(tmpdir(), 'qaily-art-'));
    mkdirSync(join(dir2, 'data'));
    mkdirSync(join(dir2, 'raw/run1/attachments'), { recursive: true });
    writeFileSync(join(dir2, 'raw/run1/attachments/shot.png'), 'png');
    writeFileSync(join(dir2, 'data/settings.json'), JSON.stringify({ connections: { s3: { bucket: 'acme-pw', region: 'eu-north-1', prefix: 'jsonl-report' } } }));
    const signer = new LocalSigner({
      env: {},
      exec: async (args) => {
        execCalls.push(args);
        return JSON.stringify({ AccessKeyId: 'ASIAEXAMPLEKEY123456', SecretAccessKey: 'secretsecretsecret1', SessionToken: 'tok', Expiration: new Date(Date.now() + 3600_000).toISOString() });
      },
    });
    const handler = createHandler({ dataDir: join(dir2, 'data'), attachmentsDir: join(dir2, 'raw'), signer });
    server2 = createServer((req, res) => void handler(req, res, () => res.writeHead(404).end()));
    await new Promise<void>((r) => server2.listen(0, '127.0.0.1', r));
    base2 = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server2.close();
    rmSync(dir2, { recursive: true, force: true });
  });

  const get = (q: string, headers: Record<string, string> = {}) => fetch(`${base2}/__qaily/artifact?${q}`, { redirect: 'manual', headers });

  it('serves a local file when there is one', async () => {
    const res = await get('run=run1&path=attachments/shot.png');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('png');
  });

  it('redirects to a presigned S3 URL otherwise, signing once with the AWS CLI login', async () => {
    const res = await get('run=run1&path=attachments/trace.zip&download=trace.zip');
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin).toBe('https://acme-pw.s3.eu-north-1.amazonaws.com');
    expect(loc.pathname).toBe('/jsonl-report/run1/attachments/trace.zip');
    expect(loc.searchParams.get('X-Amz-Security-Token')).toBe('tok');
    expect(loc.searchParams.get('response-content-disposition')).toContain('trace.zip');
    await get('run=run1&path=attachments/other.zip');
    expect(execCalls).toEqual([['configure', 'export-credentials', '--format', 'process']]);
  });

  it('rejects traversal, and callers other than this origin and the trace viewer', async () => {
    expect((await get('run=run1&path=attachments/../../secret')).status).toBe(400);
    expect((await get('run=../x&path=a')).status).toBe(400);
    expect((await get('run=run1&path=attachments/shot.png', { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    const trace = await get('run=run1&path=attachments/t.zip', { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://trace.playwright.dev' });
    expect(trace.status).toBe(302);
    expect(trace.headers.get('access-control-allow-origin')).toBe('https://trace.playwright.dev');
  });

  it('reports signer status without exposing credentials', async () => {
    const body = await (await fetch(`${base2}/__qaily/s3/status`)).json();
    expect(body).toMatchObject({ configured: true, bucket: 'acme-pw', ok: true, identity: 'default AWS profile' });
    expect(JSON.stringify(body)).not.toContain('secretsecret');
  });
});

describe('LocalSigner', () => {
  it('prefers env keys and caches CLI failures for a while', async () => {
    const env = new LocalSigner({ env: { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLEKEY123456', AWS_SECRET_ACCESS_KEY: 's' } });
    expect(await env.status()).toMatchObject({ ok: true, identity: 'environment variables' });

    let calls = 0;
    let now = 0;
    const failing = new LocalSigner({ env: {}, now: () => now, exec: async () => { calls++; throw new Error('Token has expired; run aws sso login'); } });
    expect(await failing.status()).toEqual({ ok: false, error: 'Token has expired; run aws sso login' });
    await failing.status();
    expect(calls).toBe(1);
    now += 31_000;
    await failing.status();
    expect(calls).toBe(2);
  });
});

describe('publish and pull', () => {
  const s3 = { bucket: 'acme', region: 'auto', prefix: 'jsonl-report', endpoint: 'https://storage.example.test', pathStyle: false, dataSource: 'bucket' as const, dataPrefix: '/qaily-data/' };

  it('uploads the catalog last, and keeps site-only files out of the bucket', async () => {
    const { publishArgs } = await import('../src/sync.ts');
    const [upload, catalog] = publishArgs({ s3, dataDir: 'data', profile: 'qa' });
    expect(upload.slice(0, 4)).toEqual(['s3', 'sync', 'data', 's3://acme/qaily-data/']);
    for (const file of ['settings.json', 'ai/*', 'catalog.json']) expect(upload[upload.indexOf(file) - 1]).toBe('--exclude');
    expect(upload).not.toContain('--delete');
    expect(catalog.slice(0, 4)).toEqual(['s3', 'cp', 'data/catalog.json', 's3://acme/qaily-data/catalog.json']);
    expect(catalog).toContain('--endpoint-url');
    expect(catalog.slice(-2)).toEqual(['--profile', 'qa']);
  });

  it('pulls without overwriting site-only files', async () => {
    const { pullArgs } = await import('../src/sync.ts');
    const args = pullArgs({ s3, dataDir: 'data' });
    expect(args.slice(0, 4)).toEqual(['s3', 'sync', 's3://acme/qaily-data/', 'data']);
    expect(args).toContain('settings.json');
    expect(args).toContain('ai/*');
    expect(args).not.toContain('--delete');
  });

  it('refuses a data folder that overlaps the run folders', async () => {
    const { dataLocation } = await import('../src/sync.ts');
    expect(dataLocation(s3)).toBe('s3://acme/qaily-data/');
    for (const [prefix, dataPrefix] of [['jsonl-report', 'jsonl-report'], ['jsonl-report', 'jsonl-report/data'], ['a/runs', 'a'], ['', 'qaily-data'], ['jsonl-report', '']]) {
      expect(() => dataLocation({ ...s3, prefix, dataPrefix })).toThrow(/prefix/);
    }
  });
});

describe('sync', () => {
  it('excludes attachments unless asked, and passes the profile', async () => {
    const { syncArgs } = await import('../src/sync.ts');
    const s3 = { bucket: 'acme', region: 'eu-north-1', prefix: '/jsonl-report/', endpoint: '', pathStyle: false, dataSource: 'website' as const, dataPrefix: '' };
    expect(syncArgs({ s3, toDir: 'cache' })).toEqual([
      's3', 'sync', 's3://acme/jsonl-report/', 'cache', '--region', 'eu-north-1', '--only-show-errors', '--exclude', '*/attachments/*',
    ]);
    expect(syncArgs({ s3: { ...s3, endpoint: 'storage.googleapis.com' }, toDir: 'c' })).toContain('https://storage.googleapis.com');
    expect(syncArgs({ s3: { ...s3, endpoint: 'storage.googleapis.com' }, toDir: 'c' })).toContain('--endpoint-url');
    expect(syncArgs({ s3, toDir: 'c', withAttachments: true, profile: 'qa' })).not.toContain('--exclude');
    expect(syncArgs({ s3, toDir: 'c', profile: 'qa' }).slice(-2)).toEqual(['--profile', 'qa']);
  });
});

describe('AI results route', () => {
  const record = (over: Record<string, unknown> = {}) => ({
    schemaVersion: 1, kind: 'test-analysis', runId: 'run1', testId: 't1', createdAt: '2026-10-22T10:00:00Z', provider: 'copilotcli',
    promptVersion: 'qaily-ai/1', inputHash: 'abc',
    result: { summary: 's', category: 'flaky', confidence: 0.5, rootCause: 'r', evidence: [], suggestedFix: 'f', relatedFiles: [] },
    ...over,
  });
  const put = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/__qaily/ai?path=${encodeURIComponent(path)}`, { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } });

  it('writes a valid record and keeps the index up to date', async () => {
    expect((await put('runs/run1/tests/t1.json', record())).status).toBe(200);
    expect((await put('runs/run1/tests/t2.fix.json', record({ kind: 'test-fix', testId: 't2',
      result: { summary: 's', filesChanged: [], verification: 'v', risk: '', needsHumanReview: true } }))).status).toBe(200);
    const index = JSON.parse(readFileSync(join(dir, 'data/ai/index.json'), 'utf8'));
    expect(index.runs.run1).toEqual({ tests: ['t1'], fixes: ['t2'] });
    const served = await fetch(`${base}/data/ai/runs/run1/tests/t1.json`);
    expect((await served.json()).result.category).toBe('flaky');
  });

  it('rejects bad paths, mismatched or invalid records, and other origins', async () => {
    expect((await put('../../etc/x.json', record())).status).toBe(400);
    expect((await put('runs/run1/tests/other.json', record())).status).toBe(400);
    expect((await put('runs/run1/tests/t1.json', record({ result: { summary: '' } }))).status).toBe(400);
    expect((await put('runs/run1/tests/t1.json', record(), { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
  });
});
