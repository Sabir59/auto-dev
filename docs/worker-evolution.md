# Worker evolution: a worker proposes changes to itself (2026-10-28)

A person can teach a worker how their organisation does something ("our A/B tests work like this; learn it"). The worker proposes a change to its own definition. The console checks the proposal, can try it in a trial run and grade that run against what actually happened. Only the person approves it, and it becomes a new, recorded version of the worker.

## The lifecycle

| State | What it means | Who moves it |
|---|---|---|
| **proposed** | Stored after passing the console's checks. Nothing about the worker has changed | the worker (`evolve_propose`) |
| **stale** | The worker changed since (its version isn't the proposal's base). It can't be tried or approved; the worker proposes again | worked out by the console |
| **approved** | The person approved it: it is version N+1 of the worker | the person |
| **rejected** | The person rejected it; it stays on record | the person |

A refused submission isn't stored. The worker gets the reasons back and can propose again.

**Verification is separate and is worked out by the console from what it recorded, never from the worker's words:**

| Verification | Evidence |
|---|---|
| **passed** | The latest graded trial of the proposed version ran every check, and all passed |
| **blocked** | What it relies on isn't available now (for example "Builder.io: read content: Not connected"), and nothing has passed |
| **failed** | The latest graded trial ran its checks and at least one failed |
| **untested** | No graded trial yet, or its checks couldn't be run (the reason is given) |
| **no-checks** | It has no checks, so the console can't test it |

**Approving.** Approving something that isn't **passed**, or that removes a hard limit or most of the knowledge or steps, needs the person's explicit acknowledgement. The page keeps the Approve button disabled until it's ticked. That acknowledgement is recorded in the new version.

## What a proposal can change

A proposal can change only the worker's own text:
- `workflow` (its steps)
- `knowledge`
- `limitations` (its hard limits)
- `onMissing`
- `outcomes` (schema 2)

Each changed field is given in full.

It can **never** change:
- tools or core capabilities;
- integrations or their settings;
- requirements;
- repository access;
- name, mission or specialization.

Those decide access or identity, and stay the person's edits in the editor. A proposal that names one of them is refused with a reason.

Its `uses` (the capabilities a procedure relies on) must be the worker's own. Anything it would need and doesn't have — an account, a connector, an API the tools don't support — goes under `needs`, and is shown as "Not possible with its tools".

## Checks and trial runs

A check is data from a fixed vocabulary, graded by console code (`worker-ui/evolve.mjs`):
- **`builder_entry`:** entries of a Builder model, matched by name (a regular expression) or url.
  - Only entries created or changed during the trial run count.
  - Options: how many there are, publication state, and data fields (a regular expression each, or `{ absent: true }`).
  - The console reads Builder itself, with its own credentials and fresh reads.
- **`tool_called`:** the trial run called this tool, and the call succeeded (at least `min` times).

**A trial run is a real run of the proposed definition:**
- it's marked as a trial in the run and its snapshot;
- it has no evolve tools;
- its `REMEMBER:` lines are ignored;
- it never changes the worker.

**A baseline trial** runs the worker as it is on the same task, so the person can compare. A check that fails on the current version and passes on the proposed one shows the change caused the behaviour.

**The checks are written by the worker.** The person reviews them with the change. Passing them shows the behaviour *on that task, in that environment*, not in general.

## Versions

Every write to a worker records `workers/<id>/history/v<N>.json`:
- `{ version, parent, savedAt, source, reason, definition }`;
- **sources:** create, edit, proposal (with the verification at approval), restore, upgrade, migration, import, clone, repository-removed, before-history.

**Rules:**
- **Numbers are never reused.** A recorded version is never overwritten.
- **Restore** makes an old version's definition the next version. It goes through the same checks as any save.
- **Run snapshots** record the version a run used (`meta.worker.version`, `runs/<id>.worker.json`). Resumes keep it.

**Integrity check.** A worker whose stored definition doesn't match the history file of its version was changed outside the console. It isn't run, and its editor says so; saving it in the editor records it.

## The pieces

