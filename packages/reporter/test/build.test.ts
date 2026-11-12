import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import type { Catalog, RunRow } from '@qaily/contracts';
import { build } from '../src/build.ts';
import { writeDemoRuns } from '../src/demo.ts';

let dir: string;
const runsDir = () => join(dir, 'runs');
const outDir = () => join(dir, 'data');

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qaily-build-'));
  writeDemoRuns(runsDir(), { runs: 24, days: 20, now: new Date('2026-10-15T12:00:00Z') });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function query(sql: string) {
  const conn = await (await DuckDBInstance.create(':memory:')).connect();
  return (await conn.runAndReadAll(sql)).getRowObjectsJson();
}

describe('qaily-report build', () => {
  it('writes a catalog, run rollups and parquet that agree with the manifests', async () => {
    const result = await build({ inDir: runsDir(), outDir: outDir() });
    const catalog = JSON.parse(readFileSync(join(outDir(), 'catalog.json'), 'utf8')) as Catalog;
    expect(catalog.runCount).toBe(24);
    expect(result.rebuiltMonths.sort()).toEqual(catalog.months.map((m) => m.month).sort());

    for (const m of catalog.months) {
      const runs = JSON.parse(readFileSync(join(outDir(), m.files.runs), 'utf8')) as RunRow[];
      expect(runs).toHaveLength(m.runs);
      const finished = runs.filter((r) => r.ended_at);
      const ids = finished.map((r) => `'${r.run_id}'`).join(',') || "''";
      const [row] = await query(`SELECT count(*) AS n FROM '${join(outDir(), m.files.tests)}' WHERE run_id IN (${ids})`);
      expect(Number(row.n)).toBe(finished.reduce((n, r) => n + r.total, 0));
    }
  });

  it("copies each run's tag into the tests rollup as the suite", async () => {
    const catalog = JSON.parse(readFileSync(join(outDir(), 'catalog.json'), 'utf8')) as Catalog;
    for (const m of catalog.months) {
      const runs = JSON.parse(readFileSync(join(outDir(), m.files.runs), 'utf8')) as RunRow[];
      const rows = await query(`SELECT DISTINCT run_id, suite FROM '${join(outDir(), m.files.tests)}'`);
      for (const r of rows) expect(r.suite ?? null).toBe(runs.find((x) => x.run_id === r.run_id)?.tag ?? null);
    }
  });

  it('writes every file the report opens for a run, even when the raw run lacks it', async () => {
    const inDir = join(dir, 'sparse-runs');
    const out = join(dir, 'sparse-data');
    writeDemoRuns(inDir, { runs: 1, days: 1, now: new Date('2026-10-15T12:00:00Z') });
    const [run] = readdirSync(inDir);
    rmSync(join(inDir, run, 'errors.jsonl'));
    rmSync(join(inDir, run, 'attachments-index.jsonl'), { force: true });
    await build({ inDir, outDir: out });
    for (const name of ['manifest', 'test-summary', 'test_details', 'errors', 'attachments-index']) {
      expect(existsSync(join(out, 'runs', run, `${name}.jsonl.gz`)), name).toBe(true);
    }
    expect(gunzipSync(readFileSync(join(out, 'runs', run, 'errors.jsonl.gz'))).length).toBe(0);
  });

  it('gives the same error in different runs the same issue signature', async () => {
    const files = JSON.parse(readFileSync(join(outDir(), 'catalog.json'), 'utf8')).months.map(
      (m: { files: { issues: string } }) => `'${join(outDir(), m.files.issues)}'`,
    );
    const rows = await query(`SELECT issue_sig, count(DISTINCT run_id) AS runs, count(DISTINCT norm_msg) AS msgs
      FROM read_parquet([${files.join(',')}]) GROUP BY 1 ORDER BY runs DESC`);
    expect(Number(rows[0].runs)).toBeGreaterThan(1);
    expect(rows.every((r) => Number(r.msgs) === 1)).toBe(true);
  });

  it('skips unchanged months on the next build, and rebuilds a month whose run changed', async () => {
    const again = await build({ inDir: runsDir(), outDir: outDir() });
    expect(again.rebuiltMonths).toEqual([]);

    const catalog = JSON.parse(readFileSync(join(outDir(), 'catalog.json'), 'utf8')) as Catalog;
    const run = (JSON.parse(readFileSync(join(outDir(), catalog.months[0].files.runs), 'utf8')) as RunRow[])[0];
    const summary = join(runsDir(), run.run_id, 'test-summary.jsonl');
    writeFileSync(summary, readFileSync(summary, 'utf8') + '\n');
    const third = await build({ inDir: runsDir(), outDir: outDir() });
    expect(third.rebuiltMonths).toEqual([catalog.months[0].month]);
  });

  it('skips runs without .sync-complete when the folder is an S3 sync', async () => {
    const victim = (JSON.parse(readFileSync(join(outDir(), 'catalog.json'), 'utf8')) as Catalog).months[0];
    const runs = JSON.parse(readFileSync(join(outDir(), victim.files.runs), 'utf8')) as RunRow[];
    rmSync(join(runsDir(), runs[0].run_id, '.sync-complete'));
    const result = await build({ inDir: runsDir(), outDir: join(dir, 'data2') });
    expect(result.skippedRuns).toEqual([runs[0].run_id]);
    expect(result.catalog.runCount).toBe(23);
    const loose = await build({ inDir: runsDir(), outDir: join(dir, 'data3'), requireSyncComplete: false });
    expect(loose.catalog.runCount).toBe(24);
  });

  it('copies raw run files as gzip', () => {
    const catalog = JSON.parse(readFileSync(join(outDir(), 'catalog.json'), 'utf8')) as Catalog;
    const run = (JSON.parse(readFileSync(join(outDir(), catalog.months[0].files.runs), 'utf8')) as RunRow[])[0];
    expect(existsSync(join(outDir(), 'runs', run.run_id, 'test_details.jsonl.gz'))).toBe(true);
  });
});

