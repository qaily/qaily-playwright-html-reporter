// `qaily-report expire-attachments`: deletes the attachments of runs older than N days from the run folders in the bucket,
// and keeps everything else there (manifest, JSONL, .sync-complete) for `build` and other readers of the run folders.
//
// A bucket lifecycle rule can't do this: its filter matches the start of a key, and attachments sit in the middle of one
// (<prefix>/<run_id>/attachments/…). Run it on a schedule instead, e.g. a daily CI job.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { S3Config } from './s3-signer.ts';
import { awsCapture, commonArgs, noBucket } from './sync.ts';

export interface ExpireOptions {
  s3: S3Config;
  /** Attachments of runs whose newest attachment is older than this many days are deleted. */
  olderThanDays: number;
  profile?: string;
  /** Only report what would be deleted. */
  dryRun?: boolean;
  /**
   * Also delete old versions and delete markers, for a bucket with versioning where nobody can add a lifecycle rule
   * for noncurrent versions. Needs s3:ListBucketVersions and s3:DeleteObjectVersion. Not for Google Cloud Storage.
   */
  allVersions?: boolean;
  now?: Date;
  log?: (msg: string) => void;
}

export interface StoredAttachment {
  key: string;
  /** Set when listed with versions. */
  versionId?: string;
  lastModified: string;
  size: number;
  /** A delete marker (with versions only): it doesn't count for age. */
  marker?: boolean;
}

export interface ExpiredRun {
  runId: string;
  objects: StoredAttachment[];
  bytes: number;
}

const trimSlashes = (s: string) => s.replace(/^\/+|\/+$/g, '');

/** Run id of an attachment key (<prefix>/<run_id>/attachments/…), or null for any other key. */
export function attachmentRunId(key: string, prefix: string): string | null {
  const root = `${trimSlashes(prefix)}/`;
  if (!key.startsWith(root)) return null;
  const [runId, folder, ...rest] = key.slice(root.length).split('/');
  return runId && folder === 'attachments' && rest.length && rest.at(-1) ? runId : null;
}

/** Runs whose attachments are all older than the cutoff, oldest first. A run still being uploaded is never one of them. */
export function selectExpiredRuns(objects: StoredAttachment[], prefix: string, cutoff: Date): ExpiredRun[] {
  const byRun = new Map<string, { objects: StoredAttachment[]; newest: number }>();
  for (const o of objects) {
    const runId = attachmentRunId(o.key, prefix);
    if (!runId) continue;
    const run = byRun.get(runId) ?? { objects: [], newest: 0 };
    run.objects.push(o);
    if (!o.marker) run.newest = Math.max(run.newest, Date.parse(o.lastModified));
    byRun.set(runId, run);
  }
  return [...byRun]
    .filter(([, r]) => r.newest > 0 && r.newest < cutoff.getTime())
    .sort(([, a], [, b]) => a.newest - b.newest)
    .map(([runId, r]) => ({ runId, objects: r.objects, bytes: r.objects.reduce((n, o) => n + (o.marker ? 0 : o.size), 0) }));
}

