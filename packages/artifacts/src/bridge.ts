// The report's side of the storage bridge (see bridge-page.ts): a fetch-like function that sends signed URLs to the
// bridge page in a hidden iframe and turns its answers back into Responses.

import { BRIDGE_FILE, BRIDGE_VERSION } from './bridge-page.ts';

/** A failure the bridge explained; its message is meant for people. */
export class BridgeError extends Error {
  override name = 'BridgeError';
}

interface MessageLike {
  source: unknown;
  origin: string;
  data: unknown;
}

/** The browser parts the bridge uses; replaced in tests. */
export interface BridgeHost {
  /** Loads the bridge page; `target` is the frame's window. */
  open(src: string): { target: { postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void }; close(): void; alive?(): boolean };
  listen(fn: (e: MessageLike) => void): () => void;
}

export const domBridgeHost: BridgeHost = {
  open(src) {
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.title = 'Storage bridge';
    frame.setAttribute('aria-hidden', 'true');
    frame.referrerPolicy = 'no-referrer';
    frame.src = src;
    // Outside <body>: the app replaces the body's content when it starts, which would unload the bridge.
    document.documentElement.append(frame);
    return { target: frame.contentWindow!, close: () => frame.remove(), alive: () => frame.isConnected };
  },
  listen(fn) {
    const handler = (e: MessageEvent) => fn(e);
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  },
};

interface Pending {
  resolve(r: Response): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface Frame {
  origin: string;
  target: ReturnType<BridgeHost['open']>['target'];
  close(): void;
  alive(): boolean;
  ready: Promise<void>;
}

export interface StorageBridgeOptions {
  host?: BridgeHost;
  /** How long the bridge page may take to load. */
  readyMs?: number;
  /** How long one request may take, including the download. */
  requestMs?: number;
  /** Requests in flight at once. */
  maxConcurrent?: number;
}

export class StorageBridge {
  private readonly src: () => Promise<string | null>;
  private readonly host: BridgeHost;
  private readonly readyMs: number;
  private readonly requestMs: number;
  private readonly maxConcurrent: number;
  private frame: Frame | null = null;
  private opening: Promise<Frame> | null = null;
  private pending = new Map<string, Pending>();
  private active = 0;
  private queue: (() => void)[] = [];
  private seq = 0;
  private onReady: ((source: unknown, version: unknown) => void) | null = null;

  /** `src` signs the bridge page's URL, or gives null when credentials are needed first. */
  constructor(src: () => Promise<string | null>, opts: StorageBridgeOptions = {}) {
    this.src = src;
    this.host = opts.host ?? domBridgeHost;
    this.readyMs = opts.readyMs ?? 20_000;
    this.requestMs = opts.requestMs ?? 300_000;
    this.maxConcurrent = opts.maxConcurrent ?? 6;
    this.host.listen((e) => this.receive(e));
  }

  /** Like fetch, for signed bucket URLs. Throws BridgeError with a readable message when the bridge can't help. */
  async fetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
    const href = String(url);
    const frame = await this.frameFor(new URL(href).origin);
    // A request made while the page is still loading waits for it: earlier messages would be lost.
    await frame.ready;
    await this.slot();
    try {
      return await this.send(frame, href, init);
    } finally {
      this.release();
    }
  }

  /** Removes the frame, e.g. when the bucket location changes. */
  close(): void {
    this.frame?.close();
    this.frame = null;
    this.opening = null;
  }

  private async frameFor(origin: string): Promise<Frame> {
    if (this.frame && !this.frame.alive()) this.close();
    if (this.frame?.origin === origin) return this.frame;
    if (!this.opening) {
      this.opening = this.open().finally(() => (this.opening = null));
    }
    const frame = await this.opening;
    if (frame.origin !== origin) {
      throw new BridgeError(`The storage bridge is on ${frame.origin}, but this file is on ${origin}.`);
    }
    return frame;
  }

  private async open(): Promise<Frame> {
    this.close();
    const src = await this.src();
    if (!src) throw new BridgeError('Report data is stored in the bucket. Connect credentials in Settings → Tokens to view it.');
    const origin = new URL(src).origin;
    const opened = this.host.open(src);
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.onReady = null;
        reject(
          new BridgeError(
            `The storage bridge did not load from ${origin}. Check that ${BRIDGE_FILE} is in the data folder (qaily-report bridge --origin ${globalThis.location?.origin ?? '<this site>'}), and that this browser trusts the storage's certificate. Or set Settings → Connections → Storage access to Direct.`,
          ),
        );
      }, this.readyMs);
      this.onReady = (source, version) => {
        if (source !== opened.target) return;
        clearTimeout(timer);
        this.onReady = null;
        if (version !== BRIDGE_VERSION) {
          reject(new BridgeError(`The storage bridge in the bucket is version ${String(version)}, this report needs ${BRIDGE_VERSION}. Upload it again with qaily-report bridge.`));
        } else resolve();
      };
    });
    const frame: Frame = { origin, target: opened.target, close: opened.close, alive: opened.alive ?? (() => true), ready };
    this.frame = frame;
    try {
      await ready;
    } catch (err) {
      if (this.frame === frame) this.close();
      throw err;
    }
    return frame;
  }

  private send(frame: Frame, url: string, init: RequestInit): Promise<Response> {
    const id = `${Date.now().toString(36)}-${(this.seq++).toString(36)}`;
    const headers = new Headers(init.headers);
    const pick: Record<string, string> = {};
    for (const name of ['Range', 'Content-Type']) {
      const value = headers.get(name);
      if (value !== null) pick[name] = value;
    }
    if (init.body != null && typeof init.body !== 'string') throw new BridgeError('The storage bridge only sends text bodies.');
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('The storage bridge did not answer in time.'));
      }, this.requestMs);
      this.pending.set(id, { resolve, reject, timer });
      frame.target.postMessage({ type: 'qaily-fetch', id, url, method: init.method ?? 'GET', headers: pick, body: init.body ?? undefined }, frame.origin);
    });
  }

  private receive(e: MessageLike): void {
    const m = e.data as { type?: string; id?: string; version?: unknown } | null;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'qaily-bridge-ready') return this.onReady?.(e.source, m.version);
    const frame = this.frame;
    if (m.type !== 'qaily-response' || !frame || e.source !== frame.target || e.origin !== frame.origin || typeof m.id !== 'string') return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    const r = m as { error?: string; status?: number; statusText?: string; headers?: Record<string, string>; body?: ArrayBuffer | null };
    if (r.error || typeof r.status !== 'number') return p.reject(new BridgeError(r.error ?? 'The storage bridge sent an invalid answer.'));
    const status = r.status < 200 || r.status > 599 ? 502 : r.status;
    const empty = status === 204 || status === 304 || r.body == null;
    p.resolve(new Response(empty ? null : r.body, { status, statusText: r.statusText ?? '', headers: r.headers ?? {} }));
  }

  private slot(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(() => {
      this.active++;
      resolve();
    }));
  }

  private release(): void {
    this.active--;
    this.queue.shift()?.();
  }
}

/** True for an error the bridge explained (works across packages, where instanceof may not). */
export function isBridgeError(err: unknown): err is Error {
  return err instanceof Error && err.name === 'BridgeError';
}
