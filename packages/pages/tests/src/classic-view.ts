import { rangeLabel, type PageContext, type TestStatus } from '@qaily/contracts';
import { formatDateTime, formatDuration, formatPercent, hasRunFilters } from '@qaily/core';
import { LitElement, STATUS_COLOR, STATUS_GLYPH, baseStyles, css, elementView, html, nothing, styleMap, suiteBadge, type TemplateResult } from '@qaily/ui';
import './test-detail.ts';
import { runTestItems, type RangeExecution, type RangeTest, type RangeView, type RunOption, type SpecNode, type TestItem, type TestsModel } from './model.ts';

type StatusFilter = 'all' | TestStatus;
const FILTERS: StatusFilter[] = ['all', 'failed', 'flaky', 'passed', 'skipped'];

class TestsClassic extends LitElement {
  static properties = {
    model: { attribute: false },
    ctx: { attribute: false },
    status: { state: true },
    search: { state: true },
    project: { state: true },
    open: { state: true },
    selected: { state: true },
    at: { state: true },
    exec: { state: true },
  };
  declare model: TestsModel;
  declare ctx: PageContext;
  declare status: StatusFilter;
  declare search: string;
  declare project: string;
  declare open: Set<string>;
  declare selected: string | null;
  /** All runs in range: the run whose execution of the selected test the drawer shows (null = pick a default). */
  declare at: string | null;
  /** All runs in range: the loaded details of that execution. */
  declare exec: { key: string; item: TestItem | null; similar: TestItem[]; error: string } | null;

  private initialisedFor = '';

  constructor() {
    super();
    this.status = 'all';
    this.search = '';
    this.project = '';
    this.open = new Set();
    this.selected = null;
    this.at = null;
    this.exec = null;
  }

  /** The run shown for a test in range scope: the one in the URL, else its newest failure, else its newest run. */
  private execRunOf(t: RangeTest): string | null {
    if (this.at && t.executions.some((e) => e.run_id === this.at)) return this.at;
    return (t.executions.find((e) => e.status === 'failed') ?? t.executions.find((e) => e.status === 'flaky') ?? t.executions[0])?.run_id ?? null;
  }

