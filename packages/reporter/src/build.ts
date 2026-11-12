// `qaily-report build`: turns a folder of raw run folders into the files the report reads.
//
//   <out>/catalog.json                      what exists, with a hash per month for cache busting
//   <out>/rollups/runs-YYYY-MM.json         one row per run (dashboards need nothing else)
//   <out>/rollups/tests-YYYY-MM.parquet     one row per (run, test)
//   <out>/rollups/issues-YYYY-MM.parquet    one row per first-attempt error, with an issue signature
//   <out>/rollups/steps-YYYY-MM.parquet     one row per top-level step of each attempt (+ explicit coverage labels)
//   <out>/runs/<run_id>/<file>.jsonl.gz     raw per-run files, loaded when a run or test is opened
//
// Months whose runs did not change since the last build are skipped. Runs whose folders are gone (a bucket lifecycle
// rule expired them) keep their rows from the previous build, so <out> must hold that build: `pull` it first.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import {
  CATALOG_SCHEMA_VERSION,
  RUN_FILES,
  type Catalog,
  type CatalogMonth,
  type RunFile,
  type RunRow,
  type SettingsLayer,
} from '@qaily/contracts';
import { runRowFromManifest, monthOf } from './manifest.ts';
import { findRunFile, scanRunDirs, selectCompleteRuns, type RunDir } from './scan.ts';

export interface BuildOptions {
  inDir: string;
  outDir: string;
  /** Overrides data.requireSyncComplete from <out>/settings.json. */
  requireSyncComplete?: boolean;
  force?: boolean;
  /** Drops months before this one (YYYY-MM) for good, also when run folders or older rollups still have them. */
  pruneBefore?: string;
  log?: (msg: string) => void;
}

export interface BuildResult {
  catalog: Catalog;
  rebuiltMonths: string[];
  skippedRuns: string[];
}

const sql = (s: string) => `'${s.replaceAll("'", "''")}'`;
const sqlList = (items: string[]) => `[${items.map(sql).join(', ')}]`;

