// `qaily-report sync`: copies run folders from S3 with the AWS CLI, without attachments
// (they stay in S3 and are signed on demand), then the caller runs `build`.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRIDGE_FILE, TEAM_SETTINGS_FILE, s3EndpointUrl } from '@qaily/artifacts';
import { withoutBucketConnection, type Catalog, type SettingsLayer } from '@qaily/contracts';
import type { S3Config } from './s3-signer.ts';

export interface SyncOptions {
  s3: S3Config;
  toDir: string;
  profile?: string;
  /** Also copy attachments (big). Off by default. */
  withAttachments?: boolean;
  log?: (msg: string) => void;
}

export function syncArgs(o: SyncOptions): string[] {
  const prefix = o.s3.prefix.replace(/^\/+|\/+$/g, '');
  const args = ['s3', 'sync', `s3://${o.s3.bucket}/${prefix ? `${prefix}/` : ''}`, o.toDir, '--region', o.s3.region, '--only-show-errors'];
  // The CLI uses path-style addressing by itself with a custom endpoint, so pathStyle isn't needed here.
  if (o.s3.endpoint?.trim()) args.push('--endpoint-url', s3EndpointUrl(o.s3.endpoint));
  if (!o.withAttachments) args.push('--exclude', '*/attachments/*');
  if (o.profile) args.push('--profile', o.profile);
  return args;
}

export function sync(o: SyncOptions): Promise<void> {
  if (!o.s3.bucket) return Promise.reject(noBucket());
  return aws(syncArgs(o), o.s3, o.log);
}

export interface PublishOptions {
  s3: S3Config;
  dataDir: string;
  profile?: string;
  /**
   * Team settings in the data folder (team-settings.json), which a report reading from the bucket uses and saves to.
   * seed (default): upload <data dir>/settings.json only when the bucket has none yet, so saves from the report are
   * kept. replace: always upload it. skip: leave the bucket's copy alone.
   */
  teamSettings?: 'seed' | 'replace' | 'skip';
  /** publish: upload a catalog with fewer runs than the published one (otherwise refused, see shrinkError). */
  allowShrink?: boolean;
  log?: (msg: string) => void;
}

const trimSlashes = (s: string) => s.replace(/^\/+|\/+$/g, '');
export const noBucket = () => new Error('No S3 bucket configured. Pass --bucket or set it in Settings → Connections (team).');

/** The data folder must sit outside the run folders, or `sync` would download it and treat it as runs. */
export function dataLocation(s3: S3Config): string {
  const data = trimSlashes(s3.dataPrefix);
  const runs = trimSlashes(s3.prefix);
  if (!data) throw new Error('No report data key prefix configured. Pass --data-prefix or set it in Settings → Connections (team).');
  if (!runs || data === runs || data.startsWith(`${runs}/`) || runs.startsWith(`${data}/`)) {
    throw new Error(`The report data key prefix "${data}" must be outside the S3 key prefix "${runs}".`);
  }
  return `s3://${s3.bucket}/${data}/`;
}

/** Region, endpoint and profile for an AWS CLI call. --only-show-errors exists for `aws s3` only; `aws s3api` rejects it. */
export function commonArgs(o: { s3: S3Config; profile?: string }, api: 's3' | 's3api' = 's3'): string[] {
  const args = ['--region', o.s3.region, ...(api === 's3' ? ['--only-show-errors'] : [])];
  if (o.s3.endpoint?.trim()) args.push('--endpoint-url', s3EndpointUrl(o.s3.endpoint));
  if (o.profile) args.push('--profile', o.profile);
  return args;
}

// Kept with the website, not in the bucket: settings say where the bucket is, and AI notes are committed to the repo.
// Team settings in the bucket are written on their own (see publishTeamSettings), never by a folder sync.
// The storage bridge page is uploaded by `qaily-report bridge` only.
const SITE_ONLY = ['--exclude', 'settings.json', '--exclude', 'ai/*', '--exclude', TEAM_SETTINGS_FILE, '--exclude', BRIDGE_FILE];

/** Data upload, then the catalog on its own: viewers must never see a catalog that points at files not there yet. */
export function publishArgs(o: PublishOptions): string[][] {
  const dest = dataLocation(o.s3);
  return [
    ['s3', 'sync', o.dataDir, dest, ...SITE_ONLY, '--exclude', 'catalog.json', ...commonArgs(o)],
    ['s3', 'cp', join(o.dataDir, 'catalog.json'), `${dest}catalog.json`, ...commonArgs(o)],
  ];
}

/**
 * Downloads what was published last time, so `build` only rebuilds months that changed and keeps runs whose folders
 * have expired. Not the raw per-run copies (runs/): build doesn't read them, and they grow with every run.
 */
export function pullArgs(o: PublishOptions): string[] {
  return ['s3', 'sync', dataLocation(o.s3), o.dataDir, ...SITE_ONLY, '--exclude', 'runs/*', ...commonArgs(o)];
}

