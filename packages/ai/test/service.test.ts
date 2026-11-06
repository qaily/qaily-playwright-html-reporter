import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, setPath, type ArtifactsApi, type DataApi, type RunDetail, type SecretsApi, type Settings } from '@qaily/contracts';
import { AiService } from '../src/service.ts';
import { AiStore } from '../src/store.ts';
import { GitHubRepo } from '../src/github.ts';

const RUN = 'run1';
const detail: RunDetail = {
  run: { run_id: RUN, started_at: '2026-10-12T10:00:00.000Z', ended_at: '2026-10-12T10:30:00.000Z', dur_ms: 1, total: 2, passed: 1, failed: 1,
    flaky: 0, skipped: 0, category: 'ui:web', environment: 'dev', branch: 'main', tag: null, commit: 'abc', ci_url: null, pw_version: null },
  summaries: [{ run_id: RUN, test_id: 't1', started_at: '', title: 'Archive board', status: 'failed', tags: [], dur_ms: 1, project: 'chromium',
    file: '/r/board.spec.ts', err_summary: 'Timeout', err_type: 'timeout', failed_step: 'When I archive' }],
  details: [{ run_id: RUN, test_id: 't1', started_at: '', attempt: 0, worker_idx: 0, parallel_idx: 0, status: 'failed', dur_ms: 1, step_cnt: 0,
    failed_step_idx: null, steps: [], full_title: '', line_num: 3 }],
  errors: [{ run_id: RUN, test_id: 't1', attempt: 0, err_msg: 'Timeout 5000ms', err_type: 'timeout', stack: null, err_file: null, err_line: null,
    err_col: null, snippet: null, failed_step: 'When I archive', locator: null }],
  attachments: [],
};

const GOOD = { summary: 'Sign button is slow', category: 'environment', confidence: 0.7, rootCause: 'Backend 502', evidence: ['502 in log'],
  suggestedFix: 'Retry later', relatedFiles: [] };

/** A fake agent that answers each prompt with the next scripted reply. */
function fakeAgent(replies: string[]) {
  const prompts: string[] = [];
  return {
    prompts,
    connect: async () => ({
      close() {},
      openChat: async () => {
        let handlers: ((a: any) => void)[] = [];
        let n = 0;
        return {
          onAction(h: (a: any) => void) {
            handlers.push(h);
            return () => (handlers = handlers.filter((x) => x !== h));
          },
          cancelTurn() {},
          sendPrompt(text: string) {
            prompts.push(text);
            const turnId = `turn-${++n}`;
            const reply = replies.shift() ?? '';
            setTimeout(() => {
              for (const h of [...handlers]) h({ type: 'chat/responsePart', turnId, part: { kind: 'markdown', id: `p${n}`, content: reply } });
              for (const h of [...handlers]) h({ type: 'chat/usage', turnId, model: 'test-model' });
              for (const h of [...handlers]) h({ type: 'chat/turnComplete', turnId });
            }, 0);
            return turnId;
          },
        };
      },
    }),
  };
}

function service(replies: string[], settings: Settings = setPath(DEFAULT_SETTINGS, 'connections.workingDirectory', '/repo')) {
  const agent = fakeAgent(replies);
  const data = { runDetail: async () => detail, query: async () => [] } as unknown as DataApi;
  const artifacts = { text: async () => ({ text: '', truncated: false }) } as unknown as ArtifactsApi;
  const secrets = { get: () => null } as unknown as SecretsApi;
  const store = new AiStore(new URL('http://report.test/data/'));
  const ai = new AiService({ baseUrl: new URL('http://report.test/'), data, artifacts, secrets, settings: () => settings, store, localWrites: false, connect: agent.connect });
  return { ai, agent, store };
}

const done = (ai: AiService, id: string) =>
  new Promise<void>((resolve) => {
    const off = ai.subscribe(() => {
      const j = ai.job(id)!;
      if (j.status !== 'running') {
        off();
        resolve();
      }
    });
  });

beforeEach(() => {
  // Nothing is published yet.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
});
afterEach(() => vi.unstubAllGlobals());

