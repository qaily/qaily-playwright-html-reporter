// `qaily-report bridge`: uploads the storage bridge page (qaily-bridge.html) to the data folder, for storage whose CORS
// rules can't be changed. The report then reads the bucket through it (Settings → Connections → Storage access).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRIDGE_FILE, bridgePage, bridgePaths } from '@qaily/artifacts';
import type { S3Config } from './s3-signer.ts';
import { awsCapture, commonArgs, dataLocation } from './sync.ts';

export interface BridgeOptions {
  s3: S3Config;
  /** Report origins that may use it, e.g. https://org.github.io. */
  origins: string[];
  profile?: string;
  /** Only print the page. */
  dryRun?: boolean;
  log?: (msg: string) => void;
}

/** Builds the page for this bucket and uploads it as HTML. Returns the page. */
export async function uploadBridge(o: BridgeOptions): Promise<string> {
  const page = bridgePage({ origins: o.origins, paths: bridgePaths(o.s3) });
  const dest = `${dataLocation(o.s3)}${BRIDGE_FILE}`;
  if (o.dryRun) {
    o.log?.(`Dry run: would upload to ${dest}`);
    return page;
  }
  const dir = mkdtempSync(join(tmpdir(), 'qaily-bridge-'));
  try {
    const file = join(dir, BRIDGE_FILE);
    writeFileSync(file, page);
    const args = ['s3', 'cp', file, dest, '--content-type', 'text/html; charset=utf-8', '--cache-control', 'no-cache', ...commonArgs(o)];
    o.log?.(`aws ${args.join(' ')}`);
    const { code, stderr } = await awsCapture(args, o.s3);
    if (code !== 0) throw new Error(`Uploading the bridge failed: ${stderr.trim() || `aws exited with code ${code}`}`);
    o.log?.(`Uploaded ${dest} for ${o.origins.join(', ')}. Turn it on in Settings → Connections → Storage access.`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return page;
}
