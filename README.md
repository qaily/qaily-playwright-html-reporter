# @qaily/playwright-html-reporter

**Qaily** is an ecosystem of QA tools for AI agents and QA engineers.

`@qaily/playwright-html-reporter` is the web interface for
[`@qaily/playwright-jsonl-reporter`](https://github.com/qaily/qaily-playwright-jsonl-reporter). The JSONL reporter
writes every Playwright run in a compact, AI-friendly format. An AI agent can read the runs and their history without
filling its context window or burning tokens, and find patterns in failures and their root causes.

This package adds the report for people, and is built to keep a year of history:

- **Monitoring** of hourly or daily runs: the latest run of each lane (an environment, a suite, a branch), refreshing
  by itself.
- **Weekly and monthly statistics:** pass rate, flakiness and duration trends.
- **Issues:** failing tests grouped by cause, across runs.
- **Tests:** every attempt with its steps, errors and stack traces, screenshots, logs and Playwright traces.
- **Coverage heat map:** which parts of the product the tests exercised ([docs/heatmap.md](docs/heatmap.md)).
- **Retention built in:** heavy artifacts (screenshots, traces, videos) are deleted after a few days, while the light
  data behind the dashboards is kept.
- **Static:** one page on any static host, such as GitHub Pages. Data is pre-aggregated into small Parquet and JSON
  files and queried in the browser with DuckDB-WASM. Artifacts can stay in your bucket (AWS S3, Google Cloud Storage,
  MinIO, Dell ECS), read through short-lived signed links.
- **Optional AI:** analyse failures and suggest fixes through a local agent host ([docs/ai.md](docs/ai.md)).

**[Live demo](https://qaily.github.io/qaily-playwright-html-reporter/)**, built from synthetic data.

## Contents

1. [Install](#1-install)
2. [Record runs](#2-record-runs)
3. [View the report on your machine](#3-view-the-report-on-your-machine)
4. [Host the report](#4-host-the-report)
5. [Storage and credentials](#5-storage-and-credentials)
6. [Settings](#6-settings)
7. [Retention](#7-retention)
8. [Commands](#8-commands)
9. [Develop and release](#9-develop-and-release)

## 1. Install

```bash
npm install --save-dev @qaily/playwright-html-reporter
```

See [CHANGELOG.md](CHANGELOG.md) for versions and release channels.

You need:

- Node 20 or newer, and `@playwright/test`. Coverage labels on steps need Playwright 1.58 or newer.
- The [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), only for a bucket.
  `qaily-report` uses it, and its login, for every provider.

## 2. Record runs

Add the reporter to `playwright.config.ts`. It writes the JSONL files (through `@qaily/playwright-jsonl-reporter`),
so you don't add that reporter separately.

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  reporter: [
    ['list'],
    ['@qaily/playwright-html-reporter', {
      outputDir: 'reports/data',
      environment: process.env.TEST_ENV ?? 'local',
      category: 'ui:web',
      tag: '@regression',
    }],
  ],
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
```

| Option | Default | What it does |
|---|---|---|
| `outputDir` | `'./reports/data'` | Where run folders are written |
| `environment` | none | The environment tested, e.g. `'staging'`. Lanes and filters use it |
| `category` | none | What kind of run, e.g. `'ui:web'` or `'api'`. Lanes use it |
| `tag` | none | The suite's name, shown on the run, e.g. `'@regression'` |
| `coverage.levels` | `['Component', 'Test Name', 'Feature', 'Area']` | Step annotation types used as the heat map's four levels |
| `archived` | `true` | Write `.jsonl.gz` (`true`) or plain `.jsonl` (`false`) |
| `writePlainText` | `true` | With `archived`, also write plain `.jsonl` copies |
| `compressLevel` | `6` | Gzip level, 1 to 9 |
| `includeAttachmentChecksums` | `false` | Record the SHA-256 of each attachment |
| `maxErrorMessageLength` | `500` | Error messages are cut at this length |
| `afterJsonl` | none | An async function called after the run's files are written |

The commit and branch are taken from git. Each run becomes one folder:

```
reports/data/
└── <time>_<commit>_<n>/            one folder per run
    ├── manifest.jsonl.gz           run start and end: commit, branch, environment, totals
    ├── test-summary.jsonl.gz       one line per test: status, duration, error summary
    ├── test_details.jsonl.gz       one line per attempt: steps and annotations
    ├── errors.jsonl.gz             errors and stack traces
    ├── attachments-index.jsonl.gz  list of attachments
    ├── step-coverage.jsonl.gz      heat map labels (only when steps are labelled)
    └── attachments/                screenshots, traces, videos, logs
```

Screenshots and traces become attachments when Playwright makes them, so set `screenshot` and `trace` in `use` as you
need them. Traces are the heaviest part: [Retention](#7-retention) deletes them after a few days.

## 3. View the report on your machine

After a test run:

```bash
npx qaily-report show
```

This builds the report from `reports/data` into `report-data` and serves it at <http://127.0.0.1:4173>. Run it again
after the next test run; it only rebuilds what changed. `--in`, `--out` and `--port` change the folders and the port.

**Runs in a bucket** (set up in [section 4](#4-host-the-report)), with the bucket in `report-data/settings.json` and an
AWS CLI login ([section 5](#5-storage-and-credentials)). Use one of these, depending on where the report data lives:

| Your setup | Command | What it does |
|---|---|---|
| Mode 2: Pages + bucket for artifacts | `show --sync` | Downloads the run folders (no attachments), builds the report on your machine, serves it |
| Mode 3: all data in the bucket | `show --pull` | Downloads the report data CI published, serves it. No build |

```bash
npx qaily-report show --sync --aws-profile qaily
npx qaily-report show --pull --aws-profile qaily
```

- **`--sync`** works in both modes. It shows only runs whose folders are still in the bucket: runs whose folders were
  deleted by retention are missing. In mode 3, use it to see runs CI hasn't published yet.
- **`--pull`** is faster and includes runs whose folders have expired, but it's only as fresh as CI's last `publish`.
  In mode 2 there's nothing to pull: CI deploys the data with the site.
- **Not both:** pull, then sync, is what CI does in mode 3 to keep history and add the newest runs. To look at the
  report, one is enough, so `show` refuses both together.

Screenshots and traces stay in the bucket: the local server reads them with your login, which never reaches the
browser, and passes them to the page from its own address. The bucket needs no CORS rules or bridge for this, on any
provider.

**Without tests:** `npx qaily-report demo && npx qaily-report serve` shows 120 synthetic runs.

**Settings:** open Settings in the report. **For me** changes apply to your browser only. Under **For the team**,
**Save to settings.json** writes `report-data/settings.json`. Commit that file: CI uses it ([section 6](#6-settings)).
Add the rest of `report-data/` to `.gitignore`:

```gitignore
report-data/*
!report-data/settings.json
!report-data/coverage-catalog.json
```

## 4. Host the report

Three ways to share the report, here with GitHub Actions and GitHub Pages. Every workflow is in
[docs/workflows/](docs/workflows) ready to copy, and the steps are plain `qaily-report` commands, so other CI systems and
static hosts work the same way.

| | 1. Pages only | 2. Pages + bucket for artifacts | 3. All data in the bucket |
|---|---|---|---|
| On the site | App, report data, the latest runs' attachments | App and report data | App and `settings.json` only |
| In the bucket | Nothing | Run folders with attachments | Run folders and the report data |
| Site rebuilt | Every run | Every run | Once, and when the version or settings change |
| History kept in | A `report-data` branch | The bucket's run folders | The bucket |
| Dashboards need credentials | No | No | Yes, every viewer |
| Attachments need credentials | No | Yes | Yes |
| Who can read test names and errors | Anyone who can open the site | Anyone who can open the site | Only people with bucket access |
| Workflow | [pages-only.yml](docs/workflows/pages-only.yml) | [pages-s3-attachments.yml](docs/workflows/pages-s3-attachments.yml) | [s3-data.yml](docs/workflows/s3-data.yml) + [s3-data-site.yml](docs/workflows/s3-data-site.yml) |

Choose **1** to start, or when the site's readers may see everything. Choose **2** to keep large artifacts out of the
site. Choose **3** when the data must stay private and access to the site can't be limited, or to publish new runs without
redeploying. For all three, set Settings → Pages → Source to **GitHub Actions**.

### Mode 1: GitHub Pages only

After the tests, the job adds the run to the report data and deploys the site. The report data is small (rollups and
JSONL), and is kept in a `report-data` branch between runs; `build` keeps the earlier runs from it. Attachments are
published only for the runs in the latest deploy.

```yaml
- run: npx playwright test
- run: npx qaily-report build --in reports/data --out report-history   # report-history: the report-data branch
- run: |
    cp -r node_modules/@qaily/playwright-html-reporter/app site
    cp -r report-history site/data
    npx qaily-report trace-viewer --out site/trace
```

[pages-only.yml](docs/workflows/pages-only.yml) has the full job, including the branch and the attachments.

### Mode 2: GitHub Pages + bucket for artifacts

The test job uploads the run folder, attachments included. The report job rebuilds the report from every run in the
bucket, without downloading attachments, and deploys it. Viewers connect credentials to open screenshots and traces.

```yaml
# test job
- run: npx playwright test
- run: npx qaily-report upload          # reports/data → bucket, .sync-complete marker last
# report job
- run: npx qaily-report sync            # run folders from the bucket, no attachments, then build
- run: |
    cp -r node_modules/@qaily/playwright-html-reporter/app site
    cp -r report-data site/data
    npx qaily-report trace-viewer --out site/trace
```

`report-data/settings.json` names the bucket ([settings for each mode](#settings-for-each-mode)). CI needs a key that
can upload and list the run folders. If run folders are deleted after a while, add `pull` before `sync` and `publish`
after it, so the bucket keeps the report data between builds.

### Mode 3: all data in the bucket

The site is deployed once, with the app and `settings.json`. After each test run, CI publishes the report data to the
bucket, and viewers see the new run on their next load.

```yaml
# after the tests, every run (s3-data.yml)
- run: npx qaily-report upload
- run: npx qaily-report pull            # what was published last time
- run: npx qaily-report sync            # run folders → rebuild the months that changed
- run: npx qaily-report publish         # report data → bucket, catalog.json last
# when the version or settings change (s3-data-site.yml)
- run: |
    cp -r node_modules/@qaily/playwright-html-reporter/app site
    mkdir -p site/data && cp report-data/settings.json site/data/
    npx qaily-report trace-viewer --out site/trace
```

Viewers paste credentials in Settings → Tokens. Team settings (lanes, thresholds, heat map rules) can then be saved from
the report to the bucket, with no redeploy ([docs/storage.md](docs/storage.md#7-team-settings-in-the-bucket)). Run folders
can expire while the dashboards keep every run.

### Reading the bucket from the browser: CORS or the storage bridge

In modes 2 and 3 the page reads the bucket from the viewer's browser, which needs the bucket's permission (CORS):

- **You can set CORS rules:** allow the site's origin, e.g. `https://<org>.github.io`, for `GET` and `HEAD` (and `PUT` to
  save team settings). Examples for each provider are in [docs/storage.md](docs/storage.md#3-cors).
- **You can't** (Dell ECS, or no admin rights): use the **storage bridge**. Upload a small page to the bucket once, and set
  Settings → Connections → **Storage access** to **Bridge**:

  ```bash
  npx qaily-report bridge --origin https://<org>.github.io --aws-profile qaily
  ```

  The report then reads the bucket through that page, with no CORS rules. Each viewer can switch between Direct and Bridge
  under **For me**. How it works and what it allows: [docs/storage.md](docs/storage.md#9-storage-without-cors-the-storage-bridge).

Without CORS or the bridge, mode 2 still shows dashboards, screenshots and downloads (on most storage), but not text
attachments; mode 3 shows nothing. `qaily-report show` needs neither.

**Traces** open in the trace viewer copied next to the report (`qaily-report trace-viewer`, with
`"traceViewer": "trace/"`). The report hands it the trace file, so the viewer needs no CORS of its own
([docs/storage.md](docs/storage.md#10-self-hosted-trace-viewer)).

## 5. Storage and credentials

| Storage | `endpoint` | `region` | `pathStyle` | Browser access |
|---|---|---|---|---|
| AWS S3 (tested) | empty | the bucket's region | `false` | CORS |
| Google Cloud Storage (tested) | `https://storage.googleapis.com` | `auto` | `false` | CORS |
| MinIO | the server's URL | usually `us-east-1` | `true` | CORS (server-wide) |
| Dell ECS | the server's URL | any, e.g. `us-east-1` | `true` | Storage bridge |

The commands log in through the AWS CLI v2, for every provider:

```bash
aws configure --profile qaily                       # access key and secret (HMAC key for Google Cloud Storage)
aws configure sso --profile qaily                   # or AWS IAM Identity Center; then: aws sso login --profile qaily
npx qaily-report show --sync --aws-profile qaily    # or AWS_PROFILE=qaily, or the AWS_ACCESS_KEY_ID variables
```

For the browser (Settings → Tokens), paste one of:

```bash
aws configure export-credentials --profile qaily --format process
aws sts get-session-token --profile qaily --duration-seconds 43200 --query Credentials --output json   # 12-hour keys
```

[docs/storage.md](docs/storage.md) has the rest:
- provider notes;
- CORS rules;
- IAM policies for viewers, CI and the retention job;
- certificates for internal storage;
- what the page stores and for how long.

## 6. Settings

Settings come in three layers, the later ones winning:

1. **Site:** `settings.json` next to the report data. In this README it's `report-data/settings.json`, committed and
   deployed by CI.
2. **Team settings in the bucket** (mode 3): `team-settings.json` in the data folder. **Save to bucket** writes it, and it
   never contains the bucket connection.
3. **Personal:** Settings → **For me**, kept in each viewer's browser.

Edit them in the report: Settings shows where each value comes from, and **For the team** saves to the right place
(**Save to settings.json**, **Save to bucket** or **Commit to GitHub**). Or edit the JSON. Unset fields keep their
defaults.

### Settings for each mode

Mode 1, no bucket:

```json
{
  "lanes": [
    { "id": "main", "label": "Main branch", "match": { "branch": "^main$" } },
    { "id": "other", "label": "Other branches", "match": {} }
  ],
  "connections": { "traceViewer": "trace/" }
}
```

Mode 2: the same, plus the bucket:

```json
{
  "connections": {
    "traceViewer": "trace/",
    "s3": { "bucket": "test-reports", "region": "eu-north-1", "prefix": "jsonl-report" }
  }
}
```

Mode 3: the data source and the data folder too. Add `"transport": "bridge"` for the storage bridge:

```json
{
  "connections": {
    "traceViewer": "trace/",
    "s3": {
      "bucket": "test-reports",
      "region": "eu-north-1",
      "prefix": "jsonl-report",
      "dataSource": "bucket",
      "dataPrefix": "qaily-data"
    }
  }
}
```

For Google Cloud Storage, MinIO or ECS, add `endpoint` and `pathStyle` from [section 5](#5-storage-and-credentials).
`prefix` is where run folders go; `dataPrefix` must be outside it.

### Lanes

A lane is a line of runs on the Monitoring page and a filter elsewhere. Lanes group whole **runs**, not single tests,
and look at three values of each run:

| Condition | Tested against |
|---|---|
| Category | The reporter option `category`, e.g. `'ui:web'`. Not a test title, file, tag or project |
| Environment | The reporter option `environment`, e.g. `'staging'` (exact match) |
| Branch | The git branch of the run |
| Started | The time of day the run started, e.g. between `22:00` and `06:00` for nightly runs |

Each run joins the first lane that matches, so list specific lanes first and keep a catch-all (no conditions) last.
A nightly lane, for example, goes above the general lane for the same category, or that lane takes the nightly runs.

A start-time window is saved with its own time zone (`"time": { "from": "22:00", "to": "06:00", "zone": "Europe/Vilnius" }`),
so a run lands in the same lane for every viewer. A window whose `from` is after its `to` runs past midnight.

Edit lanes in **Settings → Lanes → For the team**. The builder offers the values your runs from the last 90 days
reported, shows how many runs each lane gets, warns when a lane above takes a lane's runs, lists runs that are in no lane
(with a button to create one), and can generate starter lanes from your runs. Conditions are "is", "is one of",
"starts with", "ends with" and "contains"; "matches regex" is there for anything else.

Environments are not a fixed list: Monitoring's environment chips show every `environment` value your runs report.
Set an environment on a lane to get one lane per environment, or leave it at "any environment" to keep them in one
lane and filter with the chips.

Tests, Issues, Heat Map, Weekly and Monthly have **Lane** and **Environment** filters in the filter bar. Pick one or
more of each, and only runs that match are counted. They stay in the URL (`?lanes=web-dev&env=staging`), so they carry
over when you switch between those pages. Monitoring keeps its own environment chips. A run opened from a link is
always shown, even when the filters would hide it.

In the settings file the conditions are stored as `match`, with `category` and `branch` as regular expressions:

```json
{ "id": "web-staging", "label": "Web · Staging", "match": { "category": "^ui:web$", "environment": "staging" } }
```

### Coverage heat map

The heat map places steps on four levels: Component, Scenario, Feature and Area. Steps get there in two ways:

- **Mapping rules** in Settings → Coverage heat map, with no test changes:
  ```json
  { "coverage": { "rules": [ { "step": "^Archive board", "component": "Permissions", "feature": "Boards", "area": "Archive" } ] } }
  ```
- **Labels on steps**, with Playwright 1.58+:
  ```ts
  import { coverage } from '@qaily/playwright-html-reporter';

  await test.step('Archive board', async (step) => {
    coverage(step, { component: 'Permissions', scenario: 'Workspace owners', feature: 'Boards', area: 'Archive' });
  });
  ```

A planned matrix shows the gaps: `npx qaily-report catalog --csv coverage/matrix.csv` writes
`report-data/coverage-catalog.json`. Details are in [docs/heatmap.md](docs/heatmap.md).

## 7. Retention

Attachments are most of the storage: a run with traces can be 1 GB or more, while its JSONL is a few hundred KB. The
report is built to keep a year of light data and drop heavy artifacts after a few days. Example: 20 runs a day of
1.5 GB is 900 GB a month with everything kept, and about 90 GB with attachments kept for 3 days.

| What | How long | How |
|---|---|---|
| Attachments | Days | `qaily-report expire-attachments`, on a schedule |
| Run folders | Weeks, or forever | A lifecycle rule on the run-folder prefix, or keep them |
| Report data (dashboards) | A year or more | Kept by `build`; `--prune-before YYYY-MM` drops older months |

### Delete old attachments: `expire-attachments`

```bash
npx qaily-report expire-attachments --older-than 3 --dry-run   # what would be deleted
npx qaily-report expire-attachments --older-than 3             # delete it
```

It deletes `<prefix>/<run>/attachments/` of runs whose attachments are all older than the given days, and keeps the rest
of each run folder. The dashboards, and other tools that read the run folders, keep working. The age lives in your
workflow, not in the bucket, so it works where you can't change the bucket's settings. Run it daily:
[expire-attachments.yml](docs/workflows/expire-attachments.yml).

A lifecycle rule can't do this, because its filter matches the start of a key and `attachments/` is in the middle. In a
versioned bucket, a delete only hides a file, so also add a rule that deletes old versions, or pass `--all-versions`.

The report then says, for an old run, that its attachments are no longer in storage. The test's error, steps and history
are still shown.

### Delete old run folders: lifecycle rules

To delete whole run folders after, say, 30 days, add a lifecycle rule on the run-folder prefix. Dashboards keep those runs
as long as CI keeps the report data: mode 3 does this already; in mode 2, add `pull` and `publish`
([docs/storage.md](docs/storage.md#11-when-run-folders-expire-too)).

AWS S3 (`aws s3api put-bucket-lifecycle-configuration --bucket <bucket> --lifecycle-configuration file://lifecycle.json`).
This replaces the bucket's existing rules, so include any you have:

```json
{
  "Rules": [
    { "ID": "run-folders", "Status": "Enabled", "Filter": { "Prefix": "jsonl-report/" }, "Expiration": { "Days": 30 } },
    { "ID": "old-versions", "Status": "Enabled", "Filter": {}, "NoncurrentVersionExpiration": { "NoncurrentDays": 1 } }
  ]
}
```

Google Cloud Storage (`gcloud storage buckets update gs://<bucket> --lifecycle-file=lifecycle.json`):

```json
{ "rule": [ { "action": { "type": "Delete" }, "condition": { "age": 30, "matchesPrefix": ["jsonl-report/"] } } ] }
```

MinIO: `mc ilm rule add --expire-days 30 --prefix "jsonl-report/" <alias>/<bucket>`.

Dell ECS accepts the AWS rule through its S3 API (`--endpoint-url`) when the bucket's owner allows it. Otherwise use
`expire-attachments` only.

Rules count days from upload, and providers usually apply them once a day.

## 8. Commands

Run them as `npx qaily-report <command>`; `npx qaily-report help` lists them. The defaults match the setup above: run
folders in `reports/data`, report data in `report-data`, and the bucket from `report-data/settings.json`.

| Command | What it does |
|---|---|
| `show` | Build from local run folders and serve |
| `serve` | Serve report data that's already built |
| `build` | Run folders → report data; only changed months are rebuilt |
| `upload` | Run folders → bucket, attachments included, marker last |
| `sync` | Bucket run folders → local folder (no attachments), then build |
| `pull` | Published report data → local folder |
| `publish` | Report data → bucket, `catalog.json` last |
| `expire-attachments` | Delete the attachments of old runs, keep the rest |
| `bridge` | Upload the storage bridge page |
| `trace-viewer` | Copy Playwright's trace viewer from the test project |
| `catalog` | Planned coverage matrix for the heat map |
| `demo` | Synthetic runs, to try the report |

Options, with their defaults:

```text
show                --in reports/data   --out report-data   --port 4173
                    --sync              run folders from the bucket instead
                    --pull              published report data from the bucket instead
serve               --data report-data  --attachments <run folders>
                    --port 4173         --host 127.0.0.1    --app <built app>
build               --in reports/data   --out report-data
                    --force             rebuild every month
                    --prune-before YYYY-MM                  drop older months for good
upload              --in reports/data   --dry-run
sync                --to .qaily/runs    --out report-data   --with-attachments
pull                --out report-data
publish             --out report-data   --allow-shrink
                    --team-settings seed|replace|skip       team-settings.json
expire-attachments  --older-than <days> (required)
                    --dry-run           --all-versions
bridge              --origin <site origin> (required)       --dry-run
trace-viewer        --out <site>/trace (required)           --from <test project>
catalog             --csv <matrix.csv> (required)
                    --out report-data/coverage-catalog.json
demo                --out report-data   --runs 120          --days 30
```

Bucket options, for every command that uses a bucket:

```text
--bucket <name>       --region <region>       --endpoint <url>      --path-style
--prefix <run folders>                        --data-prefix <report data>
--aws-profile <name>
```

## 9. Develop and release

```bash
npm ci
npm run data:demo          # synthetic data in .qaily/data (git-ignored)
npm run app:dev            # http://127.0.0.1:5173
npm run app:test && npm run app:typecheck
npm run pkg:build          # dist/ and app/, as published to npm
```

The workspace layout is in [packages/README.md](packages/README.md). Releases: Actions → **Release** → Run workflow,
see [docs/releasing.md](docs/releasing.md).

## License

MIT
