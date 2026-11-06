// CSS of the Timeline view (layout from the Observatory design, colours from the Chronoscope skin) (view header, KPI row, panels, Chronoscope legend,
// day grid, run rows, problem rows, leaderboards), kept 1:1 with the original design.

import { css } from '@qaily/ui';

export const timelineStyles = css`
  :host {
    --panel-a: var(--q-surface, rgba(16, 24, 42, 0.78));
    --panel-b: rgba(7, 10, 20, 0.84);
    --line: var(--q-border, rgba(150, 180, 255, 0.18));
    --line-2: color-mix(in srgb, var(--q-accent, #b6a6ff) 34%, transparent);
    --ink: var(--q-text, #e8efff);
    --muted: var(--q-text-muted, #8a97b6);
    --dim: color-mix(in srgb, var(--muted) 62%, transparent);
    --ice: var(--q-accent, #b6a6ff);
    --ice-2: var(--q-series-1, #8fe6ff);
    --pass: var(--q-pass, #34f3a0);
    --fail: var(--q-fail, #ff4d6d);
    --flaky: var(--q-flaky, #ffc247);
    --skip: var(--q-skip, #7d8aa8);
    --run: var(--q-running, #4db6ff);
    --display: var(--q-font-display, 'Unbounded', 'Arial Black', system-ui, sans-serif);
    --body: var(--q-font, 'Manrope', 'Segoe UI', system-ui, sans-serif);
    --mono: var(--q-font-mono, 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace);
    display: flex;
    flex-direction: column;
    gap: 20px;
    max-width: 1340px;
    margin: 0 auto;
    padding-bottom: 40px;
    color: var(--ink);
    font-family: var(--body);
    font-size: 15px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  * {
    box-sizing: border-box;
  }
  a {
    color: inherit;
    text-decoration: none;
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
  .c-pass {
    color: var(--pass);
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

  /* view header */
  .vhead {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  .eyebrow {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--ice);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .h1 {
    font-family: var(--display);
    font-weight: 500;
    font-size: clamp(26px, 4vw, 44px);
    line-height: 1.05;
    margin: 8px 0 0;
    letter-spacing: -0.01em;
    text-wrap: balance;
  }
  .h1 em {
    font-style: normal;
    background: linear-gradient(90deg, var(--ice), var(--ice-2));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  .vright {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 10px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .chip {
    font-family: var(--mono);
    font-size: 12px;
    padding: 5px 10px;
    border-radius: 8px;
    border: 1px solid var(--line);
    background: rgba(14, 18, 34, 0.6);
    color: var(--muted);
    white-space: nowrap;
  }
  .chip b {
    color: var(--ink);
    font-weight: 600;
  }
  .runnav {
    display: flex;
    gap: 8px;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 9px 14px;
    border-radius: 10px;
    border: 1px solid var(--line-2);
    background: rgba(12, 16, 30, 0.7);
    font-size: 13px;
    color: var(--ink);
    transition: box-shadow 0.2s;
  }
  .btn:hover {
    box-shadow: 0 0 20px -6px var(--ice);
  }
  .btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
    box-shadow: none;
  }

  /* panels */
  .panel {
    position: relative;
    background: linear-gradient(180deg, var(--panel-a), var(--panel-b));
    border: 1px solid var(--line);
    border-radius: 18px;
    padding: 18px;
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--ice) 6%, transparent), 0 0 44px -14px color-mix(in srgb, var(--ice) 45%, transparent), inset 0 1px 0 color-mix(in srgb, var(--ice) 8%, transparent);
    min-width: 0;
  }
  .ptitle {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 14px;
  }
  .ptitle .l {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .ptitle span.n {
    letter-spacing: 0.04em;
    text-transform: none;
    color: var(--dim);
  }

  /* KPI row */
  .sumrow {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 12px;
  }
  .ctr {
    padding: 12px 14px;
    border-radius: 14px;
    border: 1px solid var(--line);
    background: rgba(12, 16, 30, 0.7);
    min-width: 0;
  }
  .ctr .k {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .ctr .v {
    font-family: var(--display);
    font-size: 24px;
    font-weight: 500;
    margin-top: 4px;
    font-variant-numeric: tabular-nums;
  }

  /* chronoscope legend */
  .chrono-leg {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    text-transform: none;
    letter-spacing: 0;
  }
  .chrono-leg span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .chrono-leg i {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }

  /* day grid */
  .day-grid {
    display: grid;
    grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
    gap: 20px;
  }
  .heat {
    display: grid;
    grid-template-columns: repeat(24, minmax(0, 1fr));
    gap: 3px;
    margin-bottom: 6px;
  }
  .heat i {
    height: 16px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--ice) 6%, transparent);
  }
  .heat-ax {
    display: flex;
    justify-content: space-between;
    font-family: var(--mono);
    font-size: 10px;
    color: var(--dim);
    margin-bottom: 16px;
  }
  .runrows {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .runrow {
    display: grid;
    grid-template-columns: 52px minmax(0, 1.1fr) minmax(0, 1.3fr) 110px 58px;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border-radius: 12px;
    border: 1px solid transparent;
    text-align: left;
    font-size: 13px;
    transition: background 0.2s, border-color 0.2s;
  }
  .runrow:hover {
    background: color-mix(in srgb, var(--ice) 5%, transparent);
    border-color: var(--line);
  }
  .runrow .t {
    font-family: var(--mono);
    color: var(--ink);
  }
  .runrow .tg {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .runrow .br {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .runrow .pc {
    font-family: var(--mono);
    text-align: right;
  }
  .stack {
    display: flex;
    height: 6px;
    border-radius: 6px;
    overflow: hidden;
    background: color-mix(in srgb, var(--ice) 8%, transparent);
  }
  .stack i {
    display: block;
    height: 100%;
  }
  .frow {
    display: grid;
    grid-template-columns: 10px minmax(0, 1fr) auto;
    gap: 12px;
    align-items: center;
    padding: 10px 4px;
    border-bottom: 1px dashed color-mix(in srgb, var(--line) 50%, transparent);
    text-align: left;
    width: 100%;
  }
  .frow:hover .ft {
    color: var(--ice);
  }
  .frow .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }
  .frow .ft {
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .frow .fs {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .frow .fc {
    font-family: var(--mono);
    font-size: 12px;
    text-align: right;
    white-space: nowrap;
  }
  .empty {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
    padding: 18px 0;
  }

  /* leaderboards (the original design's "Most flaky" list) */
  .top-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 20px;
  }
  .flist {
    display: flex;
    flex-direction: column;
  }
  .fl {
    display: grid;
    grid-template-columns: 26px minmax(0, 1fr) auto;
    gap: 6px 14px;
    align-items: center;
    padding: 12px 6px;
    border-bottom: 1px dashed color-mix(in srgb, var(--line) 50%, transparent);
    text-align: left;
    width: 100%;
  }
  .fl:hover .ft {
    color: var(--accent, var(--flaky));
  }
  .fl .rk {
    font-family: var(--display);
    font-size: 13px;
    color: var(--dim);
  }
  .fl .ft {
    font-size: 14px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Wraps, so "ran in 23 of 59 executions" is never cut off. */
  .fl .fs {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
    margin-top: 2px;
  }
  .fl .rate {
    font-family: var(--display);
    font-size: 18px;
    color: var(--accent, var(--flaky));
    text-align: right;
    white-space: nowrap;
  }
  .fl .rate small {
    display: block;
    font-family: var(--mono);
    font-size: 10px;
    color: var(--muted);
  }
  .note {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
  }

  @media (max-width: 1000px) {
    .day-grid,
    .top-grid {
      grid-template-columns: minmax(0, 1fr);
    }
    .sumrow {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }
  @media (max-width: 720px) {
    .sumrow {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .runrow {
      grid-template-columns: 46px minmax(0, 1fr) 56px;
      row-gap: 6px;
    }
    .runrow .br,
    .runrow .stack {
      grid-column: 2/4;
    }
    .runrow .br {
      order: 3;
    }
    .vright {
      align-items: flex-start;
    }
  }
`;
