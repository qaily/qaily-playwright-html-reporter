import {
  DEFAULT_SETTINGS,
  fieldByPath,
  resolveSettings,
  setPath,
  getPath,
  type ResolvedSettings,
  type Settings,
  type SettingsApi,
  type SettingsLayer,
} from '@qaily/contracts';
import { readJson, remove, writeJson } from './storage.ts';

export const PERSONAL_SETTINGS_KEY = 'qaily.settings.v1';

/** Writes the team layer somewhere everyone reads it from. */
export interface TeamSettingsWriter {
  readonly label: string;
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
  private _team: SettingsLayer;
  private readonly writer: TeamSettingsWriter | null;
  private readonly defaults: Settings;

  constructor(team: SettingsLayer, writer: TeamSettingsWriter | null, defaults: Settings = DEFAULT_SETTINGS) {
    this._team = team;
    this.writer = writer;
    this.defaults = defaults;
    this._personal = readJson<SettingsLayer>('local', PERSONAL_SETTINGS_KEY) ?? {};
    this._resolved = this.resolve();
  }

  get resolved(): ResolvedSettings {
    return this._resolved;
  }
  get team(): SettingsLayer {
    return this._team;
  }
  get personal(): SettingsLayer {
    return this._personal;
  }
  get canSaveTeam(): boolean {
    return this.writer !== null && (this.writer.available?.() ?? true);
  }

  get teamWriterLabel(): string | null {
    return this.writer?.label ?? null;
  }
  get settings(): Settings {
    return this._resolved.settings;
  }

  /** value === undefined clears the personal override. */
  setPersonal(path: string, value: unknown): void {
    if (!fieldByPath(path)) throw new Error(`Unknown setting: ${path}`);
    this._personal = setPath(this._personal, path, value);
    if (Object.keys(this._personal).length === 0) remove('local', PERSONAL_SETTINGS_KEY);
    else writeJson('local', PERSONAL_SETTINGS_KEY, this._personal);
    this.update();
  }

  async saveTeam(layer: SettingsLayer): Promise<void> {
    if (!this.writer) throw new Error('This report is read-only: no team settings writer is available');
    await this.writer.save(layer);
    this._team = layer;
    this.update();
  }

  exportJson(): string {
    // Only non-secret settings exist in these layers; secrets live in SecretStore.
    return JSON.stringify({ team: this._team, personal: this._personal }, null, 2);
  }

  async importJson(json: string, target: 'personal' | 'team'): Promise<void> {
    const parsed = JSON.parse(json) as { team?: SettingsLayer; personal?: SettingsLayer } & SettingsLayer;
    const layer = (parsed.team || parsed.personal ? parsed[target] : parsed) ?? {};
    if (typeof layer !== 'object' || Array.isArray(layer)) throw new Error('Expected a settings object');
    if (target === 'team') return this.saveTeam(layer);
    this._personal = layer;
    writeJson('local', PERSONAL_SETTINGS_KEY, layer);
    this.update();
  }

  subscribe(fn: (r: ResolvedSettings) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The value a field would have without the personal layer, for "reset to team". */
  teamOrDefault(path: string): unknown {
    return getPath(resolveSettings(this.defaults, this._team, {}).settings, path);
  }

  private resolve(): ResolvedSettings {
    const resolved = resolveSettings(this.defaults, this._team, this._personal);
    for (const w of resolved.warnings) console.warn(`[qaily settings] ${w}`);
    return resolved;
  }

  private update(): void {
    this._resolved = this.resolve();
    for (const fn of this.listeners) fn(this._resolved);
  }
}
