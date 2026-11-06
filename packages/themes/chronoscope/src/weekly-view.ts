// Chronoscope carousel view for Weekly (layout after the Timeline view of the Observatory design): KPI row, the week's days
// on a curved 3D carousel, the Chronoscope chart, the selected day's runs and top problems, then the week's
// most failing / most flaky / slowest tests. The carousel and the chart share the selected day.

import type { DayProblem, PageContext, PeriodDay, PeriodKpis, TopTests, ViewModule } from '@qaily/contracts';
import type { CarouselCard } from './timeline/carousel.ts';
import { LitElement, html } from '@qaily/ui';
import { chronoData, chronoPanel, dayCard, dayRuns, defaultDay, fmtDate, sumrow, topProblems, topTests, weekdayLabel } from './timeline/panels.ts';
import { timelineStyles } from './timeline/styles.ts';

interface WeeklyLike {
  week: number;
  from: string;
  to: string;
  totalRuns: number;
  period: PeriodDay[];
  summary: PeriodKpis;
  top: TopTests;
  problems: Record<string, DayProblem[]>;
}

class ChronoWeek extends LitElement {
  static properties = { model: { attribute: false }, ctx: { attribute: false }, selected: { state: true } };
  declare model: WeeklyLike;
  declare ctx: PageContext;
  declare selected: number;
  private lastWeek: number | null = null;
  // Built once per model, not on every render (the carousel re-renders each animation frame).
  private cards: CarouselCard[] = [];
  private chart: ReturnType<typeof chronoData> = { days: [], runs: [] };

  constructor() {
    super();
    this.selected = 0;
  }

  willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('model') || changed.has('ctx')) {
      this.cards = this.model.period.map((d) => dayCard(d, this.ctx));
      this.chart = chronoData(this.model.period, this.ctx, weekdayLabel(this.ctx));
    }
    if (changed.has('model') && this.model.week !== this.lastWeek) {
      this.lastWeek = this.model.week;
      this.selected = defaultDay(this.model.period);
    }
  }

  render() {
    const m = this.model;
    const ctx = this.ctx;
    const day = m.period[this.selected];
    const last = new Date(new Date(m.to).getTime() - 1).toISOString();
    const d0 = fmtDate(m.from, ctx, { day: 'numeric', month: 'short' });
    const d1 = fmtDate(last, ctx, { day: 'numeric', month: 'short' });
    const branch = ctx.filters.branch === 'main' ? 'main builds' : 'all branches';
    return html`
      <div class="vhead">
        <div>
          <div class="eyebrow">${m.week === 0 ? 'This week' : m.week === -1 ? 'Last week' : `${-m.week} weeks ago`}</div>
          <h1 class="h1">Weekly <em>timeline</em></h1>
        </div>
        <div class="vright">
          <div class="runnav">
            <button class="btn" @click=${() => ctx.nav.go('weekly', { week: String(m.week - 1) })}>&#8592; Older</button>
            <button class="btn" ?disabled=${m.week >= 0}
              @click=${() => ctx.nav.go('weekly', m.week + 1 ? { week: String(m.week + 1) } : {})}>Newer &#8594;</button>
          </div>
          <div class="chips"><span class="chip"><b>${d0}</b> → <b>${d1}</b></span><span class="chip">${branch}</span></div>
        </div>
      </div>
      ${sumrow(m.summary, ctx)}
      <q-chrono-carousel .cards=${this.cards} .selected=${this.selected} ?reducedMotion=${ctx.theme.reducedMotion}
        @select=${(e: CustomEvent<number>) => (this.selected = e.detail)}></q-chrono-carousel>
      ${chronoPanel(this.chart, this.selected, (i) => (this.selected = i))}
      <div class="day-grid">${dayRuns(day, ctx)} ${topProblems(day, day && m.problems[day.key], ctx)}</div>
      ${topTests(m.top, ctx, m.summary.runs)}
    `;
  }

  static styles = timelineStyles;
}

const tag = 'q-chrono-week';
if (!customElements.get(tag)) customElements.define(tag, ChronoWeek);

const view: ViewModule<WeeklyLike> = {
  mount(host, model, ctx) {
    const el = document.createElement(tag) as ChronoWeek;
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
