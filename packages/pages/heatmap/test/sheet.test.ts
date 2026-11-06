import { describe, expect, it } from 'vitest';
import { buildSheet } from '../src/sheet.ts';
import type { CellRow } from '../src/sql.ts';

const level = (rate: number | null) => (rate == null ? 'none' : rate >= 100 ? 'good' : 'warn') as 'none' | 'good' | 'warn';
const row = (component: string, scenario: string, feature: string, area: string, hits: number, passed = hits, flaky = 0): CellRow =>
  ({ component, scenario, feature, area, hits, passed, failed: hits - passed, flaky, tests: 1, runs: 1 });
const cell = (component: string, scenario: string, feature: string, area: string) => ({ component, scenario, feature, area });

describe('buildSheet', () => {
  const catalog = [
    cell('Permissions', 'Workspace owners', 'Task creation', 'From list'),
    cell('Permissions', 'Workspace owners', 'Task creation', 'From board'),
    cell('Permissions', 'Workspace owners', 'Boards', 'Archive'),
    cell('Regression Test', 'Templates', 'Create template from a task', ''),
    cell('Regression Test', 'Templates', 'View task template', ''),
    cell('Regression Test', 'Task setup', 'Task creation', 'From list'),
  ];
  const rows = [
    row('Regression Test', 'Task setup', 'Task creation', 'From list', 10, 9, 1),
    row('Regression Test', 'Task setup', 'Task creation', 'From email', 4),
    row('Regression Test', 'Templates', 'Create template from a task', '(unspecified)', 3),
    row('Permissions', 'Workspace owners', 'Boards', 'Archive', 2),
  ];
  const sheet = buildSheet(rows, catalog, level);

  it('keeps the spreadsheet order: components, scenarios, features, areas as written', () => {
    expect(sheet.map((c) => c.name)).toEqual(['Permissions', 'Regression Test']);
    expect(sheet[1].scenarios.map((s) => s.name)).toEqual(['Templates', 'Task setup']);
    expect(sheet[0].scenarios[0].features.map((f) => [f.name, f.areas.map((a) => a.name)])).toEqual([
      ['Task creation', ['From list', 'From board']],
      ['Boards', ['Archive']],
    ]);
  });

  it('shows feature lines without an Area as area null, matched to the unspecified data cell', () => {
    const t = sheet[1].scenarios[0].features;
    expect(t.map((f) => [f.name, f.areas[0].name, f.areas[0].key, f.areas[0].stat.hits])).toEqual([
      ['Create template from a task', null, '(unspecified)', 3],
      ['View task template', null, '(unspecified)', 0],
    ]);
  });

  it('appends hit cells missing from the catalog under their scenario, flagged unplanned', () => {
    const areas = sheet[1].scenarios[1].features[0].areas;
    expect(areas.map((a) => [a.name, a.stat.planned, a.stat.unplanned])).toEqual([
      ['From list', true, false],
      ['From email', false, true],
    ]);
  });

  it('adds up scenario and component totals and planned coverage', () => {
    const pi = sheet[1].scenarios[1];
    expect(pi.total).toMatchObject({ hits: 14, passed: 13, flaky: 1 });
    expect([pi.planned, pi.plannedHit]).toEqual([1, 1]);
    expect([sheet[0].planned, sheet[0].plannedHit, sheet[0].total.hits]).toEqual([3, 1, 2]);
  });

  it('without a catalog shows only hit cells, none flagged unplanned', () => {
    const s = buildSheet(rows, null, level);
    expect(s.flatMap((c) => c.scenarios.flatMap((x) => x.features.flatMap((f) => f.areas))).every((a) => !a.stat.unplanned && !a.stat.planned)).toBe(true);
    expect(s.reduce((n, c) => n + c.total.hits, 0)).toBe(19);
  });

  it('keeps the same scenario name apart in two components', () => {
    const s = buildSheet([row('A', 'Boards', 'F', 'x', 1), row('B', 'Boards', 'F', 'x', 2)], null, level);
    expect(s.map((c) => [c.name, c.total.hits])).toEqual([['A', 1], ['B', 2]]);
  });
});
