// AI results: drafts in this browser (IndexedDB), published files read from the report (data/ai/…),
// and writers that publish to the local server or to GitHub.

import {
  addToAiIndex,
  parseAiRecord,
  type AiIndex,
  type AiRecord,
  type StoredAiRecord,
} from '@qaily/contracts';
import type { GitHubRepo } from './github.ts';

export interface AiWriter {
  readonly label: string;
  write(path: string, record: AiRecord): Promise<void>;
}

/** PUT /__qaily/ai?path=… on `qaily-report serve`; the server also updates data/ai/index.json. */
export class LocalServerAiWriter implements AiWriter {
  readonly label = 'this report (local server)';
  private baseUrl: URL;
  constructor(baseUrl: URL) {
    this.baseUrl = baseUrl;
  }
  async write(path: string, record: AiRecord): Promise<void> {
    const url = new URL('__qaily/ai', this.baseUrl);
    url.searchParams.set('path', path);
    const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record) });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Saving failed (${res.status})`);
    }
  }
}

/** One commit with the record and the merged index; GitHub Pages redeploys after it. */
export class GitHubAiWriter implements AiWriter {
  private repo: GitHubRepo;
  private dataPath: string;
  constructor(repo: GitHubRepo, dataPath: string) {
    this.repo = repo;
    this.dataPath = dataPath.replace(/^\/+|\/+$/g, '');
  }
  get label(): string {
    return `GitHub ${this.repo.label}`;
  }
  async write(path: string, record: AiRecord): Promise<void> {
    const root = this.dataPath ? `${this.dataPath}/ai` : 'ai';
    await this.repo.commit(`AI ${record.kind}: ${record.runId}${record.testId ? ` / ${record.testId}` : ''}`, async (read) => {
      let index: AiIndex | null = null;
      try {
        const raw = await read(`${root}/index.json`);
        index = raw ? (JSON.parse(raw) as AiIndex) : null;
      } catch {
        index = null;
      }
      return [
        { path: `${root}/${path}`, content: JSON.stringify(record, null, 2) + '\n' },
        { path: `${root}/index.json`, content: JSON.stringify(addToAiIndex(index, record), null, 2) + '\n' },
      ];
    });
  }
}

interface Row {
  path: string;
  record: AiRecord;
  /** draft = not published; published = sent, waiting for the report to serve it (e.g. Pages redeploy). */
  state: 'draft' | 'published';
}

/** Minimal IndexedDB key-value store, with an in-memory fallback (private windows, tests). */
class LocalRows {
  private mem = new Map<string, Row>();
  private db: Promise<IDBDatabase | null>;

  constructor() {
    this.db = new Promise((resolve) => {
      try {
        if (typeof indexedDB === 'undefined') return resolve(null);
        const req = indexedDB.open('qaily-ai', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('records', { keyPath: 'path' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
    const db = await this.db;
    if (!db) return undefined;
    return new Promise((resolve, reject) => {
      const req = fn(db.transaction('records', mode).objectStore('records'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async all(): Promise<Row[]> {
    const rows = (await this.tx<Row[]>('readonly', (s) => s.getAll() as IDBRequest<Row[]>).catch(() => undefined)) ?? [];
    return [...rows, ...this.mem.values()];
  }
  async get(path: string): Promise<Row | undefined> {
    return this.mem.get(path) ?? (await this.tx<Row>('readonly', (s) => s.get(path) as IDBRequest<Row>).catch(() => undefined));
  }
  async put(row: Row): Promise<void> {
    const saved = await this.tx('readwrite', (s) => s.put(row)).catch(() => undefined);
    if (saved === undefined) this.mem.set(row.path, row);
  }
  async delete(path: string): Promise<void> {
    this.mem.delete(path);
    await this.tx('readwrite', (s) => s.delete(path)).catch(() => undefined);
  }
}

export class AiStore {
  private dataUrl: URL;
  private rows = new LocalRows();
  private published = new Map<string, Promise<AiRecord | null>>();
  private indexPromise: Promise<AiIndex | null> | null = null;

  constructor(dataUrl: URL) {
    this.dataUrl = dataUrl;
  }

  /** Forget cached published files (after publishing or a report refresh). */
  refresh(): void {
    this.published.clear();
    this.indexPromise = null;
  }

  private fetchPublished(path: string): Promise<AiRecord | null> {
    let p = this.published.get(path);
    if (!p) {
      p = fetch(new URL(`ai/${path}`, this.dataUrl), { cache: 'no-cache' })
        .then(async (res) => {
          if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) return null;
          return parseAiRecord(await res.json());
        })
        .catch(() => null);
      this.published.set(path, p);
    }
    return p;
  }

  private publishedIndex(): Promise<AiIndex | null> {
    this.indexPromise ??= fetch(new URL('ai/index.json', this.dataUrl), { cache: 'no-cache' })
      .then(async (res) => (res.ok && (res.headers.get('content-type') ?? '').includes('json') ? ((await res.json()) as AiIndex) : null))
      .catch(() => null);
    return this.indexPromise;
  }

  /** The newest version of a record: local draft, then the report's published file. */
  async get<K extends AiRecord['kind']>(path: string): Promise<StoredAiRecord<K> | null> {
    const [row, pub] = await Promise.all([this.rows.get(path), this.fetchPublished(path)]);
    if (row && (row.state === 'draft' || !pub || Date.parse(pub.createdAt) < Date.parse(row.record.createdAt))) {
      return { path, record: row.record as AiRecord<K>, draft: row.state === 'draft' };
    }
    // The report now serves what we published: the local copy is no longer needed.
    if (row && pub) void this.rows.delete(path);
    return pub ? { path, record: pub as AiRecord<K>, draft: false } : null;
  }

  async saveDraft(path: string, record: AiRecord): Promise<StoredAiRecord> {
    await this.rows.put({ path, record, state: 'draft' });
    return { path, record, draft: true };
  }

  async publish(stored: StoredAiRecord, writer: AiWriter): Promise<void> {
    await writer.write(stored.path, stored.record);
    // Keep showing it until the report serves the published file (Pages takes a minute to redeploy).
    await this.rows.put({ path: stored.path, record: stored.record, state: 'published' });
    this.refresh();
  }

  async discard(path: string): Promise<void> {
    await this.rows.delete(path);
  }

  async runsWithResults(): Promise<Set<string>> {
    const [index, rows] = await Promise.all([this.publishedIndex(), this.rows.all()]);
    const runs = new Set(Object.keys(index?.runs ?? {}));
    for (const r of rows) runs.add(r.record.runId);
    return runs;
  }
}
