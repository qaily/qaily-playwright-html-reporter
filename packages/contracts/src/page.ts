// The contract between the shell and isolated page modules.
// Pages depend on these interfaces only; the shell supplies the implementations.

import type { HealthLevel } from './health.ts';
import type { AttachmentRecord, ErrorRecord, TestDetailsRecord, TestSummaryRecord } from './records.ts';
import type { Catalog, RunRow } from './rollups.ts';
import type { AiKind, AiRecord } from './ai.ts';
import type { ResolvedSettings, SettingsLayer } from './settings/resolve.ts';
import type { Settings } from './settings/types.ts';

export const PAGE_CONTRACT_VERSION = 1;

export type RouteParams = Record<string, string>;

export interface DateRange {
  from: Date; // inclusive
  to: Date; // exclusive
}

export interface DataApi {
  catalog(opts?: { refresh?: boolean }): Promise<Catalog>;
  /** Runs whose start time falls inside the range, newest first. */
  runs(range: DateRange): Promise<RunRow[]>;
  /**
   * SQL over the rollups of the months that overlap the range (DuckDB-WASM, loaded on first use).
   * Tables: `tests` (TestRow), `issues` (IssueRow) and `steps` (one row per top-level step of each attempt;
   * missing when the data was built before the heat map existed). Filter by started_at yourself for exact bounds.
   */
  query<T>(sql: string, range: DateRange): Promise<T[]>;
  /** One run's raw records (runs/<id>/*.jsonl.gz). Cached; small enough to load whole. */
  runDetail(runId: string): Promise<RunDetail>;
  /** A JSON file from the data dir (e.g. coverage-catalog.json); null when it doesn't exist. */
  json<T>(path: string): Promise<T | null>;
  /** A run by id, from the rollups (null when unknown). */
  run(runId: string): Promise<RunRow | null>;
}

/**
 * Where artifacts come from:
 * - static:  files published next to the report (data/runs/<id>/attachments/…)
 * - local:   the local `qaily-report serve` serves local files or redirects to S3, signing with this machine's AWS login
 * - browser: S3, signed in the browser with credentials the viewer pasted
 */
export type ArtifactMode = 'static' | 'local' | 'browser';

export interface ArtifactStatus {
  mode: ArtifactMode;
  /** False in browser mode until the viewer connects credentials. */
  ready: boolean;
  message: string;
}

export interface CredentialsInfo {
  keyId: string; // masked
  temporary: boolean;
  expiration: string | null;
  persistence: SecretPersistence | null;
}

export interface ArtifactsApi {
  status(): ArtifactStatus;
  /** URL of a run attachment (path relative to the run folder), or null when S3 credentials are needed first. */
  url(runId: string, path: string, opts?: { downloadName?: string; /** Sign a new link even if a recent one exists. */ fresh?: boolean }): Promise<string | null>;
  /** Fetches a text attachment, cut at maxBytes. */
  text(runId: string, path: string, maxBytes?: number): Promise<{ text: string; truncated: boolean }>;
  /** Browser mode: parses and stores pasted AWS credentials. Throws with a readable message when invalid. */
  connect(pasted: string, persistence: SecretPersistence): CredentialsInfo;
  disconnect(): void;
  credentials(): CredentialsInfo | null;
  subscribe(fn: (s: ArtifactStatus) => void): () => void;
}

export interface RunDetail {
  run: RunRow | null;
  summaries: TestSummaryRecord[];
  details: TestDetailsRecord[];
  errors: ErrorRecord[];
  attachments: AttachmentRecord[];
}

export type AiConnectionStatus = 'disconnected' | 'connecting' | 'ready' | 'error';

export interface AiState {
  status: AiConnectionStatus;
  message: string;
  agent?: string;
  model?: string;
}

export type AiJobStatus = 'running' | 'needs-approval' | 'done' | 'error' | 'cancelled';

export interface AiJobInfo {
  id: string;
  kind: AiKind;
  runId: string;
  testId?: string;
  title: string;
  status: AiJobStatus;
  error?: string;
}

/** A result plus where it came from: a local draft or the published report. */
export interface StoredAiRecord<K extends AiKind = AiKind> {
  path: string;
  record: AiRecord<K>;
  draft: boolean;
}

export interface AiApi {
  state(): AiState;
  /** Whether an action can start now, and why not. */
  canRun(kind: AiKind): { ok: boolean; reason?: string };
  analyzeTest(runId: string, testId: string): AiJobInfo;
  fixTest(runId: string, testId: string): AiJobInfo;
  analyzeRun(runId: string): AiJobInfo;
  /** The newest job for this target, if any (running or finished in this session). */
  jobFor(kind: AiKind, runId: string, testId?: string): AiJobInfo | null;
  /** Opens the AI panel on a job. */
  showJob(jobId: string): void;
  testResults(runId: string, testId: string): Promise<{ analysis: StoredAiRecord<'test-analysis'> | null; fix: StoredAiRecord<'test-fix'> | null }>;
  runResult(runId: string): Promise<StoredAiRecord<'run-analysis'> | null>;
  /** Run ids that have any result (published or draft). */
  runsWithResults(): Promise<Set<string>>;
  /** Where Publish would write, or why it can't. */
  publishTarget(): { ok: boolean; label: string; reason?: string };
  publish(stored: StoredAiRecord): Promise<void>;
  discardDraft(stored: StoredAiRecord): Promise<void>;
  /** Called on any change: connection, jobs, streamed output. Frequent while a job runs. */
  subscribe(fn: () => void): () => void;
  /** Called only when stored results change (a draft saved, published or discarded). */
  onResults(fn: () => void): () => void;
}