describe('qaily-report build, after run folders expire', () => {
  // 30 runs over 40 days before 2026-10-15: September and October.
  let base: string;
  const runs = () => join(base, 'runs');
  const out = () => join(base, 'data');
  const readCatalog = () => JSON.parse(readFileSync(join(out(), 'catalog.json'), 'utf8')) as Catalog;
  const monthRuns = (m: Catalog['months'][number]) => JSON.parse(readFileSync(join(out(), m.files.runs), 'utf8')) as RunRow[];
  const testRunIds = async (m: Catalog['months'][number]) =>
    (await query(`SELECT DISTINCT run_id FROM '${join(out(), m.files.tests)}'`)).map((r) => r.run_id as string).sort();
  const runDirs = () => readdirSync(runs()).filter((d) => !d.startsWith('.'));

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'qaily-expire-'));
    writeDemoRuns(runs(), { runs: 30, days: 40, now: new Date('2026-10-15T12:00:00Z') });
    await build({ inDir: runs(), outDir: out() });
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('keeps every month and run when all run folders are gone, without rebuilding', async () => {
    const before = readCatalog();
    expect(before.months.map((m) => m.month)).toEqual(['2026-10', '2026-09']);
    const testsBefore = await Promise.all(before.months.map(testRunIds));
    for (const d of runDirs()) rmSync(join(runs(), d), { recursive: true });

    const result = await build({ inDir: runs(), outDir: out() });
    expect(result.rebuiltMonths).toEqual([]);
    const after = readCatalog();
    expect(after.months).toEqual(before.months);
    expect(after.runCount).toBe(30);
    expect(after.latestRunAt).toBe(before.latestRunAt);
    expect(await Promise.all(after.months.map(testRunIds))).toEqual(testsBefore);
  });

  it('adds new runs to a month whose older runs expired, keeping the old rows', async () => {
    const before = readCatalog();
    const october = before.months.find((m) => m.month === '2026-10')!;
    const oldIds = monthRuns(october).map((r) => r.run_id);
    writeDemoRuns(runs(), { runs: 4, days: 2, now: new Date('2026-10-20T12:00:00Z'), seed: 99 });

    const result = await build({ inDir: runs(), outDir: out() });
    expect(result.rebuiltMonths).toEqual(['2026-10']);
    const after = readCatalog().months.find((m) => m.month === '2026-10')!;
    const ids = monthRuns(after).map((r) => r.run_id);
    expect(ids).toHaveLength(oldIds.length + 4);
    expect(ids).toEqual(expect.arrayContaining([...oldIds, ...runDirs()]));
    const finished = monthRuns(after).filter((r) => r.ended_at).map((r) => r.run_id).sort();
    expect((await testRunIds(after)).filter((id) => finished.includes(id))).toEqual(finished);
    expect(after.hash).not.toBe(october.hash);
    expect(readCatalog().months.find((m) => m.month === '2026-09')).toEqual(before.months.find((m) => m.month === '2026-09'));
  });

  it('treats a run folder that lost files as expiring, not changed', async () => {
    const before = readCatalog();
    const victim = runDirs()[0];
    rmSync(join(runs(), victim, 'test-summary.jsonl'));
    const result = await build({ inDir: runs(), outDir: out() });
    expect(result.rebuiltMonths).toEqual([]);
    expect(readCatalog().months).toEqual(before.months);
    const october = readCatalog().months.find((m) => m.month === '2026-10')!;
    expect(await testRunIds(october)).toContain(victim);
  });

  it('keeps expired runs on --force too', async () => {
    const before = readCatalog();
    const result = await build({ inDir: runs(), outDir: out(), force: true });
    expect(result.rebuiltMonths.sort()).toEqual(['2026-09', '2026-10']);
    expect(readCatalog().months.map((m) => [m.month, m.runs])).toEqual(before.months.map((m) => [m.month, m.runs]));
    for (const m of readCatalog().months) {
      const finished = monthRuns(m).filter((r) => r.ended_at).map((r) => r.run_id).sort();
      expect((await testRunIds(m)).filter((id) => finished.includes(id))).toEqual(finished);
    }
  });

  it('brings back a month the published catalog lost, from its rollups', async () => {
    const before = readCatalog();
    writeFileSync(join(out(), 'catalog.json'), JSON.stringify({ ...before, months: before.months.slice(0, 1) }));
    await build({ inDir: runs(), outDir: out() });
    expect(readCatalog().months).toEqual(before.months);
  });

  it('drops months for good with pruneBefore', async () => {
    const result = await build({ inDir: runs(), outDir: out(), pruneBefore: '2026-10' });
    expect(result.catalog.months.map((m) => m.month)).toEqual(['2026-10']);
    expect(result.catalog.prunedBefore).toBe('2026-10');
    expect(existsSync(join(out(), 'rollups/runs-2026-09.json'))).toBe(false);
    writeDemoRuns(runs(), { runs: 1, days: 1, now: new Date('2026-09-10T12:00:00Z'), seed: 7 });
    const again = await build({ inDir: runs(), outDir: out() });
    expect(again.catalog.months.map((m) => m.month)).toEqual(['2026-10']);
  });
});

describe('issue key', () => {
  it('matches the SQL normalization used by the build', async () => {
    const { normalizeMessage, normalizeStep } = await import('@qaily/contracts');
    const msg = 'Error: Timeout 1200ms exceeded at line 42 (attempt 3)';
    const step = 'And I archive "TASK-123" with code "123456" 2 times';
    const [row] = await query(`SELECT regexp_replace('${msg}', '\\d+', 'N', 'g') AS m,
      regexp_replace(regexp_replace('${step.replaceAll("'", "''")}', '"[^"]*"', '"S"', 'g'), '\\d+', 'N', 'g') AS s`);
    expect(row.m).toBe(normalizeMessage(msg));
    expect(row.s).toBe(normalizeStep(step));
  });
});
