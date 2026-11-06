import type { CoverageCell, PageContext } from '@qaily/contracts';
import { formatDateTime, formatDuration, formatPercent } from '@qaily/core';
import { LitElement, STATUS_COLOR, STATUS_GLYPH, baseStyles, css, elementView, html, nothing, styleMap, type AnyStatus } from '@qaily/ui';
import { usableRules, cellDetailSql, ruleForTitle, type CellDetailRow } from './sql.ts';
import type { CellStat, HeatmapModel } from './model.ts';
import type { SheetComponent, SheetStat } from './sheet.ts';

const LAYOUT_KEY = 'qaily.heatmap.layout';

function savedLayout(): 'sheet' | 'grid' {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'grid' ? 'grid' : 'sheet';
  } catch {
    return 'sheet';
  }
}

class HeatmapClassic extends LitElement {
  static properties = {
    model: { attribute: false },
    ctx: { attribute: false },
    collapsed: { state: true },
    detail: { state: true },
    full: { state: true },
  };
  declare model: HeatmapModel;
  declare ctx: PageContext;
  declare collapsed: Set<string>;
  /** The map fills the window (big matrices are hard to read inside the page). */
  declare full: boolean;
  declare detail: { cell: CoverageCell; stat: CellStat; rows: CellDetailRow[] | null; error?: string } | null;

  constructor() {
    super();
    this.collapsed = new Set();
    this.detail = null;
    this.full = false;
  }

