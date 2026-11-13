// Playwright's trace viewer is a static app inside playwright-core. A copy next to the report opens traces the report
// hands it (see traceViewerPage/sendTrace in @qaily/contracts), so traces open without CORS rules on the bucket.
// It must come from the Playwright that recorded the traces: a viewer refuses traces from a newer Playwright.

import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

export interface TraceViewerSource {
  dir: string;
  version: string;
}

/** The trace viewer of the playwright-core installed for the project in `from` (default: the current folder). */
export function findTraceViewer(from = process.cwd()): TraceViewerSource | null {
  const require = createRequire(join(resolve(from), 'noop.js'));
  let pkgFile: string | undefined;
  try {
    pkgFile = require.resolve('playwright-core/package.json');
  } catch {
    try {
      // Walk up from the entry point if the package doesn't export its package.json.
      let dir = dirname(require.resolve('playwright-core'));
      while (!existsSync(join(dir, 'package.json')) && dirname(dir) !== dir) dir = dirname(dir);
      pkgFile = join(dir, 'package.json');
    } catch {
      return null;
    }
  }
  const dir = join(dirname(pkgFile), 'lib', 'vite', 'traceViewer');
  if (!existsSync(join(dir, 'index.html'))) return null;
  const { version } = JSON.parse(readFileSync(pkgFile, 'utf8')) as { version: string };
  return { dir, version };
}

/** Copies the project's trace viewer to `out`, replacing what is there. */
export function copyTraceViewer(out: string, from?: string): TraceViewerSource {
  const source = findTraceViewer(from);
  if (!source) {
    throw new Error('No Playwright trace viewer found. Run this in the test project, where @playwright/test (playwright-core) is installed, or pass --from <project dir>.');
  }
  rmSync(out, { recursive: true, force: true });
  cpSync(source.dir, out, { recursive: true });
  return source;
}
