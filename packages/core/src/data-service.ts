import type { Catalog, CatalogMonth, DataApi, DateRange, RunDetail, RunRow } from '@qaily/contracts';
import { fetchJsonl, readJsonl } from './jsonl.ts';
import { pruneCachedRollups, readCachedRollup, writeCachedRollup } from './rollup-cache.ts';

/** Reads the data dir from a bucket instead of the website. */
export interface BucketData {
  /** Signed URL of a file in the data dir, or null when credentials are needed first. */
  signedUrl(path: string): Promise<string | null>;
  /** True when rollups may be stored on this device: the viewer chose to remember their credentials here. */
  keepOnDevice(): boolean;
}

/** The bucket can't be read right now. The message says what the viewer can do about it. */
export class DataAccessError extends Error {}

/** Months (YYYY-MM, UTC) touched by a range. */
export function monthsInRange(range: DateRange): string[] {
  const months: string[] = [];
  const cur = new Date(Date.UTC(range.from.getUTCFullYear(), range.from.getUTCMonth(), 1));
  const last = new Date(range.to.getTime() - 1);
  while (cur <= last) {
    months.push(cur.toISOString().slice(0, 7));
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return months;
}

export class DataService implements DataApi {
  private catalogPromise: Promise<Catalog> | null = null;
  private monthRuns = new Map<string, Promise<RunRow[]>>(); // key: month@hash
  private duck: Promise<import('./duckdb.ts').DuckSession> | null = null;
  private details = new Map<string, Promise<RunDetail>>();

  readonly dataUrl: URL;
  private readonly bucket: BucketData | null;
  private _accessProblem: DataAccessError | null = null;

  constructor(dataUrl: URL, bucket: BucketData | null = null) {
    this.dataUrl = dataUrl;
    this.bucket = bucket;
  }

  get readsFromBucket(): boolean {
    return this.bucket !== null;
  }

  /** Why the last catalog check couldn't read the bucket; null when it could. Data already loaded stays usable. */
  get accessProblem(): DataAccessError | null {
    return this._accessProblem;
  }

  catalog(opts: { refresh?: boolean } = {}): Promise<Catalog> {
    if (!this.catalogPromise || opts.refresh) {
      const next = this.fetchJson<Catalog>('catalog.json', 'no-cache').then((catalog) => {
        this._accessProblem = null;
        if (this.bucket?.keepOnDevice()) {
          void pruneCachedRollups(catalog.months.flatMap((m) => Object.values(m.files).filter(Boolean).map((path) => ({ path: path as string, hash: m.hash }))));
        }
        return catalog;
      });
      // Keep the last good catalog if a refresh fails. With none yet, the next call tries again.
      const previous = this.catalogPromise;
      const current: Promise<Catalog> = next.catch((err) => {
        if (err instanceof DataAccessError) this._accessProblem = err;
        if (previous) return previous;
        if (this.catalogPromise === current) this.catalogPromise = null;
        throw err;
      });
      this.catalogPromise = current;
    }
    return this.catalogPromise;
  }

  async runs(range: DateRange): Promise<RunRow[]> {
    const months = await this.monthsFor(range);
    const lists = await Promise.all(months.map((m) => this.runsOfMonth(m)));
    const from = range.from.getTime();
    const to = range.to.getTime();
    return lists
      .flat()
      .filter((r) => {
        const t = Date.parse(r.started_at);
        return t >= from && t < to;
      })
      .sort((a, b) => b.started_at.localeCompare(a.started_at));
  }

  async query<T>(sql: string, range: DateRange): Promise<T[]> {
    const months = await this.monthsFor(range);
    this.duck ??= import('./duckdb.ts').then((m) => m.openDuckSession());
    const session = await this.duck;
    return session.query<T>(sql, months, this.bucket ? { bytes: (path, hash) => this.rollupBytes(path, hash) } : { url: (path) => new URL(path, this.dataUrl).href });
  }

  async json<T>(path: string): Promise<T | null> {
    try {
      return await this.fetchJson<T>(path, 'no-cache');
    } catch {
      return null;
    }
  }

  run(runId: string): Promise<RunRow | null> {
    return this.findRun(runId);
  }

  runDetail(runId: string): Promise<RunDetail> {
    let p = this.details.get(runId);
    if (!p) {
      const file = (name: string) => {
        if (!this.bucket) return fetchJsonl(this.url(`runs/${encodeURIComponent(runId)}/${name}.jsonl.gz`));
        const path = `runs/${runId}/${name}.jsonl.gz`;
        return this.fromBucket(path).then((res) => readJsonl(res, path));
      };
      p = Promise.all([
        this.findRun(runId),
        file('test-summary'),
        file('test_details'),
        file('errors'),
        file('attachments-index'),
      ]).then(([run, summaries, details, errors, attachments]) => {
        if (!run && summaries.length === 0) throw new Error(`Run ${runId} was not found`);
        return { run, summaries, details, errors, attachments } as RunDetail;
      });
      p.catch(() => this.details.delete(runId));
      this.details.set(runId, p);
      // Keep memory bounded: only the most recent few runs stay cached.
      if (this.details.size > 8) this.details.delete(this.details.keys().next().value!);
    }
    return p;
  }

  private async findRun(runId: string): Promise<RunRow | null> {
    const catalog = await this.catalog();
    // Run ids start with their ISO start time, so the month is usually right there.
    const guess = /^\d{4}-\d{2}/.exec(runId)?.[0];
    const ordered = [...catalog.months].sort((a, b) => Number(b.month === guess) - Number(a.month === guess));
    for (const m of ordered) {
      const hit = (await this.runsOfMonth(m)).find((r) => r.run_id === runId);
      if (hit) return hit;
    }
    return null;
  }

  /** Absolute URL of a file in the data dir. */
  url(path: string): string {
    return new URL(path, this.dataUrl).href;
  }

  private async monthsFor(range: DateRange): Promise<CatalogMonth[]> {
    const wanted = new Set(monthsInRange(range));
    return (await this.catalog()).months.filter((m) => wanted.has(m.month));
  }

  private runsOfMonth(m: CatalogMonth): Promise<RunRow[]> {
    const key = `${m.month}@${m.hash}`;
    let p = this.monthRuns.get(key);
    if (!p) {
      p = this.bucket
        ? this.rollupBytes(m.files.runs, m.hash).then((bytes) => JSON.parse(new TextDecoder().decode(bytes)) as RunRow[])
        : this.fetchJson<RunRow[]>(`${m.files.runs}?v=${m.hash}`, 'default');
      p.catch(() => this.monthRuns.delete(key));
      this.monthRuns.set(key, p);
    }
    return p;
  }

  private async fetchJson<T>(path: string, cache: RequestCache): Promise<T> {
    const res = this.bucket ? await this.fromBucket(path, { cache }) : await fetch(new URL(path, this.dataUrl), { cache });
    if (!res.ok) throw new Error(`Could not load ${path} (${res.status})`);
    const type = res.headers.get('content-type') ?? '';
    // Static hosts may answer a missing file with an HTML page and status 200.
    if (type.includes('text/html')) throw new Error(`Could not load ${path} (got HTML)`);
    return (await res.json()) as T;
  }

  /** A rollup from this device when allowed and present, otherwise from the bucket. */
  private async rollupBytes(path: string, hash: string): Promise<Uint8Array> {
    const keep = this.bucket!.keepOnDevice();
    const hit = keep ? await readCachedRollup(path, hash) : null;
    if (hit) return hit;
    const res = await this.fromBucket(path);
    if (!res.ok) throw new Error(`Could not load ${path} (${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (keep) await writeCachedRollup(path, hash, bytes);
    return bytes;
  }

  /** Fetches a data file with a fresh signed link. Errors name the file, never the link. */
  private async fromBucket(path: string, init?: RequestInit): Promise<Response> {
    const file = path.split('?')[0];
    const url = await this.bucket!.signedUrl(file);
    if (!url) throw new DataAccessError('Report data is stored in the bucket. Connect credentials in Settings → Tokens to view it.');
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch {
      throw new DataAccessError(`Could not read ${file} from storage. Check that the bucket's CORS rules allow ${globalThis.location?.origin ?? 'this site'}, and your network connection.`);
    }
    if (res.status === 403) throw new DataAccessError(`Storage refused access to ${file} (403). The credentials may lack read access to the report data, or have expired.`);
    return res;
  }
}
