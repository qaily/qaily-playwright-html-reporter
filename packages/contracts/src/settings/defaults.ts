// ─────────────────────────────────────────────────────────────────────────────
// Default settings. Edit this file to change what every report starts with.
// Teams can override values in data/settings.json (the team save button), and each
// viewer can override again in their browser ("Save for me").
// ─────────────────────────────────────────────────────────────────────────────

import { SETTINGS_VERSION, type Settings } from './types.ts';

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,

  thresholds: {
    // 100% → green, 90–99.99% → yellow, below 90% → red.
    passRate: [
      { min: 100, level: 'good' },
      { min: 90, level: 'warn' },
      { level: 'bad' },
    ],
    flakyRate: [
      { max: 2, level: 'good' },
      { max: 5, level: 'warn' },
      { level: 'bad' },
    ],
    durationRegressionPct: [
      { max: 10, level: 'good' },
      { max: 25, level: 'warn' },
      { level: 'bad' },
    ],
    coverageCell: [
      { min: 100, level: 'good' },
      { min: 80, level: 'warn' },
      { level: 'bad' },
    ],
  },

  metrics: {
    flakyCountsAsPassed: true,
    excludeSkipped: true,
  },

  // First matching lane wins; keep the catch-all last.
  lanes: [
    { id: 'web-dev', label: 'Web · Dev', match: { category: '^ui:web$', environment: 'dev' } },
    { id: 'web-staging', label: 'Web · Staging', match: { category: '^ui:web$', environment: 'staging' } },
    { id: 'admin-dev', label: 'Admin · Dev', match: { category: '^ui:admin$', environment: 'dev' } },
    { id: 'admin-staging', label: 'Admin · Staging', match: { category: '^ui:admin$', environment: 'staging' } },
    { id: 'web-nightly', label: 'Web · Nightly', match: { category: '^ui:web-nightly$' } },
    { id: 'batch', label: 'Batch jobs', match: { category: 'batch$' } },
    { id: 'other', label: 'Other', match: {} },
  ],

  display: {
    theme: 'chronoscope',
    colorScheme: 'auto',
    views: {},
    defaultPage: 'monitoring',
    defaultRangeDays: 14,
    weekStartsOn: 1,
    timeZone: 'local',
    refreshSeconds: 60,
    historyChips: 5,
    reducedMotion: 'auto',
  },

  themeTokens: {},

  data: {
    mainBranches: ['main'],
    requireSyncComplete: true,
  },

  connections: {
    agentHostUrl: 'ws://127.0.0.1:8081',
    workingDirectory: '',
    pathMap: [],
    github: { apiBase: 'https://api.github.com', owner: '', repo: '', branch: 'main', dataPath: 'data' },
    s3: { bucket: '', region: 'eu-north-1', prefix: 'jsonl-report', endpoint: '', pathStyle: false, dataSource: 'website', dataPrefix: 'qaily-data' },
  },

  coverage: {
    levels: ['Component', 'Scenario', 'Feature', 'Area'],
    // Empty: the heat map lists the most common unmapped steps to help write rules.
    rules: [],
  },

  ai: {
    provider: 'copilotcli',
    githubHost: '',
    contextCapKb: 30,
    actions: { analyzeTest: true, fixTest: true, analyzeRun: true },
  },
};
