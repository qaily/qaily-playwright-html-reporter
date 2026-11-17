# Storage: buckets, CORS, permissions and credentials

The details behind the README's [hosting modes](../README.md#4-host-the-report). Any S3-compatible storage works:

| Storage | Status | Browser access |
|---|---|---|
| **AWS S3** | Tested | CORS rules on the bucket |
| **Google Cloud Storage** | Tested (through its S3 API) | CORS rules on the bucket |
| **MinIO** | Speaks the same API; not yet checked against a live server | Server-wide CORS setting |
| **Dell ECS** | Through the [storage bridge](#9-storage-without-cors-the-storage-bridge); checked against a stand-in, not yet a live ECS | Bridge, or CORS if the storage team sets it up |

Please open an issue if something doesn't work with your storage.

## Contents

1. [How the report reads storage](#1-how-the-report-reads-storage)
2. [Storage settings for each provider](#2-storage-settings-for-each-provider)
3. [CORS](#3-cors)
4. [Permissions](#4-permissions)
5. [Credentials and the AWS CLI](#5-credentials-and-the-aws-cli)
6. [Bucket data source in detail](#6-bucket-data-source-in-detail)
7. [Team settings in the bucket](#7-team-settings-in-the-bucket)
8. [Looking at another bucket or data folder](#8-looking-at-another-bucket-or-data-folder)
9. [Storage without CORS: the storage bridge](#9-storage-without-cors-the-storage-bridge)
10. [Self-hosted trace viewer](#10-self-hosted-trace-viewer)
11. [When run folders expire too](#11-when-run-folders-expire-too)

## 1. How the report reads storage

The bucket holds two kinds of folders:

```
<bucket>/
├── jsonl-report/                  run folders (prefix), as the reporter wrote them
│   └── <run_id>/
│       ├── manifest.jsonl.gz      ... and the other JSONL files
│       ├── .sync-complete         written last by `qaily-report upload`
│       └── attachments/           screenshots, traces, videos, logs: the heavy part
└── qaily-data/                    report data (dataPrefix), Bucket data source only
    ├── catalog.json               index of months and runs
    ├── rollups/                   pre-aggregated data for the dashboards
    ├── runs/                      each run's JSONL, kept after its run folder expires
    ├── team-settings.json         team settings saved from the report
    └── qaily-bridge.html          the storage bridge, if you use it
```

The report never holds long-lived secrets in the site. Every file is read through a signed link that expires, and who
signs depends on where the report runs:

| Where | Who signs | Credentials |
|---|---|---|
| `qaily-report show` / `serve` | The local server, which also reads the file and passes it to the page | This machine's AWS CLI login. Never sent to the browser |
| GitHub Pages or any static host | The page | Pasted by each viewer in Settings → Tokens |
| No bucket configured | Nobody | Attachments are read from the site itself |

Without credentials the report still works: dashboards from the site load, and attachments show "Stored in S3:
connect to view".

## 2. Storage settings for each provider

These go in `connections.s3` of `report-data/settings.json` (or Settings → For the team → Connections):

| Setting | AWS S3 | Google Cloud Storage | MinIO | Dell ECS |
|---|---|---|---|---|
| `bucket` | Bucket name | Bucket name | Bucket name | Bucket name |
| `region` | The bucket's region | `auto` | Usually `us-east-1` | Any, e.g. `us-east-1` |
| `endpoint` | Empty | `https://storage.googleapis.com` | Server URL, e.g. `https://minio.example.com:9000` | Server URL, e.g. `https://ecs.example.com` |
| `pathStyle` | `false` | `false` | `true` | `true` |
| `transport` | `cors` | `cors` | `cors` | `bridge`, unless CORS is set up |
| Keys | IAM user or SSO | HMAC key of a service account | MinIO access key | ECS object user's S3 key |

```json
{
  "connections": {
    "s3": {
      "bucket": "test-reports",
      "region": "us-east-1",
      "endpoint": "https://ecs.example.com",
      "pathStyle": true,
      "prefix": "jsonl-report",
      "dataPrefix": "qaily-data",
      "transport": "bridge"
    }
  }
}
```

Notes per provider:

- **AWS S3:** keep **Block Public Access** on; the report needs no public access. Turn on versioning if team settings are
  saved from the report, so a bad save can be rolled back (and add a rule that deletes old versions, see
  [Retention](../README.md#7-retention)).
- **Google Cloud Storage:** create an HMAC key for a service account (`gcloud storage hmac create <service account email>`)
  and use it as the AWS key. `qaily-report` sets `AWS_REQUEST_CHECKSUM_CALCULATION=when_required` for custom endpoints, which
  uploads to Google Cloud Storage need with AWS CLI 2.23 or later. If you call the AWS CLI yourself, set it too.
- **MinIO:** a report on `https://` can't read an `http://` server (browsers block mixed content), and viewers' browsers
  need network access to the server, for example through a VPN.
- **Dell ECS:** see the [storage bridge](#9-storage-without-cors-the-storage-bridge). Storage on an internal network also needs a
  CI runner inside that network (a self-hosted runner).
- **Internal certificates:** if the storage uses a certificate from your company's CA, point the tools at it instead of
  turning verification off: `AWS_CA_BUNDLE=/path/to/ca.pem` for the AWS CLI, and `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` for
  `qaily-report` (`show` and `serve` read attachments with it). Browsers must trust it too for the report on a site
(usually already the case on company machines).

## 3. CORS

A browser lets the report read a file from another site only when that site's CORS rules allow it. What needs CORS:

| | Needs CORS |
|---|---|
| Report data with the Bucket data source (`catalog.json`, rollups, run details, `team-settings.json`) | Yes: everything |
| Viewing a text attachment, the "no longer in storage" check, the self-hosted trace viewer | Yes |
| **Save to bucket** (team settings) | Yes, with `PUT` |
| Screenshots in the page, **Download**, opening a file in a new tab | No (except on storage that sends `Cross-Origin-Resource-Policy`, such as Dell ECS) |
| `qaily-report show` / `serve` | No: the local server reads the bucket and serves each file from its own address |

Allow your site's origin (scheme and host, no path), for example `https://<org>.github.io`. Add
`https://trace.playwright.dev` only if you don't [host the trace viewer yourself](#10-self-hosted-trace-viewer).

**AWS S3** (console: bucket → Permissions → CORS, or `aws s3api put-bucket-cors --bucket <bucket> --cors-configuration file://cors.json`
with this list wrapped as `{"CORSRules": [...]}`):

```json
[
  {
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedOrigins": ["https://<org>.github.io"],
    "AllowedHeaders": ["Range"],
    "ExposeHeaders": ["Content-Length", "Content-Range", "ETag", "Accept-Ranges"],
    "MaxAgeSeconds": 3000
  },
  {
    "AllowedMethods": ["PUT"],
    "AllowedOrigins": ["https://<org>.github.io"],
    "AllowedHeaders": ["Content-Type"],
    "MaxAgeSeconds": 3000
  }
]
```

The `PUT` rule is only for **Save to bucket**.

**Google Cloud Storage** uses its own format, for the whole bucket:
`gcloud storage buckets update gs://<bucket> --cors-file=cors.json`

```json
[
  {
    "origin": ["https://<org>.github.io"],
    "method": ["GET", "HEAD", "PUT"],
    "responseHeader": ["Range", "Content-Type", "Content-Length", "Content-Range", "ETag", "Accept-Ranges"],
    "maxAgeSeconds": 3000
  }
]
```

**MinIO** sets CORS for the whole server; an admin can limit it with
`mc admin config set <alias> api cors_allow_origin="https://<org>.github.io"`.

**Dell ECS:** the bucket owner can set rules in the AWS format above (`aws s3api put-bucket-cors ... --endpoint-url <ECS URL>`),
but browsers' CORS checks carry no credentials, so ECS also needs a namespace base URL set up by its administrators. Until
then, use the [storage bridge](#9-storage-without-cors-the-storage-bridge).

## 4. Permissions

AWS policies; other providers have the same split with their own roles. Replace `<bucket>`, and the prefixes if you
changed them (`jsonl-report` for run folders, `qaily-data` for report data).

**Viewer** (browser, or `show` / `serve`): read only.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "s3:GetObject",
      "Resource": ["arn:aws:s3:::<bucket>/jsonl-report/*", "arn:aws:s3:::<bucket>/qaily-data/*"] },
    { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::<bucket>",
      "Condition": { "StringLike": { "s3:prefix": ["jsonl-report/*"] } } }
  ]
}
```

`s3:ListBucket` is optional. With it, AWS answers 404 for an attachment that retention deleted, and the report says "no
longer in storage". Without it, AWS answers 403, and the report can only say "removed, or no access". `show --sync` needs it.

**CI** (`upload`, `sync`, and with the Bucket data source `pull` and `publish`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": ["arn:aws:s3:::<bucket>/jsonl-report/*", "arn:aws:s3:::<bucket>/qaily-data/*"] },
    { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::<bucket>",
      "Condition": { "StringLike": { "s3:prefix": ["jsonl-report/*", "qaily-data/*"] } } }
  ]
}
```

**Retention job** (`expire-attachments`): `s3:ListBucket` with `s3:prefix` = `jsonl-report/*`, and `s3:DeleteObject` on
`arn:aws:s3:::<bucket>/jsonl-report/*/attachments/*` only. With `--all-versions`, also `s3:ListBucketVersions` and
`s3:DeleteObjectVersion`.

**Saving team settings from the report:** `s3:PutObject` on `arn:aws:s3:::<bucket>/qaily-data/team-settings.json`, for the
people who may change them.

**Uploading the storage bridge:** `s3:PutObject` on `arn:aws:s3:::<bucket>/qaily-data/qaily-bridge.html`, once.

## 5. Credentials and the AWS CLI

`qaily-report`'s bucket commands (`upload`, `sync`, `pull`, `publish`, `expire-attachments`, `bridge`, and `show` / `serve`
when they sign links) use the [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
and its login, for every provider.

**Set up a profile** (for Google Cloud Storage, MinIO and ECS too, with their keys):

```bash
aws configure --profile qaily          # asks for the access key, secret and default region
aws configure list-profiles            # the profiles on this machine
aws sts get-caller-identity --profile qaily   # check it works (AWS only)
```

With AWS IAM Identity Center (SSO):

```bash
aws configure sso --profile qaily
aws sso login --profile qaily          # again when the session expires
```

**Use it with `qaily-report`:** `--aws-profile qaily`, or `AWS_PROFILE=qaily`, or the `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY` (/ `AWS_SESSION_TOKEN`) environment variables, which win when set. In CI, use the variables from
repository secrets, or an OIDC role on AWS (`aws-actions/configure-aws-credentials`).

**Credentials for the browser** (Settings → Tokens → Storage credentials). Paste the output of one of these:

```bash
# The profile's current credentials, as JSON
aws configure export-credentials --profile qaily --format process

# Temporary credentials that expire after 12 hours, for a profile with permanent keys (an IAM user)
aws sts get-session-token --profile qaily --duration-seconds 43200 --query Credentials --output json
```

Leave out `--profile` only when you have a `default` profile; otherwise the CLI says "Unable to locate credentials". Keep
`--query Credentials` on `get-session-token`: it removes the outer `{"Credentials": ...}` wrapper. `--format env` (lines of
`export AWS_...=`) is accepted too.

Choose where the page keeps them: this tab only (default), remember on this device (localStorage), or not at all.
Expired credentials are deleted automatically. Prefer temporary credentials and a read-only policy: any script on the
site can read stored credentials, and on `*.github.io` that can include other Pages sites of the same owner.

Keys from Google Cloud Storage, MinIO and ECS usually don't expire, so prefer `show` / `serve` (the keys stay on your
machine), or a read-only key limited to the bucket.

## 6. Bucket data source in detail

With `"dataSource": "bucket"`, the site holds only the app and `settings.json`, and CI publishes the report data to
`<data prefix>/` instead of deploying it. Compared with the Website data source:

| | Website | Bucket |
|---|---|---|
| Who can read test titles and errors | Anyone who can open the site | Only people with bucket access |
| Viewing dashboards | No credentials | Every viewer needs credentials |
| New runs appear after | A site redeploy | `qaily-report publish`; no redeploy |
| Runs whose folders were deleted | Lost, unless CI also runs `pull` / `publish` | Kept |
| One site for several buckets | No | Yes, viewers can switch ([section 8](#8-looking-at-another-bucket-or-data-folder)) |

- **Data prefix:** keep it outside the run folders' prefix, or `sync` would download it as runs. `publish` refuses an
  overlapping prefix.
- **Links:** report data links last 10 minutes and are used immediately. Attachment links last 1 hour and are reused for
  30 minutes; an image whose link has expired gets a new one.
- **On the device:** with **Remember on this device**, rollups are also kept in the browser so pages load faster.
  Otherwise report data stays in memory only. Forgetting credentials, or their expiry, clears it.
- **Not in the bucket:** `settings.json` (it says where the bucket is) and AI notes (`data/ai/`) stay on the site.
- The report header shows the data source of the page (Website data, Website data · S3 files, Bucket data or Local
  server); hover it for details.

## 7. Team settings in the bucket

With the Bucket data source, lanes, thresholds, heat map rules and the other team settings can live with the data, as
`team-settings.json` in the data folder. They apply over the site's `settings.json`, and never contain the bucket
connection, so a file in the bucket can't send the report somewhere else.

- **First copy:** `publish` uploads `report-data/settings.json`, without the bucket connection, as `team-settings.json`
  when the data folder has none yet. After that it leaves the file alone, so changes saved from the report are kept.
  `--team-settings replace` overwrites it; `--team-settings skip` never touches it.
- **Saving from the report:** Settings → For the team → **Save to bucket** writes it with the viewer's key, after a
  confirmation that names the file. Fields marked *Saved to bucket* go there; the S3 fields are marked *Site
  settings.json only*. Everyone viewing that data gets the change on their next load. It needs write access to the file,
  and `PUT` in the CORS rules (or the storage bridge).
- **Two people at once:** before saving, the report checks that the file is still what it loaded. If someone else saved
  in the meantime, it stops and asks you to reload.

## 8. Looking at another bucket or data folder

Under Settings → **For me**, a viewer can point only their own browser at another dataset: another folder in the same
bucket (**Report data key prefix**, **S3 key prefix**, **Report data source**), or another bucket or storage service
(**S3 bucket**, **S3 region**, **S3 endpoint**, **Bucket in the URL path**). For AWS, leave **S3 endpoint** empty: an empty
value of your own replaces the site's endpoint. That dataset's own `team-settings.json` comes with it.

The header then shows the bucket or folder, with **Reset** to return to the report's own data. Changing the location asks
for a reload, and downloaded data of the old location is removed from the device. The other bucket needs credentials that
can read it, and CORS rules for the site. Personal settings are kept per report path, so two reports on one host (for
example `/` and `/bucket/`) don't share them.

## 9. Storage without CORS: the storage bridge

Some storage can't send CORS headers for your site. On Dell ECS, for example, only the storage team can add CORS rules,
and browsers' CORS checks fail until a namespace base URL is also set up. ECS also sends
`Cross-Origin-Resource-Policy: same-origin`, which stops other sites from showing its images.

The storage bridge works around both, with nothing to change on the storage:

- **What it is:** `qaily-bridge.html`, a small page in the data folder. The report loads it in a hidden iframe. Its
  script runs on the storage's own origin, so its requests to the bucket need no CORS. It passes the answers to the
  report with `postMessage`.
- **What it holds:** no credentials. The report signs every URL with the viewer's credentials, as without the bridge.
- **What it allows:** requests from the report sites it was uploaded for; signed URLs on its own host, under the run and
  data folders; GET and HEAD, and PUT only for `team-settings.json`; only the `Range` and `Content-Type` headers.
- **What it never does:** load other scripts or store anything. Read it before uploading:
  `npx qaily-report bridge --origin https://<org>.github.io --dry-run` prints it.

**Turn it on:**

1. Upload it once, with a key that can write to the data folder:
   ```bash
   npx qaily-report bridge --origin https://<org>.github.io --aws-profile qaily
   ```
   `--origin` is the scheme and host of the report's site. Repeat it, or separate with commas, for several sites. The
   bucket comes from `report-data/settings.json` or the bucket flags. Upload it again when a report version changes the
   bridge; the report says so.
2. Set Settings → Connections → **Storage access** to **Bridge**: for everyone with `"transport": "bridge"` in the site's
   `settings.json`, or for yourself under **For me**. **Direct** turns it off at once.

With the bridge on, report data, text attachments, the "no longer in storage" check and Save to bucket go through it.
Screenshots are downloaded through it and shown from memory, and traces open in the
[self-hosted trace viewer](#10-self-hosted-trace-viewer). Download and Open links don't need it.

**If the report says "The storage bridge did not load":**

- Check that `qaily-bridge.html` is in the data folder.
- Open any signed link from the report in a tab. A certificate warning means the browser doesn't trust the storage's
  certificate.
- If that tab downloads the bridge instead of showing a page, the storage ignores `response-content-type`, and the
  bridge can't work there.
- If the report says the site is not allowed, upload the bridge again with the exact `--origin`.

When the bridge can't work, use `qaily-report show` (the local server reads the bucket) or ask for CORS.

## 10. Self-hosted trace viewer

**Trace viewer** opens `https://trace.playwright.dev` by default, with a signed link to the trace. That site fetches the
trace itself, so the bucket's CORS rules must allow it, and some networks block it. Hosting Playwright's trace viewer next
to the report avoids both:

- **How it works:** the report reads `trace.zip` the way it reads everything else, then hands the file to the viewer's
  tab. The viewer never fetches from the bucket.
- **Copy it in CI, from the test project:** `npx qaily-report trace-viewer --out site/trace`. A viewer only opens traces
  from its own Playwright version or older, so it must come from the Playwright that ran the tests; this package doesn't
  bundle one.
- **Point the report at it:** `"connections": { "traceViewer": "trace/" }` in `settings.json`, relative to the report:
  `trace/` for a report at the site root, `../trace/` for one in a subfolder.
- **Locally,** `show` and `serve` provide it at `/trace/` when they run where Playwright is installed.
- **Keep it on the report's origin:** the report checks that the viewer has loaded the trace by reading the tab's address.

The viewer takes the trace through a message Playwright uses but doesn't document. If a Playwright version changes it,
the report says the viewer didn't take the trace: download it and use **Select file** in the viewer.

## 11. When run folders expire too

If whole run folders are deleted after a while (a lifecycle rule on `jsonl-report/`, see
[Retention](../README.md#7-retention)), the dashboards still keep every run, as long as CI keeps the report data between
builds: `pull` before `build`/`sync` and `publish` after it (the Bucket data source does this anyway).

- `build` keeps the rows of runs whose folders are gone, from the previous build. A run that has lost some of its files
  is treated as expired, not changed. `build --prune-before YYYY-MM` drops older months for good.
- Each run's raw JSONL stays in `<data prefix>/runs/<run_id>/`, so runs and tests still open.
- `publish` refuses a catalog with fewer runs than the published one, the sign of a build without `pull`;
  `--allow-shrink` publishes anyway.
