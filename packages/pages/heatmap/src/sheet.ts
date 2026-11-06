// The "Sheet" layout of the heat map: the planned coverage matrix as kept in a spreadsheet
// (Component → Scenario → Feature → Area, one row per area, in the sheet's own order), with the
// coverage of each row. Hit cells missing from the catalog are appended under their scenario and flagged.

import type { CatalogCell, HealthLevel } from '@qaily/contracts';
import type { CellRow } from './sql.ts';

export interface SheetStat {
  hits: number;
  passed: number;
  failed: number;
  flaky: number;
  tests: number;
  rate: number | null;
  level: HealthLevel | 'none';
  planned: boolean;
  /** Hit, but not in the catalog (only when there is a catalog). */
  unplanned: boolean;
}

export interface SheetArea {
  /** null = a feature line without an Area (as in the sheet). */
  name: string | null;
  /** The area value the cell has in the data ('(unspecified)' or ''), for the drill-down. */
  key: string;
  stat: SheetStat;
}
export interface SheetFeature {
  name: string;
  areas: SheetArea[];
  total: SheetStat;
}
export interface SheetScenario {
  name: string;
  features: SheetFeature[];
  total: SheetStat;
  planned: number;
  plannedHit: number;
}
export interface SheetComponent {
  name: string;
  scenarios: SheetScenario[];
  total: SheetStat;
  planned: number;
  plannedHit: number;
}

const UNSPEC = '(unspecified)';
const norm = (v: string | null | undefined) => (v && v.trim() ? v.trim() : UNSPEC);
const cellKey = (c: { component: string; scenario: string; feature: string; area: string }) =>
  [norm(c.component), norm(c.scenario), norm(c.feature), norm(c.area)].join('\u0000');

export function buildSheet(
  rows: readonly CellRow[],
  catalog: readonly CatalogCell[] | null,
  level: (rate: number | null) => HealthLevel | 'none',
): SheetComponent[] {
  const stat = (r: Partial<CellRow> | undefined, planned: boolean, unplanned: boolean): SheetStat => {
    const hits = Number(r?.hits ?? 0);
    const passed = Number(r?.passed ?? 0);
    const rate = hits ? (passed / hits) * 100 : null;
    return {
      hits,
      passed,
      failed: Number(r?.failed ?? 0),
      flaky: Number(r?.flaky ?? 0),
      tests: Number(r?.tests ?? 0),
      rate,
      level: level(rate),
      planned,
      unplanned,
    };
  };
  const sum = (list: SheetStat[]): SheetStat => {
    const t = list.reduce(
      (a, c) => ({ hits: a.hits + c.hits, passed: a.passed + c.passed, failed: a.failed + c.failed, flaky: a.flaky + c.flaky, tests: a.tests + c.tests }),
      { hits: 0, passed: 0, failed: 0, flaky: 0, tests: 0 },
    );
    return stat(t, list.some((c) => c.planned), false);
  };

  const byKey = new Map(rows.map((r) => [cellKey(r), r]));

  // The sheet's order: catalog rows as written, then hit cells the catalog doesn't have.
  type Leaf = { component: string; scenario: string; feature: string; area: string; planned: boolean };
  const leaves: Leaf[] = [];
  const seen = new Set<string>();
  for (const c of catalog ?? []) {
    const k = cellKey(c);
    if (seen.has(k)) continue;
    seen.add(k);
    leaves.push({ component: norm(c.component), scenario: norm(c.scenario), feature: norm(c.feature), area: norm(c.area), planned: true });
  }
  const extra = rows
    .filter((r) => !seen.has(cellKey(r)))
    .map((r) => ({ component: norm(r.component), scenario: norm(r.scenario), feature: norm(r.feature), area: norm(r.area), planned: false }));
  // Without a catalog, keep a stable, readable order; with one, extras follow their scenario's planned rows.
  extra.sort((a, b) => cellKey(a).localeCompare(cellKey(b)));
  leaves.push(...extra);

  const components: SheetComponent[] = [];
  const get = <T extends { name: string }>(list: T[], name: string, make: () => T) => {
    let x = list.find((i) => i.name === name);
    if (!x) list.push((x = make()));
    return x;
  };
  for (const leaf of leaves) {
    const comp = get(components, leaf.component, () => ({ name: leaf.component, scenarios: [], total: stat(undefined, false, false), planned: 0, plannedHit: 0 }));
    const scen = get(comp.scenarios, leaf.scenario, () => ({ name: leaf.scenario, features: [], total: stat(undefined, false, false), planned: 0, plannedHit: 0 }));
    const feat = get(scen.features, leaf.feature, () => ({ name: leaf.feature, areas: [], total: stat(undefined, false, false) }));
    const r = byKey.get(cellKey(leaf));
    feat.areas.push({
      name: leaf.area === UNSPEC ? null : leaf.area,
      key: r?.area ?? leaf.area,
      stat: stat(r, leaf.planned, !!catalog && !leaf.planned),
    });
  }
  for (const comp of components) {
    for (const scen of comp.scenarios) {
      for (const feat of scen.features) feat.total = sum(feat.areas.map((a) => a.stat));
      const areas = scen.features.flatMap((f) => f.areas);
      scen.total = sum(areas.map((a) => a.stat));
      scen.planned = areas.filter((a) => a.stat.planned).length;
      scen.plannedHit = areas.filter((a) => a.stat.planned && a.stat.hits > 0).length;
    }
    comp.total = sum(comp.scenarios.map((s) => s.total));
    comp.planned = comp.scenarios.reduce((n, s) => n + s.planned, 0);
    comp.plannedHit = comp.scenarios.reduce((n, s) => n + s.plannedHit, 0);
  }
  return components;
}
