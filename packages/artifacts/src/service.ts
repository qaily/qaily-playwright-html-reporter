import type {
  ArtifactMode,
  ArtifactStatus,
  ArtifactsApi,
  CredentialsInfo,
  SecretPersistence,
  SecretsApi,
  Settings,
} from '@qaily/contracts';
import { isExpired, isTemporary, maskKeyId, parseCredentials, type AwsCredentials } from './credentials.ts';
import { presignS3Get } from './sigv4.ts';

// Attachment links are signed when a test opens and may be used much later, by a lazy image or a trace link.
const ATTACHMENT_LINK_SECONDS = 3600;
// Reused for half their life, so a reused link always has at least 30 minutes left.
const ATTACHMENT_REUSE_SECONDS = 1800;
// Report data links are used immediately.
const DATA_LINK_SECONDS = 600;

export interface ArtifactServiceOptions {
  /** Report root, e.g. https://org.github.io/reports/ */
  baseUrl: URL;
  /** Data dir, e.g. <base>/data/ */
  dataUrl: URL;
  /** True when served by `qaily-report serve` (it resolves artifacts itself). */
  localServer: boolean;
  secrets: SecretsApi;
  s3: () => Settings['connections']['s3'];
  /** Runs when the viewer forgets the credentials, after they are gone. */
  onForget?: () => void;
}

/** S3 object key of an attachment: <prefix>/<run_id>/<attachment path>. */
export function artifactKey(prefix: string, runId: string, path: string): string {
  const clean = path.replace(/^\/+/, '');
  if (clean.split('/').includes('..') || runId.includes('/') || runId.includes('..')) throw new Error('Invalid attachment path');
  return [prefix.replace(/^\/+|\/+$/g, ''), runId, clean].filter(Boolean).join('/');
}

export class ArtifactService implements ArtifactsApi {
  private opts: ArtifactServiceOptions;
  private listeners = new Set<(s: ArtifactStatus) => void>();
  private cache = new Map<string, { url: string; until: number }>();

  constructor(opts: ArtifactServiceOptions) {
    this.opts = opts;
  }

  private get mode(): ArtifactMode {
    if (this.opts.localServer) return 'local';
    return this.opts.s3().bucket ? 'browser' : 'static';
  }

  status(): ArtifactStatus {
    const mode = this.mode;
    if (mode === 'static') return { mode, ready: true, message: 'Attachments are published with the report.' };
    if (mode === 'local') return { mode, ready: true, message: 'Served by the local report server (local files first, then S3).' };
    const c = this.loadCredentials();
    return c
      ? { mode, ready: true, message: `Signed in the browser as ${maskKeyId(c.accessKeyId)}.` }
      : { mode, ready: false, message: 'Attachments are stored in S3-compatible storage. Connect credentials to view them.' };
  }

  async url(runId: string, path: string, opts: { downloadName?: string; fresh?: boolean } = {}): Promise<string | null> {
    const mode = this.mode;
    if (mode === 'static') {
      const clean = path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
      return new URL(`runs/${encodeURIComponent(runId)}/${clean}`, this.opts.dataUrl).href;
    }
    if (mode === 'local') {
      const u = new URL('__qaily/artifact', this.opts.baseUrl);
      u.searchParams.set('run', runId);
      u.searchParams.set('path', path);
      if (opts.downloadName) u.searchParams.set('download', opts.downloadName);
      return u.href;
    }

    const creds = this.loadCredentials();
    if (!creds) return null;
    const s3 = this.opts.s3();
    const key = artifactKey(s3.prefix, runId, path);
    const cacheKey = `${key}|${opts.downloadName ?? ''}`;
    const hit = this.cache.get(cacheKey);
    if (hit && hit.until > Date.now() && !opts.fresh) return hit.url;
    const url = await this.sign(creds, key, ATTACHMENT_LINK_SECONDS, opts.downloadName);
    // Never reuse a URL past the credentials' own expiry.
    const credsUntil = creds.expiration ? Date.parse(creds.expiration) - 60_000 : Infinity;
    this.cache.set(cacheKey, { url, until: Math.min(Date.now() + ATTACHMENT_REUSE_SECONDS * 1000, credsUntil) });
    return url;
  }

