# Worker platform: design (2026-10-02)

> Project overview and current status: `docs/PROJECT_HANDOFF.md` (canonical). This file is the Worker design.

## 1. What exists today

**Worker runtime.** `worker-ui/server.mjs` starts one headless `claude.exe` per run (stream-json in and out, so one process takes follow-ups), resumes a saved session in a new process, and turns the worker's output into the event log the page shows. Every run gets the same `worker-instructions.md` and the same tools, decided only by the workspace's profile.

**Workspace.** A folder plus a security profile: `full` ("Work") or `inspect`. The profile is the hard boundary. It decides `--restricted`, `--tools`, `--allowedTools`, the MCP servers' own modes (browser http-only in Inspect), and which Git actions exist. A run is bound to its workspace's real root, profile and config dir for life.

**Tools.**
- Built-ins: Read, Glob, Grep, Write, Edit, Bash(node/curl), WebFetch, WebSearch.
- MCP: `figma-executor` (the plugin + bridge: read and edit a Figma file that's open and connected) and `browser-executor` (Playwright).
- The Figma Reader (REST, from a URL) exists as a CLI only.

**Persistence.** JSON files in the console's data dir (`workspaces.json`, `prompts.json`, `runs/*`). Credentials never go there. The Figma Reader keeps its token in `~/.figma-reader/` (outside every repo), and Git uses its own credential manager.

## 2. The change: one runtime, many workers

```
Worker definition (who, what for, what it may use, what it needs, its rules)   -- workers.json
        +  Worker memory (what it learned from work)                          -- workers/<id>/memory.json
        ↓   snapshot taken when a run starts
Run  =  worker snapshot  ×  workspace (folder + profile)  ×  person's message
        ↓
the same claude.exe runtime: system prompt + tools + MCP servers computed from all three
```

- **No second runtime.** A worker definition only changes the arguments the existing `spawnWorker` already builds.
- **The definition can only narrow what the workspace allows; it can never widen it.** Effective tools are workspace profile ∩ worker capabilities. A worker with "edit files" in an Inspect workspace gets no Write.
- **The general worker** (no definition) keeps exactly today's behaviour, so existing runs, tests and the old console are unchanged.

## 3. Data model

```js
// workers.json (data dir, gitignored): definitions only, never credentials
{ id, name, mission, specialization,
  capabilities: ["files.read", "browser", "figma.read", ...],   // ids from the capability catalogue
  knowledge,                     // domain instructions, conventions, reference notes (text)
  workflow: ["Understand the request", ...],                     // ordered steps
  limitations: ["Never ...", ...],                               // hard rules
  requirements: [{ resource: "figma", access: "read", need: "required" | "optional" }],
  onMissing,                     // how to ask for something missing (tone, who to ask)
  version, createdAt, updatedAt }
// workers/<id>/memory.json: what the worker chose to remember
[{ text, at, run }]
```

## 4. Capabilities map to real tools

The catalogue is fixed in code, because a capability must name tools that exist.

| Capability | Tools | Profiles |
|---|---|---|
| `files.read` | Read, Glob, Grep | both |
| `files.write` | Write, Edit | Work |
| `shell` | Bash(node:\*), Bash(curl:\*) | Work |
| `web` | WebFetch, WebSearch | Work |
| `browser` | browser-executor (Inspect: navigate + read page only) | both |
| `figma.read` | figma-reader MCP: read a design from a URL via the REST API | both |
| `figma.plugin.read` | figma-executor read tools (the plugin must be open) | both |
| `figma.plugin.edit` | figma-executor edit tools | Work |

A capability turns a tool on. It grants no access to any resource.

## 5. Requirements and access

Requirements are generic `{resource, access, need}` entries. A small resource registry in code knows how to check each one *right now*, without exposing secrets:

| Resource | Access | Checked how |
|---|---|---|
| `figma` | `read` | a Figma Reader credential exists **and** Figma accepts it (`GET /v1/me`, cached) |
| `figma` | `edit` | the Figma plugin is connected to the bridge (PING) |
| `workspace` | `write` | the run's workspace is Work |
| `browser` | `use` | the browser adapter is installed |

**At run start:** the statuses are checked, written into the worker's context and shown as a "Requirements" card.

**Enforcement doesn't depend on the prompt:**
- tools for missing capabilities aren't loaded at all;
- the Figma Reader tool itself refuses without a valid authorization, and says what's needed;
- a file the authorized account can't see still gets Figma's 403 or 404.

**What the worker must do:** when a task needs something missing, it stops and writes `NEEDS: <resource> <access>: <what the person must do>`. The console turns that line into a "Needs access" event. That event is the hook a future channel (WhatsApp, …) would use to ask the stakeholder.

**Credentials** stay where each integration already keeps them securely (`~/.figma-reader/`, Git's credential manager). They're available only to workers whose capabilities load the tool that uses them. Per-worker credential scoping is future work.

## 6. Memory, separate from the definition

- **Writing:** the worker writes `REMEMBER: …` lines. The console stores them in that worker's memory file, with the date and run, and refuses lines that look like secrets.
- **Reading:** the next runs of that worker get the memory as a separate, clearly labelled section ("may be outdated").
- **Control:** the person can see and delete each entry.
- **Separation:** the definition is never edited by the worker.

## 7. Lifecycle and editing

- Saving a definition bumps `version`.
- A run stores a **snapshot**: the definition and the generated context file, `runs/<id>.worker.md`. History and resumes keep using the version the run started with.
- New runs use the latest version.
- Deleting a worker leaves its runs readable and resumable from their snapshots.

## 8. UI

- **Sidebar "Workers" section:** the same row style as Workspaces. Selecting a worker sets who answers new chats, and the composer shows that worker.
- **Defining a worker:** opens in the centre panel, like a version or a file.
- **The form follows the definition:** identity, capabilities (each with its real tools and whether this workspace allows it), knowledge, workflow, limitations, requirements (with live status), what to do when something is missing, and memory.
- **No decorative fields.**

## 9. Now vs later

**Now:**
- the definitions, the runtime mapping, the requirement checks, NEEDS and REMEMBER;
- the Figma Reader as an MCP tool;
- the UI, and behavioural tests.

**Later (extension points, not built):**
- channels (WhatsApp);
- per-worker credentials and OAuth flows inside the UI;
- more resources (GitHub, documents);
- reference files, and shared or imported workers;
- richer memory (search, expiry).

## 10. Conflicts with the requested model

- **Capabilities can't override the workspace's security profile.** The request's diagram puts resources under the worker. Here the workspace stays the security boundary, and the worker can only narrow it.
- **Credentials are per integration on this machine, not per worker.** A worker reaches a credential only through a tool its capabilities load. Per-worker credentials need a credential store that doesn't exist yet. That's documented rather than faked.

## 11. Work without a folder (added 2026-10-06)

Not all work has a project folder. A Figma design job's target is the Figma file the plugin has open.

- **Scratch** (called "No folder" until 2026-10-20): a built-in mode (`id: scratch`) that's always present, listed apart from the project folders.
- **How runs use it:**
  - Each conversation runs in its own new, empty folder (`<data>/scratch-runs/<run id>`), with the Work profile; the worker's capabilities still narrow its tools.
  - A fresh-session continuation works in its parent's folder.
  - Runs from before 2026-10-20 keep the old shared `<data>/scratch`.
  - Details are in `docs/ux-remediation.md` §3.
- **The rule stays the same:** every run has exactly one bound workspace. That's what keeps resume and the file viewer bound to a real folder.

## 12. Teams (added 2026-10-06)

Teams group workers with shared knowledge, resources, instructions, prompts, requirements and enforced policies. They're built on this platform and add no new runtime. See `docs/team-platform.md`.

## 13. A worker for the work a person describes (added 2026-10-22)

**Journey.** The person never picks a job title. It goes: describe → tools and systems → review → create → first task.
1. **Describe.** "What would you like your AI worker to do?", answered in their own words. Examples are only inspiration.
2. **Tools and systems.** The console recognises the ones the description names, shown as chips the person can remove, add to, or extend with "something else".
3. **Questions.** Only those integrations' questions are asked. A required one with no default is a follow-up the person must answer; the console doesn't guess.
4. **Review.** Name and mission (their words), where it works, the tools it gets in that workspace, its requirements checked now, what's not possible today, what stays with the person, and its steps, knowledge and limits.
5. **Create.** A normal definition in `workers.json`, then the new-task screen with their request as the first task.

**Registry: integrations, not roles** (`worker-ui/integrations.mjs`). Each integration declares:
- whether a real connector exists;
- the questions it needs;
- what each answer adds:
  - capabilities and requirements, from the fixed catalogues only;
  - steps, knowledge and limits (instructions to the worker);
  - an approval note;
  - or another integration (`adds`).

| Integration | Connector | What it really does today |
|---|---|---|
| Git branch sync and promotion | yes | read-only Git tools, plus the worker's Git workflow page (commits by developer, ownership evidence, simulated plans, approved proposal branches): `docs/gitflow-worker.md` |
| Code repository | yes | files, Node scripts (node and curl only), browser checks; commits and pushes stay the person's |
| Builder.io | yes | read / drafts / publish (test spaces only, enforced by the adapter) |
| Figma | yes | the open file through the plugin (edit or only look); other files by link with a token |
| Websites in a browser | yes | read pages (Inspect); click, fill, screenshot (Work); no saved logins |
| Web research | yes | search and fetch |
| Files in a folder | yes | read or edit CSV, Markdown, JSON, text |
| Shopify | **no** | products and orders through an exported CSV (Files); theme code in a repository (Code); store pages and the live store aren't possible |
| Google Sheets | **no** | CSV downloads and imports (Files); live sheets aren't possible |
| WordPress | **no** | public pages in a browser; theme or plugin code in a repository; posts, pages, media and settings aren't possible |
| Notion, Slack, Gmail, Airtable, HubSpot, Salesforce, Stripe, Jira, Trello, Webflow, Wix, Squarespace, Mailchimp, WhatsApp | **no** | named honestly; nothing composed |

Any other system the person names under "something else" is listed as having no connector.

**Composition** (`compose()`; server-side only):
- Capabilities start from `files.read`; each answered question adds its own.
- The page sends the description, the integration ids and the answers. Capability lists in the request are never read.
- Unknown integrations, questions and choices are refused (400).
- `POST /workers/from-request` is refused while a required follow-up is unanswered, or when nothing asked for has a connector.
- A Shopify request answered "products and inventory" is still a "Shopify worker". It gets the Files integration (edit), the knowledge that products come from a CSV export, and "not possible: changing the live store".

**Security is unchanged.** The result is an ordinary definition run through `workerRuntime`: capabilities ∩ workspace mode ∩ Team scope ∩ platform.
- Requirements are checked, never satisfied, by an answer.
- Missing access makes the worker write `NEEDS`.
- The Builder adapter refuses production spaces, whatever was chosen.
- The registry is checked against the catalogues at start-up (`checkRegistry`): a bad entry stops the console.

**API:**
- `GET /integrations`
- `POST /worker-drafts/preview {description, integrations?, answers?, others?, workspace?}`: the composition, the tools it would get in that workspace, and its requirement states
- `POST /workers/from-request {…, name?, mission?}`: the worker records `fromRequest {description, integrations, answers, others, workspace, unsupported, starters}`

After creation, the worker's full definition is its editor, as for any worker. The shared definitions in `workers/*.json` are still added with `doctor --seed-workers`; they're internal starting points, not the creation journey.

**Replaced:** a short-lived catalogue of five worker templates (2026-10-22, `d413e6b`). It made people choose one of our job titles instead of describing their work (`docs/ux-sprint.md` §0).

**Tests:** `bash bench/workspace-ui/run-suite.sh create`. It covers the ten scenarios: Shopify, Sheets, WordPress, Next.js, Builder.io, a combination, no connector, missing credentials, denied permissions, and a real run of a created worker. Also `node bench/hosted/journey-test.mjs`.
