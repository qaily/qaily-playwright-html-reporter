// ANSI escape codes → Lit templates. Text is always bound as text (never innerHTML),
// and colours map to theme tokens so Playwright code frames follow the theme.

import { html, styleMap, type TemplateResult } from './lit.ts';

const COLORS = [
  'var(--q-text)', // black → normal text, so it stays visible on dark themes
  'var(--q-fail)', // red
  'var(--q-pass)', // green
  'var(--q-flaky)', // yellow
  'var(--q-accent)', // blue
  '#c678dd', // magenta
  'var(--q-accent)', // cyan
  'var(--q-text)', // white
];

interface Style {
  color?: string;
  background?: string;
  fontWeight?: string;
  opacity?: string;
  fontStyle?: string;
  textDecoration?: string;
}

function apply(style: Style, codes: number[]): Style {
  let s = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) s = {};
    else if (c === 1) s.fontWeight = '700';
    else if (c === 2) s.opacity = '0.7';
    else if (c === 3) s.fontStyle = 'italic';
    else if (c === 4) s.textDecoration = 'underline';
    else if (c === 22) delete s.fontWeight, delete s.opacity;
    else if (c === 39) delete s.color;
    else if (c === 49) delete s.background;
    else if (c >= 30 && c <= 37) s.color = COLORS[c - 30];
    else if (c >= 90 && c <= 97) s.color = c === 90 ? 'var(--q-text-muted)' : COLORS[c - 90];
    else if (c >= 40 && c <= 47) s.background = COLORS[c - 40];
    else if ((c === 38 || c === 48) && codes[i + 1] === 5) i += 2; // 256 colours: ignored, keep text readable
  }
  return s;
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

export function ansi(text: string | null | undefined): TemplateResult[] {
  if (!text) return [];
  const out: TemplateResult[] = [];
  const re = /\u001b\[([0-9;]*)m/g;
  let style: Style = {};
  let last = 0;
  let m: RegExpExecArray | null;
  const push = (chunk: string) => {
    if (!chunk) return;
    out.push(Object.keys(style).length ? html`<span style=${styleMap({ ...style })}>${chunk}</span>` : html`${chunk}`);
  };
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index));
    style = apply(style, m[1] ? m[1].split(';').map(Number) : [0]);
    last = re.lastIndex;
  }
  push(text.slice(last));
  return out;
}
