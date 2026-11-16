import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uploadRuns } from '../src/upload.ts';

const s3 = { bucket: 'acme', region: 'eu-north-1', prefix: '/jsonl-report/', endpoint: '', pathStyle: false, dataSource: 'website' as const, dataPrefix: 'qaily-data', transport: 'cors' as const };

describe('qaily-report upload', () => {
  let dir: string;
  let path: string | undefined;
  const calls = () => readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'qaily-upload-'));
    // A stand-in `aws` that records its arguments.
    writeFileSync(join(dir, 'aws'), `#!/usr/bin/env node
require('fs').appendFileSync(${JSON.stringify(join(dir, 'calls'))}, JSON.stringify(process.argv.slice(2)) + '\\n');
`);
    chmodSync(join(dir, 'aws'), 0o755);
    for (const run of ['2026-11-01T10-00-00_abc_1', '2026-11-02T10-00-00_abc_2']) {
      mkdirSync(join(dir, 'runs', run, 'attachments'), { recursive: true });
      writeFileSync(join(dir, 'runs', run, 'manifest.jsonl'), '{}\n');
    }
    mkdirSync(join(dir, 'runs', 'not-a-run'));
    path = process.env.PATH;
    process.env.PATH = `${dir}:${path}`;
  });
  afterAll(() => {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  });

  it('uploads each run folder with attachments, then its .sync-complete marker', async () => {
    writeFileSync(join(dir, 'calls'), '');
    const runs = await uploadRuns({ s3, inDir: join(dir, 'runs') });
    expect(runs).toEqual(['2026-11-01T10-00-00_abc_1', '2026-11-02T10-00-00_abc_2']);
    const [sync1, marker1, sync2, marker2, ...rest] = calls();
    expect(sync1.slice(0, 2)).toEqual(['s3', 'sync']);
    expect(sync1[3]).toBe('s3://acme/jsonl-report/2026-11-01T10-00-00_abc_1/');
    expect(sync1).not.toContain('*/attachments/*');
    expect(marker1.slice(0, 2)).toEqual(['s3', 'cp']);
    expect(marker1[3]).toBe('s3://acme/jsonl-report/2026-11-01T10-00-00_abc_1/.sync-complete');
    expect(sync2[3]).toBe('s3://acme/jsonl-report/2026-11-02T10-00-00_abc_2/');
    expect(marker2[3]).toContain('/.sync-complete');
    expect(rest).toHaveLength(0);
  });

  it('only lists on a dry run, and explains an empty folder', async () => {
    writeFileSync(join(dir, 'calls'), '');
    await uploadRuns({ s3, inDir: join(dir, 'runs'), dryRun: true });
    expect(readFileSync(join(dir, 'calls'), 'utf8')).toBe('');
    await expect(uploadRuns({ s3, inDir: join(dir, 'runs', 'not-a-run') })).rejects.toThrow(/No run folders/);
    await expect(uploadRuns({ s3: { ...s3, bucket: '' }, inDir: join(dir, 'runs') })).rejects.toThrow(/No S3 bucket/);
  });
});
