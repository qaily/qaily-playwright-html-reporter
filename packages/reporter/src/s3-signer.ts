// Signs S3 artifact URLs with this machine's AWS login, for the local report server.
// Credentials never leave the server: the browser only ever sees short-lived presigned URLs.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, resolveSettings, type Settings, type SettingsLayer } from '@qaily/contracts';
import { presignS3Get, type AwsCredentials } from '@qaily/artifacts';

export type S3Config = Settings['connections']['s3'];

/** The team's S3 settings from <data>/settings.json, falling back to the defaults. */
export function readS3Config(dataDir: string): S3Config {
  let team: SettingsLayer = {};
  try {
    team = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')) as SettingsLayer;
  } catch {
    // No team settings yet.
  }
  return resolveSettings(DEFAULT_SETTINGS, team, null).settings.connections.s3;
}

export type ExecAws = (args: string[]) => Promise<string>;

const defaultExec: ExecAws = (args) =>
  new Promise((resolve, reject) => {
    execFile('aws', args, { timeout: 20_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
        reject(new Error(missing ? 'The AWS CLI (v2) is not installed or not on PATH.' : (stderr || err.message).trim()));
      } else resolve(stdout);
    });
  });

export interface SignerOptions {
  profile?: string;
  env?: NodeJS.ProcessEnv;
  exec?: ExecAws;
  now?: () => number;
}

export interface SignerStatus {
  ok: boolean;
  identity?: string;
  expiresAt?: string;
  error?: string;
}

export class LocalSigner {
  private opts: SignerOptions;
  private cached: { creds: AwsCredentials; identity: string; until: number } | null = null;
  private failure: { error: string; until: number } | null = null;
  private pending: Promise<void> | null = null;

  constructor(opts: SignerOptions = {}) {
    this.opts = opts;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Env keys first, then `aws configure export-credentials` (SSO, profiles, credential_process). */
  private async refresh(): Promise<void> {
    const env = this.opts.env ?? process.env;
    if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
      this.cached = {
        creds: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN || undefined },
        identity: 'environment variables',
        until: this.now() + 3600_000,
      };
      return;
    }
    const profile = this.opts.profile ?? env.AWS_PROFILE;
    try {
      const args = ['configure', 'export-credentials', '--format', 'process', ...(profile ? ['--profile', profile] : [])];
      const json = JSON.parse(await (this.opts.exec ?? defaultExec)(args)) as Record<string, string>;
      if (!json.AccessKeyId || !json.SecretAccessKey) throw new Error('The AWS CLI returned no credentials.');
      const expiresAt = json.Expiration ? Date.parse(json.Expiration) : NaN;
      this.cached = {
        creds: { accessKeyId: json.AccessKeyId, secretAccessKey: json.SecretAccessKey, sessionToken: json.SessionToken, expiration: json.Expiration },
        identity: profile ? `AWS profile "${profile}"` : 'default AWS profile',
        // Refresh five minutes before expiry; long-lived keys are re-read hourly.
        until: Number.isNaN(expiresAt) ? this.now() + 3600_000 : expiresAt - 5 * 60_000,
      };
      this.failure = null;
    } catch (err) {
      this.cached = null;
      // Don't run the CLI for every image while signed out.
      this.failure = { error: err instanceof Error ? err.message : String(err), until: this.now() + 30_000 };
    }
  }

  private async ensure(): Promise<void> {
    if (this.cached && this.cached.until > this.now()) return;
    if (this.failure && this.failure.until > this.now()) return;
    this.pending ??= this.refresh().finally(() => (this.pending = null));
    await this.pending;
  }

  async status(): Promise<SignerStatus> {
    await this.ensure();
    if (this.cached) return { ok: true, identity: this.cached.identity, expiresAt: this.cached.creds.expiration };
    return { ok: false, error: this.failure?.error ?? 'No AWS credentials found.' };
  }

  async presign(cfg: S3Config, key: string, downloadName?: string): Promise<string> {
    await this.ensure();
    if (!this.cached) throw new Error(this.failure?.error ?? 'No AWS credentials found.');
    const c = this.cached.creds;
    return presignS3Get({
      bucket: cfg.bucket,
      region: cfg.region,
      endpoint: cfg.endpoint,
      pathStyle: cfg.pathStyle,
      key,
      accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey,
      sessionToken: c.sessionToken,
      expiresIn: 600,
      downloadName,
      now: new Date(this.now()),
    });
  }
}
