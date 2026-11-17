// A compact multi-select for the filter bar: a button ("All lanes", "Web · Dev +1") that opens a checkbox list.
// Nothing selected means "all". Fires `change` with the selected values in `detail`.

import { LitElement, baseStyles, css, html, nothing } from '@qaily/ui';

export interface MultiOption {
  value: string;
  label: string;
  /** Shown muted after the label, e.g. a run count. */
  note?: string;
}

export class MultiSelect extends LitElement {
  static properties = {
    label: {},
    allLabel: {},
    options: { attribute: false },
    selected: { attribute: false },
    open: { state: true },
  };
  declare label: string;
  declare allLabel: string;
  declare options: MultiOption[];
  declare selected: string[];
  declare open: boolean;

  private onDocClick = (e: MouseEvent) => {
    if (this.open && !e.composedPath().includes(this)) this.open = false;
  };

  constructor() {
    super();
    this.label = '';
    this.allLabel = 'All';
    this.options = [];
    this.selected = [];
    this.open = false;
  }

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('click', this.onDocClick);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('click', this.onDocClick);
  }

  private emit(next: string[]) {
    this.dispatchEvent(new CustomEvent('change', { detail: next, bubbles: true, composed: true }));
  }

  private toggle(value: string) {
    const on = this.selected.includes(value);
    // Keep the options' order, so the URL and the button text are stable.
    const next = this.options.map((o) => o.value).filter((v) => (v === value ? !on : this.selected.includes(v)));
    // Selected values that are no longer offered stay selected until unticked.
    const stale = this.selected.filter((v) => v !== value && !this.options.some((o) => o.value === v));
    this.emit([...next, ...stale]);
  }

  private summary(): string {
    if (!this.selected.length) return this.allLabel;
    const first = this.options.find((o) => o.value === this.selected[0])?.label ?? this.selected[0];
    return this.selected.length === 1 ? first : `${first} +${this.selected.length - 1}`;
  }

  render() {
    const stale = this.selected.filter((v) => !this.options.some((o) => o.value === v)).map((v) => ({ value: v, label: v, note: 'no runs' }));
    const options = [...this.options, ...stale];
    return html`<span class="label">${this.label}</span>
      <div class="wrap" @keydown=${(e: KeyboardEvent) => e.key === 'Escape' && (this.open = false)}>
        <button class="trigger ${this.selected.length ? 'active' : ''}" aria-haspopup="true" aria-expanded=${this.open}
          @click=${() => (this.open = !this.open)}>
          ${this.summary()} <span aria-hidden="true">▾</span>
        </button>
        ${this.open
          ? html`<div class="panel" role="group" aria-label=${this.label}>
              <label class="row">
                <input type="checkbox" .checked=${this.selected.length === 0} @change=${() => this.emit([])} />
                <span>${this.allLabel}</span>
              </label>
              <hr />
              ${options.length
                ? options.map(
                    (o) => html`<label class="row">
                      <input type="checkbox" .checked=${this.selected.includes(o.value)} @change=${() => this.toggle(o.value)} />
                      <span>${o.label}</span>${o.note ? html`<span class="note">${o.note}</span>` : nothing}
                    </label>`,
                  )
                : html`<p class="note empty">Nothing to choose from yet.</p>`}
            </div>`
          : nothing}
      </div>`;
  }

  static styles = [
    baseStyles,
    css`
      :host {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--q-text-muted);
        font-size: 0.9rem;
      }
      .wrap {
        position: relative;
      }
      .trigger {
        padding: 4px 10px;
        font-size: 0.9rem;
        max-width: 240px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .trigger.active {
        border-color: var(--q-accent);
        color: var(--q-accent);
      }
      .panel {
        position: absolute;
        top: calc(100% + 4px);
        left: 0;
        z-index: 20;
        min-width: 220px;
        max-height: 320px;
        overflow-y: auto;
        padding: 6px;
        background: var(--q-surface);
        color: var(--q-text);
        border: 1px solid var(--q-border);
        border-radius: var(--q-radius);
        box-shadow: var(--q-shadow);
      }
      .row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 6px;
        border-radius: 4px;
        cursor: pointer;
        white-space: nowrap;
      }
      .row:hover {
        background: var(--q-surface-2);
      }
      .row input {
        padding: 0;
      }
      .note {
        margin-left: auto;
        padding-left: 12px;
        color: var(--q-text-muted);
        font-size: 0.8rem;
      }
      .note.empty {
        margin: 4px 6px;
        padding: 0;
      }
      hr {
        border: none;
        border-top: 1px solid var(--q-border);
        margin: 4px 0;
      }
    `,
  ];
}

if (!customElements.get('q-multi-select')) customElements.define('q-multi-select', MultiSelect);
