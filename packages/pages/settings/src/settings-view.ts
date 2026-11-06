import {
  DEFAULT_SETTINGS,
  SETTINGS_FIELDS,
  SETTINGS_GROUPS,
  getPath,
  setPath,
  type FieldDef,
  type PageContext,
  type SecretKey,
  type SecretPersistence,
  type SettingsLayer,
} from '@qaily/contracts';
import { LitElement, baseStyles, css, elementView, html, nothing } from '@qaily/ui';
import { extraValidation, renderEditor } from './editors.ts';

type Mode = 'personal' | 'team';

const SOURCE_LABEL = { default: 'Default', team: 'Team', personal: 'Mine' } as const;

const SECRETS: { key: SecretKey; label: string; help: string }[] = [
  { key: 'agentHostToken', label: 'Agent host connection token', help: 'Remote-control key for the local AI agent host. Treat it like a password.' },
  { key: 'githubToken', label: 'GitHub token', help: 'OAuth token from `gh auth token`. Used for AI and for publishing results to GitHub.' },
];

const PERSISTENCE_LABEL: Record<SecretPersistence, string> = {
  session: 'This tab only',
  local: 'Remember on this device',
  memory: "Don't store (until reload)",
};

class SettingsPage extends LitElement {
  static properties = {
    model: { attribute: false },
    ctx: { attribute: false },
    mode: { state: true },
    draft: { state: true },
    dirty: { state: true },
    errors: { state: true },
    saving: { state: true },
    awsError: { state: true },
    serverS3: { state: true },
  };
  declare model: unknown;
  declare ctx: PageContext;
  declare mode: Mode;
  declare draft: SettingsLayer;
  declare dirty: boolean;
  declare errors: Record<string, string>;
  declare saving: boolean;
  declare awsError: string;
  declare serverS3: { configured: boolean; ok?: boolean; identity?: string; error?: string; bucket?: string; expiresAt?: string } | null;

  constructor() {
    super();
    this.mode = 'personal';
    this.draft = {};
    this.dirty = false;
    this.errors = {};
    this.saving = false;
    this.awsError = '';
    this.serverS3 = null;
  }

  firstUpdated(): void {
    const section = new URLSearchParams(location.hash.split('?')[1] ?? '').get('section');
    if (section) requestAnimationFrame(() => this.renderRoot.querySelector(`#g-${CSS.escape(section)}`)?.scrollIntoView());
    if (this.ctx.artifacts.status().mode === 'local') this.loadServerS3();
  }

  private async loadServerS3() {
    try {
      const res = await fetch(new URL('__qaily/s3/status', document.baseURI), { cache: 'no-store' });
      this.serverS3 = res.ok ? await res.json() : null;
    } catch {
      this.serverS3 = null;
    }
  }

