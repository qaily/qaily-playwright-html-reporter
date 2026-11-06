// The AI panel: connection, a free-form chat, jobs, and each job's live transcript with tool approvals.
// It lives in the shell, so jobs keep running and stay visible while the user changes pages.
// Agent text is only ever bound as text (Lit escapes it); code fences become <pre> blocks.

import type { AiJob, AiService, TranscriptEntry } from '@qaily/ai';
import { formatTime, formatHash } from '@qaily/core';
import type { Settings } from '@qaily/contracts';
import { LitElement, baseStyles, css, html, nothing, type TemplateResult } from '@qaily/ui';

type Confirm = (turnId: string, toolCallId: string, approved: boolean, optionId?: string) => void;

const CHAT = 'chat';
const STATUS_TEXT = { running: 'Running', 'needs-approval': 'Needs your approval', done: 'Done', error: 'Failed', cancelled: 'Cancelled' } as const;

function prose(text: string): TemplateResult[] {
  return text.split(/^```[^\n]*\n?/m).map((chunk, i) =>
    i % 2 === 1 ? html`<pre class="code"><code>${chunk.replace(/\n$/, '')}</code></pre>` : html`<div class="prose">${chunk}</div>`,
  );
}

export class AiDock extends LitElement {
  static properties = { open: { state: true }, selected: { state: true }, tick: { state: true } };
  declare open: boolean;
  declare selected: string | null;
  declare tick: number;

  ai!: AiService;
  settings!: () => Settings;
  private offs: (() => void)[] = [];
  private frame = 0;
  private lastStatus = new Map<string, string>();

  constructor() {
    super();
    this.open = false;
    this.selected = null;
    this.tick = 0;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.offs.push(
      // Streamed output fires often: re-render at most once per animation frame.
      this.ai.subscribe(() => {
        this.announce();
        cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(() => this.tick++);
      }),
      this.ai.onShowJob((id) => {
        this.selected = id;
        this.open = true;
      }),
    );
  }

  /** Toasts for job transitions, so they are noticed while the panel is closed. */
  private announce(): void {
    for (const job of this.ai.jobs()) {
      const status = job.info.status;
      const before = this.lastStatus.get(job.id);
      if (before === status) continue;
      this.lastStatus.set(job.id, status);
      if (!before) continue;
      const notify = (message: string, kind: 'info' | 'error' = 'info') =>
        this.dispatchEvent(new CustomEvent('notify', { detail: { message, kind } }));
      if (status === 'done') notify(`AI finished: ${job.title}. Saved as a draft.`);
      else if (status === 'error') notify(`AI job failed: ${job.error ?? job.title}`, 'error');
      else if (status === 'needs-approval' && !this.open) notify(`AI is waiting for your approval: ${job.title}`);
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    for (const off of this.offs) off();
    cancelAnimationFrame(this.frame);
  }

  updated(): void {
    // Keep the newest output in view while a job streams, unless the user scrolled up.
    const log = this.renderRoot.querySelector<HTMLElement>('.log');
    if (log && log.dataset.follow !== 'false') log.scrollTop = log.scrollHeight;
  }

  private connect() {
    this.ai.connect().catch(() => {
      // The state message shows the error.
    });
  }

  private resultLink(job: AiJob): string {
    return job.testId ? formatHash('tests', { run: job.runId, test: job.testId }) : formatHash('issues', { run: job.runId });
  }

  private async publish(job: AiJob) {
    if (!job.result) return;
    try {
      await this.ai.publish(job.result);
    } catch (err) {
      this.dispatchEvent(new CustomEvent('notify', { detail: { message: err instanceof Error ? err.message : String(err), kind: 'error' } }));
    }
  }

  private entry(e: TranscriptEntry, confirm: Confirm, chat = false) {
    switch (e.kind) {
      case 'user':
        if (chat) return html`<div class="you">${e.text}</div>`;
        return html`<details class="prompt"><summary>Prompt sent (${Math.round(e.text.length / 1024)} KB)</summary><pre class="code">${e.text}</pre></details>`;
      case 'text':
        return html`<div class="agent">${prose(e.text)}</div>`;
      case 'reasoning':
        return html`<details class="reasoning"><summary>Reasoning</summary><div class="prose">${e.text}</div></details>`;
      case 'status':
        return html`<div class="status ${e.error ? 'error' : ''}" role=${e.error ? 'alert' : nothing}>${e.text}</div>`;
      case 'tool': {
        const badge = e.status === 'asking' ? 'needs your approval' : `${e.auto && e.status !== 'preparing' ? 'auto-approved by host · ' : ''}${e.status}`;
        return html`<div class="tool ${e.status}">
          <div class="tool-head"><b>${e.name}</b><span class="badge">${badge}</span></div>
          ${e.message ? html`<div>${e.message}</div>` : nothing}
          ${e.input ? html`<pre class="code">${e.input}</pre>` : nothing}
          ${e.status === 'asking'
            ? html`<div class="tool-actions">
                ${e.options.map(
                  (o, i) => html`<button class=${o.kind === 'deny' ? '' : 'primary'} ?autofocus=${i === 0}
                    @click=${() => confirm(e.turnId, e.id, o.kind !== 'deny', o.id)}>${o.label}</button>`,
                )}
              </div>`
            : nothing}
          ${e.result ? html`<div class="muted">${e.result}</div>` : nothing}
        </div>`;
      }
    }
  }

  private jobView(job: AiJob) {
    const info = job.info;
    const target = this.ai.publishTarget();
    return html`<div class="job">
      <div class="job-head">
        <button class="back" @click=${() => (this.selected = null)} aria-label="Back to jobs">←</button>
        <div class="job-title"><b>${job.title}</b><span class="pill ${info.status}">${STATUS_TEXT[info.status]}</span></div>
        ${job.status === 'running' ? html`<button @click=${() => job.cancel()}>Stop</button>` : nothing}
      </div>
      ${this.log(job.transcript.entries.map((e) => this.entry(e, (...a) => job.confirm(...a))))}
      ${job.result
        ? html`<div class="result">
            <span>${job.result.draft ? 'Draft saved in this browser.' : 'Published.'}</span>
            <a href=${this.resultLink(job)} @click=${() => (this.open = false)}>Open result</a>
            ${job.result.draft
              ? html`<button class="primary" ?disabled=${!target.ok} title=${target.ok ? `Publish to ${target.label}` : target.reason ?? ''}
                  @click=${() => this.publish(job)}>Publish</button>`
              : nothing}
          </div>
          ${job.result.draft && !target.ok ? html`<p class="muted small">${target.reason}</p>` : nothing}`
        : nothing}
    </div>`;
  }

  private log(content: unknown) {
    return html`<div class="log" @scroll=${(e: Event) => {
      const el = e.target as HTMLElement;
      el.dataset.follow = String(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
    }}>${content}</div>`;
  }

  private send(form: HTMLFormElement) {
    const box = form.elements.namedItem('message') as HTMLTextAreaElement;
    const text = box.value;
    if (!text.trim() || this.ai.chat.busy) return;
    box.value = '';
    void this.ai.chat.send(text);
  }

  private chatView() {
    const chat = this.ai.chat;
    const entries = chat.transcript.entries;
    return html`<div class="job">
      <div class="job-head">
        <button class="back" @click=${() => (this.selected = null)} aria-label="Back to jobs">←</button>
        <div class="job-title"><b>Chat</b><span class="muted small">Works in ${this.settings().connections.workingDirectory || 'your local test repo'}</span></div>
        ${chat.busy ? html`<button @click=${() => chat.stop()}>Stop</button>` : nothing}
        <button ?disabled=${!entries.length} @click=${() => chat.reset()} title="Start a fresh agent session">New chat</button>
      </div>
      ${this.log(
        entries.length
          ? entries.map((e) => this.entry(e, (...a) => chat.confirm(...a), true))
          : html`<p class="muted small">Ask the agent anything. It can read the test repo and run tools; tools that change things ask for your approval here.</p>`,
      )}
      <form class="composer" @submit=${(e: Event) => {
        e.preventDefault();
        this.send(e.target as HTMLFormElement);
      }}>
        <textarea name="message" rows="3" placeholder="Message the agent… (Enter to send, Shift+Enter for a new line)" aria-label="Message"
          @keydown=${(e: KeyboardEvent) => {
            if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
            e.preventDefault();
            this.send((e.target as HTMLTextAreaElement).form!);
          }}></textarea>
        <button class="primary" type="submit" ?disabled=${chat.busy}>${chat.busy ? 'Working…' : 'Send'}</button>
      </form>
    </div>`;
  }

  private list() {
    const state = this.ai.state();
    const jobs = this.ai.jobs();
    const s = this.settings();
    return html`
      <section class="conn">
        <div><span class="dot ${state.status}"></span> <b>${state.status === 'ready' ? state.agent ?? 'Connected' : state.status}</b></div>
        <p class="muted small">${state.message}</p>
        <p class="muted small">Host <code>${s.connections.agentHostUrl.replace(/\?.*$/, '')}</code> · repo
          <code>${s.connections.workingDirectory || 'not set'}</code></p>
        <div class="row">
          ${state.status === 'ready'
            ? html`<button @click=${() => this.ai.disconnect()}>Disconnect</button>`
            : html`<button class="primary" ?disabled=${state.status === 'connecting'} @click=${this.connect}>Connect</button>`}
          <a href=${formatHash('settings', { section: 'connections' })} @click=${() => (this.open = false)}>AI settings</a>
        </div>
        ${state.status === 'error' || state.status === 'disconnected'
          ? html`<details class="help"><summary>How to connect</summary>
              <ol>
                <li>Start the agent host: <code>code agent host --connection-token "$(openssl rand -hex 16)"</code></li>
                <li>Paste the printed <code>Local: ws://…?tkn=…</code> URL into Settings → Connections → AI agent host URL,
                  or the URL there and the token in Settings → Tokens.</li>
                <li>Set "Local test repo path" to your checkout of the tests.</li>
                <li>Sign the host in: store <code>gh auth token</code> in Settings → Tokens, or connect VS Code's Agents window to it.</li>
                <li>Chrome may ask to allow access to devices on your local network: allow it.</li>
              </ol>
              <p class="small">The connection token is a remote-control key for an agent that can run tools on your machine.
                The host still approves reads/writes inside the working directory and safe shell commands by itself, so use a
                dedicated checkout.</p>
            </details>`
          : nothing}
      </section>
      <section>
        <h3>Chat</h3>
        <button class="chat-open" @click=${() => (this.selected = CHAT)}>
          💬 ${this.ai.chat.transcript.entries.length ? 'Continue the chat' : 'Chat with the agent'}
          ${this.ai.chat.busy ? html`<span class="pill running">Running</span>` : nothing}
        </button>
      </section>
      <section>
        <h3>Jobs</h3>
        ${jobs.length
          ? html`<ul class="jobs">
              ${jobs.map((j) => {
                const info = j.info;
                return html`<li><button @click=${() => (this.selected = j.id)}>
                  <span class="pill ${info.status}">${STATUS_TEXT[info.status]}</span>
                  <span class="job-name">${j.title}</span>
                  <span class="muted small">${formatTime(j.createdAt, s)}</span>
                </button></li>`;
              })}
            </ul>`
          : html`<p class="muted small">No jobs yet. Use "Analyze with AI" on a failed test, or "Analyze all failures" on a run's Issues page.</p>`}
      </section>`;
  }

  render() {
    const state = this.ai.state();
    const jobs = this.ai.jobs();
    const waiting = jobs.filter((j) => j.info.status === 'needs-approval').length;
    const running = jobs.filter((j) => j.status === 'running').length;
    const job = this.selected && this.selected !== CHAT ? this.ai.job(this.selected) : undefined;
    return html`
      <button class="fab ${waiting ? 'attention' : ''}" @click=${() => (this.open = !this.open)} aria-expanded=${this.open}
        aria-label="AI panel${waiting ? `, ${waiting} waiting for approval` : ''}">
        <span class="dot ${state.status}"></span> ✨ AI ${running ? html`<span class="count">${running}</span>` : nothing}
      </button>
      ${this.open
        ? html`<aside class="panel" aria-label="AI panel">
            <header><h2>AI assistant</h2><button @click=${() => (this.open = false)} aria-label="Close">✕</button></header>
            <div class="body">${this.selected === CHAT ? this.chatView() : job ? this.jobView(job) : this.list()}</div>
          </aside>`
        : nothing}
    `;
  }

  static styles = [
    baseStyles,
    css`
      .fab {
        position: fixed;
        right: 16px;
        bottom: 16px;
        /* Above drawers (31), below modals (40). */
        z-index: 35;
        display: flex;
        align-items: center;
        gap: 6px;
        border-radius: 999px;
        padding: 8px 14px;
        box-shadow: var(--q-shadow);
        background: var(--q-surface);
      }
      .fab.attention {
        border-color: var(--q-warn);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--q-warn) 40%, transparent);
      }
      .count {
        background: var(--q-accent);
        color: var(--q-on-accent);
        border-radius: 999px;
        padding: 0 6px;
        font-size: 0.75rem;
      }
      .dot {
        display: inline-block;
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: var(--q-none);
      }
      .dot.ready {
        background: var(--q-good);
      }
      .dot.connecting {
        background: var(--q-warn);
      }
      .dot.error {
        background: var(--q-bad);
      }
      .panel {
        position: fixed;
        right: 16px;
        bottom: 64px;
        top: 70px;
        width: min(480px, calc(100vw - 32px));
        z-index: 36;
        background: var(--q-bg);
        border: 1px solid var(--q-border);
        border-radius: var(--q-radius);
        box-shadow: var(--q-shadow);
        display: flex;
        flex-direction: column;
      }
      .panel header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 10px 14px;
        border-bottom: 1px solid var(--q-border);
      }
      h2 {
        font-size: 1rem;
      }
      h3 {
        font-size: 0.9rem;
        margin: 12px 0 6px;
      }
      .body {
        flex: 1;
        overflow: auto;
        padding: 12px 14px;
        display: flex;
        flex-direction: column;
      }
      .small {
        font-size: 0.82rem;
      }
      .row {
        display: flex;
        gap: 10px;
        align-items: center;
      }
      .help ol {
        padding-left: 18px;
        font-size: 0.85rem;
      }
      .jobs {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .jobs button {
        width: 100%;
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: 8px;
        align-items: center;
        text-align: left;
        margin-bottom: 6px;
      }
      .job-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pill {
        font-size: 0.72rem;
        border-radius: 999px;
        padding: 1px 8px;
        border: 1px solid var(--q-border);
        white-space: nowrap;
      }
      .pill.running {
        color: var(--q-running);
        border-color: var(--q-running);
      }
      .pill.needs-approval {
        color: var(--q-warn);
        border-color: var(--q-warn);
      }
      .pill.done {
        color: var(--q-good);
        border-color: var(--q-good);
      }
      .pill.error {
        color: var(--q-bad);
        border-color: var(--q-bad);
      }
      .job {
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-height: 0;
        flex: 1;
      }
      .job-head {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .job-title {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
        align-items: flex-start;
      }
      .log {
        flex: 1;
        overflow: auto;
        display: flex;
        flex-direction: column;
        gap: 8px;
        border-top: 1px solid var(--q-border);
        padding-top: 8px;
        min-height: 160px;
      }
      .prose {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      pre.code {
        white-space: pre-wrap;
        word-break: break-word;
        background: var(--q-surface-2);
        border-radius: 6px;
        padding: 8px;
        font-family: var(--q-font-mono);
        font-size: 0.78rem;
        max-height: 320px;
        overflow: auto;
      }
      .status {
        font-size: 0.85rem;
        color: var(--q-text-muted);
      }
      .status.error {
        color: var(--q-bad);
      }
      .tool {
        border: 1px solid var(--q-border);
        border-radius: 6px;
        padding: 8px;
        font-size: 0.85rem;
      }
      .tool.asking {
        border-color: var(--q-warn);
      }
      .tool-head {
        display: flex;
        justify-content: space-between;
        gap: 8px;
      }
      .badge {
        font-size: 0.75rem;
        color: var(--q-text-muted);
      }
      .tool-actions {
        display: flex;
        gap: 8px;
        margin-top: 6px;
      }
      .you {
        align-self: flex-end;
        max-width: 85%;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        background: color-mix(in srgb, var(--q-accent) 14%, var(--q-surface));
        border: 1px solid var(--q-border);
        border-radius: 10px;
        padding: 6px 10px;
      }
      .chat-open {
        width: 100%;
        display: flex;
        gap: 8px;
        align-items: center;
        text-align: left;
      }
      .composer {
        display: flex;
        gap: 8px;
        align-items: flex-end;
        border-top: 1px solid var(--q-border);
        padding-top: 8px;
      }
      .composer textarea {
        flex: 1;
        resize: vertical;
        min-height: 3.2em;
        font: inherit;
        color: inherit;
        background: var(--q-surface);
        border: 1px solid var(--q-border);
        border-radius: 6px;
        padding: 6px 8px;
      }
      .result {
        display: flex;
        gap: 10px;
        align-items: center;
        flex-wrap: wrap;
        border-top: 1px solid var(--q-border);
        padding-top: 8px;
      }
      .result span {
        flex: 1;
      }
    `,
  ];
}
