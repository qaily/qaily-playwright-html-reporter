// Test detail shown in the drawer: attempts, error, steps, screenshots, attachments, history, notes.

import { sendTrace, traceViewerPage, type AttachmentCheck, type AttachmentRecord, type PageContext, type StepRecord } from '@qaily/contracts';
import { formatDateTime, formatDuration } from '@qaily/core';
import {
  LitElement,
  STATUS_COLOR,
  STATUS_GLYPH,
  ansi,
  baseStyles,
  css,
  html,
  nothing,
  stripAnsi,
  styleMap,
  suiteBadge,
  suiteBadges,
  suiteColor,
  type AnyStatus,
} from '@qaily/ui';
import type { TestItem } from './model.ts';
import './ai-section.ts';

interface HistoryPoint {
  run_id: string;
  started_at: number;
  status: AnyStatus;
  dur_ms: number;
  suite: string | null;
}

const TEXT_TYPES = /^(text\/|application\/(json|x-ndjson|xml))/;

const traceViewerUrl = (url: string) => `https://trace.playwright.dev/?trace=${encodeURIComponent(url)}`;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export class TestDetail extends LitElement {
  static properties = {
    item: { attribute: false },
    ctx: { attribute: false },
    runId: {},
    /** The suite (run tag) this execution ran in. */
    suite: { attribute: false },
    similar: { attribute: false },
    attempt: { state: true },
    history: { state: true },
    historyError: { state: true },
    viewer: { state: true },
    showStack: { state: true },
    urls: { state: true },
    gone: { state: true },
  };
  declare item: TestItem;
  declare ctx: PageContext;
  declare suite: string | null;
  declare runId: string;
  declare similar: TestItem[];
  declare attempt: number;
  declare history: HistoryPoint[] | null;
  declare historyError: string;
  declare viewer:
    | { kind: 'image'; list: AttachmentRecord[]; index: number }
    | { kind: 'text'; att: AttachmentRecord; text: string | null; truncated: boolean; error?: string }
    | null;
  declare showStack: boolean;
  /** Resolved attachment URLs for the shown attempt; null = needs S3 credentials. */
  declare urls: Map<string, string | null>;
  /** Storage's answer for this attempt's files when they can't be opened: missing (e.g. expired) or denied. */
  declare gone: Extract<AttachmentCheck, 'missing' | 'denied'> | null;

  private loadedFor = '';
  private urlsFor = '';
  private retried = new Set<string>();

  constructor() {
    super();
    this.attempt = -1;
    this.history = null;
    this.historyError = '';
    this.viewer = null;
    this.showStack = false;
    this.similar = [];
    this.urls = new Map();
    this.gone = null;
  }

  willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('item') && this.item) {
      const key = `${this.runId}/${this.item.summary.test_id}`;
      if (key !== this.loadedFor) {
        this.loadedFor = key;
        // Default to the last attempt: it decides the result.
        this.attempt = this.item.attempts.length - 1;
        this.showStack = false;
        this.loadHistory();
      }
    }
    // Re-resolve on every model update too: the artifact mode or credentials may have changed.
    if ((changed.has('attempt') || changed.has('item')) && this.item && this.attempt >= 0) this.resolveUrls();
  }

  private async resolveUrls() {
    const atts = this.item.attempts[this.attempt]?.attachments ?? [];
    const key = `${this.runId}/${this.item.summary.test_id}/${this.attempt}`;
    this.urlsFor = key;
    this.retried.clear();
    const entries = await Promise.all(
      // Images through imageUrl: with the storage bridge on, they become blob: URLs.
      atts.map(async (a) => [a.path, await (a.type.startsWith('image/') ? this.ctx.artifacts.imageUrl(this.runId, a.path) : this.ctx.artifacts.url(this.runId, a.path)).catch(() => null)] as const),
    );
    if (this.urlsFor !== key) return;
    this.urls = new Map(entries);
    this.gone = null;
    // A bucket lifecycle rule removes a run's files together; asking for the smallest one tells for all of them.
    const smallest = [...atts].sort((a, b) => a.size - b.size)[0];
    if (!smallest || !this.ctx.artifacts.status().ready) return;
    const check = await this.ctx.artifacts.check(this.runId, smallest.path);
    if (this.urlsFor === key) this.gone = check === 'missing' || check === 'denied' ? check : null;
  }

  /** An image that fails may just have an expired link. Tries one new link; a load success allows another try later. */
  private async retryImage(a: AttachmentRecord) {
    if (this.retried.has(a.path)) return;
    this.retried.add(a.path);
    const key = this.urlsFor;
    const url = await this.ctx.artifacts.imageUrl(this.runId, a.path, { fresh: true }).catch(() => null);
    if (url && this.urlsFor === key && url !== this.urls.get(a.path)) this.urls = new Map(this.urls).set(a.path, url);
  }

  /** Opens a link in a new tab with a current signature: the one in the page may have expired while the test stayed open. */
  private async openFresh(e: Event, a: AttachmentRecord, wrap: (url: string) => string = (u) => u) {
    e.preventDefault();
    const url = await this.ctx.artifacts.url(this.runId, a.path).catch(() => null);
    if (!url) return this.ctx.notify('Connect storage credentials in Settings → Tokens to open this file.', 'error');
    window.open(wrap(url), '_blank', 'noopener');
  }

  /** The self-hosted trace viewer, if the report has one (Settings → Connections → Trace viewer). */
  private traceViewer(): URL | null {
    try {
      return traceViewerPage(this.ctx.settings.connections.traceViewer, document.baseURI);
    } catch {
      return null;
    }
  }

  /** Opens the trace in the self-hosted viewer: reads the file here and hands it over, so no CORS is needed for it. */
  private async openTrace(e: Event, a: AttachmentRecord) {
    const viewer = this.traceViewer();
    if (!viewer) return this.openFresh(e, a, traceViewerUrl);
    e.preventDefault();
    // Opened inside the click, before any await, so the popup blocker allows it. Not noopener: the report needs the tab.
    const win = window.open(viewer.href, '_blank');
    if (!win) return this.ctx.notify('The browser blocked the trace viewer tab. Allow pop-ups for this site and try again.', 'error');
    try {
      const trace = await this.ctx.artifacts.blob(this.runId, a.path);
      if ((await sendTrace(win, trace, viewer.origin)) === 'sent' && viewer.origin === location.origin) {
        this.ctx.notify('The trace viewer did not take the trace. Download it and open it there with Select file.', 'error');
      }
    } catch (err) {
      win.close();
      this.ctx.notify(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  private async download(a: AttachmentRecord) {
    const name = a.path.split('/').pop() ?? a.name;
    const url = await this.ctx.artifacts.url(this.runId, a.path, { downloadName: name });
    if (!url) return this.ctx.notify('Connect storage credentials in Settings → Tokens to download this file.', 'error');
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.rel = 'noopener';
    link.click();
  }

  private connectHint() {
    return html`<p class="connect">${this.ctx.artifacts.status().message}
      <a href=${this.ctx.nav.href('settings', { section: 'secrets' })}>Connect</a></p>`;
  }

  private async loadHistory() {
    const id = this.item.summary.test_id;
    this.history = null;
    this.historyError = '';
    try {
      const now = this.ctx.now();
      const rows = await this.ctx.data.query<HistoryPoint>(
        `SELECT run_id, epoch_ms(started_at) AS started_at, status, dur_ms, suite FROM tests
         WHERE test_id = '${id.replaceAll("'", "''")}' ORDER BY started_at DESC LIMIT 30`,
        { from: new Date(now.getTime() - 90 * 86_400_000), to: new Date(now.getTime() + 1) },
      );
      if (this.item.summary.test_id === id) this.history = rows.reverse();
    } catch (err) {
      this.historyError = err instanceof Error ? err.message : String(err);
    }
  }

  private copy(text: string) {
    navigator.clipboard.writeText(text).then(
      () => this.ctx.notify('Copied to clipboard'),
      () => this.ctx.notify('Could not copy', 'error'),
    );
  }

  private async openText(att: AttachmentRecord) {
    this.viewer = { kind: 'text', att, text: null, truncated: false };
    try {
      const { text, truncated } = await this.ctx.artifacts.text(this.runId, att.path);
      this.viewer = { kind: 'text', att, text, truncated };
    } catch (err) {
      this.viewer = { kind: 'text', att, text: null, truncated: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private header() {
    const s = this.item.summary;
    const status = s.status;
    return html`<div class="head">
      <span class="pill" style=${styleMap({ background: STATUS_COLOR[status] })}>${STATUS_GLYPH[status]} ${status}</span>
      <h2>${s.title}</h2>
      <div class="muted mono path">${this.item.spec}${this.item.line ? `:${this.item.line}` : ''} · ${s.project}</div>
      ${this.item.groups.length ? html`<div class="muted crumbs">${this.item.groups.join(' › ')}</div>` : nothing}
      <div class="chips">
        ${suiteBadge(this.suite)}
        <span class="chip">⏱ ${formatDuration(s.dur_ms)}</span>
        ${this.item.attempts.length > 1 ? html`<span class="chip">↻ ${this.item.attempts.length - 1} retr${this.item.attempts.length > 2 ? 'ies' : 'y'}</span>` : nothing}
        ${s.tags.map((t) => html`<span class="chip tag">@${t}</span>`)}
      </div>
    </div>`;
  }

  private attemptTabs() {
    if (this.item.attempts.length < 2) return nothing;
    return html`<div class="tabs" role="tablist" aria-label="Attempts">
      ${this.item.attempts.map((a, i) => {
        const st = (a.detail?.status ?? 'passed') as AnyStatus;
        return html`<button role="tab" aria-selected=${i === this.attempt} class=${i === this.attempt ? 'on' : ''}
          @click=${() => (this.attempt = i)}>
          <span style=${styleMap({ color: STATUS_COLOR[st] })}>${STATUS_GLYPH[st]}</span> Attempt ${i + 1}
        </button>`;
      })}
    </div>`;
  }

  private errorSection() {
    const a = this.item.attempts[this.attempt];
    if (!a?.errors.length) return nothing;
    return html`${a.errors.map(
      (e) => html`<section class="card error">
        <div class="section-head">
          <h3>Error</h3>
          <span class="chip">${e.err_type}</span>
          <button class="small" @click=${() => this.copy([stripAnsi(e.err_msg), e.stack ? stripAnsi(e.stack) : ''].join('\n\n'))}>Copy</button>
        </div>
        <pre class="msg">${ansi(e.err_msg)}</pre>
        ${e.failed_step ? html`<p><span class="muted">Failed step:</span> ${e.failed_step}</p>` : nothing}
        ${e.locator ? html`<p><span class="muted">Locator:</span> <code>${e.locator}</code></p>` : nothing}
        ${e.snippet ? html`<pre class="code">${ansi(e.snippet)}</pre>` : nothing}
        ${e.stack
          ? html`<button class="small" @click=${() => (this.showStack = !this.showStack)}>${this.showStack ? 'Hide' : 'Show'} stack trace</button>
              ${this.showStack ? html`<pre class="code">${ansi(e.stack)}</pre>` : nothing}`
          : nothing}
      </section>`,
    )}`;
  }

  private stepsSection() {
    const steps = this.item.attempts[this.attempt]?.detail?.steps ?? [];
    if (!steps.length) return nothing;
    const longest = Math.max(...steps.map((s) => s.dur_ms), 1);
    const failedIdx = this.item.attempts[this.attempt]?.detail?.failed_step_idx;
    const row = (s: StepRecord) => html`<li class=${s.idx === failedIdx ? 'failed' : ''}>
      <span class="glyph" style=${styleMap({ color: STATUS_COLOR[s.status as AnyStatus] ?? 'inherit' })}
        title=${s.status}>${STATUS_GLYPH[s.status as AnyStatus] ?? '•'}</span>
      <span class="title">${s.title}</span>
      <span class="bar"><i style=${styleMap({ width: `${(s.dur_ms / longest) * 100}%` })}></i></span>
      <span class="dur muted">${formatDuration(s.dur_ms)}</span>
    </li>`;
    return html`<section class="card"><h3>Steps</h3><ol class="steps">${steps.map(row)}</ol></section>`;
  }

  private attachmentsSection() {
    const all = this.item.attempts[this.attempt]?.attachments ?? [];
    if (!all.length) return nothing;
    const images = all.filter((a) => a.type.startsWith('image/'));
    const others = all.filter((a) => !a.type.startsWith('image/'));
    const url = (a: AttachmentRecord) => this.urls.get(a.path);
    const locked = !this.ctx.artifacts.status().ready;
    if (this.gone === 'missing') {
      return html`<section class="card">
        <h3>Attachments</h3>
        <p class="muted">The screenshots and files of this run are no longer in storage: a retention rule on the bucket
          removes them after a while. The error and steps above are kept.</p>
        <ul class="files">${all.map((a) => html`<li><span class="name">${a.name}</span>
          <span class="muted">${a.type} · ${formatBytes(a.size)}</span></li>`)}</ul>
      </section>`;
    }
    return html`
      ${locked ? this.connectHint() : nothing}
      ${this.gone === 'denied'
        ? html`<p class="connect">Storage refused the files of this run. A retention rule on the bucket may have removed
            them (AWS answers "access denied" for a missing file when your key can't list the bucket), or your key can't
            read them.</p>`
        : nothing}
      ${images.length
        ? html`<section class="card">
            <h3>Screenshots</h3>
            <div class="shots">
              ${images.map((a, i) =>
                url(a)
                  ? html`<button class="shot" @click=${() => (this.viewer = { kind: 'image', list: images, index: i })}
                      aria-label="Open screenshot ${i + 1}"><img src=${url(a)!} alt=${a.name} loading="lazy"
                        @load=${() => this.retried.delete(a.path)} @error=${() => this.retryImage(a)} /></button>`
                  : html`<div class="shot placeholder muted">${locked ? 'Stored in S3' : '…'}</div>`,
              )}
            </div>
          </section>`
        : nothing}
      ${others.length
        ? html`<section class="card">
            <h3>Attachments</h3>
            <ul class="files">
              ${others.map(
                (a) => html`<li>
                  <span class="name">${a.name}</span>
                  <span class="muted">${a.type} · ${formatBytes(a.size)}</span>
                  <span class="actions">
                    ${TEXT_TYPES.test(a.type) ? html`<button class="small" ?disabled=${locked} @click=${() => this.openText(a)}>View</button>` : nothing}
                    ${a.name === 'trace' && url(a)
                      ? html`<a class="small button" target="_blank" rel="noopener"
                          href=${this.traceViewer()?.href ?? traceViewerUrl(url(a)!)} @click=${(e: Event) => this.openTrace(e, a)}>Trace viewer</a>`
                      : nothing}
                    <button class="small" ?disabled=${locked} @click=${() => this.download(a)}>Download</button>
                  </span>
                </li>`,
              )}
            </ul>
          </section>`
        : nothing}
    `;
  }

  private historySection() {
    const runId = this.runId;
    return html`<section class="card">
      <h3>History <span class="muted">(last ${this.history?.length ?? 30} runs)</span></h3>
      ${this.historyError
        ? html`<p class="muted">History unavailable: ${this.historyError}</p>`
        : !this.history
          ? html`<p class="muted">Loading…</p>`
          : html`<div class="history">
              ${this.history.map(
                (h) => html`<a href=${this.ctx.nav.href('tests', { run: h.run_id, test: this.item.summary.test_id })}
                  class=${h.run_id === runId ? 'cell current' : 'cell'}
                  style=${styleMap({
                    background: STATUS_COLOR[h.status] ?? 'var(--q-none)',
                    borderBottom: h.suite ? `4px solid ${suiteColor(h.suite)}` : '',
                  })}
                  title="${formatDateTime(new Date(h.started_at), this.ctx.settings)} · ${h.suite ? `${h.suite} · ` : ''}${h.status} · ${formatDuration(h.dur_ms)}"
                  ><span class="visually-hidden">${h.status}</span></a>`,
              )}
            </div>
            ${(() => {
              const suites = [...new Set(this.history.map((h) => h.suite).filter((x): x is string => !!x))].sort();
              return suites.length > 1 ? html`<p class="muted small-text">Underline = suite: ${suiteBadges(suites)}</p>` : nothing;
            })()}
            <p class="muted small-text">
              ${(() => {
                const ran = this.history.filter((h) => h.status !== 'skipped');
                const ok = ran.filter((h) => h.status === 'passed' || h.status === 'flaky').length;
                const flaky = ran.filter((h) => h.status === 'flaky').length;
                return ran.length ? `Passed ${ok} of ${ran.length} executed (${flaky} flaky).` : 'Not executed in this period.';
              })()}
            </p>`}
    </section>`;
  }

  private similarSection() {
    if (!this.similar.length) return nothing;
    return html`<section class="card">
      <h3>Same failure in this run <span class="muted">(${this.similar.length})</span></h3>
      <ul class="similar">
        ${this.similar.map(
          (t) => html`<li><a href=${this.ctx.nav.href('tests', { run: this.runId, test: t.summary.test_id })}>
            <span style=${styleMap({ color: STATUS_COLOR[t.summary.status] })}>${STATUS_GLYPH[t.summary.status]}</span> ${t.summary.title}</a>
            <span class="muted">${t.spec}</span></li>`,
        )}
      </ul>
    </section>`;
  }

  private notesSection() {
    const id = this.item.summary.test_id;
    return html`<section class="card">
      <h3>Notes <span class="muted">(this browser only)</span></h3>
      <textarea rows="3" placeholder="Add a note about this test…" .value=${this.ctx.notes.get(`test:${id}`)}
        @change=${(e: Event) => this.ctx.notes.set(`test:${id}`, (e.target as HTMLTextAreaElement).value)}></textarea>
    </section>`;
  }

  private annotations() {
    const list = this.item.attempts[this.attempt]?.detail?.annotations ?? [];
    if (!list.length) return nothing;
    return html`<section class="card"><h3>Annotations</h3>
      <dl class="annotations">${list.map((a) => html`<dt>${a.type}</dt><dd>${a.description ?? ''}</dd>`)}</dl></section>`;
  }

  private viewerModal() {
    const v = this.viewer;
    if (!v) return nothing;
    const close = () => (this.viewer = null);
    if (v.kind === 'image') {
      const a = v.list[v.index];
      const src = this.urls.get(a.path) ?? '';
      const go = (d: number) => (this.viewer = { ...v, index: (v.index + d + v.list.length) % v.list.length });
      return html`<q-modal open heading="Screenshot ${v.index + 1} of ${v.list.length}" @close=${close}>
        <div class="viewer-nav">
          <button ?disabled=${v.list.length < 2} @click=${() => go(-1)}>← Previous</button>
          <a class="button" href=${src} target="_blank" rel="noopener" @click=${(e: Event) => this.openFresh(e, a)}>Open original</a>
          <button ?disabled=${v.list.length < 2} @click=${() => go(1)}>Next →</button>
        </div>
        <img class="full" src=${src} alt=${a.name} @load=${() => this.retried.delete(a.path)} @error=${() => this.retryImage(a)} />
      </q-modal>`;
    }
    return html`<q-modal open heading=${v.att.name} @close=${close}>
      ${v.error
        ? html`<q-state kind="error" message=${v.error}></q-state>`
        : v.text == null
          ? html`<q-state kind="loading"></q-state>`
          : html`${v.truncated ? html`<p class="muted">Showing the first 256 KB. Download the file for the rest.</p>` : nothing}
              <pre class="code">${ansi(v.text)}</pre>`}
    </q-modal>`;
  }

  render() {
    if (!this.item) return nothing;
    const s = this.item.summary.status;
    const ai = s === 'failed' || s === 'flaky'
      ? html`<q-test-ai .ctx=${this.ctx} .runId=${this.runId} .testId=${this.item.summary.test_id}></q-test-ai>`
      : nothing;
    return html`${this.header()} ${ai} ${this.attemptTabs()} ${this.errorSection()} ${this.stepsSection()} ${this.attachmentsSection()}
    ${this.similarSection()} ${this.historySection()} ${this.annotations()} ${this.notesSection()} ${this.viewerModal()}`;
  }

  static styles = [
    baseStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .head h2 {
        font-size: 1.15rem;
        margin: 8px 0 4px;
      }
      .pill {
        display: inline-block;
        color: var(--q-on-status);
        border-radius: 999px;
        padding: 2px 10px;
        font-size: 0.85rem;
        font-weight: 600;
        text-transform: capitalize;
      }
      .path,
      .crumbs {
        font-size: 0.85rem;
        word-break: break-all;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 8px;
      }
      .chip {
        border: 1px solid var(--q-border);
        border-radius: 999px;
        padding: 1px 8px;
        font-size: 0.8rem;
        color: var(--q-text-muted);
      }
      .tabs {
        display: flex;
        gap: 4px;
        border-bottom: 1px solid var(--q-border);
      }
      .tabs button {
        border: none;
        border-bottom: 2px solid transparent;
        border-radius: 0;
        background: none;
      }
      .tabs button.on {
        border-bottom-color: var(--q-accent);
        color: var(--q-accent);
      }
      h3 {
        font-size: 0.95rem;
        margin-bottom: 8px;
      }
      .section-head {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .section-head h3 {
        margin: 0;
      }
      .section-head button {
        margin-left: auto;
      }
      .error {
        border-left: 4px solid var(--q-fail);
      }
      pre {
        white-space: pre-wrap;
        word-break: break-word;
        font-family: var(--q-font-mono);
        font-size: 0.82rem;
        margin: 8px 0;
      }
      pre.code {
        background: var(--q-surface-2);
        border-radius: calc(var(--q-radius) * 0.75);
        padding: 10px;
        overflow-x: auto;
      }
      button.small,
      a.small {
        font-size: 0.8rem;
        padding: 3px 8px;
      }
      a.button {
        display: inline-block;
        border: 1px solid var(--q-border);
        border-radius: calc(var(--q-radius) * 0.75);
        text-decoration: none;
        color: var(--q-text);
        padding: 6px 10px;
      }
      .steps {
        list-style: none;
        padding: 0;
        margin: 0;
        font-size: 0.85rem;
      }
      .steps li {
        display: grid;
        grid-template-columns: 18px minmax(0, 1fr) 80px 60px;
        gap: 8px;
        align-items: center;
        padding: 3px 4px;
        border-radius: 4px;
      }
      .steps li.failed {
        background: color-mix(in srgb, var(--q-fail) 15%, transparent);
      }
      .bar {
        height: 6px;
        background: var(--q-surface-2);
        border-radius: 3px;
        overflow: hidden;
      }
      .bar i {
        display: block;
        height: 100%;
        background: var(--q-accent);
      }
      .dur {
        text-align: right;
      }
      .shots {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
        gap: 8px;
      }
      .shot {
        padding: 0;
        overflow: hidden;
        aspect-ratio: 16 / 10;
      }
      .shot img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        object-position: top;
        display: block;
      }
      .placeholder {
        display: flex;
        align-items: center;
        justify-content: center;
        border: 1px dashed var(--q-border);
        border-radius: calc(var(--q-radius) * 0.75);
        font-size: 0.8rem;
      }
      .connect {
        border: 1px solid var(--q-warn);
        border-radius: var(--q-radius);
        padding: 8px 12px;
        margin: 0;
      }
      .files {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .files li {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 10px;
        align-items: center;
        padding: 6px 0;
        border-top: 1px solid var(--q-border);
      }
      .files .name {
        font-weight: 600;
      }
      .files .actions {
        margin-left: auto;
        display: flex;
        gap: 6px;
      }
      .history {
        display: flex;
        gap: 3px;
        flex-wrap: wrap;
      }
      .cell {
        width: 16px;
        height: 26px;
        border-radius: 3px;
        box-sizing: border-box;
      }
      .cell.current {
        outline: 2px solid var(--q-text);
        outline-offset: 1px;
      }
      .small-text {
        font-size: 0.85rem;
        margin: 8px 0 0;
      }
      .similar {
        margin: 0;
        padding-left: 18px;
      }
      .similar li {
        margin: 3px 0;
      }
      .similar .muted {
        font-size: 0.8rem;
        margin-left: 6px;
      }
      textarea {
        width: 100%;
        font: inherit;
        color: var(--q-text);
        background: var(--q-surface);
        border: 1px solid var(--q-border);
        border-radius: calc(var(--q-radius) * 0.75);
        padding: 8px;
      }
      .annotations {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 4px 12px;
        margin: 0;
      }
      .annotations dt {
        font-weight: 600;
      }
      .annotations dd {
        margin: 0;
      }
      .viewer-nav {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 10px;
      }
      img.full {
        max-width: 100%;
        display: block;
        margin: 0 auto;
      }
    `,
  ];
}

if (!customElements.get('q-test-detail')) customElements.define('q-test-detail', TestDetail);
