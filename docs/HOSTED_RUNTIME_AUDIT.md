# Hosted runtime audit (2026-10-20)

What the product is today, checked against the code at `e810db0` (main), and what stood between it and a hosted, website-first pilot. The resulting design is in `docs/HOSTED_ARCHITECTURE.md`; deployment is in `docs/CLOUD_DEPLOYMENT.md`.

Markers: **VERIFIED** (read in code or run), **INFERRED** (a conclusion from the code, not run).

## 1. Current architecture (VERIFIED)

```
Browser (worker-ui/workspace.html, vanilla JS, one file)
  │ same-origin fetch + SSE (/events)
  ▼
worker-ui/server.mjs  (Node http, 127.0.0.1:8799, one process, one person)
  │ workspaces · workers · teams · runs · git · files · mentions · attachments · GitHub
  │ spawns per run: claude -p --input-format stream-json … (cwd = workspace folder)
  ▼
Claude Code CLI (claude.exe 2.1.283), signed in with the owner's claude.ai subscription
  ├── mcp/server.mjs ─HTTP─► bridge/server.js (127.0.0.1:8787) ─WS─► Figma desktop plugin
  ├── mcp/reader-server.mjs ─► api.figma.com (token in ~/.figma-reader)
  ├── mcp/builder-server.mjs ─► Builder.io (keys in ~/.builder-adapter)
  ├── mcp/repo-server.mjs   ─► git in the workspace (the person's Git sign-in)
  └── browser-adapter/server.mjs ─► Playwright Chromium (fresh profile per worker process)
```

