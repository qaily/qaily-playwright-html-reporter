// Styles of the Chronoscope view, from the Chronoscope design. A single dark world by design.
import { css } from '@qaily/ui';

export const styles = css`
  :host {
    --void: #04060c;
    --glass: rgba(16, 24, 42, 0.58);
    --glass-hi: rgba(28, 40, 66, 0.72);
    --line: rgba(150, 180, 255, 0.16);
    --line-hi: rgba(190, 210, 255, 0.32);
    --ink: #e8efff;
    --ink-2: #b4c1dc;
    --mute: #7d8aa8;
    --ice: #8fe6ff;
    --brand: #b6a6ff;
    --pass: #34f3a0;
    --fail: #ff4d6d;
    --flaky: #ffc247;
    --run: #4db6ff;
    --f-display: var(--q-font-display, 'Unbounded', 'Arial Black', system-ui, sans-serif);
    --f-body: var(--q-font, 'Manrope', system-ui, sans-serif);
    --f-mono: var(--q-font-mono, 'JetBrains Mono', ui-monospace, Menlo, monospace);
    display: block;
    position: relative;
    color: var(--ink);
    font-family: var(--f-body);
    font-size: 14px;
    color-scheme: dark;
  }
  #gl {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    z-index: 0;
    background: radial-gradient(ellipse at 50% 20%, #0e1a35 0%, var(--void) 60%);
  }
  #spacer {
    position: relative;
    width: 1px;
  }
  #world {
    position: fixed;
    inset: 0;
    z-index: 5;
    pointer-events: none;
    overflow: hidden;
  }
  .pos {
    position: absolute;
    left: 0;
    top: 0;
    will-change: transform, opacity;
    pointer-events: none;
  }
  .pos.off {
    visibility: hidden;
  }

  /* ---------- hour + day labels ---------- */
  .hour {
    font-family: var(--f-mono);
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1;
    white-space: nowrap;
    transform-origin: center;
    color: transparent;
    background: linear-gradient(180deg, #ffffff 0%, #cfefff 45%, #6fb7ff 100%);
    -webkit-background-clip: text;
    background-clip: text;
    filter: drop-shadow(0 0 10px rgba(120, 200, 255, 0.6)) drop-shadow(0 2px 0 rgba(40, 90, 180, 0.6));
  }
  .hour small {
    display: block;
    font-size: 0.22em;
    letter-spacing: 0.2em;
    text-align: center;
    margin-top: 0.35em;
    font-weight: 500;
    -webkit-text-fill-color: var(--ink-2);
    opacity: 0.75;
  }
  .day {
    font-family: var(--f-display);
    font-weight: 800;
    white-space: nowrap;
    line-height: 0.9;
    text-transform: uppercase;
    color: transparent;
    -webkit-text-stroke: 1px rgba(182, 166, 255, 0.38);
    letter-spacing: 0.04em;
  }
  .day span {
    display: block;
    font-family: var(--f-mono);
    font-weight: 500;
    -webkit-text-stroke: 0;
    color: var(--brand);
    font-size: 0.18em;
    letter-spacing: 0.3em;
    margin-top: 0.5em;
    opacity: 0.85;
  }
  .now {
    font-family: var(--f-mono);
    font-size: 12px;
    letter-spacing: 0.18em;
    color: var(--ice);
    display: flex;
    align-items: center;
    gap: 8px;
    white-space: nowrap;
  }
  .now i {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--run);
    box-shadow: 0 0 12px var(--run);
    animation: beat 1.4s infinite;
  }
  @keyframes beat {
    0%,
    100% {
      transform: scale(1);
      opacity: 1;
    }
    50% {
      transform: scale(1.7);
      opacity: 0.4;
    }
  }

  /* ---------- run cards ---------- */
  .card {
    --c: var(--pass);
    pointer-events: auto;
    cursor: pointer;
    width: 236px;
    box-sizing: border-box;
    padding: 11px 12px 10px;
    border-radius: 14px;
    background: linear-gradient(155deg, rgba(255, 255, 255, 0.09), rgba(255, 255, 255, 0.015) 40%), var(--glass);
    border: 1px solid color-mix(in srgb, var(--c) 38%, transparent);
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4), 0 18px 40px -12px rgba(0, 0, 0, 0.8), 0 0 28px -6px color-mix(in srgb, var(--c) 45%, transparent),
      inset 0 1px 0 rgba(255, 255, 255, 0.12);
    -webkit-backdrop-filter: blur(10px) saturate(140%);
    backdrop-filter: blur(10px) saturate(140%);
    transition: opacity 0.55s ease, transform 0.55s cubic-bezier(0.2, 0.8, 0.2, 1), filter 0.55s ease, box-shadow 0.3s ease;
    position: relative;
    overflow: hidden;
    outline: none;
    container-type: inline-size;
  }
  .card::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    background: linear-gradient(115deg, transparent 30%, rgba(255, 255, 255, 0.14) 45%, transparent 60%);
    background-size: 250% 100%;
    background-position: 120% 0;
    transition: background-position 0.7s ease;
  }
  .card:hover::after,
  .card:focus-visible::after {
    background-position: -30% 0;
  }
  .card:hover,
  .card:focus-visible,
  .card.hl {
    transform: scale(1.06);
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4), 0 24px 50px -10px rgba(0, 0, 0, 0.9), 0 0 46px -4px color-mix(in srgb, var(--c) 70%, transparent),
      inset 0 1px 0 rgba(255, 255, 255, 0.2);
  }
  .card:focus-visible {
    outline: 2px solid var(--c);
    outline-offset: 3px;
  }
  @container (max-width:210px) {
    .c-counts .dur {
      display: none;
    }
    .gauge {
      width: 42px;
      height: 42px;
    }
    .c-main {
      gap: 8px;
    }
  }
  @container (max-width:165px) {
    .gauge,
    .c-meta .proj {
      display: none;
    }
    .wave {
      height: 18px;
      margin-top: 4px;
    }
    .c-suite {
      font-size: 12px;
      white-space: normal;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }
    .c-top {
      font-size: 9px;
      letter-spacing: 0.06em;
    }
    .pill {
      font-size: 8px;
      padding: 2px 5px;
      letter-spacing: 0.08em;
    }
    .c-counts {
      gap: 7px;
      font-size: 10px;
    }
    .c-counts .n-s,
    .c-counts .n-k {
      display: none;
    }
  }
  @container (max-width:120px) {
    .c-top span:first-child {
      display: none;
    }
    .c-top {
      justify-content: flex-start;
    }
    .wave {
      display: none;
    }
  }
  .card.sel {
    box-shadow: 0 0 0 2px var(--c), 0 0 60px -2px color-mix(in srgb, var(--c) 80%, transparent);
  }
  .card.gone {
    opacity: 0;
    transform: scale(0.55);
    filter: blur(10px);
    pointer-events: none;
  }
  .s-passed {
    --c: var(--pass);
  }
  .s-failed {
    --c: var(--fail);
  }
  .s-flaky {
    --c: var(--flaky);
  }
  .s-running {
    --c: var(--run);
  }
  .c-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-family: var(--f-mono);
    font-size: 10px;
    letter-spacing: 0.12em;
    color: var(--mute);
  }
  .pill {
    font-family: var(--f-mono);
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    padding: 3px 7px;
    border-radius: 99px;
    color: var(--c);
    background: color-mix(in srgb, var(--c) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--c) 40%, transparent);
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .s-running .pill::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--run);
    animation: beat 1.2s infinite;
  }
  .c-main {
    display: flex;
    gap: 10px;
    align-items: center;
    margin-top: 7px;
  }
  .c-text {
    flex: 1;
    min-width: 0;
  }
  .c-suite {
    font-weight: 700;
    font-size: 13.5px;
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .c-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
    font-size: 11.5px;
    color: var(--ink-2);
    min-width: 0;
  }
  .c-meta .proj {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .env {
    font-family: var(--f-mono);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    padding: 2px 5px;
    border-radius: 4px;
    flex: none;
  }
  .env-prod {
    color: #ffd9e0;
    background: rgba(255, 77, 109, 0.18);
    border: 1px solid rgba(255, 77, 109, 0.35);
  }
  .env-staging {
    color: #e2dbff;
    background: rgba(182, 166, 255, 0.16);
    border: 1px solid rgba(182, 166, 255, 0.35);
  }
  .env-dev {
    color: #cdeeff;
    background: rgba(143, 230, 255, 0.12);
    border: 1px solid rgba(143, 230, 255, 0.3);
  }
  .gauge {
    width: 50px;
    height: 50px;
    flex: none;
    filter: drop-shadow(0 0 6px color-mix(in srgb, var(--c) 70%, transparent));
  }
  .gauge .bg {
    fill: none;
    stroke: rgba(255, 255, 255, 0.08);
    stroke-width: 4.5;
  }
  .gauge .fg {
    fill: none;
    stroke: var(--c);
    stroke-width: 4.5;
    stroke-linecap: round;
    transform: rotate(-90deg);
    transform-origin: 26px 26px;
    transition: stroke-dasharray 0.8s ease;
  }
  .gauge text {
    fill: var(--ink);
    font-family: var(--f-mono);
    font-size: 11px;
    font-weight: 700;
    text-anchor: middle;
  }
  .gauge text.u {
    font-size: 6px;
    fill: var(--mute);
    letter-spacing: 0.12em;
    font-weight: 500;
  }
  .wave {
    display: block;
    width: 100%;
    height: 24px;
    margin-top: 6px;
    overflow: visible;
  }
  .wave polyline {
    fill: none;
    stroke: var(--c);
    stroke-width: 1.6;
    filter: drop-shadow(0 0 3px var(--c));
    vector-effect: non-scaling-stroke;
  }
  .c-counts {
    display: flex;
    gap: 10px;
    align-items: center;
    margin-top: 6px;
    font-family: var(--f-mono);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .c-counts b {
    font-weight: 700;
  }
  .n-p {
    color: var(--pass);
  }
  .n-f {
    color: var(--fail);
  }
  .n-s {
    color: var(--mute);
  }
  .n-k {
    color: var(--flaky);
  }
  .c-counts .dur {
    margin-left: auto;
    color: var(--mute);
    font-size: 10.5px;
  }
  .c-counts .z {
    opacity: 0.35;
  }
  .c-counts span {
    white-space: nowrap;
  }

  /* ---------- controls (stick under the shell header) ---------- */
  .filters {
    position: sticky;
    top: 60px;
    z-index: 9;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    padding: 0 64px 2px 0;
    pointer-events: none;
  }
  .filters > * {
    pointer-events: auto;
  }
  .fgroup {
    display: flex;
    gap: 4px;
    padding: 4px;
    border-radius: 12px;
    background: var(--glass);
    border: 1px solid var(--line);
    -webkit-backdrop-filter: blur(14px);
    backdrop-filter: blur(14px);
    flex: none;
  }
  .fgroup.brand {
    border-color: color-mix(in srgb, var(--brand) 45%, transparent);
    box-shadow: 0 0 18px -8px var(--brand);
  }
  .fgroup.brand label {
    color: var(--brand);
  }
  .fgroup label {
    font-family: var(--f-mono);
    font-size: 9.5px;
    letter-spacing: 0.16em;
    color: var(--mute);
    text-transform: uppercase;
    align-self: center;
    padding: 0 4px 0 6px;
  }
  .chip {
    font: 600 11.5px var(--f-body);
    color: var(--ink-2);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    padding: 5px 9px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }
  .chip .d {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--c, var(--ink-2));
    box-shadow: 0 0 8px var(--c, transparent);
  }
  .chip[aria-pressed='true'] {
    color: var(--ink);
    background: rgba(255, 255, 255, 0.09);
    border-color: var(--line-hi);
  }
  .chip[aria-pressed='false'] {
    opacity: 0.5;
  }
  .chip:focus-visible {
    outline: 2px solid var(--brand);
  }
  select.chip {
    appearance: none;
    -webkit-appearance: none;
    background: rgba(255, 255, 255, 0.06);
    padding-right: 22px;
    background-image: linear-gradient(45deg, transparent 50%, var(--ink-2) 50%), linear-gradient(135deg, var(--ink-2) 50%, transparent 50%);
    background-position: calc(100% - 11px) 50%, calc(100% - 7px) 50%;
    background-size: 4px 4px;
    background-repeat: no-repeat;
  }
  select.chip option {
    background: #0e1526;
    color: var(--ink);
  }
  .search {
    position: relative;
    flex: 0 1 240px;
    min-width: 160px;
  }
  .search input {
    width: 100%;
    box-sizing: border-box;
    background: var(--glass);
    border: 1px solid var(--line);
    border-radius: 12px;
    color: var(--ink);
    font: 500 12.5px var(--f-body);
    padding: 9px 12px 9px 32px;
    outline: none;
    -webkit-backdrop-filter: blur(14px);
    backdrop-filter: blur(14px);
  }
  .search input:focus {
    border-color: var(--brand);
  }
  .search svg {
    position: absolute;
    left: 11px;
    top: 50%;
    transform: translateY(-50%);
    width: 14px;
    height: 14px;
    stroke: var(--mute);
  }
  .rearr {
    font: 700 12px var(--f-body);
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 8px 12px;
    border-radius: 12px;
    cursor: pointer;
    flex: none;
    white-space: nowrap;
    color: var(--ink-2);
    background: var(--glass);
    border: 1px solid var(--line);
    -webkit-backdrop-filter: blur(14px);
    backdrop-filter: blur(14px);
    transition: color 0.2s, border-color 0.2s, box-shadow 0.2s;
  }
  .rearr:hover {
    color: var(--ink);
    border-color: var(--line-hi);
  }
  .rearr.stale {
    color: #0b0820;
    background: linear-gradient(135deg, #d6ccff, var(--brand) 60%, #8fe6ff);
    border-color: transparent;
    animation: nudge 2.4s ease-in-out infinite;
  }
  .rearr.on {
    color: var(--ice);
    border-color: color-mix(in srgb, var(--ice) 45%, transparent);
  }
  @keyframes nudge {
    0%,
    100% {
      box-shadow: 0 0 0 0 rgba(182, 166, 255, 0);
    }
    50% {
      box-shadow: 0 0 22px 2px rgba(182, 166, 255, 0.55);
    }
  }

  /* ---------- HUD: KPIs + minimap ---------- */
  .hud {
    position: fixed;
    z-index: 8;
  }
  .kpis {
    left: 16px;
    bottom: 16px;
    display: grid;
    grid-template-columns: repeat(4, auto);
    gap: 4px 22px;
    padding: 14px 18px;
    border-radius: 18px;
    background: var(--glass);
    border: 1px solid var(--line);
    -webkit-backdrop-filter: blur(16px);
    backdrop-filter: blur(16px);
    box-shadow: 0 20px 40px -14px rgba(0, 0, 0, 0.9);
  }
  .kpis .k {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .kpis .k span {
    font-family: var(--f-mono);
    font-size: 9.5px;
    letter-spacing: 0.16em;
    color: var(--mute);
    text-transform: uppercase;
  }
  .kpis .k b {
    font-family: var(--f-display);
    font-weight: 600;
    font-size: 22px;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
  }
  .kpis .k b em {
    font-style: normal;
    font-size: 0.55em;
    color: var(--mute);
    margin-left: 2px;
  }
  .kpis .pulse {
    grid-column: 1/-1;
    margin-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .kpis .pulse > span {
    font-family: var(--f-mono);
    font-size: 9.5px;
    letter-spacing: 0.16em;
    color: var(--mute);
    text-transform: uppercase;
    display: flex;
    justify-content: space-between;
  }
  .kpis svg {
    width: 100%;
    height: 42px;
    display: block;
    overflow: visible;
  }
  .kpis .legend {
    grid-column: 1/-1;
    max-width: 330px;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--line);
    font-size: 11px;
    line-height: 1.5;
    color: var(--ink-2);
  }
  .kpis .legend b {
    display: block;
    font-family: var(--f-mono);
    font-size: 9.5px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--mute);
    font-weight: 500;
    margin-bottom: 2px;
  }
  .mini {
    right: 14px;
    top: 132px;
    bottom: 76px;
    width: 58px;
    border-radius: 14px;
    background: var(--glass);
    border: 1px solid var(--line);
    -webkit-backdrop-filter: blur(14px);
    backdrop-filter: blur(14px);
    cursor: pointer;
    overflow: hidden;
  }
  .mini .track {
    position: absolute;
    inset: 10px 8px;
  }
  .mini .md {
    position: absolute;
    width: 5px;
    height: 3px;
    border-radius: 2px;
    transform: translateY(-50%);
  }
  .mini .mh {
    position: absolute;
    left: -2px;
    right: -2px;
    height: 1px;
    background: rgba(255, 255, 255, 0.06);
  }
  .mini .mday {
    position: absolute;
    left: -4px;
    right: -4px;
    border-top: 1px dashed rgba(182, 166, 255, 0.5);
    font-family: var(--f-mono);
    font-size: 8px;
    color: var(--brand);
    letter-spacing: 0.06em;
    padding-top: 2px;
  }
  .mini .view {
    position: absolute;
    left: -5px;
    right: -5px;
    border: 1px solid var(--ice);
    border-radius: 6px;
    background: rgba(143, 230, 255, 0.08);
    box-shadow: 0 0 14px -2px rgba(143, 230, 255, 0.6);
    transition: top 0.08s linear;
  }
  .hint {
    position: fixed;
    z-index: 7;
    left: 50%;
    bottom: 22px;
    transform: translateX(-50%);
    font-family: var(--f-mono);
    font-size: 10px;
    letter-spacing: 0.2em;
    color: var(--mute);
    text-transform: uppercase;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    transition: opacity 0.5s;
    pointer-events: none;
  }
  .hint i {
    width: 1px;
    height: 26px;
    background: linear-gradient(var(--ice), transparent);
    animation: drip 1.6s infinite;
  }
  @keyframes drip {
    0% {
      transform: scaleY(0);
      transform-origin: top;
    }
    50% {
      transform: scaleY(1);
      transform-origin: top;
    }
    51% {
      transform-origin: bottom;
    }
    100% {
      transform: scaleY(0);
      transform-origin: bottom;
    }
  }

  /* ---------- drawer ---------- */
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 45;
    background: rgba(2, 3, 8, 0.35);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.35s;
  }
  .scrim.on {
    opacity: 1;
    pointer-events: auto;
  }
  .drawer {
    position: fixed;
    z-index: 50;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(440px, 100%);
    box-sizing: border-box;
    padding: 18px 20px 24px 22px;
    background: linear-gradient(180deg, rgba(18, 26, 46, 0.92), rgba(8, 12, 24, 0.96));
    border-left: 1px solid var(--line-hi);
    -webkit-backdrop-filter: blur(22px);
    backdrop-filter: blur(22px);
    transform: translateX(105%);
    transition: transform 0.5s cubic-bezier(0.2, 0.8, 0.2, 1);
    overflow-y: auto;
    box-shadow: -30px 0 80px -20px rgba(0, 0, 0, 0.9);
  }
  .drawer.on {
    transform: none;
  }
  .dh {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .dh .id {
    font-family: var(--f-mono);
    font-size: 11px;
    color: var(--mute);
    letter-spacing: 0.12em;
  }
  .x {
    margin-left: auto;
    width: 34px;
    height: 34px;
    border-radius: 10px;
    border: 1px solid var(--line);
    background: rgba(255, 255, 255, 0.04);
    color: var(--ink);
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
  }
  .x:focus-visible {
    outline: 2px solid var(--brand);
  }
  .drawer h2 {
    font-family: var(--f-display);
    font-weight: 600;
    font-size: 23px;
    letter-spacing: -0.02em;
    margin: 14px 0 6px;
    text-wrap: balance;
  }
  .sub {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 12px;
    align-items: center;
    color: var(--ink-2);
    font-size: 12.5px;
  }
  .sub code {
    font-family: var(--f-mono);
    font-size: 11.5px;
    color: var(--ice);
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
    margin-top: 18px;
  }
  .stats div {
    padding: 10px;
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid var(--line);
  }
  .stats span {
    display: block;
    font-family: var(--f-mono);
    font-size: 9px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--mute);
  }
  .stats b {
    font-family: var(--f-display);
    font-weight: 600;
    font-size: 20px;
    font-variant-numeric: tabular-nums;
  }
  .stack {
    display: flex;
    height: 8px;
    border-radius: 99px;
    overflow: hidden;
    margin-top: 12px;
    background: rgba(255, 255, 255, 0.06);
  }
  .stack i {
    display: block;
    height: 100%;
  }
  .sec {
    margin-top: 24px;
  }
  .sec h3 {
    font-family: var(--f-mono);
    font-size: 10px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--mute);
    font-weight: 500;
    margin: 0 0 10px;
    display: flex;
    justify-content: space-between;
  }
  .ft {
    display: block;
    color: inherit;
    text-decoration: none;
    padding: 12px;
    border-radius: 12px;
    background: rgba(255, 77, 109, 0.06);
    border: 1px solid rgba(255, 77, 109, 0.22);
    margin-bottom: 8px;
  }
  a.ft:hover {
    border-color: rgba(255, 77, 109, 0.5);
  }
  .ft.flk {
    background: rgba(255, 194, 71, 0.06);
    border-color: rgba(255, 194, 71, 0.25);
  }
  .ft .t {
    font-weight: 600;
    font-size: 13px;
    line-height: 1.35;
  }
  .ft .f,
  .f.muted {
    font-family: var(--f-mono);
    font-size: 10.5px;
    color: var(--mute);
    margin-top: 3px;
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }
  .ft .f span:last-child {
    flex: none;
    white-space: nowrap;
  }
  .ft .f span:first-child {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ft pre {
    font-family: var(--f-mono);
    font-size: 11px;
    line-height: 1.5;
    color: #ffc2cd;
    background: rgba(0, 0, 0, 0.35);
    padding: 8px 10px;
    border-radius: 8px;
    margin: 8px 0 0;
    overflow: auto;
    white-space: pre-wrap;
    max-height: 9em;
  }
  .ft.flk pre {
    color: #ffe3a8;
  }
  .ok {
    padding: 14px;
    border-radius: 12px;
    border: 1px solid rgba(52, 243, 160, 0.25);
    background: rgba(52, 243, 160, 0.06);
    color: #bfffe3;
    font-size: 13px;
  }
  .trend svg {
    width: 100%;
    height: 110px;
    display: block;
  }
  .trend .ax {
    fill: var(--mute);
    font-family: var(--f-mono);
    font-size: 9px;
  }
  .actions {
    display: flex;
    gap: 8px;
    margin-top: 24px;
    flex-wrap: wrap;
  }
  .btn {
    font: 700 12.5px var(--f-body);
    color: #0b0820;
    background: linear-gradient(135deg, #d6ccff, var(--brand) 60%, #8fe6ff);
    border: 0;
    border-radius: 10px;
    padding: 9px 14px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    white-space: nowrap;
    box-shadow: 0 0 22px -6px var(--brand);
    text-decoration: none;
  }
  .btn:hover {
    filter: brightness(1.08);
  }
  .btn.ghost {
    background: rgba(255, 255, 255, 0.06);
    color: var(--ink);
    border: 1px solid var(--line);
    box-shadow: none;
  }
  .prog {
    height: 6px;
    border-radius: 99px;
    background: rgba(255, 255, 255, 0.07);
    overflow: hidden;
    margin-top: 12px;
  }
  .prog i {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, var(--run), #bfe9ff);
    box-shadow: 0 0 12px var(--run);
    transition: width 0.9s ease;
  }

  @media (max-width: 760px) {
    .kpis {
      left: 0;
      right: 0;
      bottom: 0;
      border-radius: 18px 18px 0 0;
      grid-template-columns: repeat(4, 1fr);
      gap: 2px 10px;
      padding: 10px 16px;
    }
    .kpis .k b {
      font-size: 16px;
    }
    .kpis .pulse,
    .kpis .legend,
    .hint,
    .chip.wide {
      display: none;
    }
    .mini {
      width: 14px;
      right: 6px;
      top: 150px;
      bottom: 84px;
      border-radius: 8px;
    }
    .mini .track {
      inset: 6px 3px;
    }
    .mini .md {
      width: 6px;
      left: 0 !important;
    }
    .mini .mday {
      font-size: 0;
    }
    .mini .view {
      left: -3px;
      right: -3px;
    }
    .card {
      padding: 10px 11px 9px;
    }
    .drawer {
      top: auto;
      width: 100%;
      height: 84%;
      border-left: 0;
      border-top: 1px solid var(--line-hi);
      border-radius: 22px 22px 0 0;
      transform: translateY(105%);
      padding: 16px 18px 24px;
    }
    .stats {
      grid-template-columns: repeat(2, 1fr);
    }
    .filters {
      flex-wrap: nowrap;
      overflow-x: auto;
      scrollbar-width: none;
      padding-right: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      animation: none !important;
      transition-duration: 0.01ms !important;
    }
  }
`;
