// Chronoscope carousel view for Monthly, built from the same Timeline parts as Weekly: the last twelve months on the 3D
// carousel (choosing one loads it), the chosen month's KPI row, a Chronoscope chart with one column per month (every
// execution as a dot inside its month, the monthly pass rate as the line), and the chosen month's most failing /
// most flaky / slowest tests.

import type { HealthLevel, PageContext, PeriodKpis, PeriodRun, TestStat, ViewModule } from '@qaily/contracts';
import { LitElement, html } from '@qaily/ui';
import type { CarouselCard } from './timeline/carousel.ts';
import { LEVEL_HUE, LEVEL_LABEL } from './timeline/chrono-math.ts';
import type { ChronoDay, ChronoRun } from './timeline/chrono-chart.ts';
import { chronoPanel, fmtDate, sumrow, topTests } from './timeline/panels.ts';
import { timelineStyles } from './timeline/styles.ts';

interface MonthCardLike {
  month: string;
  start: string;
  isCurrent: boolean;
  runs: number;
  rate: number | null;
  level: HealthLevel | 'none';
  failed: number;
  flaky: number;
  dayRates: (number | null)[];
  points: { x: number; run: PeriodRun }[];
}

interface MonthlyLike {
  month: string;
  isCurrent: boolean;
  start: string;
  summary: PeriodKpis;
  months: MonthCardLike[];
  topFailing: TestStat[];
  topFlaky: TestStat[];
  slowest: TestStat[];
  statsError: string | null;
}

function monthCard(c: MonthCardLike, ctx: PageContext): CarouselCard {
  const name = fmtDate(c.start, ctx, { month: 'long' });
  return {
    key: c.month,
    top: fmtDate(c.start, ctx, { year: 'numeric' }),
    status: c.isCurrent ? 'Live' : LEVEL_LABEL[c.level],
    date: fmtDate(c.start, ctx, { month: 'short' }),
    small: '',
    pct: c.rate,
    hue: LEVEL_HUE[c.level],
    bars: c.runs ? c.dayRates.map((r, i) => ({ pct: r, hue: LEVEL_HUE[r == null ? 'none' : ctx.health('passRate', r)], title: `${i + 1}: ${r == null ? 'no executions' : `${r.toFixed(1)}%`}` })) : [],
    runs: c.runs,
    failed: c.failed,
    flaky: c.flaky,
    label: `${name}: ${c.runs} executions`,
  };
}

/** The months chart: one column per carousel month, executions placed by start time within their month. */
function monthsChart(months: readonly MonthCardLike[], ctx: PageContext): { days: ChronoDay[]; runs: ChronoRun[] } {
  const tz = ctx.settings.display.timeZone === 'UTC' ? 'UTC' : undefined;
  const when = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz });
  return {
    days: months.map((c) => ({
      label: fmtDate(c.start, ctx, { month: 'short' }),
      rate: c.rate == null ? null : c.rate / 100,
      failed: c.failed,
      flaky: c.flaky,
      weekend: false,
    })),
    runs: months.flatMap((c, i) =>
      c.points
        .filter((p) => !p.run.running && p.run.rate != null)
        .map((p) => ({
          x: i + p.x,
          rate: p.run.rate! / 100,
          hue: LEVEL_HUE[p.run.level],
          title: `Execution ${when(p.run.run.started_at)} · ${p.run.laneLabel ?? p.run.run.category ?? ''} · ${p.run.run.tag ?? ''} · ${p.run.rate!.toFixed(1)}%`,
          href: ctx.nav.href('tests', { run: p.run.run.run_id }),
        })),
    ),
  };
}

class ChronoMonth extends LitElement {
  static properties = { model: { attribute: false }, ctx: { attribute: false } };
  declare model: MonthlyLike;
  declare ctx: PageContext;
  // Built once per model, not on every render.
  private cards: CarouselCard[] = [];
  private chart: { days: ChronoDay[]; runs: ChronoRun[] } = { days: [], runs: [] };

  willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('model') || changed.has('ctx')) {
      this.cards = this.model.months.map((c) => monthCard(c, this.ctx));
      this.chart = monthsChart(this.model.months, this.ctx);
    }
  }

  private go(month: string) {
    const current = this.model.months.find((c) => c.isCurrent)?.month;
    this.ctx.nav.go('monthly', month === current ? {} : { month });
  }

  render() {
    const m = this.model;
    const ctx = this.ctx;
    const monthIndex = m.months.findIndex((c) => c.month === m.month);
    const name = fmtDate(m.start, ctx, { month: 'long', year: 'numeric' });
    const branch = ctx.filters.branch === 'main' ? 'main builds' : 'all branches';
    return html`
      <div class="vhead">
        <div>
          <div class="eyebrow">${m.isCurrent ? 'This month' : name}</div>
          <h1 class="h1">Monthly <em>timeline</em></h1>
        </div>
        <div class="vright">
          <div class="runnav">
            <button class="btn" ?disabled=${monthIndex <= 0} @click=${() => this.go(m.months[monthIndex - 1].month)}>&#8592; Older</button>
            <button class="btn" ?disabled=${monthIndex >= m.months.length - 1}
              @click=${() => this.go(m.months[monthIndex + 1].month)}>Newer &#8594;</button>
          </div>
          <div class="chips"><span class="chip"><b>${name}</b></span><span class="chip">${branch}</span></div>
        </div>
      </div>
      <q-chrono-carousel .cards=${this.cards} .selected=${monthIndex} ?reducedMotion=${ctx.theme.reducedMotion}
        @select=${(e: CustomEvent<number>) => this.go(m.months[e.detail].month)}></q-chrono-carousel>
      ${sumrow(m.summary, ctx)}
      ${chronoPanel(this.chart, monthIndex, (i) => this.go(m.months[i].month), { unit: 'month' })}
      ${topTests({ topFailing: m.topFailing, topFlaky: m.topFlaky, slowest: m.slowest, statsError: m.statsError }, ctx, m.summary.runs)}
    `;
  }

  static styles = timelineStyles;
}

const tag = 'q-chrono-month';
if (!customElements.get(tag)) customElements.define(tag, ChronoMonth);

const view: ViewModule<MonthlyLike> = {
  mount(host, model, ctx) {
    const el = document.createElement(tag) as ChronoMonth;
    el.model = model;
    el.ctx = ctx;
    host.append(el);
    return {
      update(next, nextCtx) {
        el.ctx = nextCtx;
        el.model = next;
      },
      destroy() {
        el.remove();
      },
    };
  },
};

export default view;
