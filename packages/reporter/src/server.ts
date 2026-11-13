// Local report server: serves the built app and the data dir, plus a few loopback-only
// write endpoints. Also used as Vite dev-server middleware (see packages/shell/vite.config.ts).

import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { artifactKey } from '@qaily/artifacts';
import { addToAiIndex, attachmentCheckOf, parseAiRecord, parseAiRecordPath, type AiIndex } from '@qaily/contracts';
import { LocalSigner, readS3Config } from './s3-signer.ts';

/** HTTP status of a GET for the first byte; the body is not read. */
async function fetchStatus(url: string): Promise<number> {
  const ctrl = new AbortController();
  const res = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: ctrl.signal });
  ctrl.abort();
  return res.status;
}

export interface HandlerOptions {
  /** Built app (index.html, assets/). Omit when Vite serves the app. */
  appDir?: string;
  dataDir: string;
  /** Raw run folders; used for runs/<id>/attachments/* when the data dir has no copy. */
  attachmentsDir?: string;
  /** Signs S3 artifact URLs; defaults to this machine's AWS login. */
  signer?: LocalSigner;
  /** Playwright's trace viewer, served at /trace/ (the Trace viewer setting is then trace/ or ../trace/). */
  traceViewerDir?: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.gz': 'application/gzip',
  '.parquet': 'application/vnd.apache.parquet',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
  '.webm': 'video/webm',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
};

const MAX_SETTINGS_BYTES = 256 * 1024;
const MAX_AI_RECORD_BYTES = 1024 * 1024;
const TRACE_VIEWER_ORIGIN = 'https://trace.playwright.dev';

/** Resolves a URL path inside root, or null if it escapes root. */
function safeJoin(root: string, urlPath: string): string | null {
  const full = resolve(root, '.' + decodeURIComponent(urlPath));
  return full === root || full.startsWith(root + sep) ? full : null;
}

