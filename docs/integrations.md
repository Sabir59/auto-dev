# Integrations, core capabilities and workers (2026-10-25)

A worker has three things:
- **its role:** name, mission, specialization and outcomes;
- **its integrations:** each pinned to an exact version, with that version's validated settings;
- **its core capabilities:** granted to it explicitly.

It also has its own instructions. What an integration brings (its tools, the accounts it needs, its steps, limits and setup text) is read from its manifest, never copied into the worker.

Permissions are decided by code at every run's start and at every integration tool call. Recommendations and the AI never grant anything.

## The warehouse (`worker-ui/integrations/`)
- **`<id>/<semver>.json`:** one released version of one integration. It's checked against `manifest.schema.json` (JSON Schema draft 2020-12, validated by `worker-ui/jsonschema.mjs`). Each manifest has:
  - its id and version;
  - its status: `tested`, `preview`, or `recognised` (named but with no connector);
  - its **owner**, its review level, and **the tests that prove it**;
  - the workspace it needs, and its detection words;
  - the **capabilities it provides**, each with the accounts it needs;
  - what it turns on always (`base`) and per answer (choices: `enables`, `core`, `requires`, limits, an approval note, and `adds` for another integration);
  - why it uses each core tool (`coreWhy`);
  - naming templates, instructions (steps, limits, starters) and setup questions;
  - a **config schema** for its settings;
  - **relations** to other integrations, each with a reason and patterns for when it's relevant;
  - a description of what changed in each version.
- **`core.json`:** the core capabilities (files.read, files.write, shell, web, browser), each with the accounts it needs, and the General worker's default grant. **No core tool is given to a worker by default.**
- **`releases.lock.json`:** the sha256 of every released version, so **released versions are immutable**.
  - The console refuses to start if one changes, or if one disappears.
  - An unreleased version loads only with `AIW_INTEGRATIONS_DEV=1`.
  - Release with `node worker-ui/integrations/release.mjs <id>@<version>`.
- **`order.json`:** the order integrations are recognised and named in.
- **`REVIEW.md`:** ownership, review levels and releasing.

`worker-ui/catalog.mjs` loads the warehouse and checks it against the console's code catalogues when the console starts:
- every capability is classified exactly once, as core or provided by an integration;
- every account and requirement exists;
- relations and added integrations point at real ones;
- patterns compile, and the tests a manifest names exist.

Executable logic stays in code: what a capability's tools are, and how an account is checked.

## Workers
**Schema 2** (`worker-ui/workerdef.mjs`) stores:
- its role: `name`, `specialization`, `mission`, `outcomes`;
- `integrations: [{ id, version, config }]` and `core: [ids]`;
- its own `workflow`, `knowledge`, `limitations` and `onMissing`;
- `extraRequirements`, `repos`, `version`, `fromRequest`, `origin` and `migratedFrom`.

**Resolution reads the pinned manifests** and works out:
- its capabilities: each integration's (for its settings), plus its core grants;
- its requirements;
- each integration's instructions, kept apart from its own;
- a report.

Resolution **fails closed**: a missing version, invalid settings, or an unknown integration contributes nothing.

**Workers made before integrations (schema 1)** keep working as they were until they're migrated.

**Creating** a worker from a description (`integrations.mjs` compose) pins each integration at its newest released version. Its answers become the integration's settings, and the core tools the composition gives become explicit grants.

## Authorization (fail-closed)
**Effective access** at a run's start (`launchPlan` in `worker-ui/server.mjs`):

```text
(integration capabilities for its settings ∪ core grants)
  ∩ workspace mode ∩ Team scope ∩ policies ∩ platform
  − capabilities whose accounts aren't available now (the gate)
```

- **The gate (`accountGate`)** checks each capability against its manifest's (or the core catalogue's) accounts. A missing account, a rejected or expired credential, a check that fails or times out, or an unknown capability means the capability isn't available. The run and the worker's context say why.
  - **An integration capability** (one served by an integration tool server: Figma, the Figma Reader, Builder, Git workflow) is still loaded, with its tools off. It **waits for its connection**.
  - **Any other** (built-in tools, the browser) isn't loaded. A running process's built-in tools can't change.
- **The Figma bridge** is started at a run's start for any worker that can use the open file (read or edit), so a plugin opened later can connect.

### Connections during a run
A connection that comes up mid-task brings its tools into **the same task**. There's no new task, and the conversation is kept.
- **The console checks** the run's integration capabilities every 3 seconds (`refreshLive`), with the same account checks as at the start. Successful Figma and Builder token checks are cached for 60 seconds, failed ones for 5.
  - **A capability that stops being available** is turned off at once.
  - **One that comes up** is turned on after two checks in a row, so a flickering connection doesn't toggle tools.
- **Each tool server follows the run's live set.** It asks `GET /authz/:runId/live` (token-checked) before it connects, then every 2 seconds, and enables exactly those tools (`mcp/authz.mjs`). Enabling or disabling a tool sends `notifications/tools/list_changed`, and Claude Code updates the session's tool list. The worker finds the new tools with ToolSearch.
  - Tested with Claude Code 2.1.283, in `runtime-tools-test.mjs` and a model run.
  - **A server that gets no answer turns all its tools off.**
