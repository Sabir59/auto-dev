# The worker's home, its own context, and its assistant (2026-11-07)

Milestone 1 of `docs/PRODUCT_DIRECTION.md`: the worker becomes the place a person opens, understands, talks to and changes.

## What the person sees

Clicking a defined worker in the sidebar opens its **home** (`openWorkerHome`, `workspace.html`). It also chooses that worker for the next task. The General worker has no home and works as before.

| Part | What it shows | Where it comes from |
|---|---|---|
| Header | name, specialization, version, "Working in" (a workspace picker), readiness, open task, changes waiting | `GET /workers/:id/home?workspace=` |
| Overview | purpose and objectives (editable), counts, readiness in that workspace, recent tasks, "Make it yours" | same |
| Knowledge & instructions | steps, general knowledge, "when something is missing", hard limits; **knowledge entries**, **skills**, **references**, **documents** (each with its source and when it changed); learnings; **what a task receives** (the context, section by section, with its source) | same; `GET /workers/:id/context-preview` |
| Tools & access | the person's **accounts** (Figma, Builder spaces, GitHub), and what **this worker** was given of each; its integrations; each capability's availability in the chosen workspace; boundaries | same |
| Activity | its tasks; its assistant conversations | same |
| History | changes waiting for approval (approve or reject, with what changes); the worker's own proposals; every version (compare, restore) | same; `POST /workers/:id/changes/:cid/approve\|reject`; existing `/versions`, `/restore` |
| Assistant (right column) | a conversation about this worker | `POST /workers/:id/assistant`, then `/runs/:id/message`, `/events` |

"New task" opens the composer with this worker chosen, in the workspace the home shows. "All settings" is the existing editor; integrations and access are still changed there, or through the assistant with approval.

## The worker's own context (`worker-ui/worker-context.mjs`)

Schema-2 field `context`, versioned with the rest of the definition:
- **knowledge**: `{ id, title, text, source, updatedAt }`.
- **skills**: `{ id, name, description, instructions, … }`. A skill is a named procedure, given to every task. The worker is told to follow a skill when the task matches its description, and to say which one it used. It's plain text in the context, not a Claude Code skill (see Limits).
- **references**: `link`, `repository` (+ branch) or `note`. A reference grants nothing: access is still the worker's grants and the workspace.
- **documents**: references of kind `document`.
  - Stored content-addressed in `<data>/workers/<id>/documents/<sha16>-<name>`, at most 10 per worker and 512 KB each.
  - Each run gets read-only copies in `runs/<id>.docs/`, through `--add-dir`. The runtime refuses writes there (`platformDeny` covers `runs/**` and `workers/**`); tested.

`source.kind` is `owner`, `assistant`, `package`, `clone` or `migration`. Text that looks like a credential is refused. The existing editor sends no `context`, so saving there keeps it.

## One change model (`worker-ui/worker-change.mjs`)

The owner's edits on the home and the assistant's changes go through the same `plan()`. Then `normalizeWorker`, exactly as an editor save, so a change can't give anything the editor wouldn't. Then `writeWorkers`, which writes a new recorded version (`source.kind`: `owner` or `assistant`).

| Part | By the assistant | By the owner |
|---|---|---|
| identity, steps, general knowledge, "when missing", adding a hard limit, adding or updating knowledge, skills and references | applied at once, as a version | applied |
| removing a hard limit, an entry, a skill or a reference; removing more than half of the steps or the knowledge | **waits for approval** (`workers/<id>/changes/<cid>.json`) | applied (confirmed in the page) |
| access: core tools, repository access, integrations | **waits for approval** | in All settings |
| credentials | refused | not here (accounts are connected on their pages) |

A stale base version is refused (409). An approval made for an older version is refused as stale.

## The assistant (`mcp/assistant-server.mjs`)

An assistant conversation is a run with `meta.assistant` (not `meta.worker`):
- It has its own Scratch folder.
- **Its only tools** are `worker_inspect`, `worker_change` and `worker_add_document`. It has no files, shell, web or integration tools, and no evolve tools.
- It reaches `/assist/<run>/…` with its run's token, for its own worker only. Approving is the person's (page routes behind the request guard).
- Its context is `assistantContext()` in `server.mjs`.
- It can be open **while a task runs**: `active()` ignores assistant runs. At most one assistant conversation is live at a time, and switching Claude accounts waits for both.
- Its conversations are listed on the worker's Activity tab, not in the sidebar.

## Packages: format 3

A worker with its own context exports as **format 3**: format 2 plus `context.json` (no sources or dates) and `documents/<file>`, all checksummed. A worker without context still exports as **format 2**, so older consoles can import it. Import and clone install the context with new copies of the documents. Checks: a document not referred to, context in a format-1/2 package, or format 4 is refused.

## Migration of the person's workers (done 2026-11-07)

The three real workers (Senior UI/UX Design Engineer, Builder Page Engineer, BAU branch sync worker) were migrated to schema 2 through the existing migration (backup `worker-ui/backups/workers-2026-11-06T22-58-08-705Z.json`; undo: "Review older workers" or `POST /migration/undo`).
- It was rehearsed first on a copy of the data: identical launch plans (order aside); no step, limit or knowledge line lost; export still works; undo restores them.
- One visible difference: requirements now come from the Figma manifest. Figma read is *required* for both Figma workers, and the Builder Page Engineer lists Figma edit, whose tools it already had.

## Tests

- `node bench/studio/studio-test.mjs`: real Claude Code runtime, scripted model; 18 steps. It covers the migration, home, owner edits and their refusals, documents, the editor keeping context, the context preview, context and read-only documents in a real task run, a real assistant conversation (applied, pending, refused credential, document), its tool set, running alongside a task, token checks, approve, reject, stale, restore, and format 3 export, import, clone and refusals.
- `node bench/studio/home-ui-test.mjs`: the home in a real browser (Playwright), with the assistant on the scripted model; 8 steps; screenshots in `bench/studio/shots/`.

## Limits (next increments)

- Skills are text in every task's context, not loaded on demand. Moving them to Claude Code's own skills needs checking that they load headless under `--restricted`.
- The assistant can't read a repository or the web yet ("understand our architecture" works from what the owner pastes or attaches).
- Integrations are still only the platform's catalogue. Remote MCP and API capabilities come next (`PRODUCT_DIRECTION.md` §F).
- Custom interfaces for a worker: the home is the same for every worker; it says so.
- Hosted: the routes are the same and guarded the same, but not yet tested in the hosted image.
