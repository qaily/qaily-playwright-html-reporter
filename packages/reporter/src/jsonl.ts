import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

export function readText(file: string): string {
  const buf = readFileSync(file);
  return file.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
}

export function readJsonl<T>(file: string): T[] {
  const rows: T[] = [];
  for (const line of readText(file).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as T);
    } catch {
      // A truncated last line (interrupted upload) must not fail the whole build.
    }
  }
  return rows;
}
