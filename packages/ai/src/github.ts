// Commits files to a GitHub repo from the browser with the Git Data API (one commit for several files).
// Works with github.com (https://api.github.com) and GitHub Enterprise Server (https://<host>/api/v3).

export interface GitHubRepoOptions {
  apiBase: string;
  owner: string;
  repo: string;
  branch: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export interface RepoFile {
  path: string;
  content: string;
}

export class GitHubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

function b64ToUtf8(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export class GitHubRepo {
  private o: GitHubRepoOptions;
  private fetchImpl: typeof fetch;

  constructor(o: GitHubRepoOptions) {
    this.o = { ...o, apiBase: o.apiBase.replace(/\/+$/, '') };
    this.fetchImpl = o.fetchImpl ?? ((...args) => fetch(...args));
  }

  get label(): string {
    return `${this.o.owner}/${this.o.repo}@${this.o.branch}`;
  }

  private async api<T>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<{ status: number; data: T | null }> {
    const res = await this.fetchImpl(`${this.o.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.o.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return { status: res.status, data: res.status === 204 ? null : ((await res.json()) as T) };
    if (okStatuses.includes(res.status)) return { status: res.status, data: null };
    const detail = ((await res.json().catch(() => null)) as { message?: string } | null)?.message ?? res.statusText;
    const repo = `${this.o.owner}/${this.o.repo}`;
    if (res.status === 401) throw new GitHubError(401, 'GitHub rejected the token (401). Store a fresh `gh auth token` in Settings → Tokens.');
    if (res.status === 403 || res.status === 404) {
      throw new GitHubError(res.status, `No write access to ${repo} (${res.status}: ${detail}). The token needs the "repo" scope, and SSO authorization for the org if it uses SSO.`);
    }
    throw new GitHubError(res.status, `GitHub API ${method} ${path} failed (${res.status}): ${detail}`);
  }

  private repoPath(): string {
    return `/repos/${encodeURIComponent(this.o.owner)}/${encodeURIComponent(this.o.repo)}`;
  }

  async login(): Promise<string | null> {
    try {
      return (await this.api<{ login: string }>('GET', '/user')).data?.login ?? null;
    } catch {
      return null;
    }
  }

  /** A file's text at a commit (or the branch head); null when it doesn't exist. */
  async read(path: string, ref = this.o.branch): Promise<string | null> {
    const enc = path.split('/').map(encodeURIComponent).join('/');
    const { data } = await this.api<{ content?: string; encoding?: string }>('GET', `${this.repoPath()}/contents/${enc}?ref=${encodeURIComponent(ref)}`, undefined, [404]);
    if (!data?.content) return null;
    return data.encoding === 'base64' ? b64ToUtf8(data.content) : data.content;
  }

  /**
   * Creates one commit. `build` receives a reader for the parent commit, so files that merge with existing content
   * (an index) are computed fresh; if the branch moved meanwhile, the whole thing is retried.
   */
  async commit(message: string, build: (read: (path: string) => Promise<string | null>) => Promise<RepoFile[]>, attempts = 3): Promise<string> {
    const base = this.repoPath();
    const branch = encodeURIComponent(this.o.branch);
    for (let attempt = 1; ; attempt++) {
      const ref = (await this.api<{ object: { sha: string } }>('GET', `${base}/git/ref/heads/${branch}`)).data!;
      const parent = ref.object.sha;
      const parentCommit = (await this.api<{ tree: { sha: string } }>('GET', `${base}/git/commits/${parent}`)).data!;
      const files = await build((path) => this.read(path, parent));
      const tree = (await this.api<{ sha: string }>('POST', `${base}/git/trees`, {
        base_tree: parentCommit.tree.sha,
        tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
      })).data!;
      const commit = (await this.api<{ sha: string }>('POST', `${base}/git/commits`, { message, tree: tree.sha, parents: [parent] })).data!;
      const update = await this.api('PATCH', `${base}/git/refs/heads/${branch}`, { sha: commit.sha, force: false }, [422]);
      if (update.status !== 422) return commit.sha;
      // 422: the branch moved (someone else published); rebuild on top of the new head.
      if (attempt >= attempts) throw new GitHubError(422, 'The branch kept changing while publishing. Try again.');
    }
  }
}
