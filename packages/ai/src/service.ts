import {
  AI_PROMPT_VERSION,
  AI_RESULT_SCHEMAS,
  AI_SCHEMA_VERSION,
  aiRecordPath,
  issueKey,
  type AiApi,
  type AiJobInfo,
  type AiJobStatus,
  type AiKind,
  type AiRecord,
  type AiState,
  type ArtifactsApi,
  type AttachmentRecord,
  type DataApi,
  type RunDetail,
  type SecretsApi,
  type Settings,
  type StoredAiRecord,
} from '@qaily/contracts';
import { extractJson } from './extract.ts';
import { GitHubAiWriter, LocalServerAiWriter, type AiStore, type AiWriter } from './store.ts';
import { GitHubRepo } from './github.ts';
import {
  analyzeRunPrompt,
  analyzeTestPrompt,
  buildRunContext,
  buildTestContext,
  fixTestPrompt,
  retryPrompt,
} from './prompts.ts';
import { AhpConnection, normalizeGitHubHost, parseHostInput, type AhpChat } from './session.ts';
import { Transcript, runTurn, type ChatLike } from './transcript.ts';
import type { AhpClientOptions } from './ahp-client.ts';

export interface AiServiceOptions {
  baseUrl: URL;
  data: DataApi;
  artifacts: ArtifactsApi;
  secrets: SecretsApi;
  settings: () => Settings;
  store: AiStore;
  /** The local server accepts writes (publish goes there instead of GitHub). */
  localWrites: boolean;
  clientOptions?: AhpClientOptions;
  /** For tests: replaces the real agent host connection. */
  connect?: () => Promise<{ openChat(provider: string, cwd: string): Promise<ChatLike & Partial<Pick<AhpChat, 'confirmTool'>>>; close(): void; agentName?: string }>;
}

export class AiJob {
  readonly id = crypto.randomUUID();
  readonly kind: AiKind;
  readonly runId: string;
  readonly testId?: string;
  readonly title: string;
  readonly createdAt = new Date();
  status: AiJobStatus = 'running';
  error?: string;
  result: StoredAiRecord | null = null;
  readonly transcript: Transcript;
  readonly abort = new AbortController();
  chat: (ChatLike & Partial<Pick<AhpChat, 'confirmTool'>>) | null = null;

  constructor(kind: AiKind, runId: string, testId: string | undefined, title: string, onChange: () => void) {
    this.kind = kind;
    this.runId = runId;
    this.testId = testId;
    this.title = title;
    this.transcript = new Transcript(onChange);
  }

  get info(): AiJobInfo {
    const asking = this.status === 'running' && this.transcript.pendingApprovals().length > 0;
    return { id: this.id, kind: this.kind, runId: this.runId, testId: this.testId, title: this.title, status: asking ? 'needs-approval' : this.status, error: this.error };
  }

  confirm(turnId: string, toolCallId: string, approved: boolean, optionId?: string): void {
    this.chat?.confirmTool?.({ turnId, toolCallId, approved, optionId });
  }

  cancel(): void {
    this.abort.abort();
  }
}

type ChatSession = ChatLike & Partial<Pick<AhpChat, 'confirmTool'>>;

/**
 * A free-form conversation with the agent: one agent session that keeps its context across messages,
 * opened on the first message. Nothing is saved; "New chat" starts a fresh session.
 */
export class AiChatThread {
  transcript: Transcript;
  busy = false;
  private session: ChatSession | null = null;
  private abort: AbortController | null = null;
  private open: () => Promise<ChatSession>;
  private onChange: () => void;

  constructor(open: () => Promise<ChatSession>, onChange: () => void) {
    this.open = open;
    this.onChange = onChange;
    this.transcript = new Transcript(onChange);
  }

  async send(text: string): Promise<void> {
    if (this.busy || !text.trim()) return;
    this.busy = true;
    this.abort = new AbortController();
    this.onChange();
    try {
      if (!this.session) {
        this.transcript.status('Starting an agent session…');
        this.session = await this.open();
      }
      await runTurn(this.session, text.trim(), this.transcript, this.abort.signal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'Cancelled') this.transcript.status('Stopped.');
      // runTurn already shows chat errors.
      else if (!this.transcript.entries.some((e) => e.kind === 'status' && e.text === msg)) this.transcript.status(msg, true);
    } finally {
      this.busy = false;
      this.abort = null;
      this.onChange();
    }
  }

