import { LOCATION_PATHS, type Catalog, type Filters, type PageContext, type RegistryInfo, type ResolvedSettings, type RouteParams, type Settings, type ThemeInfo } from '@qaily/contracts';
import {
  DataAccessError,
  FILTER_PARAMS,
  clearCachedRollups,
  filtersFromParams,
  filtersToParams,
  formatHash,
  formatRelative,
  healthLevel,
  type DataService,
  type Route,
  type Router,
  type NotesStore,
  type SecretStore,
  type SettingsService,
  type ThemeManager,
} from '@qaily/core';
import type { AiService } from '@qaily/ai';
import type { ArtifactService } from '@qaily/artifacts';
import { LitElement, baseStyles, css, html, nothing, repeat } from '@qaily/ui';
import { PageHost, type HostState } from './page-host.ts';
import { PAGES, type PageEntry } from './pages.ts';

/** Where the report reads its data from, fixed when the page loads. */
export type DataLocation = Pick<Settings['connections']['s3'], 'dataSource' | 'prefix' | 'dataPrefix'> & {
  /** The folder the viewer chose personally, for the header; null when the page loaded the report's own location. */
  personal: string | null;
};

/** The personal folder to name in the header: the data folder first, since a report reading from the bucket shows that. */
export function personalFolder(s3: Settings['connections']['s3'], sources: ResolvedSettings['sources']): string | null {
  const mine = (p: string) => sources[p] === 'personal';
  if (!LOCATION_PATHS.some(mine)) return null;
  const folder = s3.dataSource === 'bucket' && (mine('connections.s3.dataPrefix') || !mine('connections.s3.prefix')) ? s3.dataPrefix : s3.prefix;
  return folder.replace(/^\/+|\/+$/g, '') || '(bucket root)';
}

export interface ShellServices {
  data: DataService;
  settings: SettingsService;
  secrets: SecretStore;
  notes: NotesStore;
  artifacts: ArtifactService;
  ai: AiService;
  themes: ThemeManager;
  router: Router;
  location: DataLocation;
}

interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error';
}

const RANGE_OPTIONS = [1, 7, 14, 30, 90];

export class QailyShell extends LitElement {
  static properties = {
    route: { state: true },
    host: { state: true },
    theme: { state: true },
    catalog: { state: true },
    toasts: { state: true },
    dataAccess: { state: true },
  };
  declare route: Route;
  declare host: HostState;
  declare theme: ThemeInfo;
  declare catalog: Catalog | null;
  declare toasts: Toast[];
  declare dataAccess: string | null;

  services!: ShellServices;
  private pageHost: PageHost | null = null;
  private cleanups: (() => void)[] = [];
  private refreshTimer: number | undefined;
  private toastSeq = 0;

  constructor() {
    super();
    this.host = { page: null, view: null, status: 'idle' };
    this.catalog = null;
    this.toasts = [];
    this.dataAccess = null;
  }

  connectedCallback(): void {
    super.connectedCallback();
    const { router, settings, themes } = this.services;
    this.route = router.current;
    this.theme = themes.apply(settings.settings);
    this.cleanups.push(
      router.subscribe((r) => {
        const pageChanged = (r.page || this.settingsNow.display.defaultPage) !== this.pageId;
        this.route = r;
        // A new page starts at the top; a param change on the same page keeps the scroll position.
        if (pageChanged) window.scrollTo(0, 0);
        this.showRoute();
      }),
      settings.subscribe((r) => this.onSettings(r)),
      themes.onSystemChange(() => this.onSettings(settings.resolved)),
      this.services.artifacts.subscribe(async () => {
        const { data, artifacts } = this.services;
        if (data.readsFromBucket) {
          if (!artifacts.keepsCredentialsOnDevice()) void clearCachedRollups();
          // New credentials may be what the data was waiting for.
          await this.loadCatalog(true);
        }
        this.showRoute(true);
      }),
    );
    this.loadCatalog();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    for (const c of this.cleanups) c();
    window.clearInterval(this.refreshTimer);
  }

  firstUpdated(): void {
    const root = this.renderRoot.querySelector<HTMLElement>('#page-root')!;
    this.pageHost = new PageHost(root, this.services.themes, (s) => (this.host = s));
    this.showRoute();
    this.scheduleRefresh();
  }

