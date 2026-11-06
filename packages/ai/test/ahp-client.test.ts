import { describe, expect, it, vi } from 'vitest';
import { AhpClient, ConnectionError, RpcError } from '../src/ahp-client.ts';
import { AhpConnection, buildSocketUrl, normalizeGitHubHost, parseHostInput, pathToFileUri } from '../src/session.ts';
import { FakeSocket, tick } from './fake-socket.ts';

async function connected(opts = {}) {
  const client = new AhpClient('ws://127.0.0.1:1?tkn=x', { WebSocketImpl: FakeSocket, pingIntervalMs: 0, ...opts });
  const p = client.connect();
  FakeSocket.last.open();
  await p;
  return { client, ws: FakeSocket.last };
}

describe('AhpClient', () => {
  it('correlates responses to requests by id, out of order', async () => {
    const { client, ws } = await connected();
    const a = client.request('initialize', { channel: 'ahp-root://' });
    const b = client.request('subscribe', { channel: 'ahp-session:/1' });
    const [reqA, reqB] = ws.sent;
    expect(reqA.id).not.toBe(reqB.id);
    ws.push({ jsonrpc: '2.0', id: reqB.id, result: { snapshot: 'B' } });
    ws.push({ jsonrpc: '2.0', id: reqA.id, result: { protocolVersion: '1.0.0' } });
    expect(await a).toEqual({ protocolVersion: '1.0.0' });
    expect(await b).toEqual({ snapshot: 'B' });
    client.close();
  });

  it('rejects with RpcError carrying code and data', async () => {
    const { client, ws } = await connected();
    const p = client.request('initialize', {});
    ws.push({ jsonrpc: '2.0', id: ws.sent[0].id, error: { code: -32005, message: 'bad version', data: { supportedVersions: ['0.9.0'] } } });
    await expect(p).rejects.toSatisfy((e: unknown) => e instanceof RpcError && e.code === -32005);
    client.close();
  });

  it('times out pending requests', async () => {
    const { client } = await connected({ requestTimeoutMs: 20 });
    await expect(client.request('slow', {})).rejects.toThrow(/timed out/);
    client.close();
  });

  it('routes notifications by method and channel, with * wildcard', async () => {
    const { client, ws } = await connected();
    const chatA: string[] = [];
    const any: string[] = [];
    client.on('action', 'ahp-chat:/a', (p) => chatA.push(p.action.type));
    client.on('action', '*', (p) => any.push(p.channel));
    ws.push({ jsonrpc: '2.0', method: 'action', params: { channel: 'ahp-chat:/a', action: { type: 'chat/delta' } } });
    ws.push({ jsonrpc: '2.0', method: 'action', params: { channel: 'ahp-chat:/b', action: { type: 'chat/delta' } } });
    expect(chatA).toEqual(['chat/delta']);
    expect(any).toEqual(['ahp-chat:/a', 'ahp-chat:/b']);
    client.close();
  });

  it('tolerates unknown notifications, bad JSON and throwing listeners', async () => {
    const { client, ws } = await connected();
    const seen: string[] = [];
    client.on('action', '*', () => {
      throw new Error('boom');
    });
    client.on('action', '*', (p) => seen.push(p.action.type));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ws.emit('message', { data: 'not json' });
    ws.push({ jsonrpc: '2.0', method: 'something/new', params: { channel: 'x' } });
    ws.push({ jsonrpc: '2.0', method: 'action', params: { channel: 'x', action: { type: 'chat/future' } } });
    err.mockRestore();
    warn.mockRestore();
    expect(seen).toEqual(['chat/future']);
    client.close();
  });

  it('dispatch auto-increments clientSeq', async () => {
    const { client, ws } = await connected();
    expect(client.dispatch('c', { type: 'x' })).toBe(1);
    expect(client.dispatch('c', { type: 'x' })).toBe(2);
    expect(ws.sent.map((m) => [m.method, m.params.clientSeq, 'id' in m])).toEqual([
      ['dispatchAction', 1, false],
      ['dispatchAction', 2, false],
    ]);
    client.close();
  });

  it('connect rejects when the socket closes before opening (403 / host down)', async () => {
    const client = new AhpClient('ws://127.0.0.1:1?tkn=bad', { WebSocketImpl: FakeSocket, pingIntervalMs: 0 });
    const p = client.connect();
    FakeSocket.last.emit('error');
    FakeSocket.last.emit('close', { code: 1006, reason: '' });
    await expect(p).rejects.toSatisfy((e: unknown) => e instanceof ConnectionError && /403/.test((e as Error).message));
  });

  it('fails pending requests when the connection drops', async () => {
    const { client, ws } = await connected();
    const closed: number[] = [];
    client.onClose((info) => closed.push(info.code));
    const p = client.request('createSession', {});
    ws.emit('close', { code: 1006, reason: '' });
    await expect(p).rejects.toBeInstanceOf(ConnectionError);
    expect(closed).toEqual([1006]);
  });
});

