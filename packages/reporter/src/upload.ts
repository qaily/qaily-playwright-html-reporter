// `qaily-report upload`: copies run folders (what the Playwright reporter writes) to the bucket, attachments included,
// each followed by its .sync-complete marker. `build` skips synced run folders without the marker, so a run that is
// still uploading never reaches the report.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { S3Config } from './s3-signer.ts';
import { scanRunDirs } from './scan.ts';
import { commonArgs, noBucket, runAws } from './sync.ts';

export interface UploadOptions {
  s3: S3Config;
  /** Folder with run folders, e.g. reports/data. */
  inDir: string;
  profile?: string;
  /** Only say what would be uploaded. */
  dryRun?: boolean;
  log?: (msg: string) => void;
}

/** Uploads every run folder in inDir. Returns the run ids. */
export async function uploadRuns(o: UploadOptions): Promise<string[]> {
  if (!o.s3.bucket) throw noBucket();
  const runs = scanRunDirs(o.inDir).map((r) => r.runId);
  if (!runs.length) {
    throw new Error(`No run folders in ${o.inDir}. Run the tests with the Qaily reporter first (its outputDir), or pass --in <folder>.`);
  }
  const prefix = o.s3.prefix.replace(/^\/+|\/+$/g, '');
  const dest = (run: string) => `s3://${o.s3.bucket}/${prefix ? `${prefix}/` : ''}${run}/`;
  if (o.dryRun) {
    for (const run of runs) o.log?.(`Would upload ${join(o.inDir, run)} → ${dest(run)}`);
    return runs;
  }
  const dir = mkdtempSync(join(tmpdir(), 'qaily-upload-'));
  try {
    const marker = join(dir, '.sync-complete');
    writeFileSync(marker, JSON.stringify({ complete: true }) + '\n');
    for (const run of runs) {
      // The marker can't be in the folder before the upload ends, so it is excluded and sent last.
      await runAws(['s3', 'sync', join(o.inDir, run), dest(run), '--exclude', '.sync-complete', ...commonArgs(o)], o.s3, o.log);
      await runAws(['s3', 'cp', marker, `${dest(run)}.sync-complete`, '--content-type', 'application/json', ...commonArgs(o)], o.s3, o.log);
      o.log?.(`Uploaded ${run}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return runs;
}