/** Free-text notes on tests and issues, kept in this browser. */
export interface NotesApi {
  get(key: string): string;
  set(key: string, text: string): void;
  /** Keys with a note, e.g. to show a note marker. */
  keys(): Set<string>;
}

export interface SettingsApi {
  readonly resolved: ResolvedSettings;
  readonly team: SettingsLayer;
  readonly personal: SettingsLayer;
  /** Whether "Save for team" is available (local server or GitHub writer configured). */
  readonly canSaveTeam: boolean;
  setPersonal(path: string, value: unknown): void;
  /** Writes the team layer to data/settings.json. */
  saveTeam(layer: SettingsLayer): Promise<void>;
  exportJson(): string;
  importJson(json: string, target: 'personal' | 'team'): Promise<void>;
  subscribe(fn: (r: ResolvedSettings) => void): () => void;
}

export type SecretKey = 'agentHostToken' | 'githubToken' | 'awsCredentials';
export type SecretPersistence = 'memory' | 'session' | 'local';

export interface SecretsApi {
  get(key: SecretKey): string | null;
  set(key: SecretKey, value: string, persistence: SecretPersistence): void;
  persistence(key: SecretKey): SecretPersistence | null;
  forget(key: SecretKey): void;
  forgetAll(): void;
}

export interface Filters {
  /** Days back from now. */
  rangeDays: number;
  /** "main" keeps only data.mainBranches. */
  branch: 'main' | 'all';
  /** Empty means all lanes. */
  lanes: string[];
}

export interface NavApi {
  href(page: string, params?: RouteParams): string;
  go(page: string, params?: RouteParams): void;
  /** Updates the current page's params without reloading the page model. */
  replaceParams(params: RouteParams): void;
}

export interface RegistryInfo {
  pages: { id: string; title: string; views: string[] }[];
  themes: { id: string; label: string; views: Record<string, string[]> }[];
}

export interface ThemeInfo {
  id: string;
  colorScheme: 'light' | 'dark';
  reducedMotion: boolean;
}

export interface PageContext {
  data: DataApi;
  settings: Settings;
  settingsApi: SettingsApi;
  secrets: SecretsApi;
  notes: NotesApi;
  artifacts: ArtifactsApi;
  ai: AiApi;
  filters: Filters;
  nav: NavApi;
  theme: ThemeInfo;
  registry: RegistryInfo;
  now(): Date;
  health(metric: keyof Settings['thresholds'], value: number | null | undefined): HealthLevel | 'none';
  notify(message: string, kind?: 'info' | 'error'): void;
}

export interface ViewHandle<M> {
  update(model: M, ctx: PageContext): void;
  destroy(): void;
}

export interface ViewModule<M> {
  mount(host: HTMLElement, model: M, ctx: PageContext): ViewHandle<M>;
  /**
   * For heavy views (WebGL, animation): true when the view can run here, else a reason. The shell then shows
   * the page's classic view instead and tells the user why.
   */
  isSupported?(ctx: PageContext): true | string;
}

export interface PageModule<M = unknown> {
  id: string;
  title: string;
  /** Icon name from @qaily/ui icons. */
  icon: string;
  order: number;
  contractVersion: typeof PAGE_CONTRACT_VERSION;
  /** Shell filters this page uses; the filter bar shows only these. Default: none. */
  filters?: Array<keyof Filters>;
  /** Builds the page's view model. Called again when route params, filters or settings change. */
  load(ctx: PageContext, params: RouteParams, signal: AbortSignal): Promise<M>;
  /** 'classic' is required; themes may add more. */
  views: { classic: () => Promise<ViewModule<M>> } & Record<string, () => Promise<ViewModule<M>>>;
}

/** Themes add skins and, optionally, alternative views for pages. */
export interface ThemeModule {
  id: string;
  label: string;
  /** CSS that defines the --q-* tokens. Must cover light and dark via [data-color-scheme]. */
  css: string;
  /** Only light or only dark, for single-world themes such as Chronoscope. */
  forcedColorScheme?: 'light' | 'dark';
  views?: Record<string, Record<string, () => Promise<ViewModule<any>>>>;
  /** Preferred view per page when this theme is active. */
  preferredViews?: Record<string, string>;
}

export function definePage<M>(page: PageModule<M>): PageModule<M> {
  return page;
}

export function defineTheme(theme: ThemeModule): ThemeModule {
  return theme;
}
