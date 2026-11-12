# @qaily/playwright-html-reporter

A Playwright reporter with a static, fast report built for test history: what failed today, how this week and
month went, which issues keep coming back, and which parts of the product the tests actually cover.

**[Live demo](https://qaily.github.io/qaily-playwright-html-reporter/)**, built from synthetic data.

- **Dashboards:** Monitoring (latest run per lane), Weekly, Monthly, Issues (failures grouped by cause), Tests
  (every attempt with steps, errors, screenshots and traces) and a coverage Heat Map.
- **Static:** a single-page app on any static host, such as GitHub Pages. Data is pre-aggregated into small Parquet
  and JSON files and queried in the browser with DuckDB-WASM, so months of runs load in seconds.
- **Large artifacts stay in your bucket:** traces, videos and screenshots are read straight from S3, Google Cloud
  Storage or MinIO through short-lived signed links, so they never go into the site.
- **Optional AI:** analyse failures and suggest fixes through a local agent host (see [docs/ai.md](docs/ai.md)).
- **Themes:** Chronoscope (default, 3D dials and carousels), Classic (light and dark) and Dark Ops, switched in Settings.

## Install

```bash
npm install --save-dev @qaily/playwright-html-reporter
```

Or straight from GitHub (builds on install, about 20 s): `npm install --save-dev github:qaily/qaily-playwright-html-reporter`.

Node 20 or newer. The reporter needs `@playwright/test`; step coverage labels need Playwright 1.58+.
The commands that talk to a bucket (`sync`, `pull`, `publish`, and `serve` when it signs links) use the
[AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) and its login.

## 1. Record runs

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  reporter: [['@qaily/playwright-html-reporter', { outputDir: 'reports/data' }]],
});
```

Each run becomes a folder under `outputDir`:

```
reports/data/<ISO time>_<commit>_<n>/
  manifest.jsonl.gz  test-summary.jsonl.gz  test_details.jsonl.gz  errors.jsonl.gz  attachments-index.jsonl.gz
  step-coverage.jsonl.gz   (only when steps are labelled)
  attachments/             (screenshots, traces, logs)
```

| Option | Default | Description |
|---|---|---|
| `outputDir` | `'./reports/data'` | Where run folders are written |
| `archived` | `true` | Write `.jsonl.gz` (true) or plain `.jsonl` (false) |
| `environment` | none | Environment name, e.g. `'staging'`; lanes can match it |
| `category` | none | What kind of run this is, e.g. `'ui:web'`; lanes can match it |
| `tag` | none | Suite name shown on the run, e.g. `'@regression'` |
| `coverage.levels` | `['Component', 'Test Name', 'Feature', 'Area']` | Step annotation types used as the heat map's four levels |
| `includeAttachmentChecksums` | `false` | SHA-256 of each attachment |
| `maxErrorMessageLength` | `500` | Error messages are cut at this length |
| `afterJsonl` | none | Called after the run's files are written |

Label steps for the coverage heat map (optional, see [docs/heatmap.md](docs/heatmap.md)):

```ts
import { coverage } from '@qaily/playwright-html-reporter';

await test.step('Archive board', async (step) => {
  coverage(step, { component: 'Permissions', scenario: 'Workspace owners', feature: 'Boards', area: 'Archive' });
  // ...
});
```

## 2. Build and view the report

```bash
npx qaily-report build --in reports/data --out report-data   # rollups for the dashboards
npx qaily-report serve --data report-data --attachments reports/data
# → http://127.0.0.1:4173
```

`build` only rebuilds months whose runs changed. Try it without tests: `npx qaily-report demo --out report-data`
writes 120 synthetic runs, with heat map rules and a planned matrix.

Everything else is set on the report's **Settings** page: lanes, health thresholds, theme, the bucket, heat map rules.
**Save for team** writes `report-data/settings.json` when the report is opened through `serve` (on GitHub Pages it
can commit the file instead, see [docs/ai.md](docs/ai.md#drafts-and-publishing)). A report that reads its data from a
bucket keeps team settings there instead, as `team-settings.json` next to the data (see
[docs/s3-artifacts.md](docs/s3-artifacts.md#team-settings-in-the-bucket)).

## 3. Share it

Upload each run folder to a bucket from CI, with a `.sync-complete` marker last (the upload step is at the end of
[docs/report-site.example.yml](docs/report-site.example.yml)). Then build the report from the bucket:

```bash
npx qaily-report sync --to runs --out report-data   # run folders without attachments, then build
```

The bucket comes from `report-data/settings.json` (Settings → For the team → Connections), or from flags:

```json
{ "connections": { "s3": { "bucket": "my-test-runs", "region": "eu-north-1", "prefix": "jsonl-report" } } }
```

Copy `node_modules/@qaily/playwright-html-reporter/app` and your data folder (as `data/`) to any static host.
[docs/report-site.example.yml](docs/report-site.example.yml) does this on GitHub Pages every 30 minutes.

Dashboard data can live on the site (simplest) or in the bucket (private, viewers sign in with credentials). Both, and
the bucket, CORS and IAM setup for AWS, Google Cloud Storage and MinIO, are in [docs/s3-artifacts.md](docs/s3-artifacts.md).

## `qaily-report` commands

| Command | What it does |
|---|---|
| `build --in <runs> --out <data> [--force] [--prune-before YYYY-MM]` | Turns run folders into the report's data, keeping runs whose folders have expired; `--force` rebuilds every month |
| `serve --data <data> [--attachments <runs>] [--aws-profile p] [--port 4173]` | Local server; signs bucket links with this machine's login |
| `sync --to <runs> --out <data> [--with-attachments]` | Downloads run folders from the bucket (attachments only if asked), then builds |
| `pull` / `publish --out <data> [--team-settings seed\|replace\|skip] [--allow-shrink]` | Bucket data source: fetch the last published data / upload the new one, and team settings when the bucket has none yet. See [expiring run folders](docs/s3-artifacts.md#when-run-folders-expire-too) |
| `expire-attachments --older-than <days> [--dry-run] [--all-versions]` | Deletes attachments of runs older than N days and keeps the rest of each run folder; run it daily. See [short retention](docs/s3-artifacts.md#8-short-retention-for-attachments) |
| `demo --out <data> [--runs 120] [--days 30]` | Synthetic runs, for trying the report |
| `catalog --csv <matrix.csv> --out <data>/coverage-catalog.json` | Planned coverage matrix for the heat map |

Bucket, region, key prefix and endpoint come from `<data>/settings.json`, or flags: `--bucket`, `--region`, `--prefix`,
`--endpoint` (Google Cloud Storage, MinIO), `--data-prefix`. `--aws-profile` picks the AWS CLI profile.

## Develop

```bash
npm ci
npm run data:demo          # synthetic data in .qaily/data (git-ignored)
npm run app:dev            # http://127.0.0.1:5173
npm run app:test && npm run app:typecheck
npm run pkg:build          # dist/ and app/, as published to npm
```

The workspace layout is described in [packages/README.md](packages/README.md).

## License

MIT
