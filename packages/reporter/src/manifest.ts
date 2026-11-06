import type { ManifestRecord, ManifestRunEnd, ManifestRunStart, RunRow } from '@qaily/contracts';
import { readJsonl } from './jsonl.ts';

export function runRowFromManifest(runId: string, file: string): RunRow | null {
  const records = readJsonl<ManifestRecord>(file);
  const start = records.find((r): r is ManifestRunStart => r.type === 'run_start');
  if (!start) return null;
  const end = records.find((r): r is ManifestRunEnd => r.type === 'run_end');
  return {
    run_id: start.run_id || runId,
    started_at: new Date(start.started_at).toISOString(),
    ended_at: end ? new Date(end.ended_at).toISOString() : null,
    dur_ms: end?.dur_ms ?? null,
    total: end?.test_cnt ?? 0,
    passed: end?.passed_cnt ?? 0,
    failed: end?.failed_cnt ?? 0,
    flaky: end?.flaky_cnt ?? 0,
    skipped: end?.skipped_cnt ?? 0,
    category: start.category ?? null,
    environment: start.environment ?? null,
    branch: start.git_branch ?? null,
    tag: start.tag ?? null,
    commit: start.git_commit ?? null,
    ci_url: start.ci_url ?? null,
    pw_version: start.pw_version ?? null,
  };
}

export function monthOf(iso: string): string {
  return iso.slice(0, 7);
}
