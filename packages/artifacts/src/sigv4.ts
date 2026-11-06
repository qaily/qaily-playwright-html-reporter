// AWS Signature V4 presigned GET URLs for S3, on WebCrypto only.
// The same file runs in the browser and in Node 22, with no AWS SDK.

export interface PresignOptions {
  bucket: string;
  region: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Seconds, max 7 days. Default 600. */
  expiresIn?: number;
  now?: Date;
  /** Makes the browser save the file under this name (sent as response-content-disposition). */
  downloadName?: string;
  /** Override the endpoint host, e.g. "examplebucket.s3.amazonaws.com". Default: <bucket>.s3.<region>.amazonaws.com */
  host?: string;
  /** S3-compatible service, e.g. "storage.googleapis.com" or "http://minio.local:9000". Default: AWS. */
  endpoint?: string;
  /** Put the bucket in the path (host/bucket/key) instead of the host name. MinIO usually needs this. */
  pathStyle?: boolean;
}

const encoder = new TextEncoder();

/** Full endpoint URL, https unless a scheme is given. Throws on anything but a bare http(s) origin. */
export function s3EndpointUrl(endpoint: string): string {
  const raw = endpoint.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error(`Invalid S3 endpoint: ${endpoint}`);
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.pathname !== '/' || url.search || url.username) {
    throw new Error(`Invalid S3 endpoint (use e.g. https://storage.example.com:9000): ${endpoint}`);
  }
  return url.origin;
}

/** RFC 3986 encoding as SigV4 requires: everything except A–Z a–z 0–9 - _ . ~ */
export function uriEncode(value: string, keepSlash = false): string {
  let out = '';
  for (const byte of encoder.encode(value)) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(c) || (keepSlash && c === '/')) out += c;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, encoder.encode(data));
}

/** 20130524T000000Z */
export function amzDate(d: Date): string {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

export async function presignS3Get(o: PresignOptions): Promise<string> {
  const now = o.now ?? new Date();
  const expires = Math.min(Math.max(1, Math.floor(o.expiresIn ?? 600)), 604_800);
  const datetime = amzDate(now);
  const date = datetime.slice(0, 8);
  const endpoint = o.endpoint?.trim() ? new URL(s3EndpointUrl(o.endpoint)) : null;
  const scheme = endpoint?.protocol ?? 'https:';
  const serviceHost = endpoint?.host ?? `s3.${o.region}.amazonaws.com`;
  const host = o.host ?? (o.pathStyle ? serviceHost : `${o.bucket}.${serviceHost}`);
  const scope = `${date}/${o.region}/s3/aws4_request`;
  const keyPath = uriEncode(o.key.replace(/^\/+/, ''), true);
  const path = o.pathStyle && !o.host ? `/${uriEncode(o.bucket)}/${keyPath}` : `/${keyPath}`;

  const params: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${o.accessKeyId}/${scope}`,
    'X-Amz-Date': datetime,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
  };
  if (o.sessionToken) params['X-Amz-Security-Token'] = o.sessionToken;
  if (o.downloadName) {
    params['response-content-disposition'] = `attachment; filename="${o.downloadName.replace(/["\\\r\n]/g, '_')}"`;
  }
  const query = Object.keys(params)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(params[k])}`)
    .join('&');

  const canonicalRequest = ['GET', path, query, `host:${host}`, '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', datetime, scope, await sha256Hex(canonicalRequest)].join('\n');

  let key: ArrayBuffer = await hmac(encoder.encode(`AWS4${o.secretAccessKey}`), date);
  for (const part of [o.region, 's3', 'aws4_request']) key = await hmac(key, part);
  const signature = hex(await hmac(key, stringToSign));

  return `${scheme}//${host}${path}?${query}&X-Amz-Signature=${signature}`;
}
