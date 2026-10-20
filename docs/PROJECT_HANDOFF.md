# PROJECT HANDOFF: AI Workspace / Workers / Teams

**The canonical master handoff for this repository.** Written 2026-10-06, at HEAD `e44501c` plus the handoff commit.

It's meant for a senior engineer or AI agent joining with no conversational history. It tells you what the product is, why it looks the way it does, what's proven, what isn't, and what to do next.

**How to read the markers:**
- **VERIFIED**: checked against the repository, the git history or a test run while writing this document.
- **INFERRED**: a reasonable conclusion from the code or the conversation, not separately proven.
- **OPEN / UNKNOWN**: not known; check before relying on it.
- **CONVERSATION-ONLY**: decided or discussed with the owner, but not written in the repository before this document.

Where this document and the code disagree, **the code wins**. Fix this document.

> ## HARD CONSTRAINT: 20-DAY LAUNCH WINDOW (from 2026-10-06)
> The owner has a **20-day deadline to launch**. **LAUNCH > architecture perfection.**
>
> Don't migrate to Next.js, rewrite the frontend, rebuild the architecture, or add remote workspaces, WhatsApp, billing, enterprise accounts, multi-agent orchestration, a new credential system or speculative abstractions. **The only exception is a concrete launch blocker that requires it.** See §17–18.
>
> **Don't push to GitHub unless the owner explicitly says so.** Never add a Claude/AI `Co-authored-by` trailer to commits (§21).

---

## Contents
1. Product identity
2. Long-term vision
3. Core concepts: Workspace, Worker, Team
4. Current architecture
5. The Claude runtime
6. Tools and adapters
7. Security model
8. Team implementation
9. Test status
10. MATW, the primary proof environment
11. History and milestones
12. Design philosophy
13. UI / UX principles
14. Current product state
15. Known limitations
16. Git / code state
17. Next 20 days: launch priority
18. Launch definition
19. Commercial / business vision
20. Future architecture
21. Architectural decisions: do not accidentally reverse
22. If a new Claude joins tomorrow

Machine-readable companion: `docs/PROJECT_MEMORY.json`.

