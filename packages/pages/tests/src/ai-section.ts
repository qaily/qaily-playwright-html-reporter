// "AI" card in the test drawer: start Analyze / Fix jobs and show their saved results.

import type { AiKind, PageContext, StoredAiRecord } from '@qaily/contracts';
import { AI_CATEGORY_COLOR, AI_CATEGORY_LABEL, LitElement, aiProvenance, baseStyles, css, html, nothing, styleMap } from '@qaily/ui';

export class TestAiSection extends LitElement {
  static properties = {
    ctx: { attribute: false },
    runId: {},
    testId: {},
    analysis: { state: true },
    fix: { state: true },
    busy: { state: true },
    tick: { state: true },
  };
  declare ctx: PageContext;
  declare runId: string;
  declare testId: string;
  declare analysis: StoredAiRecord<'test-analysis'> | null;
  declare fix: StoredAiRecord<'test-fix'> | null;
  declare busy: boolean;
  declare tick: number;

  private offs: (() => void)[] = [];
  private loadedFor = '';

  constructor() {
    super();
    this.analysis = null;
    this.fix = null;
    this.busy = false;
    this.tick = 0;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.offs.push(
      this.ctx.ai.onResults(() => this.load()),
      // Job status changes (running → done) update the buttons.
      this.ctx.ai.subscribe(() => this.tick++),
    );
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    for (const off of this.offs) off();
    this.offs = [];
  }

  willUpdate(changed: Map<string, unknown>): void {
    if ((changed.has('runId') || changed.has('testId')) && `${this.runId}/${this.testId}` !== this.loadedFor) {
      this.analysis = null;
      this.fix = null;
      this.load();
    }
  }

  private async load() {
    const key = `${this.runId}/${this.testId}`;
    this.loadedFor = key;
    const { analysis, fix } = await this.ctx.ai.testResults(this.runId, this.testId);
    if (this.loadedFor === key) {
      this.analysis = analysis;
      this.fix = fix;
    }
  }

