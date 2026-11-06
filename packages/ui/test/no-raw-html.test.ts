import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Agent output, test titles and error messages are untrusted text. They must only reach the DOM through Lit's
// escaped bindings: no innerHTML, no unsafeHTML. (unsafeSVG is allowed for the static icon set only.)
const root = join(__dirname, '../..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === 'node_modules' || name === 'test') return [];
    if (statSync(p).isDirectory()) return sources(p);
    return /\.ts$/.test(name) ? [p] : [];
  });
}

describe('no raw HTML rendering', () => {
  it('no source file uses innerHTML or unsafeHTML, and unsafeSVG only renders icons', () => {
    const offenders: string[] = [];
    for (const file of sources(root)) {
      // Comments may mention the forbidden APIs; only code counts.
      const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|unsafeHTML/.test(text)) offenders.push(file);
      if (/unsafeSVG\(/.test(text) && !file.endsWith(join('ui', 'src', 'components.ts'))) offenders.push(`${file} (unsafeSVG)`);
    }
    expect(offenders).toEqual([]);
  });
});
