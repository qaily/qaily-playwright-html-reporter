// Opens a trace in a self-hosted Playwright trace viewer without giving it a URL: the report reads the trace itself
// (website, bucket with CORS, local server) and posts the file to the viewer's tab. The viewer listens for
// { method: 'load', params: { trace: Blob } } (Playwright 1.58 and later at least; not documented), so the storage
// needs no CORS rules for the viewer's origin.

/** The viewer tab as the report sees it. */
export interface TraceViewerWindow {
  readonly closed: boolean;
  readonly location: { readonly href: string };
  postMessage(message: unknown, targetOrigin: string): void;
}

export type TraceSendResult = 'loaded' | 'sent' | 'closed';

/**
 * Where the viewer is: `traceViewer` resolved against the report, with index.html for a folder.
 * Null when the setting is empty (the report then links to trace.playwright.dev).
 */
export function traceViewerPage(traceViewer: string, base: string): URL | null {
  const path = traceViewer.trim();
  if (!path) return null;
  const url = new URL(path, base);
  if (url.pathname.endsWith('/')) url.pathname += 'index.html';
  else if (!/\.html?$/.test(url.pathname)) url.pathname += '/index.html';
  return url;
}

/**
 * Posts the trace to the viewer until it has loaded it. A viewer on the report's origin shows `?trace=blob:` in its
 * address once loaded ('loaded'). On another origin that can't be read, so it posts for a few seconds and reports
 * 'sent'; the viewer may then load it more than once, which only repeats the same view.
 */
export function sendTrace(
  win: TraceViewerWindow,
  trace: Blob,
  targetOrigin: string,
  { intervalMs = 250, timeoutMs = 30_000, crossOriginMs = 4_000 } = {},
): Promise<TraceSendResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (win.closed) return resolve('closed');
      let sameOrigin = true;
      try {
        if (win.location.href.includes('trace=blob')) return resolve('loaded');
      } catch {
        sameOrigin = false;
      }
      const waited = Date.now() - started;
      if (waited > (sameOrigin ? timeoutMs : crossOriginMs)) return resolve('sent');
      try {
        win.postMessage({ method: 'load', params: { trace } }, targetOrigin);
      } catch {
        // The viewer page hasn't reached its own origin yet (still about:blank); try again on the next tick.
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}