function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** Writes are allowed only from this machine and only from this origin's own pages. */
function writeAllowed(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  return isLoopback(req) && (site === undefined || site === 'same-origin' || site === 'none');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** The trace viewer may call the artifact route; anything else must be this origin's own pages. */
function artifactCallerAllowed(req: IncomingMessage): boolean {
  if (!isLoopback(req)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site === undefined || site === 'same-origin' || site === 'none') return true;
  return req.headers.origin === TRACE_VIEWER_ORIGIN;
}

function sendFile(req: IncomingMessage, res: ServerResponse, file: string, downloadName?: string): void {
  const st = statSync(file);
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers: Record<string, string | number> = {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    ETag: etag,
    // Data changes between builds; let the browser revalidate with the ETag.
    'Cache-Control': file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  // Lets trace.playwright.dev load a trace straight from this server ("Trace viewer" button). Only that origin.
  if (req.headers.origin === TRACE_VIEWER_ORIGIN) headers['Access-Control-Allow-Origin'] = TRACE_VIEWER_ORIGIN;
  if (downloadName) headers['Content-Disposition'] = `attachment; filename="${downloadName.replace(/["\\\r\n]/g, '_')}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range) {
    let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, st.size - 1);
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('Body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Atomic write, so a reader never sees half a file. */
function writeFileAtomic(file: string, content: string): void {
  mkdirSync(resolve(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

/**
 * Returns a request handler. It answers /__qaily/*, /data/* and (with appDir) the app,
 * and calls next() for anything else, so it can sit in front of Vite.
 */
export function createHandler(opts: HandlerOptions) {
  const dataDir = resolve(opts.dataDir);
  const appDir = opts.appDir ? resolve(opts.appDir) : undefined;
  const attachmentsDir = opts.attachmentsDir ? resolve(opts.attachmentsDir) : undefined;
  const signer = opts.signer ?? new LocalSigner();

  /** A run attachment on disk: the data dir copy first, then the raw run folders. */
  const localAttachment = (runId: string, path: string): string | null => {
    for (const [root, rel] of [[dataDir, `/runs/${runId}/${path}`], [attachmentsDir, `/${runId}/${path}`]] as const) {
      if (!root) continue;
      const file = safeJoin(root, rel);
      if (file && existsSync(file) && statSync(file).isFile()) return file;
    }
    return null;
  };

  return async (req: IncomingMessage, res: ServerResponse, next?: () => void): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path === '/__qaily/status') {
      sendJson(res, 200, { ok: true, writes: writeAllowed(req), artifacts: true, s3: { configured: !!readS3Config(dataDir).bucket } });
      return;
    }

    if (path === '/__qaily/s3/status') {
      if (!writeAllowed(req)) return sendJson(res, 403, { error: 'Only from this machine' });
      const cfg = readS3Config(dataDir);
      if (!cfg.bucket) return sendJson(res, 200, { configured: false, ok: false });
      return sendJson(res, 200, { configured: true, bucket: cfg.bucket, region: cfg.region, prefix: cfg.prefix, ...(await signer.status()) });
    }

    if (path === '/__qaily/artifact') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Use GET' });
      if (!artifactCallerAllowed(req)) return sendJson(res, 403, { error: 'Artifacts are served to this machine only' });
      const runId = url.searchParams.get('run') ?? '';
      const relPath = (url.searchParams.get('path') ?? '').replace(/^\/+/, '');
      const download = url.searchParams.get('download') ?? undefined;
      if (!runId || !relPath || runId.includes('/') || runId.includes('..') || relPath.split('/').includes('..')) {
        return sendJson(res, 400, { error: 'Invalid run or path' });
      }
      const check = url.searchParams.has('check');
      const local = localAttachment(runId, relPath);
      if (local) return check ? sendJson(res, 200, { status: 'ok' }) : sendFile(req, res, local, download ?? undefined);
      const cfg = readS3Config(dataDir);
      if (!cfg.bucket) {
        return check ? sendJson(res, 200, { status: 'missing' }) : sendJson(res, 404, { error: 'Not found locally, and no S3 bucket is configured' });
      }
      try {
        const signed = await signer.presign(cfg, artifactKey(cfg.prefix, runId, relPath), download);
        if (check) {
          // Whether the file is still in the bucket: a lifecycle rule may have removed it.
          const status = await fetchStatus(signed).then(attachmentCheckOf, () => 'unknown' as const);
          return sendJson(res, 200, { status });
        }
        const headers: Record<string, string> = { Location: signed, 'Cache-Control': 'no-store' };
        if (req.headers.origin === TRACE_VIEWER_ORIGIN) headers['Access-Control-Allow-Origin'] = TRACE_VIEWER_ORIGIN;
        res.writeHead(302, headers);
        res.end();
        return;
      } catch (err) {
        return sendJson(res, 502, { error: `Could not sign the S3 URL: ${err instanceof Error ? err.message : err}` });
      }
    }

    if (path === '/__qaily/settings') {
      if (req.method !== 'PUT') return sendJson(res, 405, { error: 'Use PUT' });
      if (!writeAllowed(req)) return sendJson(res, 403, { error: 'Writes are allowed only from this machine' });
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
        return sendJson(res, 415, { error: 'Expected application/json' });
      }
      try {
        const parsed: unknown = JSON.parse(await readBody(req, MAX_SETTINGS_BYTES));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object');
        writeFileAtomic(join(dataDir, 'settings.json'), JSON.stringify(parsed, null, 2) + '\n');
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
      }
    }

    if (path === '/__qaily/ai') {
      if (req.method !== 'PUT') return sendJson(res, 405, { error: 'Use PUT' });
      if (!writeAllowed(req)) return sendJson(res, 403, { error: 'Writes are allowed only from this machine' });
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return sendJson(res, 415, { error: 'Expected application/json' });
      const recordPath = url.searchParams.get('path') ?? '';
      const target = parseAiRecordPath(recordPath);
      if (!target) return sendJson(res, 400, { error: 'Invalid AI record path' });
      try {
        const record = parseAiRecord(JSON.parse(await readBody(req, MAX_AI_RECORD_BYTES)));
        if (!record) throw new Error('Not a valid AI record');
        if (record.kind !== target.kind || record.runId !== target.runId || (record.testId ?? undefined) !== target.testId) {
          throw new Error('The record does not match its path');
        }
        const aiDir = join(dataDir, 'ai');
        writeFileAtomic(join(aiDir, recordPath), JSON.stringify(record, null, 2) + '\n');
        let index: AiIndex | null = null;
        try {
          index = JSON.parse(readFileSync(join(aiDir, 'index.json'), 'utf8')) as AiIndex;
        } catch {
          index = null;
        }
        writeFileAtomic(join(aiDir, 'index.json'), JSON.stringify(addToAiIndex(index, record), null, 2) + '\n');
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid body' });
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (next) return next();
      return sendJson(res, 405, { error: 'Method not allowed' });
    }

    if (path.startsWith('/data/')) {
      const rel = path.slice('/data'.length);
      const file = safeJoin(dataDir, rel);
      if (file && existsSync(file) && statSync(file).isFile()) return sendFile(req, res, file);
      // Attachments are not copied by `build`; read them from the raw run folders.
      const attachment = /^\/runs\/([^/]+)\/(attachments\/.+)$/.exec(rel);
      if (attachment && attachmentsDir) {
        const raw = safeJoin(attachmentsDir, `/${attachment[1]}/${attachment[2]}`);
        if (raw && existsSync(raw) && statSync(raw).isFile()) return sendFile(req, res, raw);
      }
      return sendJson(res, 404, { error: 'Not found' });
    }

    if (opts.traceViewerDir && (path === '/trace' || path.startsWith('/trace/'))) {
      const rel = path === '/trace' || path === '/trace/' ? '/index.html' : path.slice('/trace'.length);
      const file = safeJoin(resolve(opts.traceViewerDir), rel);
      if (file && existsSync(file) && statSync(file).isFile()) return sendFile(req, res, file);
      return sendJson(res, 404, { error: 'Not found' });
    }

    if (appDir) {
      const file = safeJoin(appDir, path === '/' ? '/index.html' : path);
      if (file && existsSync(file) && statSync(file).isFile()) return sendFile(req, res, file);
      // Hash routing means every page is index.html.
      return sendFile(req, res, join(appDir, 'index.html'));
    }
    next?.();
  };
}

export interface ServeOptions extends HandlerOptions {
  port: number;
  host: string;
  log?: (msg: string) => void;
}

export function serve(opts: ServeOptions): Promise<void> {
  const handler = createHandler(opts);
  const server = createServer((req, res) => {
    handler(req, res).catch((err) => sendJson(res, 500, { error: String(err) }));
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      opts.log?.(`Serving on http://${opts.host === '0.0.0.0' ? 'localhost' : opts.host}:${opts.port}`);
      if (opts.host !== '127.0.0.1' && opts.host !== 'localhost') {
        opts.log?.('Warning: listening beyond this machine. Write endpoints still accept loopback clients only.');
      }
      resolvePromise();
    });
  });
}
