import {
  DEFAULT_SETTINGS,
  fieldByPath,
  resolveSettings,
  setPath,
  getPath,
  overlayLayer,
  withoutBucketConnection,
  type ResolvedSettings,
  type Settings,
  type SettingsApi,
  type SettingsLayer,
} from '@qaily/contracts';
import { readJson, remove, writeJson } from './storage.ts';

export const PERSONAL_SETTINGS_KEY = 'qaily.settings.v1';

/**
 * Personal settings key for the report at this path. Reports on one host (e.g. several on github.io) share
 * localStorage, so each keeps its own personal settings, such as a different bucket location.
 */
export function personalSettingsKey(reportPath: string): string {
  const path = reportPath.replace(/\/+$/, '') || '/';
  return path === '/' ? PERSONAL_SETTINGS_KEY : `${PERSONAL_SETTINGS_KEY}:${path}`;
}

/** Writes the team layer somewhere everyone reads it from. */
export interface TeamSettingsWriter {
  readonly label: string;
  /** Which team layer it writes: the site's settings.json (default), or team settings stored with the report data. */
  readonly target?: 'site' | 'data';
  /** False when the writer can't be used right now (e.g. no token yet). Default: always available. */
  available?(): boolean;
  save(layer: SettingsLayer): Promise<void>;
}

/** Saves through the local `qaily-report serve` (or Vite dev) server. */
export class LocalServerSettingsWriter implements TeamSettingsWriter {
  readonly label = 'local server';
  private readonly baseUrl: URL;

  constructor(baseUrl: URL) {
    this.baseUrl = baseUrl;
  }

