// One render function per FieldEditor kind. Editors call onChange with the whole new value;
// the settings view validates it against the field schema before saving.

import type { Band, CoverageRule, FieldDef, HealthLevel, Lane, PageContext, PathMapping } from '@qaily/contracts';
import { checkCoverageRule, evaluateRules, healthLevel } from '@qaily/contracts';
import { LEVEL_GLYPH, TOKENS, html, live, nothing, styleMap, type TemplateResult } from '@qaily/ui';

export interface EditorArgs {
  field: FieldDef;
  value: unknown;
  disabled: boolean;
  ctx: PageContext;
  onChange: (value: unknown) => void;
  /** In team mode: the page's team save button ("Save to bucket", …), for editors that cover the page (the full-screen rules editor). */
  team?: { dirty: boolean; canSave: boolean; saving: boolean; save: () => void; label: string };
}

const LEVELS: HealthLevel[] = ['good', 'warn', 'bad'];
const LEVEL_TEXT: Record<HealthLevel, string> = { good: 'Green (good)', warn: 'Yellow (warning)', bad: 'Red (bad)' };

const inputValue = (e: Event) => (e.target as HTMLInputElement | HTMLSelectElement).value;
const optionalNumber = (raw: string): number | undefined => (raw.trim() === '' ? undefined : Number(raw));

function replaceAt<T>(list: readonly T[], index: number, item: T): T[] {
  return list.map((x, i) => (i === index ? item : x));
}

