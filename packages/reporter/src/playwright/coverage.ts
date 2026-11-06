/**
 * Labels a test step with the coverage cell it exercises, for the report's heat map.
 *
 * @example
 * await test.step('Archive board', async (step) => {
 *   coverage(step, { component: 'Permissions', scenario: 'Workspace owners', feature: 'Boards', area: 'Archive' });
 *   // ...
 * });
 *
 * Needs Playwright 1.58+ (TestStepInfo.annotations). With custom level names, pass them as `levels`.
 */

export interface CoverageLabels {
  component: string;
  scenario?: string;
  feature?: string;
  area?: string;
}

interface StepInfoLike {
  annotations?: { type: string; description?: string }[];
}

export function coverage(step: StepInfoLike, labels: CoverageLabels, levels = ['Component', 'Test Name', 'Feature', 'Area']): void {
  if (!Array.isArray(step.annotations)) {
    throw new Error('coverage(): this Playwright version has no step annotations (needs 1.58 or newer).');
  }
  const values = [labels.component, labels.scenario, labels.feature, labels.area];
  values.forEach((value, i) => {
    if (value) step.annotations!.push({ type: levels[i], description: value });
  });
}
