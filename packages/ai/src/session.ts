// Session flow on top of AhpClient, split in two:
//   AhpConnection: initialize → authenticate, shared by all jobs
//   AhpChat:       one agent session + chat per job, so jobs never share context

import { AhpClient, RpcError, type AhpClientOptions } from './ahp-client.ts';

export const ROOT = 'ahp-root://';
const PROTOCOL_VERSIONS = ['1.0.0', '0.10.0', '0.9.0'];

export interface AhpAgent {
  provider: string;
  displayName?: string;
  protectedResources?: { resource: string; required?: boolean }[];
}

/** Accepts `ws://127.0.0.1:8081`, `ws://localhost:49495?tkn=…`, or a whole `Local: ws://…` line printed by the host. */
export function parseHostInput(input: string): { url: string; tkn: string | null } {
  const match = String(input).match(/wss?:\/\/\S+/);
  if (!match) throw new Error('The agent host URL must start with ws://');
  const u = new URL(match[0]);
  const tkn = u.searchParams.get('tkn');
  u.searchParams.delete('tkn');
  return { url: u.toString().replace(/\/$/, '').replace(/\/\?$/, ''), tkn };
}

export function buildSocketUrl(url: string, tkn: string): string {
  const u = new URL(url);
  u.searchParams.set('tkn', tkn);
  return u.toString();
}

/** Absolute POSIX (`/Users/me/x`) or Windows (`C:\x`) path → file:// URI. */
export function pathToFileUri(path: string): string {
  const p = String(path).trim();
  if (/^[A-Za-z]:[\\/]/.test(p)) {
    const [drive, ...rest] = p.replace(/\\/g, '/').split('/');
    return `file:///${drive}/` + rest.map(encodeURIComponent).join('/');
  }
  if (p.startsWith('/')) return 'file://' + p.split('/').map(encodeURIComponent).join('/');
  throw new Error('The working directory must be an absolute path');
}

/**
 * `acme.ghe.com`, `https://acme.ghe.com/`, `github.company.com` → `https://<host>`.
 * Empty or github.com → '' (meaning github.com).
 */
export function normalizeGitHubHost(input: string): string {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (['github.com', 'www.github.com', 'api.github.com'].includes(u.host)) return '';
  return `${u.protocol}//${u.host}`;
}

/** StringOrMarkdown → string. */
export function textOf(s: unknown): string {
  if (typeof s === 'string') return s;
  if (s && typeof s === 'object' && 'markdown' in s) return String((s as { markdown: unknown }).markdown);
  return '';
}

/** Coarse token type from its prefix only; never inspect more than that. */
export function tokenKind(token: string): string {
  if (token.startsWith('gho_')) return 'gh CLI OAuth token';
  if (token.startsWith('ghp_')) return 'classic personal access token';
  if (token.startsWith('github_pat_')) return 'fine-grained personal access token';
  return 'unknown token type';
}

export class AhpConnection {
  client: AhpClient | null = null;
  protocolVersion: string | null = null;
  agents: AhpAgent[] = [];
  rootConfig: Record<string, unknown> = {};
  private clientOptions: AhpClientOptions;

  constructor(clientOptions: AhpClientOptions = {}) {
    this.clientOptions = clientOptions;
  }

  async connect(hostUrl: string, tkn: string): Promise<{ protocolVersion: string | null; agents: AhpAgent[] }> {
    const client = new AhpClient(buildSocketUrl(hostUrl, tkn), this.clientOptions);
    this.client = client;
    await client.connect();
    const init = await this.initialize(PROTOCOL_VERSIONS).catch((e) => {
      const supported = e instanceof RpcError && e.code === -32005 ? (e.data as { supportedVersions?: string[] })?.supportedVersions : null;
      if (Array.isArray(supported)) return this.initialize(supported);
      throw e;
    });
    this.protocolVersion = init?.protocolVersion ?? null;
    // `initialize` returns the root snapshot; older hosts need an explicit subscribe.
    let rootState = init?.snapshots?.find?.((s: any) => s.resource === ROOT)?.state;
    if (!rootState) rootState = (await client.request('subscribe', { channel: ROOT }))?.snapshot?.state;
    this.agents = rootState?.agents ?? [];
    this.rootConfig = { ...(rootState?.config?.values ?? {}) };
    client.on('action', ROOT, ({ action }) => {
      if (action?.type === 'root/agentsChanged' && Array.isArray(action.agents)) this.agents = action.agents;
      if (action?.type === 'root/configChanged') {
        this.rootConfig = action.replace ? { ...action.config } : { ...this.rootConfig, ...action.config };
      }
    });
    return { protocolVersion: this.protocolVersion, agents: this.agents };
  }

  private initialize(versions: string[]) {
    return this.client!.request<any>('initialize', {
      channel: ROOT,
      protocolVersions: versions,
      clientId: crypto.randomUUID(),
      clientInfo: { name: 'qaily-report', version: '0.1.0' },
      initialSubscriptions: [ROOT],
    });
  }

