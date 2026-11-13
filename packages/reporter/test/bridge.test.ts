import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uploadBridge } from '../src/bridge.ts';
import { publishArgs } from '../src/sync.ts';

const s3 = { bucket: 'reports', region: 'us-east-1', prefix: 'jsonl-report', endpoint: 'https://ecs.example.test', pathStyle: true, dataSource: 'bucket' as const, dataPrefix: 'qaily-data', transport: 'bridge' as const };

describe('qaily-report bridge', () => {
  let dir: string;
  let path: string | undefined;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'qaily-bridge-aws-'));
    // A stand-in `aws`: records its arguments and the uploaded file.
    writeFileSync(join(dir, 'aws'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(join(dir, 'call.json'))}, JSON.stringify(args));
fs.copyFileSync(args[2], ${JSON.stringify(join(dir, 'uploaded.html'))});
`);
    chmodSync(join(dir, 'aws'), 0o755);
    path = process.env.PATH;
    process.env.PATH = `${dir}:${path}`;
  });
  afterAll(() => {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  });

  it('uploads the page to the data folder as HTML, for the given sites and this bucket only', async () => {
    await uploadBridge({ s3, origins: ['https://org.github.io'] });
    const args = JSON.parse(readFileSync(join(dir, 'call.json'), 'utf8')) as string[];
    expect(args.slice(0, 2)).toEqual(['s3', 'cp']);
    expect(args[3]).toBe('s3://reports/qaily-data/qaily-bridge.html');
    expect(args).toContain('text/html; charset=utf-8');
    expect(args).toContain('https://ecs.example.test');
    const page = readFileSync(join(dir, 'uploaded.html'), 'utf8');
    expect(page).toContain('"origins":["https://org.github.io"]');
    expect(page).toContain('"paths":["/reports/jsonl-report/","/reports/qaily-data/"]');
  });

  it('prints the page on a dry run, and refuses a bad origin', async () => {
    writeFileSync(join(dir, 'call.json'), 'null');
    expect(await uploadBridge({ s3, origins: ['https://org.github.io'], dryRun: true })).toContain('Qaily storage bridge');
    expect(readFileSync(join(dir, 'call.json'), 'utf8')).toBe('null');
    await expect(uploadBridge({ s3, origins: ['https://org.github.io/site/'] })).rejects.toThrow(/Not an origin/);
  });

  it('is never overwritten or downloaded by publish and pull', () => {
    expect(publishArgs({ s3, dataDir: 'data' })[0]).toEqual(expect.arrayContaining(['--exclude', 'qaily-bridge.html']));
  });
});
