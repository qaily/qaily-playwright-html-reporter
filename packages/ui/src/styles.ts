import { css } from 'lit';

/** Base styles for shadow roots. Everything reads --q-* tokens, so themes restyle every page. */
export const baseStyles = css`
  :host {
    color: var(--q-text);
    font-family: var(--q-font);
    font-variant-numeric: tabular-nums;
  }
  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }
  h1,
  h2,
  h3 {
    font-family: var(--q-font-display);
    margin: 0;
    font-weight: 600;
  }
  a {
    color: var(--q-accent);
  }
  button,
  select,
  input {
    font: inherit;
    color: var(--q-text);
    background: var(--q-surface);
    border: 1px solid var(--q-border);
    border-radius: calc(var(--q-radius) * 0.75);
    padding: 6px 10px;
  }
  button {
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    background: var(--q-surface-2);
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  button.primary {
    background: var(--q-accent);
    color: var(--q-on-accent);
    border-color: transparent;
  }
  :focus-visible {
    outline: 2px solid var(--q-accent);
    outline-offset: 2px;
  }
  .card {
    background: var(--q-surface);
    border: 1px solid var(--q-border);
    border-radius: var(--q-radius);
    box-shadow: var(--q-shadow);
    padding: 16px;
  }
  .muted {
    color: var(--q-text-muted);
  }
  .mono {
    font-family: var(--q-font-mono);
  }
  .level-good {
    --level: var(--q-good);
  }
  .level-warn {
    --level: var(--q-warn);
  }
  .level-bad {
    --level: var(--q-bad);
  }
  .level-none {
    --level: var(--q-none);
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
`;
