// `qaily-report sync`: copies run folders from S3 with the AWS CLI, without attachments
// (they stay in S3 and are signed on demand), then the caller runs `build`.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEAM_SETTINGS_FILE, s3EndpointUrl } from '@qaily/artifacts';
import { withoutBucketConnection, type SettingsLayer } from '@qaily/contracts';
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
  log?: (msg: string) => void;
}

const trimSlashes = (s: string) => s.replace(/^\/+|\/+$/g, '');
const noBucket = () => new Error('No S3 bucket configured. Pass --bucket or set it in Settings → Connections (team).');

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

function commonArgs(o: { s3: S3Config; profile?: string }): string[] {
  const args = ['--region', o.s3.region, '--only-show-errors'];
  if (o.s3.endpoint?.trim()) args.push('--endpoint-url', s3EndpointUrl(o.s3.endpoint));
  if (o.profile) args.push('--profile', o.profile);
  return args;
}

// Kept with the website, not in the bucket: settings say where the bucket is, and AI notes are committed to the repo.
// Team settings in the bucket are written on their own (see publishTeamSettings), never by a folder sync.
const SITE_ONLY = ['--exclude', 'settings.json', '--exclude', 'ai/*', '--exclude', TEAM_SETTINGS_FILE];

/** Data upload, then the catalog on its own: viewers must never see a catalog that points at files not there yet. */
export function publishArgs(o: PublishOptions): string[][] {
  const dest = dataLocation(o.s3);
  return [
    ['s3', 'sync', o.dataDir, dest, ...SITE_ONLY, '--exclude', 'catalog.json', ...commonArgs(o)],
    ['s3', 'cp', join(o.dataDir, 'catalog.json'), `${dest}catalog.json`, ...commonArgs(o)],
  ];
}

/** Downloads what was published last time, so `build` only rebuilds months that changed. */
export function pullArgs(o: PublishOptions): string[] {
  return ['s3', 'sync', dataLocation(o.s3), o.dataDir, ...SITE_ONLY, ...commonArgs(o)];
}

export async function publish(o: PublishOptions): Promise<void> {
  if (!o.s3.bucket) throw noBucket();
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

/** True when the object exists; false only when the bucket says it doesn't. Any other failure throws. */
async function objectExists(o: PublishOptions, url: string): Promise<boolean> {
  const [, bucket, key] = /^s3:\/\/([^/]+)\/(.+)$/.exec(url)!;
  const { code, stderr } = await awsCapture(['s3api', 'head-object', '--bucket', bucket, '--key', key, ...commonArgs(o)], o.s3);
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

function awsCapture(args: string[], s3: S3Config): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('aws', args, { stdio: ['ignore', 'ignore', 'pipe'], env: awsEnv(s3) });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err) => reject(noCli(err)));
    child.on('exit', (code) => resolve({ code: code ?? 1, stderr }));
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
