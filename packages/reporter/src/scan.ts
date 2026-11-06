import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_FILES, type RunFile } from '@qaily/contracts';

export interface RunDir {
  runId: string;
  dir: string;
  syncComplete: boolean;
  /** Plain .jsonl path per file when present, else .jsonl.gz, else absent. */
  files: Partial<Record<RunFile, string>>;
  /** Fingerprint of the run's files (names, sizes, mtimes); changes when any file changes. */
  fingerprint: string;
}

export function findRunFile(dir: string, name: RunFile, prefer: 'plain' | 'gz' = 'plain'): string | undefined {
  const plain = join(dir, `${name}.jsonl`);
  const gz = join(dir, `${name}.jsonl.gz`);
  const order = prefer === 'plain' ? [plain, gz] : [gz, plain];
  return order.find((p) => existsSync(p));
}

export function scanRunDirs(root: string): RunDir[] {
  const runs: RunDir[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const files: RunDir['files'] = {};
    const parts: string[] = [];
    for (const name of RUN_FILES) {
      const file = findRunFile(dir, name);
      if (!file) continue;
      files[name] = file;
      const st = statSync(file);
      parts.push(`${name}:${st.size}:${Math.floor(st.mtimeMs)}`);
    }
    if (!files.manifest) continue;
    runs.push({
      runId: entry.name,
      dir,
      syncComplete: existsSync(join(dir, '.sync-complete')),
      files,
      fingerprint: parts.join('|'),
    });
  }
  return runs;
}

/**
 * Applies the sync-complete rule: when the folder is an S3 sync (at least one run has the
 * marker) and the rule is on, runs without the marker are still uploading and are skipped.
 */
export function selectCompleteRuns(runs: RunDir[], requireSyncComplete: boolean): { included: RunDir[]; skipped: RunDir[] } {
  const isSyncedFolder = runs.some((r) => r.syncComplete);
  if (!requireSyncComplete || !isSyncedFolder) return { included: runs, skipped: [] };
  return {
    included: runs.filter((r) => r.syncComplete),
    skipped: runs.filter((r) => !r.syncComplete),
  };
}