> **2026-10-20: hosted pilot.** The product can now also run as a website for a few trusted people: a gateway (`worker-ui/gateway.mjs`) signs people in, runs one console per person as their own Linux user, and holds the Anthropic API key (the claude.ai subscription can't back a hosted product). Where this document says "local only", "no auth" or "the owner's subscription", that's still true of the local console; the hosted mode is described in `docs/HOSTED_ARCHITECTURE.md` and `docs/CLOUD_DEPLOYMENT.md`.

---

## 1. Product identity

### What it is now (VERIFIED)
A **local AI Workspace**: a web page served by a small Node server (`worker-ui/server.mjs`, port 8799). In it, a person:
- registers **Workspaces**: real folders on their computer, each in **Inspect** (read-only) or **Work** mode, plus the built-in **Scratch** mode for work with no project (each conversation gets its own folder);
- defines specialised **Workers**: identity, mission, capabilities mapped to real tools, workflow, knowledge, hard limits, requirements and memory;
- groups them into **Teams**: shared knowledge, resources, instructions, *enforced* policies, prompts and versions;
- gives a task and watches the worker do it.

The worker is a headless **Claude Code** process (`claude.exe`) that the console starts with a computed tool set, context and folder. It acts on real environments:
- files in the workspace;
- a real **Figma** file, through a plugin and a local bridge;
- a real **browser**, through Playwright;
- the web;
- Git, through the console's own commit and push.

The person sees every tool call live, reviews the changes as Git versions, and commits or pushes from the page.

### The problem it solves
Organisations have real work inside real systems: a codebase, a Figma file, a website. Chat assistants only *talk* about that work. This product lets a specialised AI worker **do the work inside those systems, under explicit, enforced boundaries**, with every action observable and every result reviewable.

### Who it's for
- **Now:** the owner and their organisation (MATW, a charity's donation-site frontend team; §10) as the first real environment.
- **Intended:** organisations that want specialised AI workers operating in their own repositories, design files and web systems.

### How it differs from a chatbot
- It acts through real tools on real resources, not text alone.
- Boundaries are **enforced below the model**: tool lists, permission deny rules, adapter checks, and server-side Git refusals. They aren't requests in a prompt.
- Missing access produces an explicit `NEEDS:` request, not an improvised workaround.
- Runs are recorded, replayable and resumable, with snapshots of exactly what the worker was given.

### How it differs from Claude Code
- **The runtime *is* Claude Code.** The product is the layer around it:
  - workspaces with security profiles and run binding;
  - worker definitions that compute the tool set and context;
  - Teams, with shared context and enforced policies;
  - adapters (Figma, browser) with their own enforcement;
  - an observable activity log;
  - Git versions and explicit push;
  - attachments and `@` mentions, as references rather than contents.
- Claude Code alone is a general agent with a person's full rights. This product turns it into **bounded, specialised, accountable workers**.

### Why Workers, Teams and Workspaces exist
- **Workspace:** *where* work happens, and the **security boundary** (folder plus mode).
- **Worker:** *who* does it, a specialist: what it is, what tools it may use, how it works, what it must never do, and what it needs.
- **Team:** the *operational context* several workers share: knowledge, resources, conventions, enforced policies and prompts. It exists so this isn't copied into every worker.
- **How they combine:** a run is **one worker**, in **one workspace**, optionally as a member of **one Team**.
  - Effective access = worker capabilities ∩ workspace mode ∩ Team scope ∩ platform security.

### Evolution, in short (VERIFIED from git history and docs; earliest stage CONVERSATION-ONLY)
1. **Original idea** (CONVERSATION-ONLY): an "AI worker / bot" that does real work rather than chat (the owner described it as Grok-like).
2. **Figma Executor POC** (2026-09-29, tag `executor-poc-v0.1`): the AI drives a live Figma file with no copy-paste.
   - Before this repo, the same loop built a 16-screen "AI Visa Agent" app design, and reproduced the "Umrah & Hajj Guide" design spec with exact fidelity (`docs/baseline.md`).
3. **MCP adapter, then a second environment (browser), then benchmarks B1–B6:** worker loops across Figma, browser and files, with failure and recovery.
4. **Worker Console:** a local chat front-end that observes the headless worker.
5. **Security hardening** (adversarial tests).
6. **AI Workspace UI** (from a Stitch design): workspaces, attachments, versions and push.
7. **Worker definitions and memory; Figma Reader.**
8. **Senior UI/UX Design Engineer worker; "No folder"; `@` mentions.**
9. **Teams** (`e44501c`).
10. **Workspace UI redesign** (2026-10-19). This was presentation only: `worker-ui/workspace.html`. No API or server change.
    - **Design system:** one token set, plus borders, spacing and a sans-first type scale. Mono is kept for code, paths and hashes.
    - **Sidebar:** a **New task** action (Alt+N), then foldable groups: Workforce (workers, teams), Work (runs, prompts), Project (workspaces, versions, files) and Connections (GitHub). Folding is remembered per browser.
    - **Run header:** who is working (worker, Team), where, and the run's state.
    - **New task screen:** the worker's mission, what it can use (from its definition) and saved prompts to start from.
    - **Each turn:** a "Worked Ns · N actions" line, counted from the run's real events, and the files the worker produced as deliverables after its reply.
    - **Activity panel:**
      - the run's deliverables pinned at the top;
      - typed steps: tool calls as compact rows, the worker's PLAN…DONE notes accented, alerts tinted;
      - Context & usage pinned at the bottom.
    - **Composer:** hidden on the worker, Team and GitHub definition pages.
    - **Unchanged:** every element id and the card titles the bench suites use.
11. **UX remediation** (2026-10-19, `docs/ux-remediation.md`): the 29 audit findings, fixed.
    - **Server:** a per-turn outcome (replied / done / needs / error) while a run waits; deliverables (ARTIFACT:) kept apart from files written; busy-worker refusals name the run.
    - **Page:** guarded drafts and consequential actions, a separate Stop, explicit run replacement, view-only teams, one state vocabulary and one counting rule.
    - **Tests:** `bash bench/workspace-ui/run-suite.sh remediation`.

Details in §11.

---

## 2. Long-term vision

```
Organization
  → Teams (operational context: knowledge, resources, rules, prompts)
    → Specialized Workers (Frontend, QA, Figma/Design, Research, Visa, …)
      → Workspace / Resources / Knowledge / Rules
        → Real tools (files, Git, Figma, browser, web, …)
          → Real work → Result (reviewed, versioned, accountable)
```

| Item | Status |
|---|---|
| Teams → Workers → Workspace → tools → result, locally, for one person | **CURRENTLY BUILT** (VERIFIED) |
| Frontend Engineer, QA Engineer, Research Worker, Senior UI/UX Design Engineer as definitions | **BUILT**: `workers/*.json`, created through the API or UI |
| Figma/Design worker editing a live Figma file | **BUILT and proven** (plugin path); reading by link needs a Figma token (not yet provided) |
| Visa Worker (an AI that operates a visa website for a person) | **FUTURE VISION.** Only design artefacts exist (`exports/visa-agent-journey-plan.md`, `scripts/visa-*.mjs`, the earlier 16-screen design). No visa-operating worker exists. |
| Organization level (several users, roles) | **FUTURE.** There's no user or account model; it's single local user. |
| External channels (WhatsApp, …): a stakeholder hands a worker a task and gets the result | **FUTURE.** The `NEEDS:` event is the intended hook for asking a stakeholder (`docs/worker-platform.md` §5, §9) |
| Multi-worker orchestration / Team leader / delegation | **FUTURE.** Not built, deliberately |
| Hosted SaaS, model-provider choice, billing | **FUTURE / commercial** (§19–20) |

---

## 3. Core concepts

### 3.1 Workspace (VERIFIED: `worker-ui/server.mjs` "workspaces")
**What it is:** a registered folder plus a **profile**.

| Profile | Mode | What the worker gets |
|---|---|---|
| `inspect` | **Inspect**: look, don't touch | `--restricted --tools Read,Glob,Grep,ToolSearch`, an allow-list of 12 read-only Figma tools and 2 browser tools, `--permission-prompts none`. Repo settings, hooks and `CLAUDE.md` aren't loaded. |
| `full` | **Work** | Read, Write, Edit, Glob, Grep, `Bash(node:*)`, `Bash(curl:*)`, WebFetch, WebSearch, the whole Figma Executor, and the full browser. `--setting-sources project,local`, so the repo's own `.claude` settings and hooks **do** run. Full trust. |

**Kinds of workspace:**
- **Registry:** `workspaces.json` in the console's data dir (gitignored). Workspaces are added in the UI with a path, Browse (the Windows folder picker) or the API.
- **Rules for a new workspace:** the path must be absolute and exist. Drive roots, the home folder, UNC paths and duplicates are refused.
- **Scratch** (`id: scratch`, called "No folder" until 2026-10-20): built in, Work profile, for work with no project folder (a Figma design job, Builder content, a web page, research). See `docs/ux-remediation.md` §3.
  - Each conversation gets its own empty folder, `<data>/scratch-runs/<run id>`. A fresh-session continuation keeps its parent's folder.
  - The worker is told it has no project files and no Git.
  - Files, `@` mentions and the viewer reach a scratch folder only through its conversation (`?run=`). `?workspace=scratch` lists nothing.
  - A team in Scratch can only use uploaded documents.
  - Runs from before 2026-10-20 keep the old shared `<data>/scratch`.
- **"Executor"** (`id: console`): this repo itself. It can be hidden.

**Binding:**
- Every run records the workspace's **real root** (junctions resolved), its profile and its Claude config dir.
- Before every resume, restart and file view, the console checks the binding still holds: same real root, same profile, the session lives in this config dir, and every cwd in the session transcript is that root.
- It refuses on any mismatch.
- Workers are spawned with `cwd` = the bound root, and the console checks the `init.cwd` the worker reports.

**What a workspace brings into the UI:**
- **Files:** the Files tree (`/tree`) and a read-only viewer (`/file`), both under realpath containment. Files are served with `CSP: sandbox` and `nosniff`, so HTML/SVG can't run as the console.
- **Git:** see §6.4.
- **Browser / Figma:** through adapters (§6), with the profile deciding which tools are loaded.
- **Artifacts:** files the worker wrote successfully inside the workspace. They're registered on a successful tool result, and shown as Activity cards and links.
- **Versions:** the workspace's own Git history plus the working copy. Commit and push are explicit actions the person takes (Work only).
- **Runs:** one run is one conversation with one worker process (follow-ups go to the same process; resume starts a new process with `--resume`). One active run at a time.
- **Attachments:** images, PDFs and text in the message itself.
  - The type is checked from the bytes; at most 10 files and 25 MB in total.
  - A copy is kept in `runs/<id>.att/`.
  - **They're never written into the workspace.**
- **`@` mentions:** see §6.3.

### 3.2 Worker (VERIFIED: `server.mjs` "workers", `docs/worker-platform.md`)
**Definition** (`workers.json`, gitignored; reusable definitions are in `workers/*.json` in the repo):

```js
{ id, name, mission, specialization,
  capabilities: [...],          // ids from the fixed CAPABILITIES catalogue → real tools
  workflow: [...], knowledge, limitations: [...] /* hard limits */,
  requirements: [{ resource, access, need: "required"|"optional" }],
  onMissing, version, createdAt, updatedAt }
```

**Capabilities.** A capability turns tools on; it grants no access.

| Capability | Tools | Profiles |
|---|---|---|
| `files.read` | Read, Glob, Grep | both |
| `files.write` | Write, Edit | Work |
| `shell` | `Bash(node:*)`, `Bash(curl:*)` | Work |
| `web` | WebFetch, WebSearch | Work |
| `browser` | browser-executor (in Inspect: navigate and read DOM only) | both |
| `figma.read` | figma-reader MCP (REST, by link) | both |
| `figma.plugin.read` | figma-executor read tools | both |
| `figma.plugin.edit` | figma-executor, every tool | Work |

**What a definition decides at runtime:**
- **Tools:** effective tools = the worker's capabilities ∩ what the profile allows (`workerRuntime()` builds `--tools`, `--allowedTools`, MCP servers and `--add-dir` for the adapters' exports folders).
- **Requirements:**
  - The resource registry is fixed in code: `figma read` (a credential exists and `/v1/me` accepts it), `figma edit` (the plugin answers PING through the bridge), `workspace read/write`, `browser use`, and `github read` (`git ls-remote` on `origin` works).
  - They're checked at run start, shown on a card, and written into the context.
  - **A requirement is not authorization.** When access is missing, the worker must write `NEEDS: <resource> <access>: <what the person must do>`, which becomes a "Needs access" event.
- **Memory:** `REMEMBER: …` lines go to `workers/<id>.memory.json`. Secret-looking lines are refused. Memory is given to later runs as a labelled section, and the person can delete it. It's kept separate from the definition, which a worker can never edit.
- **Versioning:** each save bumps `version`. Each run snapshots its definition, runtime, requirement statuses, memory and the full context (`runs/<id>.worker.json`, `runs/<id>.worker.md`). Old runs keep their version, also when resumed. Deleting a worker leaves its runs readable and resumable.
- **The General worker** (no definition) runs on the plain profile flags. The exception is a run under an enforced policy, which gets an equivalent definition minus the policy's tools (§7).

### 3.3 Team (VERIFIED: `server.mjs` "teams", `docs/team-platform.md`)
> **A Worker is a specialist. A Team is the operational environment and shared context.**
> A Team run **is** the member worker's normal run. There is **no second runtime**.

**A Team owns:**
- identity: name and description;
- **members**: worker ids. Each keeps its own definition and memory;
- **workspace**: the one place the Team's runs happen. A Team run asking for another workspace is refused;
- **Figma resource**: link, file key, name. It locks the Figma tools to that file;
- **knowledge**:
  - `workspace_file` **references**: read fresh by the worker, validated like `@` mentions, and only from the Team's own workspace;
  - **uploads**: checked like attachments, content-addressed, and copied per run;
- **instructions**: conventions given to the worker, labelled **INSTRUCTION**, not enforced;
- **enforced policies**: only kinds the platform enforces. Today that's `protect_branch`, "Never modify `<branch>`", labelled **ENFORCED**;
- **requirements**: the worker requirement model, marked "(Team)";
- **prompts**: Team prompts, separate from the global Favourites;
- **versions**: every save writes `teams/<id>/history/vN.json`.

**Runtime composition** (§8.3): platform instructions → Workspace (its enforced policies) → Team → Worker → the person's message.

**Narrowing only:** a Team can take tools away (policy) or lock a resource (Figma file). It can **never** add access the workspace or platform doesn't give.

---

## 4. Current architecture

```
Browser (worker-ui/workspace.html, vanilla JS, one file, ~1600 lines)
   │  same-origin fetch + SSE (/events)            [UI]
   ▼
Worker Console  worker-ui/server.mjs  (Node http, 127.0.0.1:8799, ~1480 lines)   [PLATFORM]
   │  workspaces · workers · teams · runs · git · files · mentions · attachments · prompts
   │  computes per run: cwd, --tools/--allowedTools/--settings(deny)/--restricted/--add-dir,
   │  MCP config (per run), context file (--append-system-prompt-file)
   │  spawns  claude.exe -p --input-format stream-json --output-format stream-json …
   ▼
Claude Code runtime (claude.exe 2.1.283, CLAUDE_CONFIG_DIR=~/.claude)  → Anthropic (subscription)
   │  built-in tools (Read/Write/…)   +   MCP servers (stdio):
   ├── mcp/server.mjs        figma-executor ─HTTP─► bridge/server.js (:8787 loopback) ─WS─► plugin/ui.html ─postMessage─► plugin/code.js ─► Figma
   ├── mcp/reader-server.mjs figma-reader   ─HTTPS─► api.figma.com (REST, person's token)
   └── browser-adapter/server.mjs browser-executor ─► Playwright Chromium
   ▼
Workspace folder (cwd)  ·  Figma file  ·  web pages
```

**Platform vs UI:**
- Everything that decides access, context or execution is in `server.mjs` and the adapters.
- `workspace.html` is a client of a JSON and SSE API. Every request that changes state is same-origin guarded.
- The old Worker Console page (`worker-ui/index.html`) is still served at `/console`.

**Storage.** The data dir is `worker-ui/` by default, or `WORKER_CONSOLE_DATA`.

| Path | What | In git? |
|---|---|---|
| `workspaces.json` | workspace registry, in display order | ignored |
| `workers.json`, `workers/<id>.memory.json` | worker definitions, memory | ignored |
| `teams.json`, `teams/<id>/history/vN.json`, `teams/<id>/knowledge/<sha16>-<name>` | Teams, versions, uploads | ignored |
| `prompts.json` | global Favourites | **tracked** (it holds the owner's prompts) |
| `runs/<id>.meta.json`, `.jsonl` (events), `.raw.jsonl` (raw stream) | run history | **NOT ignored**; three 2026-09-30 proof runs are tracked. See §15 |
| `runs/<id>.att/`, `.worker.json`, `.worker.md`, `.mcp.json`, `.team/` | attachments, snapshots, per-run MCP config, Team upload copies | ignored |
| `scratch/` | the old shared Scratch folder (runs from before 2026-10-20) | ignored |
| `scratch-runs/` | one folder per Scratch conversation | ignored |
| `mcp.full.json`, `mcp.inspect.json` | generated MCP configs | ignored |
| `~/.figma-reader/credentials.json` (or `FIGMA_READER_DIR`) | Figma Reader credential | outside the repo |
| `~/.claude/projects/...` | Claude Code session transcripts | outside the repo |

**Events** (SSE, and `runs/<id>.jsonl`):
- `{ts, type, env?, tool?, summary, detail?}`.
- Types: `user`, `reply`, `status`, `start`, `tool`, `result`, `failure`, `artifact`, `completed`, `team`, `worker`, `requirements`, `policy`, `needs`, `memory`, `commit`, `push`, `note`, and tagged findings (`plan`, `observation`, `decision`, `verification`, `recovery`, `done`).
- Tagged lines come from the reporting convention in `worker-ui/worker-instructions.md` (`PLAN:` … `DONE:`, `NEEDS:`, `REMEMBER:`, `ARTIFACT:`).

**HTTP API** (VERIFIED route list):
- `/workspaces` (GET, POST, `/order`, DELETE), `/pick-folder`
- `/workers` (GET, POST, PUT, DELETE, `/memory`)
- `/teams` (GET, POST, PUT, DELETE, `/knowledge/:kid`, `/versions`)
- `/runs` (GET, POST, `/:id` GET, `/:id/message|stop|end|restart` POST, `/:id/att/:file`), `/events`
- `/git`, `/git/version`, `/git/diff`, `/git/file`, `/git/commit`, `/git/push`
- `/mentions`, `/tree`, `/file`, `/prompts`

---

## 5. The Claude runtime

**Current (VERIFIED).** The product does **not** call the Anthropic API for its local runtime. It starts the installed **Claude Code CLI** (`claude.exe` 2.1.283; path found from `PATH` → `node_modules/@anthropic-ai/claude-code/bin/claude.exe`, or `CLAUDE_BIN`), headless:

```
Browser UI → localhost:8799 (server.mjs) → claude.exe -p (stream-json in/out) → Anthropic Claude service
                                           (the owner's Claude Code subscription; config dir ~/.claude)
```

**How the console starts and talks to it:**
- **Messages:** user messages are written to stdin as stream-json lines, and output lines become events.
- **Flags:** `--mcp-config <per-run file> --strict-mcp-config`, `--append-system-prompt-file <context>`, the profile or worker args, and `--resume <session>` for resumes.
- **Settings for every worker:** `--settings {"includeCoAuthoredBy":false,"attribution":{"commit":"","pr":""}}`. Tested: the default adds a Claude co-author trailer; these settings remove it.
- **Environment:** the console drops the `CLAUDE*`, `AI_AGENT*`, `WORKER_CONSOLE_*` and `FIGMA_*` variables it inherited (except `FIGMA_READER_DIR`), then sets `CLAUDE_CONFIG_DIR` = `~/.claude` (or `WORKER_CONSOLE_CLAUDE_CONFIG_DIR`). This keeps sessions out of other tools' config dirs.
- **Model and effort:** whatever Claude Code defaults to in `~/.claude`. User settings are skipped. Observed: `claude-opus-5-5`, default effort. **OPEN:** set them explicitly if a specific model is wanted.

**Runtime behaviours the platform depends on** (VERIFIED by probes, 2026-10-06):
- `--restricted` keeps Write and Edit when they're listed in `--tools`, removes shell and code tools, and doesn't load project settings, hooks or `CLAUDE.md`.
- `permissions.deny` rules passed with `--settings` (`Edit(.git/**)`, and absolute `Edit(//c/…/**)`) are enforced: "File is in a directory that is denied by your permission settings".
- Claude Code **expands `@path` in message text into file contents**. In Work it also did that for paths **outside** the workspace. The console defuses this by wrapping readable `@tokens` in backticks (§6.3).
- `CLAUDE_CODE_DISABLE_ATTACHMENTS` exists but is internal and broad: it also disables deferred tools and AGENTS.md. Deliberately **not** used.

**Future / commercial** (CONVERSATION-ONLY, **NOT BUILT**):
```
Customer → our SaaS → AI orchestration (Workers/Teams) → Claude API / other model APIs (OpenAI, Gemini, …)
```
The Worker is meant to be the product abstraction, independent of the model. Today the runtime **is** Claude Code, and its permission system, MCP client, session resume and `--restricted` are load-bearing for security. Moving to raw model APIs would mean re-implementing those controls. Don't do that during the launch window.

---

## 6. Tools and adapters

### 6.1 Figma
**Executor architecture** (VERIFIED; the original POC, still in use):
```
Claude Code ──MCP stdio──► mcp/server.mjs (thin: tool → {type, params}, no Figma logic)
           (earlier: curl / HTTP POST directly)
                      ──HTTP POST /command──► bridge/server.js  (127.0.0.1 + ::1 :8787 only, WS relay,
                                                                  writes base64 exports to exports/)
                      ──WebSocket /ws──► plugin/ui.html (iframe: network, no document)
                      ──postMessage──► plugin/code.js (sandbox: Figma Plugin API, no network)
```
- **Plugin commands** (`plugin/code.js` handlers, VERIFIED):
  - PING, GET_FILE_INFO, LIST_PAGES, SWITCH_PAGE, CREATE_PAGE, RENAME_PAGE;
  - GET_SELECTION, SEARCH_NODES, GET_DOCUMENT_STATE, GET_VARIABLES, GET_STYLES, GET_ICON_COMPONENTS, GET_COMPONENT_TREE, GET_SCREEN_TREE, GET_PROTOTYPE;
  - CREATE_FRAME, CREATE_COMPONENT, CREATE_TEXT, CREATE_VECTOR, CREATE_ELLIPSE, CREATE_INSTANCE, COMBINE_AS_VARIANTS, SET_AUTO_LAYOUT, MODIFY_NODE, DETACH_INSTANCE, SET_INSTANCE_PROPERTIES, DELETE_NODE;
  - BIND_VARIABLE_TO_FILL, IMPORT_COMPONENT_BY_KEY, EXPORT_NODE (PNG/JPG/SVG/PDF).
- **MCP tools:** 30 `figma_*` tools mirror these.
- **Uncommitted:** the working tree also has `MODIFY_NODE` `fills` and `copyFillsFrom` (§16).
- **Proven** (`docs/baseline.md`, `docs/capabilities-log.md`, `docs/benchmarks.md`):
  - create, modify and inspect real nodes; auto layout; variants; variable binding; library import; instance detach;
  - export → read back → compare → correct;
  - a 16-screen design build; exact extraction of a reference design spec;
  - B1/B2 checklists with failure and recovery;
  - B3 and B6 implementation packages verified in a browser;
  - the Senior UI/UX worker redesigning the owner's "trekking hiking" file (2026-10-05, read and edited by the worker).
- **Set up once per Figma session:**
  - start the bridge (`cd bridge && npm start`);
  - in the Figma **desktop** app, use Plugins → Development → Import plugin from `plugin/manifest.json`, then Run "AI Executor (POC)".
  - Figma requires a human to launch the plugin; there's no API for it.
- **Access model:** the plugin acts in whatever file is open, with the person's Figma session. There's no separate authentication. The "figma edit" requirement = PING answered.
- **File lock (Team runs):** with `FIGMA_EXPECTED_FILE_KEY` set, every command except PING and GET_FILE_INFO first asks the plugin for `figma.fileKey`, and is refused if the open file isn't the Team's.
  - VERIFIED: this dev plugin (`enablePrivatePluginApi`) does report `fileKey`.
- **Inspect:** only the 12 read tools are allowed. The adapter has no read-only mode of its own; "Inspect" relies on the allow-list.
- **Known limitations** (`docs/how-to-drive.md`, `docs/benchmarks.md`):
  - a human must launch the plugin;
  - Figma sometimes kills the plugin iframe, and the bridge then reports "No Figma plugin connected";
  - a page sometimes won't load until a human clicks the page tab (B3/B6);
  - `dynamic-page` needs the async APIs;
  - vector paths support only M/L/C/Z;
  - `resize` doesn't keep the ratio;
  - instances can't take children.

**Figma Reader** (VERIFIED: `figma-reader/`, `mcp/reader-server.mjs`):
- **What it does:** reads a design **by URL** through Figma's REST API: an outline plus a render. It needs no plugin.
- **Tools:** `figma_read_design`, `figma_access_status`.
- **Credentials:** a PAT or OAuth in `~/.figma-reader/credentials.json`. The credential is never passed to workers as an environment variable.
- **A link grants nothing.** 401/403/404 are explained, and the worker must write `NEEDS:`.
- **Team runs:** `FIGMA_READER_ALLOWED_KEYS` refuses other files.
- **STATUS:** the authorized path was **never proven** with a real token. The owner hasn't created `~/.figma-reader/credentials.json` yet. Tier-1 rate limits are very low on Starter and View seats.

**The official Figma MCP** (CONVERSATION-ONLY findings, 2026-10-02):
- the remote `mcp.figma.com` needs OAuth; the owner's earlier authorization had expired;
- the desktop server `127.0.0.1:3845` refused: it needs a paid Dev Mode seat.

It isn't used.

### 6.2 Browser (VERIFIED: `browser-adapter/server.mjs`)
- **Implementation:** an MCP server over Playwright Chromium.
- **Tools:** `browser_navigate`, `browser_get_dom_state` (DOM and accessibility state), `browser_click`, `browser_fill`, `browser_screenshot` (Work only).
- **Profiles** (`BROWSER_EXECUTOR_PROFILE`):
  - `full`: any URL, including `file://` for local renders, plus screenshots;
  - **anything else**, unset included, is `inspect`: URLs are parsed with WHATWG URL and only http(s) is accepted. A page that leaves http(s) is reset to `about:blank`. Downloads are off, and there's no screenshot tool.
  - D1–D3 tests: 32 URL tricks.
- **Proven:** benchmark B4 (a SauceDemo order), B5 (failure and recovery), the B6 render and geometry checks, and the console proof (an expense-portal report).
- **Limit:** in Inspect, `browser_navigate` can still reach any http(s) host with any query string. That's an outbound channel (§15).

### 6.3 Files, attachments, `@` mentions (VERIFIED)
- **File access:** worker file tools are confined by Claude Code to the cwd plus `--add-dir` (the adapters' exports folders; a Team run's knowledge copy).
- **Console file endpoints:** realpath containment (`fileInside`/`dirInside`). Absolute, drive, UNC and device paths are refused before the disk is touched.
- **Attachments:** §3.1.
- **`@` mentions:**
  - **Search:** typing `@` searches the selected workspace's index (`/mentions`): Git's tracked and untracked files, then the files `.gitignore` hides, minus dependency and build folders (`node_modules`, `dist`, `build`, `out`, `.next`, `.vercel`, …). Outside a repo, it walks the folder. Link-outs are excluded, the index is cached for 15 s and capped at 20,000 files.
  - **What's sent:** a pick is sent as `mentions: [{type:"file", path}]`, re-checked on the server against the run's workspace, and appended as a `<file_references>` block. **The worker reads the file itself.**
  - **Workspace switch:** a mention picked in another workspace is refused at send time.
  - **Defusing:** every readable `@token` in text sent to the worker (attached text included) is wrapped in backticks, so Claude Code doesn't inline it. That covers a path that exists from the workspace, and any absolute, drive, UNC, `~` or `..` path.

### 6.4 Git (VERIFIED: `server.mjs` "versions")
- **Reading:** `/git` gives the branch, remote, ahead count, changes, the last 30 commits, the runs linked to commits, and the protection state. Diffs, versions and file-at-version are read-only.
- **Safe execution:**
  - git runs with `core.fsmonitor=false`, `--no-ext-diff`, `--no-textconv` and no prompts;
  - revisions must be hex;
  - paths are relative, with no `..`;
  - inherited `GIT_DIR`-style variables are dropped.
- **Commit** (Work only):
  - stages and commits only the workspace's folder (`git add -A -- <spec>`);
  - uses the person's message as typed and the person's Git identity, and adds **no trailer**;
  - links the runs whose changes went in.
- **Push** (Work only):
  - explicit refspec `HEAD:refs/heads/<upstream target>`, never `--force`, never `-u`;
  - existing credentials, never prompts;
  - remote URLs are shown without credentials.
- **Protected branches** (a Team policy): the console refuses a commit while the branch is checked out, and a push when the branch or its upstream target is protected. The Versions view shows why.
- **Workers** are told not to commit or push (`worker-instructions.md`). Under a branch policy they *can't* (no shell, `.git` writes denied).
- **GitHub (2026-10-17, `docs/github.md`):**
  - one platform-wide GitHub connection (a token kept outside the repo, used by the console only);
  - a registry of repositories, each assignable to one workspace whose checkout's origin it must match;
  - per-worker access levels (read / write / commit / push), enforced through `mcp/repo-server.mjs` and the runtime. In an assigned workspace, workers do Git only through those tools: no shell by default, and no commits or pushes to the default or protected branches.
- **Second developer (2026-10-17, `docs/second-developer.md`):**
  - each developer runs their own copy (their own Claude login, bridge, plugin and Git/GitHub sign-in), and nothing is exposed to the network;
  - the browser tool and WebFetch can't reach the console, the bridge or devctl, and the browser opens `file://` only inside the workspace;
  - the bridge refuses web pages and foreign Host names;
  - `worker-ui/doctor.mjs` checks a new machine.
- **Limitations:**
  - commit stages everything in the folder that isn't ignored;
  - repo hooks run on commit and push;
  - no branch switching, pull or merge from the UI.
  - **Pushing a MATW branch that has a pipeline** (`sabir-uat`, `uat-main`, `dev-main`, `preprod-main`) **triggers a deployment** (§10).

---

## 7. Security model

**Effective access = worker capabilities ∩ workspace mode ∩ Team scope ∩ platform security.**
- A Team can only take tools away or lock a resource.
- Capabilities only turn tools on; they don't authorise anything.
- Requirements check access; they don't grant it.

The evidence is in `bench/workspace-security/README.md` (adversarial tests with canary fixtures) and `bench/workspace-ui/README.md`.

| Area | What's enforced | By | Status |
|---|---|---|---|
| Console network | listens on 127.0.0.1 only; `Host` must be this console (blocks DNS rebinding) | server | VERIFIED |
| CSRF | state changes need the exact Origin, `Sec-Fetch-Site: same-origin`, `X-Worker-Console: 1` and a JSON content type; preflight is never approved; no CORS headers; run actions are POST-only | server | VERIFIED (12 cross-origin probes rejected) |
| Bridge | `:8787` on loopback only (`::1` and `127.0.0.1`) | bridge | VERIFIED |
| Run ↔ workspace binding | real root, profile and config dir checked before every resume, restart and file view; the reported `init.cwd` and Inspect tools are checked, and the worker is killed on mismatch | server | VERIFIED (E3–E5) |
| Path traversal / junctions | realpath containment on `/file`, `/tree`, mentions and Team knowledge; absolute, drive, UNC, `..`, junction-out and folder refused | server | VERIFIED (28 path forms; junctions) |
| Symlinks | the same realpath logic | server | **OPEN**: needs admin or Developer Mode, never demonstrated |
| Inspect | allow-list; `--restricted` (no shell, no repo hooks, settings or `CLAUDE.md`); no Write or Edit | Claude Code | VERIFIED (E1: 17 forbidden actions) |
| Browser `file://` | adapter-side URL scheme check in Inspect | adapter | VERIFIED (D1–D3) |
| Served files | `CSP: sandbox` + `nosniff` (a hostile `evil.html` couldn't start a run) | server | VERIFIED |
| `@path` inlining | readable `@tokens` defused before reaching the worker | server | VERIFIED (mentions test) |
| `.env` / secrets | **not enforced**: readable by Inspect and Work file tools, listed by Files and `@`. Path deny rules don't see hardlinks or copies | — | known limitation |
| `.git` / `.claude` | write-denied under a branch policy (deny rules); `--restricted` there | Claude Code | VERIFIED (Teams test step 7) |
| Shell | Work has `Bash(node:*)` and `Bash(curl:*)` = arbitrary code with the user's OS rights; removed under a branch policy | Claude Code (`--tools`) | VERIFIED |
| Repo settings / hooks | run in Work (full trust); not under Inspect or a branch policy | Claude Code (`--restricted`) | VERIFIED (hook ran 1× vs 0×) |
| Figma file lock | the Executor refuses while another file is open; the Reader refuses other keys (Team runs) | adapters | VERIFIED (fake bridge plus a real run) |
| Figma external state | edits change the live file; there's no undo or diff beyond Figma's own history. In Inspect only read tools are allowed. `EXPORT_NODE` writes to `exports/` | — | design fact |
| Missing credentials | requirement status, plus the tool refusal, plus the worker's `NEEDS:` | server and adapters | VERIFIED |
| Co-author trailers | worker settings; the console's commit adds none | Claude Code settings / server | VERIFIED |
| Integration tokens | `FIGMA_TOKEN` etc. never reach workers; `FIGMA_READER_DIR` is only a path | server | VERIFIED |

**Branch policy "Never modify X"** (§8.6) is enforced in four layers:
1. console Git;
2. no shell;
3. `.git`/`.claude` deny rules;
4. `--restricted`.

While X is checked out, runs also lose Write and Edit. The policy holds in **every workspace inside that repository**, Team and non-Team runs alike.

**Honest limitations** (more in §15):
- A Work workspace with shell anywhere on the machine can run `git` against **any** repo with the user's rights. Branch protection only covers runs inside the protected repo and the console's own Git. **No OS-level isolation exists.** The real backstop for prod is GitHub branch protection and the manual prod pipeline.
- If the branch is switched outside the console mid-run, that run keeps edit tools until it restarts. Commits are still refused.
- Protected repositories can't run commands, builds or tests.
- Credentials are per integration on this machine, not per Team or worker.
- Figma reading needs authentication; a link isn't access.
- Secrets in a Work (or even an Inspect) workspace are readable by the worker. Inspect has an outbound channel via `browser_navigate`; Work has WebSearch, WebFetch and curl.
- The model's judgement was observed refusing exfiltration, but that's **not** enforcement.

---

## 8. Team implementation (commit `e44501c`, committed locally, no co-author trailer, NOT pushed)

### 8.1 Data model (VERIFIED: `normalizeTeam()`)
```js
// teams.json
{ id, name, description,
  workers: [workerId],
  workspace: workspaceId | null,            // null/"scratch" = Scratch (no project)
  figma: { url, fileKey, branchKey?, name } | null,
  knowledge: [
    { id, type: "workspace_file", workspaceId, path, note },
    { id, type: "upload", name, kind, size, sha, file, note } ],
  policies: [{ type: "protect_branch", branch }],
  instructions: [text],                     // ≤30 × 500 chars
  requirements: [{ resource, access, need }],
  prompts: [{ id, title, text }],           // ≤50
  version, createdAt, updatedAt }
// teams/<id>/history/v<N>.json  every saved version
// teams/<id>/knowledge/<sha16>-<name>  uploads (≤20; attachment limits)
```

### 8.2 Validation
- Workers must exist.
- The workspace must resolve.
- The Figma link must be a figma.com file or design URL.
- Knowledge must be in the Team's workspace, as a file that exists, through the mention checks.
- Uploads go through the attachment checks.
- An unknown policy type is refused with "can't be enforced by this platform. Add it as an instruction instead."
- Branch names are validated. A protected branch needs the workspace to be a Git repo.

### 8.3 Runtime context order (VERIFIED: `workerContext()`; the Teams test checks the order)
```
worker-instructions.md (platform reporting rules)
## Workspace          (name, mode, branch; ENFORCED policies and what they turn off)
# Team: <name> (version N)  (description, members)
## Team instructions  (labelled: instructions, not enforced)
## Team knowledge     (workspace paths; upload paths in runs/<id>.team/ read-only)
## Team resources     (workspace; Figma file + lock explanation)
# You are: <worker>   (mission, specialization, tools, requirements incl. "(Team)", workflow, knowledge, hard limits, memory)
→ the person's message (+ @ references, attachments)
```

### 8.4 Run behaviour
- **Starting a run:** `POST /runs {prompt, team, worker}`.
  - The worker must be a member.
  - The workspace is forced to the Team's; naming another is refused.
  - Requirements = the worker's own plus the Team's (de-duplicated).
- **What's written:**
  - uploads are copied to `runs/<id>.team/`: readable via `--add-dir`, write-denied by an absolute deny rule;
  - the snapshot `runs/<id>.worker.json` = definition, **the whole Team at that version**, scope and statuses;
  - `meta.team = {id, name, version}`;
  - events `team`, `worker`, `requirements` and `policy`.
- **Resume:** continuing a run keeps its context file and snapshot (version pinning). Enforcement is recomputed at every spawn (`runScope()`): the policies now ∪ the ones the run started under. A resume never runs with less enforcement.
- **Deletion:**
  - deleting a Team removes its definition, versions and uploads, and is refused while one of its runs is active. Runs keep their snapshot and their own upload copies;
  - removing a worker from a Team (or deleting the worker) saves a new Team version; old runs are untouched.

### 8.5 UI (VERIFIED)
- **Sidebar "Teams":**
  - selecting a Team opens its page and makes it the context for new chats;
  - the composer shows "Team · worker" with ×;
  - choosing General, a non-member worker or another workspace leaves the Team.
- **Team page:**
  - a summary of the saved state (workers, resources, knowledge counts, policies, prompts, live requirement states);
  - the full editable form: workers with **Chat**; resources; knowledge (`WORKSPACE FILE` vs `UPLOADED`, with a workspace file search); rules (`ENFORCED` branch list vs `INSTRUCTION` text); requirements; Team prompts (Use); versions with the runs that used each one; delete with a confirm.
- **Sidebar "<Team> prompts":** only while that Team is active.
- **Versions view:** shows the protection instead of the commit or push control.

### 8.6 Security enforcement
§7. Code: `workerRuntime(def, profile, scope)`, `runScope()`, `wsPolicies()` (per repository, via `repoTop()`), `GENERAL` (the general worker under a policy), the guards in `gitCommit()`/`gitPush()`, the `translate()` init check, and `MCP_SERVERS` env (`FIGMA_EXPECTED_FILE_KEY`, `FIGMA_READER_ALLOWED_KEYS`).

---

## 9. Test status (VERIFIED from `bench/workspace-ui/*-results.json`, 2026-10-06)

| Suite | Result | What it covers |
|---|---|---|
| `teams-test.mjs` | **19/19** | §9.1 |
| `workflow-test.mjs` | 12/12 | add workspaces through the form, file explorer, hostile HTML, runs with live activity, follow-up, favourites, End, resume, Stop, Work artifact. The 2 "page errors" are its own deliberately refused requests |
| `manage-test.mjs` | 7/7 | order, drag, keyboard, remove/confirm, busy-workspace refusal, guard |
| `sync-test.mjs` | 6/6 | two tabs stay consistent; removing Executor; "No folder" |
| `attach-test.mjs` | 10/10 | picker, paste, drop, image/PDF/text read by the worker, read-only serving, server re-checks, nothing written |
| `versions-test.mjs` | 14/14 | working copy, diff, commit (no trailer), push to a local remote, refusals, Inspect, non-repo, guard, Claude's own trailer default vs off |
| `mentions-test.mjs` | 15/15 | picker, filter, keyboard/mouse, references not contents, deleted file, workspace switch, server re-checks, outside `@path` defused, performance |
| `workers-test.mjs` | 12/12 | define in UI, NEEDS, runtime tools, limits, memory, Work vs Inspect, versions, a rejected Figma credential, delete, guard |
| `designer-worker-test.mjs` | 4/4 | Senior UI/UX worker definition, access check (read-only), context, exports read |
| `browse-test.mjs` | 9/9 (2026-10-01) | Windows folder picker. Needs `dialog-driver.ps1` and real desktop dialogs; run manually |

- **Known flaky:** `sync-test` step 6 failed once in three runs. The 4-second workspace sync re-rendered the list while Playwright clicked a hover-only button ("element was detached"). Not caused by product code.
- **Bugs found by testing and fixed:**
  1. writes the runtime **refused** were listed as **artifacts** (now registered only on a successful tool result);
  2. the Versions view hid the **commit** box when only the **push target** was protected (now only the push is refused).
- **Other bugs found by testing earlier:**
  - the `@` picker's Enter both picked and sent;
  - `dir/` matched only from the root;
  - mentions were sent in pick order;
  - runtime `@path` inlining (§5);
  - `.gitignore`d docs couldn't be mentioned.

### 9.1 What the Teams test proves (real worker, real browser, a copy of the real MATW repo)
1. **Lifecycle:** the Team is created in the UI with 3 workers, the workspace, a Figma link, 3 real docs as references, 2 uploads, the prod-main policy, 3 instructions, 2 requirements and 2 prompts. It persists across reload; edit and version (v1 → v3) work; delete works.
2. **ENFORCED vs INSTRUCTION in the UI:** the API refuses `follow_ddfoa` as an enforced policy.
3. **Prompts:** Team prompts are scoped; global Favourites are unaffected; another Team sees only its own prompts.
4. **A real Frontend Engineer run:**
   - the request carries `team` and `worker` and no workspace;
   - the context order is correct;
   - the worker reported "prod-main… the platform enforces this", the instructions, the uploaded document's codeword, and "UMDA Protocol" from the real `docs/universal/ARCHITECTURE.md`, which it **read itself**;
   - no Bash; Team and Enforced policy cards shown.
5. **Escape attempt:**
   - the worker found no shell tool ("No matching deferred tools found");
   - Writes to `.git/refs/heads/prod-main` and `.claude/settings.local.json` were refused by the runtime;
   - prod-main was unchanged, and nothing was listed as an artifact.
6. **Git refusals:** a commit on prod-main and a push via an upstream to prod-main were refused; the bare remote stayed empty; the Versions view says why. On a full repo with prod-main checked out: no commit box, no push.
7. **prod-main checked out:** the run's tools are Glob, Grep, Read and ToolSearch only.
8. **Repository-wide:** a General worker in that repo has no Bash; a sub-folder workspace is covered.
9. **Version pinning:** v4 adds an instruction; a new run sees 4 instructions; continuing the v3 run sees 3, with a byte-identical context.
10. **Figma:** the Reader refuses another file; the Team's file without a token led to `NEEDS:`; with a fake bridge, a mismatched file is refused before Figma is touched, the matching file is allowed, and runs outside a Team are unchanged.
11. **Inspect Team:** stays Inspect; `../`, absolute, `C:x`, UNC, junction-out, folder and other-workspace knowledge refused; a run in another workspace or with a non-member refused.
12. **Leaving and membership:** switching workspace leaves the Team; removing QA refuses new QA runs, and the old run stays v3.
13. **Delete:** the Team is gone, and its run still opens with its Team card and snapshot.
14. **GitHub requirement on the real MATW repo (Inspect):** "Reachable" via `git ls-remote`.
15. **Origin guard:** 403 on create, change and delete.

**How to run:** `bash bench/workspace-ui/run-suite.sh <suite>` (§22).

---

## 10. MATW: the primary proof environment

**Why MATW** (INFERRED and CONVERSATION-ONLY): it's the owner's real production frontend, with real conventions, real protected branches, a real Figma workflow and real deployment pipelines. Proving workers there shows the product works on real work, not a demo.

**Facts** (VERIFIED from `C:\Users\hp\Desktop\MATW\matw-revamp-main-frontend-site`, read-only):
- **Repo:** `MATWProject-org/matw-revamp-main-frontend-site` on GitHub; package name `matw-checkout`. The owner's working branch is `sabir-uat`.
- **Stack:** React 18 with Create React App (`react-scripts` 5), Tailwind, Redux Toolkit, TanStack Query, Builder.io (`@builder.io/react`), Adyen, Stripe and PayPal, Datadog RUM. Cloudflare Wrangler deploys.
- **Pipelines** (`.github/workflows`):
  - **prod is manual** (`workflow_dispatch`, checks out `prod-main`);
  - preprod deploys on push to `preprod-main`, uat on `uat-main`, dev on `dev-main`;
  - several personal pipelines, including `sabir-uat`.
- **`prod-main`** exists locally and on origin. It's the production branch.
- **Docs:** `docs/` is **gitignored** in MATW (`.gitignore` line 35, `/docs`), but present locally. That's why `@` mentions list ignored files (`14f5bb2`).
- **Architecture docs:**
  - `docs/ddfoa.md`: "The MATW DDFOA Protocol". Domain-Driven Feature-Oriented Architecture. **"Dumb Features, Smart Domains"**:
    - `src/domains/` is the source of truth (data orchestration, business logic, PSP integrations);
    - `src/features/` is dumb: it views data and signals intents (views, components, hooks for local UI only, constants);
    - all cart and storage goes through `@hooks/cart/useCart.jsx`;
    - API in `@api/services` and `@api/queries`;
    - payments in `@domains/payments`;
    - "API logic inside a /view … is a critical architectural violation";
    - Tailwind only, flex and gap, no margins between siblings;
    - Figma CSS is normalised, never copied.
  - `docs/platform-contract.md`: "Widget & Cart Protocol". **The One Cart Rule**: every basket write goes through `useCart()`; `basketStates` is the single source of truth; currency from Redux; analytics and checkout metadata must never be bypassed; widgets consume the platform and don't own cart state.
  - `docs/universal/ARCHITECTURE.md`: 5–6 contracts (UMDA, state management, shadcn UI, layout/styling, monorepo/Turborepo + Wrangler, forms). It lists 6 while saying 5.
- **BFF pattern** and **"Domains cannot depend on UI":** **not found** in MATW's docs. They were instructions the owner gave (CONVERSATION-ONLY) and are used as Team instructions in tests. Treat them as conventions to confirm with the owner.
  - "UI cannot contain business logic" matches DDFOA's "dumb features".
- **Figma for MATW:** **no MATW Figma URL** was found in the repo. The Teams test used a placeholder key. **OPEN:** the owner must add the real link.

**Proof so far:**
- an Inspect workspace on the real repo (the owner's live console);
- the security tests read only `package.json`;
- the Teams test on a **local, shallow, sparse clone** with the real code, the real docs copied in, and `origin` pointed at a local bare repo. **The real repo has never been written by tests.**

---

## 11. History and milestones (dates VERIFIED from git and docs)

| # | Milestone | Problem | Built | Proven | Why it mattered |
|---|---|---|---|---|---|
| 1 | Original concept (CONVERSATION-ONLY) | chat AI doesn't *do* work | the idea of an AI worker | — | the north star |
| 2 | Figma Executor POC (`53e1096`, tag `executor-poc-v0.1`, 2026-09-29) | the AI couldn't touch Figma without copy-paste into Scripter | plugin (sandbox + iframe) + bridge + HTTP | create/modify/inspect/export loop; a 16-screen Visa Agent design; exact Umrah spec extraction (pre-repo work in `baseline.md`) | the first real environment |
| 3 | MCP adapter (`ab7e308`, Phases 1–3) | curl was clumsy; tools needed schemas | `mcp/server.mjs`, a thin tool → command layer | Phase 3 benchmark | the AI calls Figma as tools |
| 4 | Execution-layer boundary (`8d43688`) | what generalises beyond Figma? | `docs/execution-layer.md` | — | the adapter pattern for new environments |
| 5 | Browser adapter (`8ef5bdd`) | a second environment proves generality | Playwright MCP | B4 SauceDemo order, B5 recovery | multi-environment workers |
| 6 | Benchmarks B1–B6 (2026-09-29/30) | can the worker loop, fail and recover across environments? | benchmark deliverables + `worker/` checks (pixeldiff, package check) | B3/B6 packages verified in a browser; honest gaps recorded | the worker *verifies* its own work |
| 7 | Worker Console (`9149188`, `cfed406`) | the worker was invisible and terminal-only | local chat UI: follow-ups, resume, stop, prompts, history | the console proof (expense report) | observable work |
| 8 | Security (`9d44249`, `8386bba`, `9beb7d8`, `16c69ce`, `63f6810`) | LAN exposure, CSRF, cwd not bound, junction leaks, browser `file://` | local-only, same-origin guard, run binding, one config dir, realpath, browser profiles, Inspect allow-list, bridge on loopback | adversarial suites with canaries | trust before features |
| 9 | Workspace UI (`1547dfd` → `5c41f23`, 2026-10-01/02) | the product needed a real surface | Stitch-design UI: add/browse/remove/reorder workspaces, attachments, versions + commit/push | workflow, browse, manage, sync, attach, versions suites | a usable product |
| 10 | Cleanup (`1f8ad1b`) | UI without purpose | removed | — | "no fake controls" |
| 11 | Figma Reader (`785db26`) | "Figma URL → worker" without the plugin | REST reader + MCP + OAuth | the unauthorized path; the authorized path is **unproven** | a URL-based Figma resource |
| 12 | Worker definitions (`b666f98`) | every run was the same generic worker | capabilities → tools, requirements, NEEDS, memory, versions, snapshots | workers suite | specialised workers |
| 13 | Senior UI/UX Design Engineer (`3e9f064`) | first real specialised worker | its definition + exports access | designer suite; real redesign of "trekking hiking" (2026-10-05) | a specialist doing real design work |
| 14 | "No folder" (`151055c`) | a Figma job has no project folder | built-in scratch workspace | sync suite | "how can a Figma file be a workspace" (owner feedback) |
| 15 | `@` mentions (`813e1e0`, `14f5bb2`) | referencing files precisely | picker, references not contents, runtime `@` defusal, ignored files listed | mentions suite | precise and safe context |
| 16 | Teams (`e44501c`) | shared context copied into every worker; rules were only prompts | Teams with enforced policies, Figma lock, versions, snapshots | teams suite 19/19 on a MATW copy | the operational environment for an organisation |

---

## 12. Design philosophy (CONVERSATION-ONLY, consistently applied in the code)
- **"Build everything on pain. When we discover what is missing, build it."** Build from real pain, not from a beautiful UI with invented functionality.
- **No fake or placeholder features.** Every control does something real; no invented capabilities.
- **Prove capability through real execution:** inspect → test → prove → integrate. Tests use the real worker, a real browser and real environments (disposable copies where writes happen).
- **Security below the model wherever possible.** The model is never the security boundary. Model refusals observed in tests are recorded as *judgement*, not enforcement.
- **Don't call anything secure, sandboxed, isolated or read-only unless a test demonstrates that exact property.** No fake "enforced" rules.
- **Workspace is the fundamental resource and security boundary.** Workers specialise; Teams provide operational context.
- **Capabilities narrow access. Requirements aren't authorization. Missing access → `NEEDS:`**, never a workaround.
- **Historical runs stay reproducible** through snapshots.
- **Don't duplicate shared knowledge:** reference workspace files.
- **Don't build future infrastructure before current pain requires it.**
- **Report honestly:** what was proven, what wasn't, and what failed. Bugs found by testing are fixed and recorded, not assumed away.

## 13. UI / UX principles
- The UI should make obvious:
  - what exists and what the user can do;
  - which worker or Team is active, in which workspace and mode;
  - what resources are available, and what the AI is doing (live activity cards);
  - what happened (conversation, artifacts, versions), what failed, and what access is missing.
- Avoid decorative controls, meaningless filters, fake buttons, inactive icons, empty sections and UI made only to look good.
- **Visual language:** the Stitch design (Geist / Geist Mono, dark tokens measured from the Figma "Test Scripter" → Main → "Html → Body"). Keep it.
- **Labels must be truthful:** ENFORCED vs INSTRUCTION; WORKSPACE FILE vs UPLOADED; "read-only view"; "Inspect: read-only".

---

## 14. Current product state

### WORKING (VERIFIED in code and recent runs)
- Local console on 127.0.0.1:8799.
- Workspaces: add, browse, remove, reorder, Scratch (a folder per conversation), Executor; Inspect/Work.
- Runs: start, follow-up, stop, end, resume, restart, history.
- Live activity cards.
- Files tree and viewer.
- Attachments.
- `@` mentions.
- Git versions, diff, commit and push.
- Global Favourites.
- Worker definitions: editor, capabilities, requirements, NEEDS, memory, versions, snapshots.
- Teams (everything in §8).
- Figma Executor (plugin + bridge + MCP).
- Browser adapter.
- Figma Reader without authorization (it reports what's needed).

### PROVEN (covered by real tests or proof)
- Everything in §9.
- Benchmarks B1–B6.
- The security adversarial suites.
- The real redesign of the "trekking hiking" Figma file by the Senior UI/UX worker.

### PARTIALLY WORKING
- **Figma Reader:** the authorized path is unproven (no token), and rate limits are low on cheap seats.
- **Figma plugin:** needs a human to launch it; sometimes needs a page-tab click.
- **Branch policies:** they can't cover other workspaces' shells, and a protected repo can't run builds or tests.
- **Semantic events:** they rely on the worker following the tagging convention.
- **One run at a time:** there's no queue.
- **Windows-only** in practice: folder picker, `mklink` in tests, `claude.exe` paths. **INFERRED:** the server may run elsewhere, but it's untested.

### NOT BUILT
- user accounts, auth, organisations, roles;
- remote or hosted workspaces;
- a credential store or per-Team credentials;
- WhatsApp or other channels;
- multi-worker orchestration;
- billing and metering;
- a model-provider abstraction;
- OS or container isolation;
- a sandboxed command runner;
- pull, merge or branch switching in the UI;
- a host allow-list for the browser;
- a MATW Figma link in the Team;
- Next.js/React migration.

### FUTURE (after launch)
§20.

---

## 15. Known limitations (complete as known)
1. **Shell = the user's OS rights.** Any Work workspace with the `shell` capability (or the General worker in Work) can run arbitrary code, including `git` on any repo on the machine. There's no OS or container isolation.
2. **A branch policy covers only runs inside the protected repository and the console's Git.** The real backstop is server-side protection (GitHub) and MATW's manual prod pipeline.
3. **Mid-run branch switch** outside the console: the run keeps Write/Edit until it restarts. Commits are still refused.
4. **Protected repos can't run commands, builds or tests.** That needs a command runner that can't reach Git.
5. **Credentials** are per integration on this machine (`~/.figma-reader`, Git's credential manager), not per Team or worker.
6. **Secrets inside a workspace are readable** by the worker in Inspect and Work, listed by Files and `@`, and attachable. Hardlinks and copies defeat path rules.
7. **Outbound channels:** Inspect's `browser_navigate` can reach any http(s) host; Work has WebSearch, WebFetch and curl. Only model judgement stopped exfiltration in tests.
8. **The full (Work) profile is full trust:** the repo's own `.claude` settings and hooks run, and so do Git hooks on commit and push.
9. **Commit stages everything not ignored** in the workspace folder, including a new `.env` if the repo doesn't ignore it.
10. **Pushing MATW branches with pipelines deploys** (`sabir-uat`, `uat-main`, `dev-main`, `preprod-main`).
11. **Run logs (`worker-ui/runs/*.jsonl`, `*.raw.jsonl`, `*.meta.json`) are not gitignored.** They can contain anything the worker read. Three proof runs are tracked. Don't `git add -A` blindly.
12. **Figma:** human plugin launch; occasional iframe teardown; page-load failures needing a human click; Reader rate limits; Reader authorized path unproven; live-file edits have no platform-level undo.
13. **Symlink escapes** were never demonstrated blocked (only junctions).
14. **The file viewer has a TOCTOU window** (a link swapped between the check and the read) if something can write inside the workspace.
15. **One active run at a time**; single local user; no auth (local-only by design).
16. **Teams created elsewhere** (another tab, the API) appear after a page reload. Workspaces sync every 4 s; Teams don't.
17. **Large pasted instructions** go into every run's context. Uploads are read on demand.
18. **Flaky test:** `sync-test` (§9).
19. **Model and effort aren't set explicitly** (Claude Code defaults).
20. **Some test fixtures** (MATW clone, mention fixtures) are built under `%TEMP%`. The Teams suite reads the real MATW repo path (`MATW_SRC`), which must exist.

---

## 16. Git / code state (VERIFIED 2026-10-06)

**Repository:**
- **Folder:** `C:\Users\hp\Desktop\millionaire\auto-dev\figma-ai-executor` (the git root).
- **Remote:** `origin` = `https://github.com/Sabir59/auto-dev.git`.
- **Branch:** `main`.
- **HEAD:** the handoff commit on top of `e44501c` (see the final report). Before it, HEAD was `e44501c feat(teams): Teams as a first-class platform object`.

**GitHub `main` is at `b666f98`** (checked with `git ls-remote`). **Local is ahead by these commits, none pushed:**
- `3e9f064` Senior UI/UX Design Engineer worker
- `151055c` "No folder"
- `813e1e0` `@` file mentions
- `14f5bb2` `@` lists files `.gitignore` hides
- **`e44501c` Teams.** Committed locally, no co-author trailer, nothing pushed.
- the handoff commit

**History and refs:**
- **History rewrite:** git history was rewritten (2026-10-02) to remove Claude co-author trailers, then force-pushed with the owner's approval.
- **Backup refs:** `refs/backup/main-before-full-rewrite`, `refs/backup/main-before-trailer-rewrite`, `refs/backup/tags/*`.
- **Local tags:** `executor-poc-v0.1`, `figma-adapter-v0.2`, `v0.2.1`, `v0.2.2`. They're **not on the remote**.

**Uncommitted working-tree changes, deliberately left out of the commits:**
- `plugin/code.js` + `docs/capabilities-log.md`: `MODIFY_NODE` `fills` and `copyFillsFrom`, written **by the Senior UI/UX worker** during the 2026-10-05 "trekking hiking" redesign run and verified there per its log. **Not reviewed.** `mcp/server.mjs`'s `figma_modify_node` schema does **not** expose these fields (OPEN: whether to review, wire up and commit them).
- `worker-ui/prompts.json`: emptied by using the app (it held one 2026-09-30 benchmark prompt).
- Untracked run logs in `worker-ui/runs/`.

**Files of the Teams work (`e44501c`):**
- `worker-ui/server.mjs`, `worker-ui/workspace.html`
- `mcp/server.mjs`, `mcp/reader-server.mjs`
- `workers/{frontend-engineer,qa-engineer,research-worker}.json`
- `docs/team-platform.md`, `docs/worker-platform.md`
- `bench/workspace-ui/teams-test.mjs`, `teams-results.json`, `README.md`, `shots/teams-*.png`
- `.gitignore`

**Docs map:**
- `docs/PROJECT_HANDOFF.md` (this file) and `docs/PROJECT_MEMORY.json`
- `docs/team-platform.md`, `docs/worker-platform.md`
- `docs/baseline.md`, `docs/how-to-drive.md`, `docs/execution-layer.md`, `docs/next-environment.md`, `docs/benchmarks.md`, `docs/capabilities-log.md`
- `bench/workspace-security/README.md`, `bench/workspace-ui/README.md`
- `figma-reader/README.md`, `worker-ui/README.md`, `README.md`

---

## 17. Next 20 days: launch priority (HARD CONSTRAINT)
- **LAUNCH > architecture perfection.** The deadline is about 2026-10-26 (20 days from 2026-10-06; the exact date is OPEN, so confirm with the owner).
- **Don't, unless a real launch blocker requires it:**
  - migrate to Next.js, React or TypeScript; rewrite the frontend; rebuild the architecture;
  - add remote workspaces, WhatsApp, billing, enterprise accounts or multi-agent orchestration;
  - build a new credential system or add unnecessary abstractions.
- **Next.js + React + TypeScript** is the intended *post-launch* UI direction. The vanilla JS UI is not throwaway: it discovered and proved the platform architecture, and the platform lives in `server.mjs` and the adapters, not in the UI.
- **Suggested launch-critical work** (INFERRED; confirm with the owner before starting):
  1. **Run the §18 loop end to end in the owner's real console** with a real MATW Team. Add the real MATW Figma link; create a Figma Reader token if Figma-by-link is needed.
  2. **Decide on the uncommitted `MODIFY_NODE` fills change:** review, expose in MCP, commit or drop.
  3. **Protected-repo workflow:** decide whether launch needs builds or tests in MATW. If so, design the smallest safe command runner. Otherwise document "review and run tests yourself".
  4. **Guard pushes to deploy branches:** at least warn in the Versions view when the target has a pipeline, or let a Team protect `sabir-uat`/`uat-main` if wanted.
  5. **Hygiene:** gitignore run logs; set model and effort explicitly; fix the sync-test flake.
  6. **Onboarding:** first-run guidance in the UI for the bridge, the plugin and the Figma token. Truthful, no fake controls.
  7. **Packaging:** a one-command start (server + bridge), and a README section for a new organisation.

## 18. Launch definition
A real organisation can:
1. create a Team;
2. add specialised Workers;
3. attach a real Workspace;
4. attach knowledge and resources;
5. configure legitimate requirements and access;
6. define useful rules and instructions;
7. give the Team a real task;
8. let the Worker operate with real tools;
9. observe the work;
10. receive a useful result;
11. review the changes;
12. commit or push where allowed;
13. understand failures and missing access.

**Status:** each step exists and is tested locally (§9). What isn't proven is the whole loop in the owner's real console on a real MATW task. That's the launch proof to do first.

The product doesn't need every future feature to launch.

## 19. Commercial / business vision (CONVERSATION-ONLY; nothing commercial is built)
- **What organisations pay for:** specialised AI workers and Teams, not "chat".
- **Where the value comes from:** specialization, tools, access, knowledge, memory, workflows, responsibility (limits, enforced policies, `NEEDS:`), real execution, and organisational context. Prompts renamed as workers wouldn't carry that value.
- **Conceptual SaaS:** customer subscription → our platform → Worker/Team execution → model provider(s) → real work.
- **Before pricing:** API and model costs, infrastructure, usage limits and commercial terms must be validated.
  - Today's runtime uses the owner's Claude Code subscription. **That isn't a basis for a commercial service.** Commercial use needs API terms and keys (OPEN).
  - No revenue numbers are forecasts.

## 20. Future architecture (FUTURE, not current)
- **Workspace providers:** local (built) → GitHub → server or remote.
- **External channels:** WhatsApp and others (the `NEEDS:` event is the hook).
- **Model providers:** Claude (built, via Claude Code) → Claude API → OpenAI, Gemini, ….
- **Organisational model:** Organization → Teams → Workers → Resources → Knowledge → Policies → Runs.
- **Also:**
  - multi-worker orchestration (Team leader, delegation);
  - a credential store with per-Team/worker credentials and OAuth in the UI;
  - OS or container isolation for shell commands, and a sandboxed command runner;
  - a browser host allow-list per workspace;
  - SaaS billing and usage metering;
  - the Next.js + React + TypeScript UI;
  - more resources (GitHub, documents); richer memory (search, expiry); shared or imported workers.

---

## 21. ARCHITECTURAL DECISIONS: DO NOT ACCIDENTALLY REVERSE

| Decision | Why |
|---|---|
| **Team is not a second runtime.** A Team run is the member worker's normal run. | One execution path to secure and test |
| **The Worker remains the execution unit.** The Team adds context and scope. | Keeps specialisation and accountability per worker |
| **A Team cannot widen workspace permissions.** Effective access = capabilities ∩ mode ∩ Team scope ∩ platform. | The workspace is the security boundary |
| **Worker capabilities are not authorization.** They only load tools. | Access is decided by the workspace, credentials and the resource owner |
| **Requirements ≠ credentials.** They're checked, never granted. | No fake access; no new credential system yet |
| **Missing access produces `NEEDS:`**, never a workaround. | Honest workers; the future stakeholder hook |
| **Historical runs use snapshots** (definition, Team, context, upload copies). Resumes keep their version; enforcement is never weaker on resume. | Reproducibility; no silent rule changes |
| **Shared knowledge references workspace files** and doesn't copy them. | No stale duplicates |
| **Security is enforced below the model** (tools, deny rules, adapters, server). | The model isn't a boundary |
| **No fake enforced rules.** Only `protect_branch` is enforceable; everything else is an INSTRUCTION. | Platform credibility |
| **Branch policies hold per repository**, not per workspace id. | A sub-folder workspace mustn't escape |
| **Under a branch policy: no shell, `--restricted`, deny `.git`/`.claude`.** | A shell can run git; repo hooks and settings could re-enable it |
| **The Figma lock lives in the adapters** (env set per Team run). | Enforcement where the action happens |
| **The local runtime is `claude.exe` on the owner's subscription**, not the API. | Reuses Claude Code's permission system, MCP and sessions |
| **The UI isn't the platform.** | The platform is `server.mjs` and the adapters; the UI can be replaced later |
| **No Next.js migration during the 20-day window** without a concrete reason. | Launch first |
| **Don't push code without explicit instruction.** | The owner controls publication |
| **Never add Claude/AI co-author trailers to commits.** Preserve the owner's git identity. Worker settings disable Claude's attribution; the console's commit adds nothing. | The owner's explicit rule |
| **Bind runs to the workspace's real root, profile and config dir; check `init.cwd`.** | Claude Code resumes in any cwd |
| **Inspect is an allow-list** (fails closed). | New tools are refused by default |
| **Attachments and mentions are references or messages, never written into the workspace;** `@path` is defused. | Contents and outside files mustn't sneak in |
| **Commit and push are explicit actions the person takes;** workers are told not to, and under a policy can't. | A human reviews before changes leave the machine |
| **The console listens on loopback only, with the same-origin guard;** the bridge is loopback only. | No LAN or web-page control |
| **Integration tokens never go to workers** (`FIGMA_*` dropped; Reader reads its own file). | Keeps secrets out of worker contexts and logs |

---

## 22. If a new Claude joins tomorrow

**What this is:** §1. **Constraint:** launch in 20 days (§17); don't push; no co-author trailers.

**Where the code is:**
- `worker-ui/server.mjs`: the whole platform. Sections: workers, teams, Claude config, workspaces, runs, attachments, versions (git), prompts, http, file containment, `@` mentions, request guard, routes.
- `worker-ui/workspace.html`: the UI (vanilla JS, one file).
- `worker-ui/worker-instructions.md`: the platform reporting rules given to every worker.
- `mcp/server.mjs`: Figma Executor tools. `mcp/reader-server.mjs`: Figma Reader tools.
- `bridge/server.js`, `plugin/{code.js,ui.html,manifest.json}`: the Figma execution path.
- `browser-adapter/server.mjs`: the browser.
- `figma-reader/`: REST reader, CLI, OAuth.
- `workers/*.json`: reusable worker definitions (load with `POST /workers`, the same way the tests do).
- `bench/`: tests and evidence. `docs/`: design docs.
- **Unrelated or legacy:**
  - `agent/agent.mjs`: an early API-key agent (Anthropic SDK), unused by the product;
  - `worker/`: verification helpers;
  - `deliverables/`, `exports/`, `reference/`, `scripts/`, `intent-create-html/`: benchmark and design artefacts.

**Start the system (Windows, Node 22, Claude Code CLI 2.1.283 installed and logged in):**
```powershell
# once: npm install in bridge/, mcp/, browser-adapter/ (Playwright Chromium)
cd bridge; npm start               # Figma bridge on 127.0.0.1:8787 (only for Figma work)
# Figma desktop → Plugins → Development → Import plugin from manifest (plugin/manifest.json) → Run
node worker-ui/server.mjs           # console → http://localhost:8799
```

**Ports:**

| Port | Use |
|---|---|
| 8799 | console |
| 8797 | test console (tests) |
| 8787 | Figma bridge |
| 3007 | Figma OAuth callback |
| 8790 | B5 benchmark expense portal (bench only) |

**Restart the console after changing `server.mjs` or `workspace.html`.** The owner's own console runs on 8799; don't kill the owner's processes without asking.

**Data:**
- the console's data dir is `worker-ui/` (workspaces, workers, teams, prompts, runs, scratch);
- worker memory: `worker-ui/workers/<id>.memory.json`;
- Teams: `worker-ui/teams.json` and `worker-ui/teams/`;
- runs: `worker-ui/runs/`;
- Claude sessions: `~/.claude/projects/`;
- Figma Reader credential: `~/.figma-reader/credentials.json`.

**Tests:** `bash bench/workspace-ui/run-suite.sh <suite>` from Git Bash.
- **Suites:** workflow | manage | sync | attach | versions | mentions | workers | designer | teams.
- **Setup:** it starts a fresh test console on 8797 with a new data dir, and builds the fixtures under `%TEMP%\wsui` via `bench/workspace-ui/fixtures.mjs`. Canary values only, never real secrets.
- **Teams suite:** needs the real MATW repo at `C:\Users\hp\Desktop\MATW\matw-revamp-main-frontend-site` (or `MATW_SRC`). It only reads it.
- **Designer suite:** reads the open Figma file (read-only) if the plugin is connected.
- **Cost:** the real worker runs, so suites take minutes and use the subscription.
- **Evidence:** `bench/workspace-ui/<suite>-results.json`.

**Figma:** §6.1. **Browser:** §6.2. **Security assumptions:** §7 and §15.

**What not to touch without the owner:**
- don't push; don't rewrite history;
- don't commit the uncommitted `plugin/code.js` change unreviewed;
- don't write to the real MATW repo (use a clone);
- don't read or print real secrets (`.env` in MATW exists; tests use canaries);
- don't touch the owner's tokens in other tools' config (e.g. `~/.claude/.credentials.json`);
- don't modify the user's live Figma file in tests (use read-only checks or a fake bridge);
- don't weaken a security restriction to make a test pass.

**How the owner works:**
- **Inspect before building.** Propose when the scope is ambiguous, then build fully when asked.
- **Prove with real tests.** Report exactly what changed and which test proves it. Mark what's unverified.
- **Commit:** locally, without trailers, when the work is done and tests are green.

**Immediate priority:** §17. Do the §18 launch loop end to end in the owner's real console on a real MATW task, and fix what blocks it.