  /** Signed URL of a report data file (path relative to the data folder), or null when credentials are needed first. */
  async dataFileUrl(path: string): Promise<string | null> {
    const clean = path.replace(/^\/+/, '');
    if (clean.split('/').includes('..')) throw new Error('Invalid report data path');
    const creds = this.loadCredentials();
    if (!creds) return null;
    const prefix = this.opts.s3().dataPrefix.replace(/^\/+|\/+$/g, '');
    return this.sign(creds, [prefix, clean].filter(Boolean).join('/'), DATA_LINK_SECONDS);
  }

  private sign(creds: AwsCredentials, key: string, expiresIn: number, downloadName?: string): Promise<string> {
    const s3 = this.opts.s3();
    return presignS3Get({
      bucket: s3.bucket,
      region: s3.region,
      endpoint: s3.endpoint,
      pathStyle: s3.pathStyle,
      key,
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
      expiresIn,
      downloadName,
    });
  }

  async text(runId: string, path: string, maxBytes = 256 * 1024): Promise<{ text: string; truncated: boolean }> {
    const url = await this.url(runId, path);
    if (!url) throw new Error('This attachment is stored in S3-compatible storage. Connect credentials in Settings → Tokens to view it.');
    let res: Response;
    try {
      res = await fetch(url, { headers: { Range: `bytes=0-${maxBytes - 1}` } });
    } catch {
      // A browser hides the reason from scripts; missing CORS rules are the usual one (images still load without them).
      throw new Error(`Could not read ${path} from storage. Check that the bucket's CORS rules allow ${globalThis.location?.origin ?? 'this site'}, and your network connection.`);
    }
    if (res.status === 404 && this.mode === 'local') {
      // The local server says exactly why (e.g. no bucket configured).
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? 'This attachment was not found locally or in S3.');
    }
    if (res.status === 404) {
      throw new Error(
        this.mode === 'static'
          ? 'This attachment is not in the report. Large artifacts (traces, logs) may be stored in S3 instead.'
          : 'This attachment was not found locally or in S3.',
      );
    }
    if (res.status === 403) throw new Error('S3 refused access (403). The credentials may lack s3:GetObject on this prefix, or have expired.');
    if (!res.ok) throw new Error(`Could not load ${path} (${res.status})`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const total = Number(res.headers.get('content-range')?.split('/')[1] ?? buf.length);
    const slice = buf.subarray(0, maxBytes);
    return { text: new TextDecoder().decode(slice), truncated: total > slice.length || buf.length > maxBytes };
  }

  connect(pasted: string, persistence: SecretPersistence): CredentialsInfo {
    const creds = parseCredentials(pasted);
    this.opts.secrets.set('awsCredentials', JSON.stringify(creds), persistence);
    this.cache.clear();
    this.emit();
    return this.credentials()!;
  }

  disconnect(): void {
    this.opts.secrets.forget('awsCredentials');
    this.cache.clear();
    this.emit();
    this.opts.onForget?.();
  }

  /** True when the viewer chose to keep valid credentials on this device. */
  keepsCredentialsOnDevice(): boolean {
    return this.credentials()?.persistence === 'local';
  }

  credentials(): CredentialsInfo | null {
    const c = this.loadCredentials();
    if (!c) return null;
    return {
      keyId: maskKeyId(c.accessKeyId),
      temporary: isTemporary(c),
      expiration: c.expiration ?? null,
      persistence: this.opts.secrets.persistence('awsCredentials'),
    };
  }

  subscribe(fn: (s: ArtifactStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Stored credentials, or null. Expired ones are deleted on the spot. */
  private loadCredentials(): AwsCredentials | null {
    const raw = this.opts.secrets.get('awsCredentials');
    if (!raw) return null;
    try {
      const c = JSON.parse(raw) as AwsCredentials;
      if (!c.accessKeyId || !c.secretAccessKey) throw new Error('incomplete');
      if (isExpired(c)) {
        this.opts.secrets.forget('awsCredentials');
        this.cache.clear();
        queueMicrotask(() => this.emit());
        return null;
      }
      return c;
    } catch {
      this.opts.secrets.forget('awsCredentials');
      return null;
    }
  }

  private emit(): void {
    const s = this.status();
    for (const fn of this.listeners) fn(s);
  }
}
