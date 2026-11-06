// The curved 3D card carousel (from the Observatory design: buildCarousel / layoutCarousel / renderCarousel /
// carTo / carInput), in Chronoscope colours: Weekly shows days on it, Monthly shows months.
// Drag, flick, click, arrow keys or the buttons move it; it fires `select` with the card index.
// Kept cheap to paint: no animated SVG filter and one blurred layer per card (the halo); the border glow is a
// box-shadow. Card frames change transform/opacity only, so moving the carousel does not re-raster them.

import { LitElement, css, html, nothing, styleMap } from '@qaily/ui';
import { cardBarHeight, carouselCard, flickTarget } from './chrono-math.ts';

export interface CarouselCard {
  key: string;
  /** Top-left label (weekday / "Today" / year). */
  top: string;
  /** Status pill (Stable, Degraded, Live…). */
  status: string;
  /** Big date line and its small suffix ("14" + "Oct"). */
  date: string;
  small: string;
  /** Pass rate in %, null when there were no executions. */
  pct: number | null;
  hue: number;
  /** One bar per run (or per day, on month cards): pass rate in % and hue. */
  bars: { pct: number | null; hue: number; title?: string }[];
  /** Executions; failed and flaky count test runs. */
  runs: number;
  failed: number;
  flaky: number;
  future?: boolean;
  label: string;
}

export class ChronoCarousel extends LitElement {
  static properties = {
    cards: { attribute: false },
    selected: { type: Number },
    reducedMotion: { type: Boolean },
    pos: { state: true },
    width: { state: true },
  };
  declare cards: CarouselCard[];
  declare selected: number;
  declare reducedMotion: boolean;
  declare pos: number;
  declare width: number;

  private drag: { x: number; p: number; lx: number; lt: number; v: number; moved: number } | null = null;
  private anim = 0;
  private ro?: ResizeObserver;
  private shown = -1;

  constructor() {
    super();
    this.cards = [];
    this.selected = 0;
    this.reducedMotion = false;
    this.pos = 0;
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
    cancelAnimationFrame(this.anim);
  }

  willUpdate(changed: Map<string, unknown>): void {
    if (!changed.has('selected')) return;
    // First show: jump. Later changes (from the chart or a reload): glide there.
    if (this.shown < 0) this.pos = this.selected;
    else if (this.selected !== this.shown) this.glide(this.selected);
    this.shown = this.selected;
  }

  /** Card width and perspective follow the original design's layoutCarousel. */
  private get geo() {
    const W = this.width || 900;
    const cw = Math.round(Math.min(230, Math.max(168, W * 0.42)));
    return { cw, P: Math.max(700, W * 0.95) };
  }

