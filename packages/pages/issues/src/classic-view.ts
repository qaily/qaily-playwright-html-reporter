import type { AiRunAnalysis, ErrorType, PageContext, StoredAiRecord } from '@qaily/contracts';
import { formatDate, formatDateTime, formatRelative } from '@qaily/core';
import {
  AI_CATEGORY_COLOR,
  AI_CATEGORY_LABEL,
  LitElement,
  STATUS_COLOR,
  STATUS_GLYPH,
  aiProvenance,
  ansi,
  baseStyles,
  css,
  elementView,
  html,
  nothing,
  stripAnsi,
  styleMap,
  suiteBadge,
  suiteBadges,
} from '@qaily/ui';
import type { IssueGroup, IssuesModel } from './model.ts';

const TYPE_LABEL: Record<ErrorType, string> = {
  timeout: 'Timeout',
  assertion: 'Assertion',
  element_not_found: 'Element not found',
  network: 'Network',
  unknown: 'Other',
};

class IssuesClassic extends LitElement {
  static properties = {
    model: { attribute: false },
    ctx: { attribute: false },
    type: { state: true },
    search: { state: true },
    expanded: { state: true },
    shots: { state: true },
    aiRun: { state: true },
    aiTick: { state: true },
  };
  declare model: IssuesModel;
  declare ctx: PageContext;
  declare type: ErrorType | '';
  declare search: string;
  declare expanded: Set<string>;
  /** test_id → screenshot URL, for run scope. */
  declare shots: Map<string, string>;
  declare aiRun: StoredAiRecord<'run-analysis'> | null;
  declare aiTick: number;

  private shotsFor = '';
  private shotsRetried = '';
  /** Run whose thumbnails failed after a retry: not loaded again. */
  private shotsGone = '';
  private freshShots = new Set<string>();
  private aiFor = '';
  private offs: (() => void)[] = [];

  constructor() {
    super();
    this.type = '';
    this.search = '';
    this.expanded = new Set();
    this.shots = new Map();
    this.aiRun = null;
    this.aiTick = 0;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.offs.push(
      this.ctx.ai.onResults(() => this.loadAi()),
      this.ctx.ai.subscribe(() => this.aiTick++),
    );
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    for (const off of this.offs) off();
    this.offs = [];
  }

  private async loadAi() {
    const runId = this.model?.run?.run_id ?? '';
    this.aiFor = runId;
    const stored = runId ? await this.ctx.ai.runResult(runId) : null;
    if (this.aiFor === runId) this.aiRun = stored;
  }

  private aiPanel() {
    const m = this.model;
    if (!m.run) {
      return html`<p class="muted ai-hint">✨ To have AI analyse all failures together, pick a single run in Scope.</p>`;
    }
    const runId = m.run.run_id;
    const job = this.ctx.ai.jobFor('run-analysis', runId);
    const can = this.ctx.ai.canRun('run-analysis');
    const stored = this.aiRun;
    const r = stored?.record.result;
    const target = this.ctx.ai.publishTarget();
    const act = async (fn: () => Promise<void>, ok: string) => {
      try {
        await fn();
        this.ctx.notify(ok);
      } catch (err) {
        this.ctx.notify(err instanceof Error ? err.message : String(err), 'error');
      }
    };
    return html`<section class="card ai">
      <div class="ai-head">
        <h2>✨ AI summary</h2>
        ${job && (job.status === 'running' || job.status === 'needs-approval')
          ? html`<button @click=${() => this.ctx.ai.showJob(job.id)}>
              ${job.status === 'needs-approval' ? '⚠ Waiting for your approval' : 'Analyzing…'} (show)</button>`
          : html`<button class="primary" ?disabled=${!can.ok || m.issues.length === 0} title=${can.reason ?? ''}
              @click=${() => {
                try {
                  this.ctx.ai.analyzeRun(runId);
                } catch (err) {
                  this.ctx.notify(err instanceof Error ? err.message : String(err), 'error');
                }
              }}>${r ? 'Analyze again' : 'Analyze all failures'}</button>`}
      </div>
      ${r
        ? html`<p class="ai-summary">${r.summary}</p>
            ${r.nextSteps.length ? html`<h3>Next steps</h3><ol>${r.nextSteps.map((s) => html`<li>${s}</li>`)}</ol>` : nothing}
            ${r.flakySuspects.length
              ? html`<h3>Flaky suspects</h3><ul>${r.flakySuspects.map((f) => html`<li><b>${f.title}</b>: ${f.reason}</li>`)}</ul>`
              : nothing}
            <div class="ai-foot">
              <span class="muted small">${aiProvenance(stored!.record, this.ctx.settings)}</span>
              ${stored!.draft
                ? html`<span class="badge draft">Draft · only in this browser</span>
                    <button ?disabled=${!target.ok} title=${target.ok ? `Publish to ${target.label}` : target.reason ?? ''}
                      @click=${() => act(() => this.ctx.ai.publish(stored!), `Published to ${target.label}.`)}>Publish</button>
                    <button @click=${() => act(() => this.ctx.ai.discardDraft(stored!), 'Draft discarded.')}>Discard</button>`
                : html`<span class="badge">Published</span>`}
            </div>`
        : html`<p class="muted small">No AI summary for this run yet.${can.ok ? '' : ` ${can.reason}`}</p>`}
    </section>`;
  }

