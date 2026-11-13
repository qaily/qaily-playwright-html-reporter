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

Settings → **For the team** → Connections → S3 bucket / region / key prefix, then **Save to settings.json**
(writes `data/settings.json`, through `serve`). A report that reads its data from the bucket can't save these fields
to the bucket: it needs them to find the bucket, so set them in the site's `settings.json` (in CI, for example from
repository variables). The object key of an attachment is:

```
<prefix>/<run_id>/attachments/<file>      e.g. jsonl-report/2026-10-12T14-05-09-334_82a5885_4395/attachments/trace.zip
```

The default prefix is `jsonl-report`, as used by the upload step in [`report-site.example.yml`](report-site.example.yml).

## 2. Bucket settings

- Private, **Block Public Access** on.
- CORS, so browsers can read objects. `https://trace.playwright.dev` is only needed when you don't host the trace viewer
  yourself ([section 9](#9-self-hosted-trace-viewer)):

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
aws configure export-credentials --profile qaily-aws --format process     # JSON; leave out --profile for the default profile
# or: aws configure export-credentials --profile qaily-aws --format env   (export AWS_…= lines; PowerShell: --format powershell)

# Temporary credentials that expire after 12 hours, for a profile with permanent keys (an IAM user):
aws sts get-session-token --profile qaily-aws --duration-seconds 43200 --query Credentials --output json
```

`--profile` is the name given to `aws configure --profile <name>`; `aws configure list-profiles` lists them. Without it the CLI
uses the `default` profile and fails with "Unable to locate credentials" when there is none. Keep `--query Credentials` on
`get-session-token`: it removes the outer `{"Credentials": …}` wrapper, so the report can read the JSON.

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
- **Saving from the report:** Settings → For the team → **Save to bucket** writes `team-settings.json` with the viewer's key,
  after a confirmation that names the file. Fields marked *Saved to bucket* go there; the S3 fields are marked *Site settings.json only*.
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

### Looking at another bucket or data folder

Under Settings → For me, a viewer can point only their own browser at another dataset, without changing the site: another
folder in the same bucket (**Report data key prefix**, **S3 key prefix**, **Report data source**), or another bucket or storage
service (**S3 bucket**, **S3 region**, **S3 endpoint**, **Bucket in the URL path**). For AWS, leave **S3 endpoint** empty: an
empty value of your own replaces the site's endpoint. That dataset's own `team-settings.json` comes with it. The header then
shows the bucket or folder, and a bar under it has **Reset**, which returns to the report's own data. Changing the location,
either way, asks for a reload, and downloaded data of the old location is removed from the device.

Another bucket needs credentials that can read it (Settings → Tokens) and CORS rules on it for the site's origin, e.g.
`https://<org>.github.io`. This only affects the viewer's own browser: a bucket's `team-settings.json` never contains the
connection, so stored data can't redirect anyone.

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

## 9. Self-hosted trace viewer

By default, **Trace viewer** opens `https://trace.playwright.dev` with a signed link to the trace. That site fetches the
trace itself, so the bucket's CORS rules must allow it, and some networks block it.

You can host Playwright's trace viewer next to the report instead:

- **How it works.** The report reads `trace.zip` the way it reads everything else, then hands the file to the viewer's
  tab. The viewer never fetches from the bucket, so it needs no CORS rule. Traces open even when the bucket only allows
  the report's own origin, or (with the report's local server) no browser origin at all.
- **Copy it in CI, from the test project:**
  ```sh
  npx qaily-report trace-viewer --out site/trace
  ```
  A viewer only opens traces from its own Playwright version or older. So copy it from the Playwright that ran the
  tests; this package doesn't bundle one.
- **Point the report at it:** Settings → Connections → **Trace viewer**, relative to the report. Use `trace/` for a
  report at the site root, or `../trace/` for one in a subfolder such as `/bucket/`. As a team setting in
  `settings.json`:
  ```json
  { "connections": { "traceViewer": "trace/" } }
  ```
- **Locally,** `qaily-report serve` provides the viewer at `/trace/` when it runs in a folder where Playwright is
  installed, so the same setting works there.
- **Keep it on the report's origin.** The report checks that the viewer has loaded the trace by reading the tab's
  address. On another origin it can't, so it sends the trace a few times instead.

The viewer takes the trace through a message that Playwright uses but doesn't document. If a Playwright version
changes it, the report says the viewer didn't take the trace: download it and open it in the viewer with **Select file**.

## 10. Storage without CORS: the storage bridge

Some storage can't send CORS headers for your site. On Dell ECS, for example, only the storage team can add a CORS
rule, and browser CORS checks fail until they also set up a namespace base URL. ECS also sends
`Cross-Origin-Resource-Policy: same-origin`, which stops other sites from showing its images in `<img>`.

The storage bridge works around both, with nothing to change on the storage:

- **What it is.** `qaily-bridge.html` is a small page stored in the data folder. The report loads it in a hidden
  iframe. Its script runs on the storage's own origin, so its requests to the bucket need no CORS. It sends the
  answers to the report with `postMessage`.
- **What it holds.** No credentials. The report signs every URL with the viewer's credentials, as it does without the
  bridge, and the signature is the permission.
- **What it allows:**
  - requests only from the report sites it was uploaded for;
  - only signed URLs on its own host, under the bucket's run and data folders;
  - GET and HEAD, and PUT only for `team-settings.json`;
  - only the `Range` and `Content-Type` headers.
- **What it never does:** load other scripts or store anything. It is short, so read it once:
  `npx qaily-report bridge --origin https://<org>.github.io --dry-run` prints it.

### Turn it on

1. Upload it once, with a key that can write to the data folder:
   ```sh
   npx qaily-report bridge --origin https://<org>.github.io --out report-data
   ```
   `--origin` is the scheme and host of the report's site, without a path. Repeat it, or separate with commas, for
   several sites. Bucket, endpoint and folders come from `report-data/settings.json`, or from `--bucket`,
   `--endpoint`, `--prefix`, `--data-prefix`. Upload it again after a new report version changes the bridge; the
   report says so.
2. Set Settings → Connections → **Storage access** to **Bridge**. For everyone, put it in the site's `settings.json`:
   ```json
   { "connections": { "s3": { "transport": "bridge" } } }
   ```
   A viewer can switch it for themselves under **For me**: Direct turns the bridge off at once, Bridge turns it on.

With the bridge on, report data, text attachments, the "no longer in storage" check and Save to bucket all go through
it. Screenshots are downloaded through it and shown from memory. Traces open in the self-hosted trace viewer
([section 9](#9-self-hosted-trace-viewer)). Download and Open links don't need it: opening a link isn't affected by
CORS.

### If it doesn't load

The report says "The storage bridge did not load". Check:

- the page is in the data folder (`qaily-bridge.html`);
- the browser trusts the storage's TLS certificate: open any signed link from the report in a tab;
- `--origin` matched the report's site exactly, scheme included. If it didn't, the report says that site is not
  allowed.

It relies on the storage serving the page as HTML when the link asks for it (`response-content-type`), and allowing
it in an iframe. Storage that stops doing either needs CORS or the local server (`qaily-report serve`) instead.