function readJsonIfExists<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export async function build(opts: BuildOptions): Promise<BuildResult> {
  const log = opts.log ?? (() => {});
  const inDir = resolve(opts.inDir);
  const outDir = resolve(opts.outDir);
  mkdirSync(join(outDir, 'rollups'), { recursive: true });

  const team = readJsonIfExists<SettingsLayer>(join(outDir, 'settings.json'));
  const requireSync = opts.requireSyncComplete ?? team?.data?.requireSyncComplete ?? true;

  const { included, skipped } = selectCompleteRuns(scanRunDirs(inDir), requireSync);
  if (skipped.length) log(`Skipping ${skipped.length} run(s) without .sync-complete`);

  const previous = readJsonIfExists<Catalog>(join(outDir, 'catalog.json'));
  const previousHash = new Map(previous?.months.map((m) => [m.month, m.hash]) ?? []);
  const prunedBefore = [opts.pruneBefore, previous?.prunedBefore].filter((m): m is string => !!m).sort().pop();
  const pruned = (month: string) => !!prunedBefore && month < prunedBefore;

  // Runs per month, from the manifests.
  const byMonth = new Map<string, { dirs: RunDir[]; rows: RunRow[] }>();
  for (const dir of included) {
    const row = runRowFromManifest(dir.runId, dir.files.manifest!);
    if (!row) {
      log(`Skipping ${dir.runId}: manifest has no run_start`);
      continue;
    }
    const month = monthOf(row.started_at);
    if (pruned(month)) continue;
    const bucket = byMonth.get(month) ?? { dirs: [], rows: [] };
    bucket.dirs.push(dir);
    bucket.rows.push(row);
    byMonth.set(month, bucket);
  }

  // Months built before stay even when their run folders are gone (a bucket lifecycle rule expired them): the
  // previous catalog, and rollups on disk in case that catalog was published without them.
  const allMonths = new Set<string>([...byMonth.keys(), ...(previous?.months.map((m) => m.month) ?? []), ...builtMonthsOnDisk(outDir)]);
  for (const month of [...allMonths]) {
    if (!pruned(month)) continue;
    allMonths.delete(month);
    for (const f of Object.values(monthFiles(month))) rmSync(join(outDir, f), { force: true });
    log(`Pruned ${month}`);
  }

  const months: CatalogMonth[] = [];
  const monthRows = new Map<string, RunRow[]>();
  const rebuilt: string[] = [];
  const toCopy: RunDir[] = [];
  let db: { instance: DuckDBInstance; conn: DuckDBConnection } | null = null;

  for (const month of [...allMonths].sort().reverse()) {
    const files = monthFiles(month);
    const at = (f: string) => join(outDir, f);
    const hasPrevious = [files.runs, files.tests, files.issues].every((f) => existsSync(at(f)));
    const prevRows = hasPrevious ? (readJsonIfExists<RunRow[]>(at(files.runs)) ?? []) : [];
    const prevSources = hasPrevious ? readJsonIfExists<Sources>(at(files.sources)) : null;

    // A run that has lost files since it was built is being expired, not changed: its built rows are kept.
    const current = byMonth.get(month) ?? { dirs: [], rows: [] };
    const expiring = new Set(
      current.dirs.filter((d) => prevSources?.[d.runId]?.files.some((f) => !d.files[f as RunFile])).map((d) => d.runId),
    );
    const dirs = current.dirs.filter((d) => !expiring.has(d.runId));
    const curRows = current.rows.filter((r) => !expiring.has(r.run_id));
    const curIds = new Set(dirs.map((d) => d.runId));
    const kept = prevRows.filter((r) => !curIds.has(r.run_id));

    const sources: Sources = {};
    for (const d of dirs) sources[d.runId] = { fp: d.fingerprint, files: Object.keys(d.files) };
    for (const r of kept) sources[r.run_id] = prevSources?.[r.run_id] ?? { fp: 'kept', files: [] };

    const rows = [...curRows, ...kept].sort((a, b) => b.started_at.localeCompare(a.started_at));
    if (!rows.length) continue;
    const hash = createHash('sha1')
      .update(`v${CATALOG_SCHEMA_VERSION}\n`)
      .update(Object.entries(sources).map(([id, s]) => `${id}=${s.fp}`).sort().join('\n'))
      .digest('hex')
      .slice(0, 12);
    const { sources: _, ...catalogFiles } = files;
    months.push({ month, runs: rows.length, hash, files: catalogFiles });
    monthRows.set(month, rows);
    toCopy.push(...dirs);

    const upToDate = !opts.force && hasPrevious && existsSync(at(files.steps)) && previousHash.get(month) === hash;
    if (upToDate) {
      if (!prevSources) writeFileSync(at(files.sources), JSON.stringify(sources));
      continue;
    }

    log(`Building ${month} (${curRows.length} runs${kept.length ? `, ${kept.length} kept from the previous build` : ''})`);
    if (!db) {
      const instance = await DuckDBInstance.create(':memory:');
      db = { instance, conn: await instance.connect() };
    }
    const fresh = { tests: `${at(files.tests)}.new`, issues: `${at(files.issues)}.new`, steps: `${at(files.steps)}.new` };
    await buildMonthParquet(db.conn, dirs, curRows, fresh);
    const keptIds = kept.map((r) => r.run_id);
    for (const [name, order] of [['tests', 'run_id, test_id'], ['issues', 'issue_sig, run_id'], ['steps', 'run_id, test_id, attempt, idx']] as const) {
      const target = at(files[name]);
      if (keptIds.length && existsSync(target)) {
        await db.conn.run(`COPY (
          SELECT * FROM read_parquet(${sql(fresh[name])})
          UNION ALL BY NAME
          SELECT * FROM read_parquet(${sql(target)}) WHERE run_id IN (SELECT unnest(${sqlList(keptIds)}))
          ORDER BY ${order}
        ) TO ${sql(`${target}.merged`)} (FORMAT parquet, COMPRESSION zstd)`);
        renameSync(`${target}.merged`, target);
        rmSync(fresh[name]);
      } else {
        renameSync(fresh[name], target);
      }
    }
    writeFileSync(at(files.runs), JSON.stringify(rows));
    writeFileSync(at(files.sources), JSON.stringify(sources));
    rebuilt.push(month);
  }

  db?.conn.closeSync();

  let copied = 0;
  for (const dir of toCopy) copied += copyRawRun(dir, join(outDir, 'runs', dir.runId));
  if (copied) log(`Copied ${copied} raw file(s)`);

  const latest = months.length ? monthRows.get(months[0].month)![0]?.started_at ?? null : null;
  const catalog: Catalog = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    runCount: months.reduce((n, m) => n + m.runs, 0),
    latestRunAt: latest,
    months,
    runsPath: 'runs',
    ...(prunedBefore ? { prunedBefore } : {}),
  };
  writeFileSync(join(outDir, 'catalog.json'), JSON.stringify(catalog, null, 2));
  return { catalog, rebuiltMonths: rebuilt, skippedRuns: skipped.map((r) => r.runId) };
}

/**
 * What each built run was made from, per month (rollups/sources-YYYY-MM.json). Only `build` reads it: to tell a run
 * that changed from one whose folder is being expired, and to keep a month's hash when its runs are only kept.
 */
