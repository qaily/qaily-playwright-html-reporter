import {
  type CoverageCatalog,
  type CoverageCell,
  type HealthLevel,
  type PageContext,
  type RouteParams,
  type RunRow,
} from '@qaily/contracts';
import { branchMatches, rangeFromDays } from '@qaily/core';
import { cellsSql, unmappedSql, usableRules, type CellRow, type CoverageScope, type UnmappedRow } from './sql.ts';
import { buildSheet, type SheetComponent } from './sheet.ts';

export interface CellStat {
  hits: number;
  passed: number;
  failed: number;
  flaky: number;
  tests: number;
  /** Percent of hits that passed; null without hits. */
  rate: number | null;
  level: HealthLevel | 'none';
  planned: boolean;
  /** Hit, but not in the catalog (only when a catalog exists): often a label typo. */
  unplanned: boolean;
}

export interface AreaRow {
  name: string;
  cells: Record<string, CellStat | undefined>;
}

export interface FeatureRow {
  name: string;
  areas: AreaRow[];
  totals: Record<string, CellStat | undefined>;
}

export interface HeatmapModel {
  levels: string[];
  scope: CoverageScope;
  run: RunRow | null;
  runs: RunRow[];
  components: string[];
  component: string | null;
  scenarios: string[];
  features: FeatureRow[];
  hasCatalog: boolean;
  kpis: { cells: number; hits: number; passRate: number | null; level: HealthLevel | 'none'; flakyCells: number; plannedCells: number; plannedHit: number };
  unmapped: UnmappedRow[];
  ruleCount: number;
  ruleErrors: string[];
  /** False when the data was built before the steps rollup existed. */
  stepsAvailable: boolean;
  /** All components as the planned matrix (spreadsheet) lays them out, for the Sheet layout. */
  sheet: SheetComponent[];
  sheetKpis: { hits: number; passRate: number | null; level: HealthLevel | 'none'; planned: number; plannedHit: number };
  /** From the URL; null = the viewer's last choice (Sheet by default). */
  layout: 'sheet' | 'grid' | null;
}

const key = (c: Pick<CoverageCell, 'scenario' | 'feature' | 'area'>) => `${c.feature}\u0000${c.area}\u0000${c.scenario}`;

function stat(ctx: PageContext, r: Partial<CellRow> | undefined, planned: boolean, unplanned: boolean): CellStat {
  const hits = r?.hits ?? 0;
  const rate = hits ? ((r!.passed ?? 0) / hits) * 100 : null;
  return {
    hits,
    passed: r?.passed ?? 0,
    failed: r?.failed ?? 0,
    flaky: r?.flaky ?? 0,
    tests: r?.tests ?? 0,
    rate,
    level: ctx.health('coverageCell', rate),
    planned,
    unplanned,
  };
}

function sum(ctx: PageContext, list: (CellStat | undefined)[]): CellStat | undefined {
  const present = list.filter((c): c is CellStat => !!c);
  if (!present.length) return undefined;
  const total = present.reduce(
    (a, c) => ({ hits: a.hits + c.hits, passed: a.passed + c.passed, failed: a.failed + c.failed, flaky: a.flaky + c.flaky, tests: a.tests + c.tests }),
    { hits: 0, passed: 0, failed: 0, flaky: 0, tests: 0 },
  );
  return stat(ctx, total, present.some((c) => c.planned), false);
}

