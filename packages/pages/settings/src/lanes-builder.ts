// Lane builder: lanes as readable conditions ("Category is ui:web"), with values offered from real runs
// and a live preview of which runs each lane gets. Stores the same regex strings as before.

import {
  compileMatch,
  describeMatch,
  discoverLaneValues,
  isCatchAll,
  isValidTimeZone,
  laneCoverage,
  laneFor,
  parseClock,
  patternMatches,
  slugify,
  startHours,
  suggestLanes,
  uniqueId,
  type Lane,
  type LaneTimeWindow,
  type LaneCoverage,
  type LaneGroup,
  type LaneValue,
  type LaneValues,
  type MatchMode,
  type PageContext,
  type RunRow,
} from '@qaily/contracts';
import { LitElement, baseStyles, css, html, live, nothing, type TemplateResult } from '@qaily/ui';

/** How far back the builder looks for values and previews. */
const DAYS = 90;

type PatternKey = 'category' | 'branch';

const MODES: { mode: MatchMode; label: string }[] = [
  { mode: 'any', label: 'any value' },
  { mode: 'is', label: 'is' },
  { mode: 'oneOf', label: 'is one of' },
  { mode: 'startsWith', label: 'starts with' },
  { mode: 'endsWith', label: 'ends with' },
  { mode: 'contains', label: 'contains' },
  { mode: 'regex', label: 'matches regex (advanced)' },
];

const FIELD = {
  category: { label: 'Category', source: html`reporter option <code>category</code>`, example: 'ui:web' },
  branch: { label: 'Branch', source: html`git branch of the run`, example: 'main' },
} as const;

const OTHER_ENV = '\u0000other';

