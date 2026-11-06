import { describe, expect, it } from 'vitest';
import { catalogFromCsv, parseCsv } from '../src/catalog.ts';

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, newlines in quotes and ; separators', () => {
    expect(parseCsv('a,"b, c","say ""hi"""\n1,"two\nlines",3')).toEqual([['a', 'b, c', 'say "hi"'], ['1', 'two\nlines', '3']]);
    expect(parseCsv('a;b;c\r\n1;2;3\r\n')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });
});

describe('catalogFromCsv', () => {
  it('fills down merged cells and resets deeper levels when a higher one changes', () => {
    const csv = [
      'Components,Scenario,Feature,Area',
      'Permissions,Workspace owners,Task creation,From list',
      ',,,From board',
      ',,Boards,Edit',
      ',,,Archive',
      ',Workspace guests,Boards,Archive',
      ',,,',
      'Regression Test,Templates,Create template from a task,',
      ',,View task template,',
    ].join('\n');
    const c = catalogFromCsv(csv);
    expect(c.levels).toEqual(['Components', 'Scenario', 'Feature', 'Area']);
    expect(c.cells).toEqual([
      { component: 'Permissions', scenario: 'Workspace owners', feature: 'Task creation', area: 'From list' },
      { component: 'Permissions', scenario: 'Workspace owners', feature: 'Task creation', area: 'From board' },
      { component: 'Permissions', scenario: 'Workspace owners', feature: 'Boards', area: 'Edit' },
      { component: 'Permissions', scenario: 'Workspace owners', feature: 'Boards', area: 'Archive' },
      { component: 'Permissions', scenario: 'Workspace guests', feature: 'Boards', area: 'Archive' },
      { component: 'Regression Test', scenario: 'Templates', feature: 'Create template from a task', area: '' },
      { component: 'Regression Test', scenario: 'Templates', feature: 'View task template', area: '' },
    ]);
  });
});
