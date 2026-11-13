# AI in the report

The report can ask an AI agent, running on **your own machine**, to analyse failures:

| Action | Where | What you get |
|---|---|---|
| **Analyze with AI** | Tests → failed or flaky test → AI card | Category (product bug, test bug, environment, test data, flaky, unclear), confidence, root cause, evidence, suggested fix, related files |
| **Fix with AI** | Same card | The agent edits your local test checkout (under tool approval) and reports the files it changed. Nothing is committed or pushed. |
| **Analyze all failures** | Issues → pick one run in Scope → AI summary | Summary, failure groups with root cause and recommendation, flaky suspects, next steps. Each group's note also appears on the matching issue card. |

Runs that have AI results are marked ✨ on Monitoring and Weekly.

## How it works

```
Report page (browser) ──WebSocket──► `code agent host` on your machine ──► Copilot (or the claude agent)
       │                                     │ reads your local test repo (working directory)
       │ context pack: error, steps, code frame, history, page snapshot, network log (capped)
       ▼
  result (validated JSON) → draft in this browser → Publish → data/ai/… in the report
```

- Each job gets its own agent session, so jobs never share context.
- The agent can't read the report itself. The page sends what it needs in the prompt: the error, steps, code frame,
  30-run history, the `error-context` page snapshot and the end of `network-log-filtered`. All of it is capped by
  Settings → AI → Context size cap. CI paths in stack traces are rewritten through Settings → Connections → Path mapping.
- The answer must contain one JSON block matching a fixed schema. If it doesn't, the agent is asked once more, and
  after that the job fails with the reason.
- Agent text is only ever rendered as text, never as HTML.

## Set up

1. **Start the agent host** (VS Code):

   ```bash
   code agent host --port 8081 --connection-token "$(openssl rand -hex 16)"
   # Windows (PowerShell): code agent host --port 8081 --connection-token ([guid]::NewGuid().ToString('N'))
   ```

   Copy the printed `Local: ws://127.0.0.1:8081?tkn=…` line. If `code` isn't on PATH on a Mac, use
   `"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"`.

2. **Settings → Connections:**
   - **AI agent host URL:** paste the `ws://…` URL. The `?tkn=…` part can stay in it, or store the token
     separately in Settings → Tokens.
   - **Local test repo path:** an absolute path to a checkout of the test repository. Use a dedicated checkout:
     the host approves reads, writes and "safe" shell commands inside it by itself.
   - **Path mapping** (optional): e.g. `/runner/_work/my-tests/my-tests/` → your checkout.

3. **Sign the host in to Copilot**, either way:
   - Store `gh auth token` (a `gho_…` OAuth token) in Settings → Tokens → GitHub token. Personal access tokens
     (`ghp_`, `github_pat_`) do not work through the agent host.
   - Or connect VS Code's Agents window to the host (`chat.remoteAgentHosts` setting). The host then keeps
     VS Code's sign-in for all clients.

4. Click **✨ AI** (bottom right) → **Connect**. Chrome may ask to allow access to devices on your local network; allow it.

Settings → AI: agent provider (`copilotcli` by default, or `claude` if the host offers it), GitHub host for Copilot
(GitHub Enterprise with its own domain only; it changes host-wide config), context size cap, and which actions are enabled.

## Tool approvals

The ✨ AI panel shows each job's live transcript. When the agent wants to run something the host doesn't approve
by itself, the panel shows the command with **Deny first** (focused) and the approve options. You also get a
toast if the panel is closed. Stop cancels a running job.

## Drafts and publishing

A finished job is saved as a **draft in this browser** (IndexedDB) and shown at once with a "Draft" badge.
**Publish** writes it into the report so everyone sees it:

| Report opened via | Publish writes to | Needs |
|---|---|---|
| `qaily-report serve` | `data/ai/…` on disk, via the local server (loopback-only route) | nothing |
| GitHub Pages | one commit to the report repo (`data/ai/<record>` + `data/ai/index.json`) | Settings → Connections (team): GitHub API base, owner, repo, branch, data folder; plus a GitHub token with `repo` scope (SSO-authorized for the org) |

On Pages the result keeps showing from the browser until the site has redeployed. Every record stores provenance:
model, time, author (GitHub login), prompt version and a hash of the context sent.

The same GitHub settings also let **Settings → For the team → Commit to GitHub** work on Pages (it commits
`data/settings.json`).

Files:

```
data/ai/index.json
data/ai/runs/<run_id>/summary.json            Analyze all failures
data/ai/runs/<run_id>/tests/<test_id>.json    Analyze with AI
data/ai/runs/<run_id>/tests/<test_id>.fix.json  Fix with AI
```

## Security notes

- The connection token is a remote-control key for an agent that can run tools on your machine. It's stored like
  other tokens (this tab by default) and never shared or exported.
- The host listens on 127.0.0.1 by default; never start it with `--host 0.0.0.0` or `--without-connection-token`.
- The host auto-approves reads/writes inside the working directory and safe shell commands even in manual mode.
  Point it at a dedicated checkout.
