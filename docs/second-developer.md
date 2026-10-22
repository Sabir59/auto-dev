# A second developer: connectivity, security and setup (2026-10-17)

> Project overview: `docs/PROJECT_HANDOFF.md`. This note covers how a second developer uses AI Worker from their own computer, why it's done that way, and what was changed to make it safe.

## 1. What runs where today
- **Worker console** (`worker-ui/server.mjs`, `127.0.0.1:8799`, loopback only)
  - One Node process. It serves the page and its JSON API: workspaces, workers, teams, git, github, runs and the `/events` stream, files, prompts, account and models.
  - It also opens folder dialogs on its own desktop (`/pick-folder`).
  - It starts every worker (`claude.exe`) and the worker's MCP servers on its own computer.
  - Its guard checks the Host header (loopback names only). Changes also need the same Origin, `X-Worker-Console` and JSON.
  - **It has no user accounts: whoever reaches it acts as the owner of that computer.**
  - Optional: `worker-ui/devctl.mjs` on `127.0.0.1:8796`, the dashboard's ON/OFF switches.
- **Figma bridge** (`bridge/server.js`, `localhost:8787`, loopback only)
  - HTTP `POST /command` (from `mcp/server.mjs`, `FIGMA_BRIDGE_URL`), `GET /status`, `POST /shutdown`, and a WebSocket `/ws` for the plugin.
  - The plugin's UI (`plugin/ui.html`) has `ws://localhost:8787/ws` built in, and the bridge keeps one plugin connection (the newest wins).
  - **Things that assume one computer:**
    - the plugin's localhost URL;
    - plain `ws://`, which Figma's HTTPS iframe allows only to localhost;
    - exports are written to the bridge's disk and returned as a local path that the worker then reads.
- **Worker runtime**
  - `claude.exe` runs on the console's computer: `CLAUDE_BIN`, or a global npm install.
  - It uses that computer's `~/.claude` login, so it's the owner's Claude subscription.
  - Its working directory is the workspace folder there.
  - It gets the console's environment, without `CLAUDE_*` variables or integration tokens (`FIGMA_*`, `BUILDER_*`, `GITHUB_*`, `GH_*`).
  - Its Read and Write tools are limited to the workspace (plus the exports folders).
  - **Shell (`node`, `curl`), when a worker has it, runs with the full rights of that computer's user.**
- **GitHub (all per computer)**
  - The connection token: `~/.github-connector/credentials.json`.
  - The registry: `worker-ui/github.json`.
  - Assignments: `workspaces.json`.
  - Checkouts: the workspace folders on that disk.
  - Push: that computer's own Git sign-in.

## 2. What a worker could reach (assessment) and what changed
| Route | Before | Now |
|---|---|---|
| **Shell** (`node`, `curl`) | Anything the user can do: forge console API calls (raise its own repository access, push), read other files and credentials. | **Unchanged.** It can't be contained inside one user account. Shell is an explicit capability, and it's off in repository-assigned workspaces and under protected branches. |
| **Browser tool** | It could open the console's page and act as the person (push, grant access, edit workers). In Work workspaces it could open **any** `file://`: `~/.claude`, `~/.github-connector`, other projects. | **Fixed.** It never reaches the console, the bridge or devctl, whether by navigation, frame, page script, WebSocket or address spelling. After a redirect into them, the page is reset before anything is returned. `file://` only inside the workspace and its exports. |
| **WebFetch** | No rule against the console's address. | **Fixed.** Denied by the runtime for `localhost`, `*.localhost`, `127.0.0.1`, `[::1]` and `0.0.0.0`. |
| **A web page in the developer's own browser** | It could send Figma commands to the bridge (no Origin or Host check) and take over the plugin's WebSocket. The console was already protected. | **Fixed.** The bridge refuses requests that carry a web page's Origin, Host names that aren't loopback, and WebSockets from web origins. |
| **Another developer's files or credentials** | Not reachable if each developer runs their own copy. On a shared host, every developer's runs would be the same OS user and the same Claude login, with nothing between them. | One copy per developer (below). |

**Remaining (known):**
- **A redirect reaches a service once.** When a site redirects the worker's browser into one of the platform's services, the browser itself follows the redirect, so that GET reaches the service once. Nothing comes back to the worker, and the console's GET routes change nothing.
- **Bridge WebSocket from a sandboxed frame.** A sandboxed frame on a malicious site also has Origin `"null"`, which is what the Figma plugin sends, so it could still open the bridge's WebSocket.
- **Local programs can read the console's GET API.** Any program on the computer can call it.

