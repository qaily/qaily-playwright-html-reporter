# Workspace

The report is a TypeScript + Lit workspace. `scripts/build-package.mjs` bundles it into the npm package.

| Package | Role |
|---|---|
| `contracts` | Types only + pure logic: JSONL records, rollup rows, page/view/theme contract, settings schema, **`settings/defaults.ts` (edit defaults here)** |
| `core` | Browser services: DataService (JSON rollups + lazy DuckDB-WASM), SettingsService, SecretStore, Router, ThemeManager, formatters |
| `ui` | Shared Lit components and the `--q-*` design tokens |
| `shell` | App entry, nav, filter bar, page host with per-page error boundary, page + theme registries |
| `pages/*` | One folder per page (`monitoring`, `weekly`, `monthly`, `issues`, `tests`, `heatmap`, `settings`). Pages import only contracts/core/ui, never each other |
| `themes/*` | Skins (`classic`, `dark-ops`); themes may also add alternative views per page |
| `artifacts` | SigV4 presigning (WebCrypto, browser + Node), credential parsing, ArtifactService (static / local / browser modes) |
| `ai` | Agent Host Protocol client, per-job sessions, prompts, AI store and publishers (local server / GitHub) |
| `reporter` | The Playwright reporter and `coverage()` (`src/playwright`), and the Node CLI `qaily-report`: `build` (rollups), `serve` (local server + S3 signer), `sync` (S3 → local), `demo` (synthetic data) |

```bash
npm run data:build     # .qaily/runs → .qaily/data   (or: npm run data:demo for synthetic data)
npm run app:dev        # Vite on http://127.0.0.1:5173 (serves .qaily/data too)
npm run app:build && npm run site:serve   # production build on http://127.0.0.1:4173
npm run app:test       # Vitest
npm run app:typecheck
```

Add a page: create `packages/pages/<id>` exporting `definePage({...})`, then add one line to `packages/shell/src/pages.ts`.
Add a theme: create `packages/themes/<id>` exporting `defineTheme({...})` that defines every token in `packages/ui/src/tokens.ts`, then add it to `packages/shell/src/themes.ts`.
