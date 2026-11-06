import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from './build.ts';

const USAGE = `Usage:
  qaily-report build --in <run folders> --out <data dir> [--require-sync-complete=true|false] [--force]
  qaily-report serve --data <data dir> [--app <built app dir>] [--attachments <run folders>] [--port 4173] [--host 127.0.0.1]
  qaily-report demo  --out <data dir> [--runs 120] [--days 30]
  qaily-report catalog --csv <matrix.csv> --out <data dir>/coverage-catalog.json
  qaily-report sync  --to <run folders> --out <data dir> [--bucket b --region r --prefix p --endpoint url] [--aws-profile name] [--with-attachments]
  qaily-report pull    --out <data dir> [--bucket b --region r --prefix p --data-prefix d --endpoint url] [--aws-profile name]
  qaily-report publish --out <data dir> [--bucket b --region r --prefix p --data-prefix d --endpoint url] [--aws-profile name]

  pull and publish are for the Bucket data source. pull first, so build skips months that didn't change; publish uploads the result.

  serve also takes --aws-profile; it signs S3 artifact URLs with that AWS login (default: env keys, then the default profile).
  Without --app, serve uses the report that ships with the npm package, or .qaily/app in a checkout of the repo.`;

/** The built report: inside the npm package (next to dist/), else a checkout's build output. */
function defaultAppDir(): string | undefined {
  const candidates = [fileURLToPath(new URL('../app/', import.meta.url)), resolve('.qaily/app')];
  return candidates.find((dir) => existsSync(join(dir, 'index.html')));
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      in: { type: 'string' },
      out: { type: 'string' },
      app: { type: 'string' },
      data: { type: 'string' },
      attachments: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      runs: { type: 'string' },
      days: { type: 'string' },
      force: { type: 'boolean' },
      'require-sync-complete': { type: 'string' },
      to: { type: 'string' },
      bucket: { type: 'string' },
      region: { type: 'string' },
      prefix: { type: 'string' },
      endpoint: { type: 'string' },
      'data-prefix': { type: 'string' },
      'aws-profile': { type: 'string' },
      'with-attachments': { type: 'boolean' },
      csv: { type: 'string' },
    },
  });
  const log = (msg: string) => console.log(`[qaily] ${msg}`);

  switch (command) {
    case 'build': {
      if (!values.in || !values.out) throw new Error(USAGE);
      const flag = values['require-sync-complete'];
      const started = Date.now();
      const result = await build({
        inDir: values.in,
        outDir: values.out,
        requireSyncComplete: flag === undefined ? undefined : flag !== 'false',
        force: values.force,
        log,
      });
      log(
        `Done in ${Date.now() - started} ms: ${result.catalog.runCount} runs, ` +
          `${result.catalog.months.length} month(s), rebuilt ${result.rebuiltMonths.join(', ') || 'nothing'}`,
      );
      return;
    }
    case 'serve': {
      if (!values.data) throw new Error(USAGE);
      const appDir = values.app ?? defaultAppDir();
      if (!appDir) throw new Error('No built report found. Pass --app <dir>, or run `npm run app:build` in a checkout of this repo.');
      const { serve } = await import('./server.ts');
      const { LocalSigner } = await import('./s3-signer.ts');
      await serve({
        signer: new LocalSigner({ profile: values['aws-profile'] }),
        appDir,
        dataDir: values.data,
        attachmentsDir: values.attachments,
        port: Number(values.port ?? 4173),
        host: values.host ?? '127.0.0.1',
        log,
      });
      return;
    }
    case 'demo': {
      if (!values.out) throw new Error(USAGE);
      const { writeDemoRuns, DEMO_COVERAGE_CATALOG, DEMO_COVERAGE_RULES } = await import('./demo.ts');
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const runsDir = `${values.out}/../demo-runs`;
      writeDemoRuns(runsDir, { runs: Number(values.runs ?? 120), days: Number(values.days ?? 30) });
      log(`Wrote demo runs to ${runsDir}`);
      // Heat map rules and planned matrix for the demo data. Existing files are kept: they may be the user's own.
      mkdirSync(values.out, { recursive: true });
      for (const [file, content] of [
        ['settings.json', { coverage: { rules: DEMO_COVERAGE_RULES } }],
        ['coverage-catalog.json', DEMO_COVERAGE_CATALOG],
      ] as const) {
        const path = join(values.out, file);
        if (existsSync(path)) log(`Kept the existing ${file}`);
        else writeFileSync(path, JSON.stringify(content, null, 2) + '\n');
      }
      await build({ inDir: runsDir, outDir: values.out, force: true, log });
      return;
    }
    case 'catalog': {
      if (!values.csv || !values.out) throw new Error(USAGE);
      const { readFileSync, writeFileSync } = await import('node:fs');
      const { catalogFromCsv } = await import('./catalog.ts');
      const catalog = catalogFromCsv(readFileSync(values.csv, 'utf8'));
      writeFileSync(values.out, JSON.stringify(catalog, null, 2) + '\n');
      log(`Wrote ${catalog.cells.length} planned cells to ${values.out}`);
      return;
    }
    case 'sync': {
      if (!values.to || !values.out) throw new Error(USAGE);
      const { sync } = await import('./sync.ts');
      const { readS3Config } = await import('./s3-signer.ts');
      const team = readS3Config(values.out);
      const s3 = {
        ...team,
        endpoint: values.endpoint ?? team.endpoint,
        bucket: values.bucket ?? team.bucket,
        region: values.region ?? team.region,
        prefix: values.prefix ?? team.prefix,
      };
      await sync({ s3, toDir: values.to, profile: values['aws-profile'], withAttachments: values['with-attachments'], log });
      const result = await build({ inDir: values.to, outDir: values.out, log });
      log(`Synced and built: ${result.catalog.runCount} runs, rebuilt ${result.rebuiltMonths.join(', ') || 'nothing'}`);
      return;
    }
    case 'pull':
    case 'publish': {
      if (!values.out) throw new Error(USAGE);
      const { publish, pull } = await import('./sync.ts');
      const { readS3Config } = await import('./s3-signer.ts');
      const team = readS3Config(values.out);
      const s3 = {
        ...team,
        endpoint: values.endpoint ?? team.endpoint,
        bucket: values.bucket ?? team.bucket,
        region: values.region ?? team.region,
        prefix: values.prefix ?? team.prefix,
        dataPrefix: values['data-prefix'] ?? team.dataPrefix,
      };
      await (command === 'pull' ? pull : publish)({ s3, dataDir: values.out, profile: values['aws-profile'], log });
      log(command === 'pull' ? 'Pulled the published report data' : 'Published the report data');
      return;
    }
    default:
      console.log(USAGE);
  }
}
