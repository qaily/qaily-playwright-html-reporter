// AWS credentials pasted by the viewer: the JSON from `aws configure export-credentials --format process`,
// or the `export AWS_…=` / `$Env:AWS_…=` / `set AWS_…=` lines that `--format env*` prints.

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** ISO time; absent for long-lived keys. */
  expiration?: string;
}

const ENV_LINE = /^\s*(?:export\s+|\$env:|set\s+)?(AWS_[A-Z_]+)\s*=\s*["']?([^"'\r\n]*)["']?\s*;?\s*$/i;

export function parseCredentials(input: string): AwsCredentials {
  const text = input.trim();
  if (!text) throw new Error('Paste the output of `aws configure export-credentials`.');

  let creds: Partial<AwsCredentials> = {};
  if (text.startsWith('{')) {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error('That looks like JSON but could not be parsed.');
    }
    creds = {
      accessKeyId: String(json.AccessKeyId ?? ''),
      secretAccessKey: String(json.SecretAccessKey ?? ''),
      sessionToken: json.SessionToken ? String(json.SessionToken) : undefined,
      expiration: json.Expiration ? String(json.Expiration) : undefined,
    };
  } else {
    const vars: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
      const m = ENV_LINE.exec(line);
      if (m) vars[m[1].toUpperCase()] = m[2].trim();
    }
    creds = {
      accessKeyId: vars.AWS_ACCESS_KEY_ID ?? '',
      secretAccessKey: vars.AWS_SECRET_ACCESS_KEY ?? '',
      sessionToken: vars.AWS_SESSION_TOKEN || undefined,
      expiration: vars.AWS_CREDENTIAL_EXPIRATION || undefined,
    };
  }

  // Not only AWS keys (AKIA…/ASIA…): GCS HMAC ids start with GOOG, and MinIO's can be any short name.
  if (!/^[A-Za-z0-9._~+=/-]{3,128}$/.test(creds.accessKeyId ?? '')) {
    throw new Error('No valid access key id found.');
  }
  if (!creds.secretAccessKey || creds.secretAccessKey.length < 8) throw new Error('No secret access key found.');
  if (creds.expiration && Number.isNaN(Date.parse(creds.expiration))) throw new Error('The expiration time is not a valid date.');
  if (creds.expiration && isExpired(creds as AwsCredentials)) throw new Error('These credentials have already expired.');
  return creds as AwsCredentials;
}

/** Expired, or expiring within the margin (so a presigned URL never outlives its credentials by surprise). */
export function isExpired(c: AwsCredentials, now = new Date(), marginMs = 60_000): boolean {
  return !!c.expiration && Date.parse(c.expiration) - marginMs <= now.getTime();
}

export function isTemporary(c: AwsCredentials): boolean {
  return c.accessKeyId.startsWith('ASIA') || !!c.sessionToken;
}

export function maskKeyId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : '****';
}