const formatMb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export async function expireAttachments(o: ExpireOptions): Promise<ExpiredRun[]> {
  if (!o.s3.bucket) throw noBucket();
  const prefix = trimSlashes(o.s3.prefix);
  // An empty prefix would make every top-level folder of the bucket a "run folder".
  if (!prefix) throw new Error('No S3 key prefix configured. Pass --prefix or set it in Settings → Connections (team).');
  if (!(o.olderThanDays > 0)) throw new Error('--older-than must be a number of days above 0');
  const log = o.log ?? (() => {});
  const cutoff = new Date((o.now ?? new Date()).getTime() - o.olderThanDays * 86_400_000);

  const objects = await listAttachments(o, prefix);
  const runs = selectExpiredRuns(objects, prefix, cutoff);
  const files = runs.reduce((n, r) => n + r.objects.filter((x) => !x.marker).length, 0);
  const bytes = runs.reduce((n, r) => n + r.bytes, 0);
  log(
    `${runs.length} run(s) with attachments older than ${o.olderThanDays} day(s) (before ${cutoff.toISOString()}): ` +
      `${files} file(s), ${formatMb(bytes)}${o.dryRun ? ' — dry run, nothing deleted' : ''}`,
  );
  if (o.dryRun || !runs.length) return runs;

  if (o.allVersions) {
    await deleteVersions(o, runs.flatMap((r) => r.objects));
  } else {
    // `aws s3 rm` deletes one object per request, which every S3-compatible service supports (GCS has no multi-delete).
    for (const run of runs) {
      log(`Deleting attachments of ${run.runId} (${formatMb(run.bytes)})`);
      const { code, stderr } = await awsCapture(
        ['s3', 'rm', `s3://${o.s3.bucket}/${prefix}/${run.runId}/attachments/`, '--recursive', ...commonArgs(o)],
        o.s3,
      );
      if (code !== 0) throw new Error(`Could not delete attachments of ${run.runId}: ${stderr.trim() || `aws exited with code ${code}`}`);
    }
  }
  log(`Deleted ${formatMb(bytes)} of attachments from ${runs.length} run(s)`);
  return runs;
}

async function listAttachments(o: ExpireOptions, prefix: string): Promise<StoredAttachment[]> {
  const filter = `[?contains(Key, '/attachments/')]`;
  const args = o.allVersions
    ? ['s3api', 'list-object-versions', '--query',
      `{v: Versions${filter}.[Key, VersionId, LastModified, Size], d: DeleteMarkers${filter}.[Key, VersionId, LastModified]}`]
    : ['s3api', 'list-objects-v2', '--query', `{v: Contents${filter}.[Key, '', LastModified, Size], d: \`[]\`}`];
  const { code, stdout, stderr } = await awsCapture(
    [...args, '--bucket', o.s3.bucket, '--prefix', `${prefix}/`, '--output', 'json', ...commonArgs(o, 's3api')],
    o.s3,
  );
  if (code !== 0) throw new Error(`Could not list s3://${o.s3.bucket}/${prefix}/: ${stderr.trim() || `aws exited with code ${code}`}`);
  type Row = [string, string | null, string, number?];
  const parsed = JSON.parse(stdout || '{}') as { v?: Row[] | null; d?: Row[] | null };
  const versioned = (id: string | null) => (o.allVersions && id ? { versionId: id } : {});
  return [
    ...(parsed.v ?? []).map(([key, id, lastModified, size]) => ({ key, lastModified, size: size ?? 0, ...versioned(id) })),
    ...(parsed.d ?? []).map(([key, id, lastModified]) => ({ key, lastModified, size: 0, marker: true, ...versioned(id) })),
  ];
}

async function deleteVersions(o: ExpireOptions, objects: StoredAttachment[]): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'qaily-expire-'));
  try {
    for (let i = 0; i < objects.length; i += 1000) {
      const batch = objects.slice(i, i + 1000).map((x) => ({ Key: x.key, ...(x.versionId ? { VersionId: x.versionId } : {}) }));
      const file = join(dir, 'delete.json');
      writeFileSync(file, JSON.stringify({ Objects: batch, Quiet: true }));
      o.log?.(`Deleting ${batch.length} object version(s)`);
      const { code, stdout, stderr } = await awsCapture(
        ['s3api', 'delete-objects', '--bucket', o.s3.bucket, '--delete', `file://${file}`, '--output', 'json', ...commonArgs(o, 's3api')],
        o.s3,
      );
      if (code !== 0) throw new Error(`Could not delete attachment versions: ${stderr.trim() || `aws exited with code ${code}`}`);
      const errors = (JSON.parse(stdout || '{}') as { Errors?: { Key: string; Message: string }[] }).Errors ?? [];
      if (errors.length) throw new Error(`Could not delete ${errors.length} object(s), e.g. ${errors[0].Key}: ${errors[0].Message}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
