import { describe, expect, it } from 'vitest';
import { sendTrace, traceViewerPage, type TraceViewerWindow } from '../src/index.ts';

describe('trace viewer page', () => {
  it('resolves the setting against the report, with index.html for a folder', () => {
    expect(traceViewerPage('', 'https://o.github.io/r/bucket/')).toBeNull();
    expect(traceViewerPage('trace/', 'https://o.github.io/r/')?.href).toBe('https://o.github.io/r/trace/index.html');
    expect(traceViewerPage('../trace', 'https://o.github.io/r/bucket/')?.href).toBe('https://o.github.io/r/trace/index.html');
    expect(traceViewerPage('https://t.example/viewer/index.html', 'https://o.github.io/r/')?.href).toBe('https://t.example/viewer/index.html');
  });
});

/** A viewer tab that loads the trace on the n-th message it gets. */
function viewer(loadsOn: number, opts: { crossOrigin?: boolean } = {}) {
  const posted: unknown[] = [];
  let href = 'https://o.github.io/r/trace/index.html';
  const win: TraceViewerWindow & { closed: boolean } = {
    closed: false,
    get location() {
      if (opts.crossOrigin) throw new DOMException('Blocked', 'SecurityError');
      return { href };
    },
    postMessage(message) {
      posted.push(message);
      if (posted.length === loadsOn) href += '?trace=blob%3Ahttps%3A%2F%2Fo.github.io%2Fabc';
    },
  };
  return { win, posted };
}

describe('sending a trace', () => {
  const trace = new Blob(['zip']);

  it('posts the file until the viewer shows it, then stops', async () => {
    const { win, posted } = viewer(3);
    expect(await sendTrace(win, trace, 'https://o.github.io', { intervalMs: 1 })).toBe('loaded');
    expect(posted).toHaveLength(3);
    expect(posted[0]).toEqual({ method: 'load', params: { trace } });
  });

  it('stops when the tab is closed', async () => {
    const { win } = viewer(Infinity);
    win.closed = true;
    expect(await sendTrace(win, trace, 'https://o.github.io', { intervalMs: 1 })).toBe('closed');
  });

  it('gives up after a while when it cannot see the viewer', async () => {
    const { win, posted } = viewer(Infinity, { crossOrigin: true });
    expect(await sendTrace(win, trace, 'https://t.example', { intervalMs: 1, crossOriginMs: 20 })).toBe('sent');
    expect(posted.length).toBeGreaterThan(0);
  });
});
