# Changelog

All notable changes to `@qaily/playwright-html-reporter`. Versions follow [semantic versioning](https://semver.org); while
the version has a `-beta.N` suffix, minor changes may still break things. Add entries under `Unreleased`; the Release workflow
moves them into the new version's section (see [docs/releasing.md](docs/releasing.md)).

## [Unreleased]

## [1.0.1-beta.8] - 2026-11-25

### Added

- **Today** in the Range filter: since midnight in the display time zone (`?range=today`).
- Tests has a Scope like Issues and opens on **All runs in range**:
  - every test of every matching run on one page, grouped by spec, counted by its worst result;
  - a dot per run on each test;
  - clicking a test opens its full details in its newest failing run, with a Run picker (and the dots) to switch
    between its runs.

### Changed

- The default date range is now Today, and the setting is a dropdown. Monitoring keeps 14 days until a range is picked.
- Tests opens on all runs in range instead of the newest run. Links to a run (`?run=…`) open that run as before.

### Fixed

- Chronoscope theme: status colours on the dial no longer clip to white, and hovering brightens a segment instead of
  washing the dial out.

## [1.0.1-beta.7] - 2026-11-17

### Added

- Settings → Lanes is a guided builder:
  - Conditions read as "Category is ui:web" and offer the values your runs from the last 90 days reported.
  - Each lane shows a live preview of the runs it gets, and warns when a lane above takes its runs.
  - Runs that are in no lane are listed, with a button to create a lane for them, and starter lanes can be generated
    from your runs.
  - Regex is still there as an advanced option, with a tester against your real values.
  - The settings format is unchanged.
- Lanes can match the time of day a run started (`match.time`, e.g. 22:00–06:00 for nightly runs), in a time zone saved
  with the lane.
- **Lane** and **Environment** filters on Tests, Issues, Heat Map, Weekly and Monthly. They are multi-selects in the
  filter bar, kept in the URL (`?lanes=…&env=…`) and carried between those pages.

### Changed

- Monitoring only uses the filters it shows: `?lanes=` in the URL no longer narrows its lanes.

## [1.0.1-beta.6] - 2026-11-17

### Fixed

- `qaily-report show` / `serve`: attachments from the bucket are streamed through the local server instead of a redirect
  to a signed URL. Images from Dell ECS, which sends `Cross-Origin-Resource-Policy: same-origin`, no longer fail with
  `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`, and text attachments and the local trace viewer need no CORS rules on the
  bucket. Storage with a company certificate now needs `NODE_EXTRA_CA_CERTS` for these commands too.

## [1.0.1-beta.5] - 2026-11-16

### Added

- `qaily-report show`: one command that builds the report from `reports/data` and serves it. `show --sync` and
  `show --pull` serve from a bucket instead.
- `qaily-report upload`: uploads run folders to the bucket, attachments included, with the `.sync-complete` marker last.
  It replaces the `aws s3 sync` loop in CI.
- `qaily-report help`, and `--path-style` for every bucket command.
- Ready-to-copy GitHub Actions workflows for the three hosting modes and for retention, in `docs/workflows/`.

### Changed

- Every command has defaults: run folders in `reports/data` (the reporter's default), report data in `report-data`.
  `expire-attachments` and `bridge` used `data` before: pass `--out data` if you relied on that.
- An unknown command now fails with the usage, instead of printing it and succeeding.
- New README, organised as a setup guide. `docs/s3-artifacts.md` is now `docs/storage.md`, by provider, with CORS,
  permissions and AWS CLI credentials. `docs/report-site.example.yml` is replaced by `docs/workflows/`.

## [1.0.1-beta.4] - 2026-11-16

## [1.0.1-beta.3] - 2026-11-13

### Added

- Storage bridge, for storage whose CORS rules you can't change (e.g. Dell ECS): `qaily-report bridge --origin <site>`
  uploads a small page to the data folder, and with Settings → Connections → **Storage access** set to **Bridge**, the
  report reads the bucket through it. Each viewer can switch it on or off for themselves.

## [1.0.1-beta.2] - 2026-11-13

### Added

- Self-hosted trace viewer: `qaily-report trace-viewer --out <site>/trace` copies Playwright's trace viewer from the test
  project. With Settings → Connections → **Trace viewer** set (e.g. `trace/`), the report reads the trace itself and hands
  it to that viewer, so traces open without CORS rules for the viewer. `serve` provides it at `/trace/`.

## [1.0.1-beta.1] - 2026-11-13

### Changed

- Settings → For the team: the save button says where it writes (**Save to bucket**, **Save to settings.json** or
  **Commit to GitHub**) and asks before saving to the bucket, naming the file and warning when you look at a bucket of
  your own. Fields are marked *Saved to bucket*, or *Site settings.json only* for the S3 connection, which the bucket
  save leaves out and which can no longer be edited there.

## [1.0.1-beta.0] - 2026-11-12

First version on npm.

### Report

- Dashboards: Monitoring (latest run per lane), Weekly, Monthly, Issues (failures grouped by cause), Tests (every attempt
  with steps, errors, screenshots and traces) and a coverage Heat Map, queried in the browser with DuckDB-WASM.
- Themes: Chronoscope, Classic (light and dark) and Dark Ops.
- Attachments read from S3, Google Cloud Storage or MinIO through short-lived signed links, from the browser or through
  `qaily-report serve`.
- Bucket data source: the report data lives in the bucket next to the run folders, so the site holds only the app.
- Team settings stored with the report data in the bucket (`team-settings.json`), saved from the report with the viewer's
  key. They never contain the bucket connection.
- Viewers can look at another bucket or folder for themselves under Settings → For me (bucket, region, endpoint, path
  style, prefixes), with a Reset bar under the header.
- The header shows where the data comes from.
- A run whose attachments are gone says so instead of showing broken images.
- Settings → Tokens shows the AWS CLI commands to get credentials, with `--profile`.
- Optional AI analysis of failures through a local agent host.

### `qaily-report`

- `build`, `serve`, `sync`, `pull`, `publish`, `demo` and `catalog`.
- `build` keeps the runs whose run folders have expired, from the previous build; `--prune-before YYYY-MM` drops old months.
- `pull` skips the raw per-run copies; `publish` refuses a catalog with fewer runs than the published one
  (`--allow-shrink` overrides) and seeds team settings in the bucket (`--team-settings seed|replace|skip`).
- `expire-attachments --older-than <days>` deletes the attachments of old runs and keeps the rest of each run folder;
  `--all-versions` also removes old versions in a versioned bucket.

[Unreleased]: https://github.com/qaily/qaily-playwright-html-reporter/compare/v1.0.1-beta.8...HEAD
[1.0.1-beta.8]: https://github.com/qaily/qaily-playwright-html-reporter/releases/tag/v1.0.1-beta.8
[1.0.1-beta.7]: https://github.com/qaily/qaily-playwright-html-reporter/releases/tag/v1.0.1-beta.7
[1.0.1-beta.6]: https://github.com/qaily/qaily-playwright-html-reporter/releases/tag/v1.0.1-beta.6
[1.0.1-beta.5]: https://github.com/qaily/qaily-playwright-html-reporter/releases/tag/v1.0.1-beta.5
[1.0.1-beta.4]: https://github.com/qaily/qaily-playwright-html-reporter/releases/tag/v1.0.1-beta.4
[1.0.1-beta.3]: https://github.com/qaily/qaily-playwright-html-reporter/releases/tag/v1.0.1-beta.3
[1.0.1-beta.2]: https://github.com/qaily/qaily-playwright-html-reporter/releases/tag/v1.0.1-beta.2
[1.0.1-beta.1]: https://github.com/qaily/qaily-playwright-html-reporter/releases/tag/v1.0.1-beta.1
[1.0.1-beta.0]: https://github.com/qaily/qaily-playwright-html-reporter/releases/tag/v1.0.1-beta.0
