// Agent Host Protocol client: JSON-RPC 2.0 over one WebSocket.
// No DOM access, so it runs under Node for tests.

export interface RpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export class RpcError extends Error {
  readonly method: string;
  readonly code: number;
  readonly data: unknown;
  constructor(method: string, error: RpcErrorShape) {
    super(`${method} failed (${error.code}): ${error.message}`);
    this.name = 'RpcError';
    this.method = method;
    this.code = error.code;
    this.data = error.data;
  }
}

export class ConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionError';
  }
}

/** The subset of WebSocket the client uses, so tests can pass a fake. */
export interface SocketLike {
  addEventListener(type: 'open' | 'message' | 'close' | 'error', fn: (ev: any) => void): void;
  send(text: string): void;
  close(code?: number): void;
}
export type SocketCtor = new (url: string) => SocketLike;

export interface AhpClientOptions {
  WebSocketImpl?: SocketCtor;
  /** Per-request timeout. Default 30 s. */
  requestTimeoutMs?: number;
  /** Keep-alive interval; 0 disables. Default 30 s. */
  pingIntervalMs?: number;
  /** Raw frame tap for debugging. Frames can contain tokens: never log them unredacted. */
  onFrame?: (dir: 'in' | 'out', text: string) => void;
}

type Pending = { method: string; resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
type Listener = { method: string; channel: string; handler: (params: any, msg: any) => void };

export class AhpClient {
  readonly url: string;
  private WebSocketImpl: SocketCtor;
  private requestTimeoutMs: number;
  private pingIntervalMs: number;
  private onFrame?: AhpClientOptions['onFrame'];
  private ws: SocketLike | null = null;
  private nextId = 1;
  private clientSeq = 1;
  private pending = new Map<number, Pending>();
  private listeners: Listener[] = [];
  private closeHandlers: ((info: { code: number; reason: string }) => void)[] = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingSupported = true;
  closed = false;

  constructor(url: string, options: AhpClientOptions = {}) {
    this.url = url;
    this.WebSocketImpl = options.WebSocketImpl ?? (globalThis.WebSocket as unknown as SocketCtor);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.pingIntervalMs = options.pingIntervalMs ?? 30_000;
    this.onFrame = options.onFrame;
  }

  /** Opens the socket. Rejects if it closes before opening (wrong token → 403, or host not running). */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let opened = false;
      const ws = new this.WebSocketImpl(this.url);
      this.ws = ws;
      ws.addEventListener('open', () => {
        opened = true;
        this.startPing();
        resolve();
      });
      ws.addEventListener('message', (ev) => this.handleFrame(ev.data));
      ws.addEventListener('close', (ev) => {
        this.closed = true;
        this.stopPing();
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new ConnectionError(`Connection closed during ${p.method}`));
        }
        this.pending.clear();
        if (!opened) {
          reject(
            new ConnectionError(
              'Could not connect. Either the agent host is not running at this URL, the connection token was rejected (403), ' +
                'or the host failed to start (503). Chrome may also be waiting for you to allow local network access.',
            ),
          );
          return;
        }
        for (const h of this.closeHandlers) h({ code: ev.code, reason: ev.reason });
      });
      // Errors are always followed by 'close', which does the real handling.
      ws.addEventListener('error', () => {});
    });
  }

  request<T = any>(method: string, params: Record<string, unknown>, timeoutMs = this.requestTimeoutMs): Promise<T> {
    if (!this.ws || this.closed) return Promise.reject(new ConnectionError('Not connected'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ConnectionError(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  /** Client mutation on a channel. Returns the clientSeq used (one counter per connection). */
  dispatch(channel: string, action: Record<string, unknown>): number {
    const clientSeq = this.clientSeq++;
    this.notify('dispatchAction', { channel, clientSeq, action });
    return clientSeq;
  }

  /** Listen for server notifications. channel '*' matches any channel. Returns an unsubscribe function. */
  on(method: string, channel: string, handler: (params: any, msg: any) => void): () => void {
    const entry = { method, channel, handler };
    this.listeners.push(entry);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== entry);
    };
  }

  onClose(handler: (info: { code: number; reason: string }) => void): void {
    this.closeHandlers.push(handler);
  }

  close(): void {
    this.stopPing();
    if (this.ws && !this.closed) this.ws.close(1000);
  }

  private send(obj: unknown): void {
    if (!this.ws) throw new ConnectionError('Not connected');
    const text = JSON.stringify(obj);
    this.onFrame?.('out', text);
    this.ws.send(text);
  }

  private handleFrame(data: unknown): void {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer);
    this.onFrame?.('in', text);
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      console.warn('[ahp] non-JSON frame ignored');
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcError(p.method, msg.error));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method !== 'string') return;
    const channel = msg.params?.channel;
    for (const l of [...this.listeners]) {
      if (l.method !== msg.method) continue;
      if (l.channel !== '*' && l.channel !== channel) continue;
      try {
        l.handler(msg.params, msg);
      } catch (e) {
        console.error('[ahp] listener failed', e);
      }
    }
  }

  private startPing(): void {
    if (!this.pingIntervalMs) return;
    this.pingTimer = setInterval(() => {
      if (!this.pingSupported) return;
      this.request('ping', { channel: 'ahp-root://' }, 10_000).catch((e) => {
        if (e instanceof RpcError && e.code === -32601) this.pingSupported = false;
        else console.warn('[ahp] ping failed:', e.message);
      });
    }, this.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}