  private start(kind: AiKind) {
    try {
      if (kind === 'test-fix') this.ctx.ai.fixTest(this.runId, this.testId);
      else this.ctx.ai.analyzeTest(this.runId, this.testId);
    } catch (err) {
      this.ctx.notify(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  private async act(fn: () => Promise<void>, ok: string) {
    this.busy = true;
    try {
      await fn();
      this.ctx.notify(ok);
    } catch (err) {
      this.ctx.notify(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      this.busy = false;
    }
  }

  private button(kind: AiKind, label: string) {
    const job = this.ctx.ai.jobFor(kind, this.runId, this.testId);
    if (job && (job.status === 'running' || job.status === 'needs-approval')) {
      return html`<button @click=${() => this.ctx.ai.showJob(job.id)}>
        ${job.status === 'needs-approval' ? '⚠ Waiting for your approval' : `${label}…`} (show)</button>`;
    }
    const can = this.ctx.ai.canRun(kind);
    return html`<button class=${kind === 'test-analysis' ? 'primary' : ''} ?disabled=${!can.ok} title=${can.reason ?? ''}
      @click=${() => this.start(kind)}>${kind === 'test-analysis' ? '✨ ' : ''}${label}</button>`;
  }

  private footer(stored: StoredAiRecord) {
    const target = this.ctx.ai.publishTarget();
    return html`<div class="foot">
      <span class="muted small">${aiProvenance(stored.record, this.ctx.settings)}</span>
      ${stored.draft
        ? html`<span class="badge draft">Draft · only in this browser</span>
            <button class="small primary" ?disabled=${this.busy || !target.ok} title=${target.ok ? `Publish to ${target.label}` : target.reason ?? ''}
              @click=${() => this.act(() => this.ctx.ai.publish(stored), `Published to ${target.label}.`)}>Publish</button>
            <button class="small" ?disabled=${this.busy} @click=${() => this.act(() => this.ctx.ai.discardDraft(stored), 'Draft discarded.')}>Discard</button>`
        : html`<span class="badge">Published</span>`}
    </div>`;
  }

  render() {
    const a = this.analysis?.record.result;
    const f = this.fix?.record.result;
    return html`<section class="card ai">
      <div class="head">
        <h3>AI</h3>
        <div class="buttons">${this.button('test-analysis', 'Analyze with AI')} ${this.button('test-fix', 'Fix with AI')}</div>
      </div>
      ${!a && !f ? html`<p class="muted small">No AI result for this test yet. Results are drafts until you publish them to the report.</p>` : nothing}
      ${a
        ? html`<div class="result">
            <div class="row">
              <span class="cat" style=${styleMap({ background: AI_CATEGORY_COLOR[a.category] })}>${AI_CATEGORY_LABEL[a.category]}</span>
              <span class="muted small">confidence ${Math.round(a.confidence * 100)}%</span>
            </div>
            <p class="summary">${a.summary}</p>
            <dl>
              <dt>Root cause</dt><dd class="pre">${a.rootCause}</dd>
              ${a.evidence.length ? html`<dt>Evidence</dt><dd><ul>${a.evidence.map((e) => html`<li>${e}</li>`)}</ul></dd>` : nothing}
              <dt>Suggested fix</dt><dd class="pre">${a.suggestedFix}</dd>
              ${a.relatedFiles.length
                ? html`<dt>Files</dt><dd>${a.relatedFiles.map((r) => html`<code>${r.path}${r.line ? `:${r.line}` : ''}</code> `)}</dd>`
                : nothing}
            </dl>
            ${this.footer(this.analysis!)}
          </div>`
        : nothing}
      ${f
        ? html`<div class="result">
            <div class="row"><b>Fix</b>${f.needsHumanReview ? html`<span class="badge">needs review</span>` : nothing}</div>
            <p class="summary">${f.summary}</p>
            <dl>
              ${f.filesChanged.length
                ? html`<dt>Changed</dt><dd><ul>${f.filesChanged.map((c) => html`<li><code>${c.path}</code>: ${c.description}</li>`)}</ul></dd>`
                : nothing}
              <dt>Verify</dt><dd class="pre">${f.verification}</dd>
              ${f.risk ? html`<dt>Risk</dt><dd class="pre">${f.risk}</dd>` : nothing}
            </dl>
            <p class="muted small">The changes are in your local checkout; review and commit them yourself.</p>
            ${this.footer(this.fix!)}
          </div>`
        : nothing}
    </section>`;
  }

  static styles = [
    baseStyles,
    css`
      .ai {
        border-left: 4px solid var(--q-accent);
      }
      .head {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      h3 {
        font-size: 0.95rem;
        margin: 0;
        flex: 1;
      }
      .buttons {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      .small {
        font-size: 0.82rem;
      }
      button.small {
        padding: 3px 8px;
      }
      .result {
        border-top: 1px solid var(--q-border);
        margin-top: 10px;
        padding-top: 10px;
      }
      .row {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .cat {
        color: var(--q-on-status);
        border-radius: 999px;
        padding: 1px 10px;
        font-size: 0.8rem;
        font-weight: 600;
      }
      .summary {
        font-weight: 600;
        margin: 8px 0;
      }
      dl {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 4px 12px;
        margin: 0;
        font-size: 0.9rem;
      }
      dt {
        color: var(--q-text-muted);
      }
      dd {
        margin: 0;
      }
      dd ul {
        margin: 0;
        padding-left: 16px;
      }
      .pre {
        white-space: pre-wrap;
      }
      .foot {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
        margin-top: 10px;
      }
      .foot .muted {
        flex: 1;
      }
      .badge {
        font-size: 0.75rem;
        border: 1px solid var(--q-border);
        border-radius: 999px;
        padding: 1px 8px;
      }
      .badge.draft {
        border-color: var(--q-warn);
        color: var(--q-warn);
      }
    `,
  ];
}

if (!customElements.get('q-test-ai')) customElements.define('q-test-ai', TestAiSection);