  /** The GitHub Enterprise base URI the host is configured for ('' = github.com). */
  get gitHubEnterpriseUri(): string {
    return String(this.rootConfig.githubEnterpriseUri ?? '');
  }

  /**
   * Points the host at github.com ('') or a GitHub Enterprise instance. Host-wide root config, normally pushed by
   * VS Code. Waits (up to 5 s) for the host to republish the agents with the new protected resources.
   */
  async setGitHubEnterpriseUri(uri: string): Promise<boolean> {
    if (uri === this.gitHubEnterpriseUri) return false;
    const client = this.client!;
    const agentsUpdated = new Promise<void>((resolve) => {
      const off = client.on('action', ROOT, ({ action }) => {
        if (action?.type !== 'root/agentsChanged') return;
        off();
        resolve();
      });
      setTimeout(() => {
        off();
        resolve();
      }, 5000);
    });
    client.dispatch(ROOT, { type: 'root/configChanged', config: { githubEnterpriseUri: uri } });
    await agentsUpdated;
    return true;
  }

  /** The resource the agent needs a token for (differs on GitHub Enterprise). */
  static authResource(agent: AhpAgent | undefined): string | null {
    const resources = agent?.protectedResources ?? [];
    return (resources.find((r) => r.required) ?? resources[0])?.resource ?? null;
  }

  agent(provider: string): AhpAgent {
    const agent = this.agents.find((a) => a.provider === provider);
    if (!agent) {
      const offered = this.agents.map((a) => a.provider).join(', ') || 'none';
      throw new Error(`The agent host does not offer "${provider}" (offered: ${offered}). Check Settings → AI → Agent provider.`);
    }
    return agent;
  }

  /** Pushes a GitHub token. Optional: the host keeps one sign-in for all clients (e.g. from VS Code). */
  async authenticate(provider: string, token: string): Promise<string | null> {
    const resource = AhpConnection.authResource(this.agent(provider));
    if (!resource) return null;
    await this.client!.request('authenticate', { channel: ROOT, resource, token });
    return resource;
  }

  async openChat(provider: string, cwd: string, config: Record<string, unknown> = {}): Promise<AhpChat> {
    const client = this.client;
    if (!client || client.closed) throw new Error('Not connected to the agent host');
    this.agent(provider);
    const sessionUri = `ahp-session:/${crypto.randomUUID()}`;
    await client.request(
      'createSession',
      {
        channel: sessionUri,
        provider,
        workingDirectories: [pathToFileUri(cwd)],
        config: { autoApprove: 'default', isolation: 'folder', mode: 'interactive', ...config },
      },
      60_000,
    );
    const sess = await client.request<any>('subscribe', { channel: sessionUri });
    const state = sess?.snapshot?.state ?? {};
    const firstChat = state.chats?.[0];
    // Use defaultChat exactly as given; never build a chat URI ourselves.
    const chatUri: string | undefined = state.defaultChat ?? (typeof firstChat === 'string' ? firstChat : firstChat?.resource);
    if (!chatUri) throw new Error('The new agent session has no chat channel');
    await client.request('subscribe', { channel: chatUri });
    return new AhpChat(client, sessionUri, chatUri);
  }

  close(): void {
    this.client?.close();
    this.client = null;
  }
}

export class AhpChat {
  readonly client: AhpClient;
  readonly sessionUri: string;
  readonly chatUri: string;
  private turnStarts = new Map<string, number>();

  constructor(client: AhpClient, sessionUri: string, chatUri: string) {
    this.client = client;
    this.sessionUri = sessionUri;
    this.chatUri = chatUri;
  }

  onAction(handler: (action: any) => void): () => void {
    return this.client.on('action', this.chatUri, (params) => {
      if (params?.action) handler(params.action);
    });
  }

  sendPrompt(text: string): string {
    const turnId = crypto.randomUUID();
    this.turnStarts.set(turnId, Date.now());
    this.client.dispatch(this.chatUri, {
      type: 'chat/turnStarted',
      turnId,
      startedAt: new Date().toISOString(),
      message: { text, origin: { kind: 'user' } },
    });
    return turnId;
  }

  cancelTurn(turnId: string): void {
    const started = this.turnStarts.get(turnId) ?? Date.now();
    this.client.dispatch(this.chatUri, { type: 'chat/turnCancelled', turnId, duration: Date.now() - started });
  }

  confirmTool(c: { turnId: string; toolCallId: string; approved: boolean; optionId?: string }): void {
    const action: Record<string, unknown> = c.approved
      ? { type: 'chat/toolCallConfirmed', turnId: c.turnId, toolCallId: c.toolCallId, approved: true, confirmed: 'user-action' }
      : { type: 'chat/toolCallConfirmed', turnId: c.turnId, toolCallId: c.toolCallId, approved: false, reason: 'denied' };
    if (c.optionId) action.selectedOptionId = c.optionId;
    this.client.dispatch(this.chatUri, action);
  }
}
