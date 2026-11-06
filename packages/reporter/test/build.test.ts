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
