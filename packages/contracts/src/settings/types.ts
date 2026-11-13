import type { Band } from '../health.ts';
import type { Lane } from '../lanes.ts';
import type { CoverageRule } from '../coverage.ts';

export const SETTINGS_VERSION = 1;

export interface PathMapping {
  /** Path prefix as it appears in CI stack traces. */
  from: string;
  /** Local replacement, e.g. the test repo checkout. */
  to: string;
}

export interface Settings {
  version: number;
  thresholds: {
    /** Run/test pass rate in percent. */
    passRate: Band[];
    /** Share of flaky tests in percent. */
    flakyRate: Band[];
    /** Duration growth versus the previous comparable run, in percent. */
    durationRegressionPct: Band[];
    /** Heat map cell pass rate in percent. */
    coverageCell: Band[];
  };
  metrics: {
    flakyCountsAsPassed: boolean;
    excludeSkipped: boolean;
  };
  lanes: Lane[];
  display: {
    theme: string;
    colorScheme: 'auto' | 'light' | 'dark';
    /** Per page view override, e.g. { monitoring: 'chronoscope' }. */
    views: Record<string, string>;
    defaultPage: string;
    defaultRangeDays: number;
    weekStartsOn: 0 | 1;
    timeZone: 'local' | 'UTC';
    refreshSeconds: number;
    historyChips: number;
    reducedMotion: 'auto' | 'on' | 'off';
  };
  /** CSS custom property overrides applied on top of the active theme, e.g. { "--q-good": "#1a7f37" }. */
  themeTokens: Record<string, string>;
  data: {
    mainBranches: string[];
    requireSyncComplete: boolean;
  };
  connections: {
    agentHostUrl: string;
    workingDirectory: string;
    pathMap: PathMapping[];
    /** Self-hosted Playwright trace viewer (path relative to the report, or a URL); '' uses trace.playwright.dev. */
    traceViewer: string;
    github: { apiBase: string; owner: string; repo: string; branch: string; dataPath: string };
    s3: {
      bucket: string;
      region: string;
      prefix: string;
      endpoint: string;
      pathStyle: boolean;
      dataSource: 'website' | 'bucket';
      dataPrefix: string;
      /** How the browser reads the bucket: directly (needs CORS rules), or through the storage bridge page in the bucket. */
      transport: 'cors' | 'bridge';
    };
  };
  coverage: {
    /** Display names of the four levels: component, scenario, feature, area. */
    levels: string[];
    rules: CoverageRule[];
  };
  ai: {
    provider: string;
    /** GitHub Enterprise host the agent's Copilot sign-in belongs to; '' leaves the host as configured. */
    githubHost: string;
    contextCapKb: number;
    actions: { analyzeTest: boolean; fixTest: boolean; analyzeRun: boolean };
  };
}

/** Recursively optional, used for the team and personal layers that store only overrides. */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;
