# UX remediation: the audit's findings UX-001 to UX-029 (2026-10-19)

> Project overview: `docs/PROJECT_HANDOFF.md`.
>
> This note records:
> - what each finding turned out to be;
> - its root cause and the fix;
> - the rules the page follows now.
>
> Changed files:
> - `worker-ui/workspace.html` (the page);
> - `worker-ui/server.mjs` (run lifecycle, results, error detail);
> - `bench/workspace-ui/remediation-test.mjs` (new) and the existing suites that read the changed UI.

## 1. Rules the page now follows

### Run state
The vocabulary is one set, and the run chip, the conversation list, the header pill and the Activity footer all use it.

The server's **status** is the lifecycle:
- `starting`
- `running`
- `waiting`
- `finished`
- `stopped`
- `failed`
- `interrupted`

While a run waits, the server's **outcome** says why. It's `meta.outcome`, also on the `status` event, and it comes from that turn's runtime result and the worker's tagged lines:

| status / outcome | Label | Meaning |
|---|---|---|
| starting | Starting | the worker process is starting |
| running | Working | it's working on your message |
| waiting / replied | Your turn | it replied; nothing is blocked |
| waiting / done | Done | it wrote a `DONE:` line |
| waiting / needs | Needs your action | it wrote a `NEEDS:` line: it can't go on without you |
| waiting / error | Turn failed | the runtime ended the turn with an error, or the worker reported a `FAILURE:` it didn't recover from (no `RECOVERY:` or `DONE:`) |
| finished | Closed | closed with "Close conversation"; send a message to continue it |
| stopped | Stopped | you stopped it |
| failed | Failed | the worker process failed |
| interrupted | Interrupted | the console restarted under it |

A compaction or handoff request isn't a turn of the task, so it keeps the previous outcome.

Logs written before the outcome existed get the same rule from their own logged events.

The run chip carries `data-status` and `data-outcome`; the suites wait on `data-status`. Green is used for Done and success only.

### One worker at a time
The console runs one worker process. Before you send something that would close another open conversation, the composer says so: "“X” in Y is still open (…). Sending here closes it; you can continue it later from Conversations. [Open it]". After sending, a notice confirms what was closed and links to it.

A **busy** conversation is never closed or stopped by another task:
- the send is refused;
- the notice links to that conversation;
- the server's refusal names it (`activeRun` in the error body).

The header pill shows the active conversation's state and workspace, and opens it.

### Counting rule
- An **action** is one tool call the worker made for a message, as listed in Activity. Loading tool schemas (ToolSearch) isn't counted.
- The per-message summary ("Worked 9.4s · 3 actions") and that message's "Reply finished" row use the same counter.
- The time is the runtime's own duration for the reply.
- Durations use one format everywhere: 240ms, 9.4s, 12s, 3m 05s.
- The Context & usage card counts **replies**, its raw details count model requests and tool calls, and Activity groups by **message**.

### Files
- **Deliverables** are the files the worker named with `ARTIFACT:` (`meta.declared`).
- **Files written** are every file it successfully wrote inside the workspace (`meta.artifacts`, as before).
- Activity has one link per file. It sits on the tool row that wrote the file. A named file with no write in this run gets its own Deliverable row.
- The conversation shows Deliverables after the reply, and other files folded ("1 other file written").
- The pinned list in Activity opens for Deliverables, and stays folded when there are only files written.

### Drafts and consequential actions
- **Worker and team pages:** they're drafts until saved. Every way out asks first with Save / Discard changes / Keep editing (Keep editing is the default). That covers the sidebar, the header, the pickers, page buttons, Escape, Alt+N and reloading the page.
- **Confirmed in a dialog, saying exactly what happens:**
  - stopping the console or the Figma bridge;
  - Clear memory;
  - Continue in a fresh session (including what happens to the text in the message box);
  - push (destination and commits).
- **Commit:** the button names the scope and branch ("Commit 2 files to main"). Enter adds a line; Ctrl+Enter commits.
- **Stop:** its own labelled button. Send is disabled while the worker works, and the message stays in the box.

## 2. Findings

Status key: **Fixed** means confirmed in the source and corrected; **Fixed (design)** means the finding was a hypothesis and was resolved with the safest coherent design (see "Remaining").

