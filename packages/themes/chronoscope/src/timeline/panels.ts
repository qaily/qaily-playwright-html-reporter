// Templates of the Timeline view (after the Observatory design) (renderTimelineHeader / renderChrono legend /
// renderDay / "Most flaky" list), filled from the period models Weekly and Monthly build.

import type { DayProblem, PageContext, PeriodDay, PeriodKpis, PeriodRun, TestStat, TopTests } from '@qaily/contracts';
import { html, nothing, styleMap, suiteBadge, suiteBadges } from '@qaily/ui';
import type { CarouselCard } from './carousel.ts';
import type { ChronoDay, ChronoRun } from './chrono-chart.ts';
import { LEVEL_HUE, LEVEL_LABEL } from './chrono-math.ts';
import './carousel.ts';
import './chrono-chart.ts';

const COL = { passed: 'var(--pass)', failed: 'var(--fail)', flaky: 'var(--flaky)', skipped: 'var(--skip)' };

export const zone = (ctx: PageContext) => (ctx.settings.display.timeZone === 'UTC' ? 'UTC' : undefined);
export const fmtDate = (iso: string, ctx: PageContext, o: Intl.DateTimeFormatOptions) =>
  new Date(iso).toLocaleDateString(undefined, { ...o, timeZone: zone(ctx) });