  private aws() {
    const art = this.ctx.artifacts;
    const status = art.status();
    const creds = art.credentials();
    const s3 = this.ctx.settings.connections.s3;
    let body;
    if (status.mode === 'static') {
      body = html`<p class="muted">No S3 bucket is configured (Connections → S3 bucket), so attachments are read from the report itself.</p>`;
    } else if (status.mode === 'local') {
      const sv = this.serverS3;
      body = html`<p>${status.message}</p>
        ${!sv
          ? html`<p class="muted">Checking the server's storage login…</p>`
          : !sv.configured
            ? html`<p class="muted">No S3 bucket configured; only local files are served.</p>`
            : sv.ok
              ? html`<p>Signing for <code>${sv.bucket}</code> as <b>${sv.identity}</b>${sv.expiresAt ? html`, valid until ${new Date(sv.expiresAt).toLocaleString()}` : nothing}.</p>`
              : html`<p class="error">The server has no storage login: ${sv.error}</p>
                  <p class="muted">Run <code>aws sso login</code> (or set AWS_PROFILE / AWS_ACCESS_KEY_ID) where the server runs, then
                    <button class="link inline-link" @click=${this.loadServerS3}>check again</button>.</p>`}`;
    } else if (creds) {
      const expires = creds.expiration ? new Date(creds.expiration) : null;
      body = html`<p>Connected as <code>${creds.keyId}</code> · ${creds.temporary ? 'temporary credentials' : html`<b class="warn">long-lived key</b>`}
          ${expires ? html` · expires ${expires.toLocaleString()}` : nothing} · kept: ${creds.persistence ?? 'memory'}</p>
        ${creds.temporary ? nothing : html`<p class="warn">Long-lived access keys are risky in a browser. Prefer temporary credentials from <code>aws sso login</code>.</p>`}
        <button @click=${() => { art.disconnect(); this.requestUpdate(); this.ctx.notify('Storage credentials forgotten.'); }}>Forget credentials</button>`;
    } else {
      body = html`<p>${status.message} Bucket <code>${s3.bucket}</code> (${s3.region}), prefix <code>${s3.prefix}</code>.</p>
        <form class="aws" @submit=${(e: SubmitEvent) => {
          e.preventDefault();
          const data = new FormData(e.target as HTMLFormElement);
          try {
            art.connect(String(data.get('creds') ?? ''), data.get('persistence') as SecretPersistence);
            this.awsError = '';
            (e.target as HTMLFormElement).reset();
            this.ctx.notify('Storage credentials connected.');
          } catch (err) {
            this.awsError = err instanceof Error ? err.message : String(err);
          }
        }}>
          <label><span>Paste the output of <code>aws configure export-credentials --format process</code> (or <code>--format env</code>)</span>
            <textarea name="creds" rows="5" autocomplete="off" spellcheck="false" class="mono"></textarea></label>
          <div class="inline-row">
            <select name="persistence" aria-label="Where to keep them">
              ${(['session', 'local', 'memory'] as SecretPersistence[]).map((p) => html`<option value=${p}>${PERSISTENCE_LABEL[p]}</option>`)}
            </select>
            <button type="submit" class="primary">Connect</button>
          </div>
          ${this.awsError ? html`<p class="error" role="alert">${this.awsError}</p>` : nothing}
        </form>
        <ul class="muted small">
          <li>Use temporary credentials and a read-only IAM policy limited to <code>${s3.prefix}/*</code>${s3.dataSource === 'bucket' ? html` and <code>${s3.dataPrefix}/*</code>` : nothing}.</li>
          <li>Credentials are only used to sign URLs in this page; they are never sent anywhere.</li>
          <li>"Remember on this device" keeps them in localStorage until you forget them or they expire. Any script on this site can read them.${s3.dataSource === 'bucket' ? ' It also keeps downloaded report data on this device, so pages load faster.' : ''}</li>
        </ul>`;
    }
    return html`<div class="field"><div class="field-head"><span class="label">Storage credentials (${s3.dataSource === 'bucket' ? 'report data and attachments' : 'attachments'} in S3-compatible storage)</span>
      <span class="badge">${status.mode} mode</span></div>${body}</div>`;
  }

  private setMode(mode: Mode) {
    if (mode === this.mode) return;
    if (this.dirty && !window.confirm('Discard unsaved team changes?')) return;
    this.mode = mode;
    this.draft = structuredClone(this.ctx.settingsApi.team);
    this.dirty = false;
    this.errors = {};
  }

  /** Switches to team mode and keeps the field in view. */
  private async editForTeam(field: FieldDef) {
    this.setMode('team');
    if (this.mode !== 'team') return;
    await this.updateComplete;
    this.renderRoot.querySelector(`#${CSS.escape(`f-${field.path}`)}`)?.scrollIntoView({ block: 'start' });
  }

  private editable(field: FieldDef): boolean {
    return field.scope === 'both' || field.scope === this.mode;
  }

  private valueOf(field: FieldDef): { value: unknown; source: keyof typeof SOURCE_LABEL } {
    if (this.mode === 'personal') {
      return { value: getPath(this.ctx.settings, field.path), source: this.ctx.settingsApi.resolved.sources[field.path] ?? 'default' };
    }
    const team = getPath(this.draft, field.path);
    return team === undefined
      ? { value: getPath(DEFAULT_SETTINGS, field.path), source: 'default' }
      : { value: team, source: 'team' };
  }

  private change(field: FieldDef, value: unknown) {
    const parsed = field.schema.safeParse(value);
    const error = parsed.success ? extraValidation(field, parsed.data) : parsed.error.issues[0]?.message ?? 'Invalid value';
    this.errors = { ...this.errors, [field.path]: error ?? '' };
    if (error) {
      this.requestUpdate();
      return;
    }
    if (this.mode === 'personal') {
      this.ctx.settingsApi.setPersonal(field.path, parsed.success ? parsed.data : value);
    } else {
      this.draft = setPath(this.draft, field.path, parsed.success ? parsed.data : value);
      this.dirty = true;
    }
  }

  private reset(field: FieldDef) {
    this.errors = { ...this.errors, [field.path]: '' };
    if (this.mode === 'personal') this.ctx.settingsApi.setPersonal(field.path, undefined);
    else {
      this.draft = setPath(this.draft, field.path, undefined);
      this.dirty = true;
    }
  }

  private async saveTeam() {
    this.saving = true;
    try {
      await this.ctx.settingsApi.saveTeam(this.draft);
      this.dirty = false;
      this.ctx.notify('Team settings saved. Everyone gets them on their next load.');
    } catch (err) {
      this.ctx.notify(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      this.saving = false;
    }
  }

  private exportSettings() {
    const blob = new Blob([this.ctx.settingsApi.exportJson()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'qaily-settings.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  private async importSettings(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      if (this.mode === 'personal') {
        await this.ctx.settingsApi.importJson(text, 'personal');
        this.ctx.notify('Imported into your personal settings.');
      } else {
        const parsed = JSON.parse(text) as { team?: SettingsLayer } & SettingsLayer;
        this.draft = parsed.team ?? parsed;
        this.dirty = true;
        this.ctx.notify('Imported into the team draft. Review it, then save for team.');
      }
    } catch (err) {
      this.ctx.notify(`Import failed: ${err instanceof Error ? err.message : err}`, 'error');
    }
  }

  private field(field: FieldDef) {
    const { value, source } = this.valueOf(field);
    const editable = this.editable(field);
    const error = this.errors[field.path];
    const resettable = editable && source === (this.mode === 'personal' ? 'personal' : 'team');
    return html`<div class="field" id=${`f-${field.path}`}>
      <div class="field-head">
        <span class="label">${field.label}</span>
        <span class="badge source-${source}" title="Current value comes from: ${SOURCE_LABEL[source]}">${SOURCE_LABEL[source]}</span>
        ${field.scope !== 'both' ? html`<span class="badge scope">${field.scope === 'team' ? 'Team only' : 'Personal only'}</span>` : nothing}
        ${resettable
          ? html`<button class="link" @click=${() => this.reset(field)}>
              ${this.mode === 'personal' ? 'Reset to team/default' : 'Reset to default'}
            </button>`
          : nothing}
      </div>
      ${field.help ? html`<p class="help muted">${field.help}</p>` : nothing}
      ${!editable && field.scope === 'team'
        ? html`<p class="locked">Shared with the team, so it is edited under <b>For the team</b> (top of the page).
            <button class="primary" @click=${() => this.editForTeam(field)}>Edit for the team</button></p>`
        : nothing}
      <div class="editor">${renderEditor({
        field,
        value,
        disabled: !editable,
        ctx: this.ctx,
        onChange: (v) => this.change(field, v),
        team: this.mode === 'team'
          ? { dirty: this.dirty, canSave: this.ctx.settingsApi.canSaveTeam, saving: this.saving, save: () => void this.saveTeam() }
          : undefined,
      })}</div>
      ${error ? html`<p class="error" role="alert">${error}</p>` : nothing}
    </div>`;
  }

  private secrets() {
    const s = this.ctx.secrets;
    return html`<section class="card" id="g-secrets">
      <h2>Tokens</h2>
      <p class="muted">Personal and never shared: not exported and never saved for the team. Any script on this site can read stored tokens.</p>
      ${this.aws()}
      ${SECRETS.map((sec) => {
        const stored = s.persistence(sec.key);
        return html`<form class="field secret" @submit=${(e: SubmitEvent) => {
          e.preventDefault();
          const form = e.target as HTMLFormElement;
          const data = new FormData(form);
          const value = String(data.get('value') ?? '').trim();
          if (!value) return;
          s.set(sec.key, value, data.get('persistence') as SecretPersistence);
          form.reset();
          this.requestUpdate();
          this.ctx.notify(`${sec.label} stored.`);
        }}>
          <div class="field-head"><span class="label">${sec.label}</span>
            <span class="badge">${stored ? `Stored: ${PERSISTENCE_LABEL[stored]}` : 'Not set'}</span></div>
          <p class="help muted">${sec.help}</p>
          <div class="editor inline-row">
            <input type="password" name="value" autocomplete="off" placeholder="Paste token" aria-label=${sec.label} />
            <select name="persistence" aria-label="Where to keep it">
              ${(['session', 'local', 'memory'] as SecretPersistence[]).map((p) => html`<option value=${p}>${PERSISTENCE_LABEL[p]}</option>`)}
            </select>
            <button type="submit" class="primary">Store</button>
            ${stored ? html`<button type="button" @click=${() => { s.forget(sec.key); this.requestUpdate(); }}>Forget</button>` : nothing}
          </div>
        </form>`;
      })}
      <button @click=${() => { s.forgetAll(); this.ctx.artifacts.disconnect(); this.requestUpdate(); this.ctx.notify('All tokens forgotten.'); }}>Forget all tokens</button>
    </section>`;
  }

  render() {
    const api = this.ctx.settingsApi;
    const warnings = api.resolved.warnings;
    return html`
      <div class="layout" @preview=${() => this.requestUpdate()}>
        <nav class="toc" aria-label="Settings sections">
          ${SETTINGS_GROUPS.map((g) => html`<a href="#" @click=${(e: Event) => this.jump(e, `g-${g.id}`)}>${g.label}</a>`)}
          <a href="#" @click=${(e: Event) => this.jump(e, 'g-secrets')}>Tokens</a>
        </nav>
        <div class="content">
          <div class="card top">
            <div class="modes" role="tablist" aria-label="Which settings to edit">
              <button role="tab" aria-selected=${this.mode === 'personal'} class=${this.mode === 'personal' ? 'primary' : ''}
                @click=${() => this.setMode('personal')}>For me</button>
              <button role="tab" aria-selected=${this.mode === 'team'} class=${this.mode === 'team' ? 'primary' : ''}
                @click=${() => this.setMode('team')}>For the team</button>
            </div>
            <p class="muted">
              ${this.mode === 'personal'
                ? 'Changes apply at once and are saved in this browser only.'
                : api.canSaveTeam
                  ? 'Edit the shared defaults (data/settings.json), then save. Personal settings still win for each viewer.'
                  : 'This report is read-only, so team settings cannot be saved here. Run it with `qaily-report serve` to save them, or export and commit data/settings.json.'}
            </p>
            <div class="top-actions">
              ${this.mode === 'team'
                ? html`<button class="primary" ?disabled=${!this.dirty || !api.canSaveTeam || this.saving} @click=${this.saveTeam}>
                    ${this.saving ? 'Saving…' : 'Save for team'}</button>`
                : nothing}
              <button @click=${this.exportSettings}>Export JSON</button>
              <label class="file-button">Import JSON<input type="file" accept="application/json,.json" @change=${this.importSettings} /></label>
            </div>
            ${warnings.length ? html`<ul class="warnings">${warnings.map((w) => html`<li>${w}</li>`)}</ul>` : nothing}
          </div>
          ${SETTINGS_GROUPS.map(
            (g) => html`<section class="card" id=${`g-${g.id}`}>
              <h2>${g.label}</h2>
              ${g.help ? html`<p class="muted">${g.help}</p>` : nothing}
              ${SETTINGS_FIELDS.filter((f) => f.group === g.id).map((f) => this.field(f))}
            </section>`,
          )}
          ${this.secrets()}
        </div>
      </div>
    `;
  }

  private jump(e: Event, id: string) {
    e.preventDefault();
    this.renderRoot.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ behavior: this.ctx.theme.reducedMotion ? 'auto' : 'smooth' });
  }

