import { defineTheme } from '@qaily/contracts';

// The classic palette, light and dark.
const css = `
:root {
  --q-font: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --q-font-display: var(--q-font);
  --q-font-mono: 'IBM Plex Mono', 'Fira Code', Consolas, monospace;
  --q-radius: 8px;
}
:root[data-color-scheme='light'] {
  --q-bg: #fafbfc;
  --q-surface: #ffffff;
  --q-surface-2: #f4f6f8;
  --q-border: #e1e5ea;
  --q-text: #1a1d21;
  --q-text-muted: #616e7c;
  --q-accent: #2563eb;
  --q-on-accent: #ffffff;
  --q-good: #16a34a;
  --q-warn: #b45309;
  --q-bad: #dc2626;
  --q-none: #8a95a3;
  --q-on-status: #ffffff;
  --q-pass: #16a34a;
  --q-fail: #dc2626;
  --q-flaky: #d97706;
  --q-skip: #8a95a3;
  --q-running: #0284c7;
  --q-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05);
}
:root[data-color-scheme='dark'] {
  --q-bg: #0d1117;
  --q-surface: #161b22;
  --q-surface-2: #21262d;
  --q-border: #30363d;
  --q-text: #e6edf3;
  --q-text-muted: #8b949e;
  --q-accent: #58a6ff;
  --q-on-accent: #0d1117;
  --q-good: #238636;
  --q-warn: #9e6a03;
  --q-bad: #da3633;
  --q-none: #484f58;
  --q-on-status: #ffffff;
  --q-pass: #3fb950;
  --q-fail: #f85149;
  --q-flaky: #d29922;
  --q-skip: #6e7681;
  --q-running: #58a6ff;
  --q-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.3);
}
`;

export default defineTheme({ id: 'classic', label: 'Classic', css });
