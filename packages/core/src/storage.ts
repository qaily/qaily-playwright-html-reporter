// Browser storage can be missing or throw (private windows, blocked site data), so every access is guarded.

export type StorageKind = 'local' | 'session';

function area(kind: StorageKind): Storage | null {
  try {
    return kind === 'local' ? globalThis.localStorage ?? null : globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function readJson<T>(kind: StorageKind, key: string): T | null {
  try {
    const raw = area(kind)?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeJson(kind: StorageKind, key: string, value: unknown): boolean {
  try {
    const store = area(kind);
    if (!store) return false;
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function remove(kind: StorageKind, key: string): void {
  try {
    area(kind)?.removeItem(key);
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}
