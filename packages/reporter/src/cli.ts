import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from './build.ts';
import type { S3Config } from './s3-signer.ts';

/** Where the Playwright reporter writes run folders by default (its outputDir). */
const RUNS = 'reports/data';
/** The report's data folder: rollups, catalog.json, settings.json. */
const DATA = 'report-data';
/** Run folders downloaded from the bucket by `show --sync`. */
const SYNCED_RUNS = '.qaily/runs';

const USAGE = `Usage: qaily-report <command> [options]

View
  show [--in ${RUNS}] [--out ${DATA}] [--port 4173]          Build the report from local runs and serve it
  show --sync [--aws-profile name]                                Run folders from the bucket (no attachments), build, serve
  show --pull [--aws-profile name]                                Published report data from the bucket, serve
  serve [--data ${DATA}] [--attachments <run folders>] [--port 4173] [--host 127.0.0.1] [--aws-profile name] [--app dir]
  demo [--out ${DATA}] [--runs 120] [--days 30]                  Synthetic runs, for trying the report

Build
  build [--in ${RUNS}] [--out ${DATA}] [--force] [--prune-before YYYY-MM] [--require-sync-complete=true|false]
  catalog --csv <matrix.csv> [--out ${DATA}/coverage-catalog.json]   Planned coverage matrix for the heat map
  trace-viewer --out <site>/trace [--from <test project>]         Copy Playwright's trace viewer next to the report

Bucket (AWS CLI v2)
  upload [--in ${RUNS}] [--dry-run]                              Run folders → bucket, attachments included, marker last
  sync [--to <run folders>] [--out ${DATA}] [--with-attachments]  Bucket → run folders (no attachments), then build
  pull [--out ${DATA}]                                            Published report data → data folder
  publish [--out ${DATA}] [--team-settings seed|replace|skip] [--allow-shrink]   Data folder → bucket, catalog.json last
  expire-attachments --older-than <days> [--dry-run] [--all-versions]   Delete attachments of old runs, keep the rest
  bridge --origin <site origin>[,<origin>] [--dry-run]            Upload the storage bridge (storage without CORS)

Bucket options, for every bucket command (default: connections.s3 in <data folder>/settings.json):
  --bucket b --region r --prefix <run folders> --data-prefix <report data> --endpoint url --path-style --aws-profile name

Notes
  The data folder is --out (or --data for serve). Its settings.json says where the bucket is.
  build keeps runs whose folders are gone (deleted from the bucket) from the previous build; --prune-before drops older
  months for good. Locally written run folders need no .sync-complete marker; synced ones without it are skipped.
  pull and publish are for the Bucket data source: pull first, so build skips unchanged months and keeps expired runs.
  publish refuses a catalog with fewer runs than the published one (a build without pull), unless --allow-shrink. It
  also uploads <data folder>/settings.json, without the bucket connection, as team-settings.json when there is none yet
  (seed); replace overwrites it.
  expire-attachments deletes <prefix>/<run>/attachments/ of runs whose attachments are all older than <days>.
  serve signs bucket links with this machine's AWS login (env keys, else --aws-profile, else the default profile), and
  provides Playwright's trace viewer at /trace/ when run where Playwright is installed.`;

/** The built report: inside the npm package (next to dist/), else a checkout's build output. */
function defaultAppDir(): string | undefined {
  const candidates = [fileURLToPath(new URL('../app/', import.meta.url)), resolve('.qaily/app')];
  return candidates.find((dir) => existsSync(join(dir, 'index.html')));
}

type Values = Record<string, string | boolean | string[] | undefined>;

/** The bucket: <data folder>/settings.json, with flags over it. */
async function s3From(values: Values, dataDir: string): Promise<S3Config> {
  const { readS3Config } = await import('./s3-signer.ts');
  const team = readS3Config(dataDir);
  const str = (k: string) => (typeof values[k] === 'string' ? (values[k] as string) : undefined);
  return {
    ...team,
    bucket: str('bucket') ?? team.bucket,
    region: str('region') ?? team.region,
    prefix: str('prefix') ?? team.prefix,
    dataPrefix: str('data-prefix') ?? team.dataPrefix,
    endpoint: str('endpoint') ?? team.endpoint,
    pathStyle: values['path-style'] === true ? true : team.pathStyle,
  };
}