  private glide(target: number) {
    cancelAnimationFrame(this.anim);
    if (this.reducedMotion) {
      this.pos = target;
      return;
    }
    const from = this.pos;
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / 900);
      const ease = t === 1 ? 1 : 1 - Math.pow(2, -10 * t); // GSAP expo.out, .9 s
      this.pos = from + (target - from) * ease;
      if (t < 1) this.anim = requestAnimationFrame(step);
    };
    this.anim = requestAnimationFrame(step);
  }

  /** Moves to card i and tells the page (like carTo(i, true)). */
  private choose(i: number) {
    const target = Math.max(0, Math.min(this.cards.length - 1, i));
    this.glide(target);
    this.shown = target;
    if (target !== this.selected) this.dispatchEvent(new CustomEvent('select', { detail: target }));
  }

  private onDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    cancelAnimationFrame(this.anim);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const now = performance.now();
    this.drag = { x: e.clientX, p: this.pos, lx: e.clientX, lt: now, v: 0, moved: 0 };
  };

  private onMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) return;
    const dx = e.clientX - d.x;
    d.moved = Math.max(d.moved, Math.abs(dx));
    const now = performance.now();
    d.v = (e.clientX - d.lx) / Math.max(1, now - d.lt);
    d.lx = e.clientX;
    d.lt = now;
    this.pos = Math.max(-0.4, Math.min(this.cards.length - 0.6, d.p - dx / (this.geo.cw * 0.95)));
  };

  private onUp = (e: PointerEvent) => {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.moved < 6) {
      const card = this.renderRoot instanceof ShadowRoot
        ? this.renderRoot.elementsFromPoint(e.clientX, e.clientY).map((n) => (n as HTMLElement).closest?.('.dcard') as HTMLElement | null).find(Boolean)
        : null;
      if (card) return this.choose(Number(card.dataset.i));
    }
    this.choose(flickTarget(this.pos, d.v, this.geo.cw, this.cards.length));
  };

  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') this.choose(this.shown - 1);
    else if (e.key === 'ArrowRight') this.choose(this.shown + 1);
    else return;
    e.preventDefault();
  };

  private card(c: CarouselCard, i: number) {
    const { cw, P } = this.geo;
    const g = carouselCard(i, this.pos, cw, P);
    if (!g.visible) return nothing;
    const sel = Math.round(this.pos) === i;
    return html`<div class="dcard eb ${sel ? 'eb-on' : ''} ${c.future ? 'future' : ''}" data-i=${i} role="button"
      aria-pressed=${i === this.selected} aria-label=${c.label}
      style=${styleMap({ '--h': String(c.hue), '--cw': `${cw}px`, transform: g.transform, opacity: String(g.opacity), zIndex: String(g.zIndex) })}>
      <div class="eb-glow"></div>
      <div class="eb-body">
        <div class="dc-top"><span>${c.top}</span><span class="dc-st">${c.status}</span></div>
        <div class="dc-date">${c.date} <small>${c.small}</small></div>
        <div class="dc-pct tab">${c.pct == null ? '–' : c.pct.toFixed(1)}<span>%</span></div>
        <div class="dc-bars ${c.bars.length > 14 ? 'dense' : ''}">
          ${c.bars.length
            ? c.bars.map((b) => {
                const color = b.pct == null ? 'rgba(124,231,255,.12)' : `hsl(${b.hue} 100% 62%)`;
                return html`<i title=${b.title ?? nothing}
                  style=${styleMap({ height: `${b.pct == null ? 4 : cardBarHeight(b.pct)}%`, background: color, color })}></i>`;
              })
            : html`<span class="c-dim mono" style="font-size:11px">no executions</span>`}
        </div>
        <div class="dc-foot"><span>${c.runs} executions</span><span class=${c.failed ? 'c-fail' : ''}>${c.failed} failed</span>
          <span class=${c.flaky ? 'c-flaky' : ''}>${c.flaky} flaky</span></div>
      </div>
      <div class="eb-fx"><i class="s"></i></div>
    </div>`;
  }

  render() {
    return html`
      <div class="carousel" tabindex="0" aria-label="Carousel. Use the arrow keys to move between cards."
        @pointerdown=${this.onDown} @pointermove=${this.onMove} @pointerup=${this.onUp} @pointercancel=${this.onUp} @keydown=${this.onKey}>
        <div class="car-floor"></div>
        <div class="car-stage" style=${styleMap({ perspective: `${this.geo.P}px` })}>${this.cards.map((c, i) => this.card(c, i))}</div>
        <div class="car-ui">
          <button @click=${() => this.choose(this.shown - 1)} aria-label="Previous">&#8592;</button><span>Drag through time</span>
          <button @click=${() => this.choose(this.shown + 1)} aria-label="Next">&#8594;</button>
        </div>
      </div>`;
  }

  static styles = css`
    :host {
      display: block;
      --ink: var(--q-text, #e8efff);
      --muted: var(--q-text-muted, #8a97b6);
      --dim: color-mix(in srgb, var(--muted) 62%, transparent);
      --ice: var(--q-accent, #b6a6ff);
      --line-2: color-mix(in srgb, var(--ice) 34%, transparent);
      --fail: var(--q-fail, #ff4d6d);
      --flaky: var(--q-flaky, #ffc247);
      --display: var(--q-font-display, 'Unbounded', 'Arial Black', system-ui, sans-serif);
      --mono: var(--q-font-mono, 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace);
      color: var(--ink);
    }
    * {
      box-sizing: border-box;
    }
    button {
      font: inherit;
      color: inherit;
      background: none;
      border: 0;
      cursor: pointer;
    }
    :focus-visible {
      outline: 2px solid var(--ice);
      outline-offset: 3px;
      border-radius: 8px;
    }
    .mono {
      font-family: var(--mono);
    }
    .tab {
      font-variant-numeric: tabular-nums;
    }
    .c-fail {
      color: var(--fail);
    }
    .c-flaky {
      color: var(--flaky);
    }
    .c-dim {
      color: var(--dim);
    }

    /* glowing card frame (the original design's "electric border", without the animated distortion) */
    .eb {
      --h: 192;
      position: relative;
      isolation: isolate;
      border-radius: 20px;
    }
    .eb-glow {
      position: absolute;
      inset: 0;
      border-radius: inherit;
      z-index: 0;
      transform: scale(1.04);
      filter: blur(28px);
      opacity: 0.32;
      pointer-events: none;
      background: linear-gradient(-30deg, hsl(var(--h) 100% 60%), transparent 45%, transparent 55%, hsl(var(--h) 100% 60%));
    }
    .eb-body {
      position: relative;
      z-index: 1;
      border-radius: inherit;
      height: 100%;
    }
    .eb-fx {
      position: absolute;
      inset: 0;
      border-radius: inherit;
      pointer-events: none;
      z-index: 2;
    }
    .eb-fx i {
      position: absolute;
      inset: 0;
      border-radius: inherit;
    }
    /* The border and its glow, as box-shadows (blur filters here cost a re-raster per card per frame). */
    .eb-fx .s {
      border: 2px solid hsl(var(--h) 100% 64% / 0.6);
      box-shadow: 0 0 8px -1px hsl(var(--h) 100% 66% / 0.45), inset 0 0 8px -2px hsl(var(--h) 100% 66% / 0.35);
    }
    .eb-on .eb-fx .s {
      border-color: hsl(var(--h) 100% 66%);
      box-shadow: 0 0 14px 0 hsl(var(--h) 100% 66% / 0.7), inset 0 0 12px -2px hsl(var(--h) 100% 66% / 0.45);
    }
    .eb-on .eb-glow {
      opacity: 0.5;
    }

    .carousel {
      position: relative;
      height: 440px;
      overflow: hidden;
      touch-action: pan-y;
      cursor: grab;
      user-select: none;
      -webkit-user-select: none;
      border-radius: 22px;
    }
    .carousel:active {
      cursor: grabbing;
    }
    .car-stage {
      position: absolute;
      inset: 0;
      transform-style: preserve-3d;
    }
    .dcard {
      position: absolute;
      left: 50%;
      top: 50%;
      width: var(--cw, 220px);
      height: calc(var(--cw, 220px) * 1.45);
      transform-style: preserve-3d;
      will-change: transform, opacity;
      backface-visibility: hidden;
    }
    .dcard.future {
      filter: saturate(0.3) brightness(0.75);
    }
    .dcard .eb-body {
      overflow: hidden;
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      background: radial-gradient(120% 70% at 20% 0%, hsl(var(--h) 90% 45% / 0.32), transparent 60%),
        radial-gradient(90% 60% at 100% 100%, hsl(calc(var(--h) + 40) 90% 50% / 0.2), transparent 60%),
        linear-gradient(180deg, #121a2e, #070a12);
    }
    .dcard .eb-body::before {
      content: '';
      position: absolute;
      inset: 0;
      background-image: linear-gradient(hsl(var(--h) 100% 70% / 0.06) 1px, transparent 1px),
        linear-gradient(90deg, hsl(var(--h) 100% 70% / 0.06) 1px, transparent 1px);
      background-size: 22px 22px;
      pointer-events: none;
    }
    .dc-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--muted);
      position: relative;
    }
    .dc-st {
      padding: 3px 8px;
      border-radius: 99px;
      border: 1px solid hsl(var(--h) 100% 65% / 0.5);
      color: hsl(var(--h) 100% 72%);
      letter-spacing: 0.08em;
    }
    .dc-date {
      font-family: var(--display);
      font-size: clamp(30px, 4vw, 40px);
      font-weight: 500;
      line-height: 1;
      margin-top: 8px;
      position: relative;
    }
    .dc-date small {
      font-size: 0.42em;
      color: var(--muted);
      font-weight: 300;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .dc-pct {
      font-family: var(--display);
      font-weight: 300;
      font-size: clamp(22px, 3vw, 30px);
      color: hsl(var(--h) 100% 72%);
      text-shadow: 0 0 20px hsl(var(--h) 100% 60% / 0.6);
      position: relative;
    }
    .dc-pct span {
      font-size: 0.55em;
      margin-left: 2px;
    }
    .dc-bars {
      flex: 1;
      display: flex;
      align-items: flex-end;
      gap: 4px;
      min-height: 40px;
      position: relative;
      padding-top: 8px;
    }
    .dc-bars.dense {
      gap: 2px;
    }
    .dc-bars.dense i {
      box-shadow: none;
    }
    .dc-bars i {
      flex: 1;
      max-width: 18px;
      border-radius: 3px 3px 1px 1px;
      opacity: 0.9;
      box-shadow: 0 0 10px -2px currentColor;
    }
    .dc-foot {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 10px;
      font-family: var(--mono);
      font-size: 11px;
      color: var(--muted);
      position: relative;
    }
    .car-ui {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 12px;
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 14px;
      z-index: 5;
      font-family: var(--mono);
      font-size: 11px;
      color: var(--muted);
      letter-spacing: 0.1em;
      text-transform: uppercase;
      pointer-events: none;
    }
    .car-ui button {
      pointer-events: auto;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      border: 1px solid var(--line-2);
      display: grid;
      place-items: center;
      background: rgba(12, 16, 30, 0.8);
      color: var(--ice);
    }
    .car-ui button:hover {
      box-shadow: 0 0 18px -4px var(--ice);
    }
    .car-floor {
      position: absolute;
      left: -10%;
      right: -10%;
      bottom: -40%;
      height: 70%;
      background: radial-gradient(ellipse at 50% 0%, color-mix(in srgb, var(--ice) 22%, transparent), transparent 60%);
      pointer-events: none;
    }
    @media (max-width: 720px) {
      .carousel {
        height: 380px;
      }
    }
  `;
}

const tag = 'q-chrono-carousel';
if (!customElements.get(tag)) customElements.define(tag, ChronoCarousel);