  private get settingsNow() {
    return this.services.settings.settings;
  }

  private get pageId(): string {
    return this.route.page || this.settingsNow.display.defaultPage;
  }

  private get filters(): Filters {
    return filtersFromParams(this.route.params, this.settingsNow);
  }

  /** Route params that belong to the page itself (everything except the shell filters). */
  private get pageParams(): RouteParams {
    const params = { ...this.route.params };
    for (const k of FILTER_PARAMS) delete params[k];
    return params;
  }

  private onSettings(resolved: ResolvedSettings): void {
    this.theme = this.services.themes.apply(resolved.settings);
    this.scheduleRefresh();
    this.showRoute(true);
  }

  private async loadCatalog(refresh = false): Promise<boolean> {
    try {
      const before = this.catalog?.generatedAt;
      this.catalog = await this.services.data.catalog({ refresh });
      return before !== undefined && before !== this.catalog.generatedAt;
    } catch (err) {
      if (!refresh && !(err instanceof DataAccessError)) this.notify(`No report data found: ${err instanceof Error ? err.message : err}`, 'error');
      return false;
    } finally {
      this.dataAccess = this.services.data.accessProblem?.message ?? null;
    }
  }

  private scheduleRefresh(): void {
    window.clearInterval(this.refreshTimer);
    const seconds = this.settingsNow.display.refreshSeconds;
    if (seconds <= 0) return;
    this.refreshTimer = window.setInterval(async () => {
      if (document.hidden) return;
      if (await this.loadCatalog(true)) this.showRoute(true);
    }, seconds * 1000);
  }

  private registry(): RegistryInfo {
    return {
      pages: PAGES.map((p) => ({ id: p.id, title: p.title, views: this.viewNames(p) })),
      themes: this.services.themes.themes.map((t) => ({
        id: t.id,
        label: t.label,
        views: Object.fromEntries(Object.entries(t.views ?? {}).map(([page, views]) => [page, Object.keys(views)])),
      })),
    };
  }

  private viewNames(p: PageEntry): string[] {
    const themeViews = this.services.themes.themes.flatMap((t) => Object.keys(t.views?.[p.id] ?? {}));
    return ['classic', ...new Set(themeViews.filter((v) => v !== 'classic'))];
  }

  private context(): PageContext {
    const { data, settings, secrets, notes, artifacts, ai, router } = this.services;
    const s = settings.settings;
    const filters = this.filters;
    const keep = filtersToParams(filters, s);
    return {
      data,
      settings: s,
      settingsApi: settings,
      secrets,
      notes,
      artifacts,
      ai,
      filters,
      theme: this.theme,
      registry: this.registry(),
      now: () => new Date(),
      health: (metric, value) => healthLevel(s.thresholds[metric], value),
      notify: (m, k) => this.notify(m, k),
      nav: {
        href: (page, params = {}) => formatHash(page, { ...keep, ...params }),
        go: (page, params = {}) => router.go(page, { ...keep, ...params }),
        replaceParams: (params) => router.replace(this.pageId, { ...keep, ...params }),
      },
    };
  }

  private showRoute(quiet = false): void {
    if (!this.pageHost) return;
    const entry = PAGES.find((p) => p.id === this.pageId);
    if (!entry) return this.pageHost.showMissing(this.pageId);
    document.title = `${entry.title} · Qaily`;
    void this.pageHost.show(entry, this.pageParams, this.context(), quiet);
  }

  private setFilters(patch: Partial<Filters>): void {
    const s = this.settingsNow;
    const next = { ...this.filters, ...patch };
    this.services.router.go(this.pageId, { ...this.pageParams, ...filtersToParams(next, s) });
  }

  notify(message: string, kind: 'info' | 'error' = 'info'): void {
    const id = ++this.toastSeq;
    this.toasts = [...this.toasts, { id, message, kind }];
    window.setTimeout(() => (this.toasts = this.toasts.filter((t) => t.id !== id)), kind === 'error' ? 8000 : 4000);
  }

  private toggleScheme(): void {
    const next = this.theme.colorScheme === 'dark' ? 'light' : 'dark';
    this.services.settings.setPersonal('display.colorScheme', next);
  }

  /** The viewer's own bucket folder this page loaded, set under Settings → For me; null when it loaded the report's own. */
  private personalLocation(): string | null {
    return this.services.location.personal;
  }