**`mcp/evolve-server.mjs`:** the worker's two tools.
- **`evolve_read_self`:** its own text, version, tools and integrations, and its open proposals.
- **`evolve_propose`:** submit a proposal.
- **Where it's loaded:** for every defined worker, in Work and Inspect, but not in trial runs.
- **What it can reach:** the console only, at `/evolve/<run>/self|propose`, with the run's token, about the run's own worker, while the run is active.
- **What it can't do:** approve, edit, try or grade anything.

**`worker-ui/server.mjs`:**
- proposals storage, versions and the integrity check;
- the person's routes, behind the same-origin guard:
  - `GET /workers/:id/versions`, `/versions/:n`, `/versions/:n/diff?to=`
  - `POST /workers/:id/restore`
  - `GET /workers/:id/proposals`, `/proposals/:pid`
  - `POST /workers/:id/proposals/:pid/trial|grade|recheck|approve|reject`

**`worker-ui/evolve.mjs`:** validation, diffs, the check vocabulary and grading, and the state.

**The page:** "Versions and proposed changes" in the worker's editor, and a "Proposed a change" card in the conversation.

## Security: what holds, and what doesn't

**Probed with a real worker** (`bench/evolution/boundary-probe.mjs`; the console's data and catalogue placed inside the worker's workspace, as on a default local console). Before this change:
- a worker with file tools (no shell) **could** rewrite its own definition in `workers.json`;
- it **could** edit the integration lockfile;
- it **could** write a `CLAUDE.md` that **steered its next run**.

Claude Code itself already refused `.claude/settings.json`.

**Now, on every console**, the runtime's permission rules deny every worker's file tools:
- the console's records: `*.json` and `*.md` in the data folder, plus `runs/`, `workers/`, `teams/`, `gitflow/` and `backups/`;
- the integration catalogue;
- the platform instructions;
- `.claude/`, `CLAUDE.md`, `CLAUDE.local.md` and `AGENTS.md` in a workspace.

Before this change, the data-folder rules applied only when hosted.

**Limits, stated plainly:**
- **A worker with shell (node, curl) runs code as the person's OS user.**
  - It isn't held by file permission rules.
  - It can call the console's API with forged headers. The request guard stops browsers (CSRF), not local programs; probed: a forged `PUT /workers/<id>` from a local process succeeds.
  - It can do anything the person can, including editing a definition and its history file consistently.
  - The integrity check catches a definition edited outside the console without a matching history file. It isn't a boundary against deliberate code.
  - In the probe, the model **refused** to run the forged commands. That's judgement, not enforcement.
- **Hosted:**
  - there's no shell;
  - every request must carry the gateway's secret;
  - the person's credentials are unreadable by workers.

  So a worker can't reach the person's endpoints there.
- **The evolve endpoints prove which run is asking**, by its token, but not which person approves. Locally the console has one person; hosted, the gateway signs the person in.
- **A worker can write a workspace's ordinary files.** Those are its work product, reviewed through Git (Versions). A repository's own `.claude/`, `CLAUDE.md` and `AGENTS.md` are now off-limits to workers, so a person edits them.

## What isn't built
- Proposals made by the person, Team-level proposals, and merging a stale proposal onto a newer version (the worker proposes again).
- Model-graded or human-rubric checks, and check types other than `builder_entry` and `tool_called`.
- Executable changes. A proposal is text and data; code that a worker needs is platform work (an integration version), or the customer's own repository.
- Native Builder A/B testing. The adapter writes an entry's `name`, `data`, url query and `meta.breakpoints` only (`builder-adapter/builder.mjs`), not its `variations`. A worker asked for it reports it as not possible.

## Tests
- `node bench/integrations/evolve-test.mjs`, deterministic (stand-in Claude, mock Builder):
  - versions, restore and integrity;
  - the evolve tools' boundaries;
  - refused proposals;
  - trial runs and memory;
  - grading (including a `data.variations` impostor);
  - approval, stale proposals, and the next run's version.
- `node bench/evolution/ui-test.mjs`: the page (proposal card, approval acknowledgement, versions, compare, restore).
- `node bench/evolution/boundary-probe.mjs`: a real worker probing the boundary. Needs a signed-in Claude config (`WORKER_CONSOLE_CLAUDE_CONFIG_DIR`).
- `node bench/evolution/builder-evolution-test.mjs`: the end-to-end proof with the real worker, the real model and the Builder test space, checked with raw Builder reads. It needs the same.