  confirm(turnId: string, toolCallId: string, approved: boolean, optionId?: string): void {
    this.session?.confirmTool?.({ turnId, toolCallId, approved, optionId });
  }

  stop(): void {
    this.abort?.abort();
  }

  /** The connection went away: the next message opens a new session (the transcript stays). */
  detach(): void {
    this.stop();
    this.session = null;
  }

  reset(): void {
    this.detach();
    this.transcript = new Transcript(this.onChange);
    this.onChange();
  }
}

const KIND_LABEL: Record<AiKind, string> = { 'test-analysis': 'Analyze', 'test-fix': 'Fix', 'run-analysis': 'Analyze run' };

async function shortHash(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class AiService implements AiApi {
  private o: AiServiceOptions;
  private listeners = new Set<() => void>();
  private resultListeners = new Set<() => void>();
  private showListeners = new Set<(jobId: string) => void>();
  private _state: AiState = { status: 'disconnected', message: 'Not connected to an AI agent.' };
  private conn: Awaited<ReturnType<NonNullable<AiServiceOptions['connect']>>> | null = null;
  private connecting: Promise<void> | null = null;
  private _jobs: AiJob[] = [];
  private author: Promise<string | null> | null = null;
  readonly chat: AiChatThread;

  constructor(o: AiServiceOptions) {
    this.o = o;
    this.chat = new AiChatThread(() => this.openChatSession(), () => this.emit());
  }

  private async openChatSession(): Promise<ChatSession> {
    await this.connect();
    const s = this.o.settings();
    if (!s.connections.workingDirectory) throw new Error('Set "Local test repo path" in Settings → Connections first: the agent works in that folder.');
    return this.conn!.openChat(s.ai.provider, s.connections.workingDirectory);
  }

  // ── connection ──────────────────────────────────────────────────────────

  state(): AiState {
    return this._state;
  }

  private setState(s: AiState): void {
    this._state = s;
    this.emit();
  }

  connect(): Promise<void> {
    if (this._state.status === 'ready') return Promise.resolve();
    this.connecting ??= this.doConnect().finally(() => (this.connecting = null));
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    const settings = this.o.settings();
    this.setState({ status: 'connecting', message: 'Connecting to the agent host…' });
    try {
      this.conn = this.o.connect ? await this.o.connect() : await this.connectHost(settings);
      this.setState({ status: 'ready', message: `Connected (${settings.ai.provider}).`, agent: this.conn.agentName ?? settings.ai.provider });
    } catch (err) {
      this.conn = null;
      this.setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  private async connectHost(settings: Settings) {
    const { url, tkn } = parseHostInput(settings.connections.agentHostUrl);
    const token = this.o.secrets.get('agentHostToken') ?? tkn;
    if (!token) throw new Error('No agent host connection token. Store it in Settings → Tokens, or include ?tkn=… in the host URL.');
    const conn = new AhpConnection(this.o.clientOptions);
    await conn.connect(url, token);
    // Only when configured: this is host-wide config, shared with VS Code.
    if (settings.ai.githubHost) await conn.setGitHubEnterpriseUri(normalizeGitHubHost(settings.ai.githubHost));
    const provider = settings.ai.provider;
    const agent = conn.agent(provider);
    const gh = this.o.secrets.get('githubToken');
    // Optional: the host keeps one sign-in for all clients (e.g. pushed by VS Code).
    if (gh) await conn.authenticate(provider, gh);
    return {
      agentName: agent.displayName ?? provider,
      openChat: (p: string, cwd: string) => conn.openChat(p, cwd),
      close: () => conn.close(),
    };
  }

  disconnect(): void {
    for (const j of this._jobs) if (j.status === 'running') j.cancel();
    this.chat.detach();
    this.conn?.close();
    this.conn = null;
    this.setState({ status: 'disconnected', message: 'Disconnected.' });
  }

  canRun(kind: AiKind): { ok: boolean; reason?: string } {
    const s = this.o.settings();
    const enabled = { 'test-analysis': s.ai.actions.analyzeTest, 'test-fix': s.ai.actions.fixTest, 'run-analysis': s.ai.actions.analyzeRun }[kind];
    if (!enabled) return { ok: false, reason: 'Turned off in Settings → AI.' };
    if (!s.connections.workingDirectory) return { ok: false, reason: 'Set "Local test repo path" in Settings → Connections first.' };
    if (!s.connections.agentHostUrl) return { ok: false, reason: 'Set the AI agent host URL in Settings → Connections first.' };
    return { ok: true };
  }

  // ── jobs ────────────────────────────────────────────────────────────────

  jobs(): AiJob[] {
    return this._jobs;
  }

  job(id: string): AiJob | undefined {
    return this._jobs.find((j) => j.id === id);
  }

  jobFor(kind: AiKind, runId: string, testId?: string): AiJobInfo | null {
    return this._jobs.find((j) => j.kind === kind && j.runId === runId && j.testId === testId)?.info ?? null;
  }

  showJob(jobId: string): void {
    for (const fn of this.showListeners) fn(jobId);
  }

  onShowJob(fn: (jobId: string) => void): () => void {
    this.showListeners.add(fn);
    return () => this.showListeners.delete(fn);
  }

  analyzeTest(runId: string, testId: string): AiJobInfo {
    return this.start('test-analysis', runId, testId);
  }

  fixTest(runId: string, testId: string): AiJobInfo {
    return this.start('test-fix', runId, testId);
  }

  analyzeRun(runId: string): AiJobInfo {
    return this.start('run-analysis', runId);
  }

  private start(kind: AiKind, runId: string, testId?: string): AiJobInfo {
    const running = this._jobs.find((j) => j.kind === kind && j.runId === runId && j.testId === testId && j.status === 'running');
    if (running) {
      this.showJob(running.id);
      return running.info;
    }
    const check = this.canRun(kind);
    if (!check.ok) throw new Error(check.reason);
    const job = new AiJob(kind, runId, testId, `${KIND_LABEL[kind]}: ${testId ? 'test' : 'run'}`, () => this.emit());
    this._jobs = [job, ...this._jobs].slice(0, 20);
    this.emit();
    this.showJob(job.id);
    void this.run(job);
    return job.info;
  }

  private async run(job: AiJob): Promise<void> {
    const settings = this.o.settings();
    try {
      await this.connect();
      job.transcript.status('Collecting context from the report…');
      const { context, title } = await this.context(job, settings);
      (job as { title: string }).title = `${KIND_LABEL[job.kind]}: ${title}`;
      if (job.abort.signal.aborted) throw new Error('Cancelled');

      job.transcript.status('Starting an agent session…');
      job.chat = await this.conn!.openChat(settings.ai.provider, settings.connections.workingDirectory);
      const prompt = { 'test-analysis': analyzeTestPrompt, 'test-fix': fixTestPrompt, 'run-analysis': analyzeRunPrompt }[job.kind](context);
      let reply = await runTurn(job.chat, prompt, job.transcript, job.abort.signal);
      let parsed = this.validate(job.kind, reply);
      if (!parsed.ok) {
        job.transcript.status(`The answer did not match the expected format (${parsed.error}); asking once more.`);
        reply = await runTurn(job.chat, retryPrompt(job.kind, parsed.error), job.transcript, job.abort.signal);
        parsed = this.validate(job.kind, reply);
        if (!parsed.ok) throw new Error(`The agent's answer could not be used: ${parsed.error}`);
      }

      const record: AiRecord = {
        schemaVersion: AI_SCHEMA_VERSION,
        kind: job.kind,
        runId: job.runId,
        ...(job.testId ? { testId: job.testId } : {}),
        createdAt: new Date().toISOString(),
        ...(await this.authorLogin().then((a) => (a ? { author: a } : {}))),
        provider: settings.ai.provider,
        ...(job.transcript.model ? { model: job.transcript.model } : {}),
        promptVersion: AI_PROMPT_VERSION,
        inputHash: await shortHash(context),
        result: parsed.value,
        transcript: reply.length > 20_000 ? `${reply.slice(0, 20_000)}\n…` : reply,
      } as AiRecord;
      job.result = await this.o.store.saveDraft(aiRecordPath(job.kind, job.runId, job.testId), record);
      job.status = 'done';
      this.emitResults();
      job.transcript.status('Saved as a draft. Review it, then publish it to the report.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      job.status = job.abort.signal.aborted || msg === 'Cancelled' ? 'cancelled' : 'error';
      job.error = msg;
      if (job.status === 'error') job.transcript.status(msg, true);
    } finally {
      this.emit();
    }
  }

  private validate(kind: AiKind, reply: string): { ok: true; value: unknown } | { ok: false; error: string } {
    const json = extractJson(reply);
    if (json === undefined) return { ok: false, error: 'no ```json block found' };
    const r = AI_RESULT_SCHEMAS[kind].safeParse(json);
    if (r.success) return { ok: true, value: r.data };
    const issue = r.error.issues[0];
    return { ok: false, error: `${issue?.path.join('.') || 'value'}: ${issue?.message ?? 'invalid'}` };
  }

  private authorLogin(): Promise<string | null> {
    const token = this.o.secrets.get('githubToken');
    const gh = this.o.settings().connections.github;
    if (!token) return Promise.resolve(null);
    this.author ??= new GitHubRepo({ ...gh, token }).login();
    return this.author;
  }

  // ── context ─────────────────────────────────────────────────────────────

  private async context(job: AiJob, settings: Settings): Promise<{ context: string; title: string }> {
    const detail = await this.o.data.runDetail(job.runId);
    const capBytes = settings.ai.contextCapKb * 1024;
    const pathMap = settings.connections.pathMap;
    if (job.kind === 'run-analysis') {
      if (!detail.run) throw new Error('The run was not found in the report.');
      return { context: buildRunContext({ ...(await this.runContextParts(detail)), run: detail.run, pathMap, capBytes }), title: detail.run.run_id };
    }
    const summary = detail.summaries.find((s) => s.test_id === job.testId);
    if (!summary) throw new Error('The test was not found in this run.');
    const attempts = detail.details
      .filter((d) => d.test_id === job.testId)
      .sort((a, b) => a.attempt - b.attempt)
      .map((d) => ({ detail: d, errors: detail.errors.filter((e) => e.test_id === job.testId && e.attempt === d.attempt) }));
    if (!attempts.length) attempts.push({ detail: null as never, errors: detail.errors.filter((e) => e.test_id === job.testId) });
    const failingAttempt = [...attempts].reverse().find((a) => a.errors.length)?.detail?.attempt ?? attempts[attempts.length - 1]?.detail?.attempt ?? 0;
    const atts = detail.attachments.filter((a) => a.test_id === job.testId && a.attempt === failingAttempt);
    const [history, errorContext, networkLog] = await Promise.all([
      this.history(job.testId!),
      this.attachmentText(job.runId, atts, 'error-context', 40_000, 'head'),
      this.attachmentText(job.runId, atts, 'network-log-filtered', 30_000, 'tail'),
    ]);
    return {
      context: buildTestContext({ run: detail.run, summary, attempts, history, errorContext, networkLog, pathMap, capBytes }),
      title: summary.title,
    };
  }

  private async history(testId: string) {
    const now = Date.now();
    try {
      const rows = await this.o.data.query<{ started_at: number; status: string; branch: string | null }>(
        `SELECT epoch_ms(started_at) AS started_at, status, branch FROM tests WHERE test_id = '${testId.replaceAll("'", "''")}'
         ORDER BY started_at DESC LIMIT 30`,
        { from: new Date(now - 90 * 86_400_000), to: new Date(now + 1) },
      );
      return rows.reverse();
    } catch {
      return [];
    }
  }

  private async attachmentText(runId: string, atts: AttachmentRecord[], name: string, max: number, keep: 'head' | 'tail') {
    const att = atts.find((a) => a.name === name);
    if (!att) return undefined;
    try {
      // For the tail we still read from the start (no suffix ranges on every host), then keep the end.
      const { text } = await this.o.artifacts.text(runId, att.path, keep === 'head' ? max : 512 * 1024);
      return keep === 'head' ? text.slice(0, max) : text.slice(-max);
    } catch {
      return undefined;
    }
  }

  private async runContextParts(detail: RunDetail) {
    const run = detail.run!;
    let sigs = new Map<string, string>();
    try {
      const rows = await this.o.data.query<{ test_id: string; issue_sig: string }>(
        `SELECT test_id, issue_sig FROM issues WHERE run_id = '${run.run_id.replaceAll("'", "''")}'`,
        { from: new Date(Date.parse(run.started_at) - 1), to: new Date(Date.parse(run.started_at) + 1) },
      );
      sigs = new Map(rows.map((r) => [r.test_id, r.issue_sig]));
    } catch {
      // Without the rollup, fall back to an unhashed key; the Issues page then can't attach notes by signature.
    }
    const byTest = new Map(detail.summaries.map((s) => [s.test_id, s]));
    const clusters = new Map<string, RunContextCluster>();
    for (const e of detail.errors) {
      const first = detail.errors.filter((x) => x.test_id === e.test_id).sort((a, b) => a.attempt - b.attempt)[0];
      if (first !== e) continue;
      const sig = sigs.get(e.test_id) ?? issueKey(e.err_msg, e.failed_step).slice(0, 40);
      const s = byTest.get(e.test_id);
      const c = clusters.get(sig) ?? {
        sig,
        errType: e.err_type,
        message: e.err_msg,
        failedStep: e.failed_step,
        location: e.err_file ? `${e.err_file}:${e.err_line ?? '?'}` : null,
        tests: [],
      };
      c.tests.push({ title: s?.title ?? e.test_id, status: s?.status ?? 'failed', project: s?.project ?? '' });
      clusters.set(sig, c);
    }
    return {
      clusters: [...clusters.values()].sort((a, b) => b.tests.length - a.tests.length),
      flaky: detail.summaries.filter((s) => s.status === 'flaky').map((s) => ({ title: s.title, project: s.project })),
    };
  }

  // ── results ─────────────────────────────────────────────────────────────

  async testResults(runId: string, testId: string) {
    const [analysis, fix] = await Promise.all([
      this.o.store.get<'test-analysis'>(aiRecordPath('test-analysis', runId, testId)),
      this.o.store.get<'test-fix'>(aiRecordPath('test-fix', runId, testId)),
    ]);
    return { analysis, fix };
  }

  runResult(runId: string) {
    return this.o.store.get<'run-analysis'>(aiRecordPath('run-analysis', runId));
  }

  runsWithResults(): Promise<Set<string>> {
    return this.o.store.runsWithResults();
  }

  private writer(): AiWriter | null {
    if (this.o.localWrites) return new LocalServerAiWriter(this.o.baseUrl);
    const gh = this.o.settings().connections.github;
    const token = this.o.secrets.get('githubToken');
    if (gh.owner && gh.repo && token) return new GitHubAiWriter(new GitHubRepo({ ...gh, token }), gh.dataPath);
    return null;
  }

  publishTarget(): { ok: boolean; label: string; reason?: string } {
    const w = this.writer();
    if (w) return { ok: true, label: w.label };
    const gh = this.o.settings().connections.github;
    const reason = !gh.owner || !gh.repo
      ? 'Set the GitHub owner and repo in Settings → Connections (team), or open the report with `qaily-report serve`.'
      : 'Store a GitHub token in Settings → Tokens to publish.';
    return { ok: false, label: 'nowhere', reason };
  }

  async publish(stored: StoredAiRecord): Promise<void> {
    const w = this.writer();
    if (!w) throw new Error(this.publishTarget().reason);
    await this.o.store.publish(stored, w);
    for (const j of this._jobs) if (j.result?.path === stored.path) j.result = { ...stored, draft: false };
    this.emit();
    this.emitResults();
  }

  async discardDraft(stored: StoredAiRecord): Promise<void> {
    await this.o.store.discard(stored.path);
    for (const j of this._jobs) if (j.result?.path === stored.path) j.result = null;
    this.emit();
    this.emitResults();
  }

  onResults(fn: () => void): () => void {
    this.resultListeners.add(fn);
    return () => this.resultListeners.delete(fn);
  }

  private emitResults(): void {
    for (const fn of this.resultListeners) fn();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

interface RunContextCluster {
  sig: string;
  errType: string;
  message: string;
  failedStep: string | null;
  location: string | null;
  tests: { title: string; status: string; project: string }[];
}