describe('AiService', () => {
  it('analyzes a test: context in the prompt, validated JSON, saved as a draft with provenance', async () => {
    const { ai, agent } = service(['Looks like the backend.\n```json\n' + JSON.stringify(GOOD) + '\n```']);
    const info = ai.analyzeTest(RUN, 't1');
    await done(ai, info.id);
    const job = ai.job(info.id)!;
    expect(job.status).toBe('done');
    expect(agent.prompts[0]).toContain('Archive board');
    expect(agent.prompts[0]).toContain('Timeout 5000ms');
    expect(agent.prompts[0]).toContain('Do not modify any files');
    const { analysis } = await ai.testResults(RUN, 't1');
    expect(analysis?.draft).toBe(true);
    expect(analysis?.record).toMatchObject({ kind: 'test-analysis', runId: RUN, testId: 't1', model: 'test-model', promptVersion: 'qaily-ai/1' });
    expect(analysis?.record.result).toMatchObject({ category: 'environment', confidence: 0.7 });
    expect(analysis?.record.inputHash).toMatch(/^[0-9a-f]{16}$/);
    expect(await ai.runsWithResults()).toEqual(new Set([RUN]));
  });

  it('asks once more when the answer does not match the schema', async () => {
    const { ai, agent } = service(['```json\n{"summary":"x","category":"weird"}\n```', '```json\n' + JSON.stringify(GOOD) + '\n```']);
    const info = ai.analyzeTest(RUN, 't1');
    await done(ai, info.id);
    expect(ai.job(info.id)!.status).toBe('done');
    expect(agent.prompts[1]).toMatch(/could not be used: category/);
  });

  it('fails the job when the retry is still invalid', async () => {
    const { ai } = service(['nothing', 'still nothing']);
    const info = ai.analyzeTest(RUN, 't1');
    await done(ai, info.id);
    expect(ai.job(info.id)!.status).toBe('error');
    expect(ai.job(info.id)!.error).toMatch(/no ```json block/);
  });

  it('refuses to start without a working directory or when the action is off', () => {
    const { ai } = service([], DEFAULT_SETTINGS);
    expect(ai.canRun('test-fix')).toMatchObject({ ok: false, reason: expect.stringMatching(/Local test repo path/) });
    const off = setPath(setPath(DEFAULT_SETTINGS, 'connections.workingDirectory', '/repo'), 'ai.actions.fixTest', false);
    expect(service([], off).ai.canRun('test-fix').ok).toBe(false);
    expect(() => service([], off).ai.fixTest(RUN, 't1')).toThrow(/Turned off/);
  });

  it('analyzes a run with failure groups and reports where publishing would go', async () => {
    const run = { summary: 'One backend outage', clusters: [{ title: 'Timeouts', issueSigs: ['abc'], category: 'environment', confidence: 0.6,
      rootCause: 'x', recommendation: 'y' }], flakySuspects: [], nextSteps: ['Check backend'] };
    const { ai, agent } = service(['```json\n' + JSON.stringify(run) + '\n```']);
    const info = ai.analyzeRun(RUN);
    await done(ai, info.id);
    expect(agent.prompts[0]).toContain('Failure groups');
    expect(agent.prompts[0]).toContain('Archive board [failed, chromium]');
    expect((await ai.runResult(RUN))?.record.result.nextSteps).toEqual(['Check backend']);
    expect(ai.publishTarget()).toMatchObject({ ok: false, reason: expect.stringMatching(/GitHub owner/) });
  });
});

describe('GitHubRepo.commit', () => {
  it('commits files on top of the branch head and retries when the branch moved', async () => {
    const calls: string[] = [];
    let heads = ['sha-1', 'sha-2'];
    let patches = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname + new URL(url).search;
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${path}`);
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (path.endsWith('/git/ref/heads/main')) return json(200, { object: { sha: heads[0] } });
      if (path.includes('/git/commits/') && method === 'GET') return json(200, { tree: { sha: `tree-of-${path.split('/').pop()}` } });
      if (path.includes('/contents/')) {
        return path.includes('ref=sha-2')
          ? json(200, { encoding: 'base64', content: btoa(JSON.stringify({ schemaVersion: 1, runs: { old: { summary: 'x' } } })) })
          : json(404, { message: 'Not Found' });
      }
      if (path.endsWith('/git/trees')) return json(201, { sha: 'new-tree' });
      if (path.endsWith('/git/commits')) return json(201, { sha: 'new-commit' });
      if (method === 'PATCH') {
        if (patches++ === 0) {
          heads = ['sha-2'];
          return json(422, { message: 'Update is not a fast forward' });
        }
        return json(200, {});
      }
      return json(500, { message: `unexpected ${method} ${path}` });
    }) as typeof fetch;

    const repo = new GitHubRepo({ apiBase: 'https://ghe.example.com/api/v3/', owner: 'acme', repo: 'reports', branch: 'main', token: 'gho_x', fetchImpl });
    let seenIndex: string | null = 'unset';
    const sha = await repo.commit('msg', async (read) => {
      seenIndex = await read('data/ai/index.json');
      return [{ path: 'data/ai/index.json', content: seenIndex ?? '{}' }];
    });
    expect(sha).toBe('new-commit');
    expect(patches).toBe(2);
    expect(seenIndex).toContain('"old"'); // second attempt read the index at the new head
    expect(calls[0]).toBe('GET /api/v3/repos/acme/reports/git/ref/heads/main');
  });

  it('explains auth and permission failures', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 })) as unknown as typeof fetch;
    const repo = new GitHubRepo({ apiBase: 'https://api.github.com', owner: 'a', repo: 'b', branch: 'main', token: 'x', fetchImpl });
    await expect(repo.commit('m', async () => [])).rejects.toThrow(/rejected the token/);
  });
});