  /** Loads the full details (attempts, steps, errors, attachments) of one execution, from that run's files. */
  private async loadExec(runId: string, testId: string) {
    const key = `${runId}/${testId}`;
    if (this.exec?.key === key) return;
    this.exec = { key, item: null, similar: [], error: '' };
    try {
      const { tests } = runTestItems(await this.ctx.data.runDetail(runId));
      if (this.exec?.key !== key) return;
      const item = tests.find((t) => t.summary.test_id === testId) ?? null;
      const similar = item?.issueKey ? tests.filter((t) => t !== item && t.issueKey === item.issueKey) : [];
      this.exec = { key, item, similar, error: item ? '' : 'This test is not in the run’s files.' };
    } catch (err) {
      if (this.exec?.key === key) this.exec = { key, item: null, similar: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  updated(): void {
    const range = this.model?.scope === 'range' ? this.model.range : null;
    const t = range && this.selected ? range.tests.find((x) => x.test_id === this.selected) : null;
    const runId = t ? this.execRunOf(t) : null;
    if (t && runId) void this.loadExec(runId, t.test_id);
  }

  willUpdate(changed: Map<string, unknown>): void {
    if (!changed.has('model') || !this.model) return;
    const runId = this.model.current?.run.run_id ?? '';
    const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
    // A new run, scope or filter (range, lane, …) starts fresh; a refresh of the same view keeps what is open.
    const key = `${this.model.scope}:${runId}:${JSON.stringify(this.ctx?.filters ?? {})}`;
    if (key !== this.initialisedFor) {
      this.initialisedFor = key;
      const fromUrl = params.get('status') as StatusFilter | null;
      this.status = fromUrl && FILTERS.includes(fromUrl) ? fromUrl : 'all';
      this.search = params.get('q') ?? '';
      this.project = '';
      // Specs with failures start expanded.
      const specs = this.model.range?.specs ?? this.model.specs;
      this.open = new Set(specs.filter((s) => s.counts.failed || s.counts.flaky).map((s) => s.spec));
    }
    this.selected = params.get('test');
    this.at = params.get('at');
  }

  private syncUrl() {
    const p: Record<string, string> = {};
    if (this.model.scope === 'run' && this.model.current) p.run = this.model.current.run.run_id;
    if (this.status !== 'all') p.status = this.status;
    if (this.search) p.q = this.search;
    if (this.selected) p.test = this.selected;
    if (this.selected && this.at && this.model.scope === 'range') p.at = this.at;
    this.ctx.nav.replaceParams(p);
  }

  private select(testId: string | null) {
    this.selected = testId;
    this.at = null;
    this.syncUrl();
  }

  private showRun(runId: string) {
    this.at = runId;
    this.syncUrl();
  }

  private passesFilters(t: TestItem): boolean {
    if (this.status !== 'all' && t.summary.status !== this.status) return false;
    if (this.project && t.summary.project !== this.project) return false;
    const q = this.search.trim().toLowerCase();
    if (!q) return true;
    const s = t.summary;
    return (
      s.title.toLowerCase().includes(q) ||
      t.spec.toLowerCase().includes(q) ||
      s.tags.some((tag) => `@${tag}`.toLowerCase().includes(q.replace(/^@?/, '@'))) ||
      (s.err_summary ?? '').toLowerCase().includes(q) ||
      t.groups.some((g) => g.toLowerCase().includes(q))
    );
  }

  private runLabel(o: RunOption): string {
    const r = o.run;
    return `${formatDateTime(r.started_at, this.ctx.settings)} · ${r.tag ? `${r.tag} · ` : ''}${o.lane ?? r.category ?? '?'} · ${r.branch ?? ''} · ${o.run.ended_at ? formatPercent(o.rate, 0) : 'running'}`;
  }

  /** Scope: every run in the range (the default), or one run. */
  private scopePicker() {
    const m = this.model;
    const cur = m.current;
    return html`<label>Scope
      <select @change=${(e: Event) => {
        const v = (e.target as HTMLSelectElement).value;
        this.ctx.nav.go('tests', v ? { run: v } : {});
      }}>
        <option value="" ?selected=${m.scope === 'range'}>All runs in range${m.scope === 'range' ? ` (${m.runs.length})` : ''}</option>
        ${m.runs.map((o) => html`<option value=${o.run.run_id} ?selected=${o === cur}>${this.runLabel(o)}</option>`)}
      </select>
    </label>`;
  }

  private rangeHeader(range: RangeView) {
    const m = this.model;
    const failedRuns = m.runs.filter((o) => o.run.failed > 0).length;
    return html`<section class="card run">
      <div class="run-pick">${this.scopePicker()}</div>
      <div class="kpis">
        <div><b>${m.runs.length}</b><span class="muted">runs (${rangeLabel(this.ctx.filters.rangeDays).toLowerCase()})</span></div>
        <div><b>${failedRuns}</b><span class="muted">runs with failures</span></div>
        <div><b>${range.tests.length}</b><span class="muted">tests</span></div>
        <div><b>${range.counts.failed}</b><span class="muted">failed at least once</span></div>
        <div><b>${range.counts.flaky}</b><span class="muted">flaky, never failed</span></div>
      </div>
    </section>`;
  }

  private runHeader() {
    const m = this.model;
    const cur = m.current!;
    const r = cur.run;
    return html`<section class="card run">
      <div class="run-pick">
        ${this.scopePicker()}
        <q-health level=${cur.level} label=${cur.run.ended_at ? formatPercent(cur.rate) : 'running'}></q-health>
      </div>
      <div class="meta muted">
        ${suiteBadge(r.tag)}
        <span>${formatDateTime(r.started_at, this.ctx.settings)}</span>
        <span>${cur.lane ?? r.category ?? ''}</span>
        <span>${r.environment ?? ''}</span>
        <span>${r.branch ?? ''}</span>
        ${r.commit ? html`<span class="mono">${r.commit.slice(0, 7)}</span>` : nothing}
        <span>⏱ ${formatDuration(r.dur_ms)}</span>
        ${r.ci_url ? html`<a href=${r.ci_url} target="_blank" rel="noopener">CI run <q-icon name="external"></q-icon></a>` : nothing}
        <a href=${this.ctx.nav.href('issues', { run: r.run_id })}>Issues in this run</a>
      </div>
    </section>`;
  }

  private toolbar() {
    const m = this.model;
    const range = m.range;
    const total = range ? range.tests.length : m.tests.length;
    const counts = range ? range.counts : m.counts;
    const projects = range ? range.projects : m.projects;
    return html`<div class="toolbar">
      <div class="chips" role="group" aria-label="Status filter"
        title=${range ? 'Across runs, a test counts by its worst result: failed in any run, else flaky, else passed.' : nothing}>
        ${FILTERS.map((f) => {
          const n = f === 'all' ? total : counts[f];
          return html`<button class=${this.status === f ? 'on' : ''} aria-pressed=${this.status === f}
            @click=${() => { this.status = f; this.syncUrl(); }}>
            ${f === 'all' ? nothing : html`<span style=${styleMap({ color: STATUS_COLOR[f] })}>${STATUS_GLYPH[f]}</span>`}
            ${f === 'all' ? 'All' : f[0].toUpperCase() + f.slice(1)} <b>${n}</b>
          </button>`;
        })}
      </div>
      <input type="search" placeholder="Search title, @tag, file, error…" .value=${this.search} aria-label="Search tests"
        @input=${(e: Event) => { this.search = (e.target as HTMLInputElement).value; this.syncUrl(); }} />
      ${projects.length > 1
        ? html`<select aria-label="Project" @change=${(e: Event) => (this.project = (e.target as HTMLSelectElement).value)}>
            <option value="">All projects</option>
            ${projects.map((p) => html`<option value=${p} ?selected=${p === this.project}>${p}</option>`)}
          </select>`
        : nothing}
    </div>`;
  }

  private testRow(t: TestItem) {
    const s = t.summary;
    const hasNote = this.ctx.notes.get(`test:${s.test_id}`) !== '';
    return html`<li>
      <button class="test ${this.selected === s.test_id ? 'sel' : ''}" @click=${() => this.select(s.test_id)}>
        <span class="glyph" style=${styleMap({ color: STATUS_COLOR[s.status] })} title=${s.status}>${STATUS_GLYPH[s.status]}</span>
        <span class="title">
          ${s.title}
          ${t.groups.length ? html`<span class="muted group">${t.groups[t.groups.length - 1]}</span>` : nothing}
          ${s.status === 'failed' && s.err_summary ? html`<span class="err">${s.failed_step ? `${s.failed_step} — ` : ''}${s.err_summary}</span>` : nothing}
        </span>
        <span class="side muted">
          ${hasNote ? html`<span title="Has a note">✎</span>` : nothing}
          ${t.attempts.length > 1 ? html`<span title="Retries">↻${t.attempts.length - 1}</span>` : nothing}
          ${formatDuration(s.dur_ms)}
        </span>
      </button>
    </li>`;
  }

  private spec(node: Pick<SpecNode, 'spec' | 'counts'>, rows: () => TemplateResult[]) {
    const filtering = this.status !== 'all' || this.search !== '' || this.project !== '';
    const isOpen = filtering || this.open.has(node.spec);
    const toggle = () => {
      const next = new Set(this.open);
      if (next.has(node.spec)) next.delete(node.spec);
      else next.add(node.spec);
      this.open = next;
    };
    return html`<section class="card spec">
      <button class="spec-head" aria-expanded=${isOpen} @click=${toggle}>
        <span class="caret">${isOpen ? '▾' : '▸'}</span>
        <span class="mono name">${node.spec}</span>
        <span class="counts">
          ${(['failed', 'flaky', 'passed', 'skipped'] as TestStatus[]).map((st) =>
            node.counts[st] ? html`<span style=${styleMap({ color: STATUS_COLOR[st] })} title=${st}>${STATUS_GLYPH[st]} ${node.counts[st]}</span>` : nothing,
          )}
        </span>
      </button>
      ${isOpen ? html`<ul class="tests">${rows()}</ul>` : nothing}
    </section>`;
  }

  // --- All runs in range --------------------------------------------------------------------------------------

  private rangePasses(t: RangeTest): boolean {
    if (this.status !== 'all' && t.worst !== this.status) return false;
    if (this.project && t.project !== this.project) return false;
    const q = this.search.trim().toLowerCase();
    if (!q) return true;
    return (
      t.title.toLowerCase().includes(q) ||
      t.spec.toLowerCase().includes(q) ||
      t.tags.some((tag) => `@${tag}`.toLowerCase().includes(q.replace(/^@?/, '@'))) ||
      t.executions.some((e) => (e.err_summary ?? '').toLowerCase().includes(q))
    );
  }

  private runOf(runId: string): RunOption | undefined {
    return this.model.runs.find((o) => o.run.run_id === runId);
  }

  private execTitle(e: RangeExecution): string {
    const o = this.runOf(e.run_id);
    const where = o ? [o.lane ?? o.run.category, o.run.environment].filter(Boolean).join(' · ') : '';
    return `${formatDateTime(new Date(e.started_ms).toISOString(), this.ctx.settings)} · ${e.status}${where ? ` · ${where}` : ''}`;
  }

  /** One dot per run, oldest on the left; each opens the test's details in that run. */
  private dots(t: RangeTest) {
    const shown = t.executions.slice(0, 20).reverse();
    const open = this.selected === t.test_id ? this.execRunOf(t) : null;
    return html`<span class="dots">
      ${t.total > shown.length ? html`<span class="muted more">+${t.total - shown.length}</span>` : nothing}
      ${shown.map(
        (e) => html`<a class="dot ${e.run_id === open ? 'on' : ''}" href=${this.ctx.nav.href('tests', { test: t.test_id, at: e.run_id })}
          style=${styleMap({ background: STATUS_COLOR[e.status] })} title=${this.execTitle(e)} aria-label=${this.execTitle(e)}
          @click=${(ev: MouseEvent) => {
            if (ev.metaKey || ev.ctrlKey || ev.shiftKey) return; // let the browser open a new tab
            ev.preventDefault();
            this.selected = t.test_id;
            this.showRun(e.run_id);
          }}></a>`,
      )}
    </span>`;
  }

  private rangeRow(t: RangeTest) {
    const lastFail = t.executions.find((e) => e.status === 'failed');
    const executed = t.total - t.counts.skipped;
    return html`<li class="range-row">
      <button class="test ${this.selected === t.test_id ? 'sel' : ''}" @click=${() => this.select(t.test_id)}>
        <span class="glyph" style=${styleMap({ color: STATUS_COLOR[t.worst] })} title=${t.worst}>${STATUS_GLYPH[t.worst]}</span>
        <span class="title">
          ${t.title}
          ${lastFail?.err_summary ? html`<span class="err">${lastFail.failed_step ? `${lastFail.failed_step} — ` : ''}${lastFail.err_summary}</span>` : nothing}
        </span>
        <span class="side muted">
          ${t.counts.failed ? html`<span style=${styleMap({ color: STATUS_COLOR.failed })} title="Failed runs">✕${t.counts.failed}/${executed}</span>` : nothing}
          ${t.counts.flaky ? html`<span style=${styleMap({ color: STATUS_COLOR.flaky })} title="Flaky runs">~${t.counts.flaky}</span>` : nothing}
          ${!t.counts.failed && !t.counts.flaky ? html`<span title="Runs">${t.total} run${t.total === 1 ? '' : 's'}</span>` : nothing}
        </span>
      </button>
      ${this.dots(t)}
    </li>`;
  }

  /**
   * Drawer for a test in range scope: the full details of one of its runs (the newest failure by default), the
   * same as when one run is open, with a picker to switch between the test's runs.
   */
  private rangeDetail(t: RangeTest) {
    const runId = this.execRunOf(t);
    const run = runId ? this.runOf(runId)?.run : undefined;
    const exec = this.exec?.key === `${runId}/${t.test_id}` ? this.exec : null;
    const label = (e: RangeExecution) => {
      const o = this.runOf(e.run_id);
      const where = o ? [o.run.tag, o.lane ?? o.run.category, o.run.environment].filter(Boolean).join(' · ') : '';
      return `${STATUS_GLYPH[e.status]} ${formatDateTime(new Date(e.started_ms).toISOString(), this.ctx.settings)}${where ? ` · ${where}` : ''}`;
    };
    return html`<div class="exec-pick">
        <label>Run
          <select @change=${(e: Event) => this.showRun((e.target as HTMLSelectElement).value)} aria-label="Run of this test">
            ${t.executions.map((e) => html`<option value=${e.run_id} ?selected=${e.run_id === runId}>${label(e)}</option>`)}
          </select>
        </label>
        <span class="muted">
          ${(['failed', 'flaky', 'passed', 'skipped'] as TestStatus[]).map((st) =>
            t.counts[st] ? html`<span style=${styleMap({ color: STATUS_COLOR[st] })}>${STATUS_GLYPH[st]}${t.counts[st]}</span> ` : nothing,
          )}
          of ${t.total} run${t.total === 1 ? '' : 's'}
        </span>
        ${runId ? html`<a class="whole" href=${this.ctx.nav.href('tests', { run: runId, test: t.test_id })}>All tests of this run →</a>` : nothing}
      </div>
      ${!exec || (!exec.item && !exec.error)
        ? html`<q-state kind="loading"></q-state>`
        : exec.item
          ? html`<q-test-detail .item=${exec.item} .ctx=${this.ctx} .runId=${runId!} .suite=${run?.tag ?? null} .similar=${exec.similar}></q-test-detail>`
          : html`<q-state kind="error" message="Couldn't read this run's details: ${exec.error}"></q-state>`}`;
  }

  private renderRange(range: RangeView) {
    const m = this.model;
    if (!m.runs.length) {
      const message = hasRunFilters(this.ctx.filters)
        ? 'No runs match the Lane and Environment filters in this range. Clear them, or try a longer range or all branches.'
        : `No runs (${rangeLabel(this.ctx.filters.rangeDays).toLowerCase()}). Try a longer range or all branches.`;
      return html`<q-state kind="empty" message=${message}></q-state>`;
    }
    if (range.error) {
      return html`${this.rangeHeader(range)}
        <q-state kind="error" message="Couldn't read the tests of these runs: ${range.error}. Pick a single run in Scope instead."></q-state>`;
    }
    const visible = range.specs.map((s) => ({ node: s, tests: s.tests.filter((t) => this.rangePasses(t)) })).filter((x) => x.tests.length);
    const selected = this.selected ? range.tests.find((t) => t.test_id === this.selected) ?? null : null;
    return html`
      ${this.rangeHeader(range)} ${this.toolbar()}
      ${visible.length
        ? visible.map((v) => this.spec(v.node, () => v.tests.map((t) => this.rangeRow(t))))
        : html`<q-state kind="empty" message="No tests match these filters."></q-state>`}
      <q-drawer ?open=${!!selected} heading="Test details" @close=${() => this.select(null)}>
        ${selected ? this.rangeDetail(selected) : nothing}
      </q-drawer>
    `;
  }

  render() {
    const m = this.model;
    if (m.scope === 'range' && m.range) return this.renderRange(m.range);
    if (!m.current) {
      const message = hasRunFilters(this.ctx.filters)
        ? 'No runs match the Lane and Environment filters in this range. Clear them, or try a longer range or all branches.'
        : 'No runs in this range. Try a longer range or all branches.';
      return html`<q-state kind="empty" message=${message}></q-state>`;
    }
    const visible = m.specs.map((s) => ({ node: s, tests: s.tests.filter((t) => this.passesFilters(t)) })).filter((x) => x.tests.length);
    const selected = this.selected ? m.tests.find((t) => t.summary.test_id === this.selected) ?? null : null;
    const similar = selected?.issueKey ? m.tests.filter((t) => t !== selected && t.issueKey === selected.issueKey) : [];
    return html`
      ${this.runHeader()} ${this.toolbar()}
      ${visible.length
        ? visible.map((v) => this.spec(v.node, () => v.tests.map((t) => this.testRow(t))))
        : html`<q-state kind="empty" message="No tests match these filters."></q-state>`}
      <q-drawer ?open=${!!selected} heading="Test details" @close=${() => this.select(null)}>
        ${selected
          ? html`<q-test-detail .item=${selected} .ctx=${this.ctx} .runId=${m.current.run.run_id} .suite=${m.current.run.tag} .similar=${similar}></q-test-detail>`
          : nothing}
      </q-drawer>
    `;
  }

  static styles = [
    baseStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: 12px;
        max-width: 1400px;
        margin: 0 auto;
      }
      .run-pick {
        display: flex;
        gap: 12px;
        align-items: center;
        flex-wrap: wrap;
      }
      .run-pick label {
        display: flex;
        gap: 8px;
        align-items: center;
        font-weight: 600;
        min-width: 0;
      }
      .run-pick select {
        max-width: min(560px, 70vw);
      }
      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 14px;
        margin-top: 10px;
        font-size: 0.9rem;
      }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
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
      .spec {
        padding: 0;
        overflow: hidden;
      }
      .spec-head {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        border: none;
        border-radius: 0;
        background: none;
        text-align: left;
        padding: 10px 14px;
      }
      .spec-head .name {
        flex: 1;
        min-width: 0;
        overflow-wrap: anywhere;
        font-size: 0.85rem;
      }
      .counts {
        display: flex;
        gap: 10px;
        font-weight: 600;
        font-size: 0.85rem;
      }
      .tests {
        list-style: none;
        margin: 0;
        padding: 0;
        border-top: 1px solid var(--q-border);
      }
      .test {
        display: grid;
        grid-template-columns: 20px minmax(0, 1fr) auto;
        gap: 10px;
        width: 100%;
        text-align: left;
        border: none;
        border-radius: 0;
        border-bottom: 1px solid var(--q-border);
        background: none;
        padding: 8px 14px;
      }
      .test.sel {
        background: var(--q-surface-2);
        box-shadow: inset 3px 0 0 var(--q-accent);
      }
      .title {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .group {
        font-size: 0.8rem;
      }
      .err {
        font-family: var(--q-font-mono);
        font-size: 0.78rem;
        color: var(--q-fail);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .side {
        display: flex;
        gap: 10px;
        font-size: 0.85rem;
        white-space: nowrap;
      }
      .glyph {
        font-weight: 700;
      }
      .kpis {
        display: flex;
        gap: 20px;
        flex-wrap: wrap;
        margin-top: 10px;
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
      .range-row {
        display: flex;
        align-items: center;
        border-bottom: 1px solid var(--q-border);
      }
      .range-row .test {
        flex: 1;
        min-width: 0;
        border-bottom: none;
      }
      .dots {
        display: flex;
        align-items: center;
        gap: 3px;
        padding: 0 14px 0 4px;
        flex-shrink: 0;
      }
      .dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        display: inline-block;
      }
      .dot:hover {
        outline: 2px solid var(--q-text);
        outline-offset: 1px;
      }
      .more {
        font-size: 0.75rem;
        margin-right: 2px;
      }
      .dot.on {
        outline: 2px solid var(--q-accent);
        outline-offset: 1px;
      }
      .exec-pick {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 14px;
        align-items: center;
        margin-bottom: 12px;
        padding-bottom: 10px;
        border-bottom: 1px solid var(--q-border);
      }
      .exec-pick label {
        display: flex;
        gap: 8px;
        align-items: center;
        font-weight: 600;
        min-width: 0;
      }
      .exec-pick select {
        max-width: 100%;
      }
      .exec-pick .whole {
        margin-left: auto;
        font-size: 0.9rem;
      }
    `,
  ];
}

export default elementView<TestsModel>('q-tests-classic', TestsClassic);
