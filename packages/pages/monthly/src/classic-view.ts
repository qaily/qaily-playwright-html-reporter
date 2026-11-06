import type { PageContext } from '@qaily/contracts';
import { formatDate, formatDuration, formatNumber, formatPercent } from '@qaily/core';
import { LEVEL_GLYPH, LitElement, SERIES_COLORS, baseStyles, css, elementView, html, nothing, suiteBadges, type ChartSeries } from '@qaily/ui';
import { shiftMonth, type DayCell, type MonthlyModel, type TestStat } from './model.ts';

const LEVEL_COLOR = { good: 'var(--q-good)', warn: 'var(--q-warn)', bad: 'var(--q-bad)' } as const;

class MonthlyClassic extends LitElement {
  static properties = { model: { attribute: false }, ctx: { attribute: false } };
  declare model: MonthlyModel;
  declare ctx: PageContext;

  private goMonth(month: string | null) {
    this.ctx.nav.go('monthly', month ? { month } : {});
  }

  private kpi(label: string, value: unknown, sub?: unknown) {
    return html`<div class="card kpi"><span class="muted">${label}</span><b>${value}</b>${sub ? html`<span class="sub">${sub}</span>` : nothing}</div>`;
  }

  private day(c: DayCell) {
    const s = this.ctx.settings;
    if (!c.inMonth) return html`<div class="day out" aria-hidden="true"></div>`;
    const label = `${formatDate(c.date, s, { weekday: 'long', month: 'long', day: 'numeric' })}: ${c.runs ? `${formatPercent(c.rate)} over ${c.runs} runs` : 'no runs'}`;
    return html`<a class="day level-${c.level} ${c.runs ? 'has' : ''} ${c.isFuture ? 'future' : ''}"
      href=${this.ctx.nav.href('weekly', c.weekOffset ? { week: String(c.weekOffset) } : {})} title=${label} aria-label=${label}>
      <span class="num">${Number(c.key.slice(8))}</span>
      ${c.runs ? html`<span class="rate">${LEVEL_GLYPH[c.level]} ${formatPercent(c.rate, 0)}</span><span class="runs">${c.runs} runs</span>` : nothing}
    </a>`;
  }

  private table(title: string, rows: TestStat[], value: (r: TestStat) => unknown, valueLabel: string) {
    return html`<section class="card list">
      <h2>${title}</h2>
      ${rows.length
        ? html`<table>
            <thead><tr><th>Test</th><th class="num">${valueLabel}</th></tr></thead>
            <tbody>
              ${rows.map(
                (r) => html`<tr>
                  <td><a href=${this.ctx.nav.href('tests', { run: r.last_run_id, test: r.test_id })}>${r.title}</a> ${suiteBadges(r.suites)}
                    <div class="muted small">ran in ${Number(r.execs)} of ${this.model.kpis.runs} executions</div></td>
                  <td class="num">${value(r)}</td>
                </tr>`,
              )}
            </tbody>
          </table>`
        : html`<p class="muted">Nothing to show.</p>`}
    </section>`;
  }