  /** True when the location in the settings is no longer the one this page loaded. */
  private locationChanged(): boolean {
    const now = this.settingsNow.connections.s3;
    return LOCATION_PATHS.some((p) => {
      const key = p.split('.').pop() as 'dataSource' | 'prefix' | 'dataPrefix';
      return now[key] !== this.services.location[key];
    });
  }

  /** Loads the page again for a new data location. Cached rollups of the old one are dropped first. */
  private async reloadForLocation(reset: boolean): Promise<void> {
    if (reset) this.services.settings.setPersonalMany(Object.fromEntries(LOCATION_PATHS.map((p) => [p, undefined])));
    await clearCachedRollups();
    window.location.reload();
  }

  /** Which way the report gets its data: a small label in the header, with the details on hover. */
  private modeNote() {
    const mode = this.services.artifacts.status().mode;
    const [label, title] =
      mode === 'local'
        ? ['Local server', 'Opened through qaily-report serve: report data from the local folder, attachments from local files first, then S3.']
        : this.services.data.readsFromBucket
          ? ['Bucket data', 'Bucket data source: dashboards, run data and attachments are all read from S3 with signed links. The site holds only the app and settings.json.']
          : mode === 'browser'
            ? ['Website data · S3 files', 'Website data source: dashboard and run data are published with this site; screenshots, traces and other attachments are read from S3.']
            : ['Website data', 'Everything, attachments included, is published with this site. No bucket is configured.'];
    const mine = this.personalLocation();
    return mine
      ? html`<span class="muted mode mine" title=${`${title} You are looking at your own location: ${mine}. Reset it in the bar below the header.`}>${label} · ${mine}</span>`
      : html`<span class="muted mode" title=${title}>${label}</span>`;
  }

  render() {
    const used = new Set(this.host.page?.filters ?? []);
    const filters = this.filters;
    const keep = filtersToParams(filters, this.settingsNow);
    const forced = this.services.themes.theme(this.settingsNow.display.theme).forcedColorScheme;
    return html`
      <header>
        <a class="brand" href=${formatHash(this.settingsNow.display.defaultPage, keep)}>Qaily</a>
        <nav aria-label="Pages">
          ${PAGES.map(
            (p) => html`<a href=${formatHash(p.id, keep)} aria-current=${p.id === this.pageId ? 'page' : nothing}
              ><q-icon name=${p.icon}></q-icon><span>${p.title}</span></a
            >`,
          )}
        </nav>
        <div class="tools">
          ${this.modeNote()}
          ${this.catalog?.latestRunAt
            ? html`<span class="muted fresh" title="Newest run in the data">Latest run ${formatRelative(this.catalog.latestRunAt, new Date())}</span>`
            : nothing}
          <button
            class="icon"
            title=${forced ? `This theme is ${forced} only` : `Switch to ${this.theme.colorScheme === 'dark' ? 'light' : 'dark'} mode`}
            ?disabled=${!!forced}
            @click=${this.toggleScheme}
          >
            ${this.theme.colorScheme === 'dark' ? '☾' : '☀'}
          </button>
        </div>
      </header>
      ${used.size
        ? html`<div class="filters" role="toolbar" aria-label="Filters">
            ${used.has('rangeDays')
              ? html`<label
                  >Range
                  <select @change=${(e: Event) => this.setFilters({ rangeDays: Number((e.target as HTMLSelectElement).value) })}>
                    ${[...new Set([...RANGE_OPTIONS, filters.rangeDays])]
                      .sort((a, b) => a - b)
                      .map((d) => html`<option value=${d} ?selected=${d === filters.rangeDays}>${d === 1 ? '24 hours' : `${d} days`}</option>`)}
                  </select></label
                >`
              : nothing}
            ${used.has('branch')
              ? html`<label
                  >Branch
                  <select @change=${(e: Event) => this.setFilters({ branch: (e.target as HTMLSelectElement).value as Filters['branch'] })}>
                    <option value="main" ?selected=${filters.branch === 'main'}>${this.settingsNow.data.mainBranches.join(', ')}</option>
                    <option value="all" ?selected=${filters.branch === 'all'}>All branches</option>
                  </select></label
                >`
              : nothing}
          </div>`
        : nothing}
      ${this.locationChanged()
        ? html`<div class="access" role="status">
            <span>The data location changed. Reload to see the data from there.</span>
            <button @click=${() => this.reloadForLocation(false)}>Reload</button>
          </div>`
        : this.personalLocation()
          ? html`<div class="access mine" role="status">
              <span>You are looking at <b>${this.personalLocation()}</b>, your own setting, not this report's usual data.</span>
              <button @click=${() => this.reloadForLocation(true)}>Reset</button>
            </div>`
          : nothing}
      ${this.dataAccess
        ? html`<div class="access" role="alert">
            <span>${this.dataAccess}${this.catalog ? ' Data already loaded stays on screen.' : ''}</span>
            <a href=${formatHash('settings', { section: 'secrets' })}>Connect</a>
          </div>`
        : nothing}
      <main id="page-root"></main>
      <qaily-ai-dock .ai=${this.services.ai} .settings=${() => this.services.settings.settings}
        @notify=${(e: CustomEvent<{ message: string; kind: 'info' | 'error' }>) => this.notify(e.detail.message, e.detail.kind)}></qaily-ai-dock>
      <div class="toasts" aria-live="polite">
        ${repeat(
          this.toasts,
          (t) => t.id,
          (t) => html`<div class="toast ${t.kind}" role=${t.kind === 'error' ? 'alert' : 'status'}>${t.message}</div>`,
        )}
      </div>
    `;
  }

