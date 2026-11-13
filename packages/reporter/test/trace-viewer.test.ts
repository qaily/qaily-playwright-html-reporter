import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHandler } from '../src/server.ts';
import { copyTraceViewer, findTraceViewer } from '../src/trace-viewer.ts';

let dir: string;
beforeAll(() => {
  // A test project with its own Playwright.
  dir = mkdtempSync(join(tmpdir(), 'qaily-trace-'));
  const core = join(dir, 'project/node_modules/playwright-core');
  mkdirSync(join(core, 'lib/vite/traceViewer'), { recursive: true });
  writeFileSync(join(core, 'package.json'), JSON.stringify({ name: 'playwright-core', version: '9.9.9', main: 'index.js' }));
  writeFileSync(join(core, 'index.js'), '');
  writeFileSync(join(core, 'lib/vite/traceViewer/index.html'), '<title>viewer</title>');
  writeFileSync(join(core, 'lib/vite/traceViewer/sw.bundle.js'), '// sw');
  mkdirSync(join(dir, 'empty'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('trace viewer copy', () => {
  it("finds the test project's own Playwright", () => {
    expect(findTraceViewer(join(dir, 'project'))?.version).toBe('9.9.9');
    expect(findTraceViewer(join(dir, 'empty'))).toBeNull();
  });

  it('copies it, replacing an older copy', () => {
    const out = join(dir, 'site/trace');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'stale.js'), 'old');
    expect(copyTraceViewer(out, join(dir, 'project')).version).toBe('9.9.9');
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toContain('viewer');
    expect(existsSync(join(out, 'stale.js'))).toBe(false);
    expect(() => copyTraceViewer(out, join(dir, 'empty'))).toThrow('No Playwright trace viewer');
  });

  it('is served at /trace/ by serve', async () => {
    mkdirSync(join(dir, 'data'), { recursive: true });
    const handler = createHandler({ dataDir: join(dir, 'data'), traceViewerDir: findTraceViewer(join(dir, 'project'))!.dir });
    const server = createServer((req, res) => void handler(req, res, () => res.writeHead(404).end()));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect(await (await fetch(`${base}/trace/`)).text()).toContain('viewer');
      const sw = await fetch(`${base}/trace/sw.bundle.js`);
      expect(sw.headers.get('content-type')).toContain('javascript');
      expect((await fetch(`${base}/trace/%2e%2e/%2e%2e/package.json`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
