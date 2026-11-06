// Qaily Chronoscope (the Chronoscope design): a single dark world, void blue-black with glass panels.
export const css = `
@import url('https://fonts.googleapis.com/css2?family=Unbounded:wght@300;500;700;800&family=Manrope:wght@400;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap');
:root {
  --q-font: 'Manrope', system-ui, -apple-system, 'Segoe UI', sans-serif;
  --q-font-display: 'Unbounded', 'Arial Black', system-ui, sans-serif;
  --q-font-mono: 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace;
  --q-radius: 14px;
  --q-bg: #04060c;
  --q-surface: rgba(16, 24, 42, 0.78);
  --q-surface-2: rgba(28, 40, 66, 0.86);
  --q-border: rgba(150, 180, 255, 0.18);
  --q-text: #e8efff;
  --q-text-muted: #8a97b6;
  --q-accent: #b6a6ff;
  --q-on-accent: #0b0820;
  --q-good: #1fbf7f;
  --q-warn: #d9a12b;
  --q-bad: #e8435f;
  --q-none: #3a4560;
  --q-on-status: #04060c;
  --q-pass: #34f3a0;
  --q-fail: #ff4d6d;
  --q-flaky: #ffc247;
  --q-skip: #7d8aa8;
  --q-running: #4db6ff;
  --q-shadow: 0 18px 40px -12px rgba(0, 0, 0, 0.8), inset 0 1px 0 rgba(255, 255, 255, 0.08);
  --q-series-1: #8fe6ff; --q-series-2: #b6a6ff; --q-series-3: #34f3a0; --q-series-4: #ff4d6d;
  --q-series-5: #ffc247; --q-series-6: #4db6ff; --q-series-7: #ff8ad8; --q-series-8: #e8efff;
}
qaily-shell {
  background: #04060c;
  isolation: isolate;
}
/* The glow sits on its own fixed layer: a fixed background-attachment would repaint the whole page on every scroll. */
qaily-shell::before {
  content: '';
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background: radial-gradient(ellipse at 50% 0%, #0e1a35 0%, #04060c 60%);
}
`;
