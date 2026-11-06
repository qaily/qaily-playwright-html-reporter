import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import type { Catalog, CoverageRule } from '@qaily/contracts';
import { build } from '../../../reporter/src/build.ts';
import { writeDemoRuns } from '../../../reporter/src/demo.ts';
import { cellDetailSql, cellsSql, unmappedSql, usableRules, type CellRow } from '../src/sql.ts';

let dir: string;
let conn: DuckDBConnection;
let annotatedRun = '';
let annotatedTest = '';

const RULES: CoverageRule[] = [
  { title: '^(Create|Assign) task', scenario: 'Planning' },
  { step: 'I archive the board', component: 'Workspace', feature: 'Boards', area: 'Archive' },
  { step: 'logged in', ignoreCase: true, component: 'Workspace', feature: 'Auth', area: 'Login' },
];

async function rows<T>(sql: string): Promise<T[]> {
  const r = await conn.runAndReadAll(sql);
  return r.getRowObjectsJS().map((row) =>
    Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])),
  ) as T[];
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'qaily-heat-'));
  const runs = join(dir, 'runs');
  writeDemoRuns(runs, { runs: 30, days: 10, now: new Date('2026-10-15T12:00:00Z') });
  // One explicit annotation: test 0 of the first run, step 1 (overrides the rules for that step).
  annotatedRun = readdirSync(runs).sort()[0];
  const summary = readFileSync(join(runs, annotatedRun, 'test-summary.jsonl'), 'utf8').split('\n')[0];
  annotatedTest = JSON.parse(summary).test_id;
  writeFileSync(join(runs, annotatedRun, 'step-coverage.jsonl'), JSON.stringify({
    run_id: annotatedRun, test_id: annotatedTest, attempt: 0, idx: 0, title: 'Given I am logged in', status: 'passed',
    component: 'Permissions', scenario: 'Owners', feature: 'Boards', area: 'Edit',
  }) + '\n');
  await build({ inDir: runs, outDir: join(dir, 'data') });
  const catalog = JSON.parse(readFileSync(join(dir, 'data/catalog.json'), 'utf8')) as Catalog;
  conn = await (await DuckDBInstance.create(':memory:')).connect();
  const files = (k: 'tests' | 'steps') => catalog.months.map((m) => `'${join(dir, 'data', m.files[k]!)}'`).join(',');
  await conn.run(`CREATE VIEW tests AS SELECT * FROM read_parquet([${files('tests')}])`);
  await conn.run(`CREATE VIEW steps AS SELECT * FROM read_parquet([${files('steps')}])`);
});
afterAll(() => {
  conn?.closeSync();
  rmSync(dir, { recursive: true, force: true });
});

describe('heat map SQL', () => {
  it('counts each executed test once per cell, from its final attempt', async () => {
    const cells = await rows<CellRow>(cellsSql(RULES, {}));
    const login = cells.filter((c) => c.area === 'Login');
    const [{ n }] = await rows<{ n: number }>(`SELECT count(*) AS n FROM tests WHERE status <> 'skipped'`);
    // Every test logs in; one test's login step is annotated instead.
    expect(login.reduce((s, c) => s + c.hits, 0)).toBeGreaterThanOrEqual(n - 1);
    for (const c of cells) {
      expect(c.passed + c.failed).toBe(c.hits);
      expect(c.flaky).toBeLessThanOrEqual(c.passed);
    }
  });

  it('takes the scenario from a test-level rule, unspecified otherwise', async () => {
    const cells = await rows<CellRow>(cellsSql(RULES, {}));
    expect(new Set(cells.map((c) => c.scenario))).toEqual(new Set(['Planning', '(unspecified)', 'Owners']));
  });

  it('marks failures and flaky passes on the archive step', async () => {
    const sign = (await rows<CellRow>(cellsSql(RULES, {}))).filter((c) => c.area === 'Archive');
    expect(sign.reduce((s, c) => s + c.failed, 0)).toBeGreaterThan(0);
    expect(sign.reduce((s, c) => s + c.flaky, 0)).toBeGreaterThan(0);
  });

  it('lets an explicit annotation replace the rules for that step', async () => {
    const cell = { component: 'Permissions', scenario: 'Owners', feature: 'Boards', area: 'Edit' };
    const detail = await rows<{ run_id: string; test_id: string }>(cellDetailSql(RULES, {}, cell));
    expect(detail.map((d) => [d.run_id, d.test_id])).toEqual([[annotatedRun, annotatedTest]]);
  });

  it('scopes to one run', async () => {
    const all = await rows<CellRow>(cellsSql(RULES, {}));
    const one = await rows<CellRow>(cellsSql(RULES, { runId: annotatedRun }));
    expect(one.every((c) => c.runs === 1)).toBe(true);
    expect(one.reduce((s, c) => s + c.hits, 0)).toBeLessThan(all.reduce((s, c) => s + c.hits, 0));
  });

  it('lists common unmapped steps, without framework hooks', async () => {
    const unmapped = await rows<{ title: string; steps: number }>(unmappedSql(RULES, {}));
    const titles = unmapped.map((u) => u.title);
    expect(titles).toContain('When I close task');
    expect(titles).not.toContain('After Hooks');
    expect(titles).not.toContain('Given I am logged in');
  });

  it('survives quotes in rules and reports broken ones', async () => {
    const { rules, errors } = usableRules([
      { step: `it's "quoted"`, feature: "O'Brien" },
      { step: '(unclosed', feature: 'x' },
      { step: '(?<=x)y', feature: 'x' },
      { feature: 'no condition' },
    ]);
    expect(rules).toHaveLength(1);
    expect(errors).toHaveLength(3);
    // The quoted rule matches nothing; only the explicit annotation remains (annotations don't depend on rules).
    const cells = await rows<CellRow>(cellsSql(rules, {}));
    expect(cells.map((c) => c.component)).toEqual(['Permissions']);
  });
});

describe('demo coverage', () => {
  it('maps the demo data onto its planned matrix, leaving only the planned gaps and the form step', async () => {
    const { DEMO_COVERAGE_RULES, DEMO_COVERAGE_CATALOG } = await import('../../../reporter/src/demo.ts');
    const { rules, errors } = usableRules(DEMO_COVERAGE_RULES);
    expect(errors).toEqual([]);
    const cells = await rows<CellRow>(cellsSql(rules, {}));
    const key = (c: { component: string; scenario: string; feature: string; area: string }) => [c.component, c.scenario, c.feature, c.area].join('|');
    const hit = new Set(cells.map(key));
    const gaps = DEMO_COVERAGE_CATALOG.cells.filter((c) => !hit.has(key(c))).map((c) => c.area);
    expect(gaps.sort()).toEqual(['Delete', 'Logout', 'Rename', 'Saved searches', 'Share']);
    const unmapped = (await rows<{ title: string }>(unmappedSql(rules, {}))).map((u) => u.title);
    expect(unmapped).toEqual(['And I submit the form']);
  });
});

describe('ruleForTitle', () => {
  it('escapes regex characters and lets folded quotes match any quoted value', async () => {
    const { ruleForTitle } = await import('../src/sql.ts');
    const re = new RegExp(ruleForTitle('When I "…" a task (draft) with the following details:'));
    expect(re.test('When I "fillInCreate" a task (draft) with the following details:')).toBe(true);
    expect(re.test('When I "x" a task draft with the following details:')).toBe(false);
  });
});
