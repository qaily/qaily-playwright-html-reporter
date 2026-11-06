import type { PageContext } from '@qaily/contracts';
import { formatDateTime, formatDuration, formatPercent, formatRelative, formatTime, formatDate } from '@qaily/core';
import { LitElement, LEVEL_GLYPH, baseStyles, css, elementView, html, nothing, suiteBadge } from '@qaily/ui';
import type { LaneCard, MonitoringModel, RunCard } from './model.ts';

class MonitoringClassic extends LitElement {
  static properties = { model: { attribute: false }, ctx: { attribute: false } };
  declare model: MonitoringModel;
  declare ctx: PageContext;

  private runTitle(c: RunCard): string {
    const r = c.run;
    return [
      `${formatDateTime(r.started_at, this.ctx.settings)} · ${r.branch ?? 'unknown branch'}`,
      `${r.category ?? ''} ${r.environment ?? ''} ${r.tag ?? ''}`.trim(),
      `Passed ${r.passed}, failed ${r.failed}, flaky ${r.flaky}, skipped ${r.skipped}`,
      `Duration ${formatDuration(r.dur_ms)}`,
    ].join('\n');
  }

  private latest(c: RunCard) {
    const r = c.run;
    const s = this.ctx.settings;
    const body = html`
      <div class="when">
        <strong>${formatDate(r.started_at, s)} ${formatTime(r.started_at, s)}</strong>
        <span>${formatRelative(r.started_at, this.ctx.now())}</span>
      </div>
      <div class="meta">${suiteBadge(r.tag)} ${r.branch ?? '–'} ${r.commit ? html`· <span class="mono">${r.commit.slice(0, 7)}</span>` : nothing}
        ${this.model.aiRuns.has(r.run_id) ? html`· <span title="Has AI analysis">✨ AI</span>` : nothing}</div>
      <div class="score">
        <span class="glyph" aria-hidden="true">${c.running ? '◌' : LEVEL_GLYPH[c.level]}</span>
        ${c.running ? 'Running' : html`${formatPercent(c.rate)} <small>${r.passed + r.flaky}/${r.total - r.skipped}</small>`}
      </div>
    `;
    const cls = `latest level-${c.level} ${c.running ? 'running' : ''}`;
    return html`<a class=${cls} href=${this.ctx.nav.href('tests', { run: r.run_id })} title=${this.runTitle(c)}>${body}</a>`;
  }

  private chip(c: RunCard) {
    const r = c.run;
    const s = this.ctx.settings;
    const label = html`<span>${this.model.aiRuns.has(r.run_id) ? '✨ ' : ''}${formatDate(r.started_at, s, { month: '2-digit', day: '2-digit' })} ${formatTime(r.started_at, s)}${r.tag ? html`<span class="suite-t">${r.tag}</span>` : nothing}</span>
      <b>${c.running ? '◌' : formatPercent(c.rate, 0)}</b>`;
    return html`<a class="chip level-${c.level}" href=${this.ctx.nav.href('tests', { run: r.run_id })} title=${this.runTitle(c)}>${label}</a>`;
  }

  private lane(l: LaneCard) {
    return html`<section class="card lane">
      <header>
        <h2>${l.label}</h2>
        <q-health level=${l.level} label=${formatPercent(l.rate)} title="Pass rate over ${l.runCount} runs"></q-health>
      </header>
      ${l.latest ? this.latest(l.latest) : html`<p class="muted empty">No runs in this range</p>`}
      ${l.history.length ? html`<div class="history">${l.history.map((c) => this.chip(c))}</div>` : nothing}
    </section>`;
  }

  render() {
    const m = this.model;
    if (!m.totalRuns) {
      return html`<q-state kind="empty" message="No runs in the last ${m.rangeDays} day(s) for this branch filter."></q-state>`;
    }
    return html`<div class="grid">${m.lanes.map((l) => this.lane(l))}</div>`;
  }

  static styles = [
    baseStyles,
    css`
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(min(100%, 380px), 1fr));
        gap: 16px;
        max-width: 1400px;
        margin: 0 auto;
      }
      .lane header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
      }
      h2 {
        font-size: 1.1rem;
      }
      .latest {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 4px 12px;
        padding: 14px;
        border-radius: var(--q-radius);
        background: var(--level);
        color: var(--q-on-status);
        text-decoration: none;
        transition: transform 0.15s;
      }
      .latest:hover {
        transform: translateY(-2px);
      }
      :host-context([data-reduced-motion]) .latest:hover {
        transform: none;
      }
      .latest.running {
        background: var(--q-running);
      }
      .when {
        display: flex;
        gap: 8px;
        align-items: baseline;
        flex-wrap: wrap;
      }
      .when span,
      .meta {
        opacity: 0.9;
        font-size: 0.85rem;
      }
      .meta {
        grid-column: 1;
      }
      .score {
        grid-column: 2;
        grid-row: 1 / span 2;
        align-self: center;
        font-size: 1.4rem;
        font-weight: 700;
        text-align: right;
      }
      .score small {
        display: block;
        font-size: 0.75rem;
        font-weight: 500;
        opacity: 0.9;
      }
      .glyph {
        margin-right: 4px;
      }
      .history {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
        gap: 6px;
        margin-top: 10px;
      }
      .chip .suite-t {
        display: block;
        opacity: 0.85;
        font-size: 0.66rem;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .chip > span {
        min-width: 0;
      }
      .chip {
        display: flex;
        justify-content: space-between;
        align-items: center;
        min-width: 0;
        gap: 6px;
        padding: 6px 8px;
        border-radius: calc(var(--q-radius) * 0.6);
        background: var(--level);
        color: var(--q-on-status);
        font-size: 0.75rem;
        text-decoration: none;
        white-space: nowrap;
      }
      .empty {
        margin: 0;
        padding: 14px 0;
      }
    `,
  ];
}

export default elementView<MonitoringModel>('q-monitoring-classic', MonitoringClassic);
