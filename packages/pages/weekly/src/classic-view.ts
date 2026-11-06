import type { PageContext } from '@qaily/contracts';
import { formatDate, formatDateTime, formatDuration, formatPercent, formatTime } from '@qaily/core';
import { LitElement, LEVEL_GLYPH, baseStyles, css, elementView, html, nothing } from '@qaily/ui';
import type { WeekRun, WeeklyModel } from './model.ts';

/** Runs shown per cell before "+N more". */
const VISIBLE_PER_CELL = 12;

class WeeklyClassic extends LitElement {
  static properties = { model: { attribute: false }, ctx: { attribute: false }, expanded: { state: true } };
  declare model: WeeklyModel;
  declare ctx: PageContext;
  declare expanded: Set<string>;

  constructor() {
    super();
    this.expanded = new Set();
  }

  private goWeek(week: number) {
    this.ctx.nav.go('weekly', week ? { week: String(week) } : {});
  }

  private cube(w: WeekRun) {
    const r = w.run;
    const s = this.ctx.settings;
    const title = [
      `${formatDateTime(r.started_at, s)} · ${r.branch ?? ''}`,
      `${r.category ?? ''} ${r.environment ?? ''} ${r.tag ?? ''}`,
      w.running ? 'Running' : `Pass rate ${formatPercent(w.rate)} (passed ${r.passed}, failed ${r.failed}, flaky ${r.flaky}, skipped ${r.skipped})`,
      `Duration ${formatDuration(r.dur_ms)}`,
    ].join('\n');
    const body = html`<span class="t">${this.model.aiRuns.has(r.run_id) ? '✨' : ''}${formatTime(r.started_at, s)}</span>
      <span class="n">${w.running ? '◌' : html`<span aria-hidden="true">${LEVEL_GLYPH[w.level]}</span> ${r.passed + r.flaky}/${r.total - r.skipped}`}</span>
      ${r.tag ? html`<span class="suite-t">${r.tag}</span>` : nothing}`;
    const cls = `cube level-${w.level} ${w.running ? 'running' : ''}`;
    return html`<a class=${cls} href=${this.ctx.nav.href('tests', { run: r.run_id })} title=${title}>${body}</a>`;
  }

  private cell(dayKey: string, laneId: string, runs: WeekRun[]) {
    const key = `${dayKey}/${laneId}`;
    const open = this.expanded.has(key);
    const shown = open ? runs : runs.slice(0, VISIBLE_PER_CELL);
    const toggle = () => {
      const next = new Set(this.expanded);
      if (open) next.delete(key);
      else next.add(key);
      this.expanded = next;
    };
    return html`<td>
      <div class="cubes">
        ${shown.map((w) => this.cube(w))}
        ${runs.length > VISIBLE_PER_CELL
          ? html`<button class="more" @click=${toggle}>${open ? 'Less' : `+${runs.length - VISIBLE_PER_CELL}`}</button>`
          : nothing}
      </div>
    </td>`;
  }

  render() {
    const m = this.model;
    const s = this.ctx.settings;
    const lastDay = new Date(new Date(m.to).getTime() - 1);
    return html`
      <div class="bar">
        <button @click=${() => this.goWeek(m.week - 1)} aria-label="Previous week"><q-icon name="chevronLeft"></q-icon></button>
        <h1>${formatDate(m.from, s, { month: 'long', day: 'numeric' })} – ${formatDate(lastDay, s, { month: 'long', day: 'numeric', year: 'numeric' })}</h1>
        <button @click=${() => this.goWeek(m.week + 1)} ?disabled=${m.week >= 0} aria-label="Next week">
          <q-icon name="chevronRight"></q-icon>
        </button>
        ${m.week < 0 ? html`<button @click=${() => this.goWeek(0)}>This week</button>` : nothing}
        <span class="muted">${m.totalRuns} executions</span>
      </div>
      ${m.lanes.length === 0
        ? html`<q-state kind="empty" message="No lanes to show. Check Settings → Lanes."></q-state>`
        : html`<div class="scroll card">
            <table>
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  ${m.lanes.map(
                    (l) => html`<th scope="col">
                      <div class="lane">${l.label}</div>
                      <q-health level=${l.level} label=${formatPercent(l.rate)}></q-health>
                    </th>`,
                  )}
                </tr>
              </thead>
              <tbody>
                ${m.days.map(
                  (d) => html`<tr class=${d.isToday ? 'today' : d.isFuture ? 'future' : ''}>
                    <th scope="row">
                      <div class="day">${formatDate(d.start, s, { weekday: 'long' })}</div>
                      <div class="muted date">${formatDate(d.start, s)}</div>
                      ${d.runCount ? html`<q-health level=${d.level} label=${formatPercent(d.rate)}></q-health>` : nothing}
                    </th>
                    ${m.lanes.map((l) => this.cell(d.key, l.id, d.byLane[l.id] ?? []))}
                  </tr>`,
                )}
              </tbody>
            </table>
          </div>`}
    `;
  }

  static styles = [
    baseStyles,
    css`
      .bar {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 16px;
      }
      h1 {
        font-size: 1.2rem;
      }
      .scroll {
        overflow-x: auto;
        padding: 0;
      }
      table {
        border-collapse: collapse;
        width: 100%;
      }
      th,
      td {
        border-bottom: 1px solid var(--q-border);
        padding: 10px;
        vertical-align: top;
        text-align: left;
      }
      thead th {
        position: sticky;
        top: 0;
        background: var(--q-surface);
        min-width: 160px;
      }
      thead th:first-child,
      tbody th {
        min-width: 120px;
        width: 120px;
      }
      .lane {
        margin-bottom: 4px;
      }
      .day {
        font-weight: 600;
      }
      .date {
        font-size: 0.85rem;
        margin-bottom: 4px;
      }
      tr.today th {
        box-shadow: inset 3px 0 0 var(--q-accent);
      }
      tr.future {
        opacity: 0.45;
      }
      .cubes {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .cube {
        display: inline-flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        width: 62px;
        min-height: 46px;
        padding: 3px 2px;
        box-sizing: border-box;
        border-radius: calc(var(--q-radius) * 0.75);
        background: var(--level);
        color: var(--q-on-status);
        text-decoration: none;
        font-size: 0.75rem;
        line-height: 1.3;
      }
      .cube.running {
        background: var(--q-running);
      }
      .cube:hover {
        filter: brightness(1.1);
      }
      .cube .suite-t {
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 0.62rem;
        opacity: 0.85;
      }
      .cube .t {
        font-weight: 700;
        font-size: 0.85rem;
      }
      .more {
        height: 46px;
        font-size: 0.8rem;
      }
    `,
  ];
}

export default elementView<WeeklyModel>('q-weekly-classic', WeeklyClassic);
