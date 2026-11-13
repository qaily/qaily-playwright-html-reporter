import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type SecretsApi } from '@qaily/contracts';
import {
  BRIDGE_SCRIPT,
  BridgeError,
  StorageBridge,
  bridgeOrigins,
  bridgePage,
  bridgePaths,
  type BridgeHost,
} from '../src/index.ts';
import { ArtifactService } from '../src/service.ts';

const REPORT = 'https://org.github.io';
const STORAGE = 'https://s3.example.test';
const PATHS = ['/acme/runs/', '/acme/data/'];
const signed = (path: string) => `${STORAGE}${path}?X-Amz-Signature=abc`;

type Listener = (e: { source: unknown; origin: string; data: unknown }) => void;

interface HarnessOptions {
  allowed?: string[];
  pageOrigin?: string;
  store?: (url: string, init: RequestInit) => Response;
  loads?: boolean;
  version?: number;
  readyMs?: number;
}

/**
 * The real bridge script, run in a fake storage-origin window and wired to a StorageBridge through postMessage.
 * `store` answers the bridge's own (same-origin) fetches.
 */
function bridgeFor(opts: HarnessOptions = {}) {
  const fetches: { url: string; init: RequestInit }[] = [];
  const reportListeners = new Set<Listener>();
  const host: BridgeHost = {
    open(src) {
      expect(new URL(src).origin).toBe(STORAGE);
      let deliver: ((data: unknown) => void) | null = null;
      const target = {
        postMessage(data: unknown, targetOrigin: string) {
          if (targetOrigin !== STORAGE) return;
          const copy = structuredClone(data);
          queueMicrotask(() => deliver?.(copy));
        },
      };
      if (opts.loads === false) return { target, close() {} };
      const parent = {
        postMessage(data: unknown, targetOrigin: string) {
          if (targetOrigin !== '*' && targetOrigin !== (opts.pageOrigin ?? REPORT)) return;
          queueMicrotask(() => reportListeners.forEach((l) => l({ source: target, origin: STORAGE, data })));
        },
      };
      const script = BRIDGE_SCRIPT.replace(
        '__CONFIG__',
        JSON.stringify({ origins: opts.allowed ?? [REPORT], paths: PATHS, maxBytes: 1000, writable: '/team-settings.json', version: opts.version ?? 1 }),
      );
      const fakeFetch = async (url: string, init: RequestInit) => {
        fetches.push({ url, init });
        return (opts.store ?? (() => new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } })))(url, init);
      };
      new Function('parent', 'location', 'addEventListener', 'fetch', script)(
        parent,
        { origin: STORAGE },
        (type: string, fn: (e: unknown) => void) => {
          if (type === 'message') deliver = (data) => fn({ source: parent, origin: opts.pageOrigin ?? REPORT, data });
        },
        fakeFetch,
      );
      return { target, close() {} };
    },
    listen(fn) {
      reportListeners.add(fn);
      return () => reportListeners.delete(fn);
    },
  };
  const bridge = new StorageBridge(async () => `${STORAGE}/acme/data/qaily-bridge.html?X-Amz-Signature=abc`, { host, readyMs: opts.readyMs ?? 200 });
  return { bridge, fetches };
}

describe('storage bridge', () => {
  it('reads signed files through the bridge page, with Range', async () => {
    const { bridge, fetches } = bridgeFor({
      store: () => new Response('abc', { status: 206, headers: { 'content-type': 'text/plain', 'content-range': 'bytes 0-2/10', 'x-secret': 'no' } }),
    });
    const res = await bridge.fetch(signed('/acme/runs/r1/attachments/a.txt'), { headers: { Range: 'bytes=0-2', Authorization: 'x' } });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('abc');
    expect(res.headers.get('content-range')).toBe('bytes 0-2/10');
    expect(res.headers.get('x-secret')).toBeNull();
    expect(fetches[0].url).toBe(signed('/acme/runs/r1/attachments/a.txt'));
    // Only Range and Content-Type are passed on.
    expect(fetches[0].init.headers).toEqual({ Range: 'bytes=0-2' });
  });

  it('passes on storage errors as responses', async () => {
    const { bridge } = bridgeFor({ store: () => new Response('<Error/>', { status: 403 }) });
    expect((await bridge.fetch(signed('/acme/data/catalog.json'))).status).toBe(403);
  });

  it('refuses requests outside its folders, unsigned, to other hosts, or writes other than team settings', async () => {
    const { bridge, fetches } = bridgeFor();
    const refused = (url: string, init?: RequestInit) => expect(bridge.fetch(url, init)).rejects.toThrow(/refused/);
    await refused(signed('/other-bucket/data/catalog.json'));
    await refused(`${STORAGE}/acme/data/catalog.json`);
    await refused(signed('/acme/data/catalog.json'), { method: 'DELETE' });
    await refused(signed('/acme/data/catalog.json'), { method: 'PUT', body: '{}' });
    await expect(bridge.fetch('https://elsewhere.test/acme/data/x?X-Amz-Signature=a')).rejects.toThrow(/is on/);
    expect(fetches).toHaveLength(0);
    const put = await bridge.fetch(signed('/acme/data/team-settings.json'), { method: 'PUT', body: '{"a":1}', headers: { 'Content-Type': 'application/json' } });
    expect(put.status).toBe(200);
    expect(fetches[0].init).toMatchObject({ method: 'PUT', body: '{"a":1}' });
  });

  it('tells a report it is not allowed to use the bridge', async () => {
    const { bridge, fetches } = bridgeFor({ allowed: ['https://other.github.io'] });
    await expect(bridge.fetch(signed('/acme/data/catalog.json'))).rejects.toThrow(/not allowed to use this storage bridge/);
    expect(fetches).toHaveLength(0);
  });

  it('explains a bridge that never loads, or is the wrong version', async () => {
    const missing = bridgeFor({ loads: false, readyMs: 20 }).bridge;
    await expect(missing.fetch(signed('/acme/data/catalog.json'))).rejects.toBeInstanceOf(BridgeError);
    await expect(missing.fetch(signed('/acme/data/catalog.json'))).rejects.toThrow(/did not load.*Storage access to Direct/s);
    await expect(bridgeFor({ version: 99 }).bridge.fetch(signed('/acme/data/catalog.json'))).rejects.toThrow(/version 99/);
  });

  it('refuses files above its size limit', async () => {
    const { bridge } = bridgeFor({ store: () => new Response('x', { headers: { 'content-length': '5000' } }) });
    await expect(bridge.fetch(signed('/acme/runs/r/attachments/big.zip'))).rejects.toThrow(/too large/);
  });
});