const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** Time zones offered for a time window (the browser's list when it has one). */
const ZONES: string[] = (() => {
  const all = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  return [...new Set([LOCAL_ZONE, 'UTC', ...all])];
})();

const inputValue = (e: Event) => (e.target as HTMLInputElement | HTMLSelectElement).value;

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

const groupText = (g: LaneGroup) => [g.category ?? '(no category)', g.environment ?? '(no environment)'].join(' · ');

export class LanesBuilder extends LitElement {
  static properties = {
    ctx: { attribute: false },
    lanes: { attribute: false },
    disabled: { type: Boolean },
    onChange: { attribute: false },
    runs: { state: true },
    loadError: { state: true },
    overrides: { state: true },
    byEnvironment: { state: true },
  };
  declare ctx: PageContext;
  declare lanes: Lane[];
  declare disabled: boolean;
  declare onChange: (lanes: Lane[]) => void;
  declare runs: RunRow[] | null;
  declare loadError: string;
  /** Modes the user picked that the stored value can't show yet (e.g. "is" before a value is chosen). */
  declare overrides: Record<string, MatchMode | 'other'>;
  declare byEnvironment: boolean;

  /** Ids the builder made in this session: they follow the label until saved. */
  private fresh = new Set<string>();

  constructor() {
    super();
    this.lanes = [];
    this.disabled = false;
    this.runs = null;
    this.loadError = '';
    this.overrides = {};
    this.byEnvironment = false;
  }

  connectedCallback(): void {
    super.connectedCallback();
    if (this.runs === null && !this.loadError) void this.load();
  }

  private async load() {
    const to = new Date(Date.now() + 86_400_000);
    const from = new Date(Date.now() - DAYS * 86_400_000);
    try {
      this.runs = await this.ctx.data.runs({ from, to });
    } catch (err) {
      this.loadError = err instanceof Error ? err.message : String(err);
    }
  }

  // --- changes -------------------------------------------------------------------------------

  private emit(lanes: Lane[], structural = false) {
    if (structural) this.overrides = {};
    this.onChange(lanes);
  }

  private setLane(i: number, lane: Lane) {
    this.emit(replaceAt(this.lanes, i, lane));
  }

  private setMatch(i: number, key: 'category' | 'environment' | 'branch', value: string | undefined) {
    const lane = this.lanes[i];
    const match = { ...lane.match };
    if (value) match[key] = value;
    else delete match[key];
    this.setLane(i, { ...lane, match });
  }

  private setTime(i: number, time: LaneTimeWindow | undefined) {
    const lane = this.lanes[i];
    const match = { ...lane.match };
    if (time) match.time = time;
    else delete match.time;
    this.setLane(i, { ...lane, match });
  }

  private setOverride(key: string, mode: MatchMode | 'other' | undefined) {
    const next = { ...this.overrides };
    if (mode === undefined) delete next[key];
    else next[key] = mode;
    this.overrides = next;
  }

  private modeOf(i: number, key: PatternKey): MatchMode {
    const o = this.overrides[`${i}:${key}`];
    return o && o !== 'other' ? o : describeMatch(this.lanes[i].match[key]).mode;
  }

  private setMode(i: number, key: PatternKey, mode: MatchMode) {
    const spec = describeMatch(this.lanes[i].match[key]);
    const source = mode === 'regex' ? spec.source : compileMatch(mode, spec.values);
    this.setOverride(`${i}:${key}`, mode === 'any' ? undefined : mode);
    this.setMatch(i, key, source);
  }

  private setValues(i: number, key: PatternKey, values: string[]) {
    this.setMatch(i, key, compileMatch(this.modeOf(i, key), values));
  }

  private setLabel(i: number, label: string) {
    const lane = this.lanes[i];
    let id = lane.id;
    if (this.fresh.has(id) && label) {
      id = uniqueId(slugify(label), this.lanes.filter((_, j) => j !== i).map((l) => l.id));
      this.fresh.delete(lane.id);
      this.fresh.add(id);
    }
    this.setLane(i, { ...lane, id, label: label || lane.label });
  }

  /** New lanes go above a trailing catch-all, which has to stay last to be useful. */
  private insert(lane: Lane) {
    const lanes = [...this.lanes];
    const at = lanes.length > 0 && isCatchAll(lanes[lanes.length - 1]) ? lanes.length - 1 : lanes.length;
    lanes.splice(at, 0, lane);
    this.fresh.add(lane.id);
    this.emit(lanes, true);
  }

  private addLane() {
    const ids = this.lanes.map((l) => l.id);
    this.insert({ id: uniqueId(`lane-${this.lanes.length + 1}`, ids), label: 'New lane', match: {} });
  }

  private generate() {
    if (!this.runs) return;
    const next = suggestLanes(this.runs, this.byEnvironment);
    const ok = confirm(
      `Replace your ${this.lanes.length} lane(s) with ${next.length} lanes made from the runs of the last ${DAYS} days?\n\n` +
        next.map((l) => `• ${l.label}`).join('\n'),
    );
    if (!ok) return;
    this.fresh = new Set(next.map((l) => l.id));
    this.emit(next, true);
  }

  // --- render --------------------------------------------------------------------------------

  render() {
    const values = this.runs ? discoverLaneValues(this.runs) : null;
    const cov = this.runs ? laneCoverage(this.lanes, this.runs) : null;
    const noCategory = values !== null && values.total > 0 && values.category.length === 0;
    return html`
      ${this.explainer(values, noCategory)}
      ${this.status(values)}
      ${values ? this.datalists(values) : nothing}
      <datalist id="dl-zones">${ZONES.map((z) => html`<option value=${z}></option>`)}</datalist>
      <ol class="lanes">
        ${this.lanes.map((lane, i) => this.laneCard(lane, i, values, cov))}
      </ol>
      <div class="bar">
        <button ?disabled=${this.disabled} @click=${() => this.addLane()}><q-icon name="plus"></q-icon> Add lane</button>
        ${values && values.total > 0
          ? html`<span class="grow"></span>
              <label class="muted">Make lanes from my runs:
                <select ?disabled=${this.disabled} aria-label="Make one lane per"
                  @change=${(e: Event) => (this.byEnvironment = inputValue(e) === 'env')}>
                  <option value="cat" ?selected=${!this.byEnvironment}>one per category</option>
                  <option value="env" ?selected=${this.byEnvironment}>one per category and environment</option>
                </select>
              </label>
              <button ?disabled=${this.disabled} @click=${() => this.generate()}>Generate…</button>`
          : nothing}
      </div>
      ${cov ? this.unmatched(cov) : nothing}
    `;
  }

  private explainer(values: LaneValues | null, noCategory: boolean) {
    return html`<details class="explain" ?open=${noCategory}>
      <summary>What does a lane match, and where do the values come from?</summary>
      <p>A lane groups <b>runs</b> (one <code>npx playwright test</code> = one run), not single tests. Each run goes into
        the <b>first</b> lane whose conditions all match, so put specific lanes above general ones and keep a catch-all last.</p>
      <dl>
        <dt>Category</dt>
        <dd>The <code>category</code> option of the reporter in <code>playwright.config.ts</code>. It is <b>not</b> a test
          title, file, tag or project: one value for the whole run.</dd>
        <dt>Environment</dt>
        <dd>The <code>environment</code> reporter option. There is no fixed list: Monitoring's environment chips show every
          value your runs report. Pick one here to make a separate lane per environment, or leave it at <i>any</i> to keep
          all environments in one lane and filter them with the chips.</dd>
        <dt>Branch</dt>
        <dd>The git branch the run was on, detected from git or CI.</dd>
        <dt>Started</dt>
        <dd>The time of day the run started, e.g. <i>between 22:00 and 06:00</i> for nightly runs. The time zone is saved
          with the lane, so everyone's lanes are the same whatever their own time zone.</dd>
      </dl>
      <pre class="mono">reporter: [['@qaily/playwright-html-reporter', {
  category: 'ui:web',                              // → Category
  environment: process.env.TEST_ENV ?? 'local',    // → Environment
}]]</pre>
      ${noCategory
        ? html`<p class="warn">None of the ${values?.total} runs from the last ${DAYS} days set <code>category</code>, so a
            Category condition matches nothing yet. Add it to the reporter options as above, or build lanes from
            environment and branch only.</p>`
        : nothing}
    </details>`;
  }

  private status(values: LaneValues | null) {
    if (this.loadError)
      return html`<p class="muted note">Couldn't read runs (${this.loadError}), so there are no suggestions or previews. You can
        still type values.</p>`;
    if (!values) return html`<p class="muted note">Reading runs from the last ${DAYS} days…</p>`;
    if (values.total === 0)
      return html`<p class="muted note">No runs in the last ${DAYS} days, so there are no suggestions or previews yet.</p>`;
    return html`<p class="muted note">Suggestions and previews use the ${values.total} runs from the last ${DAYS} days.</p>`;
  }

  private datalists(values: LaneValues) {
    const list = (id: string, items: LaneValue[]) =>
      html`<datalist id=${id}>${items.map((v) => html`<option value=${v.value}>${v.runs} runs</option>`)}</datalist>`;
    return html`${list('dl-category', values.category)}${list('dl-branch', values.branch)}`;
  }

  private laneCard(lane: Lane, i: number, values: LaneValues | null, cov: LaneCoverage | null) {
    const d = this.disabled;
    const last = i === this.lanes.length - 1;
    return html`<li class="lane">
      <div class="head">
        <span class="num" aria-hidden="true">${i + 1}</span>
        <input class="name" .value=${live(lane.label)} ?disabled=${d} aria-label="Lane ${i + 1} name"
          @change=${(e: Event) => this.setLabel(i, inputValue(e).trim())} />
        <label class="id muted" title="Stable key used in links (?lanes=…). Change it only if nothing refers to it.">id
          <input class="mono" .value=${live(lane.id)} ?disabled=${d} aria-label="Lane ${i + 1} id"
            @change=${(e: Event) => {
              const id = inputValue(e).trim();
              if (!id) return;
              this.fresh.delete(lane.id);
              this.setLane(i, { ...lane, id });
            }} />
        </label>
        <span class="grow"></span>
        <button ?disabled=${d || i === 0} @click=${() => this.emit(move(this.lanes, i, -1), true)} aria-label="Move lane ${i + 1} up"><q-icon name="arrow-up"></q-icon></button>
        <button ?disabled=${d || last} @click=${() => this.emit(move(this.lanes, i, 1), true)} aria-label="Move lane ${i + 1} down"><q-icon name="arrow-down"></q-icon></button>
        <button ?disabled=${d || this.lanes.length === 1} @click=${() => this.emit(this.lanes.filter((_, j) => j !== i), true)}
          aria-label="Remove lane ${i + 1}"><q-icon name="trash"></q-icon></button>
      </div>
      <div class="conds">
        <span class="when muted">Runs where</span>
        ${this.patternRow(i, 'category', values?.category ?? null)}
        ${this.environmentRow(i, values?.environment ?? null)}
        ${this.patternRow(i, 'branch', values?.branch ?? null)}
        ${this.timeRow(i)}
      </div>
      ${cov ? this.preview(lane, i, cov) : nothing}
    </li>`;
  }

  private patternRow(i: number, key: PatternKey, seen: LaneValue[] | null) {
    const source = this.lanes[i].match[key];
    const spec = describeMatch(source);
    const mode = this.modeOf(i, key);
    const f = FIELD[key];
    const d = this.disabled;
    let editor: TemplateResult | typeof nothing = nothing;
    if (mode === 'oneOf') {
      const chosen = spec.mode === 'oneOf' || spec.mode === 'is' ? spec.values : [];
      const options = [...new Set([...chosen, ...(seen ?? []).map((v) => v.value)])];
      const counts = new Map((seen ?? []).map((v) => [v.value, v.runs]));
      editor = html`<span class="chips">
        ${options.map((v) => {
          const on = chosen.includes(v);
          return html`<button class="chip ${on ? 'on' : ''}" aria-pressed=${on} ?disabled=${d}
            @click=${() => this.setValues(i, key, on ? chosen.filter((x) => x !== v) : [...chosen, v])}>
            ${v}${counts.has(v) ? html` <span class="muted">${counts.get(v)}</span>` : nothing}</button>`;
        })}
        <input list="dl-${key}" placeholder="add a value…" ?disabled=${d} aria-label="Add ${f.label} value"
          @change=${(e: Event) => {
            const v = inputValue(e).trim();
            (e.target as HTMLInputElement).value = '';
            if (v && !chosen.includes(v)) this.setValues(i, key, [...chosen, v]);
          }} />
      </span>`;
    } else if (mode === 'regex') {
      editor = html`<input class="mono regex" .value=${live(source ?? '')} placeholder="e.g. ^ui:(web|admin)$" ?disabled=${d}
        aria-label="${f.label} regular expression"
        @change=${(e: Event) => this.setMatch(i, key, compileMatch('regex', [], inputValue(e)))} />`;
    } else if (mode !== 'any') {
      const value = spec.mode === mode ? spec.values[0] ?? '' : '';
      editor = html`<input list="dl-${key}" .value=${live(value)} placeholder="e.g. ${f.example}" ?disabled=${d}
        aria-label="${f.label} value" @change=${(e: Event) => this.setValues(i, key, [inputValue(e)])} />`;
    }
    return html`<div class="cond">
      <span class="field" title="Tested against the ${key === 'category' ? 'reporter option “category”' : 'git branch of the run'}">${f.label}</span>
      <select ?disabled=${d} aria-label="${f.label} condition" @change=${(e: Event) => this.setMode(i, key, inputValue(e) as MatchMode)}>
        ${MODES.map((m) => html`<option value=${m.mode} ?selected=${m.mode === mode}>${m.label}</option>`)}
      </select>
      ${editor}
      <span class="src muted">${f.source}</span>
      ${source && seen ? this.tester(source, mode, seen, f.label) : nothing}
    </div>`;
  }

  /** Which seen values a condition matches; for regexes, the full list so the user sees what it tests against. */
  private tester(source: string, mode: MatchMode, seen: LaneValue[], label: string) {
    let valid = true;
    try {
      new RegExp(source);
    } catch {
      valid = false;
    }
    if (!valid) return html`<p class="hint bad">Not a valid regular expression.</p>`;
    const hits = seen.filter((v) => patternMatches(source, v.value));
    if (mode !== 'regex') {
      return hits.length === 0 && seen.length > 0
        ? html`<p class="hint warn">No run in the last ${DAYS} days has a matching ${label.toLowerCase()}.
            Seen: ${seen.slice(0, 6).map((v) => html`<code>${v.value}</code> `)}</p>`
        : nothing;
    }
    return html`<p class="hint">Tested against each run's ${label.toLowerCase()}:
      ${seen.slice(0, 12).map((v) => {
        const ok = hits.includes(v);
        return html`<span class="probe ${ok ? 'hit' : 'miss'}">${ok ? '✓' : '✗'} <code>${v.value}</code></span> `;
      })}${seen.length > 12 ? html`<span class="muted">+${seen.length - 12} more</span>` : nothing}</p>`;
  }

  private environmentRow(i: number, seen: LaneValue[] | null) {
    const env = this.lanes[i].match.environment ?? '';
    const key = `${i}:environment`;
    const known = (seen ?? []).some((v) => v.value === env);
    const other = this.overrides[key] === 'other';
    const d = this.disabled;
    return html`<div class="cond">
      <span class="field" title="Tested against the reporter option “environment” (exact match)">Environment</span>
      <select ?disabled=${d} aria-label="Environment"
        @change=${(e: Event) => {
          const v = inputValue(e);
          if (v === OTHER_ENV) {
            this.setOverride(key, 'other');
            return;
          }
          this.setOverride(key, undefined);
          this.setMatch(i, 'environment', v || undefined);
        }}>
        <option value="" ?selected=${!env && !other}>any environment</option>
        ${(seen ?? []).map((v) => html`<option value=${v.value} ?selected=${!other && v.value === env}>is ${v.value} (${v.runs} runs)</option>`)}
        ${env && !known ? html`<option value=${env} ?selected=${!other}>is ${env}${seen ? ' (no runs lately)' : ''}</option>` : nothing}
        <option value=${OTHER_ENV} ?selected=${other}>is another value…</option>
      </select>
      ${other
        ? html`<input .value=${live(env)} placeholder="e.g. staging" ?disabled=${d} aria-label="Environment value"
            @change=${(e: Event) => {
              this.setOverride(key, undefined);
              this.setMatch(i, 'environment', inputValue(e).trim() || undefined);
            }} />`
        : nothing}
      <span class="src muted">reporter option <code>environment</code></span>
    </div>`;
  }

  private timeRow(i: number) {
    const t = this.lanes[i].match.time;
    const d = this.disabled;
    const zone = t?.zone || 'UTC';
    // A new window starts as a typical nightly one, in the zone of whoever sets it up.
    const set = (patch: Partial<LaneTimeWindow>) =>
      this.setTime(i, { from: t?.from ?? '22:00', to: t?.to ?? '06:00', zone: t?.zone ?? LOCAL_ZONE, ...patch });
    const clock = (label: string, value: string, key: 'from' | 'to') =>
      html`<input type="time" class="clock" .value=${live(value)} ?disabled=${d} aria-label="Lane ${i + 1} ${label}"
        @change=${(e: Event) => {
          const v = inputValue(e);
          if (parseClock(v) !== null) set({ [key]: v });
          else this.requestUpdate();
        }} />`;
    return html`<div class="cond">
      <span class="field" title="Tested against the time of day the run started">Started</span>
      <select ?disabled=${d} aria-label="Lane ${i + 1} start time condition"
        @change=${(e: Event) => (inputValue(e) === 'between' ? set({}) : this.setTime(i, undefined))}>
        <option value="any" ?selected=${!t}>any time</option>
        <option value="between" ?selected=${!!t}>between</option>
      </select>
      ${t
        ? html`${clock('from', t.from, 'from')} <span class="muted">and</span> ${clock('to', t.to, 'to')}
            <input class="zone" list="dl-zones" .value=${live(zone)} ?disabled=${d} aria-label="Lane ${i + 1} time zone"
              title="Time zone of the window. Saved with the lane, so everyone gets the same lanes."
              @change=${(e: Event) => {
                const z = inputValue(e).trim();
                if (z && isValidTimeZone(z)) set({ zone: z });
                else this.requestUpdate();
              }} />`
        : nothing}
      <span class="src muted">time the run started</span>
      ${t && (parseClock(t.from) ?? 0) > (parseClock(t.to) ?? 0)
        ? html`<p class="hint muted">Runs past midnight: ${t.from} until ${t.to} the next morning.</p>`
        : nothing}
      ${t && t.from === t.to ? html`<p class="hint warn">Start and end are the same, so this matches the whole day.</p>` : nothing}
      ${t && this.runs?.length ? this.hourChart(t, zone) : nothing}
    </div>`;
  }

  /** Runs by start hour, with the window's hours highlighted, so it's clear when nightly runs start. */
  private hourChart(t: LaneTimeWindow, zone: string) {
    const hours = startHours(this.runs ?? [], zone);
    const max = Math.max(1, ...hours);
    const from = parseClock(t.from) ?? 0;
    const to = parseClock(t.to) ?? 0;
    const inside = (m: number) => from === to || (from < to ? m >= from && m < to : m >= from || m < to);
    const pad = (h: number) => String(h).padStart(2, '0');
    return html`<div class="hint hours" role="img"
      aria-label="Runs from the last ${DAYS} days by start hour in ${zone}. Highlighted hours are in the window.">
      <div class="bars">
        ${hours.map(
          (n, h) => html`<span class="bar ${inside(h * 60) ? 'in' : ''}" style="height:${Math.max(n ? 8 : 2, (n / max) * 100)}%"
            title="${pad(h)}:00–${pad(h)}:59 · ${n} run(s)"></span>`,
        )}
      </div>
      <div class="axis muted"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
      <span class="muted">All runs from the last ${DAYS} days by start hour (${zone}); highlighted hours are in the window.</span>
    </div>`;
  }

  private preview(lane: Lane, i: number, cov: LaneCoverage) {
    const rep = cov.lanes[i];
    const catchAll = isCatchAll(lane);
    const notes: TemplateResult[] = [];
    if (catchAll && i < this.lanes.length - 1)
      notes.push(html`<p class="hint warn">No conditions, so this lane catches every run and the lanes below it get nothing. Move it to the bottom.</p>`);
    // A catch-all overlapping the lanes above is the point of it, so only conditional lanes get this warning.
    if (!catchAll) for (const t of rep.takenBy.slice(0, 3))
      notes.push(html`<p class="hint warn">${t.runs} matching run(s) go to <b>${this.lanes[t.index]?.label}</b> above instead (first match wins).</p>`);
    const summary =
      rep.runs === 0
        ? rep.matches === 0
          ? html`<b>No runs</b> from the last ${DAYS} days match.${catchAll ? ' (Every run already has a lane above.)' : ''}`
          : html`<b>No runs</b>: the lanes above take all ${rep.matches} matching runs.`
        : html`Gets <b>${rep.runs}</b> run(s):
            ${rep.groups.slice(0, 4).map((g) => html`<span class="tag">${groupText(g)} <span class="muted">${g.runs}</span></span> `)}
            ${rep.groups.length > 4 ? html`<span class="muted">+${rep.groups.length - 4} more</span>` : nothing}`;
    return html`<div class="result ${rep.runs === 0 ? 'empty' : ''}"><p>${summary}</p>${notes}</div>`;
  }

  private unmatched(cov: LaneCoverage) {
    if (cov.unmatched.length === 0)
      return html`<p class="muted note">Every run from the last ${DAYS} days lands in a lane.</p>`;
    const total = cov.unmatched.reduce((n, g) => n + g.runs, 0);
    return html`<section class="unmatched">
      <h4>${total} run(s) are in no lane, so Monitoring doesn't show them</h4>
      <ul>
        ${cov.unmatched.map(
          (g) => html`<li>
            <span class="tag">${groupText(g)}</span>
            <span class="muted">${g.runs} run(s)${g.branches.length ? ` · ${g.branches.slice(0, 3).join(', ')}${g.branches.length > 3 ? '…' : ''}` : ''}</span>
            <button ?disabled=${this.disabled} @click=${() => this.insert(laneFor(g.category, g.environment, this.lanes.map((l) => l.id)))}>
              <q-icon name="plus"></q-icon> Create lane</button>
          </li>`,
        )}
      </ul>
    </section>`;
  }

  static styles = [
    baseStyles,
    css`
      :host {
        display: block;
      }
      code,
      pre {
        font-family: var(--q-font-mono);
        font-size: 0.9em;
      }
      .explain {
        border: 1px solid var(--q-border);
        border-radius: var(--q-radius);
        padding: 8px 12px;
        margin-bottom: 8px;
        background: var(--q-surface-2);
      }
      .explain summary {
        cursor: pointer;
        font-weight: 500;
      }
      .explain dl {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 4px 12px;
        margin: 8px 0;
      }
      .explain dt {
        font-weight: 600;
      }
      .explain dd {
        margin: 0;
      }
      .explain pre {
        overflow-x: auto;
        padding: 8px;
        background: var(--q-surface);
        border: 1px solid var(--q-border);
        border-radius: calc(var(--q-radius) * 0.75);
      }
      .note {
        margin: 4px 0 8px;
        font-size: 0.9rem;
      }
      .lanes {
        list-style: none;
        padding: 0;
        margin: 0 0 8px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .lane {
        border: 1px solid var(--q-border);
        border-radius: var(--q-radius);
        padding: 8px 10px;
        background: var(--q-surface);
      }
      .head,
      .bar,
      .unmatched li {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .grow {
        flex: 1;
      }
      .num {
        min-width: 1.6em;
        text-align: center;
        font-weight: 600;
        color: var(--q-text-muted);
      }
      input.name {
        font-weight: 600;
        width: min(260px, 100%);
      }
      .id {
        font-size: 0.85rem;
      }
      .id input {
        width: 140px;
        padding: 3px 6px;
        font-size: 0.85rem;
      }
      .conds {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin: 6px 0 0 2.2em;
      }
      .when {
        font-size: 0.85rem;
      }
      .cond {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .cond .field {
        width: 7.5em;
        font-weight: 500;
      }
      .cond .src {
        font-size: 0.8rem;
      }
      .regex {
        width: min(320px, 100%);
      }
      .chips {
        display: inline-flex;
        flex-wrap: wrap;
        gap: 4px;
        align-items: center;
      }
      .chip {
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 0.85rem;
      }
      .chip.on {
        border-color: var(--q-accent);
        color: var(--q-accent);
        background: var(--q-surface-2);
      }
      .hint {
        flex-basis: 100%;
        margin: 0 0 0 calc(7.5em + 6px);
        font-size: 0.85rem;
      }
      .result .hint {
        margin: 2px 0 0;
      }
      .hint.warn,
      .warn {
        color: var(--q-warn);
      }
      .hint.bad {
        color: var(--q-bad);
      }
      .probe.hit {
        color: var(--q-good);
      }
      .probe.miss {
        color: var(--q-text-muted);
      }
      input.clock {
        width: 7.5em;
      }
      input.zone {
        width: 13em;
      }
      .hours {
        max-width: 420px;
      }
      .hours .bars {
        display: flex;
        align-items: flex-end;
        gap: 2px;
        height: 36px;
        border-bottom: 1px solid var(--q-border);
      }
      .hours .bar {
        flex: 1;
        background: var(--q-border);
        border-radius: 2px 2px 0 0;
      }
      .hours .bar.in {
        background: var(--q-accent);
      }
      .hours .axis {
        display: flex;
        justify-content: space-between;
        font-size: 0.75rem;
      }
      .result {
        margin: 6px 0 0 2.2em;
        padding-top: 6px;
        border-top: 1px dashed var(--q-border);
        font-size: 0.9rem;
      }
      .result p {
        margin: 0;
      }
      .tag {
        display: inline-block;
        padding: 1px 6px;
        border-radius: 4px;
        background: var(--q-surface-2);
        border: 1px solid var(--q-border);
        font-size: 0.85rem;
      }
      .unmatched {
        margin-top: 12px;
        padding: 8px 12px;
        border: 1px solid var(--q-warn);
        border-radius: var(--q-radius);
      }
      .unmatched h4 {
        margin: 0 0 6px;
        font-size: 0.95rem;
      }
      .unmatched ul {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
    `,
  ];
}

if (!customElements.get('q-lanes-builder')) customElements.define('q-lanes-builder', LanesBuilder);
