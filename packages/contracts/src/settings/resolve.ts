import { SETTINGS_FIELDS, type SettingsScope } from './fields.ts';
import { SETTINGS_VERSION, type DeepPartial, type Settings } from './types.ts';

export type SettingsSource = 'default' | 'team' | 'personal';
export type SettingsLayer = DeepPartial<Settings> & { version?: number };

export interface ResolvedSettings {
  settings: Settings;
  /** Where each field's current value came from, keyed by field path. */
  sources: Record<string, SettingsSource>;
  warnings: string[];
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Returns a copy of obj with path set to value. value === undefined removes the key. */
export function setPath<T extends object>(obj: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split('.');
  const copy: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
  if (rest.length === 0) {
    if (value === undefined) delete copy[head];
    else copy[head] = value;
    return copy as T;
  }
  const child = copy[head];
  const next = setPath(child && typeof child === 'object' ? (child as object) : {}, rest.join('.'), value);
  if (Object.keys(next).length === 0) delete copy[head];
  else copy[head] = next;
  return copy as T;
}

function allowed(scope: SettingsScope, layer: 'team' | 'personal'): boolean {
  return scope === 'both' || scope === layer;
}

/** Upgrades a stored layer to the current settings version. Add a step here when renaming fields. */
export function migrateLayer(layer: SettingsLayer | null | undefined): SettingsLayer {
  if (!layer || typeof layer !== 'object') return {};
  const migrated: SettingsLayer = { ...layer };
  // Version 1 is the first version, so there is nothing to migrate yet.
  migrated.version = SETTINGS_VERSION;
  return migrated;
}

/**
 * Merges defaults < team < personal, one field at a time. A stored value that fails
 * validation, or sits in a layer its scope doesn't allow, is ignored with a warning.
 */
export function resolveSettings(
  defaults: Settings,
  team: SettingsLayer | null | undefined,
  personal: SettingsLayer | null | undefined,
): ResolvedSettings {
  const layers = { team: migrateLayer(team), personal: migrateLayer(personal) };
  let settings = structuredClone(defaults);
  const sources: Record<string, SettingsSource> = {};
  const warnings: string[] = [];

  for (const field of SETTINGS_FIELDS) {
    sources[field.path] = 'default';
    for (const name of ['team', 'personal'] as const) {
      const value = getPath(layers[name], field.path);
      if (value === undefined) continue;
      if (!allowed(field.scope, name)) {
        warnings.push(`${field.label}: ignored ${name} value, this setting is ${field.scope}-only`);
        continue;
      }
      const parsed = field.schema.safeParse(value);
      if (!parsed.success) {
        warnings.push(`${field.label}: ignored invalid ${name} value (${parsed.error.issues[0]?.message ?? 'invalid'})`);
        continue;
      }
      settings = setPath(settings, field.path, parsed.data);
      sources[field.path] = name;
    }
  }
  return { settings, sources, warnings };
}
