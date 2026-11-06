import { LitElement, css, html, nothing, unsafeSVG } from './lit.ts';
import type { HealthLevel } from '@qaily/contracts';
import { ICONS } from './icons.ts';
import { baseStyles } from './styles.ts';
import { QDrawer, QModal } from './overlays.ts';
import { QLineChart } from './chart.ts';

/** Glyphs make health readable without colour. */
export const LEVEL_GLYPH: Record<HealthLevel | 'none', string> = { good: '✓', warn: '!', bad: '✕', none: '–' };
export const LEVEL_LABEL: Record<HealthLevel | 'none', string> = { good: 'Good', warn: 'Warning', bad: 'Bad', none: 'No data' };

export class QIcon extends LitElement {
  static properties = { name: {} };
  declare name: string;
  static styles = css`
    :host {
      display: inline-flex;
      width: 1.1em;
      height: 1.1em;
    }
    svg {
      width: 100%;
      height: 100%;
    }
  `;
  render() {
    const body = ICONS[this.name] ?? '';
    return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true">${unsafeSVG(body)}</svg>`;
  }
}

/** A value coloured by its health level, e.g. a pass rate. */
export class QHealth extends LitElement {
  static properties = { level: {}, label: {} };
  declare level: HealthLevel | 'none';
  declare label: string;
  constructor() {
    super();
    this.level = 'none';
    this.label = '';
  }
  static styles = [
    baseStyles,
    css`
      :host {
        display: inline-flex;
      }
      span {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 8px;
        border-radius: 999px;
        background: var(--level);
        color: var(--q-on-status);
        font-weight: 600;
        font-size: 0.85em;
        white-space: nowrap;
      }
    `,
  ];
  render() {
    return html`<span class="level-${this.level}" title=${LEVEL_LABEL[this.level]}
      ><span aria-hidden="true" style="padding:0;background:none">${LEVEL_GLYPH[this.level]}</span>${this.label}</span
    >`;
  }
}

/** Loading, empty and error states with one look across pages. */
export class QState extends LitElement {
  static properties = { kind: {}, message: {}, retry: { attribute: false } };
  declare kind: 'loading' | 'empty' | 'error';
  declare message: string;
  declare retry: (() => void) | undefined;
  constructor() {
    super();
    this.kind = 'loading';
    this.message = '';
  }
  static styles = [
    baseStyles,
    css`
      :host {
        display: block;
      }
      .box {
        padding: 32px;
        text-align: center;
      }
      .error {
        border-color: var(--q-bad);
      }
      .spinner {
        width: 24px;
        height: 24px;
        margin: 0 auto 12px;
        border: 3px solid var(--q-border);
        border-top-color: var(--q-accent);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }
      :host-context([data-reduced-motion]) .spinner {
        animation: none;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
    `,
  ];
  render() {
    return html`<div class="box card ${this.kind}" role=${this.kind === 'error' ? 'alert' : 'status'}>
      ${this.kind === 'loading' ? html`<div class="spinner"></div>` : nothing}
      <div>${this.message || (this.kind === 'loading' ? 'Loading…' : this.kind === 'empty' ? 'Nothing to show' : 'Something went wrong')}</div>
      ${this.retry ? html`<p><button @click=${() => this.retry?.()}>Try again</button></p>` : nothing}
    </div>`;
  }
}

export function defineComponents(): void {
  const define = (name: string, ctor: CustomElementConstructor) => customElements.get(name) ?? customElements.define(name, ctor);
  define('q-icon', QIcon);
  define('q-health', QHealth);
  define('q-state', QState);
  define('q-drawer', QDrawer);
  define('q-modal', QModal);
  define('q-line-chart', QLineChart);
}

declare global {
  interface HTMLElementTagNameMap {
    'q-icon': QIcon;
    'q-health': QHealth;
    'q-state': QState;
    'q-drawer': QDrawer;
    'q-modal': QModal;
    'q-line-chart': QLineChart;
  }
}

/** WebGL availability, checked once. */
let webgl: boolean | undefined;
export function canUseWebGL(): boolean {
  if (webgl === undefined) {
    try {
      const c = document.createElement('canvas');
      webgl = !!(c.getContext('webgl2') ?? c.getContext('webgl'));
    } catch {
      webgl = false;
    }
  }
  return webgl;
}
