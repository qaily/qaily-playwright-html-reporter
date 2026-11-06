// Loads one page module at a time, builds its model and mounts the chosen view.
// Every step is guarded, so a broken page shows an error card and the shell keeps working.

import type { PageContext, PageModule, RouteParams, ViewHandle } from '@qaily/contracts';
import type { ThemeManager } from '@qaily/core';
import type { PageEntry } from './pages.ts';

export interface HostState {
  page: PageModule<unknown> | null;
  view: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
}

export class PageHost {
  private container: HTMLElement;
  private overlay: HTMLElement;
  private handle: ViewHandle<unknown> | null = null;
  private mounted: { pageId: string; view: string } | null = null;
  private abort: AbortController | null = null;
  private seq = 0;
  private modules = new Map<string, Promise<PageModule<unknown>>>();
  private fallbackNoted = new Set<string>();

  private readonly themes: ThemeManager;
  private readonly onState: (s: HostState) => void;

  constructor(root: HTMLElement, themes: ThemeManager, onState: (s: HostState) => void) {
    this.themes = themes;
    this.onState = onState;
    this.container = document.createElement('div');
    this.container.className = 'page-view';
    this.overlay = document.createElement('div');
    this.overlay.className = 'page-overlay';
    root.append(this.overlay, this.container);
  }

  module(entry: PageEntry): Promise<PageModule<unknown>> {
    let p = this.modules.get(entry.id);
    if (!p) {
      p = entry.load().then((m) => m.default);
      // A failed chunk load (e.g. after a redeploy) can be retried.
      p.catch(() => this.modules.delete(entry.id));
      this.modules.set(entry.id, p);
    }
    return p;
  }

  /**
   * Shows a page. With quiet = true (background refresh) the current view stays visible
   * while loading, and errors are reported without replacing it.
   */
  async show(entry: PageEntry, params: RouteParams, ctx: PageContext, quiet = false): Promise<void> {
    const seq = ++this.seq;
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    const samePage = this.mounted?.pageId === entry.id;
    if (!quiet) this.setOverlay('loading', samePage ? 'Updating…' : `Loading ${entry.title}…`);

    let page: PageModule<unknown> | null = null;
    try {
      page = await this.module(entry);
      if (seq !== this.seq) return;
      this.onState({ page, view: this.mounted?.view ?? null, status: 'loading' });

      let view = this.themes.resolveView(page, ctx.settings);
      let [model, viewModule] = await Promise.all([page.load(ctx, params, abort.signal), view.load()]);
      if (seq !== this.seq || abort.signal.aborted) return;
      // Heavy theme views can decline (no WebGL, reduced motion): fall back to the classic view.
      const supported = viewModule.isSupported?.(ctx) ?? true;
      if (supported !== true && view.name !== 'classic') {
        const note = `${page.id}/${view.name}`;
        if (!this.fallbackNoted.has(note)) {
          this.fallbackNoted.add(note);
          ctx.notify(`Showing the classic ${page.title} view: ${supported}`);
        }
        view = { name: 'classic', load: page.views.classic as typeof view.load };
        viewModule = await view.load();
        if (seq !== this.seq || abort.signal.aborted) return;
      }

      if (this.handle && this.mounted?.pageId === page.id && this.mounted.view === view.name) {
        this.handle.update(model, ctx);
      } else {
        this.unmount();
        this.handle = viewModule.mount(this.container, model, ctx);
        this.mounted = { pageId: page.id, view: view.name };
      }
      this.setOverlay(null);
      this.onState({ page, view: view.name, status: 'ready' });
    } catch (err) {
      if (seq !== this.seq || abort.signal.aborted) return;
      console.error(`[qaily] page "${entry.id}" failed`, err);
      const message = err instanceof Error ? err.message : String(err);
      if (quiet && this.handle) {
        ctx.notify(`Refresh failed: ${message}`, 'error');
        return;
      }
      this.unmount();
      this.setOverlay('error', `${entry.title} could not be shown: ${message}`, () => this.show(entry, params, ctx));
      this.onState({ page, view: null, status: 'error' });
    }
  }

  showMissing(pageId: string): void {
    this.seq++;
    this.abort?.abort();
    this.unmount();
    this.setOverlay('empty', `There is no page called "${pageId}".`);
    this.onState({ page: null, view: null, status: 'error' });
  }

  private unmount(): void {
    try {
      this.handle?.destroy();
    } catch (err) {
      console.error('[qaily] view destroy failed', err);
    }
    this.handle = null;
    this.mounted = null;
    this.container.replaceChildren();
  }

  private setOverlay(kind: 'loading' | 'empty' | 'error' | null, message = '', retry?: () => void): void {
    this.overlay.replaceChildren();
    // While updating an already mounted page, keep it visible and show a slim loading bar instead.
    this.container.toggleAttribute('data-busy', kind === 'loading' && this.handle !== null);
    if (!kind || (kind === 'loading' && this.handle)) return;
    const state = document.createElement('q-state');
    state.kind = kind;
    state.message = message;
    state.retry = retry;
    this.overlay.append(state);
  }
}
