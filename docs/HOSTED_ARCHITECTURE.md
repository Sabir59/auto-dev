# Hosted architecture (pilot)

How AI Worker runs as a website for a small group of trusted people. Written 2026-10-20 with the code that implements it. What was there before, and why it changed, is in `docs/HOSTED_RUNTIME_AUDIT.md`; how to deploy it is in `docs/CLOUD_DEPLOYMENT.md`.

**The rule this design follows:** the product (Workers, Teams, Workspaces, runs, Git, adapters) is the same code as locally, `worker-ui/server.mjs`. Hosting adds a control plane in front of it and an OS boundary around it. There is no second Worker runtime and no second run lifecycle.

## 1. Request and run flow

```
Browser ──HTTPS──► load balancer (TLS) ──HTTP──► gateway  worker-ui/gateway.mjs   :AIW_PORT
                                                   │ sign-in, session cookie, Origin check, routing
                                                   │ (one console per person, started on demand)
                                                   ▼
                       person's console  worker-ui/server.mjs  AIW_HOSTED=1  127.0.0.1:<9100+n>
                       uid 20000+n, data dir <AIW_DATA>/users/<id>/ (mode 700)
                         │ workspaces · workers · teams · runs · git · files · GitHub · Figma
                         │ per run: claude -p --restricted --tools … --mcp-config … (cwd = workspace)
                         ▼
                       Claude Code CLI (same uid)  ──ANTHROPIC_BASE_URL + per-console token──►
                         │                         gateway model endpoint 127.0.0.1:AIW_MODEL_PORT
                         │                           └─► Anthropic API (x-api-key: the platform's key)
                         ├─ browser-executor (Playwright, fresh profile per worker process)
                         ├─ figma-reader (REST, the person's own Figma token)
                         ├─ repo (git in the workspace; the person's identity; no push)
                         └─ builder (Builder.io, if the person's keys exist)
```

A run, step by step:
1. The page posts `POST /runs` with this site's Origin and the session cookie.
2. The gateway checks the session and the Origin, starts the person's console if it isn't running, and forwards the request with the console's internal secret. Cookies, `Authorization` and `X-Forwarded-*` aren't forwarded.
3. The console does exactly what it does locally: checks the worker, Team and workspace, snapshots the definition and Team (`runs/<id>.worker.json`), computes the tool set (`workerRuntime()`), writes the context, and spawns the CLI in the workspace folder.
4. The CLI calls the model through the gateway's model endpoint. The gateway swaps the console's token for the provider key, streams the answer back unbuffered and logs only `user, path, status, ms`.
5. Tool calls, results, `NEEDS:`/`DONE:`/`ARTIFACT:` lines become events in `runs/<id>.jsonl`; the page follows them over SSE (`/events`, replayed from the start on every reconnect).
6. The person reviews diffs in Changes & versions, commits and pushes from there.

## 2. Control plane and execution plane

| | Process | Runs as | Holds |
|---|---|---|---|
| **Control plane** | `gateway.mjs` | root in its container (needed to start consoles as other uids) | accounts and sessions (`<AIW_DATA>/control/`, 700), the provider API key, the GitHub App client secret |
| **Execution plane** | one `server.mjs` per person, and the CLI and adapter processes it starts | that person's uid, `no_new_privs`, process limits | that person's data only: runs, workspaces, workers, Teams, their GitHub/Figma/Builder tokens, their Claude sessions |

They're one deployable image. The split is by process and uid, not by service, which is the smallest boundary that keeps one person's runs away from another's data.

## 3. Authentication and sessions (`gateway.mjs`, `users.mjs`)

- **Accounts:** invite-only. The operator runs `node worker-ui/users.mjs add <email>` on the server. Passwords are scrypt hashes (N=2¹⁵); unknown emails cost the same time as wrong passwords.
- **Sign-in:** `POST /login`, which must carry this site's Origin. 10 failures per address or account in 15 minutes → 429.
- **Session:** 256-bit random token in an `HttpOnly; SameSite=Lax; Secure` cookie (`__Host-` prefixed on HTTPS). Only its SHA-256 is stored (`sessions.json`, survives restarts).
  - Ends after 12 h idle or 7 days (`AIW_SESSION_IDLE_HOURS`, `AIW_SESSION_MAX_DAYS`), on sign-out, when the account is disabled, and when its password changes.