export async function loadHeatmap(ctx: PageContext, params: RouteParams): Promise<HeatmapModel> {
  const { settings, filters, data } = ctx;
  const window = rangeFromDays(filters.rangeDays, ctx.now());
  const runs = (await data.runs(window)).filter((r) => branchMatches(r.branch, filters, settings));
  let run: RunRow | null = null;
  let range = window;
  const scope: CoverageScope = {};
  if (params.run) {
    run = runs.find((r) => r.run_id === params.run) ?? (await data.run(params.run));
    if (!run) throw new Error(`Run ${params.run} was not found`);
    scope.runId = run.run_id;
    const start = Date.parse(run.started_at);
    range = { from: new Date(start), to: new Date(start + 1) };
  } else {
    scope.fromMs = window.from.getTime();
    scope.toMs = window.to.getTime();
    if (filters.branch === 'main') scope.branches = settings.data.mainBranches;
  }

  const { rules, errors } = usableRules(settings.coverage.rules);
  const raw = await data.json<CoverageCatalog>('coverage-catalog.json');
  const catalog = raw && Array.isArray(raw.cells) ? raw : null;
  const months = (await data.catalog()).months;
  const stepsAvailable = months.some((m) => m.files.steps);

  let rows: CellRow[] = [];
  let unmapped: UnmappedRow[] = [];
  if (stepsAvailable) {
    [rows, unmapped] = await Promise.all([data.query<CellRow>(cellsSql(rules, scope), range), data.query<UnmappedRow>(unmappedSql(rules, scope), range)]);
  }

  const components = [...new Set([...rows.map((r) => r.component), ...(catalog?.cells.map((c) => c.component) ?? [])])].sort((a, b) =>
    a === '(unspecified)' ? 1 : b === '(unspecified)' ? -1 : a.localeCompare(b),
  );
  const component = params.component && components.includes(params.component) ? params.component : components[0] ?? null;

  const planned = new Set((catalog?.cells ?? []).filter((c) => c.component === component).map(key));
  const mine = rows.filter((r) => r.component === component);
  const byKey = new Map(mine.map((r) => [key(r), r]));
  const plannedCells = (catalog?.cells ?? []).filter((c) => c.component === component);

  const scenarios = [...new Set([...mine.map((r) => r.scenario), ...plannedCells.map((c) => c.scenario || '(unspecified)')])].sort();
  const featureNames = [...new Set([...plannedCells.map((c) => c.feature || '(unspecified)'), ...mine.map((r) => r.feature)])];
  const features: FeatureRow[] = featureNames.map((feature) => {
    const areaNames = [
      ...new Set([
        ...plannedCells.filter((c) => (c.feature || '(unspecified)') === feature).map((c) => c.area || '(unspecified)'),
        ...mine.filter((r) => r.feature === feature).map((r) => r.area),
      ]),
    ];
    const areas = areaNames.map((area) => {
      const cells: Record<string, CellStat | undefined> = {};
      for (const scenario of scenarios) {
        const k = key({ feature, area, scenario });
        const r = byKey.get(k);
        const isPlanned = planned.has(k);
        if (r || isPlanned) cells[scenario] = stat(ctx, r, isPlanned, !!catalog && !!r && !isPlanned);
      }
      return { name: area, cells };
    });
    const totals = Object.fromEntries(scenarios.map((s) => [s, sum(ctx, areas.map((a) => a.cells[s]))]));
    return { name: feature, areas, totals };
  });

  const sheet = buildSheet(rows, catalog?.cells ?? null, (rate) => ctx.health('coverageCell', rate));
  const allHits = rows.reduce((n, r) => n + Number(r.hits), 0);
  const allPassed = rows.reduce((n, r) => n + Number(r.passed), 0);
  const allRate = allHits ? (allPassed / allHits) * 100 : null;

  const hits = mine.reduce((n, r) => n + r.hits, 0);
  const passed = mine.reduce((n, r) => n + r.passed, 0);
  const passRate = hits ? (passed / hits) * 100 : null;
  return {
    levels: settings.coverage.levels,
    scope,
    run,
    runs,
    components,
    component,
    scenarios,
    features,
    hasCatalog: !!catalog,
    kpis: {
      cells: mine.length,
      hits,
      passRate,
      level: ctx.health('coverageCell', passRate),
      flakyCells: mine.filter((r) => r.flaky > 0).length,
      plannedCells: planned.size,
      plannedHit: [...planned].filter((k) => byKey.has(k)).length,
    },
    unmapped,
    ruleCount: rules.length,
    ruleErrors: errors,
    stepsAvailable,
    sheet,
    layout: params.layout === 'grid' || params.layout === 'sheet' ? params.layout : null,
    sheetKpis: {
      hits: allHits,
      passRate: allRate,
      level: ctx.health('coverageCell', allRate),
      planned: sheet.reduce((n, c) => n + c.planned, 0),
      plannedHit: sheet.reduce((n, c) => n + c.plannedHit, 0),
    },
  };
}
