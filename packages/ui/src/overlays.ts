import { LitElement, css, html, nothing } from './lit.ts';
import { baseStyles } from './styles.ts';

/**
 * Side drawer (full screen on phones). Esc, the close button and the backdrop dispatch "close";
 * the parent decides whether to actually close by clearing `open`.
 */
export class QDrawer extends LitElement {
  static properties = { open: { type: Boolean, reflect: true }, heading: {}, wide: { type: Boolean } };
  declare open: boolean;
  declare heading: string;
  declare wide: boolean;
  private returnFocus: Element | null = null;
  /** Open overlays, topmost last. Only the topmost one reacts to Esc. */
  private static stack: QDrawer[] = [];

  constructor() {
    super();
    this.open = false;
    this.heading = '';
    this.wide = false;
  }

  private onKey = (e: KeyboardEvent) => {
    const top = QDrawer.stack[QDrawer.stack.length - 1];
    if (e.key === 'Escape' && this.open && top === this && !e.defaultPrevented) {
      e.preventDefault();
      this.close();
    }
  };

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this.onKey);
  }
  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.onKey);
    QDrawer.stack = QDrawer.stack.filter((d) => d !== this);
  }

  updated(changed: Map<string, unknown>): void {
    if (!changed.has('open')) return;
    QDrawer.stack = QDrawer.stack.filter((d) => d !== this);
    if (this.open) QDrawer.stack.push(this);
    if (this.open) {
      this.returnFocus = document.activeElement;
      this.renderRoot.querySelector<HTMLElement>('.close')?.focus();
    } else if (changed.get('open') === true && this.returnFocus instanceof HTMLElement) {
      this.returnFocus.focus();
    }
  }

  close(): void {
    // Not bubbling: a modal inside a drawer must not close the drawer too.
    this.dispatchEvent(new CustomEvent('close'));
  }

  render() {
    if (!this.open) return nothing;
    return html`<div class="backdrop" @click=${this.close}></div>
      <aside role="dialog" aria-modal="true" aria-label=${this.heading} class=${this.wide ? 'wide' : ''}>
        <header>
          <slot name="header"><h2>${this.heading}</h2></slot>
          <button class="close" @click=${this.close} aria-label="Close">✕</button>
        </header>
        <div class="body"><slot></slot></div>
      </aside>`;
  }

  static styles = [
    baseStyles,
    css`
      .backdrop {
        position: fixed;
        inset: 0;
        background: rgb(0 0 0 / 0.45);
        z-index: 30;
      }
      aside {
        position: fixed;
        top: 0;
        right: 0;
        bottom: 0;
        width: min(760px, 100vw);
        background: var(--q-bg);
        border-left: 1px solid var(--q-border);
        box-shadow: var(--q-shadow);
        z-index: 31;
        display: flex;
        flex-direction: column;
        animation: slide 0.18s ease-out;
      }
      aside.wide {
        width: min(1100px, 100vw);
      }
      :host-context([data-reduced-motion]) aside {
        animation: none;
      }
      @keyframes slide {
        from {
          transform: translateX(40px);
          opacity: 0;
        }
      }
      header {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        padding: 14px 16px;
        border-bottom: 1px solid var(--q-border);
        background: var(--q-surface);
      }
      header ::slotted(*),
      header h2 {
        flex: 1;
        min-width: 0;
      }
      h2 {
        font-size: 1.05rem;
      }
      .body {
        overflow: auto;
        padding: 16px;
        flex: 1;
      }
    `,
  ];
}

/** Centered dialog for viewers (screenshots, text attachments). */
export class QModal extends QDrawer {
  static styles = [
    ...QDrawer.styles,
    css`
      aside,
      aside.wide {
        top: 4vh;
        bottom: 4vh;
        left: 50%;
        right: auto;
        transform: translateX(-50%);
        width: min(1200px, 94vw);
        border: 1px solid var(--q-border);
        border-radius: var(--q-radius);
        animation: none;
        z-index: 41;
      }
      .backdrop {
        z-index: 40;
      }
    `,
  ];
}
