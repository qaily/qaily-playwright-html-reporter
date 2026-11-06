// Every setting the Settings page shows. The page renders its form from this list,
// and resolveSettings() validates stored overrides field by field with these schemas.

import { z } from 'zod';

export type SettingsScope = 'team' | 'personal' | 'both';

export type FieldEditor =
  | { kind: 'bands'; unit: string }
  | { kind: 'number'; min?: number; max?: number; step?: number; unit?: string }
  | { kind: 'boolean' }
  | { kind: 'select'; options: { value: string | number; label: string }[] }
  | { kind: 'text'; placeholder?: string }
  | { kind: 'string-list'; placeholder?: string }
  | { kind: 'lanes' }
  | { kind: 'tokens' }
  | { kind: 'path-map' }
  | { kind: 'views' }
  | { kind: 'theme' }
  | { kind: 'page' }
  | { kind: 'coverage-rules' };

export interface SettingsGroup {
  id: string;
  label: string;
  help?: string;
}

export interface FieldDef {
  path: string;
  group: string;
  label: string;
  help?: string;
  scope: SettingsScope;
  editor: FieldEditor;
  schema: z.ZodTypeAny;
}

const level = z.enum(['good', 'warn', 'bad']);
const band = z.object({ level, min: z.number().optional(), max: z.number().optional() }).strict();
const bands = z.array(band).min(1);
const lane = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    match: z
      .object({ category: z.string().optional(), environment: z.string().optional(), branch: z.string().optional() })
      .strict(),
  })
  .strict();
const cssVarName = z.string().regex(/^--[a-z0-9-]+$/i);
const optText = z.string().max(300).optional();
const coverageRule = z
  .object({ step: optText, tag: optText, title: optText, file: optText, ignoreCase: z.boolean().optional(),
    component: optText, scenario: optText, feature: optText, area: optText })
  .strict();

export const SETTINGS_GROUPS: SettingsGroup[] = [
  { id: 'thresholds', label: 'Health thresholds', help: 'When metrics turn green, yellow or red. Bands are checked top to bottom; the first match wins.' },
  { id: 'metrics', label: 'Metrics' },
  { id: 'lanes', label: 'Lanes', help: 'How runs are grouped on dashboards. The first matching lane wins.' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'data', label: 'Data' },
  { id: 'connections', label: 'Connections', help: 'Non-secret connection settings. Tokens are stored separately and never shared.' },
  { id: 'coverage', label: 'Coverage heat map', help: 'How test steps map to the coverage matrix. Explicit step annotations in tests win over these rules.' },
  { id: 'ai', label: 'AI' },
];

const text = (path: string, group: string, label: string, scope: SettingsScope, help?: string, placeholder?: string): FieldDef => ({
  path, group, label, scope, help, editor: { kind: 'text', placeholder }, schema: z.string(),
});
const bool = (path: string, group: string, label: string, scope: SettingsScope, help?: string): FieldDef => ({
  path, group, label, scope, help, editor: { kind: 'boolean' }, schema: z.boolean(),
});

