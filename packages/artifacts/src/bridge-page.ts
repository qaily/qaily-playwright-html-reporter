// The storage bridge: a small page stored in the bucket (qaily-bridge.html). The report loads it in a hidden iframe.
// Its script runs on the storage's own origin, so its requests to the bucket are same-origin and need no CORS rules.
// It passes the answers to the report with postMessage.
//
// It holds no credentials: the report sends URLs it has already signed, and the signature is the permission. The page
// only narrows what it does with them: requests from the allowed report origins, to its own origin, under the
// bucket's run and data folders, signed, GET/HEAD (PUT only for team-settings.json), Range/Content-Type headers only.

import { TEAM_SETTINGS_FILE } from './team-settings.ts';

export const BRIDGE_FILE = 'qaily-bridge.html';
/** Bumped when the message format changes; the report checks it. */
export const BRIDGE_VERSION = 1;
const MAX_BYTES = 1024 * 1024 * 1024;

export interface BridgePageOptions {
  /** Report origins allowed to use the bridge, e.g. https://org.github.io. */
  origins: string[];
  /** URL path prefixes the bridge may read, e.g. /bucket/runs/ (see bridgePaths). */
  paths: string[];
  maxBytes?: number;
}

/** The URL path prefixes of the run and data folders, as signed URLs for this bucket carry them. */
export function bridgePaths(s3: { bucket: string; prefix: string; dataPrefix: string; pathStyle: boolean }): string[] {
  const enc = (p: string) => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const base = s3.pathStyle ? `/${encodeURIComponent(s3.bucket)}/` : '/';
  const paths = [s3.prefix, s3.dataPrefix].map((p) => (enc(p) ? `${base}${enc(p)}/` : base));
  return [...new Set(paths)];
}

/** Checks an origin list for the bridge: bare https origins (http only for localhost). */
export function bridgeOrigins(list: string[]): string[] {
  const out = list.map((raw) => raw.trim()).filter(Boolean).map((raw) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`Not an origin: ${raw}`);
    }
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.origin !== raw.replace(/\/$/, '') || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) {
      throw new Error(`Not an origin: ${raw}. Use the scheme and host only, e.g. https://org.github.io`);
    }
    return url.origin;
  });
  if (!out.length) throw new Error('The bridge needs at least one report origin, e.g. --origin https://org.github.io');
  return [...new Set(out)];
}

/** The bridge page. Self-contained: no other scripts, nothing stored. */
export function bridgePage(o: BridgePageOptions): string {
  const config = JSON.stringify({
    origins: bridgeOrigins(o.origins),
    paths: o.paths,
    maxBytes: o.maxBytes ?? MAX_BYTES,
    writable: `/${TEAM_SETTINGS_FILE}`,
    version: BRIDGE_VERSION,
  }).replace(/</g, '\\u003c');
  return `<!doctype html>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<title>Qaily storage bridge</title>
<script>
${BRIDGE_SCRIPT.replace('__CONFIG__', config)}
</script>
`;
}

/** The bridge's script. Kept as plain JavaScript so anyone can review exactly what runs on the storage origin. */
export const BRIDGE_SCRIPT = `(function () {
  'use strict';
  var C = __CONFIG__;
  var HEADERS = ['Range', 'Content-Type'];
  var EXPOSED = ['content-type', 'content-range', 'content-length', 'etag', 'last-modified'];

  function allowed(raw, method) {
    var url;
    try { url = new URL(raw); } catch (e) { return false; }
    if (url.origin !== location.origin) return false;
    if (!url.searchParams.has('X-Amz-Signature')) return false;
    if (!C.paths.some(function (p) { return url.pathname.indexOf(p) === 0; })) return false;
    if (method === 'GET' || method === 'HEAD') return true;
    return method === 'PUT' && url.pathname.slice(-C.writable.length) === C.writable;
  }

  addEventListener('message', async function (e) {
    var m = e.data;
    if (e.source !== parent || !m || m.type !== 'qaily-fetch' || typeof m.id !== 'string') return;
    function reply(msg, transfer) {
      msg.type = 'qaily-response';
      msg.id = m.id;
      parent.postMessage(msg, e.origin, transfer || []);
    }
    if (C.origins.indexOf(e.origin) < 0) return reply({ error: 'This report (' + e.origin + ') is not allowed to use this storage bridge. Upload it again with qaily-report bridge --origin ' + e.origin + '.' });
    var method = String(m.method || 'GET').toUpperCase();
    if (!allowed(m.url, method)) return reply({ error: 'The storage bridge refused this request (' + method + ').' });
    var headers = {};
    HEADERS.forEach(function (h) { if (m.headers && typeof m.headers[h] === 'string') headers[h] = m.headers[h]; });
    try {
      var res = await fetch(m.url, { method: method, headers: headers, body: method === 'PUT' ? String(m.body || '') : undefined, cache: 'no-store', credentials: 'omit' });
      if (Number(res.headers.get('content-length') || 0) > C.maxBytes) return reply({ error: 'The file is too large for the storage bridge.' });
      var body = method === 'HEAD' ? null : await res.arrayBuffer();
      var out = {};
      EXPOSED.forEach(function (h) { var v = res.headers.get(h); if (v !== null) out[h] = v; });
      reply({ status: res.status, statusText: res.statusText, headers: out, body: body }, body ? [body] : []);
    } catch (err) {
      reply({ error: 'The storage bridge could not reach the bucket: ' + (err && err.message ? err.message : err) });
    }
  });

  // Says it has loaded; carries nothing else, so any page may hear it.
  parent.postMessage({ type: 'qaily-bridge-ready', version: C.version }, '*');
})();`;
