// DuckDB-WASM, single-threaded bundles only: they need no COOP/COEP headers, which GitHub Pages can't send.

import * as duckdb from '@duckdb/duckdb-wasm';
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import type { CatalogMonth } from '@qaily/contracts';
import { ROLLUP_TABLES, tablesInQuery } from './sql-tables.ts';

const BUNDLES: duckdb.DuckDBBundles = {
  mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
  eh: { mainModule: ehWasm, mainWorker: ehWorker },
};

/**
 * Converts Arrow values to plain JS: BigInt and Arrow big numbers (BIGINT, HUGEINT from sum(), DECIMAL)
 * become numbers, list vectors become arrays. Arrow's own toJSON turns big numbers into quoted strings.
 */
function plain(value: unknown): unknown {
  if (value == null || typeof value !== 'object') return typeof value === 'bigint' ? Number(value) : value;
  if (value instanceof Date) return value;
  if (Symbol.toPrimitive in value) return Number(value);
  if (Array.isArray(value)) return value.map(plain);
  const v = value as { toArray?: () => ArrayLike<unknown>; toJSON?: () => unknown; get?: unknown; type?: unknown; length?: unknown };
  // Arrow vectors (LIST values) have type/length/get; struct rows also have toArray() but must stay objects.
  if (typeof v.toArray === 'function' && typeof v.get === 'function' && v.type !== undefined && typeof v.length === 'number') {
    return Array.from(v.toArray(), plain);
  }
  const obj = typeof v.toJSON === 'function' ? (v.toJSON() as Record<string, unknown>) : (value as Record<string, unknown>);
  return Object.fromEntries(Object.keys(obj).map((k) => [k, plain((value as Record<string, unknown>)[k] ?? obj[k])]));
}

/**
 * Where parquet files come from. `url` reads ranges over HTTP from a URL that never expires. `bytes` loads whole files,
 * for signed links: DuckDB keeps one URL per file, which would stop working when the link expires.
 */
export type ParquetSource = { url: (path: string) => string } | { bytes: (path: string, hash: string) => Promise<Uint8Array> };

export interface DuckSession {
  query<T>(sql: string, months: CatalogMonth[], source: ParquetSource): Promise<T[]>;
}

export async function openDuckSession(): Promise<DuckSession> {
  const bundle = await duckdb.selectBundle(BUNDLES);
  const worker = new Worker(bundle.mainWorker!);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(bundle.mainModule);
  const conn = await db.connect();
  const registered = new Set<string>();
  let currentViews = '';
  let queue: Promise<unknown> = Promise.resolve();

  async function ensureViews(sql: string, months: CatalogMonth[], source: ParquetSource): Promise<void> {
    const names = { tests: [] as string[], issues: [] as string[], steps: [] as string[] };
    // Whole files cost a download each, so only fetch what this query reads.
    const wanted = 'bytes' in source ? tablesInQuery(sql) : new Set(ROLLUP_TABLES);
    const missing: { name: string; path: string; hash: string }[] = [];
    for (const m of months) {
      for (const kind of wanted) {
        const path = m.files[kind];
        // Data built before the steps rollup existed has no steps file; the view is then left out.
        if (!path) continue;
        // The hash in the name makes a rebuilt month a new file, so DuckDB never reads a stale cache.
        const name = `${kind}-${m.month}-${m.hash}.parquet`;
        if (!registered.has(name)) missing.push({ name, path, hash: m.hash });
        names[kind].push(name);
      }
    }
    if ('bytes' in source) {
      await Promise.all(
        missing.map(async ({ name, path, hash }) => {
          await db.registerFileBuffer(name, await source.bytes(path, hash));
          registered.add(name);
        }),
      );
    } else {
      for (const { name, path } of missing) {
        await db.registerFileURL(name, source.url(path), duckdb.DuckDBDataProtocol.HTTP, false);
        registered.add(name);
      }
    }
    const key = JSON.stringify(names);
    if (key === currentViews) return;
    for (const kind of ROLLUP_TABLES) {
      if (!names[kind].length) {
        await conn.query(`DROP VIEW IF EXISTS ${kind}`);
        continue;
      }
      const files = names[kind].map((n) => `'${n}'`).join(', ');
      // union_by_name: months built by different versions may differ in columns.
      await conn.query(`CREATE OR REPLACE VIEW ${kind} AS SELECT * FROM read_parquet([${files}], union_by_name = true)`);
    }
    currentViews = key;
  }

  return {
    query<T>(sql: string, months: CatalogMonth[], source: ParquetSource): Promise<T[]> {
      // No data in the range: there are no files to build the views from.
      if (months.length === 0) return Promise.resolve([]);
      // One connection: run queries one after another so view swaps never interleave.
      const run = queue.then(async () => {
        await ensureViews(sql, months, source);
        const table = await conn.query(sql);
        const names = table.schema.fields.map((f) => f.name);
        return table.toArray().map((row) => Object.fromEntries(names.map((n) => [n, plain(row[n])])) as T);
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