  private setFull(on: boolean) {
    this.full = on;
    if (on) this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>('.board')?.focus());
  }

  private layoutToggle() {
    return html`<div class="layout" role="group" aria-label="Layout">
      <button class=${this.layout === 'sheet' ? 'on' : ''} aria-pressed=${this.layout === 'sheet'} @click=${() => this.setLayout('sheet')}>Sheet</button>
      <button class=${this.layout === 'grid' ? 'on' : ''} aria-pressed=${this.layout === 'grid'} @click=${() => this.setLayout('grid')}>Grid</button>
    </div>`;
  }

  private params(extra: Record<string, string> = {}): Record<string, string> {
    const p: Record<string, string> = {};
    if (this.model.run) p.run = this.model.run.run_id;
    if (this.model.component) p.component = this.model.component;
    if (this.model.layout) p.layout = this.model.layout;
    return { ...p, ...extra };
  }

  private get layout(): 'sheet' | 'grid' {
    return this.model.layout ?? savedLayout();
  }

  private setLayout(layout: 'sheet' | 'grid') {
    try {
      localStorage.setItem(LAYOUT_KEY, layout);
    } catch {
      // Private mode: the URL still carries it.
    }
    this.ctx.nav.go('heatmap', this.params({ layout }));
  }

  private async openCell(feature: string, area: string, scenario: string, stat: CellStat | SheetStat, component = this.model.component!) {
    const cell = { component, scenario, feature, area };
    this.detail = { cell, stat, rows: null };
    if (!stat.hits) {
      this.detail = { cell, stat, rows: [] };
      return;
    }
    const range = this.model.run
      ? { from: new Date(Date.parse(this.model.run.started_at)), to: new Date(Date.parse(this.model.run.started_at) + 1) }
      : { from: new Date(this.model.scope.fromMs!), to: new Date(this.model.scope.toMs!) };
    try {
      const { rules } = usableRules(this.ctx.settings.coverage.rules);
      const rows = await this.ctx.data.query<CellDetailRow>(cellDetailSql(rules, this.model.scope, cell), range);
      if (this.detail?.cell === cell) this.detail = { ...this.detail, rows };
    } catch (err) {
      if (this.detail?.cell === cell) this.detail = { ...this.detail, rows: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  private cell(feature: string, area: string, scenario: string, stat: CellStat | undefined, total = false) {
    if (!stat) return html`<td class="empty" aria-label="Not planned, no hits"></td>`;
    const label = stat.hits
      ? `${this.model.levels[2]} ${feature} › ${this.model.levels[3]} ${area} · ${scenario}: ${stat.passed} of ${stat.hits} passed` +
        `${stat.flaky ? `, ${stat.flaky} flaky` : ''}${stat.unplanned ? ' · not in the catalog' : ''}`
      : `${feature} › ${area} · ${scenario}: planned, no hits`;
    // Few hits = less evidence: draw the colour fainter.
    const strength = stat.hits >= 5 ? 1 : 0.55 + stat.hits * 0.09;
    const cls = ['cell', `level-${stat.level}`, stat.hits ? '' : 'gap', stat.unplanned ? 'unplanned' : '', total ? 'total' : ''].join(' ');
    return html`<td>
      <button class=${cls} style=${styleMap({ '--strength': String(strength) })} title=${label} aria-label=${label}
        @click=${() => (total ? null : this.openCell(feature, area, scenario, stat))} ?disabled=${total}>
        ${stat.hits ? html`${stat.passed}/${stat.hits}${stat.flaky ? html` <span aria-hidden="true">⚠</span>` : nothing}` : '·'}
      </button>
    </td>`;
  }

  private matrix() {
    const m = this.model;
    const [, scenarioName, featureName, areaName] = m.levels;
    if (!m.features.length) return nothing;
    return html`<div class="card scroll">
      <table>
        <thead>
          <tr>
            <th scope="col" class="corner">${featureName} ▸ ${areaName} <span class="muted">/ ${scenarioName}</span></th>
            ${m.scenarios.map((s) => html`<th scope="col">${s}</th>`)}
          </tr>
        </thead>
        <tbody>
          ${m.features.map((f) => {
            const open = !this.collapsed.has(f.name);
            const toggle = () => {
              const next = new Set(this.collapsed);
              if (open) next.add(f.name);
              else next.delete(f.name);
              this.collapsed = next;
            };
            return html`<tr class="feature">
                <th scope="row"><button class="link" aria-expanded=${open} @click=${toggle}>${open ? '▾' : '▸'} ${f.name}</button></th>
                ${m.scenarios.map((s) => this.cell(f.name, '', s, f.totals[s], true))}
              </tr>
              ${open
                ? f.areas.map(
                    (a) => html`<tr>
                      <th scope="row" class="area">${a.name}</th>
                      ${m.scenarios.map((s) => this.cell(f.name, a.name, s, a.cells[s]))}
                    </tr>`,
                  )
                : nothing}`;
          })}
        </tbody>
      </table>
    </div>`;
  }

  private toggle(key: string) {
    const next = new Set(this.collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.collapsed = next;
  }

  /** The coverage cell at the end of a sheet row. */
  private sheetCell(component: string, scenario: string, feature: string, area: string, stat: SheetStat, total = false) {
    const planned = stat.planned && !stat.hits;
    const label = stat.hits
      ? `${stat.passed} of ${stat.hits} hits passed in ${stat.tests} test${stat.tests === 1 ? '' : 's'}${stat.flaky ? `, ${stat.flaky} flaky` : ''}` +
        `${stat.unplanned ? ' · not in the planned matrix' : ''}`
      : planned
        ? 'Planned, not covered'
        : 'No hits';
    const strength = stat.hits >= 5 ? 1 : 0.55 + stat.hits * 0.09;
    const cls = ['cell', `level-${stat.level}`, stat.hits ? '' : 'gap', stat.unplanned ? 'unplanned' : '', total ? 'total' : ''].join(' ');
    return html`<td class="cov">
      <button class=${cls} style=${styleMap({ '--strength': String(strength) })} title=${label} aria-label=${label} ?disabled=${total}
        @click=${() => (total ? null : this.openCell(feature, area, scenario, stat, component))}>
        ${stat.hits ? html`${stat.passed}/${stat.hits}${stat.flaky ? html` <span aria-hidden="true">⚠</span>` : nothing}` : planned ? 'not covered' : '·'}
      </button>
    </td>`;
  }

  private chip(planned: number, plannedHit: number, stat: SheetStat) {
    return html`<span class="sub">${planned ? `${plannedHit}/${planned} covered · ` : ''}${stat.hits} hits</span>`;
  }

  /** The planned matrix laid out like a spreadsheet: merged Component / Scenario / Feature, one row per Area. */
  private sheet() {
    const m = this.model;
    if (!m.sheet.length) return nothing;
    const [compL, scenL, featL, areaL] = m.levels;
    return html`<div class="card scroll sheet">
      <table>
        <thead>
          <tr><th class="c-comp">${compL}</th><th class="c-scen">${scenL}</th><th>${featL}</th><th>${areaL}</th><th class="cov">Coverage</th></tr>
        </thead>
        ${m.sheet.map((c) => this.sheetComponent(c))}
      </table>
    </div>`;
  }

  private sheetComponent(c: SheetComponent) {
    const cKey = `c:${c.name}`;
    const compCell = (rows: number) => html`<th scope="rowgroup" rowspan=${rows} class="c-comp">
      <button class="link vert" aria-expanded=${!this.collapsed.has(cKey)} @click=${() => this.toggle(cKey)}>${c.name}</button></th>`;
    if (this.collapsed.has(cKey)) {
      return html`<tbody class="comp"><tr>${compCell(1)}<td colspan="3" class="muted">${c.scenarios.length} scenarios · ${this.chip(c.planned, c.plannedHit, c.total)}</td>
        ${this.sheetCell(c.name, '', '', '', c.total, true)}</tr></tbody>`;
    }
    const rowsOf = (s: SheetComponent['scenarios'][number]) =>
      this.collapsed.has(`s:${c.name}/${s.name}`) ? 1 : s.features.reduce((n, f) => n + f.areas.length, 0);
    const total = c.scenarios.reduce((n, s) => n + rowsOf(s), 0);
    const out = [];
    let first = true;
    for (const s of c.scenarios) {
      const sKey = `s:${c.name}/${s.name}`;
      const scenCell = html`<th scope="rowgroup" rowspan=${rowsOf(s)} class="c-scen">
        <button class="link" aria-expanded=${!this.collapsed.has(sKey)} @click=${() => this.toggle(sKey)}>${s.name}</button>
        ${this.chip(s.planned, s.plannedHit, s.total)}</th>`;
      if (this.collapsed.has(sKey)) {
        out.push(html`<tr class=${first ? 'first' : ''}>${first ? compCell(total) : nothing}${scenCell}
          <td colspan="2" class="muted">${s.features.length} features</td>${this.sheetCell(c.name, s.name, '', '', s.total, true)}</tr>`);
        first = false;
        continue;
      }
      let firstOfScen = true;
      for (const f of s.features) {
        f.areas.forEach((a, i) => {
          out.push(html`<tr class=${[first ? 'first' : '', firstOfScen ? 'scen-start' : '', i === 0 ? 'feat-start' : ''].join(' ')}>
            ${first ? compCell(total) : nothing}${firstOfScen ? scenCell : nothing}
            ${i === 0
              ? html`<td rowspan=${f.areas.length} class="feat ${a.name === null && f.areas.length === 1 ? 'line' : ''}">${f.name}
                  ${f.areas.length > 1 ? html`<span class="sub">${f.total.hits} hits</span>` : nothing}</td>`
              : nothing}
            <td class="area">${a.name ?? ''}</td>
            ${this.sheetCell(c.name, s.name, f.name, a.key, a.stat)}
          </tr>`);
          first = false;
          firstOfScen = false;
        });
      }
    }
    return html`<tbody class="comp">${out}</tbody>`;
  }

  private legend() {
    const bands = this.ctx.settings.thresholds.coverageCell;
    const describe = (b: (typeof bands)[number]) =>
      b.min !== undefined && b.max !== undefined ? `${b.min}–${b.max}%` : b.min !== undefined ? `≥ ${b.min}%` : b.max !== undefined ? `≤ ${b.max}%` : 'other';
    return html`<div class="legend muted">
      ${bands.map((b) => html`<span><i class="swatch level-${b.level}"></i>${describe(b)} passed</span>`)}
      <span><i class="swatch gap"></i>planned, no hits</span>
      ${this.model.hasCatalog ? html`<span><i class="swatch unplanned"></i>hit but not in the catalog (typo?)</span>` : nothing}
      <span>⚠ flaky (passed on retry)</span>
      <span>faint = few hits</span>
      <span>Cells show passed/hits. When a step fails, the later steps of that test never run, so their cells show fewer hits, not failures.</span>
    </div>`;
  }

  private unmapped() {
    const list = this.model.unmapped;
    if (!list.length) return nothing;
    const copy = (title: string) => {
      const rule = { step: ruleForTitle(title), component: '', scenario: '', feature: '', area: '' };
      navigator.clipboard.writeText(JSON.stringify(rule, null, 2)).then(
        () => this.ctx.notify('Rule copied. Add it in Settings → Coverage heat map (For the team).'),
        () => this.ctx.notify('Could not copy', 'error'),
      );
    };
    return html`<details class="card unmapped" ?open=${this.model.ruleCount === 0}>
      <summary><b>Unmapped steps</b> <span class="muted">— the most common steps no rule or annotation maps yet</span></summary>
      <table>
        <thead><tr><th>Step</th><th class="num">Steps</th><th class="num">Tests</th><th></th></tr></thead>
        <tbody>
          ${list.map(
            (u) => html`<tr>
              <td class="mono">${u.title}</td><td class="num">${u.steps}</td><td class="num">${u.tests}</td>
              <td><button class="small" @click=${() => copy(u.title)}>Copy rule</button></td>
            </tr>`,
          )}
        </tbody>
      </table>
    </details>`;
  }

  private detailDrawer() {
    const d = this.detail;
    if (!d) return nothing;
    const c = d.cell;
    const [comp, scen, feat, area] = this.model.levels;
    return html`<q-drawer open heading="Coverage cell" @close=${() => (this.detail = null)}>
      <dl class="cellhead">
        <dt>${comp}</dt><dd>${c.component}</dd><dt>${scen}</dt><dd>${c.scenario}</dd>
        <dt>${feat}</dt><dd>${c.feature}</dd><dt>${area}</dt><dd>${c.area}</dd>
      </dl>
      <p>${d.stat.hits ? html`<b>${d.stat.passed}/${d.stat.hits}</b> passed (${formatPercent(d.stat.rate)})${d.stat.flaky ? `, ${d.stat.flaky} flaky` : ''}, ${d.stat.tests} test(s).` : 'Planned, but no test step hit this cell in the selected scope.'}</p>
      ${d.error ? html`<q-state kind="error" message=${d.error}></q-state>` : nothing}
      ${d.rows === null
        ? html`<q-state kind="loading"></q-state>`
        : html`<ul class="hits">
            ${d.rows.map((r) => {
              const status = (r.final_rank === 0 ? (r.flaky ? 'flaky' : 'passed') : 'failed') as AnyStatus;
              return html`<li>
                <div>
                  <span style=${styleMap({ color: STATUS_COLOR[status] })} title=${status}>${STATUS_GLYPH[status]}</span>
                  <a href=${this.ctx.nav.href('tests', { run: r.run_id, test: r.test_id })}>${r.test_title}</a>
                  <span class="muted small">${formatDateTime(new Date(r.started_ms), this.ctx.settings)}</span>
                </div>
                <ul class="steps">
                  ${r.steps.map(
                    (s) => html`<li><span style=${styleMap({ color: STATUS_COLOR[s.status as AnyStatus] ?? 'inherit' })}>${STATUS_GLYPH[s.status as AnyStatus] ?? '•'}</span>
                      <span class="muted small">step ${s.idx}</span> ${s.title} <span class="muted small">${formatDuration(s.dur_ms)}</span></li>`,
                  )}
                </ul>
              </li>`;
            })}
          </ul>`}
    </q-drawer>`;
  }

  render() {
    const m = this.model;
    const s = this.ctx.settings;
    const k = m.kpis;
    return html`
      <section class="card head">
        <label class="scope">Scope
          <select @change=${(e: Event) => {
            const v = (e.target as HTMLSelectElement).value;
            this.ctx.nav.go('heatmap', v ? { run: v } : {});
          }}>
            <option value="" ?selected=${!m.run}>All runs in range (${m.runs.length})</option>
            ${m.run && !m.runs.some((r) => r.run_id === m.run!.run_id)
              ? html`<option value=${m.run.run_id} selected>${formatDateTime(m.run.started_at, s)}</option>`
              : nothing}
            ${m.runs.map((r) => html`<option value=${r.run_id} ?selected=${m.run?.run_id === r.run_id}>
              ${formatDateTime(r.started_at, s)} · ${r.category ?? ''} ${r.environment ?? ''} · ${r.branch ?? ''}</option>`)}
          </select>
        </label>
        ${this.layoutToggle()}
        <button class="fs" @click=${() => this.setFull(true)} title="Show the map over the whole window (Esc to close)">
          <q-icon name="maximize"></q-icon> Full screen</button>
        ${this.layout === 'sheet'
          ? html`<div class="kpis">
              ${m.hasCatalog ? html`<div><b>${m.sheetKpis.plannedHit}/${m.sheetKpis.planned}</b><span class="muted">planned rows covered</span></div>` : nothing}
              <div><b>${m.sheetKpis.hits}</b><span class="muted">hits</span></div>
              <div><q-health level=${m.sheetKpis.level} label=${formatPercent(m.sheetKpis.passRate)}></q-health><span class="muted">passed</span></div>
            </div>`
          : html`<div class="kpis">
          <div><b>${k.cells}</b><span class="muted">cells hit</span></div>
          ${m.hasCatalog ? html`<div><b>${k.plannedHit}/${k.plannedCells}</b><span class="muted">planned cells hit</span></div>` : nothing}
          <div><b>${k.hits}</b><span class="muted">hits</span></div>
          <div><q-health level=${k.level} label=${formatPercent(k.passRate)}></q-health><span class="muted">passed</span></div>
          <div><b>${k.flakyCells}</b><span class="muted">cells with flaky hits</span></div>
        </div>`}
      </section>

      ${!m.stepsAvailable
        ? html`<q-state kind="empty" message="This data was built before the heat map existed. Run qaily-report build again to add step data."></q-state>`
        : nothing}
      ${m.ruleErrors.length
        ? html`<section class="card warn"><b>Some rules are ignored:</b><ul>${m.ruleErrors.map((e) => html`<li>${e}</li>`)}</ul>
            <a href=${this.ctx.nav.href('settings', { section: 'coverage' })}>Fix them in Settings</a></section>`
        : nothing}
      ${m.stepsAvailable && k.hits === 0 && m.ruleCount === 0
        ? html`<section class="card intro">
            <h2>No coverage yet</h2>
            <p>The heat map needs to know which part of the coverage matrix each test step exercises. Either:</p>
            <ul>
              <li><b>Add mapping rules</b> in <a href=${this.ctx.nav.href('settings', { section: 'coverage' })}>Settings → Coverage heat map</a>
                (team). They work on existing runs: use "Copy rule" below to start from real step titles.</li>
              <li><b>Label steps in tests</b> with step annotations (Playwright 1.58+), e.g. <code>coverage(step, { component, scenario, feature, area })</code>.</li>
            </ul>
            <p class="muted">Optional: put the planned matrix in <code>data/coverage-catalog.json</code> (<code>qaily-report catalog --csv matrix.csv</code>) to see gaps.</p>
          </section>`
        : nothing}

      ${this.layout === 'grid' && (m.components.length > 1 || (m.components.length && m.components[0] !== m.component))
        ? html`<div class="tabs" role="tablist" aria-label=${m.levels[0]}>
            ${m.components.map(
              (c) => html`<button role="tab" aria-selected=${c === m.component} class=${c === m.component ? 'on' : ''}
                @click=${() => this.ctx.nav.go('heatmap', this.params({ component: c }))}>${c}</button>`,
            )}
          </div>`
        : nothing}
      <div class="board ${this.full ? 'full' : ''}" tabindex="-1" role=${this.full ? 'dialog' : nothing} aria-label=${this.full ? 'Heat map' : nothing}
        @keydown=${(e: KeyboardEvent) => e.key === 'Escape' && this.full && !this.detail && this.setFull(false)}>
        ${this.full
          ? html`<div class="fullbar">
              <b>Heat map</b>
              ${this.layoutToggle()}
              ${this.layout === 'grid' && m.components.length > 1
                ? html`<div class="tabs" role="tablist" aria-label=${m.levels[0]}>
                    ${m.components.map(
                      (c) => html`<button role="tab" aria-selected=${c === m.component} class=${c === m.component ? 'on' : ''}
                        @click=${() => this.ctx.nav.go('heatmap', this.params({ component: c }))}>${c}</button>`,
                    )}
                  </div>`
                : nothing}
              <span class="grow"></span>
              <span class="muted">Esc to close</span>
              <button @click=${() => this.setFull(false)}><q-icon name="minimize"></q-icon> Exit full screen</button>
            </div>`
          : nothing}
        ${this.layout === 'grid'
          ? html`${m.component && !this.full ? html`<h2 class="component">${m.levels[0]}: ${m.component}</h2>` : nothing} ${this.matrix()}`
          : this.sheet()}
        ${m.features.length || m.sheet.length ? this.legend() : nothing}
      </div> ${this.unmapped()} ${this.detailDrawer()}
    `;
  }

  static styles = [
    baseStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: 12px;
        max-width: 1500px;
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
        max-width: min(480px, 75vw);
      }
      .kpis {
        display: flex;
        gap: 20px;
        flex-wrap: wrap;
      }
      .kpis div {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
      }
      .kpis b {
        font-size: 1.3rem;
        font-family: var(--q-font-display);
      }
      .kpis span {
        font-size: 0.8rem;
      }
      .warn {
        border-left: 4px solid var(--q-warn);
      }
      .intro h2 {
        font-size: 1.05rem;
        margin-bottom: 6px;
      }
      .tabs {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      .tabs button.on {
        border-color: var(--q-accent);
        box-shadow: inset 0 0 0 1px var(--q-accent);
      }
      .board:focus {
        outline: none;
      }
      /* Full screen: the map over the whole window, the table filling it. Below drawers (31), so a cell still opens. */
      .board.full {
        position: fixed;
        inset: 0;
        z-index: 30;
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 10px 16px 12px;
        background: var(--q-bg);
      }
      .board.full .scroll {
        flex: 1;
        max-height: none;
        min-height: 0;
      }
      .fullbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px;
      }
      .fullbar .grow {
        flex: 1;
      }
      .fullbar .tabs {
        margin: 0;
      }
      button.fs {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .layout {
        display: inline-flex;
        border: 1px solid var(--q-border);
        border-radius: 8px;
        overflow: hidden;
      }
      .layout button {
        border: 0;
        border-radius: 0;
        padding: 4px 12px;
        background: transparent;
      }
      .layout button.on {
        background: var(--q-accent);
        color: var(--q-on-accent);
      }
      /* Sheet layout: mirrors the planned-matrix spreadsheet. */
      .sheet tbody th {
        position: static;
        min-width: 0;
        max-width: none;
        vertical-align: middle;
        text-align: center;
        border-right: 1px solid var(--q-border);
      }
      .sheet th.c-comp {
        width: 44px;
      }
      /* Tall merged cells: keep the names in view while scrolling through their rows. */
      .sheet tbody th.c-comp,
      .sheet tbody th.c-scen {
        vertical-align: top;
      }
      .sheet tbody th.c-comp > button,
      .sheet tbody th.c-scen > :is(button, .sub) {
        position: sticky;
        top: 34px;
      }
      .sheet tbody th.c-scen > .sub {
        top: 56px;
      }
      .sheet th.c-scen {
        width: 26%;
        font-weight: 600;
      }
      .sheet .vert {
        writing-mode: vertical-rl;
        transform: rotate(180deg);
        font-size: 1rem;
      }
      .sheet td.feat {
        vertical-align: top;
        font-weight: 600;
        background: var(--q-surface-2);
        border-right: 1px solid var(--q-border);
        width: 30%;
      }
      .sheet td.feat.line {
        font-weight: 400;
      }
      .sheet td.area {
        width: 18%;
      }
      .sheet td.cov,
      .sheet th.cov {
        width: 150px;
      }
      .sheet tr.feat-start td {
        border-top: 1px solid var(--q-text-muted);
      }
      .sheet tr.scen-start td,
      .sheet tr.scen-start th.c-scen {
        border-top: 2px solid var(--q-text-muted);
      }
      .sheet tbody.comp + tbody.comp tr.first > * {
        border-top: 6px solid var(--q-text);
      }
      .sheet .sub {
        display: block;
        font-size: 0.72rem;
        font-weight: 400;
        color: var(--q-text-muted);
      }
      h2.component {
        font-size: 1.05rem;
      }
      .scroll {
        overflow: auto;
        padding: 0;
        max-height: 75vh;
      }
      table {
        border-collapse: separate;
        border-spacing: 0;
        width: 100%;
      }
      th,
      td {
        padding: 3px 4px;
        border-bottom: 1px solid var(--q-border);
        text-align: left;
        font-size: 0.85rem;
      }
      thead th {
        position: sticky;
        top: 0;
        background: var(--q-surface);
        z-index: 1;
        min-width: 84px;
        vertical-align: bottom;
        font-weight: 600;
      }
      tbody th {
        position: sticky;
        left: 0;
        background: var(--q-surface);
        font-weight: 500;
        min-width: 220px;
        max-width: 320px;
      }
      thead th.corner {
        left: 0;
        z-index: 2;
      }
      tr.feature th {
        font-weight: 700;
      }
      th.area {
        padding-left: 24px;
      }
      button.link {
        border: none;
        background: none;
        padding: 0;
        font-weight: 700;
        text-align: left;
      }
      .cell {
        width: 100%;
        min-width: 64px;
        padding: 4px 6px;
        border-radius: 4px;
        border: 1px solid transparent;
        background: color-mix(in srgb, var(--level) calc(var(--strength, 1) * 100%), var(--q-surface));
        color: var(--q-on-status);
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .cell:hover:not(:disabled) {
        background: color-mix(in srgb, var(--level) calc(var(--strength, 1) * 100%), var(--q-surface));
        filter: brightness(1.12);
      }
      .cell.total {
        opacity: 0.75;
        cursor: default;
      }
      .cell.total:disabled {
        opacity: 0.75;
      }
      .cell.gap {
        background: repeating-linear-gradient(45deg, var(--q-surface-2), var(--q-surface-2) 4px, var(--q-surface) 4px, var(--q-surface) 8px);
        color: var(--q-text-muted);
        border-color: var(--q-border);
      }
      .cell.unplanned {
        border: 2px dashed var(--q-text);
      }
      td.empty {
        background: transparent;
      }
      .legend {
        display: flex;
        flex-wrap: wrap;
        gap: 6px 16px;
        font-size: 0.82rem;
      }
      .swatch {
        display: inline-block;
        width: 14px;
        height: 14px;
        border-radius: 3px;
        margin-right: 4px;
        vertical-align: -2px;
        background: var(--level);
      }
      .swatch.gap {
        background: repeating-linear-gradient(45deg, var(--q-surface-2), var(--q-surface-2) 3px, var(--q-surface) 3px, var(--q-surface) 6px);
        border: 1px solid var(--q-border);
      }
      .swatch.unplanned {
        background: none;
        border: 2px dashed var(--q-text);
      }
      .unmapped summary {
        cursor: pointer;
      }
      .unmapped table {
        margin-top: 8px;
      }
      .num {
        text-align: right;
      }
      button.small {
        font-size: 0.78rem;
        padding: 2px 8px;
      }
      .cellhead {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 2px 12px;
        margin: 0 0 8px;
      }
      .cellhead dt {
        color: var(--q-text-muted);
      }
      .cellhead dd {
        margin: 0;
        font-weight: 600;
      }
      .hits {
        list-style: none;
        padding: 0;
        margin: 0;
      }
      .hits > li {
        border-top: 1px solid var(--q-border);
        padding: 8px 0;
      }
      .steps {
        list-style: none;
        margin: 4px 0 0 18px;
        padding: 0;
        font-size: 0.85rem;
      }
      .small {
        font-size: 0.8rem;
      }
    `,
  ];
}

export default elementView<HeatmapModel>('q-heatmap-classic', HeatmapClassic);
