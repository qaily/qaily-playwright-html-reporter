import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachmentRunId, expireAttachments, selectExpiredRuns, type StoredAttachment } from '../src/expire.ts';

const s3 = { bucket: 'acme', region: 'eu-north-1', prefix: '/jsonl-report/', endpoint: '', pathStyle: false, dataSource: 'bucket' as const, dataPrefix: 'qaily-data' };
const NOW = new Date('2026-11-12T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

describe('attachmentRunId', () => {
  it('matches only files under <prefix>/<run>/attachments/', () => {
    expect(attachmentRunId('jsonl-report/run1/attachments/a/shot.png', 'jsonl-report')).toBe('run1');
    expect(attachmentRunId('jsonl-report/run1/test-summary.jsonl', 'jsonl-report')).toBeNull();
    expect(attachmentRunId('jsonl-report/run1/.sync-complete', 'jsonl-report')).toBeNull();
    expect(attachmentRunId('jsonl-report/run1/attachments/', 'jsonl-report')).toBeNull();
    expect(attachmentRunId('jsonl-report/run1/x/attachments/a.png', 'jsonl-report')).toBeNull();
    expect(attachmentRunId('qaily-data/runs/run1/attachments/a.png', 'jsonl-report')).toBeNull();
    expect(attachmentRunId('jsonl-report-old/run1/attachments/a.png', 'jsonl-report')).toBeNull();
  });
});

describe('selectExpiredRuns', () => {
  const obj = (key: string, age: number, size = 100, marker = false): StoredAttachment => ({ key, lastModified: daysAgo(age), size, marker });

  it('picks runs whose attachments are all older than the cutoff, oldest first', () => {
    const runs = selectExpiredRuns(
      [
        obj('jsonl-report/new/attachments/a.png', 1),
        obj('jsonl-report/old/attachments/a.png', 5),
        obj('jsonl-report/old/attachments/b.zip', 4, 900),
        obj('jsonl-report/older/attachments/a.png', 9),
        obj('jsonl-report/mixed/attachments/a.png', 10),
        obj('jsonl-report/mixed/attachments/b.png', 2),
        obj('jsonl-report/old/manifest.jsonl', 30),
      ],
      'jsonl-report',
      new Date(daysAgo(3)),
    );
    expect(runs.map((r) => r.runId)).toEqual(['older', 'old']);
    expect(runs[1].bytes).toBe(1000);
    expect(runs[1].objects.map((o) => o.key)).toEqual(['jsonl-report/old/attachments/a.png', 'jsonl-report/old/attachments/b.zip']);
  });

  it('ages runs by their files, not by delete markers', () => {
    const runs = selectExpiredRuns(
      [obj('jsonl-report/r/attachments/a.png', 10), obj('jsonl-report/r/attachments/a.png', 0, 0, true), obj('jsonl-report/gone/attachments/a.png', 0, 0, true)],
      'jsonl-report',
      new Date(daysAgo(3)),
    );
    expect(runs.map((r) => [r.runId, r.objects.length])).toEqual([['r', 2]]);
  });
});

describe('expireAttachments with the AWS CLI', () => {
  let dir: string;
  let path: string | undefined;
  const calls = () => readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'qaily-aws-'));
    // A stand-in `aws`: records its arguments, answers listings from a file, deletes nothing.
    writeFileSync(join(dir, 'aws'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(dir, 'calls'))}, JSON.stringify(args) + '\\n');
if (args[1] === 'list-objects-v2' || args[1] === 'list-object-versions') process.stdout.write(fs.readFileSync(${JSON.stringify(join(dir, 'listing.json'))}));
if (args[1] === 'delete-objects') process.stdout.write('{}');
`);
    chmodSync(join(dir, 'aws'), 0o755);
    path = process.env.PATH;
    process.env.PATH = `${dir}:${path}`;
  });
  afterAll(() => {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  });

  it('deletes the attachments folder of each expired run, and nothing else', async () => {
    writeFileSync(join(dir, 'calls'), '');
    writeFileSync(join(dir, 'listing.json'), JSON.stringify({
      v: [
        ['jsonl-report/old/attachments/a.png', '', daysAgo(5), 10],
        ['jsonl-report/new/attachments/a.png', '', daysAgo(1), 10],
      ],
      d: [],
    }));
    const runs = await expireAttachments({ s3, olderThanDays: 3, now: NOW });
    expect(runs.map((r) => r.runId)).toEqual(['old']);
    const [list, rm, ...rest] = calls();
    expect(list.slice(0, 2)).toEqual(['s3api', 'list-objects-v2']);
    expect(list).toContain('jsonl-report/');
    expect(list).not.toContain('--only-show-errors');
    expect(rm.slice(0, 4)).toEqual(['s3', 'rm', 's3://acme/jsonl-report/old/attachments/', '--recursive']);
    expect(rest).toEqual([]);
  });

  it('only lists on a dry run', async () => {
    writeFileSync(join(dir, 'calls'), '');
    await expireAttachments({ s3, olderThanDays: 3, now: NOW, dryRun: true });
    expect(calls().map((c) => c[1])).toEqual(['list-objects-v2']);
  });

  it('deletes every version and delete marker with --all-versions', async () => {
    writeFileSync(join(dir, 'calls'), '');
    writeFileSync(join(dir, 'listing.json'), JSON.stringify({
      v: [['jsonl-report/old/attachments/a.png', 'v1', daysAgo(5), 10]],
      d: [['jsonl-report/old/attachments/b.png', 'm1', daysAgo(1)]],
    }));
    await expireAttachments({ s3, olderThanDays: 3, now: NOW, allVersions: true });
    const [list, del] = calls();
    expect(list[1]).toBe('list-object-versions');
    expect(del[1]).toBe('delete-objects');
  });

  it('refuses an empty prefix and a non-positive age', async () => {
    await expect(expireAttachments({ s3: { ...s3, prefix: '' }, olderThanDays: 3 })).rejects.toThrow('prefix');
    await expect(expireAttachments({ s3, olderThanDays: 0 })).rejects.toThrow('above 0');
  });
});