describe('bridge page', () => {
  it('knows the run and data folders of the bucket', () => {
    expect(bridgePaths({ bucket: 'acme', prefix: '/jsonl-report/', dataPrefix: 'qaily-data', pathStyle: true })).toEqual([
      '/acme/jsonl-report/',
      '/acme/qaily-data/',
    ]);
    expect(bridgePaths({ bucket: 'acme', prefix: 'a b', dataPrefix: 'a b', pathStyle: false })).toEqual(['/a%20b/']);
  });

  it('takes bare https origins only', () => {
    expect(bridgeOrigins(['https://org.github.io/', ' http://127.0.0.1:4173 '])).toEqual(['https://org.github.io', 'http://127.0.0.1:4173']);
    expect(() => bridgeOrigins(['https://org.github.io/report/'])).toThrow(/Not an origin/);
    expect(() => bridgeOrigins(['http://org.github.io'])).toThrow(/Not an origin/);
    expect(() => bridgeOrigins([])).toThrow(/at least one/);
  });

  it('is one self-contained HTML file', () => {
    const page = bridgePage({ origins: [REPORT], paths: PATHS });
    expect(page).toContain('"origins":["https://org.github.io"]');
    expect(page).not.toMatch(/<script[^>]+src=/);
    expect(page).not.toContain('__CONFIG__');
  });
});

describe('artifacts through the bridge', () => {
  afterEach(() => vi.unstubAllGlobals());

  function service(transport: 'cors' | 'bridge', host: BridgeHost) {
    const creds = JSON.stringify({ accessKeyId: 'AKIAEXAMPLEKEY', secretAccessKey: 'example-secret-value' });
    const secrets = { get: () => creds, set: () => {}, forget: () => {}, persistence: () => 'session' } as unknown as SecretsApi;
    return new ArtifactService({
      baseUrl: new URL(`${REPORT}/`),
      dataUrl: new URL(`${REPORT}/data/`),
      localServer: false,
      secrets,
      s3: () => ({ ...DEFAULT_SETTINGS.connections.s3, bucket: 'acme', region: 'auto', endpoint: STORAGE, pathStyle: true, prefix: 'runs', dataPrefix: 'data', transport }),
      bridgeHost: host,
    });
  }

  /** A host whose bridge page answers every request with `body`. */
  function simpleHost(body: string, seen: string[]): BridgeHost {
    const listeners = new Set<Listener>();
    return {
      open(src) {
        seen.push(src);
        const target = {
          postMessage(data: unknown) {
            const m = data as { id: string; url: string };
            seen.push(m.url);
            queueMicrotask(() => listeners.forEach((l) => l({ source: target, origin: STORAGE, data: { type: 'qaily-response', id: m.id, status: 200, headers: { 'content-type': 'image/png' }, body: new TextEncoder().encode(body).buffer } })));
          },
        };
        queueMicrotask(() => listeners.forEach((l) => l({ source: target, origin: STORAGE, data: { type: 'qaily-bridge-ready', version: 1 } })));
        return { target, close() {} };
      },
      listen(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
  }

  it('reads attachments through the bridge when Storage access is Bridge, and directly otherwise', async () => {
    const seen: string[] = [];
    const direct = vi.fn(async () => new Response('direct'));
    vi.stubGlobal('fetch', direct);
    const viaBridge = service('bridge', simpleHost('bridged', seen));
    expect((await viaBridge.text('r1', 'attachments/a.txt')).text).toBe('bridged');
    // The bridge page itself is signed under the data folder and served as HTML.
    expect(seen[0]).toContain('/acme/data/qaily-bridge.html');
    expect(decodeURIComponent(seen[0])).toContain('response-content-type=text/html');
    expect(seen[1]).toContain('/acme/runs/r1/attachments/a.txt');
    expect(direct).not.toHaveBeenCalled();

    const plain = service('cors', simpleHost('bridged', []));
    expect((await plain.text('r1', 'attachments/a.txt')).text).toBe('direct');
  });

  it('shows images through the bridge as blob: URLs, and signed links otherwise', async () => {
    const viaBridge = service('bridge', simpleHost('png', []));
    const url = (await viaBridge.imageUrl('r1', 'attachments/shot.png'))!;
    expect(url).toMatch(/^blob:/);
    expect(await viaBridge.imageUrl('r1', 'attachments/shot.png')).toBe(url);
    const plain = service('cors', simpleHost('png', []));
    expect(await plain.imageUrl('r1', 'attachments/shot.png')).toContain('X-Amz-Signature=');
  });
});
