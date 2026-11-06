import type { SocketLike } from '../src/ahp-client.ts';

/** Fake WebSocket: records sent frames, lets the test push frames and lifecycle events. */
export class FakeSocket implements SocketLike {
  static last: FakeSocket;
  url: string;
  sent: any[] = [];
  private handlers: Record<string, ((ev: any) => void)[]> = {};
  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
  }
  addEventListener(type: string, fn: (ev: any) => void) {
    (this.handlers[type] ??= []).push(fn);
  }
  emit(type: string, ev: any = {}) {
    for (const fn of this.handlers[type] ?? []) fn(ev);
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close(code = 1000) {
    this.emit('close', { code, reason: '' });
  }
  open() {
    this.emit('open');
  }
  push(obj: unknown) {
    this.emit('message', { data: JSON.stringify(obj) });
  }
}

export const tick = () => new Promise((r) => setTimeout(r, 0));
