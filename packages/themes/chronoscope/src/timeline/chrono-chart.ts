// The Chronoscope chart (from the Observatory design, renderChrono), for any number of days:
// every run as a glowing dot at the hour it ran and its pass rate, the daily pass rate as a smooth glowing line,
// and stacked failed/flaky bars per day. Clicking a day fires `select`; clicking a dot follows its link.

import { LitElement, css, html, nothing, svg } from '@qaily/ui';
import { barHeights, chronoFrame, gridStep, smoothPath } from './chrono-math.ts';

export interface ChronoDay {
  /** Axis label ("Mo 13", "Today", "1"…). */
  label: string;
  /** Daily pass rate as a fraction, null without runs. */
  rate: number | null;
  failed: number;
  flaky: number;
  weekend: boolean;
}

export interface ChronoRun {
  /** Day index plus the fraction of the day it started at. */
  x: number;
  rate: number;
  hue: number;
  title: string;
  href: string;
}

export class ChronoChart extends LitElement {
  static properties = {
    days: { attribute: false },
    runs: { attribute: false },
    selected: { type: Number },
    /** What one column is: a day (Weekly) or a month (Monthly). */
    unit: {},
    width: { state: true },
  };
  declare days: ChronoDay[];
  declare runs: ChronoRun[];
  declare selected: number;
  declare unit: 'day' | 'month';
  declare width: number;
  private ro?: ResizeObserver;

  constructor() {
    super();
    this.days = [];
    this.runs = [];
    this.selected = -1;
    this.unit = 'day';
    this.width = 0;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.ro = new ResizeObserver(() => (this.width = this.clientWidth));
    this.ro.observe(this);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.ro?.disconnect();
  }

  private pick(i: number) {
    this.dispatchEvent(new CustomEvent('select', { detail: i }));
  }

  render() {
    const W = this.width;
    const n = this.days.length;
    if (!W || !n) return html`<div style="height:300px"></div>`;
    const f = chronoFrame(W, n, [...this.runs.map((r) => r.rate), ...this.days.flatMap((d) => (d.rate == null ? [] : [d.rate]))]);
    const { X, Y, m, iw, ih, H } = f;
    const colW = iw / n;
    const grid = [];
    const step = gridStep(f.y0);
    for (let v = 1; v >= f.y0 - 0.0001; v -= step) grid.push(v);
    const pts = this.days.flatMap((d, i) => (d.rate == null ? [] : [[X(i + 0.5), Y(d.rate)] as [number, number]]));
    const path = smoothPath(pts);
    const bars = barHeights(this.days, f.bH);
    // Thin the labels when they would collide (original design: every other day on narrow screens).
    const every = Math.max(f.narrow ? 2 : 1, Math.ceil(44 / colW));
    return html`<svg width=${W} height=${H} role="img" aria-label="Pass rate of every execution across ${n} ${this.unit}s">
      <defs>
        <linearGradient id="ar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="ar0" /><stop offset="1" class="ar1" /></linearGradient>
        <filter id="gl"><feGaussianBlur stdDeviation="3" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        <!-- One glow pass for all run dots (a CSS drop-shadow per dot was a filter layer each). -->
        <filter id="dotglow" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="2.2" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      </defs>
      ${this.days.map((d, i) =>
        i === this.selected
          ? svg`<rect x=${X(i)} y=${m.t} width=${colW} height=${H - m.t - 24} class="sel" stroke-dasharray="2 4" />`
          : d.weekend
            ? svg`<rect x=${X(i)} y=${m.t} width=${colW} height=${ih} class="wkend" />`
            : nothing,
      )}
      ${grid.map((v) => {
        const y = Y(v);
        return svg`<line x1=${m.l} x2=${W - m.r} y1=${y} y2=${y} class="grid" /><text x=${m.l - 6} y=${y + 3} text-anchor="end">${Math.round(v * 100)}%</text>`;
      })}
      ${pts.length
        ? svg`<path d="${path} L${pts[pts.length - 1][0]},${m.t + ih} L${pts[0][0]},${m.t + ih} Z" fill="url(#ar)" />
            <path d=${path} class="line" filter="url(#gl)" />`
        : nothing}
      ${this.days.map((d, i) => {
        const bw = Math.max(4, colW * 0.42);
        const x = X(i + 0.5) - bw / 2;
        const { hf, hl } = bars[i];
        const label = i % every === every - 1 || i === n - 1 || i === this.selected;
        return svg`<rect x=${x} y=${f.bTop + f.bH - hf} width=${bw} height=${hf} rx="1.5" class="bf" />
          <rect x=${x} y=${f.bTop + f.bH - hf - hl} width=${bw} height=${hl} rx="1.5" class="bk" />
          ${label ? svg`<text x=${X(i + 0.5)} y=${H - 8} text-anchor="middle" class=${i === this.selected ? 'on' : ''}>${d.label}</text>` : nothing}`;
      })}
      <line x1=${m.l} x2=${W - m.r} y1=${f.bTop + f.bH} y2=${f.bTop + f.bH} class="axis" />
      ${this.days.map((_, i) => svg`<rect x=${X(i)} y="0" width=${colW} height=${H} fill="transparent" style="cursor:pointer" @click=${() => this.pick(i)} />`)}
      <g filter="url(#dotglow)">
        ${this.runs.map(
          (r) => svg`<a href=${r.href}><circle cx=${X(r.x)} cy=${Y(r.rate)} r="3.2" fill="hsl(${r.hue} 100% 62%)"><title>${r.title}</title></circle></a>`,
        )}
      </g>
    </svg>`;
  }

  static styles = css`
    :host {
      display: block;
      width: 100%;
      overflow: hidden;
    }
    svg {
      display: block;
    }
    :host {
      --accent: var(--q-accent, #b6a6ff);
      --rule: var(--q-border, rgba(150, 180, 255, 0.18));
    }
    text {
      font-family: var(--q-font-mono, 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace);
      font-size: 10px;
      fill: var(--q-text-muted, #8a97b6);
    }
    text.on {
      fill: var(--accent);
    }
    .ar0 {
      stop-color: var(--accent);
      stop-opacity: 0.35;
    }
    .ar1 {
      stop-color: var(--accent);
      stop-opacity: 0;
    }
    .sel {
      fill: color-mix(in srgb, var(--accent) 8%, transparent);
      stroke: color-mix(in srgb, var(--accent) 40%, transparent);
    }
    .wkend {
      fill: color-mix(in srgb, var(--accent) 3%, transparent);
    }
    .grid {
      stroke: color-mix(in srgb, var(--rule) 55%, transparent);
    }
    .axis {
      stroke: var(--rule);
    }
    .line {
      fill: none;
      stroke: var(--accent);
      stroke-width: 2;
    }
    .bf {
      fill: var(--q-fail, #ff4d6d);
    }
    .bk {
      fill: var(--q-flaky, #ffc247);
    }
    circle {
      cursor: pointer;
    }
  `;
}

const tag = 'q-chrono-chart';
if (!customElements.get(tag)) customElements.define(tag, ChronoChart);