const fmtH = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;
const pct = (v: number | null) => (v == null ? '–' : v.toFixed(1));
const fmtDur = (ms: number) => {
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
};
/** Repo-relative spec path: drops a CI runner checkout prefix (/runner/_work/<repo>/<repo>/). */
const specPath = (file: string) => file.replace(/^.*?\/_work\/[^/]+\/[^/]+\//, '');
const short = (iso: string, ctx: PageContext) =>
  `${fmtDate(iso, ctx, { weekday: 'short' }).slice(0, 2)} ${fmtDate(iso, ctx, { day: 'numeric' })}`;

// Wording: an "execution" is one CI run (EXEC #n on the dials); a "test run" is one test's result in it.

/** Chart data per day; executions still running have no pass rate yet and are left out. */
export function chronoData(days: readonly PeriodDay[], ctx: PageContext, labelOf: (d: PeriodDay, i: number) => string) {
  const chronoDays: ChronoDay[] = days.map((d, i) => ({
    label: labelOf(d, i),
    rate: d.rate == null ? null : d.rate / 100,
    failed: d.failed,
    flaky: d.flaky,
    weekend: d.isWeekend,
  }));
  const runs: ChronoRun[] = days.flatMap((d, i) =>
    d.runs
      .filter((r) => r.rate != null && !r.running)
      .map((r) => ({
        x: i + r.hour / 24,
        rate: r.rate! / 100,
        hue: LEVEL_HUE[r.level],
        title: `Execution ${fmtH(r.hour)} · ${r.laneLabel ?? r.run.category ?? ''} · ${r.run.tag ?? ''} · ${pct(r.rate)}%`,
        href: ctx.nav.href('tests', { run: r.run.run_id }),
      })),
  );
  return { days: chronoDays, runs };
}

export const weekdayLabel = (ctx: PageContext) => (d: PeriodDay) => (d.isToday ? 'Today' : short(d.start, ctx));

/** A day as a carousel card (buildCarousel). */
export function dayCard(d: PeriodDay, ctx: PageContext): CarouselCard {
  return {
    key: d.key,
    top: d.isToday ? 'Today' : fmtDate(d.start, ctx, { weekday: 'short' }),
    status: d.isToday && d.runs.some((r) => r.running) ? 'Live' : LEVEL_LABEL[d.level],
    date: fmtDate(d.start, ctx, { day: 'numeric' }),
    small: fmtDate(d.start, ctx, { month: 'short' }),
    pct: d.rate,
    hue: LEVEL_HUE[d.level],
    bars: d.runs.map((r) => ({ pct: r.running ? null : r.rate, hue: LEVEL_HUE[r.level], title: `Execution at ${fmtH(r.hour)} ${r.run.tag ?? ''}` })),
    runs: d.runs.length,
    failed: d.failed,
    flaky: d.flaky,
    future: d.isFuture,
    label: `${fmtDate(d.start, ctx, { weekday: 'long', day: 'numeric', month: 'long' })}: ${d.runs.length} executions`,
  };
}

export function sumrow(k: PeriodKpis, ctx: PageContext) {
  const worst = k.worstDay ? `${short(k.worstDay.start, ctx)} · ${pct(k.worstDay.rate)}%` : '–';
  const items: [string, string, string][] = [
    ['Pass rate', k.passRate == null ? '–' : `${pct(k.passRate)}%`, ''],
    ['Executions', String(k.runs), ''],
    ['Test runs', k.executed.toLocaleString('en-US'), ''],
    ['Failed test runs', String(k.failed), 'c-fail'],
    ['Worst day', worst, 'c-flaky'],
  ];
  return html`<div class="sumrow">
    ${items.map(
      ([key, v, c]) => html`<div class="ctr"><div class="k">${key}</div>
        <div class="v ${c}" style=${styleMap({ fontSize: v.length > 10 ? '15px' : '22px' })}>${v}</div></div>`,
    )}
  </div>`;
}

export interface ChronoPanelText {
  /** What one column is ('day' | 'month'), for the legend and the chart's label. */
  unit: 'day' | 'month';
}

export function chronoPanel(
  data: { days: ChronoDay[]; runs: ChronoRun[] },
  selected: number,
  onSelect: (i: number) => void,
  { unit }: ChronoPanelText = { unit: 'day' },
) {
  return html`<div class="panel">
    <div class="ptitle"><span class="l">Chronoscope</span>
      <span class="chrono-leg">
        <span><i style="background:var(--ice)"></i>${unit === 'day' ? 'each execution, at the hour it ran' : 'each execution, in its month'}</span>
        <span><i style="background:transparent;border:2px solid var(--ice);width:12px;height:2px;border-radius:0;border-width:2px 0 0"></i>${unit === 'day' ? 'daily' : 'monthly'} pass rate</span>
        <span><i style="background:var(--fail);border-radius:2px"></i>failed</span>
        <span><i style="background:var(--flaky);border-radius:2px"></i>flaky</span>
      </span>
    </div>
    <q-chrono-chart .days=${data.days} .runs=${data.runs} .selected=${selected} unit=${unit}
      @select=${(e: CustomEvent<number>) => onSelect(e.detail)}></q-chrono-chart>
  </div>`;
}

function stackBar(r: PeriodRun) {
  const c = r.run;
  const t = c.passed + c.failed + c.flaky + c.skipped || 1;
  return html`<span class="stack">${(['passed', 'flaky', 'failed', 'skipped'] as const).map(
    (s) => html`<i style=${styleMap({ width: `${(c[s] / t) * 100}%`, background: COL[s] })}></i>`,
  )}</span>`;
}

/** The selected day's executions: a 24-hour heat strip (worst per hour) and one row per execution. */
export function dayRuns(d: PeriodDay | undefined, ctx: PageContext) {
  if (!d) return html`<div class="panel"><div class="empty">No day selected.</div></div>`;
  const heat: (PeriodRun | null)[] = Array(24).fill(null);
  for (const r of d.runs) {
    if (r.rate == null) continue;
    const h = Math.floor(r.hour);
    if (!heat[h] || heat[h]!.rate! > r.rate) heat[h] = r;
  }
  const title = fmtDate(d.start, ctx, { weekday: 'short', day: 'numeric', month: 'short' });
  return html`<div class="panel">
    <div class="ptitle"><span class="l">${title} · executions</span><span class="n">${d.runs.length} executions · ${d.executed.toLocaleString('en-US')} test runs</span></div>
    <div class="heat">${heat.map((r) => {
      if (!r) return html`<i></i>`;
      const h = LEVEL_HUE[r.level];
      return html`<i title="${fmtH(r.hour)} · ${pct(r.rate)}%"
        style=${styleMap({ background: `hsl(${h} 100% 60%)`, boxShadow: `0 0 10px -2px hsl(${h} 100% 60%)` })}></i>`;
    })}</div>
    <div class="heat-ax"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
    <div class="runrows">
      ${d.runs.length
        ? [...d.runs].reverse().map((r) => {
            const h = LEVEL_HUE[r.level];
            return html`<a class="runrow" href=${ctx.nav.href('tests', { run: r.run.run_id })}>
              <span class="t tab">${fmtH(r.hour)}</span>
              <span class="tg">${suiteBadge(r.run.tag)} ${r.laneLabel ?? r.run.category ?? ''}</span>
              <span class="br">${[r.run.branch, r.run.commit?.slice(0, 7), r.run.environment].filter(Boolean).join(' · ')}</span>
              ${stackBar(r)}
              <span class="pc tab" style=${styleMap({ color: r.running ? 'var(--run)' : `hsl(${h} 100% 70%)` })}>${r.running ? 'running' : `${pct(r.rate)}%`}</span>
            </a>`;
          })
        : html`<div class="empty">No executions on this day.</div>`}
    </div>
  </div>`;
}

export function topProblems(d: PeriodDay | undefined, problems: DayProblem[] | undefined, ctx: PageContext) {
  const list = problems ?? [];
  return html`<div class="panel">
    <div class="ptitle"><span class="l">Top problems</span><span class="n">${d?.failed ?? 0} failed · ${d?.flaky ?? 0} flaky</span></div>
    ${list.length
      ? list.map((p) => {
          const c = p.failed ? COL.failed : COL.flaky;
          return html`<a class="frow" href=${ctx.nav.href('tests', { run: p.last_run_id, test: p.test_id })}>
            <span class="dot" style=${styleMap({ background: c, boxShadow: `0 0 10px ${c}` })}></span>
            <span style="min-width:0">
              <span class="ft" style="display:block">${p.title}</span>
              <span class="fs" style="display:block">${suiteBadges(p.suites)} ${specPath(p.file)} · ${p.project}</span>
            </span>
            <span class="fc">${p.failed ? html`<span class="c-fail">${p.failed}✕</span> ` : nothing}${p.flaky
              ? html`<span class="c-flaky">${p.flaky}↻</span>`
              : nothing}</span>
          </a>`;
        })
      : html`<div class="empty">${d?.runs.length ? 'Clean day. Every test passed on the first attempt.' : 'No executions on this day.'}</div>`}
  </div>`;
}

function leaderboard(
  title: string,
  note: string,
  accent: string,
  rows: TestStat[],
  value: (s: TestStat) => [string, string],
  meta: (s: TestStat) => string,
  ctx: PageContext,
) {
  return html`<div class="panel" style=${styleMap({ '--accent': accent })}>
    <div class="ptitle"><span class="l">${title}</span><span class="n">${note}</span></div>
    <div class="flist">
      ${rows.length
        ? rows.map((s, i) => {
            const [v, sub] = value(s);
            return html`<a class="fl" href=${ctx.nav.href('tests', { run: s.last_run_id, test: s.test_id })} title="${s.title}\n${specPath(s.file)}">
              <span class="rk">${String(i + 1).padStart(2, '0')}</span>
              <span style="min-width:0"><span class="ft" style="display:block">${s.title}</span>
                <span class="fs" style="display:block">${suiteBadges(s.suites)} ${meta(s)}</span></span>
              <span class="rate tab">${v}<small>${sub}</small></span>
            </a>`;
          })
        : html`<div class="empty">Nothing here for this period.</div>`}
    </div>
  </div>`;
}

/**
 * Most failing / flaky / slowest tests. A test only runs in its own lanes' executions, so each row says how many of
 * the period's executions it ran in ("ran in 23 of 59 executions").
 */
export function topTests(top: TopTests, ctx: PageContext, totalExecutions: number) {
  if (top.statsError) return html`<p class="note">Test statistics are unavailable: ${top.statsError}</p>`;
  const ranIn = (s: TestStat) => `ran in ${Number(s.execs)} of ${totalExecutions} executions`;
  const testRuns = (n: number) => `${n} test run${n === 1 ? '' : 's'}`;
  return html`<div class="top-grid">
    ${leaderboard('Most failing', 'failed test runs', 'var(--fail)', top.topFailing, (s) => [`${s.failed}`, `of ${testRuns(Number(s.runs))}`], ranIn, ctx)}
    ${leaderboard('Most flaky', 'passed only on retry', 'var(--flaky)', top.topFlaky, (s) => [`${s.flaky}`, `of ${testRuns(Number(s.runs))}`], ranIn, ctx)}
    ${leaderboard('Slowest', 'average duration', 'var(--ice)', top.slowest, (s) => [fmtDur(Number(s.avg_ms)), `avg of ${testRuns(Number(s.runs))}`], ranIn, ctx)}
  </div>`;
}

/** The day to show first: today if it has runs, else the last day with runs, else today or the first day. */
export function defaultDay(days: readonly PeriodDay[]): number {
  const today = days.findIndex((d) => d.isToday);
  if (today >= 0 && days[today].runs.length) return today;
  const last = days.map((d) => d.runs.length > 0 && !d.isFuture).lastIndexOf(true);
  return last >= 0 ? last : Math.max(0, today);
}
