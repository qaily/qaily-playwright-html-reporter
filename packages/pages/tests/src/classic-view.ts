import type { PageContext, TestStatus } from '@qaily/contracts';
import { formatDateTime, formatDuration, formatPercent } from '@qaily/core';
import { LitElement, STATUS_COLOR, STATUS_GLYPH, baseStyles, css, elementView, html, nothing, styleMap, suiteBadge } from '@qaily/ui';
import './test-detail.ts';
import type { RunOption, SpecNode, TestItem, TestsModel } from './model.ts';

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
  };
  declare model: TestsModel;
  declare ctx: PageContext;
  declare status: StatusFilter;
  declare search: string;
  declare project: string;
  declare open: Set<string>;
  declare selected: string | null;

  private initialisedFor = '';

  constructor() {
    super();
    this.status = 'all';
    this.search = '';
    this.project = '';
    this.open = new Set();
    this.selected = null;
  }

  willUpdate(changed: Map<string, unknown>): void {
    if (!changed.has('model') || !this.model) return;
    const runId = this.model.current?.run.run_id ?? '';
    const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
    if (runId !== this.initialisedFor) {
      this.initialisedFor = runId;
      const fromUrl = params.get('status') as StatusFilter | null;
      this.status = fromUrl && FILTERS.includes(fromUrl) ? fromUrl : 'all';
      this.search = params.get('q') ?? '';
      // Specs with failures start expanded.
      this.open = new Set(this.model.specs.filter((s) => s.counts.failed || s.counts.flaky).map((s) => s.spec));
    }
    this.selected = params.get('test');
  }

  private syncUrl() {
    const p: Record<string, string> = {};
    if (this.model.current) p.run = this.model.current.run.run_id;
    if (this.status !== 'all') p.status = this.status;
    if (this.search) p.q = this.search;
    if (this.selected) p.test = this.selected;
    this.ctx.nav.replaceParams(p);
  }

  private select(testId: string | null) {
    this.selected = testId;
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

  private runHeader() {
    const m = this.model;
    const cur = m.current!;
    const r = cur.run;
    return html`<section class="card run">
      <div class="run-pick">
        <label>Run
          <select @change=${(e: Event) => this.ctx.nav.go('tests', { run: (e.target as HTMLSelectElement).value })}>
            ${m.runs.map((o) => html`<option value=${o.run.run_id} ?selected=${o === cur}>${this.runLabel(o)}</option>`)}
          </select>
        </label>
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
    return html`<div class="toolbar">
      <div class="chips" role="group" aria-label="Status filter">
        ${FILTERS.map((f) => {
          const n = f === 'all' ? m.tests.length : m.counts[f];
          return html`<button class=${this.status === f ? 'on' : ''} aria-pressed=${this.status === f}
            @click=${() => { this.status = f; this.syncUrl(); }}>
            ${f === 'all' ? nothing : html`<span style=${styleMap({ color: STATUS_COLOR[f] })}>${STATUS_GLYPH[f]}</span>`}
            ${f === 'all' ? 'All' : f[0].toUpperCase() + f.slice(1)} <b>${n}</b>
          </button>`;
        })}
      </div>
      <input type="search" placeholder="Search title, @tag, file, error…" .value=${this.search} aria-label="Search tests"
        @input=${(e: Event) => { this.search = (e.target as HTMLInputElement).value; this.syncUrl(); }} />
      ${m.projects.length > 1
        ? html`<select aria-label="Project" @change=${(e: Event) => (this.project = (e.target as HTMLSelectElement).value)}>
            <option value="">All projects</option>
            ${m.projects.map((p) => html`<option value=${p} ?selected=${p === this.project}>${p}</option>`)}
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

  private spec(node: SpecNode, tests: TestItem[]) {
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
      ${isOpen ? html`<ul class="tests">${tests.map((t) => this.testRow(t))}</ul>` : nothing}
    </section>`;
  }

  render() {
    const m = this.model;
    if (!m.current) return html`<q-state kind="empty" message="No runs in this range. Try a longer range or all branches."></q-state>`;
    const visible = m.specs.map((s) => ({ node: s, tests: s.tests.filter((t) => this.passesFilters(t)) })).filter((x) => x.tests.length);
    const selected = this.selected ? m.tests.find((t) => t.summary.test_id === this.selected) ?? null : null;
    const similar = selected?.issueKey ? m.tests.filter((t) => t !== selected && t.issueKey === selected.issueKey) : [];
    return html`
      ${this.runHeader()} ${this.toolbar()}
      ${visible.length ? visible.map((v) => this.spec(v.node, v.tests)) : html`<q-state kind="empty" message="No tests match these filters."></q-state>`}
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
    `,
  ];
}

export default elementView<TestsModel>('q-tests-classic', TestsClassic);