describe('AiStore', () => {
  it('prefers a local draft, then serves the published file once the report has it', async () => {
    const store = new AiStore(new URL('http://report.test/data/'));
    const record = { schemaVersion: 1, kind: 'test-analysis', runId: RUN, testId: 't1', createdAt: '2026-10-22T10:00:00Z', provider: 'p',
      promptVersion: 'qaily-ai/1', inputHash: 'h', result: GOOD } as const;
    const path = 'runs/run1/tests/t1.json';
    await store.saveDraft(path, record as never);
    expect((await store.get(path))?.draft).toBe(true);

    await store.publish({ path, record: record as never, draft: true }, { label: 'x', write: async () => {} });
    expect((await store.get(path))?.draft).toBe(false); // pending: still served from this browser

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(record), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    store.refresh();
    expect((await store.get(path))?.record.createdAt).toBe(record.createdAt);
  });
});

describe('AiService chat', () => {
  const idle = (ai: AiService) =>
    new Promise<void>((resolve) => {
      const off = ai.subscribe(() => {
        if (!ai.chat.busy) {
          off();
          resolve();
        }
      });
    });

  it('keeps one agent session across messages and shows the conversation', async () => {
    const { ai, agent } = service(['Hello!', 'Still here.']);
    let opened = 0;
    const connect = agent.connect;
    (ai as unknown as { o: { connect: typeof connect } }).o.connect = async () => {
      const c = await connect();
      return { ...c, openChat: async () => (opened++, c.openChat()) };
    };
    void ai.chat.send('hi');
    await idle(ai);
    void ai.chat.send('  and again  ');
    await idle(ai);
    expect(opened).toBe(1);
    expect(agent.prompts).toEqual(['hi', 'and again']);
    const kinds = ai.chat.transcript.entries.map((e) => (e.kind === 'status' ? 'status' : `${e.kind}:${'text' in e ? e.text : ''}`));
    expect(kinds).toEqual(['status', 'user:hi', 'text:Hello!', 'user:and again', 'text:Still here.']);
    ai.chat.reset();
    expect(ai.chat.transcript.entries).toEqual([]);
  });

  it('explains what is missing instead of opening a session without a working directory', async () => {
    const { ai, agent } = service(['x'], DEFAULT_SETTINGS);
    void ai.chat.send('hi');
    await idle(ai);
    expect(agent.prompts).toEqual([]);
    const last = ai.chat.transcript.entries.at(-1)!;
    expect(last.kind === 'status' && last.error && last.text).toContain('Local test repo path');
  });
});
