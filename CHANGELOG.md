# Changelog

All notable changes to `@qaily/playwright-html-reporter`. Versions follow [semantic versioning](https://semver.org); while
the version has a `-beta.N` suffix, minor changes may still break things. Add entries under `Unreleased`; the Release workflow
moves them into the new version's section (see [docs/releasing.md](docs/releasing.md)).

## [Unreleased]

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

[Unreleased]: https://github.com/qaily/qaily-playwright-html-reporter/compare/v1.0.1-beta.0...HEAD
[1.0.1-beta.0]: https://github.com/qaily/qaily-playwright-html-reporter/releases/tag/v1.0.1-beta.0