type Sources = Record<string, { fp: string; files: string[] }>;

function monthFiles(month: string) {
  return {
    runs: `rollups/runs-${month}.json`,
    tests: `rollups/tests-${month}.parquet`,
    issues: `rollups/issues-${month}.parquet`,
    steps: `rollups/steps-${month}.parquet`,
    sources: `rollups/sources-${month}.json`,
  };
}

function builtMonthsOnDisk(outDir: string): string[] {
  return readdirSync(join(outDir, 'rollups'))
    .map((f) => /^runs-(\d{4}-\d{2})\.json$/.exec(f)?.[1])
    .filter((m): m is string => !!m);
}

async function buildMonthParquet(
  conn: DuckDBConnection,
  dirs: RunDir[],
  rows: RunRow[],
  out: { tests: string; issues: string; steps: string },
): Promise<void> {
  const filesOf = (name: (typeof RUN_FILES)[number]) => dirs.map((d) => d.files[name]).filter((f): f is string => !!f);
  const summaries = filesOf('test-summary');
  const details = filesOf('test_details');
  const errors = filesOf('errors');
  const coverage = filesOf('step-coverage');

  await conn.run(`
    CREATE OR REPLACE TEMP TABLE run_info (run_id VARCHAR, branch VARCHAR, environment VARCHAR, category VARCHAR, suite VARCHAR);
    CREATE OR REPLACE TEMP TABLE ts (run_id VARCHAR, test_id VARCHAR, started_at TIMESTAMP, title VARCHAR, status VARCHAR,
      tags VARCHAR[], dur_ms BIGINT, project VARCHAR, file VARCHAR, err_summary VARCHAR, err_type VARCHAR, failed_step VARCHAR);
    CREATE OR REPLACE TEMP TABLE td (run_id VARCHAR, test_id VARCHAR, attempt INTEGER,
      steps STRUCT(idx INTEGER, title VARCHAR, dur_ms BIGINT, status VARCHAR)[]);
    CREATE OR REPLACE TEMP TABLE ann (run_id VARCHAR, test_id VARCHAR, attempt INTEGER, idx INTEGER,
      component VARCHAR, scenario VARCHAR, feature VARCHAR, area VARCHAR);
    CREATE OR REPLACE TEMP TABLE er (run_id VARCHAR, test_id VARCHAR, attempt INTEGER, err_msg VARCHAR, err_type VARCHAR,
      failed_step VARCHAR, err_file VARCHAR, err_line INTEGER, locator VARCHAR);
  `);

  const appender = await conn.createAppender('run_info');
  for (const r of rows) {
    appender.appendVarchar(r.run_id);
    for (const v of [r.branch, r.environment, r.category, r.tag]) {
      if (v == null) appender.appendNull();
      else appender.appendVarchar(v);
    }
    appender.endRow();
  }
  appender.closeSync();

  const readOpts = `format='newline_delimited', ignore_errors=true`;
  if (summaries.length) {
    await conn.run(`INSERT INTO ts SELECT * FROM read_json(${sqlList(summaries)}, ${readOpts}, columns={
      run_id:'VARCHAR', test_id:'VARCHAR', started_at:'TIMESTAMP', title:'VARCHAR', status:'VARCHAR', tags:'VARCHAR[]',
      dur_ms:'BIGINT', project:'VARCHAR', file:'VARCHAR', err_summary:'VARCHAR', err_type:'VARCHAR', failed_step:'VARCHAR'})`);
  }
  if (details.length) {
    await conn.run(`INSERT INTO td SELECT * FROM read_json(${sqlList(details)}, ${readOpts},
      columns={run_id:'VARCHAR', test_id:'VARCHAR', attempt:'INTEGER',
        steps:'STRUCT(idx INTEGER, title VARCHAR, dur_ms BIGINT, status VARCHAR)[]'})`);
  }
  if (coverage.length) {
    await conn.run(`INSERT INTO ann SELECT * FROM read_json(${sqlList(coverage)}, ${readOpts}, columns={
      run_id:'VARCHAR', test_id:'VARCHAR', attempt:'INTEGER', idx:'INTEGER',
      component:'VARCHAR', scenario:'VARCHAR', feature:'VARCHAR', area:'VARCHAR'})`);
  }
  if (errors.length) {
    await conn.run(`INSERT INTO er SELECT * FROM read_json(${sqlList(errors)}, ${readOpts}, columns={
      run_id:'VARCHAR', test_id:'VARCHAR', attempt:'INTEGER', err_msg:'VARCHAR', err_type:'VARCHAR', failed_step:'VARCHAR',
      err_file:'VARCHAR', err_line:'INTEGER', locator:'VARCHAR'})`);
  }

  // Issue signature: same grouping as the first Qaily report (digits → N, quoted strings in the failed step → "S"),
  // hashed so it is stable across runs and can key AI notes.
  await conn.run(`
    CREATE OR REPLACE TEMP TABLE issues AS
    WITH first_attempt AS (
      SELECT *, row_number() OVER (PARTITION BY run_id, test_id ORDER BY attempt) AS rn FROM er WHERE err_msg IS NOT NULL
    ), norm AS (
      SELECT run_id, test_id, err_type, err_msg, failed_step, err_file, err_line, locator,
        regexp_replace(err_msg, '\\d+', 'N', 'g') AS norm_msg,
        regexp_replace(regexp_replace(failed_step, '"[^"]*"', '"S"', 'g'), '\\d+', 'N', 'g') AS norm_step
      FROM first_attempt WHERE rn = 1
    )
    SELECT run_id, test_id, left(md5(norm_msg || '|' || coalesce(norm_step, '')), 12) AS issue_sig,
      coalesce(err_type, 'unknown') AS err_type, err_msg, norm_msg, failed_step, norm_step, err_file, err_line, locator
    FROM norm`);

  await conn.run(`COPY (SELECT * FROM issues ORDER BY issue_sig, run_id) TO ${sql(out.issues)} (FORMAT parquet, COMPRESSION zstd)`);

  // Steps, with explicit coverage labels (from step-coverage.jsonl) attached as a list per step.
  await conn.run(`COPY (
    WITH s AS (SELECT run_id, test_id, attempt, unnest(steps) AS st FROM td),
    last AS (SELECT run_id, test_id, max(attempt) AS last_attempt FROM td GROUP BY ALL),
    a AS (
      SELECT run_id, test_id, attempt, idx,
        list({'component': component, 'scenario': scenario, 'feature': feature, 'area': area}) AS cells
      FROM ann GROUP BY ALL
    )
    SELECT s.run_id, s.test_id, s.attempt, s.attempt = last.last_attempt AS final_attempt,
      s.st.idx AS idx, s.st.title AS title, s.st.status AS status, s.st.dur_ms AS dur_ms, a.cells
    FROM s
    JOIN last USING (run_id, test_id)
    LEFT JOIN a ON a.run_id = s.run_id AND a.test_id = s.test_id AND a.attempt = s.attempt AND a.idx = s.st.idx
    ORDER BY s.run_id, s.test_id, s.attempt, idx
  ) TO ${sql(out.steps)} (FORMAT parquet, COMPRESSION zstd)`);

  await conn.run(`COPY (
    SELECT ts.run_id, ts.test_id, ts.started_at, ts.title, ts.status, ts.tags, ts.dur_ms, ts.project, ts.file,
      ts.err_type, ts.err_summary, ts.failed_step,
      coalesce(a.attempts, 1)::INTEGER AS attempts, i.issue_sig,
      ri.branch, ri.environment, ri.category, ri.suite
    FROM ts
    LEFT JOIN (SELECT run_id, test_id, count(*) AS attempts FROM td GROUP BY ALL) a USING (run_id, test_id)
    LEFT JOIN issues i USING (run_id, test_id)
    LEFT JOIN run_info ri USING (run_id)
    ORDER BY ts.run_id, ts.test_id
  ) TO ${sql(out.tests)} (FORMAT parquet, COMPRESSION zstd)`);
}

// The report opens these for every run. Storage may answer 403 instead of 404 for a missing file (AWS does when the
// viewer has no s3:ListBucket), so they always exist, and a 403 can only mean an access problem.
const ALWAYS_WRITTEN = new Set<string>(['manifest', 'test-summary', 'test_details', 'errors', 'attachments-index']);

/** Copies a run's raw JSONL files as .jsonl.gz. Returns the number of files written. */
function copyRawRun(dir: RunDir, dest: string): number {
  let written = 0;
  for (const name of RUN_FILES) {
    const src = findRunFile(dir.dir, name, 'gz');
    const target = join(dest, `${name}.jsonl.gz`);
    if (!src) {
      if (ALWAYS_WRITTEN.has(name) && !existsSync(target)) {
        mkdirSync(dest, { recursive: true });
        writeFileSync(target, gzipSync(''));
        written++;
      }
      continue;
    }
    if (existsSync(target) && statSync(target).mtimeMs >= statSync(src).mtimeMs) continue;
    mkdirSync(dest, { recursive: true });
    if (src.endsWith('.gz')) copyFileSync(src, target);
    else writeFileSync(target, gzipSync(readFileSync(src)));
    written++;
  }
  return written;
}