| ID | Status | Root cause | Fix (layer) | Test |
|---|---|---|---|---|
| UX-001 | Fixed | No dirty-state model; Escape and every navigation replaced the page | Dirty snapshot of the form; Save/Discard/Keep dialog; capture-phase guard on every navigation control; Escape asks; `beforeunload` (page) | remediation: 4 steps |
| UX-002 | Fixed | Process switches looked like status rows and stopped without asking | "Local services" section with a state word per service; stopping asks and names the consequence; Cancel leaves it running (page). Kept in the sidebar footer: it's the only place these exist, and they're disabled without the devctl helper | devctl: new step + every stop confirms |
| UX-003 | Fixed | The server had one post-turn state (`waiting`) for done, blocked and failed | Server records the turn outcome; page shows it everywhere (server + page) | remediation: Done / Needs / Your turn |
| UX-004 | Fixed | The page closed a waiting run silently; busy errors named no run | Notice before sending, confirmation after; busy refusal links to the run; server error carries `activeRun`; header pill opens the active run (page + server) | remediation: 2 steps |
| UX-005 | Fixed | Send became Stop in the same place | Separate Stop button; Send disabled while working; Enter keeps the text (page) | remediation; workflow, context updated |
| UX-006 | Fixed | Clicking a team entered it (workspace, worker, new chat) | Opening a team only shows it; "Work with this team" enters it; Leave team in the run header and on the team page; leaving by choosing a non-member says so (page) | remediation; teams updated |
| UX-007 | Fixed | Every write was a "deliverable"; the same file was listed three times | Server separates named deliverables from files written; one Activity link per file (server + page) | remediation |
| UX-008 | Fixed | Three counters (actions, steps, turns) and three duration formats | One counting rule and one duration format (page) | remediation |
| UX-009 | Fixed | The raw telemetry was the default view; Continue consumed the draft silently | Plain conversation-size headline with a meter against the warning point; raw numbers under Details; Figma numbers only when Figma was used; effects written next to the buttons; Continue dialog with an explicit draft choice; cost and plan limits pointed to the account panel (page; server sends the limit) | remediation; context updated |
| UX-010 | Fixed | The title was the first line of the prompt, which for a continuation is the handoff header | Continued sessions listed once (newest), titled after the original request, "N sessions"; the handoff shown as a folded card linking to the previous session (page) | remediation |
| UX-011 | Fixed | The list was filtered to the workspace without saying so | "In <workspace>" / "All workspaces" toggle (remembered per browser) (page) | remediation |
| UX-012 | Fixed | Static chips styled like buttons | Worker and workspace chips are pickers for a new task, disabled (and saying why) in an open conversation; the mode is text in the workspace chip (page) | manual check (screenshots) |
| UX-013 | Fixed | Edit was a hover-only icon | Always-visible edit button on every defined worker; "Edit worker" in the run header (page) | remediation |
| UX-014 | Fixed | One flat, unfoldable stream; pins took the space | Setup first, then one group per message (earlier ones folded); filter (All / Notes & alerts / Tool calls); foldable file pin; capped context area (page) | remediation (folding) |
| UX-015 | Fixed (design) | Workspaces sat under "Project", after what depends on it | "Workspace" group: Workspaces, then Conversations, Changes & versions and Files, all scoped to it; Prompts and Integrations follow (page) | — |
| UX-016 | Fixed | Enter committed; scope and destination were implicit; push in one click | Scope and branch on the button; textarea; Ctrl+Enter; push dialog with destination and commits (page) | remediation; versions updated |
| UX-017 | Fixed | Clear memory deleted at once | Confirmation that says it can't be undone (page) | remediation |
| UX-018 | Fixed | "End run" sounded final | "Close conversation", state "Closed", with a confirmation notice (page) | — |
| UX-019 | Fixed | Capability warnings depended on the selected workspace | "needs a Work workspace" per tool; one note for the selected Inspect workspace (page) | — |
| UX-020 | Fixed | General's heading was the workspace name | "General worker", with the workspace in the eyebrow (page) | — |
| UX-021 | Fixed | `--t4` (≈2.3:1) used for text | Text uses t1–t3 (t3 ≥ 4.7:1 on every surface); t4 raised to ≥ 3:1 and kept for non-text marks (page) | computed |
| UX-022 | Fixed | Ready/Idle/Waiting variants; green for everything | One vocabulary (above); green for Done and success; selection shown by the accent bar (page) | remediation |
| UX-023 | Fixed | One sliders icon meant "menu" and "edit" | Menu, steps (Activity) and edit icons (page) | — |
| UX-024 | Fixed | Narrow widths hid the mode; the Activity toggle showed no state | Mode stays in the workspace chip; the Activity toggle shows a dot while working or when action is needed (page) | remediation (700px) |
| UX-025 | Fixed | Markdown in titles; "☆ Save" was ambiguous | Titles stripped of markdown (on save and when shown); "Save as prompt" (page) | — |
| UX-026 | Fixed | "2 missing" didn't say what | Tooltips list the missing requirements and how to get them (page) | — |
| UX-027 | Fixed | Shortcuts were undiscoverable | "Shortcuts" in the composer footnote opens a list; `aria-keyshortcuts` on New task (page) | remediation |
| UX-028 | Fixed | Team summary pills wrapped; a bare "…" placeholder | Single-line chips; "Loading changes and versions…" (page) | — |
| UX-029 | Fixed | "Default" didn't name the model | "Default (Opus 5.5)" when the runtime's list resolves it to a named model; otherwise "Default" (page) | manual check |