  private clusterFor(sig: string): AiRunAnalysis['clusters'][number] | undefined {
    return this.aiRun?.record.result.clusters.find((c) => c.issueSigs.includes(sig));
  }

  willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('model') && this.model) {
      const runId = this.model.run?.run_id ?? '';
      // Every model update: credentials may have been connected since (run details are cached).
      if (runId) {
        if (runId !== this.shotsFor) this.shots = new Map();
        this.shotsFor = runId;
        if (runId !== this.shotsGone) this.loadShots(runId);
      } else this.shots = new Map();
      if (runId !== this.aiFor || !runId) this.loadAi();
    }
  }

  /**
   * A thumbnail that fails may just have an expired link: sign the run's thumbnails again, once. If they fail again,
   * the files are likely gone (a bucket retention rule), so the issues show their bars instead.
   */
  private retryShots(src: string) {
    if (this.shotsRetried === this.shotsFor) {
      // Only a freshly signed link failing means the file is gone; others may be from before the retry.
      if (this.freshShots.has(src)) {
        this.shotsGone = this.shotsFor;
        this.shots = new Map();
      }
      return;
    }
    this.shotsRetried = this.shotsFor;
    if (this.shotsFor) void this.loadShots(this.shotsFor, true);
  }

  private async loadShots(runId: string, fresh = false) {
    try {
      const detail = await this.ctx.data.runDetail(runId);
      const first = new Map<string, string>();
      for (const a of detail.attachments) {
        if (a.attempt === 0 && a.type.startsWith('image/') && !first.has(a.test_id)) first.set(a.test_id, a.path);
      }
      const map = new Map<string, string>();
      await Promise.all(
        [...first].map(async ([testId, path]) => {
          const url = await this.ctx.artifacts.imageUrl(runId, path, { fresh }).catch(() => null);
          if (url) map.set(testId, url);
        }),
      );
      if (this.shotsFor !== runId) return;
      this.shots = map;
      if (fresh) this.freshShots = new Set(map.values());
    } catch {
      // Screenshots are a nice-to-have; the issue list works without them.
    }
  }

  private toggle(sig: string) {
    const next = new Set(this.expanded);
    if (next.has(sig)) next.delete(sig);
    else next.add(sig);
    this.expanded = next;
  }

  private passesFilters(i: IssueGroup): boolean {
    if (this.type && i.errType !== this.type) return false;
    const q = this.search.trim().toLowerCase();
    if (!q) return true;
    return (
      i.message.toLowerCase().includes(q) ||
      (i.failedStep ?? '').toLowerCase().includes(q) ||
      i.occurrences.some((o) => o.title.toLowerCase().includes(q))
    );
  }

  private copy(i: IssueGroup) {
    const tests = [...new Map(i.occurrences.map((o) => [o.test_id, o.title])).values()];
    const text = [stripAnsi(i.message), i.failedStep ? `Failed step: ${i.failedStep}` : '', i.location ? `At: ${i.location}` : '',
      `Affected tests (${tests.length}):`, ...tests.map((t) => `- ${t}`)].filter(Boolean).join('\n');
    navigator.clipboard.writeText(text).then(() => this.ctx.notify('Issue copied'), () => this.ctx.notify('Could not copy', 'error'));
  }

  private bars(i: IssueGroup) {
    if (!i.perDay.length) return nothing;
    const max = Math.max(...i.perDay, 1);
    return html`<div class="bars" aria-label="Occurrences per day">
      ${i.perDay.map(
        (n, d) => html`<i style=${styleMap({ height: `${n ? 15 + (n / max) * 85 : 4}%`, opacity: n ? '1' : '0.25' })}
          title="${this.model.days[d]}: ${n}"></i>`,
      )}
    </div>`;
  }

  private card(i: IssueGroup) {
    const open = this.expanded.has(i.sig);
    const s = this.ctx.settings;
    const firstShot = i.occurrences.map((o) => this.shots.get(o.test_id)).find(Boolean);
    const lines = stripAnsi(i.message).split('\n');
    const short = lines.slice(0, 3).join('\n');
    const hasNote = this.ctx.notes.get(`issue:${i.sig}`) !== '';
    const uniqueTests = [...new Map(i.occurrences.map((o) => [o.test_id, o])).values()];
    return html`<article class="card issue">
      <div class="top">
        <div class="main">
          <div class="badges">
            <span class="badge type-${i.errType}">${TYPE_LABEL[i.errType]}</span>
            <span class="badge">${i.testCount} test${i.testCount === 1 ? '' : 's'}</span>
            ${this.model.scope === 'range' ? html`<span class="badge">${i.runCount} run${i.runCount === 1 ? '' : 's'}</span>
              <span class="badge">${i.occurrences.length}× total</span>` : nothing}
            ${i.flakyCount ? html`<span class="badge" style=${styleMap({ color: STATUS_COLOR.flaky })}>↻ ${i.flakyCount} recovered on retry</span>` : nothing}
            ${hasNote ? html`<span class="badge" title="Has a note">✎ note</span>` : nothing}
          </div>
          <pre class="msg">${open ? ansi(i.message) : short}${!open && lines.length > 3 ? '…' : ''}</pre>
          ${i.failedStep ? html`<div class="step"><span class="muted">Failed step:</span> ${i.failedStep}</div>` : nothing}
          ${(() => {
            const c = this.clusterFor(i.sig);
            return c
              ? html`<div class="ai-note">
                  <span class="cat" style=${styleMap({ background: AI_CATEGORY_COLOR[c.category] })}>${AI_CATEGORY_LABEL[c.category]}</span>
                  <b>✨ ${c.title}</b> <span class="muted small">(${Math.round(c.confidence * 100)}%)</span>
                  <div class="pre">${c.rootCause}</div>
                  ${c.recommendation ? html`<div class="pre"><span class="muted">Recommendation:</span> ${c.recommendation}</div>` : nothing}
                </div>`
              : nothing;
          })()}
          ${i.location ? html`<div class="muted mono loc">${i.location}</div>` : nothing}
          ${this.model.scope === 'range'
            ? html`<div class="muted seen">First seen ${formatDateTime(new Date(i.firstSeen), s)} · last seen ${formatRelative(new Date(i.lastSeen), this.ctx.now())}</div>`
            : nothing}
        </div>
        ${firstShot ? html`<img class="thumb" src=${firstShot} alt="Screenshot of a failing test" loading="lazy" @error=${() => this.retryShots(firstShot)} />` : this.bars(i)}
      </div>
      <div class="actions">
        <button @click=${() => this.toggle(i.sig)} aria-expanded=${open}>${open ? 'Hide' : 'Show'} affected tests</button>
        <button @click=${() => this.copy(i)}>Copy</button>
      </div>
      ${open
        ? html`<ul class="affected">
              ${uniqueTests.map((o) => {
                const count = i.occurrences.filter((x) => x.test_id === o.test_id).length;
                return html`<li>
                  <span style=${styleMap({ color: STATUS_COLOR[o.status] })} title=${o.status}>${STATUS_GLYPH[o.status]}</span>
                  <a href=${this.ctx.nav.href('tests', { run: o.run_id, test: o.test_id })}>${o.title}</a>
                  ${suiteBadges([...new Set(i.occurrences.filter((x) => x.test_id === o.test_id).map((x) => x.suite).filter((x): x is string => !!x))].sort())}
                  <span class="muted">${o.project} · ${this.model.scope === 'range' ? `latest ${formatDate(new Date(o.started_at), s)}` : ''}${count > 1 ? ` · ${count}×` : ''}</span>
                </li>`;
              })}
            </ul>
            <label class="note">Note (this browser only)
              <textarea rows="2" .value=${this.ctx.notes.get(`issue:${i.sig}`)}
                @change=${(e: Event) => { this.ctx.notes.set(`issue:${i.sig}`, (e.target as HTMLTextAreaElement).value); this.requestUpdate(); }}></textarea>
            </label>`
        : nothing}
    </article>`;
  }

  render() {
    const m = this.model;
    const s = this.ctx.settings;
    const visible = m.issues.filter((i) => this.passesFilters(i));
    return html`
      <section class="card head">
        <label class="scope">Scope
          <select @change=${(e: Event) => {
            const v = (e.target as HTMLSelectElement).value;
            this.ctx.nav.go('issues', v ? { run: v } : {});
          }}>
            <option value="" ?selected=${m.scope === 'range'}>All runs in range (${m.runs.length})</option>
            ${m.run && !m.runs.some((r) => r.run_id === m.run!.run_id)
              ? html`<option value=${m.run.run_id} selected>${formatDateTime(m.run.started_at, s)} · ${m.run.tag ? `${m.run.tag} · ` : ''}${m.run.category ?? ''}</option>`
              : nothing}
            ${m.runs.map(
              (r) => html`<option value=${r.run_id} ?selected=${m.run?.run_id === r.run_id}>
                ${formatDateTime(r.started_at, s)} · ${r.tag ? `${r.tag} · ` : ''}${r.category ?? ''} ${r.environment ?? ''} · ${r.branch ?? ''} · ✕${r.failed}</option>`,
            )}
          </select>
        </label>
        ${m.run?.tag ? html`<span class="suite-of">Suite ${suiteBadge(m.run.tag)}</span>` : nothing}
        <div class="kpis">
          <div><b>${m.issues.length}</b><span class="muted">distinct issues</span></div>
          <div><b>${m.affectedTests}</b><span class="muted">affected tests</span></div>
          <div><b>${m.failingExecutions}</b><span class="muted">failing executions</span></div>
          ${m.run ? html`<div><a href=${this.ctx.nav.href('tests', { run: m.run.run_id, status: 'failed' })}>Open run in Tests →</a></div>` : nothing}
        </div>
      </section>
      ${this.aiPanel()}
      <div class="toolbar">
        <div class="chips" role="group" aria-label="Error type">
          <button class=${this.type === '' ? 'on' : ''} @click=${() => (this.type = '')}>All</button>
          ${m.errTypes.map(
            (t) => html`<button class=${this.type === t ? 'on' : ''} @click=${() => (this.type = t)}>
              ${TYPE_LABEL[t]} <b>${m.issues.filter((i) => i.errType === t).length}</b></button>`,
          )}
        </div>
        <input type="search" placeholder="Search message, step or test…" aria-label="Search issues" .value=${this.search}
          @input=${(e: Event) => (this.search = (e.target as HTMLInputElement).value)} />
      </div>
      ${visible.length
        ? visible.map((i) => this.card(i))
        : html`<q-state kind="empty" message=${m.issues.length ? 'No issues match these filters.' : 'No failures. 🎉'}></q-state>`}
    `;
  }

  static styles = [
    baseStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: 12px;
        max-width: 1200px;
        margin: 0 auto;
      }
      .head {
        display: flex;
        flex-wrap: wrap;
        gap: 16px;
        align-items: center;
        justify-content: space-between;
      }
      .scope {
        display: flex;
        gap: 8px;
        align-items: center;
        font-weight: 600;
      }
      .scope select {
        max-width: min(520px, 75vw);
      }
      .kpis {
        display: flex;
        gap: 20px;
        flex-wrap: wrap;
        align-items: center;
      }
      .kpis div {
        display: flex;
        flex-direction: column;
      }
      .kpis b {
        font-size: 1.4rem;
        font-family: var(--q-font-display);
      }
      .kpis span {
        font-size: 0.8rem;
      }
      .ai {
        border-left: 4px solid var(--q-accent);
      }
      .ai-head {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .ai-head h2 {
        font-size: 1rem;
        flex: 1;
      }
      .ai h3 {
        font-size: 0.9rem;
        margin: 10px 0 4px;
      }
      .ai-summary {
        white-space: pre-wrap;
      }
      .ai-foot {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
        margin-top: 10px;
      }
      .ai-foot .muted {
        flex: 1;
      }
      .ai-hint {
        margin: 0;
      }
      .small {
        font-size: 0.82rem;
      }
      .badge.draft {
        border-color: var(--q-warn);
        color: var(--q-warn);
      }
      .ai-note {
        margin-top: 8px;
        padding: 8px 10px;
        border-radius: calc(var(--q-radius) * 0.75);
        background: color-mix(in srgb, var(--q-accent) 10%, transparent);
        font-size: 0.88rem;
      }
      .cat {
        color: var(--q-on-status);
        border-radius: 999px;
        padding: 1px 8px;
        font-size: 0.75rem;
        font-weight: 600;
        margin-right: 6px;
      }
      .pre {
        white-space: pre-wrap;
        margin-top: 4px;
      }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .chips button.on {
        border-color: var(--q-accent);
        box-shadow: inset 0 0 0 1px var(--q-accent);
      }
      input[type='search'] {
        flex: 1;
        min-width: 200px;
      }
      .issue {
        border-left: 4px solid var(--q-fail);
      }
      .top {
        display: flex;
        gap: 16px;
      }
      .main {
        flex: 1;
        min-width: 0;
      }
      .badges {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .badge {
        border: 1px solid var(--q-border);
        border-radius: 999px;
        padding: 1px 8px;
        font-size: 0.78rem;
      }
      .type-timeout {
        color: var(--q-flaky);
        border-color: var(--q-flaky);
      }
      .type-assertion,
      .type-element_not_found {
        color: var(--q-fail);
        border-color: var(--q-fail);
      }
      .type-network {
        color: var(--q-accent);
        border-color: var(--q-accent);
      }
      .msg {
        white-space: pre-wrap;
        word-break: break-word;
        font-family: var(--q-font-mono);
        font-size: 0.82rem;
        margin: 10px 0 6px;
      }
      .step,
      .loc,
      .seen {
        font-size: 0.85rem;
        margin-top: 4px;
        overflow-wrap: anywhere;
      }
      .thumb {
        width: 180px;
        height: 112px;
        object-fit: cover;
        object-position: top;
        border-radius: calc(var(--q-radius) * 0.75);
        border: 1px solid var(--q-border);
        flex: none;
      }
      .bars {
        width: 180px;
        height: 48px;
        display: flex;
        align-items: flex-end;
        gap: 2px;
        flex: none;
      }
      .bars i {
        flex: 1;
        background: var(--q-fail);
        border-radius: 2px 2px 0 0;
      }
      .actions {
        display: flex;
        gap: 8px;
        margin-top: 10px;
      }
      .affected {
        list-style: none;
        padding: 0;
        margin: 10px 0 0;
      }
      .affected li {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        padding: 5px 0;
        border-top: 1px solid var(--q-border);
      }
      .affected .muted {
        font-size: 0.85rem;
      }
      .note {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin-top: 10px;
        font-size: 0.85rem;
        color: var(--q-text-muted);
      }
      textarea {
        font: inherit;
        color: var(--q-text);
        background: var(--q-surface);
        border: 1px solid var(--q-border);
        border-radius: calc(var(--q-radius) * 0.75);
        padding: 8px;
      }
      @media (max-width: 640px) {
        .top {
          flex-direction: column;
        }
      }
    `,
  ];
}

export default elementView<IssuesModel>('q-issues-classic', IssuesClassic);