export const SETTINGS_FIELDS: FieldDef[] = [
  { path: 'thresholds.passRate', group: 'thresholds', label: 'Pass rate', scope: 'both', editor: { kind: 'bands', unit: '%' }, schema: bands,
    help: 'Percent of executed tests that passed.' },
  { path: 'thresholds.flakyRate', group: 'thresholds', label: 'Flaky rate', scope: 'both', editor: { kind: 'bands', unit: '%' }, schema: bands,
    help: 'Percent of executed tests that passed only on retry.' },
  { path: 'thresholds.durationRegressionPct', group: 'thresholds', label: 'Duration regression', scope: 'both', editor: { kind: 'bands', unit: '%' }, schema: bands,
    help: 'How much slower a run is than the previous run in the same lane.' },
  { path: 'thresholds.coverageCell', group: 'thresholds', label: 'Heat map cell', scope: 'both', editor: { kind: 'bands', unit: '%' }, schema: bands,
    help: 'Pass rate of the steps that hit a coverage cell.' },

  bool('metrics.flakyCountsAsPassed', 'metrics', 'Flaky tests count as passed', 'both'),
  bool('metrics.excludeSkipped', 'metrics', 'Leave skipped tests out of the pass rate', 'both'),

  { path: 'lanes', group: 'lanes', label: 'Lanes', scope: 'team', editor: { kind: 'lanes' }, schema: z.array(lane).min(1),
    help: 'Category and branch are regular expressions; environment is an exact match. Empty means "any".' },

  { path: 'display.theme', group: 'appearance', label: 'Theme', scope: 'both', editor: { kind: 'theme' }, schema: z.string().min(1) },
  { path: 'display.colorScheme', group: 'appearance', label: 'Colour scheme', scope: 'personal', schema: z.enum(['auto', 'light', 'dark']),
    editor: { kind: 'select', options: [{ value: 'auto', label: 'Follow system' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }] } },
  { path: 'display.views', group: 'appearance', label: 'View per page', scope: 'personal', editor: { kind: 'views' }, schema: z.record(z.string()),
    help: 'Overrides the view the theme picks for a page.' },
  { path: 'themeTokens', group: 'appearance', label: 'Theme token overrides', scope: 'both', editor: { kind: 'tokens' },
    schema: z.record(cssVarName, z.string().max(200)), help: 'Applied on top of the active theme.' },
  { path: 'display.reducedMotion', group: 'appearance', label: 'Reduce motion', scope: 'personal', schema: z.enum(['auto', 'on', 'off']),
    editor: { kind: 'select', options: [{ value: 'auto', label: 'Follow system' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }] } },
  { path: 'display.defaultPage', group: 'appearance', label: 'Start page', scope: 'both', editor: { kind: 'page' }, schema: z.string().min(1) },
  { path: 'display.defaultRangeDays', group: 'appearance', label: 'Default date range', scope: 'both',
    editor: { kind: 'number', min: 1, max: 366, unit: 'days' }, schema: z.number().int().min(1).max(366) },
  { path: 'display.weekStartsOn', group: 'appearance', label: 'Week starts on', scope: 'both', schema: z.union([z.literal(0), z.literal(1)]),
    editor: { kind: 'select', options: [{ value: 1, label: 'Monday' }, { value: 0, label: 'Sunday' }] } },
  { path: 'display.timeZone', group: 'appearance', label: 'Time zone', scope: 'both', schema: z.enum(['local', 'UTC']),
    editor: { kind: 'select', options: [{ value: 'local', label: 'Browser local time' }, { value: 'UTC', label: 'UTC' }] } },
  { path: 'display.refreshSeconds', group: 'appearance', label: 'Auto-refresh interval', scope: 'both',
    editor: { kind: 'number', min: 0, max: 3600, unit: 's' }, schema: z.number().int().min(0).max(3600), help: '0 turns auto-refresh off.' },
  { path: 'display.historyChips', group: 'appearance', label: 'History runs per lane', scope: 'both',
    editor: { kind: 'number', min: 0, max: 20 }, schema: z.number().int().min(0).max(20) },

  { path: 'data.mainBranches', group: 'data', label: 'Main branches', scope: 'team', editor: { kind: 'string-list', placeholder: 'main' },
    schema: z.array(z.string().min(1)).min(1), help: 'Branches shown when the branch filter is "main".' },
  bool('data.requireSyncComplete', 'data', 'Only include runs with a .sync-complete marker', 'team',
    'Used by `qaily-report build`. Hides runs whose upload has not finished.'),

  text('connections.agentHostUrl', 'connections', 'AI agent host URL', 'personal', 'The `code agent host` WebSocket address.', 'ws://127.0.0.1:8081'),
  text('connections.workingDirectory', 'connections', 'Local test repo path', 'personal', 'Working directory for "Fix with AI".', '/Users/me/repos/tests'),
  { path: 'connections.pathMap', group: 'connections', label: 'Path mapping', scope: 'both', editor: { kind: 'path-map' },
    schema: z.array(z.object({ from: z.string().min(1), to: z.string() }).strict()), help: 'Rewrites CI paths in stack traces to local paths.' },
  text('connections.github.apiBase', 'connections', 'GitHub API base', 'team', 'https://api.github.com, or https://<host>/api/v3 for GitHub Enterprise Server.'),
  text('connections.github.owner', 'connections', 'GitHub owner', 'team', 'Owner of the repo that publishes this report.'),
  text('connections.github.repo', 'connections', 'GitHub repo', 'team'),
  text('connections.github.branch', 'connections', 'GitHub branch', 'team'),
  text('connections.github.dataPath', 'connections', 'Data folder in the repo', 'team'),
  text('connections.s3.bucket', 'connections', 'S3 bucket', 'team'),
  text('connections.s3.region', 'connections', 'S3 region', 'team', 'For Google Cloud Storage use auto. MinIO usually uses us-east-1.'),
  text('connections.s3.prefix', 'connections', 'S3 key prefix', 'team'),
  text('connections.s3.endpoint', 'connections', 'S3 endpoint', 'team',
    'Only for S3-compatible storage. Empty = AWS.', 'https://storage.googleapis.com'),
  bool('connections.s3.pathStyle', 'connections', 'Bucket in the URL path', 'team',
    'Uses host/bucket/key instead of bucket.host/key. MinIO usually needs this; AWS and Google Cloud Storage do not.'),
  { path: 'connections.s3.dataSource', group: 'connections', label: 'Report data source', scope: 'team', schema: z.enum(['website', 'bucket']),
    help: 'Website: dashboards work without credentials, but anyone who can open the site can read test titles and errors. Bucket: data stays private and needs no site redeploy, but every viewer needs credentials, and CI must run qaily-report publish. Applies after a reload.',
    editor: { kind: 'select', options: [{ value: 'website', label: 'Website' }, { value: 'bucket', label: 'Bucket' }] } },
  text('connections.s3.dataPrefix', 'connections', 'Report data key prefix', 'team',
    'Bucket folder for report data when the source is Bucket. Keep it outside the S3 key prefix.', 'qaily-data'),

  { path: 'coverage.levels', group: 'coverage', label: 'Level names', scope: 'both', editor: { kind: 'string-list', placeholder: 'Component, Scenario, Feature, Area' },
    schema: z.array(z.string().min(1).max(40)).length(4), help: 'Four names, top level first.' },
  { path: 'coverage.rules', group: 'coverage', label: 'Mapping rules', scope: 'team', editor: { kind: 'coverage-rules' },
    schema: z.array(coverageRule).max(500),
    help: 'Conditions are regular expressions; all filled ones must match. Each level comes from the first matching rule that sets it. A step is a hit only when a rule with a Step condition matches it.' },

  text('ai.provider', 'ai', 'Agent provider', 'both', 'Agent id offered by the host, e.g. copilotcli or claude.'),
  text('ai.githubHost', 'ai', 'GitHub host for Copilot', 'both',
    'Only for GitHub Enterprise with its own domain (e.g. acme.ghe.com). Empty = leave the agent host as it is. This changes host-wide config.'),
  { path: 'ai.contextCapKb', group: 'ai', label: 'Context size cap', scope: 'both', editor: { kind: 'number', min: 4, max: 200, unit: 'KB' },
    schema: z.number().int().min(4).max(200), help: 'Maximum test context sent to the agent per test.' },
  bool('ai.actions.analyzeTest', 'ai', 'Enable "Analyze test"', 'both'),
  bool('ai.actions.fixTest', 'ai', 'Enable "Fix with AI"', 'both'),
  bool('ai.actions.analyzeRun', 'ai', 'Enable "Analyze all failures"', 'both'),
];

export function fieldByPath(path: string): FieldDef | undefined {
  return SETTINGS_FIELDS.find((f) => f.path === path);
}