Also fixed:
- **Model menu clipped (a regression in `ff8e349`):** the chip row's `overflow: hidden`, added late in the redesign, clipped the model menu.
- **Misleading placeholders:** empty form fields showed placeholders that read like saved values (an empty team description displayed "Engineering & Design Team"). They're now "e.g. …".

## 3. "No folder" → Scratch (2026-10-20)

### What it was (from the code)
- **A deliberate, built-in workspace.** It's `id: scratch`, `SCRATCH_WS` in `server.mjs`, added in `151055c` because "a Figma job has no project folder".
- **A real folder.** One shared folder, `<data>/scratch` (by default `worker-ui/scratch`, gitignored), with the Work profile: edits, plus node and curl.
- **Also the page's fallback.** It was always first in the list and can't be removed, so it was selected whenever the stored workspace disappeared, and "No workspace" could never appear.

### What happened when it was used
- **Shared files:**
  - every folderless conversation ran there: every worker, every team without a workspace, every session;
  - files stayed forever, and one conversation saw and could overwrite another's (on the owner's machine it held 94 MB of unrelated probe scripts, `before*` folders and a PDF);
  - the Files tree, `@` mentions and `/file?workspace=scratch` all read that shared folder;
  - a team in "No folder" could reference workspace files, which would be the shared folder's.
- **Location:** the folder sat inside the console's own data directory, next to `runs/`, `workers/` and `workspaces.json`.
- **Git:** none (a repository assignment and branch protection were already refused).
- **Continuity:** worked only because everything shared the one folder.

### Root cause
Folderless work was modelled as one more workspace, but its natural unit is the conversation.

The name described an absence ("No folder"), while the thing was a shared folder with no lifecycle, doing a second job as the fallback.

The use case is real and stays:
- Figma, through the plugin or the REST API;
- Builder.io content;
- browser work and research;
- Figma-only teams.

### The design
**Scratch is a mode, scoped to the conversation:**
- **New conversation:** a new, empty folder, `<data>/scratch-runs/<run id>`, created when it starts. It's kept with the conversation and outside the old shared folder.
- **Continuity:** a fresh-session continuation, manual or automatic, keeps working in its parent's folder.
- **Binding:** the run binding accepts a run's own scratch folder. Resume still refuses a session that worked anywhere else.
- **What the worker is told** (in its context): its folder started empty, is used only by this conversation, has no project files and no version control, and anything worth keeping goes in `ARTIFACT:`.
- **Files are the conversation's:**
  - the Files tree, `@` mentions and the viewer use `?run=<id>`;
  - `/tree` and `/mentions` for `workspace=scratch` return nothing, and `/file?workspace=scratch` is refused;
  - a new scratch task offers no files, and says why.
- **Teams:** a team in Scratch can only use uploaded documents, not workspace files. The server refuses workspace files, and the team page says why.
- **Git:** still none. Versions says "Scratch has no version history. Use a project folder for Git."
- **Older conversations:** runs from before this change keep `<data>/scratch`. Nothing moves, and their files still open.

**On the page:**
- **In the list:** Scratch is shown apart, above "Project folders", with "No project · a new folder per conversation". It's also apart in the header menu and the composer picker.
- **New-task screen:** explains what the conversation's folder is and isn't.
- **Not the default:** when the selected workspace is gone, the page falls back to the first project folder, and to Scratch only when there is none.

**Tests:** `remediation` suite, 6 Scratch steps:
- two conversations' folders are separate, and Scratch itself lists nothing;
- the worker's context;
- continuation keeps the folder;
- a legacy shared-folder run still opens its files;
- team and Git refusals;
- the UI's separation, explanations and fallback.

The mentions suite's Scratch step was updated to the new behaviour.

## 4. Remaining
- **Scratch folders are never cleaned up.** They stay with their conversation, and there's no delete for a conversation yet. The old shared `<data>/scratch` is left as it was, for the runs bound to it.
- **UX-015 and UX-019 were hypotheses about comprehension.** The new grouping and wording are the safest coherent design, but no user has tried them. A five-minute think-aloud session with a second developer would validate them.
- **Deliverable links show the current file.** They open the file as it is now, not as it was when written. The link's tooltip says so. Versions shows the history.
- **One worker at a time is unchanged by design.** Sending from elsewhere still closes a conversation that's only waiting, but it's announced before and confirmed after.
- **Not verified:**
  - screen readers (markup only: dialog labelling, live regions, accessible names);
  - a real touch device (hover-only controls were removed or made visible under `(hover: none)`).
