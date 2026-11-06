import type { SecretKey, SecretPersistence, SecretsApi } from '@qaily/contracts';
import { readJson, remove, writeJson } from './storage.ts';

const KEY = (k: SecretKey) => `qaily.secret.${k}`;
const ALL: SecretKey[] = ['agentHostToken', 'githubToken', 'awsCredentials'];

/**
 * Tokens and credentials. Kept apart from settings so they can never be exported or saved for the team.
 * Default persistence is this tab only (sessionStorage); localStorage only when the user opts in.
 */
export class SecretStore implements SecretsApi {
  private memory = new Map<SecretKey, string>();

  get(key: SecretKey): string | null {
    return this.memory.get(key) ?? readJson<string>('session', KEY(key)) ?? readJson<string>('local', KEY(key));
  }

  persistence(key: SecretKey): SecretPersistence | null {
    if (this.memory.has(key)) return 'memory';
    if (readJson<string>('session', KEY(key)) !== null) return 'session';
    if (readJson<string>('local', KEY(key)) !== null) return 'local';
    return null;
  }

  set(key: SecretKey, value: string, persistence: SecretPersistence): void {
    this.forget(key);
    if (persistence === 'memory') this.memory.set(key, value);
    else writeJson(persistence === 'session' ? 'session' : 'local', KEY(key), value);
  }

  forget(key: SecretKey): void {
    this.memory.delete(key);
    remove('session', KEY(key));
    remove('local', KEY(key));
  }

  forgetAll(): void {
    for (const key of ALL) this.forget(key);
  }
}
