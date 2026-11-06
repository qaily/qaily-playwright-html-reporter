import { LitElement, css, html, nothing, styleMap, svg } from './lit.ts';
import { baseStyles } from './styles.ts';

export interface ChartSeries {
  label: string;
  /** CSS colour, usually a token like var(--q-accent). */
  color: string;
  /** One value per x position; null leaves a gap. */
  values: (number | null)[];
}

/**
 * Small SVG line chart for 0–100 percentages over days. Themeable through tokens, no library.
 * Bands draw the threshold zones behind the lines.
 */
export class QLineChart extends LitElement {
  static properties = {
    labels: { attribute: false },
    series: { attribute: false },
    bands: { attribute: false },
    min: { type: Number },
    max: { type: Number },
    hover: { state: true },
  };
  declare labels: string[];
  declare series: ChartSeries[];
  declare bands: { from: number; to: number; color: string }[];
  declare min: number;
  declare max: number;
  declare hover: number | null;

  constructor() {
    super();
    this.labels = [];
    this.series = [];
    this.bands = [];
    this.min = 0;
    this.max = 100;
    this.hover = null;
  }

  render() {
    const W = 800;
    const H = 240;
    const pad = { l: 36, r: 8, t: 8, b: 24 };
    const n = Math.max(this.labels.length, 1);
    const x = (i: number) => pad.l + (n === 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (n - 1));
    const y = (v: number) => pad.t + ((this.max - v) * (H - pad.t - pad.b)) / (this.max - this.min || 1);
    const ticks = [this.min, (this.min + this.max) / 2, this.max];
    const labelEvery = Math.ceil(n / 10);
    const path = (vals: (number | null)[]) => {
      let d = '';
      let pen = false;
      vals.forEach((v, i) => {
        if (v == null) return void (pen = false);
        d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(Math.min(this.max, Math.max(this.min, v))).toFixed(1)}`;
        pen = true;
      });
      return d;
    };
    const onMove = (e: PointerEvent) => {
      const box = (e.currentTarget as SVGElement).getBoundingClientRect();
      const px = ((e.clientX - box.left) / box.width) * W;
      this.hover = Math.max(0, Math.min(n - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (n - 1))));
    };
    const h = this.hover;
    return html`
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Pass rate trend" @pointermove=${onMove} @pointerleave=${() => (this.hover = null)}>
        ${this.bands.map((b) => svg`<rect x=${pad.l} width=${W - pad.l - pad.r} y=${y(Math.min(b.to, this.max))}
          height=${Math.max(0, y(Math.max(b.from, this.min)) - y(Math.min(b.to, this.max)))} fill=${b.color} opacity="0.08" />`)}
        ${ticks.map((t) => svg`<line x1=${pad.l} x2=${W - pad.r} y1=${y(t)} y2=${y(t)} class="grid" />
          <text x=${pad.l - 6} y=${y(t) + 4} text-anchor="end" class="tick">${t}%</text>`)}
        ${this.labels.map((l, i) => (i % labelEvery === 0 ? svg`<text x=${x(i)} y=${H - 6} text-anchor="middle" class="tick">${l}</text>` : nothing))}
        ${h != null ? svg`<line x1=${x(h)} x2=${x(h)} y1=${pad.t} y2=${H - pad.b} class="cursor" />` : nothing}
        ${this.series.map(
          (s) => svg`<path d=${path(s.values)} fill="none" stroke=${s.color} stroke-width="2" stroke-linejoin="round" />
            ${s.values.map((v, i) => (v == null ? nothing : svg`<circle cx=${x(i)} cy=${y(v)} r=${h === i ? 4 : 2.5} fill=${s.color} />`))}`,
        )}
      </svg>
      <div class="legend">
        ${this.series.map(
          (s) => html`<span><i style=${styleMap({ background: s.color })}></i>${s.label}${h != null && s.values[h] != null ? html`: <b>${s.values[h]!.toFixed(1)}%</b>` : nothing}</span>`,
        )}
        ${h != null ? html`<span class="muted">${this.labels[h]}</span>` : nothing}
      </div>
    `;
  }

  static styles = [
    baseStyles,
    css`
      svg {
        width: 100%;
        height: auto;
        display: block;
        touch-action: none;
      }
      .grid {
        stroke: var(--q-border);
      }
      .cursor {
        stroke: var(--q-text-muted);
        stroke-dasharray: 3 3;
      }
      .tick {
        fill: var(--q-text-muted);
        font-size: 11px;
      }
      .legend {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 14px;
        font-size: 0.85rem;
        margin-top: 6px;
      }
      .legend i {
        display: inline-block;
        width: 10px;
        height: 10px;
        border-radius: 2px;
        margin-right: 5px;
      }
    `,
  ];
}

/** Categorical series colours. Themes may set --q-series-1…8; these are the fallbacks (Tableau 10). */
export const SERIES_COLORS = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2', '#edc948', '#b07aa1', '#ff9da7'].map(
  (c, i) => `var(--q-series-${i + 1}, ${c})`,
);