- **Entry point:** `node worker-ui/server.mjs`. Data dir `worker-ui/` or `WORKER_CONSOLE_DATA`. Port `WORKER_CONSOLE_PORT` (8799).
- **Storage:** JSON files and JSONL logs in the data dir (`workspaces.json`, `workers.json`, `teams.json`, `github.json`, `runs/<id>.{meta.json,jsonl,raw.jsonl,worker.json,worker.md,state.json}`). Written atomically (tmp + rename) where it matters. Survives a restart.
- **Run lifecycle:** `starting → running → waiting (outcome replied|done|needs|error) → finished | stopped | failed | interrupted`. A run that was live when the server died becomes `interrupted` on next load, and the log says so. One live run at a time.
- **Model runtime:** the console spawns the installed `claude` binary (`CLAUDE_BIN` or the npm package on `PATH`), with `CLAUDE_CONFIG_DIR=~/.claude`. Authentication is whatever that config dir is signed in as: the owner's **claude.ai subscription**.
- **Enforcement below the model:** `--tools`/`--allowedTools`, `--restricted`, `--strict-mcp-config`, permission deny rules, per-adapter checks (browser URL rules, Figma file lock, Builder test-space rule, repo tools' branch checks), server-side Git refusals, realpath containment for `/file`, `/tree`, mentions and knowledge.
- **Access principle:** worker capabilities ∩ workspace mode ∩ Team scope ∩ platform rules (`workerRuntime()`), verified by the existing suites.

## 2. Model runtime: can the current one be hosted? (VERIFIED against Anthropic's docs, 2026-10-20)

- `code.claude.com/docs/en/agent-sdk/overview`: *"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods…"*, and the SDK/CLI as a product backend is governed by the Commercial Terms.
  - **So the subscription sign-in cannot back the hosted product.** The same docs list "run the CLI as a subprocess with `-p`" as a supported way to drive the agent loop.
- `code.claude.com/docs/en/llm-gateway*`: Claude Code supports an organisation-run gateway: `ANTHROPIC_BASE_URL` plus a gateway credential (`ANTHROPIC_AUTH_TOKEN` → `Authorization: Bearer`). The provider key stays on the gateway; traffic is billed to the key owner's Console account. The gateway must forward `anthropic-*` headers and bodies unchanged and stream without buffering.
- **Decision:** keep the same runtime (the Claude Code CLI, whose permission system, MCP client, sessions and `--restricted` the platform's security depends on), authenticated with **an Anthropic API key held only by the hosted control plane**, reached through a built-in gateway. No second Worker runtime.

## 3. Local-only assumptions (VERIFIED)

| Where | Assumption | Hosting impact |
|---|---|---|
| `server.mjs` listen + request guard | 127.0.0.1 only; Host/Origin must be `localhost:<port>` | No remote access, no user identity |
| Whole data model | one data dir, one person | No users, no ownership, no isolation between people |
| Workspaces | any absolute folder on the machine (`/pick-folder` = Windows dialog); "Executor" = this repo | A hosted user could register server paths |
| Model runtime | `~/.claude` subscription login | Not permitted for a hosted product (§2) |
| Worker processes | run with the console's OS user; Work has `Bash(node:*)`, `Bash(curl:*)`; `--setting-sources project,local` runs a repo's `.claude` hooks | Arbitrary code as the server's user; one person could read another's data |
| Git network | the person's Git Credential Manager / SSH | No credential on a server |
| GitHub App callback | `http://<loopback host>/github/callback` | Needs the public HTTPS origin |
| GitHub App secret | `~/.github-connector/app.json` on each machine | Must live in the control plane only |
| Figma Executor | plugin in the person's Figma desktop app → bridge on 127.0.0.1:8787 | The plugin can't reach a server's loopback; needs the person's interactive Figma app |
| Figma Reader / Builder credentials | `~/.figma-reader`, `~/.builder-adapter` | Shared per machine, not per person |
| Exports | written into the repo (`exports/`, `browser-adapter/exports/`) | Shared between people; a read-only image can't write there |
| Dev tools | `devctl.mjs`, `/__control/shutdown`, "Local services" switches, `doctor.mjs` | Local development only |
| Account panel | subscription usage (`get_usage`) | Not meaningful with an API key |
| OS | `pick-folder.ps1`, `mklink` in tests; the server itself is portable Node | Hosted target is Linux |

## 4. Adapters: hosted status before this work

| Adapter | Today | Hosted |
|---|---|---|
| Files (Read/Write/Edit/Glob/Grep) | confined by Claude Code to cwd + `--add-dir`; server-side realpath checks | Works server-side; needs per-person workspace roots |
| Shell (`Bash(node:*)`, `curl`) | the console user's full rights | **Not safe hosted** without an OS boundary and egress control |
| Web (WebFetch/WebSearch) | loopback denied by permission rules | Works; must also not reach cloud metadata / private networks |
| Browser (Playwright) | fresh profile per worker process; file:// limited to the workspace; platform ports blocked | Works on Linux with Chromium deps; must block private networks; exports per person |
| Git (console commit/push, repo tools) | person's Git sign-in | Needs a server-held, per-person GitHub credential |
| GitHub (API) | GitHub App user authorization (uncommitted at the start of this task; committed as `4ed62ef`) or PAT; one connection per console | Works per person if each person has their own console; needs public callback and a secret broker |
| Figma Reader (REST) | per-machine token; no UI to connect | Hostable per person; **no website flow to connect** |
| Figma Executor (plugin) | interactive Figma desktop app + local bridge | **Cannot run unattended on a server** |
| Builder.io | per-machine keys; no UI to connect | Hostable per person; no website flow to connect |

## 5. Authentication, authorization, persistence, isolation gaps (VERIFIED)

1. **No user identity** anywhere; the loopback guard was the only access control.
2. **No ownership**: every run, workspace, worker, Team and connection belongs to "the computer".
3. **No isolation**: all runs share one OS user and one data dir.
4. **Persistence** is already file-based and restart-safe per data dir; it has no notion of owner.
5. **Secrets**: integration tokens are kept out of worker env (`workerEnv()`), but a worker with shell can read any file the OS user can.

## 6. Required changes (all implemented in this task unless marked)

1. A **control plane** (`worker-ui/gateway.mjs`): sign-in, sessions, CSRF/Origin checks, one console per person, the model gateway holding the API key, the GitHub App secret broker, health checks.
2. **One console per person**, unchanged in its product logic, started as **its own Linux UID** with its own data dir (0700). Ownership = which console a session reaches; IDs from another person's console don't exist in yours.
3. **Model-provider boundary** (`worker-ui/provider.mjs`): `claude-subscription` (local only, refused hosted), `anthropic-api` (local, own key), `anthropic-gateway` (hosted).
4. **Hosted platform rules** in `server.mjs` (`AIW_HOSTED=1`): no shell, no Figma plugin tools, `--restricted` always (no repo hooks/settings), workers at most "commit" (the person pushes), workspaces only under the person's own root, no "Executor" workspace, no folder picker, no repo file viewer, per-person exports, metadata hosts denied for WebFetch, private networks blocked in the browser.
5. **Server-side Git credentials**: the person's GitHub App token, given to each git network command through a one-shot credential helper (never stored in the repo, never in a worker's env).
6. **Website**: sign-in page, signed-in identity and sign-out, hosted workspace creation and clone without server paths, unavailable capabilities shown as such.

## 7. Blockers to cloud deployment that remain (see `docs/CLOUD_DEPLOYMENT.md` §9)

- Egress firewall (block cloud metadata and private ranges for the per-person UIDs) is a **deployment** control: scripted and verified on a Linux kernel here, but it must be installed and checked on the target host.
- Live verification with a real Anthropic API key, a real GitHub App and github.com: **not done** (no credentials in this environment).
- Figma editing needs the person's Figma desktop app: **not hosted** (documented limitation, decision for the owner).
