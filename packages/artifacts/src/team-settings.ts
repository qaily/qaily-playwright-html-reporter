// Team settings stored with the report data in the bucket (team-settings.json), for reports that read their data
// from a bucket. They travel with the data: point the report at another data folder and that folder's lanes, rules
// and thresholds come with it. Saving needs a key that can write to the data folder, and CORS that allows PUT.

import { withoutBucketConnection, type SettingsLayer } from '@qaily/contracts';
import type { ArtifactService } from './service.ts';

export const TEAM_SETTINGS_FILE = 'team-settings.json';

type Fetch = typeof fetch;

/** Reads and saves team-settings.json in the data folder, with the viewer's credentials. */
export class BucketTeamSettings {
  readonly target = 'data' as const;
  private readonly artifacts: Pick<ArtifactService, 'dataFileUrl' | 'credentials'>;
  private readonly where: () => string;
  private readonly fetch: Fetch;
  /** The file as last read or written; null = it didn't exist; undefined = not known (not read yet, or no access). */
  private seen: string | null | undefined = undefined;

  constructor(artifacts: Pick<ArtifactService, 'dataFileUrl' | 'credentials'>, where: () => string, fetchFn: Fetch = (...a) => fetch(...a)) {
    this.artifacts = artifacts;
    this.where = where;
    this.fetch = fetchFn;
  }

  get label(): string {
    return `bucket ${this.where()}`;
  }

  /** Saving needs credentials; whether they may write is only known when the bucket answers. */
  available(): boolean {
    return this.artifacts.credentials() !== null;
  }

  /** The stored team settings, or null when there are none, no credentials yet, or no read access. */
  async load(): Promise<SettingsLayer | null> {
    const text = await this.read();
    if (!text) return null;
    try {
      const json: unknown = JSON.parse(text);
      return json && typeof json === 'object' && !Array.isArray(json) ? withoutBucketConnection(json as SettingsLayer) : null;
    } catch {
      console.warn(`[qaily settings] ignored ${TEAM_SETTINGS_FILE}: not valid JSON`);
      return null;
    }
  }

  async save(layer: SettingsLayer): Promise<void> {
    // Two people saving at once: the second one is stopped rather than silently overwriting the first.
    const before = this.seen;
    const now = await this.read();
    if (before !== undefined && now !== undefined && now !== before) {
      throw new Error('Someone else changed the team settings after this page loaded them. Reload the page, then make your change again.');
    }
    const body = JSON.stringify(withoutBucketConnection(layer), null, 2) + '\n';
    const url = await this.artifacts.dataFileUrl(TEAM_SETTINGS_FILE, 'PUT');
    if (!url) throw new Error('Connect credentials in Settings → Tokens to save team settings to the bucket.');
    let res: Response;
    try {
      res = await this.fetch(url, { method: 'PUT', body, headers: { 'Content-Type': 'application/json' } });
    } catch {
      throw new Error(`Could not save to the bucket. Its CORS rules must allow PUT from ${globalThis.location?.origin ?? 'this site'}.`);
    }
    if (res.status === 403) {
      throw new Error(`The bucket refused the save (403). The key needs write access to ${this.where()}/${TEAM_SETTINGS_FILE}; read-only keys can't save.`);
    }
    if (!res.ok) throw new Error(`Saving team settings to the bucket failed (${res.status})`);
    this.seen = body;
  }

  /** The file's text; null when it doesn't exist; undefined when it can't be read. Remembers what it saw. */
  private async read(): Promise<string | null | undefined> {
    const url = await this.artifacts.dataFileUrl(TEAM_SETTINGS_FILE);
    if (!url) return undefined;
    try {
      const res = await this.fetch(url, { cache: 'no-store' });
      if (res.status === 404) return (this.seen = null);
      if (!res.ok) return undefined;
      return (this.seen = await res.text());
    } catch {
      return undefined;
    }
  }
}
