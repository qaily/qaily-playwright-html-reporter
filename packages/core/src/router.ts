// Hash routing (#/page?a=1&b=2): works on any static host, from a subpath, and needs no server rewrites.

import type { RouteParams } from '@qaily/contracts';

export interface Route {
  page: string;
  params: RouteParams;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const params: RouteParams = {};
  for (const [k, v] of new URLSearchParams(query)) params[k] = v;
  return { page: decodeURIComponent(path.split('/')[0] ?? ''), params };
}

export function formatHash(page: string, params: RouteParams = {}): string {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString();
  return `#/${encodeURIComponent(page)}${query ? `?${query}` : ''}`;
}

export class Router {
  private listeners = new Set<(r: Route) => void>();
  private onHash = () => this.emit();

  private readonly win: Window;

  constructor(win: Window = window) {
    this.win = win;
    win.addEventListener('hashchange', this.onHash);
  }

  get current(): Route {
    return parseHash(this.win.location.hash);
  }

  go(page: string, params: RouteParams = {}): void {
    this.win.location.hash = formatHash(page, params);
  }

  /** Changes the URL without a history entry and without notifying listeners. */
  replace(page: string, params: RouteParams): void {
    this.win.history.replaceState(null, '', formatHash(page, params));
  }

  subscribe(fn: (r: Route) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  destroy(): void {
    this.win.removeEventListener('hashchange', this.onHash);
  }

  private emit(): void {
    const route = this.current;
    for (const fn of this.listeners) fn(route);
  }
}