- **CSRF:** every state-changing request needs `Origin` = `AIW_PUBLIC_ORIGIN` and, when sent, `Sec-Fetch-Site: same-origin`. Preflights are never approved. The console then applies its own guard (custom header, JSON body).
- **Signed out:** `/` redirects to `/login`; the API answers 401 with `signIn`, and the page goes there. Nothing reaches a console.
- **Headers:** CSP on HTML (scripts and connections to self only), `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, HSTS on HTTPS, `no-store` on JSON.

## 4. Ownership and isolation

**Ownership is structural.** Each person has their own console with its own data dir, so a run, workspace, worker, Team, artifact or connection of someone else isn't in yours: guessing an id gives 404 (tested for runs, events, files and messages).

**Isolation boundaries, from the outside in:**

| Boundary | Enforced by | Prevents |
|---|---|---|
| Per-person uid, data dir mode 700, control dir root-only | the kernel (gateway starts consoles with `setpriv --reuid --regid --clear-groups --no-new-privs --inh-caps=-all`, under `prlimit` nproc/nofile/fsize/core) | one person's processes reading or writing another's files, the account store or the gateway's secrets |
| Console answers only the gateway | `AIW_INTERNAL_SECRET` on every request (constant-time compare), loopback only | another process on the host driving a person's console |
| Model endpoint needs a per-console token | gateway | using the platform's key without being a running console; tokens change on every console start |
| Hosted platform rules (`AIW_HOSTED=1` in `server.mjs`) | the console and the CLI's permission system | see the next table |
| Existing workspace, Team and worker narrowing | unchanged (`workerRuntime()`, `runScope()`, adapters, server-side Git) | everything it prevented locally |

**Hosted platform rules** (the "platform security" term of *effective access = worker ∩ workspace mode ∩ Team scope ∩ platform*):
- **No shell.** `shell` (`Bash(node:*)`, `Bash(curl:*)`) isn't loaded for any worker, the General worker included. Shell would be arbitrary code with network access, and egress control isn't verified yet.
- **`--restricted` for every worker.** A cloned repository's `.claude` settings, hooks and `CLAUDE.md` never run on the servers.
- **No `.git`/`.claude` writes.**
- **Runtime deny rules** for the person's GitHub/Figma/Builder credential folders, the Claude config dir (other conversations' transcripts) and the console's own records (worker and Team definitions, workspaces, run logs).
- **No Figma plugin tools** (they need the person's Figma desktop app).
- **Workers at most "commit" on a repository;** the person pushes.
- **Workspaces are only folders the console creates** under the person's data dir: no typed or browsed server paths, no "Executor" workspace, no file viewer on the platform's own files, no folder picker, no dev-control routes.
- **WebFetch** is denied for loopback and cloud-metadata names.
- **The browser** refuses loopback, private, link-local (metadata), CGNAT, ULA addresses (names resolved, every address checked), file URLs outside the workspace, and screenshots go to the person's folder.
- **Console Git never runs repository hooks** (`core.hooksPath` → an empty folder).

**Tested** (`bench/hosted/hosted-test.mjs`):
- a worker's read of another person's file, of the account store and outside its workspace is refused;
- `Bash` doesn't exist;
- a metadata fetch is refused;
- writes stay in the workspace;
- concurrent runs don't cross;
- the browser refusals hold;
- on Linux: the uid/mode of every person's folder, that another uid gets "Permission denied", and that the console and worker processes run as the person's uid.

## 5. Model provider (`worker-ui/provider.mjs`)

| `MODEL_PROVIDER` | Where | Authentication |
|---|---|---|
| `claude-subscription` | local default | the CLI's own claude.ai sign-in. **Refused hosted:** Anthropic doesn't allow a claude.ai login to back a product for others |
| `anthropic-api` | local, a developer's own key | `ANTHROPIC_API_KEY` in the worker env. Refused hosted |
| `anthropic-gateway` | hosted default | `ANTHROPIC_BASE_URL` = the gateway's loopback model endpoint, `ANTHROPIC_AUTH_TOKEN` = a per-console token. Claude Code's documented LLM-gateway variables |

- **Provider failures:** the gateway forwards `anthropic-*` headers and bodies unchanged (Claude Code's gateway contract) and streams events as they arrive.
  - It passes through `retry-after`, `x-should-retry` and `anthropic-ratelimit-*`.
  - It answers its own failures in the provider's error shape: 502 unreachable, 504 no headers in 120 s, idle stream cut after 10 min.
  - Per person: 4 concurrent requests (`AIW_MODEL_MAX_CONCURRENT`) and an optional daily cap (`AIW_MODEL_DAILY_REQUESTS`).
- **No fallback:** a console with no valid provider configuration doesn't start. A production gateway refuses a non-https or loopback upstream (a test upstream needs `AIW_ENV=test`).
- **Replaceable:** another provider is a new entry in `provider.mjs` plus, for the hosted path, the gateway's upstream. Bedrock and Vertex are supported by the same CLI through their own base-URL variables. Worker, Team and Workspace code doesn't change.
- **Not verified live:** no Anthropic API key was available while building this. The tests use a scripted fake provider (`bench/hosted/fake-anthropic.mjs`, clearly marked) behind the real CLI and the real gateway.

## 6. Run lifecycle and persistence

- **States:** the existing ones (`server.mjs` "runs"):
  - `starting` (workspace bound, worker spawning);
  - `running`;
  - `waiting`, with `outcome` = `replied` | `done` | `needs` (the worker can't go on without the person: a `NEEDS:` line) | `error`;
  - then `finished` | `stopped` | `failed` | `interrupted`.
- **Persistence:** file-based, per person, on the data volume. Run metadata, the event log, the raw stream, snapshots (definition, Team version, context) and attachments are written as they happen and survive restarts. The Claude sessions are in the person's own config dir, so `--resume` works after a restart.
- **Shutdown and restart:** on SIGTERM the gateway stops taking requests and SIGTERMs every console. Each console marks live runs `interrupted` with a log line, kills their worker processes, and exits. After the restart, sessions are still valid; a message to an interrupted run resumes it (tested on Linux).
- **Cancellation:** Stop kills the worker process; the gateway closes the provider stream (tested: the upstream sees the close).
- **One live worker per person:** the existing console rule, kept. The page ends the open conversation before a new one. Different people run at the same time.
- **Cleanup:**
  - each worker process has its own browser, which goes with it;
  - per-conversation Scratch folders and workspaces are the person's data and are kept;
  - temp files go to the person's own `tmp/`.

## 7. GitHub and Git

- **Connect with GitHub:** the existing GitHub App web flow (`github-app.mjs`), hosted:
  - the callback is `AIW_PUBLIC_ORIGIN/github/callback` (top-level GET; the `SameSite=Lax` cookie is sent);
  - the state is one-time, 10 minutes, and must match this console;
  - PKCE S256.
- **The client secret never reaches a console.** Code exchange, refresh and revoke go to the gateway's broker (`/github/token`, `/github/revoke` on the loopback model port). The broker checks the console's broker token and that a code exchange returns to this site.
- **Repository selection** is GitHub's: the installation's chosen repositories, intersected with the person's own access.
- **Clone** goes into a new folder of the person's own. Git network commands (clone, push, `ls-remote`) authenticate with the connection's token through `git-credential.mjs`, given to that one git process only and answering only for GitHub's host. Nothing is written to the repository's config.
- **Workers:** per-repository access as before (read/write/commit), capped at **commit** hosted; `repo_push` isn't registered.
- **Commits** carry the signed-in person's name and email.
- **Push:** the person's explicit action (Changes & versions), to the registered remote only, never forced. Team `protect_branch` policies are refused server-side; GitHub's own branch protection applies on top.
- **GitHub App permissions needed hosted:** Contents: read & write, plus Metadata: read (`docs/CLOUD_DEPLOYMENT.md` §4). Locally the app still needs Metadata only.

## 8. Adapter support matrix (hosted)

| Adapter / capability | Hosted status | Evidence |
|---|---|---|
| Files: Read, Write, Edit, Glob, Grep | **Hosted, verified** (fake model, real CLI) | write in workspace; outside reads refused |
| Attachments, `@` mentions | Hosted, unchanged code; **not separately re-tested hosted** | existing suites (local) |
| Web: WebFetch, WebSearch | Hosted; WebFetch denial of metadata **verified**; a successful fetch/search **not verified** (needs the live model path) | hosted suite |
| Shell (`node`, `curl`) | **Not available hosted** (platform rule) | `Bash` absent in the hosted suite |
| Browser (Playwright) | **Hosted, verified** on Linux as a person uid and on Windows: a public page loads, the screenshot lands in the person's folder, every refusal holds | hosted suite |
| Git: status, log, diff, branch, commit (repo tools) | **Hosted, verified** (commit with the person's identity) | hosted suite |
| Git push | **Person only**, hosted, verified to a registered remote; protected branches refused | hosted suite |
| GitHub App connection | **Hosted, verified against the mock**; live github.com **not verified** | hosted suite |
| Figma Reader (links, REST) | **Hosted**; connection page verified against the live Figma API with a rejected token; reading a real file **not verified** (no token) | hosted suite |
| Figma Executor (plugin, edit) | **Requires the person's interactive Figma desktop app; not hosted.** Requirement reports "Not available in the hosted product", worker writes `NEEDS:` | hosted suite |
| Builder.io | Hosted code path unchanged; **no website flow to add keys** (requires implementation); reports "Not connected" | — |

## 9. Security assumptions and known gaps

1. **Pilot users are trusted.** A person's own worker can still read anything in that person's workspace, and send it out through WebFetch, WebSearch or the browser (as locally: `HOSTED_RUNTIME_AUDIT.md` §5). The model is not the boundary; the uid and the runtime's rules are.
2. **Network egress is restricted by a deployment firewall, not by the platform code.** `deploy/egress-firewall.sh` blocks cloud metadata, private ranges and loopback services (except the model port) for the person uids. It was verified on a Linux kernel (`bench/hosted/egress-test.sh`, and the whole hosted suite with it active), but it must be installed and checked on the target host before launch (`CLOUD_DEPLOYMENT.md` §6).
3. **The gateway runs as root** in its container, to switch uids. It handles HTTP from the internet, so a bug in it is high impact. Next step: a small privileged spawner, with the gateway itself unprivileged.
4. **No disk quotas;** RLIMIT_FSIZE caps a single file only. Monitor the volume.
5. **Secrets at rest** (GitHub/Figma tokens, sessions) are files protected by uid/mode on the data volume, not a KMS. Encrypt the volume (`CLOUD_DEPLOYMENT.md` §5).
6. **One host.** Consoles are processes of the gateway: the pilot scales vertically. Several hosts would need sticky routing per person and shared storage.
