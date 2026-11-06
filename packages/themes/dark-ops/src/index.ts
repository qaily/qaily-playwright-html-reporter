import { defineTheme } from '@qaily/contracts';

// The look of the first Qaily dashboards: dark only, teal accent, solid status blocks.
const css = `
:root {
  --q-font: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  --q-font-display: var(--q-font);
  --q-font-mono: Consolas, 'Courier New', monospace;
  --q-radius: 8px;
  --q-bg: #121212;
  --q-surface: #1e1e1e;
  --q-surface-2: #2c2c2c;
  --q-border: #3a3a3a;
  --q-text: #e0e0e0;
  --q-text-muted: #b0b0b0;
  --q-accent: #4ecdc4;
  --q-on-accent: #000000;
  --q-good: #2e7d32;
  --q-warn: #b26a00;
  --q-bad: #c62828;
  --q-none: #616161;
  --q-on-status: #ffffff;
  --q-pass: #4caf50;
  --q-fail: #ff6b6b;
  --q-flaky: #f7b538;
  --q-skip: #9e9e9e;
  --q-running: #4ecdc4;
  --q-shadow: 0 4px 6px rgb(0 0 0 / 0.2);
}
`;

export default defineTheme({ id: 'dark-ops', label: 'Dark Ops', css, forcedColorScheme: 'dark' });