function move<T>(list: readonly T[], index: number, delta: number): T[] {
  const next = [...list];
  const target = index + delta;
  if (target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Example values around each band edge, so the user sees exactly where colours flip. */
function bandExamples(bands: Band[]): number[] {
  const values = new Set<number>();
  for (const b of bands) {
    if (b.min !== undefined) values.add(b.min).add(Math.round((b.min - 0.1) * 10) / 10);
    if (b.max !== undefined) values.add(b.max).add(Math.round((b.max + 0.1) * 10) / 10);
  }
  return [...values].filter((v) => v >= 0).sort((a, b) => b - a).slice(0, 8);
}

function bandsEditor({ value, disabled, onChange, field }: EditorArgs): TemplateResult {
  const bands = value as Band[];
  const unit = field.editor.kind === 'bands' ? field.editor.unit : '';
  const set = (i: number, patch: Partial<Band>) => {
    const next = { ...bands[i], ...patch };
    if (next.min === undefined) delete next.min;
    if (next.max === undefined) delete next.max;
    onChange(replaceAt(bands, i, next));
  };
  return html`
    <table class="rows">
      <thead><tr><th>Colour</th><th>From (≥)</th><th>To (≤)</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
      <tbody>
        ${bands.map(
          (b, i) => html`<tr>
            <td>
              <select ?disabled=${disabled} @change=${(e: Event) => set(i, { level: inputValue(e) as HealthLevel })} aria-label="Colour">
                ${LEVELS.map((l) => html`<option value=${l} ?selected=${l === b.level}>${LEVEL_TEXT[l]}</option>`)}
              </select>
            </td>
            <td><input type="number" step="any" placeholder="any" aria-label="From" .value=${live(b.min?.toString() ?? '')}
              ?disabled=${disabled} @change=${(e: Event) => set(i, { min: optionalNumber(inputValue(e)) })} /> ${unit}</td>
            <td><input type="number" step="any" placeholder="any" aria-label="To" .value=${live(b.max?.toString() ?? '')}
              ?disabled=${disabled} @change=${(e: Event) => set(i, { max: optionalNumber(inputValue(e)) })} /> ${unit}</td>
            <td class="actions">
              <button ?disabled=${disabled || i === 0} @click=${() => onChange(move(bands, i, -1))} aria-label="Move up"><q-icon name="arrow-up"></q-icon></button>
              <button ?disabled=${disabled || i === bands.length - 1} @click=${() => onChange(move(bands, i, 1))} aria-label="Move down"><q-icon name="arrow-down"></q-icon></button>
              <button ?disabled=${disabled || bands.length === 1} @click=${() => onChange(bands.filter((_, j) => j !== i))} aria-label="Remove band"><q-icon name="trash"></q-icon></button>
            </td>
          </tr>`,
        )}
      </tbody>
    </table>
    <button ?disabled=${disabled} @click=${() => onChange([...bands, { level: 'bad' }])}><q-icon name="plus"></q-icon> Add band</button>
    <div class="preview" aria-label="Examples">
      ${bandExamples(bands).map((v) => {
        const level = healthLevel(bands, v);
        return html`<span class="swatch level-${level}">${LEVEL_GLYPH[level]} ${v}${unit}</span>`;
      })}
    </div>
  `;
}

function lanesEditor({ value, disabled, onChange }: EditorArgs): TemplateResult {
  const lanes = value as Lane[];
  const set = (i: number, patch: Partial<Lane> & { match?: Partial<Lane['match']> }) => {
    const lane = lanes[i];
    const match = { ...lane.match, ...patch.match };
    for (const k of Object.keys(match) as (keyof Lane['match'])[]) if (!match[k]) delete match[k];
    onChange(replaceAt(lanes, i, { ...lane, ...patch, match }));
  };
  const text = (i: number, v: string, label: string, apply: (v: string) => void, placeholder = '') =>
    html`<input .value=${live(v)} aria-label=${label} placeholder=${placeholder} ?disabled=${disabled}
      @change=${(e: Event) => apply(inputValue(e).trim())} data-row=${i} />`;
  return html`
    <div class="scroll">
      <table class="rows">
        <thead><tr><th>Id</th><th>Label</th><th>Category (regex)</th><th>Environment</th><th>Branch (regex)</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
        <tbody>
          ${lanes.map(
            (l, i) => html`<tr>
              <td>${text(i, l.id, 'Id', (v) => set(i, { id: v }))}</td>
              <td>${text(i, l.label, 'Label', (v) => set(i, { label: v }))}</td>
              <td>${text(i, l.match.category ?? '', 'Category', (v) => set(i, { match: { category: v } }), 'any')}</td>
              <td>${text(i, l.match.environment ?? '', 'Environment', (v) => set(i, { match: { environment: v } }), 'any')}</td>
              <td>${text(i, l.match.branch ?? '', 'Branch', (v) => set(i, { match: { branch: v } }), 'any')}</td>
              <td class="actions">
                <button ?disabled=${disabled || i === 0} @click=${() => onChange(move(lanes, i, -1))} aria-label="Move up"><q-icon name="arrow-up"></q-icon></button>
                <button ?disabled=${disabled || i === lanes.length - 1} @click=${() => onChange(move(lanes, i, 1))} aria-label="Move down"><q-icon name="arrow-down"></q-icon></button>
                <button ?disabled=${disabled || lanes.length === 1} @click=${() => onChange(lanes.filter((_, j) => j !== i))} aria-label="Remove lane"><q-icon name="trash"></q-icon></button>
              </td>
            </tr>`,
          )}
        </tbody>
      </table>
    </div>
    <button ?disabled=${disabled} @click=${() => onChange([...lanes, { id: `lane-${lanes.length + 1}`, label: 'New lane', match: {} }])}>
      <q-icon name="plus"></q-icon> Add lane
    </button>
  `;
}

function tokensEditor({ value, disabled, onChange }: EditorArgs): TemplateResult {
  const tokens = value as Record<string, string>;
  const computed = getComputedStyle(document.documentElement);
  const set = (name: string, v: string) => {
    const next = { ...tokens };
    if (v.trim()) next[name] = v.trim();
    else delete next[name];
    onChange(next);
  };
  return html`<div class="tokens">
    ${TOKENS.map((t) => {
      const current = tokens[t.name] ?? '';
      const effective = current || computed.getPropertyValue(t.name).trim();
      const isHex = /^#[0-9a-f]{6}$/i.test(effective);
      return html`<label class="token">
        <span>${t.label} <code>${t.name}</code></span>
        <span class="token-input">
          ${t.kind === 'color' && isHex
            ? html`<input type="color" .value=${live(effective)} ?disabled=${disabled} aria-label="${t.label} colour"
                @change=${(e: Event) => set(t.name, inputValue(e))} />`
            : t.kind === 'color'
              ? html`<span class="chip-color" style=${styleMap({ background: effective })}></span>`
              : nothing}
          <input .value=${live(current)} placeholder=${effective} ?disabled=${disabled} aria-label=${t.label}
            @change=${(e: Event) => set(t.name, inputValue(e))} />
          ${current ? html`<button ?disabled=${disabled} @click=${() => set(t.name, '')} aria-label="Clear ${t.label}">✕</button>` : nothing}
        </span>
      </label>`;
    })}
  </div>`;
}

function pathMapEditor({ value, disabled, onChange }: EditorArgs): TemplateResult {
  const rows = value as PathMapping[];
  return html`
    <table class="rows">
      <thead><tr><th>CI path prefix</th><th>Local path</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
      <tbody>
        ${rows.map(
          (r, i) => html`<tr>
            <td><input class="wide" .value=${live(r.from)} ?disabled=${disabled} aria-label="CI path prefix"
              @change=${(e: Event) => onChange(replaceAt(rows, i, { ...r, from: inputValue(e) }))} /></td>
            <td><input class="wide" .value=${live(r.to)} ?disabled=${disabled} aria-label="Local path"
              @change=${(e: Event) => onChange(replaceAt(rows, i, { ...r, to: inputValue(e) }))} /></td>
            <td><button ?disabled=${disabled} @click=${() => onChange(rows.filter((_, j) => j !== i))} aria-label="Remove mapping"><q-icon name="trash"></q-icon></button></td>
          </tr>`,
        )}
      </tbody>
    </table>
    <button ?disabled=${disabled} @click=${() => onChange([...rows, { from: '/runner/_work/', to: '' }])}><q-icon name="plus"></q-icon> Add mapping</button>
  `;
}

function viewsEditor({ value, disabled, onChange, ctx }: EditorArgs): TemplateResult {
  const views = value as Record<string, string>;
  const pages = ctx.registry.pages.filter((p) => p.views.length > 1);
  if (!pages.length) return html`<p class="muted">Every page has only the classic view so far. Themes with their own views will appear here.</p>`;
  return html`${pages.map(
    (p) => html`<label class="inline">${p.title}
      <select ?disabled=${disabled} @change=${(e: Event) => {
        const next = { ...views };
        const v = inputValue(e);
        if (v) next[p.id] = v;
        else delete next[p.id];
        onChange(next);
      }}>
        <option value="" ?selected=${!views[p.id]}>Theme default</option>
        ${p.views.map((v) => html`<option value=${v} ?selected=${views[p.id] === v}>${v}</option>`)}
      </select></label
    >`,
  )}`;
}

const RULE_FIELDS: { key: keyof CoverageRule & string; label: string; cond?: boolean }[] = [
  { key: 'step', label: 'Step', cond: true },
  { key: 'tag', label: 'Tag', cond: true },
  { key: 'title', label: 'Test title', cond: true },
  { key: 'file', label: 'File', cond: true },
  { key: 'component', label: 'Component' },
  { key: 'scenario', label: 'Scenario' },
  { key: 'feature', label: 'Feature' },
  { key: 'area', label: 'Area' },
];

/** Preview box: shows where a step title would land with the current rules. */
let rulePreview = { step: '', title: '', tags: '' };
/** The rules editor fills the window (many columns; small inputs otherwise). */
let rulesFull = false;
const rerender = (el: EventTarget | null) => el?.dispatchEvent(new CustomEvent('preview', { bubbles: true, composed: true }));

function coverageRulesEditor({ value, disabled, onChange, ctx, team }: EditorArgs): TemplateResult {
  const rules = value as CoverageRule[];
  const levels = ctx.settings.coverage.levels;
  const label = (key: string, fallback: string) => {
    const i = ['component', 'scenario', 'feature', 'area'].indexOf(key);
    return i >= 0 ? levels[i] ?? fallback : fallback;
  };
  const set = (i: number, key: keyof CoverageRule, v: string | boolean) => {
    const next: CoverageRule = { ...rules[i] };
    if (v === '' || v === false) delete next[key];
    else (next as Record<string, unknown>)[key] = v;
    onChange(replaceAt(rules, i, next));
  };
  const preview = evaluateRules(rules, {
    step: rulePreview.step,
    title: rulePreview.title,
    tags: rulePreview.tags.split(',').map((t) => t.trim()).filter(Boolean),
  });
  const setFull = (e: Event, on: boolean) => {
    rulesFull = on;
    rerender(e.currentTarget);
  };
  return html`<div class="rules-wrap ${rulesFull ? 'full' : ''}" role=${rulesFull ? 'dialog' : nothing} aria-label=${rulesFull ? 'Mapping rules' : nothing}
    @keydown=${(e: KeyboardEvent) => e.key === 'Escape' && rulesFull && setFull(e, false)}>
    <div class="rules-bar">
      ${rulesFull ? html`<b>Mapping rules</b> <span class="muted">${rules.length} rules · Esc to close</span>` : nothing}
      <span class="grow"></span>
      ${rulesFull && team
        ? html`${team.dirty ? html`<span class="muted">Unsaved changes</span>` : nothing}
            <button class="primary" ?disabled=${!team.dirty || !team.canSave || team.saving} @click=${team.save}>
              ${team.saving ? 'Saving…' : team.label}</button>`
        : nothing}
      <button @click=${(e: Event) => setFull(e, !rulesFull)} aria-pressed=${rulesFull}>
        <q-icon name=${rulesFull ? 'minimize' : 'maximize'}></q-icon> ${rulesFull ? 'Close full screen' : 'Full screen'}</button>
    </div>
    <div class="scroll">
      <table class="rows rules">
        <thead><tr>
          ${RULE_FIELDS.map((f) => html`<th class=${f.cond ? 'cond' : ''}>${f.cond ? f.label : label(f.key, f.label)}</th>`)}
          <th class="ic" title="Ignore case">Aa</th><th><span class="visually-hidden">Actions</span></th>
        </tr></thead>
        <tbody>
          ${rules.map((r, i) => {
            const problem = checkCoverageRule(r);
            return html`<tr class=${problem ? 'bad' : ''} title=${problem ?? ''}>
              ${RULE_FIELDS.map(
                (f) => html`<td><input class=${f.cond ? 'mono' : ''} .value=${live(String(r[f.key] ?? ''))} ?disabled=${disabled}
                  aria-label="Rule ${i + 1} ${f.label}" placeholder=${f.cond ? 'regex' : ''}
                  @change=${(e: Event) => set(i, f.key, inputValue(e))} /></td>`,
              )}
              <td class="ic"><input type="checkbox" .checked=${live(!!r.ignoreCase)} ?disabled=${disabled} aria-label="Rule ${i + 1} ignore case"
                @change=${(e: Event) => set(i, 'ignoreCase', (e.target as HTMLInputElement).checked)} /></td>
              <td class="actions">
                <button ?disabled=${disabled || i === 0} @click=${() => onChange(move(rules, i, -1))} aria-label="Move up"><q-icon name="arrow-up"></q-icon></button>
                <button ?disabled=${disabled || i === rules.length - 1} @click=${() => onChange(move(rules, i, 1))} aria-label="Move down"><q-icon name="arrow-down"></q-icon></button>
                <button ?disabled=${disabled} @click=${() => onChange(rules.filter((_, j) => j !== i))} aria-label="Remove rule"><q-icon name="trash"></q-icon></button>
              </td>
            </tr>`;
          })}
        </tbody>
      </table>
    </div>
    <button ?disabled=${disabled} @click=${() => onChange([...rules, { step: '', feature: '' } as CoverageRule])}><q-icon name="plus"></q-icon> Add rule</button>
    <div class="rule-preview">
      <b>Try it</b>
      <input class="wide mono" placeholder="Step title, e.g. When I archive the board &quot;Sprint 12&quot;" .value=${rulePreview.step}
        @input=${(e: Event) => { rulePreview = { ...rulePreview, step: inputValue(e) }; (e.target as HTMLElement).dispatchEvent(new CustomEvent('preview', { bubbles: true, composed: true })); }} aria-label="Step title to try" />
      <input placeholder="Test title (optional)" .value=${rulePreview.title}
        @input=${(e: Event) => { rulePreview = { ...rulePreview, title: inputValue(e) }; (e.target as HTMLElement).dispatchEvent(new CustomEvent('preview', { bubbles: true, composed: true })); }} aria-label="Test title to try" />
      <input placeholder="Tags, comma-separated (optional)" .value=${rulePreview.tags}
        @input=${(e: Event) => { rulePreview = { ...rulePreview, tags: inputValue(e) }; (e.target as HTMLElement).dispatchEvent(new CustomEvent('preview', { bubbles: true, composed: true })); }} aria-label="Tags to try" />
      <span class="muted">
        ${rulePreview.step
          ? preview
            ? html`→ ${levels.map((l, i) => html`${l}: <b>${preview[(['component', 'scenario', 'feature', 'area'] as const)[i]]}</b>${i < 3 ? ' · ' : ''}`)}`
            : 'Not a hit: no rule with a Step condition matches.'
          : ''}
      </span>
    </div>
  </div>`;
}

export function renderEditor(args: EditorArgs): TemplateResult {
  const { field, value, disabled, onChange, ctx } = args;
  const e = field.editor;
  switch (e.kind) {
    case 'bands':
      return bandsEditor(args);
    case 'lanes':
      return lanesEditor(args);
    case 'tokens':
      return tokensEditor(args);
    case 'path-map':
      return pathMapEditor(args);
    case 'views':
      return viewsEditor(args);
    case 'boolean':
      return html`<input type="checkbox" .checked=${live(Boolean(value))} ?disabled=${disabled} aria-label=${field.label}
        @change=${(ev: Event) => onChange((ev.target as HTMLInputElement).checked)} />`;
    case 'number':
      return html`<input type="number" min=${e.min ?? nothing} max=${e.max ?? nothing} step=${e.step ?? 1}
        .value=${live(String(value))} ?disabled=${disabled} aria-label=${field.label}
        @change=${(ev: Event) => onChange(Number(inputValue(ev)))} /> ${e.unit ?? ''}`;
    case 'select': {
      const options = e.options;
      return html`<select ?disabled=${disabled} aria-label=${field.label}
        @change=${(ev: Event) => {
          const raw = inputValue(ev);
          onChange(options.find((o) => String(o.value) === raw)?.value ?? raw);
        }}>
        ${options.map((o) => html`<option value=${o.value} ?selected=${o.value === value}>${o.label}</option>`)}
      </select>`;
    }
    case 'theme':
      return html`<select ?disabled=${disabled} aria-label=${field.label} @change=${(ev: Event) => onChange(inputValue(ev))}>
        ${ctx.registry.themes.map((t) => html`<option value=${t.id} ?selected=${t.id === value}>${t.label}</option>`)}
      </select>`;
    case 'page':
      return html`<select ?disabled=${disabled} aria-label=${field.label} @change=${(ev: Event) => onChange(inputValue(ev))}>
        ${ctx.registry.pages.map((p) => html`<option value=${p.id} ?selected=${p.id === value}>${p.title}</option>`)}
      </select>`;
    case 'string-list':
      return html`<input class="wide" .value=${live((value as string[]).join(', '))} placeholder=${e.placeholder ?? ''}
        ?disabled=${disabled} aria-label=${field.label}
        @change=${(ev: Event) => onChange(inputValue(ev).split(',').map((s) => s.trim()).filter(Boolean))} />
        <span class="muted">comma-separated</span>`;
    case 'text':
      return html`<input class="wide" .value=${live(String(value ?? ''))} placeholder=${e.placeholder ?? ''}
        ?disabled=${disabled} aria-label=${field.label} @change=${(ev: Event) => onChange(inputValue(ev).trim())} />`;
    case 'coverage-rules':
      return coverageRulesEditor(args);
  }
}

/** Extra semantic checks the zod schemas can't express. Returns an error message or null. */
export function extraValidation(field: FieldDef, value: unknown): string | null {
  if (field.editor.kind === 'lanes') {
    const lanes = value as Lane[];
    const ids = new Set<string>();
    for (const l of lanes) {
      if (ids.has(l.id)) return `Lane id "${l.id}" is used twice`;
      ids.add(l.id);
      for (const re of [l.match.category, l.match.branch]) {
        if (!re) continue;
        try {
          new RegExp(re);
        } catch {
          return `"${re}" is not a valid regular expression`;
        }
      }
    }
  }
  if (field.editor.kind === 'coverage-rules') {
    const rules = value as CoverageRule[];
    for (const [i, r] of rules.entries()) {
      // Rows being filled in are allowed to be incomplete; only broken regexes block saving.
      const problem = checkCoverageRule(r);
      if (problem && /regular expression|lookaround/.test(problem)) return `Rule ${i + 1}: ${problem}`;
    }
  }
  if (field.editor.kind === 'bands') {
    for (const b of value as Band[]) {
      if (b.min !== undefined && b.max !== undefined && b.min > b.max) return `A band has "from" (${b.min}) above "to" (${b.max})`;
    }
  }
  return null;
}
