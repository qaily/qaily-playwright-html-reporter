// The design tokens every theme must define. Pages and components use only these.

export interface TokenDef {
  name: `--q-${string}`;
  label: string;
  kind: 'color' | 'font' | 'length' | 'shadow';
}

export const TOKENS: TokenDef[] = [
  { name: '--q-bg', label: 'Page background', kind: 'color' },
  { name: '--q-surface', label: 'Card background', kind: 'color' },
  { name: '--q-surface-2', label: 'Raised / hover background', kind: 'color' },
  { name: '--q-border', label: 'Border', kind: 'color' },
  { name: '--q-text', label: 'Text', kind: 'color' },
  { name: '--q-text-muted', label: 'Muted text', kind: 'color' },
  { name: '--q-accent', label: 'Accent', kind: 'color' },
  { name: '--q-on-accent', label: 'Text on accent', kind: 'color' },
  { name: '--q-good', label: 'Health: good', kind: 'color' },
  { name: '--q-warn', label: 'Health: warning', kind: 'color' },
  { name: '--q-bad', label: 'Health: bad', kind: 'color' },
  { name: '--q-none', label: 'Health: no data', kind: 'color' },
  { name: '--q-on-status', label: 'Text on health colours', kind: 'color' },
  { name: '--q-pass', label: 'Status: passed', kind: 'color' },
  { name: '--q-fail', label: 'Status: failed', kind: 'color' },
  { name: '--q-flaky', label: 'Status: flaky', kind: 'color' },
  { name: '--q-skip', label: 'Status: skipped', kind: 'color' },
  { name: '--q-running', label: 'Status: running', kind: 'color' },
  { name: '--q-font', label: 'Body font', kind: 'font' },
  { name: '--q-font-display', label: 'Heading font', kind: 'font' },
  { name: '--q-font-mono', label: 'Monospace font', kind: 'font' },
  { name: '--q-radius', label: 'Corner radius', kind: 'length' },
  { name: '--q-shadow', label: 'Card shadow', kind: 'shadow' },
];