- **Only capabilities given to the run at its start can come on.** Nothing is ever added. Being listed isn't being allowed: every call is still checked (`authorizeCall`).
- **Each change is shown** in the run (Connected, Unavailable, Waiting for a connection). The worker is told with the person's next message, in one bracketed line before their text. The worker's context says from the start that waiting tools come on in this task.
- **Check connections** (in the run, `POST /runs/:id/recheck`) checks now, and turns on what's connected at once. It also starts the Figma bridge if it isn't running.
- **Confirmation (`confirmLive`):** after a change, the console waits for the tool servers to report the version they applied, then asks the runtime (`mcp_status`). If the runtime lists fewer tools than the server has on (an older Claude Code), the run offers **Reload tools** (`POST /runs/:id/reload-tools`). That ends the process between turns, and the next message resumes the same conversation (`--resume`) with what's connected then.
- **A resumed run** confirms what's connected before its tool servers get their first answer. It doesn't reuse what its first start found.
- **The plugin reopened in another file:** the person and the worker are told which file the Figma tools act on now. A Team run is pinned to its own file: another file means its tools are off.
- **Each integration tool call** (Figma executor, Figma reader, Builder, Git workflow, repository) is checked again by `mcp/authz.mjs`. The run must be active, the call must come from that run's own tool server (token), the capability must have been given to the run, and its accounts must still be available. Results are reused for at most 10 seconds. Anything else, including no answer within 8 seconds, refuses the call with `NOT_AUTHORIZED` and does nothing.
- **Built-in tools** (files, shell, web) aren't brokered per call; they're fixed for the run at its start.
- **The General worker** gets only the core capabilities granted to it in its settings (default: all five core tools), never an integration's tools. Before this change it ran with every tool the workspace allowed, including the Figma executor.
- **`GET /access/preview?worker=&workspace=`** shows what a run would start with, planned and effective, without starting one.

## Recommendations
`POST /integrations/recommend` is deterministic:
- the integrations the request names are **required**;
- an integration's declared relations add others (**suggested** or **optional**) only when their patterns appear in the request, each with its reason.

For example, Builder.io is optional for a Shopify worker only when the request mentions a headless storefront or its content. Recommending never adds anything: the person chooses. "Add integration…" searches the whole catalogue.

## Upgrades
- **A newer version never changes a worker by itself.** The editor shows "Upgrade to vX".
- **The upgrade diff** covers what it provides, the core tools it needs (and any to grant), the accounts it asks for, how the worker's settings carry over (kept, reset or no longer used), and its instructions.
- **More access needs explicit approval:** a new capability, or a new core grant.
- **Rules:** downgrades are refused; settings that aren't valid for the new version are refused.

## Migrating workers made before integrations
`GET /migration` proposes a mapping for each schema-1 worker:
- **exact:** from the request it was made from;
- **likely:** one setting gives exactly its tools;
- **ambiguous:** no single setting gives its tools (for example, Builder publish and drafts-only together), or a tool maps to nothing. The choices say what each one loses.

The proposal also separates the text its integrations provide from its own.

`POST /migration/apply`:
- refuses a mapping that changes its tools until that change is accepted;
- backs up `workers.json` (to `<data>/backups/`) first;
- writes schema 2 with `migratedFrom`.

`POST /migration/undo` restores the backup. The page has a "Review older workers" entry in the sidebar.

## Worker packages
Format 2 carries the pinned references, settings (except fields a manifest marks secret) and core grants. Format 1 is still read: it installs as a schema-1 worker that can be migrated. See `docs/worker-packages.md`.

## Tests
| Test | What it covers |
|---|---|
| `bench/integrations/effective-test.mjs` | Effective access at the process boundary for 18 workers × 2 workspace modes against the P0 recording (`golden-effective.json`), with only the changes in `intentional.mjs`. Also: launches use the effective plan; the gate takes away exactly what's missing; integration servers get the per-call check; created workers resolve to what was composed. |
| `bench/integrations/catalog-test.mjs` | The warehouse: validity, ownership, immutability, unreleased versions, and bad manifests stopping the console. |
| `bench/integrations/authz-test.mjs` | Fail-closed at the start and per call (token, capability, a plugin disconnecting or hanging mid-run, a stopped run), the MCP guard itself, and the General worker. |
| `bench/integrations/live-test.mjs` | Connections during a run, with a stand-in for Claude that really connects the tool servers. Covers: the plugin opening mid-task (tools on in the same process, the worker told with the next message); closing (tools off, calls refused); Check connections; a resumed run using what's connected now; a runtime that doesn't pick up the change (Reload tools); and the plugin moving to another file. |
| `bench/integrations/runtime-tools-test.mjs` | The real Claude Code binary, without a model call: tools coming on and going off in the same session, as its `mcp_status` reports them. It runs in a config folder of its own, and is skipped without the binary. |
| `bench/integrations/lifecycle-test.mjs` | Recommendations; pinning and upgrades (with approval); migration (exact, likely, ambiguous, refusals, access unchanged, separated text, undo); the page flows. |
| `bench/workspace-ui/workerpack-test.mjs` | Formats 1 and 2 across two consoles. |
| `bench/integrations/fake-claude.mjs` | A stand-in for the Claude binary (`CLAUDE_BIN=node`, `CLAUDE_BIN_ARGS=["…fake-claude.mjs"]`) that records how a run was started. Optional switches: `FAKE_CLAUDE_MCP=1` connects the servers and answers `mcp_status`; `FAKE_CLAUDE_REPLY=1` replies and logs messages; `FAKE_CLAUDE_STALE_FILE` makes it act like a runtime that ignores `list_changed`; `FAKE_CLAUDE_SESSIONS=1` writes resumable sessions, but only into a config folder the test set itself. |
