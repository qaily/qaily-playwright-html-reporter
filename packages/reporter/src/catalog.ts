// `qaily-report catalog`: the planned coverage matrix (a spreadsheet exported as CSV) → data/coverage-catalog.json.
// Columns: the four levels, top first. Empty cells inherit the value above (merged / filled-down cells in Excel),
// and a deeper level resets when a higher one changes.

import type { CatalogCell, CoverageCatalog } from '@qaily/contracts';

/** RFC 4180 CSV (quotes, doubled quotes, newlines in quotes). Detects ';' or tab separators from the header line. */
export function parseCsv(text: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const sep = [',', ';', '\t'].map((s) => [s, firstLine.split(s).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function catalogFromCsv(text: string, opts: { header?: boolean } = {}): CoverageCatalog {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  const header = opts.header !== false ? rows.shift() : undefined;
  const cells: CatalogCell[] = [];
  const current = ['', '', '', ''];
  const seen = new Set<string>();
  for (const raw of rows) {
    const values = [0, 1, 2, 3].map((i) => (raw[i] ?? '').replace(/\s+/g, ' ').trim());
    if (values.every((v) => !v)) continue;
    // A new value at one level clears the levels below it.
    const firstSet = values.findIndex((v) => v);
    for (let i = firstSet; i < 4; i++) current[i] = values[i] || (i === firstSet ? current[i] : '');
    if (!current[0] || !current[2]) continue; // a cell needs at least a component and a feature
    const cell = { component: current[0], scenario: current[1], feature: current[2], area: current[3] };
    const key = JSON.stringify(cell);
    if (!seen.has(key)) {
      seen.add(key);
      cells.push(cell);
    }
  }
  return { generatedAt: new Date().toISOString(), levels: header?.slice(0, 4).map((h) => h.trim()), cells };
}