describe('AhpConnection', () => {
  async function connect() {
    const conn = new AhpConnection({ WebSocketImpl: FakeSocket, pingIntervalMs: 0 });
    const p = conn.connect('ws://127.0.0.1:1', 'tok');
    const ws = FakeSocket.last;
    ws.open();
    await tick();
    return { conn, p, ws };
  }

  it('retries initialize once with the server-supported versions', async () => {
    const { conn, p, ws } = await connect();
    expect(ws.url).toBe('ws://127.0.0.1:1/?tkn=tok');
    ws.push({ jsonrpc: '2.0', id: ws.sent[0].id, error: { code: -32005, message: 'x', data: { supportedVersions: ['0.10.0'] } } });
    await tick();
    expect(ws.sent[1].params.protocolVersions).toEqual(['0.10.0']);
    ws.push({ jsonrpc: '2.0', id: ws.sent[1].id, result: { protocolVersion: '0.10.0', snapshots: [{ resource: 'ahp-root://', state: { agents: [{ provider: 'copilotcli' }] } }] } });
    const res = await p;
    expect(res.protocolVersion).toBe('0.10.0');
    expect(conn.agent('copilotcli').provider).toBe('copilotcli');
    expect(() => conn.agent('nope')).toThrow(/offered: copilotcli/);
    conn.close();
  });

  it('opens a chat per session, using defaultChat exactly as given', async () => {
    const { conn, p, ws } = await connect();
    ws.push({ jsonrpc: '2.0', id: ws.sent[0].id, result: { protocolVersion: '1.0.0', snapshots: [{ resource: 'ahp-root://', state: { agents: [{ provider: 'copilotcli' }] } }] } });
    await p;
    const chatP = conn.openChat('copilotcli', '/repo');
    await tick();
    const create = ws.sent.at(-1);
    expect(create.method).toBe('createSession');
    expect(create.params.workingDirectories).toEqual(['file:///repo']);
    expect(create.params.config).toMatchObject({ autoApprove: 'default', isolation: 'folder', mode: 'interactive' });
    ws.push({ jsonrpc: '2.0', id: create.id, result: null });
    await tick();
    const sub = ws.sent.at(-1);
    ws.push({ jsonrpc: '2.0', id: sub.id, result: { snapshot: { state: { defaultChat: 'ahp-chat://default/abc' } } } });
    await tick();
    ws.push({ jsonrpc: '2.0', id: ws.sent.at(-1).id, result: { snapshot: { state: {} } } });
    const chat = await chatP;
    expect(chat.chatUri).toBe('ahp-chat://default/abc');
    conn.close();
  });

  it('sets the GitHub Enterprise URI and waits for the agents to update', async () => {
    const { conn, p, ws } = await connect();
    ws.push({ jsonrpc: '2.0', id: ws.sent[0].id, result: { protocolVersion: '1.0.0', snapshots: [{ resource: 'ahp-root://', state: { agents: [], config: { values: {} } } }] } });
    await p;
    expect(await conn.setGitHubEnterpriseUri('')).toBe(false);
    const changed = conn.setGitHubEnterpriseUri('https://acme.ghe.com');
    const sent = ws.sent.at(-1);
    expect(sent.params.action).toEqual({ type: 'root/configChanged', config: { githubEnterpriseUri: 'https://acme.ghe.com' } });
    ws.push({ jsonrpc: '2.0', method: 'action', params: { channel: 'ahp-root://', action: sent.params.action } });
    ws.push({ jsonrpc: '2.0', method: 'action', params: { channel: 'ahp-root://', action: {
      type: 'root/agentsChanged', agents: [{ provider: 'copilotcli', protectedResources: [{ resource: 'https://api.acme.ghe.com', required: true }] }],
    } } });
    expect(await changed).toBe(true);
    expect(conn.gitHubEnterpriseUri).toBe('https://acme.ghe.com');
    expect(AhpConnection.authResource(conn.agents[0])).toBe('https://api.acme.ghe.com');
    conn.close();
  });
});

describe('helpers', () => {
  it('parseHostInput accepts a pasted Local: line', () => {
    expect(parseHostInput('  Local: ws://127.0.0.1:49495?tkn=abc-123 ')).toEqual({ url: 'ws://127.0.0.1:49495', tkn: 'abc-123' });
    expect(parseHostInput('ws://localhost:8081')).toEqual({ url: 'ws://localhost:8081', tkn: null });
    expect(() => parseHostInput('http://x')).toThrow();
  });
  it('buildSocketUrl puts the token in tkn', () => {
    expect(buildSocketUrl('ws://127.0.0.1:8081', 'a_b-1')).toBe('ws://127.0.0.1:8081/?tkn=a_b-1');
  });
  it('pathToFileUri handles POSIX and Windows paths', () => {
    expect(pathToFileUri('/Users/me/my project')).toBe('file:///Users/me/my%20project');
    expect(pathToFileUri('C:\\work\\repo')).toBe('file:///C:/work/repo');
    expect(() => pathToFileUri('relative/path')).toThrow();
  });
  it('authResource prefers the required resource', () => {
    expect(AhpConnection.authResource({ provider: 'x', protectedResources: [
      { resource: 'https://api.github.com/repos', required: false },
      { resource: 'https://api.github.com', required: true },
    ] })).toBe('https://api.github.com');
    expect(AhpConnection.authResource({ provider: 'x' })).toBeNull();
  });
  it('normalizeGitHubHost maps inputs to the host config value', () => {
    expect(normalizeGitHubHost('')).toBe('');
    expect(normalizeGitHubHost('https://github.com/')).toBe('');
    expect(normalizeGitHubHost('acme.ghe.com')).toBe('https://acme.ghe.com');
    expect(normalizeGitHubHost('https://github.company.com/some/path')).toBe('https://github.company.com');
  });
});
