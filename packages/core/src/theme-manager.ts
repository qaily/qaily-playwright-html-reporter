import type { PageModule, Settings, ThemeInfo, ThemeModule, ViewModule } from '@qaily/contracts';
import { DEFAULT_SETTINGS } from '@qaily/contracts';

export interface ResolvedView {
  name: string;
  load: () => Promise<ViewModule<unknown>>;
}

/** Applies the active theme's skin and token overrides, and picks which view renders each page. */
export class ThemeManager {
  private style: HTMLStyleElement;
  private appliedTokens: string[] = [];
  private media = window.matchMedia('(prefers-color-scheme: dark)');
  private motion = window.matchMedia('(prefers-reduced-motion: reduce)');

  readonly themes: ThemeModule[];

  constructor(themes: ThemeModule[]) {
    this.themes = themes;
    this.style = document.createElement('style');
    this.style.id = 'qaily-theme';
    document.head.append(this.style);
  }

  theme(id: string): ThemeModule {
    // An unknown id (e.g. a removed theme still saved in someone's settings) gets the default theme.
    const byId = (x: string) => this.themes.find((t) => t.id === x);
    return byId(id) ?? byId(DEFAULT_SETTINGS.display.theme) ?? this.themes[0];
  }

  /** Calls fn when the system colour scheme or motion preference changes. */
  onSystemChange(fn: () => void): () => void {
    this.media.addEventListener('change', fn);
    this.motion.addEventListener('change', fn);
    return () => {
      this.media.removeEventListener('change', fn);
      this.motion.removeEventListener('change', fn);
    };
  }

  apply(settings: Settings): ThemeInfo {
    const theme = this.theme(settings.display.theme);
    const wanted = settings.display.colorScheme;
    const colorScheme =
      theme.forcedColorScheme ?? (wanted === 'auto' ? (this.media.matches ? 'dark' : 'light') : wanted);
    const reducedMotion =
      settings.display.reducedMotion === 'auto' ? this.motion.matches : settings.display.reducedMotion === 'on';

    const root = document.documentElement;
    if (this.style.textContent !== theme.css) this.style.textContent = theme.css;
    root.dataset.theme = theme.id;
    root.dataset.colorScheme = colorScheme;
    root.style.colorScheme = colorScheme;
    root.toggleAttribute('data-reduced-motion', reducedMotion);

    for (const name of this.appliedTokens) root.style.removeProperty(name);
    this.appliedTokens = [];
    for (const [name, value] of Object.entries(settings.themeTokens)) {
      if (!/^--[a-z0-9-]+$/i.test(name)) continue;
      root.style.setProperty(name, value);
      this.appliedTokens.push(name);
    }
    return { id: theme.id, colorScheme, reducedMotion };
  }

  /** Every view name available for a page: its own views plus views themes add for it. */
  viewsFor(page: PageModule): string[] {
    const names = new Set(Object.keys(page.views));
    for (const t of this.themes) for (const name of Object.keys(t.views?.[page.id] ?? {})) names.add(name);
    return [...names];
  }

  /** User override → active theme's preferred view → classic. Unknown names fall back to classic. */
  resolveView(page: PageModule, settings: Settings): ResolvedView {
    const theme = this.theme(settings.display.theme);
    const candidates = [settings.display.views[page.id], theme.preferredViews?.[page.id], 'classic'];
    for (const name of candidates) {
      if (!name) continue;
      const load =
        page.views[name] ??
        theme.views?.[page.id]?.[name] ??
        this.themes.map((t) => t.views?.[page.id]?.[name]).find(Boolean);
      if (load) return { name, load: load as ResolvedView['load'] };
    }
    return { name: 'classic', load: page.views.classic as ResolvedView['load'] };
  }
}