  async save(layer: SettingsLayer): Promise<void> {
    const res = await fetch(new URL('__qaily/settings', this.baseUrl), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(layer),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Saving team settings failed (${res.status})`);
    }
  }
}

export interface ServerStatus {
  ok: boolean;
  /** This browser may write team settings (it is on the server's machine). */
  writes: boolean;
  /** The server resolves artifacts (local files, then S3). */
  artifacts: boolean;
}

/** Asks `qaily-report serve` what it offers. Null on static hosts such as GitHub Pages. */
export async function fetchServerStatus(baseUrl: URL): Promise<ServerStatus | null> {
  try {
    const res = await fetch(new URL('__qaily/status', baseUrl), { cache: 'no-store' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    const s = (await res.json()) as Partial<ServerStatus>;
    return s.ok ? { ok: true, writes: !!s.writes, artifacts: !!s.artifacts } : null;
  } catch {
    return null;
  }
}

/** A writer for the team layer; null when the report is read-only (e.g. GitHub Pages without a writer yet). */
export function teamWriterFor(server: ServerStatus | null, baseUrl: URL): TeamSettingsWriter | null {
  return server?.writes ? new LocalServerSettingsWriter(baseUrl) : null;
}

export async function loadTeamLayer(dataUrl: URL): Promise<SettingsLayer> {
  try {
    const res = await fetch(new URL('settings.json', dataUrl), { cache: 'no-cache' });
    if (!res.ok) return {};
    const json: unknown = await res.json();
    return json && typeof json === 'object' && !Array.isArray(json) ? (json as SettingsLayer) : {};
  } catch {
    return {};
  }
}

export class SettingsService implements SettingsApi {
  private listeners = new Set<(r: ResolvedSettings) => void>();
  private _resolved: ResolvedSettings;
  private _personal: SettingsLayer;
  /** settings.json on the site. */
  private _site: SettingsLayer;
  /** team-settings.json with the report data in the bucket; null when there is none (or it isn't loaded yet). */
  private _data: SettingsLayer | null = null;
  private writer: TeamSettingsWriter | null;
  private readonly defaults: Settings;
  private readonly storageKey: string;

  constructor(
    team: SettingsLayer,
    writer: TeamSettingsWriter | null,
    defaults: Settings = DEFAULT_SETTINGS,
    storageKey: string = PERSONAL_SETTINGS_KEY,
  ) {
    this._site = team;
    this.writer = writer;
    this.defaults = defaults;
    this.storageKey = storageKey;
    // A report that used the shared key before keeps those settings until it saves its own.
    this._personal = readJson<SettingsLayer>('local', storageKey) ?? readJson<SettingsLayer>('local', PERSONAL_SETTINGS_KEY) ?? {};
    this._resolved = this.resolve();
  }

  get resolved(): ResolvedSettings {
    return this._resolved;
  }
  /** The team layer in effect: the site's settings, with the bucket's team settings over them. */
  get team(): SettingsLayer {
    return this._data ? overlayLayer(this._site, this._data) : this._site;
  }
  get personal(): SettingsLayer {
    return this._personal;
  }
  /** True when team settings stored with the report data are applied. */
  get hasDataTeamLayer(): boolean {
    return this._data !== null;
  }

  /** Chooses where "Save for team" writes, once the report knows where its data comes from. */
  setWriter(writer: TeamSettingsWriter | null): void {
    this.writer = writer;
  }

  /** Team settings stored with the report data (bucket), over the site's. Null removes them. */
  setDataLayer(layer: SettingsLayer | null): void {
    if (JSON.stringify(layer) === JSON.stringify(this._data)) return;
    this._data = layer;
    this.update();
  }

  get canSaveTeam(): boolean {
    return this.writer !== null && (this.writer.available?.() ?? true);
  }

  get teamWriterLabel(): string | null {
    return this.writer?.label ?? null;
  }

  /** Where "Save for team" writes: the site's settings.json, or team-settings.json with the report data. */
  get teamTarget(): 'site' | 'data' | null {
    return this.writer ? (this.writer.target ?? 'site') : null;
  }
  get settings(): Settings {
    return this._resolved.settings;
  }

  /** value === undefined clears the personal override. */
  setPersonal(path: string, value: unknown): void {
    this.setPersonalMany({ [path]: value });
  }

  /** Several personal values in one update, e.g. resetting the bucket location. */
  setPersonalMany(values: Record<string, unknown>): void {
    let next = this._personal;
    for (const [path, value] of Object.entries(values)) {
      if (!fieldByPath(path)) throw new Error(`Unknown setting: ${path}`);
      next = setPath(next, path, value);
    }
    this.storePersonal(next);
  }

  async saveTeam(layer: SettingsLayer): Promise<void> {
    if (!this.writer) throw new Error('This report is read-only: no team settings writer is available');
    await this.writer.save(layer);
    if (this.writer.target === 'data') this._data = withoutBucketConnection(layer);
    else this._site = layer;
    this.update();
  }

  exportJson(): string {
    // Only non-secret settings exist in these layers; secrets live in SecretStore.
    return JSON.stringify({ team: this.team, personal: this._personal }, null, 2);
  }

  async importJson(json: string, target: 'personal' | 'team'): Promise<void> {
    const parsed = JSON.parse(json) as { team?: SettingsLayer; personal?: SettingsLayer } & SettingsLayer;
    const layer = (parsed.team || parsed.personal ? parsed[target] : parsed) ?? {};
    if (typeof layer !== 'object' || Array.isArray(layer)) throw new Error('Expected a settings object');
    if (target === 'team') return this.saveTeam(layer);
    this.storePersonal(layer);
  }

  subscribe(fn: (r: ResolvedSettings) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The value a field would have without the personal layer, for "reset to team". */
  teamOrDefault(path: string): unknown {
    return getPath(resolveSettings(this.defaults, this.team, {}).settings, path);
  }

  private storePersonal(layer: SettingsLayer): void {
    this._personal = layer;
    // A report with its own key keeps even an empty layer, so the shared key's settings don't come back.
    if (Object.keys(layer).length === 0 && this.storageKey === PERSONAL_SETTINGS_KEY) remove('local', this.storageKey);
    else writeJson('local', this.storageKey, layer);
    this.update();
  }

  private resolve(): ResolvedSettings {
    const resolved = resolveSettings(this.defaults, this.team, this._personal);
    for (const w of resolved.warnings) console.warn(`[qaily settings] ${w}`);
    return resolved;
  }

  private update(): void {
    this._resolved = this.resolve();
    for (const fn of this.listeners) fn(this._resolved);
  }
}