  static styles = [
    baseStyles,
    css`
      .layout {
        display: grid;
        grid-template-columns: 200px minmax(0, 1fr);
        gap: 16px;
        max-width: 1100px;
        margin: 0 auto;
      }
      .toc {
        position: sticky;
        top: 70px;
        align-self: start;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .toc a {
        padding: 6px 10px;
        border-radius: 6px;
        color: var(--q-text-muted);
        text-decoration: none;
      }
      .toc a:hover {
        background: var(--q-surface-2);
        color: var(--q-text);
      }
      .content {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      h2 {
        font-size: 1.1rem;
        margin-bottom: 4px;
      }
      .modes {
        display: flex;
        gap: 6px;
      }
      .top-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        align-items: center;
      }
      .file-button {
        border: 1px solid var(--q-border);
        border-radius: calc(var(--q-radius) * 0.75);
        padding: 6px 10px;
        cursor: pointer;
      }
      .file-button input {
        display: none;
      }
      .warnings {
        color: var(--q-warn);
      }
      .field {
        border-top: 1px solid var(--q-border);
        padding: 14px 0;
      }
      .field-head {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .label {
        font-weight: 600;
      }
      .badge {
        font-size: 0.75rem;
        padding: 1px 8px;
        border-radius: 999px;
        border: 1px solid var(--q-border);
        color: var(--q-text-muted);
      }
      .source-personal {
        border-color: var(--q-accent);
        color: var(--q-accent);
      }
      .source-team {
        border-color: var(--q-good);
        color: var(--q-text);
      }
      .help {
        margin: 4px 0 8px;
        font-size: 0.9rem;
      }
      .editor {
        margin-top: 6px;
      }
      .error {
        color: var(--q-bad);
        margin: 6px 0 0;
      }
      button.link {
        border: none;
        background: none;
        color: var(--q-accent);
        padding: 0;
        margin-left: auto;
      }
      table.rows {
        border-collapse: collapse;
        margin-bottom: 8px;
      }
      table.rows th {
        text-align: left;
        font-weight: 500;
        color: var(--q-text-muted);
        font-size: 0.85rem;
        padding: 2px 6px 2px 0;
      }
      table.rows td {
        padding: 3px 6px 3px 0;
      }
      td.actions {
        white-space: nowrap;
        min-width: 120px;
      }
      input[type='number'] {
        width: 90px;
      }
      input.wide {
        width: min(420px, 100%);
      }
      .scroll {
        overflow-x: auto;
        /* Contain absolutely positioned children (visually-hidden labels), or they widen the page. */
        position: relative;
      }
      .preview {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        margin-top: 10px;
      }
      .swatch {
        background: var(--level);
        color: var(--q-on-status);
        border-radius: 999px;
        padding: 2px 10px;
        font-size: 0.85rem;
      }
      .tokens {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr));
        gap: 8px 16px;
      }
      .token {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .token code {
        color: var(--q-text-muted);
        font-size: 0.75rem;
      }
      .token-input {
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .token-input input:not([type='color']) {
        flex: 1;
        min-width: 0;
      }
      input[type='color'] {
        width: 40px;
        height: 32px;
        padding: 2px;
      }
      .chip-color {
        width: 32px;
        height: 32px;
        border-radius: 6px;
        border: 1px solid var(--q-border);
        flex: none;
      }
      label.inline {
        display: flex;
        gap: 8px;
        align-items: center;
        margin-bottom: 6px;
      }
      .warn {
        color: var(--q-warn);
      }
      form.aws label {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-bottom: 8px;
      }
      textarea {
        font-family: var(--q-font-mono);
        font-size: 0.8rem;
        color: var(--q-text);
        background: var(--q-surface);
        border: 1px solid var(--q-border);
        border-radius: calc(var(--q-radius) * 0.75);
        padding: 8px;
      }
      ul.small {
        font-size: 0.85rem;
        padding-left: 18px;
      }
      .inline-link {
        margin: 0;
      }
      table.rules input {
        width: 130px;
      }
      table.rules .ic {
        text-align: center;
        padding-right: 6px;
      }
      p.locked {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px 10px;
        margin: 4px 0 8px;
        padding: 6px 10px;
        border-radius: 8px;
        border: 1px solid var(--q-border);
        background: var(--q-surface-2);
        font-size: 0.85rem;
      }
      /* Full-screen rules editor: wide inputs, no sideways scrolling. */
      .rules-wrap.full {
        position: fixed;
        inset: 0;
        z-index: 32;
        overflow: auto;
        padding: 16px 20px 24px;
        background: var(--q-bg);
      }
      .rules-wrap.full .scroll {
        overflow: visible;
      }
      .rules-wrap.full table.rules {
        width: 100%;
      }
      .rules-wrap.full table.rules input:not([type='checkbox']) {
        width: 100%;
        min-width: 110px;
      }
      /* The Step pattern is the longest. */
      .rules-wrap.full table.rules td:first-child input {
        min-width: 260px;
      }
      .rules-bar {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 6px;
      }
      .rules-bar .grow {
        flex: 1;
      }
      table.rules th.cond {
        color: var(--q-accent);
      }
      table.rules tr.bad input {
        border-color: var(--q-warn);
      }
      .rule-preview {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
        margin-top: 10px;
      }
      .inline-row {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      @media (max-width: 760px) {
        .layout {
          grid-template-columns: 1fr;
        }
        .toc {
          position: static;
          flex-direction: row;
          flex-wrap: wrap;
        }
      }
    `,
  ];
}

export default elementView<unknown>('q-settings-page', SettingsPage);