const needBucket = (s3: S3Config, dataDir: string) => {
  if (!s3.bucket) throw new Error(`No bucket configured. Pass --bucket, or set connections.s3 in ${join(dataDir, 'settings.json')}.`);
};

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
      'path-style': { type: 'boolean' },
      'aws-profile': { type: 'string' },
      'with-attachments': { type: 'boolean' },
      csv: { type: 'string' },
      'team-settings': { type: 'string' },
      'prune-before': { type: 'string' },
      'allow-shrink': { type: 'boolean' },
      'older-than': { type: 'string' },
      'dry-run': { type: 'boolean' },
      'all-versions': { type: 'boolean' },
      from: { type: 'string' },
      origin: { type: 'string', multiple: true },
      sync: { type: 'boolean' },
      pull: { type: 'boolean' },
    },
  });
  const log = (msg: string) => console.log(`[qaily] ${msg}`);
  const profile = values['aws-profile'];

  const startServer = async (dataDir: string, attachmentsDir: string | undefined) => {
    const appDir = values.app ?? defaultAppDir();
    if (!appDir) throw new Error('No built report found. Pass --app <dir>, or run `npm run app:build` in a checkout of this repo.');
    const { serve } = await import('./server.ts');
    const { LocalSigner } = await import('./s3-signer.ts');
    const { findTraceViewer } = await import('./trace-viewer.ts');
    const traceViewer = findTraceViewer();
    if (traceViewer) log(`Trace viewer of Playwright ${traceViewer.version} at /trace/`);
    await serve({
      traceViewerDir: traceViewer?.dir,
      signer: new LocalSigner({ profile }),
      appDir,
      dataDir,
      attachmentsDir,
      port: Number(values.port ?? 4173),
      host: values.host ?? '127.0.0.1',
      log,
    });
  };

  const runBuild = async (inDir: string, outDir: string) => {
    const flag = values['require-sync-complete'];
    const pruneBefore = values['prune-before'];
    if (pruneBefore !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(pruneBefore)) throw new Error('--prune-before must be a month, YYYY-MM');
    const started = Date.now();
    const result = await build({
      inDir,
      outDir,
      requireSyncComplete: flag === undefined ? undefined : flag !== 'false',
      force: values.force,
      pruneBefore,
      log,
    });
    log(
      `Built ${outDir} in ${Date.now() - started} ms: ${result.catalog.runCount} runs, ` +
        `${result.catalog.months.length} month(s), rebuilt ${result.rebuiltMonths.join(', ') || 'nothing'}`,
    );
  };

  switch (command) {
    case 'show': {
      const out = values.out ?? DATA;
      if (values.sync && values.pull) throw new Error('Use --sync or --pull, not both.');
      if (values.pull) {
        const s3 = await s3From(values, out);
        needBucket(s3, out);
        const { pull } = await import('./sync.ts');
        await pull({ s3, dataDir: out, profile, log });
        return startServer(out, undefined);
      }
      if (values.sync) {
        const s3 = await s3From(values, out);
        needBucket(s3, out);
        const { sync } = await import('./sync.ts');
        const to = values.in ?? SYNCED_RUNS;
        await sync({ s3, toDir: to, profile, withAttachments: values['with-attachments'], log });
        await runBuild(to, out);
        // Attachments stay in the bucket; the server signs links to them with this machine's login.
        return startServer(out, to);
      }
      const inDir = values.in ?? RUNS;
      if (!existsSync(inDir)) {
        throw new Error(
          `No run folders in ${inDir}. Run your Playwright tests with the Qaily reporter first, pass --in <folder>, ` +
            'or try the report with synthetic data: npx qaily-report demo && npx qaily-report serve',
        );
      }
      await runBuild(inDir, out);
      return startServer(out, inDir);
    }
    case 'serve':
      return startServer(values.data ?? DATA, values.attachments);
    case 'build':
      return runBuild(values.in ?? RUNS, values.out ?? DATA);
    case 'demo': {
      const out = values.out ?? DATA;
      const { writeDemoRuns, DEMO_COVERAGE_CATALOG, DEMO_COVERAGE_RULES } = await import('./demo.ts');
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const runsDir = `${out}/../demo-runs`;
      writeDemoRuns(runsDir, { runs: Number(values.runs ?? 120), days: Number(values.days ?? 30) });
      log(`Wrote demo runs to ${runsDir}`);
      // Heat map rules and planned matrix for the demo data. Existing files are kept: they may be the user's own.
      mkdirSync(out, { recursive: true });
      for (const [file, content] of [
        ['settings.json', { coverage: { rules: DEMO_COVERAGE_RULES } }],
        ['coverage-catalog.json', DEMO_COVERAGE_CATALOG],
      ] as const) {
        const path = join(out, file);
        if (existsSync(path)) log(`Kept the existing ${file}`);
        else writeFileSync(path, JSON.stringify(content, null, 2) + '\n');
      }
      await build({ inDir: runsDir, outDir: out, force: true, log });
      log(`Next: npx qaily-report serve${out === DATA ? '' : ` --data ${out}`}`);
      return;
    }
    case 'catalog': {
      if (!values.csv) throw new Error(USAGE);
      const outFile = values.out ?? join(DATA, 'coverage-catalog.json');
      const { readFileSync, writeFileSync } = await import('node:fs');
      const { catalogFromCsv } = await import('./catalog.ts');
      const catalog = catalogFromCsv(readFileSync(values.csv, 'utf8'));
      writeFileSync(outFile, JSON.stringify(catalog, null, 2) + '\n');
      log(`Wrote ${catalog.cells.length} planned cells to ${outFile}`);
      return;
    }
    case 'upload': {
      const out = values.out ?? DATA;
      const s3 = await s3From(values, out);
      needBucket(s3, out);
      const { uploadRuns } = await import('./upload.ts');
      const runs = await uploadRuns({ s3, inDir: values.in ?? RUNS, profile, dryRun: values['dry-run'], log });
      log(`${values['dry-run'] ? 'Would upload' : 'Uploaded'} ${runs.length} run(s)`);
      return;
    }
    case 'sync': {
      const out = values.out ?? DATA;
      const to = values.to ?? SYNCED_RUNS;
      const s3 = await s3From(values, out);
      const { sync } = await import('./sync.ts');
      await sync({ s3, toDir: to, profile, withAttachments: values['with-attachments'], log });
      return runBuild(to, out);
    }
    case 'pull':
    case 'publish': {
      const out = values.out ?? DATA;
      const s3 = await s3From(values, out);
      const { publish, pull } = await import('./sync.ts');
      const teamSettings = values['team-settings'] ?? 'seed';
      if (teamSettings !== 'seed' && teamSettings !== 'replace' && teamSettings !== 'skip') throw new Error('--team-settings must be seed, replace or skip');
      await (command === 'pull' ? pull : publish)({ s3, dataDir: out, profile, teamSettings, allowShrink: values['allow-shrink'], log });
      log(command === 'pull' ? 'Pulled the published report data' : 'Published the report data');
      return;
    }
    case 'bridge': {
      const origins = (values.origin ?? []).flatMap((o) => o.split(','));
      if (!origins.length) throw new Error(`--origin is required, e.g. --origin https://org.github.io\n\n${USAGE}`);
      const out = values.out ?? DATA;
      const s3 = await s3From(values, out);
      needBucket(s3, out);
      const { uploadBridge } = await import('./bridge.ts');
      const page = await uploadBridge({ s3, origins, profile, dryRun: values['dry-run'], log });
      if (values['dry-run']) console.log(page);
      return;
    }
    case 'trace-viewer': {
      if (!values.out) throw new Error(USAGE);
      const { copyTraceViewer } = await import('./trace-viewer.ts');
      const source = copyTraceViewer(values.out, values.from);
      log(`Copied the trace viewer of Playwright ${source.version} to ${values.out}`);
      return;
    }
    case 'expire-attachments': {
      const days = Number(values['older-than']);
      if (!values['older-than'] || !(days > 0)) throw new Error(`--older-than must be a number of days above 0\n\n${USAGE}`);
      const out = values.out ?? DATA;
      const s3 = await s3From(values, out);
      const { expireAttachments } = await import('./expire.ts');
      await expireAttachments({ s3, olderThanDays: days, profile, dryRun: values['dry-run'], allVersions: values['all-versions'], log });
      return;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return;
    default:
      throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
  }
}
