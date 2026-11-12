# S3 storage: attachments and hosted reports

Playwright runs produce large artifacts (traces, videos, logs; up to ~1 GB per run). The report keeps only the small
JSONL summaries and reads attachments from a **private S3 bucket**, through short-lived presigned URLs.

The report never holds AWS secrets. Who signs depends on where it runs:

| Mode | When | Who signs |
|---|---|---|
| `static` | No bucket configured | Nobody: attachments are read from the report (`data/runs/<run>/attachments/…`) |
| `local` | Opened through `qaily-report serve` | The local server, with **this machine's AWS login**. Local files are served first; anything missing redirects to S3 |
| `browser` | Opened from GitHub Pages (or any static host) with a bucket configured | The page itself, with credentials the viewer pastes in **Settings → Tokens** |

Without credentials the report still works; attachments show "Stored in S3: connect to view".

## Choose where dashboard data lives

Attachments are always in the bucket. For dashboard data (catalog, rollups, per-run files) a hosted report has two options,
set in Settings → **For the team** → Connections → **Report data source**:

| | Website (default) | Bucket |
|---|---|---|
| Who can read test titles and errors | Anyone who can open the site | Only people with bucket access |
| Viewing dashboards | No credentials | Every viewer needs credentials |
| A stolen key exposes | Attachments | Attachments and all report data |
| New test data appears after | Rebuild and redeploy the site | Rebuild and `qaily-report publish`; no redeploy |
| First load of a page | From the site | From the bucket, with signed links |
| One site for several buckets | No, data is part of the site | Possible, if only `settings.json` differs |