/**
 * Why a catalog must not replace the published one, or null when it may. A catalog with fewer runs usually comes from a
 * build without `pull` first: with short retention on run folders it would hide every month but the last few days.
 */
export function shrinkError(local: Pick<Catalog, 'runCount' | 'prunedBefore'>, published: Pick<Catalog, 'runCount' | 'prunedBefore'> | null): string | null {
  if (!published || local.runCount >= published.runCount) return null;
  if ((local.prunedBefore ?? '') > (published.prunedBefore ?? '')) return null;
  return (
    `The new catalog has ${local.runCount} runs, the published one ${published.runCount}. ` +
    'Run `qaily-report pull` before `build`, so runs whose folders have expired are kept. ' +
    'Pass --allow-shrink to publish it anyway.'
  );
}

export async function publish(o: PublishOptions): Promise<void> {
  if (!o.s3.bucket) throw noBucket();
  if (!o.allowShrink) {
    const local = JSON.parse(readFileSync(join(o.dataDir, 'catalog.json'), 'utf8')) as Catalog;
    const error = shrinkError(local, await publishedCatalog(o));
    if (error) throw new Error(error);
  }
  const [data, catalog] = publishArgs(o);
  await aws(data, o.s3, o.log);
  await publishTeamSettings(o);
  await aws(catalog, o.s3, o.log);
}

/** <data dir>/settings.json as team settings for the bucket: without the bucket connection. Null when there is nothing else. */
export function teamSettingsForBucket(dataDir: string): SettingsLayer | null {
  const file = join(dataDir, 'settings.json');
  if (!existsSync(file)) return null;
  const layer = withoutBucketConnection(JSON.parse(readFileSync(file, 'utf8')) as SettingsLayer);
  return Object.keys(layer).some((k) => k !== 'version') ? layer : null;
}

async function publishTeamSettings(o: PublishOptions): Promise<void> {
  const mode = o.teamSettings ?? 'seed';
  if (mode === 'skip') return;
  const layer = teamSettingsForBucket(o.dataDir);
  if (!layer) return;
  const dest = `${dataLocation(o.s3)}${TEAM_SETTINGS_FILE}`;
  if (mode === 'seed' && (await objectExists(o, dest))) {
    o.log?.(`${TEAM_SETTINGS_FILE} is already in the bucket: kept (pass --team-settings replace to overwrite it)`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'qaily-'));
  try {
    const file = join(dir, TEAM_SETTINGS_FILE);
    writeFileSync(file, JSON.stringify(layer, null, 2) + '\n');
    await aws(['s3', 'cp', file, dest, '--content-type', 'application/json', ...commonArgs(o)], o.s3, o.log);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The published catalog.json, or null when there is none yet. */
async function publishedCatalog(o: PublishOptions): Promise<Catalog | null> {
  const url = `${dataLocation(o.s3)}catalog.json`;
  const { code, stdout, stderr } = await awsCapture(['s3', 'cp', url, '-', ...commonArgs(o)], o.s3);
  if (code === 0) return JSON.parse(stdout) as Catalog;
  if (/\b(404|Not Found|NoSuchKey|does not exist)\b/i.test(stderr)) return null;
  throw new Error(`Could not read ${url}: ${stderr.trim() || `aws exited with code ${code}`}`);
}

/** True when the object exists; false only when the bucket says it doesn't. Any other failure throws. */
async function objectExists(o: PublishOptions, url: string): Promise<boolean> {
  const [, bucket, key] = /^s3:\/\/([^/]+)\/(.+)$/.exec(url)!;
  const { code, stderr } = await awsCapture(['s3api', 'head-object', '--bucket', bucket, '--key', key, ...commonArgs(o, 's3api')], o.s3);
  if (code === 0) return true;
  if (/\b(404|Not Found|NoSuchKey)\b/i.test(stderr)) return false;
  throw new Error(`Could not check ${url}: ${stderr.trim() || `aws exited with code ${code}`}`);
}

export async function pull(o: PublishOptions): Promise<void> {
  if (!o.s3.bucket) throw noBucket();
  await aws(pullArgs(o), o.s3, o.log);
}

// AWS CLI 2.23+ adds checksums that S3-compatible services such as Google Cloud Storage reject with SignatureDoesNotMatch.
const awsEnv = (s3: S3Config) => (s3.endpoint?.trim() ? { AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required', ...process.env } : process.env);
const noCli = (err: Error) =>
  (err as NodeJS.ErrnoException).code === 'ENOENT' ? new Error('The AWS CLI (v2) is not installed or not on PATH.') : err;

export function awsCapture(args: string[], s3: S3Config): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('aws', args, { stdio: ['ignore', 'pipe', 'pipe'], env: awsEnv(s3) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err) => reject(noCli(err)));
    child.on('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function aws(args: string[], s3: S3Config, log?: (msg: string) => void): Promise<void> {
  log?.(`aws ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    const child = spawn('aws', args, { stdio: 'inherit', env: awsEnv(s3) });
    child.on('error', (err) => reject(noCli(err)));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`aws s3 ${args[1]} exited with code ${code}`))));
  });
}