  static styles = [
    baseStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        min-height: 100vh;
        background: var(--q-bg);
      }
      header {
        display: flex;
        align-items: center;
        gap: 16px;
        padding: 0 16px;
        min-height: 52px;
        background: var(--q-surface);
        border-bottom: 1px solid var(--q-border);
        position: sticky;
        top: 0;
        z-index: 10;
        flex-wrap: wrap;
      }
      .brand {
        font-family: var(--q-font-display);
        font-weight: 700;
        font-size: 1.1rem;
        color: var(--q-accent);
        text-decoration: none;
      }
      nav {
        display: flex;
        gap: 2px;
        overflow-x: auto;
        flex: 1;
      }
      nav a {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 14px 12px;
        color: var(--q-text-muted);
        text-decoration: none;
        border-bottom: 2px solid transparent;
        white-space: nowrap;
      }
      nav a:hover {
        color: var(--q-text);
      }
      nav a[aria-current='page'] {
        color: var(--q-accent);
        border-bottom-color: var(--q-accent);
      }
      .tools {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .fresh {
        font-size: 0.85rem;
      }
      .mode {
        font-size: 0.75rem;
        padding: 2px 8px;
        border: 1px solid var(--q-border);
        border-radius: 999px;
        white-space: nowrap;
        cursor: help;
      }
      .mode.mine {
        border-color: var(--q-accent);
        color: var(--q-accent);
      }
      .access.mine {
        border-left: 4px solid var(--q-accent);
      }
      .icon {
        width: 34px;
        padding: 4px;
      }
      .filters {
        /* Above full-screen theme views (fixed canvases in the page), below the sticky header. */
        position: relative;
        z-index: 9;
        display: flex;
        gap: 16px;
        flex-wrap: wrap;
        padding: 8px 16px;
        border-bottom: 1px solid var(--q-border);
        background: var(--q-surface);
      }
      .filters label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--q-text-muted);
        font-size: 0.9rem;
      }
      .access {
        position: relative;
        z-index: 9;
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 4px 16px;
        padding: 8px 16px;
        border-bottom: 1px solid var(--q-border);
        background: var(--q-surface-2);
      }
      main {
        flex: 1;
        position: relative;
        padding: 16px;
      }
      .page-view[data-busy] {
        opacity: 0.6;
        transition: opacity 0.2s;
      }
      .toasts {
        position: fixed;
        right: 16px;
        bottom: 16px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        z-index: 20;
        max-width: min(420px, calc(100vw - 32px));
      }
      .toast {
        background: var(--q-surface-2);
        border: 1px solid var(--q-border);
        border-left: 4px solid var(--q-accent);
        border-radius: var(--q-radius);
        padding: 10px 14px;
        box-shadow: var(--q-shadow);
      }
      .toast.error {
        border-left-color: var(--q-bad);
      }
      @media (max-width: 640px) {
        nav a span {
          display: none;
        }
        .fresh,
        .mode {
          display: none;
        }
      }
    `,
  ];
}
