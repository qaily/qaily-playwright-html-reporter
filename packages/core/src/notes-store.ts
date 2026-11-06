import type { NotesApi } from '@qaily/contracts';
import { readJson, writeJson } from './storage.ts';

const KEY = 'qaily.notes.v1';

interface Note {
  text: string;
  updatedAt: string;
}

/** Notes per test id or issue signature. Both are stable across runs, so a note follows the test. */
export class NotesStore implements NotesApi {
  private notes: Record<string, Note>;

  constructor() {
    this.notes = readJson<Record<string, Note>>('local', KEY) ?? {};
  }

  get(key: string): string {
    return this.notes[key]?.text ?? '';
  }

  set(key: string, text: string): void {
    const next = { ...this.notes };
    if (text.trim()) next[key] = { text, updatedAt: new Date().toISOString() };
    else delete next[key];
    this.notes = next;
    writeJson('local', KEY, next);
  }

  keys(): Set<string> {
    return new Set(Object.keys(this.notes));
  }
}
