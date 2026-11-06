import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, healthLevel, laneOf, passRate } from '../src/index.ts';

describe('healthLevel with the default pass-rate bands', () => {
  const bands = DEFAULT_SETTINGS.thresholds.passRate;
  it.each([
    [100, 'good'],
    [99.99, 'warn'],
    [90, 'warn'],
    [89.9, 'bad'],
    [0, 'bad'],
  ])('%s%% → %s', (value, level) => expect(healthLevel(bands, value)).toBe(level));

  it('returns none without a value', () => {
    expect(healthLevel(bands, null)).toBe('none');
    expect(healthLevel(bands, Number.NaN)).toBe('none');
  });

  it('uses max bounds for lower-is-better metrics', () => {
    const flaky = DEFAULT_SETTINGS.thresholds.flakyRate;
    expect(healthLevel(flaky, 2)).toBe('good');
    expect(healthLevel(flaky, 2.1)).toBe('warn');
    expect(healthLevel(flaky, 6)).toBe('bad');
  });
});

describe('passRate', () => {
  const counts = { total: 45, passed: 23, failed: 7, flaky: 1, skipped: 14 };
  it('counts flaky as passed and leaves skipped out by default', () => {
    expect(passRate(counts, DEFAULT_SETTINGS.metrics)).toBeCloseTo((24 / 31) * 100);
  });
  it('follows the metric settings', () => {
    expect(passRate(counts, { flakyCountsAsPassed: false, excludeSkipped: false })).toBeCloseTo((23 / 45) * 100);
  });
  it('is null when nothing ran', () => {
    expect(passRate({ total: 3, passed: 0, failed: 0, flaky: 0, skipped: 3 }, DEFAULT_SETTINGS.metrics)).toBeNull();
  });
});

describe('laneOf', () => {
  const lanes = DEFAULT_SETTINGS.lanes;
  it('matches category regex and exact environment, first match wins', () => {
    expect(laneOf(lanes, { category: 'ui:web', environment: 'dev', branch: 'main' })?.id).toBe('web-dev');
    expect(laneOf(lanes, { category: 'ui:admin', environment: 'staging', branch: 'main' })?.id).toBe('admin-staging');
    expect(laneOf(lanes, { category: 'ui:web-batch', environment: 'staging', branch: 'main' })?.id).toBe('batch');
    expect(laneOf(lanes, { category: 'all', environment: null, branch: null })?.id).toBe('other');
  });
  it('treats an invalid regex as no match', () => {
    expect(laneOf([{ id: 'x', label: 'X', match: { category: '(' } }], { category: 'a', environment: null, branch: null })).toBeNull();
  });
});

describe('evaluateRules', async () => {
  const { evaluateRules } = await import('../src/coverage.ts');
  const rules = [
    { title: 'via admin app$', scenario: 'Admin' },
    { step: 'archive the board', feature: 'Boards', area: 'Archive', component: 'Regression' },
    { step: 'task', tag: '^recurring$', feature: 'Task creation', area: 'Recurring' },
  ];
  it('takes each level from the first matching rule that sets it', () => {
    expect(evaluateRules(rules, { step: 'When I archive the board with a code "1"', title: 'Edit x via admin app', tags: ['recurring'] })).toEqual({
      component: 'Regression', scenario: 'Admin', feature: 'Boards', area: 'Archive',
    });
    expect(evaluateRules(rules, { step: 'When I create a task', tags: ['recurring'] })).toEqual({
      component: '(unspecified)', scenario: '(unspecified)', feature: 'Task creation', area: 'Recurring',
    });
  });
  it('is not a hit without a matching step rule', () => {
    expect(evaluateRules(rules, { step: 'Given I am logged in', title: 'x via admin app' })).toBeNull();
    expect(evaluateRules(rules, { step: 'When I create a task', tags: ['one-off'] })).toBeNull();
  });
});