  render() {
    const m = this.model;
    const s = this.ctx.settings;
    const k = m.kpis;
    const weekdays = m.weeks[0]?.map((c) => formatDate(c.date, s, { weekday: 'short' })) ?? [];
    const bands = s.thresholds.passRate
      .filter((b) => b.level !== undefined)
      .map((b) => ({ from: b.min ?? 0, to: b.max ?? 100, color: LEVEL_COLOR[b.level] }));
    const series: ChartSeries[] = [
      ...m.trend.map((t, i) => ({ label: t.label, color: SERIES_COLORS[i % SERIES_COLORS.length], values: t.values })),
      { label: 'All lanes', color: 'var(--q-text)', values: m.overall },
    ];
    const monthTitle = formatDate(m.start, s, { month: 'long', year: 'numeric' });
    return html`
      <div class="bar">
        <button @click=${() => this.goMonth(shiftMonth(m.month, -1))} aria-label="Previous month"><q-icon name="chevronLeft"></q-icon></button>
        <h1>${monthTitle}</h1>
        <button @click=${() => this.goMonth(shiftMonth(m.month, 1))} ?disabled=${m.isCurrent} aria-label="Next month"><q-icon name="chevronRight"></q-icon></button>
        ${m.isCurrent ? nothing : html`<button @click=${() => this.goMonth(null)}>This month</button>`}
      </div>

      <div class="kpis">
        ${this.kpi('Pass rate', html`<q-health level=${k.passLevel} label=${formatPercent(k.passRate)}></q-health>`)}
        ${this.kpi('Flaky rate', html`<q-health level=${k.flakyLevel} label=${formatPercent(k.flakyRate)}></q-health>`)}
        ${this.kpi('Executions', formatNumber(k.runs))}
        ${this.kpi('Test runs', formatNumber(k.executed))}
        ${this.kpi('Failed test runs', formatNumber(k.failed))}
        ${this.kpi('Worst day', k.worstDay ? formatDate(k.worstDay.date, s) : '–', k.worstDay ? formatPercent(k.worstDay.rate) : undefined)}
      </div>

      <div class="cols">
        <section class="card">
          <h2>Calendar</h2>
          <div class="calendar" role="grid" aria-label="Pass rate per day">
            ${weekdays.map((w) => html`<div class="wd muted" role="columnheader">${w}</div>`)}
            ${m.weeks.flat().map((c) => this.day(c))}
          </div>
        </section>
        <section class="card">
          <h2>Pass rate per day</h2>
          ${m.overall.some((v) => v != null)
            ? html`<q-line-chart .labels=${m.dayLabels} .series=${series} .bands=${bands}></q-line-chart>`
            : html`<p class="muted">No finished executions this month.</p>`}
        </section>
      </div>

      ${m.statsError ? html`<q-state kind="error" message="Test statistics unavailable: ${m.statsError}"></q-state>` : nothing}
      <div class="lists">
        ${this.table('Most failing tests', m.topFailing, (r) => `${r.failed} / ${r.runs}`, 'Failed / test runs')}
        ${this.table('Most flaky tests', m.topFlaky, (r) => `${r.flaky} / ${r.runs}`, 'Flaky / test runs')}
        ${this.table('Slowest tests', m.slowest, (r) => formatDuration(r.avg_ms), 'Avg duration')}
      </div>
    `;
  }

  static styles = [
    baseStyles,
    css`
      .small {
        font-size: 0.78rem;
      }
      :host {
        display: flex;
        flex-direction: column;
        gap: 16px;
        max-width: 1400px;
        margin: 0 auto;
      }
      .bar {
        display: flex;
        gap: 12px;
        align-items: center;
      }
      h1 {
        font-size: 1.2rem;
      }
      h2 {
        font-size: 1rem;
        margin-bottom: 12px;
      }
      .kpis {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
        gap: 12px;
      }
      .kpi {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .kpi b {
        font-family: var(--q-font-display);
        font-size: 1.5rem;
      }
      .kpi .sub {
        color: var(--q-text-muted);
        font-size: 0.85rem;
      }
      .cols {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
        gap: 16px;
      }
      .calendar {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        gap: 4px;
      }
      .wd {
        text-align: center;
        font-size: 0.8rem;
      }
      .day {
        min-height: 64px;
        border-radius: calc(var(--q-radius) * 0.6);
        border: 1px solid var(--q-border);
        padding: 4px 6px;
        display: flex;
        flex-direction: column;
        text-decoration: none;
        color: var(--q-text);
        font-size: 0.75rem;
      }
      .day.out {
        border: none;
      }
      .day.has {
        background: var(--level);
        color: var(--q-on-status);
        border-color: transparent;
      }
      .day.future {
        opacity: 0.4;
      }
      .day .num {
        font-weight: 600;
      }
      .day .rate {
        font-weight: 700;
        font-size: 0.85rem;
        margin-top: auto;
      }
      .lists {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr));
        gap: 16px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.88rem;
      }
      th {
        text-align: left;
        color: var(--q-text-muted);
        font-weight: 500;
      }
      td,
      th {
        padding: 6px 4px;
        border-bottom: 1px solid var(--q-border);
        vertical-align: top;
      }
      .num {
        text-align: right;
        white-space: nowrap;
      }
      @media (max-width: 900px) {
        .cols {
          grid-template-columns: 1fr;
        }
      }
    `,
  ];
}

export default elementView<MonthlyModel>('q-monthly-classic', MonthlyClassic);