Use **Website** when the site can be limited to the right people, or the data isn't sensitive: it is simpler, and viewers need
no keys for dashboards. Use **Bucket** when the data must stay private and access to the site can't be limited.
`qaily-report serve` always reads its own data folder, whichever source is set. The report header shows which source a page uses
(Website data, Website data · S3 files, Bucket data or Local server); hover it for details. See [Bucket data source](#7-bucket-data-source).

## 1. Configure the bucket in the report

Settings → **For the team** → Connections → S3 bucket / region / key prefix, then **Save for team**
(writes `data/settings.json`). The object key of an attachment is:

```
<prefix>/<run_id>/attachments/<file>      e.g. jsonl-report/2026-10-12T14-05-09-334_82a5885_4395/attachments/trace.zip
```

The default prefix is `jsonl-report`, as used by the upload step in [`report-site.example.yml`](report-site.example.yml).

## 2. Bucket settings

- Private, **Block Public Access** on.
- CORS, so browsers (and the Playwright trace viewer) can read objects:

```json
[
  {
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedOrigins": ["https://<your-org>.github.io", "http://127.0.0.1:4173", "http://localhost:4173", "https://trace.playwright.dev"],
    "AllowedHeaders": ["Range"],
    "ExposeHeaders": ["Content-Length", "Content-Range", "ETag", "Accept-Ranges"],
    "MaxAgeSeconds": 3000
  }
]
```

Without CORS, screenshots and downloads still work, but viewing a text attachment in the report fails, in local mode too.

### S3-compatible storage

The same setup works with storage that speaks the S3 API. Set these in Settings → For the team → Connections:

| | AWS | Google Cloud Storage | MinIO |
|---|---|---|---|
| S3 endpoint | Empty | `https://storage.googleapis.com` | The server's URL, e.g. `https://minio.example.com:9000` |
| S3 region | The bucket's region | `auto` | Usually `us-east-1` |
| Bucket in the URL path | Off | Off | Usually on |
| Credentials | SSO or temporary keys | HMAC key of a service account | MinIO access key |

The AWS CLI and `qaily-report` use these keys through a normal AWS profile (`aws configure --profile <name>`), then
`--aws-profile <name>`. These keys usually don't expire, so prefer local mode, or a read-only key limited to the bucket.

**Google Cloud Storage**

- CORS uses its own format; the JSON above is rejected. Apply this with
  `gcloud storage buckets update gs://<bucket> --cors-file=cors.json`. It applies to the whole bucket:

  ```json
  [
    {
      "origin": ["https://<your-org>.github.io", "http://127.0.0.1:4173", "http://localhost:4173", "https://trace.playwright.dev"],
      "method": ["GET", "HEAD"],
      "responseHeader": ["Range", "Content-Length", "Content-Range", "ETag", "Accept-Ranges"],
      "maxAgeSeconds": 3000
    }
  ]
  ```

- Uploading with AWS CLI 2.23 or later fails with `SignatureDoesNotMatch` unless you set
  `AWS_REQUEST_CHECKSUM_CALCULATION=when_required`. Reads don't need this. Or upload with `gcloud storage rsync`.

**MinIO**

- MinIO speaks the S3 API, but the report hasn't been checked against a live MinIO server yet. Please report problems.
- A report on `https://` can't load attachments from an `http://` server, because browsers block mixed content.
- Viewers' browsers fetch attachments directly, so they need network access to the server (a VPN, for example).

## 3. IAM

Viewer (read-only, used in the browser or by `qaily-report serve`):

```json
{
  "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::<bucket>/jsonl-report/*" }]
}
```

`qaily-report sync` additionally needs `s3:ListBucket` on `arn:aws:s3:::<bucket>` (condition `s3:prefix` = `jsonl-report/*`).
CI needs `s3:PutObject` on the same prefix. No other permissions are required.

With the Bucket data source, also add `arn:aws:s3:::<bucket>/qaily-data/*` to the viewer's `s3:GetObject` resources. The CI job that
publishes needs `s3:GetObject` and `s3:PutObject` on that path, and `s3:ListBucket` with `s3:prefix` = `qaily-data/*`.
Viewers don't need `s3:ListBucket` on the data prefix: `build` writes every file the report opens for a run, so a 403 there always
means an access problem. When attachments are deleted after a while (section 8), give viewers `s3:ListBucket` with `s3:prefix` = `jsonl-report/*`:
without it, AWS answers 403 instead of 404 for an attachment that has been removed, and the report can't tell "removed" from
"no access".

## 4. Local mode (`qaily-report serve`)

```bash
aws sso login                    # or AWS_PROFILE=..., or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY
npx qaily-report serve --data report-data --attachments reports/data [--aws-profile qa]
```

Credentials come from the environment keys first, otherwise from `aws configure export-credentials`
(AWS CLI v2; covers SSO, profiles and `credential_process`). They are cached until five minutes before they expire and
never sent to the browser. Settings → Tokens shows which login the server uses, or the CLI's error.

The server listens on `127.0.0.1` by default. The artifact route only answers requests from this machine, from the
report's own pages, or from `https://trace.playwright.dev`.

## 5. Browser mode (GitHub Pages)

Settings → Tokens → **AWS credentials**: paste the output of

```bash
aws configure export-credentials --format process     # JSON
# or: aws configure export-credentials --format env   (export AWS_…= lines; PowerShell: --format powershell)
```

Choose where to keep them: this tab only (default), remember on this device (localStorage), or not at all.
Expired credentials are deleted automatically. Use temporary credentials and the read-only policy above: any script on
the site can read stored credentials, and on `*.github.io` that may include other Pages sites under the same origin.

## 6. CI

See [`report-site.example.yml`](report-site.example.yml): after the tests, upload `attachments/` with `aws s3 sync`,
then sync the JSONL summaries, build the rollups and deploy the report to Pages **without** attachments.

## 7. Bucket data source

Set **Report data source** to Bucket, and keep **Report data key prefix** (default `qaily-data`) outside the S3 key prefix, because
`sync` would otherwise download it as run folders. `publish` refuses an overlapping prefix. Add the prefix to the IAM policies in section 3.

The site then holds only the app and `data/settings.json`, which says where the bucket is. CI publishes the data instead of deploying it:

```bash
npx qaily-report pull    --out data            # what was published last time, so build skips unchanged months
npx qaily-report sync    --to runs --out data  # run folders from the bucket, then build
npx qaily-report publish --out data            # upload changed files, catalog.json last
```

`report-site.example.yml` shows the full job. Redeploy the site only when the report's code or `settings.json` changes.

- **Credentials:** viewers paste them as in section 5. Without them the report shows a message and a link to connect. If they
  expire, data already loaded stays on screen and a banner asks the viewer to reconnect.
- **Links:** attachment links last 1 hour and are reused for 30 minutes; an image whose link has expired gets a new one. Report data
  links last 10 minutes and are used immediately.
- **On the device:** with **Remember on this device**, rollups are also kept in the browser so pages load faster. With the other
  choices, report data stays in memory only. Forgetting credentials, or their expiry, clears what is stored.
- **Not moved:** `data/settings.json` (it says where the bucket is) and AI notes in `data/ai/` stay on the site. AI notes can
  quote test errors, and saving one still needs a site redeploy.

### Team settings in the bucket

Lanes, thresholds, heat map rules and the other team settings can live with the data, as `team-settings.json` in the data
folder. After the viewer connects, the report applies them over the site's `settings.json`. They never contain the bucket
connection, so a file in the bucket can't send the report somewhere else.

- **First copy:** `publish` uploads `data/settings.json`, without the bucket connection, as `team-settings.json` when the
  data folder has none yet. After that it leaves the file alone, so changes saved from the report are kept.
  `--team-settings replace` overwrites it from `data/settings.json`; `--team-settings skip` never touches it.
- **Saving from the report:** Settings → For the team → **Save for team** writes `team-settings.json` with the viewer's key.
  Everyone viewing that data gets the change on their next load, with no redeploy. It needs:
  - a key that can write the file (`s3:PutObject` on `<data prefix>/team-settings.json`); read-only keys can still view;
  - `PUT` in the bucket's CORS rules, with the `Content-Type` header (below);
  - preferably **object versioning** on the bucket, so a bad save can be rolled back. Saves have no review step.
- **Two people at once:** before saving, the report checks that the file is still what it loaded. If someone else saved in
  the meantime, it stops and asks you to reload.

CORS for saving, in addition to the rules in section 2 (AWS format; for Google Cloud Storage add `PUT` to `method` and
`Content-Type` to `responseHeader`):

```json
{
  "AllowedMethods": ["PUT"],
  "AllowedOrigins": ["https://<your-org>.github.io"],
  "AllowedHeaders": ["Content-Type"],
  "MaxAgeSeconds": 3000
}
```

### Looking at another data folder

**Report data key prefix**, **S3 key prefix** and **Report data source** can also be set under Settings → For me. That
points only your browser at another dataset in the same bucket, for example a test folder, without changing the site.
Its own `team-settings.json` comes with it. The header then shows the folder, and a bar under it has **Reset**, which
returns to the report's own data. Changing the location, either way, asks for a reload, and downloaded data of the old
location is removed from the device.

Personal settings are kept per report path, so two reports on one host (for example `/` and `/bucket/` on GitHub Pages)
don't share them.

## 8. Short retention for attachments

Attachments (screenshots, traces, videos) are most of the bucket, and are rarely opened after a few days. `expire-attachments`
deletes `<prefix>/<run>/attachments/` of old runs and keeps the rest of each run folder (manifest, JSONL, `.sync-complete`), so
`build`, and anything else that reads the run folders, keeps working. The age is the command's argument, so nobody needs to
change the bucket's own settings. A lifecycle rule can't do this: its filter matches the start of a key, and `attachments/` is
in the middle of one.

```bash
npx qaily-report expire-attachments --out data --older-than 3 --dry-run   # what would go
npx qaily-report expire-attachments --out data --older-than 3             # delete it
```

A run is deleted only when all its attachments are older than the given days, so a run still being uploaded is never touched.
Run it once a day, for example as a scheduled CI job:

```yaml
on:
  schedule: [{ cron: '0 3 * * *' }]
jobs:
  expire:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4 # data/settings.json says where the bucket is
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - uses: aws-actions/configure-aws-credentials@v4
        with: { role-to-assume: '${{ secrets.REPORT_EXPIRE_ROLE_ARN }}', aws-region: eu-north-1 }
      - run: npm ci
      - run: npx qaily-report expire-attachments --out data --older-than 3
```

For MinIO or Google Cloud Storage, pass `--endpoint` (or keep it in `data/settings.json`) and the keys as `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY`.

Permissions for the job: `s3:ListBucket` on the bucket with `s3:prefix` = `jsonl-report/*`, and `s3:DeleteObject` on
`arn:aws:s3:::<bucket>/jsonl-report/*/attachments/*` (only attachments can be deleted).

**Versioning:** in a versioned bucket a delete only hides a file, and its old version is still stored and billed. Either add a
lifecycle rule that deletes noncurrent versions after a day, or, where you can't change the bucket, pass `--all-versions`: it
deletes old versions and delete markers of those attachments too, and needs `s3:ListBucketVersions` and `s3:DeleteObjectVersion`.
Google Cloud Storage doesn't support `--all-versions`; use its noncurrent-version rule there.

What viewers see for a run whose attachments are gone: the test view says they are no longer in storage and still shows the error
and steps; the issues page shows its bars instead of a screenshot. Give viewers `s3:ListBucket` with `s3:prefix` = `jsonl-report/*`
so AWS answers 404 for a removed file. Without it AWS answers 403, and the report can only say "removed, or no access".

### When run folders expire too

If the run folders themselves are deleted after a while (a lifecycle rule on `jsonl-report/`, say after 30 days), the dashboards
still keep every run, with the Bucket data source (section 7) and `pull` before `build` in CI:

- `build` keeps the rows of runs whose folders are gone, from the previous build. A run that has lost some of its files (a rule
  removes them one by one) is treated as expired, not changed. `build --prune-before YYYY-MM` drops older months for good.
- Each run's raw files stay in `qaily-data/runs/<run_id>/`, so runs and tests still open.
- `publish` refuses a catalog with fewer runs than the published one, the sign of a build without `pull`; `--allow-shrink`
  publishes anyway. A month that a bad publish hid comes back on the next build after a `pull`, from its rollups.

The Website data source builds from the run folders alone on every deploy, so with expiring run folders it would keep only what
is still in the bucket.