## 3. Options for a two-developer trial
| Option | What it takes | Verdict |
|---|---|---|
| **One remote worker backend, each developer's Figma plugin connecting to it** | User accounts on the console. TLS (`wss://`) and authentication on the bridge, a configurable plugin URL, and one plugin connection per user (today: one in total). Exports moved across machines. Every developer's runs on one Claude subscription and one OS user, with shell on the host. | Not safe or ready by tomorrow. |
| **Shared dashboard, local worker and runtime per developer** | The local part works today. The *shared* dashboard needs accounts and syncing of runs, workers and registries: days of work. | Use the local part now. Share through GitHub. |
| **A tunnel or private network (Tailscale, Cloudflare) to the owner's console** | Fast to open. It hands the remote person the owner's computer, files and Claude account through an API with no accounts. Their Figma plugin still can't reach a remote bridge (`ws://localhost` is built in). | Only a supervised screen-share is acceptable. Not for use. |

**Chosen: every developer runs their own copy, and GitHub is what they share.**
- **Each developer has their own:** console, bridge and plugin, Claude login, Git sign-in, and GitHub token.
- **Shared between them:**
  - the repositories, through GitHub: the registry, per-worker access and the work-branch rule apply on each machine;
  - this repository, and the worker definitions in `workers/*.json`.
- Nothing is exposed to the network, and no developer's credentials or files are reachable by the other.

## 4. Setting up the second computer (Windows, about 15 minutes)
1. **Install the tools.**
   - Node.js 20+ and Git.
   - The worker runtime: `npm install -g @anthropic-ai/claude-code`.
   - Then run `claude` once and `/login` with **your own** Claude account.
2. **Get the code and its packages.**
   - `git clone https://github.com/Sabir59/auto-dev`, then `cd auto-dev/figma-ai-executor`.
   - Run `npm install` in `mcp`, `bridge` and `browser-adapter`.
   - Then, in `browser-adapter`: `npx playwright install chromium`.
3. **Set your Git identity:** `git config --global user.name "…"` and `git config --global user.email …`.
4. **Start the services.**
   - `node worker-ui/devctl.mjs`, which gives the dashboard switches; or start them yourself with `node worker-ui/server.mjs` (the Figma bridge starts itself when Figma work begins; `cd bridge && npm start` also works).
   - Open `http://localhost:8799`.
5. **Connect Figma.** In Figma desktop: Plugins > Development > Import plugin from manifest > `plugin/manifest.json`. Open your file and run "AI Executor (POC)". A person has to do this in each file they open: Figma has no API for it.
6. **Check everything:** `node worker-ui/doctor.mjs --seed-workers`. It checks all of the above and adds the shared worker definitions. It shows no tokens and changes nothing else.
7. **Optional, GitHub.** Sidebar > GitHub > paste your own fine-grained token. Register the repository, and add your clone as a workspace and assign it (`docs/github.md`).

## 5. Tests for this change
- **`node bench/security/local-boundaries-test.mjs`: 7/7** (no model).
  - The bridge, run as an isolated instance on port 8788:
    - a web page's command and shutdown are refused;
    - a rebinding Host is refused;
    - a web page's WebSocket is refused, while the plugin's (Origin null) and local programs are accepted.
  - The real browser adapter:
    - seven spellings of the platform's addresses are refused, with no request arriving;
    - an ordinary local site works, while its frame, fetch and WebSocket to the platform are blocked;
    - a redirect is caught and nothing is returned;
    - `file://` works inside the workspace only.
- **`bash bench/workspace-ui/run-suite.sh boundaries`: 2/2** (real runtime, Haiku). For both the General worker and a defined worker, WebFetch to `localhost` and `127.0.0.1` was denied by the runtime, and the browser refused the console.
- **`node bench/figma-executor/live-batch-test.mjs`: 11/11.** The real Figma plugin, through the bridge restarted with its new guard. The plugin connects with Origin `null`.
- **Existing tests:**
  - browser capture 5/5;
  - the adapter canary test: full profile **0 leaks (before: 15)**, inspect 0;
  - `doctor.mjs` run on this computer, and with a missing runtime.
