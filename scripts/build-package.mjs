// Builds the npm package `@qaily/playwright-html-reporter` from the workspace:
//   dist/index.cjs      the Playwright reporter and coverage() (CommonJS, so any Playwright config can load it)
//   dist/types/         its type declarations
//   dist/cli.mjs        the `qaily-report` command
//   app/                the built report, served by `qaily-report serve` and copied by CI to a static host
// Run `npm run app:build` first (`npm run pkg:build` does both).

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const at = (p) => join(root, p);

const builtApp = at('.qaily/app');
if (!existsSync(join(builtApp, 'index.html'))) throw new Error('No built report in .qaily/app. Run `npm run app:build` first.');

rmSync(at('dist'), { recursive: true, force: true });
rmSync(at('app'), { recursive: true, force: true });

await build({
  entryPoints: [at('packages/reporter/src/playwright/index.ts')],
  outfile: at('dist/index.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['@qaily/playwright-jsonl-reporter', '@playwright/test'],
  logLevel: 'warning',
});

await build({
  // The bin script, not cli.ts: it is what calls main(). esbuild keeps its #! line first.
  entryPoints: [at('packages/reporter/bin/qaily-report.mjs')],
  outfile: at('dist/cli.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['@duckdb/node-api'],
  // Bundled CommonJS dependencies may call require(); give ESM output one.
  banner: { js: "import { createRequire as __qailyRequire } from 'node:module';\nconst require = __qailyRequire(import.meta.url);" },
  logLevel: 'warning',
});

execFileSync(process.execPath, [at('node_modules/typescript/bin/tsc'), '-p', at('packages/reporter/tsconfig.types.json')], { stdio: 'inherit' });

// The report without any data: users bring their own data folder.
cpSync(builtApp, at('app'), { recursive: true, filter: (src) => !src.startsWith(join(builtApp, 'data')) });

console.log('Built dist/ and app/');
