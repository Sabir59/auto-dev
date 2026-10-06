# Workspace UI: workflow and fidelity check (2026-10-01)

**Running the suites:** `bash bench/workspace-ui/run-suite.sh <workflow|manage|sync|attach|versions|mentions|workers|designer|teams>` (Git Bash on Windows).
- It starts its own test console on port 8797 with a fresh data dir and an empty Figma Reader dir.
- It builds the disposable fixtures with `fixtures.mjs` under `%TEMP%wsui`. They use canary values only; no real secrets.
- The Teams suite reads the real MATW repository (`MATW_SRC`) to make a local clone. Nothing is ever written to the real repository.
- The real worker runs, so suites take minutes and use the Claude subscription.

Project overview: `docs/PROJECT_HANDOFF.md`.

The Workspace page (`worker-ui/workspace.html`, served at `/` by `worker-ui/server.mjs`) is the Stitch design from the Figma file "Test Scripter" (page Main, frame `12038:273`), built as a working front end for the existing Worker Console. The old console page is still at `/console`.

## What the page does, and what it's connected to

| In the design | Connected to |
|---|---|
| Workspaces list, header switcher, "+ Add workspace" | `GET/POST /workspaces`: name, folder, Inspect or Work (the hardened `inspect` / `full` profiles). Branch and commit come from the folder's own `.git`. |
| Chat and composer | `POST /runs`, `POST /runs/:id/message` (live follow-up, or resume in a new process), `/stop`, `/end`, and the SSE `/events` stream |
| Execution & Telemetry | the run's real events: tool calls paired with their results by `ref` (status and duration), PLAN/OBSERVATION/…/DONE lines, artifacts, turn summaries |
| Favourites | the existing prompt library (`/prompts`): save from the composer, click to fill, remove |
| Recent runs | the existing run history, filtered to the selected workspace; click to reopen and continue |
| (not in the design) Files | `GET /tree`, plus a read-only viewer over `GET /file?workspace=` or `?run=` |

**Sample data replaced with real data:** names, branches and commits; "Local console :8799"; the folder path and mode instead of "2,418 files indexed • AST… • Git sync"; the mode description instead of "Auto-checkpointing…"; "local" instead of "v1.4.2".

**Left out:**
- the three suggestion cards, which were sample MATW tasks;
- "Worker Engine v3" (model selection is out of scope); its place shows the access mode.

**Drawn but not interactive** at first: ⌘K, the bell, the gear, the avatar, the sliders icon and "Docs & Reference". These were removed later; see "Cleanup" below. "+ attach" became live; see Attachments.

**Added only where the function needed it:**
- the send button turns into Stop while the worker is busy;
- "End run" appears while the worker waits for you;
- "☆ Save" in the composer;
- a Files section and the viewer;
- toggles for the side panels on narrow windows.

## Workflow test: `workflow-test.mjs`, real worker, all through the UI

Against a second console (port 8797, its own data dir) and two disposable folders. **12/12 passed** (`results.json`):

1. Added an Inspect workspace through the form. The new workspace was selected, with the Inspect badge and tag.
2. The form refused a missing folder and `C:\`. API checks separately refused the home folder, UNC and relative paths, a file, a duplicate folder, a bad mode, a foreign Origin and a missing header.
3. Added a Work workspace.
4. The Files tree listed the workspace and left out the junction that points outside it (`jdir`). README.md opened read-only.
5. A hostile `evil.html` (which tries to `POST /runs`) was shown as text. Opened directly, `/file` served it with `Content-Security-Policy: sandbox`, and no run was created.
6. Started a run. The stream showed LIVE, the send button became Stop, and the "Read" tool card turned "Success · 70ms". The DONE result appeared in the chat.
7. A follow-up was answered in the same process ("Worker started" appears once).
8. Saved a favourite, clicked it to fill the composer, then removed it.
9. End run: the status became Finished, and the run appeared under Recent runs.
10. Reloaded, reopened the run from Recent runs (4 messages replayed) and continued it. It resumed in a new process and remembered the first message.
11. Stopped a busy run with the send button: Stopped.
12. In the Work workspace the worker wrote `notes/summary.md`. It appeared as an Artifact card, opened in the viewer, and matched the file on disk.

The only browser console errors were the two expected 400 responses from the refused form submissions.

**New endpoints vs. path tricks** (`/file?workspace=` and `/tree`): `..` in four forms, the junction in three forms, the sibling-prefix folder, absolute, UNC and `%2e%2e` paths all returned 404 on both. `/tree` on `jdir`, `..`, `../..` and `src/../..` also returned 404.

## Fidelity check

`shots/design-difference.png` is the design export, aligned (it carries an 8px shadow margin), blended in difference mode with the live page at 1280×1008. Fixed layout cancels to black. What lights up is different content (real data versus the design's samples) and the omitted cards.

Measured boxes match the design to ±1px for:
- header, logo, title;
- side panels, section labels, workspace rows, add button;
- footers, context header;
- composer box, textarea, utility row, attach, badges, send, footnote;
- activity header and footer, empty-state icon and title.

Pills differ only in width, because real text replaces the sample text. The design's small labels render in Geist Mono: the Figma import fell back to "Liberation Serif" for an unmapped mono font, at the mono metrics (11/14, +0.44px).

## Browse for the workspace folder (2026-10-01)

"Folder" in Add workspace now has a **Browse** button. A web page can't learn a folder's real path, so the button asks the console (`POST /pick-folder`, same-origin only) to open the standard Windows "Select Folder" dialog on this computer (`worker-ui/pick-folder.ps1`).

- Only the chosen path comes back. It fills the Folder field, and the Name field if that is empty.
- Nothing is read from the folder, copied or uploaded.
- **Cancel** leaves the form as it was.
- The path then goes through the same `POST /workspaces` checks as a typed one.

`browse-test.mjs` drives the page with Playwright and the **real** dialog with `dialog-driver.ps1` (UI Automation to find the controls, their own window messages to type and click; no mouse). **9/9 passed** (`browse-results.json`):

1. **Browse → MATW project:** the path and name were filled in.
2. **Browse → Cancel:** the form was unchanged, with no error.
3. **Browse → `C:\`, then Add:** refused ("too broad").
4. **Browse → home folder, then Add:** refused.
5. **Typed paths:** a missing folder, a file and a UNC path were each refused with their own message.
6. **Browse → MATW, then Add (Inspect):** the workspace was selected, with its branch `dev-main`.
7. **Duplicates:** browsing to MATW again was refused, and so was browsing to this repo (already Executor).
8. **The Browse-added workspace runs:** an Inspect worker was bound to the real MATW root, its Glob calls succeeded, and it ended Finished.
9. **Foreign origin:** `POST /pick-folder` returned 403 and no dialog opened; `GET` returned 404.

The full workflow suite (`workflow-test.mjs`) still passes **12/12** on the same build.

## Remove and reorder workspaces (2026-10-01)

- **Remove:** hover a workspace and press ×, then Remove in the inline confirm ("The folder and its files stay on disk").
  - It only takes the workspace off the list (`DELETE /workspaces/:id`).
  - The workspace's runs stay in history but can't be resumed or browsed: the binding check refuses them.
  - Executor (this app's own folder) can be removed too; that only hides it, and adding the folder again brings it back with its runs (see below).
  - A workspace with a running worker can't be removed until the run is stopped or ended.
- **Reorder:** drag a workspace, or press Alt+↑/↓ on a focused one. The order is saved to `workspaces.json` via `POST /workspaces/order`; Executor's position is kept as an `{ "id": "console" }` marker.

`manage-test.mjs`: **7/7 passed** (`manage-results.json`):
1. The starting order was Executor, Canary, Work test.
2. Work test was dragged above Executor, and the order was the same after a reload and in `workspaces.json`.
3. Alt+↓ moved Work test down one place, focus stayed on it, and the order persisted.
4. Executor has a × as well (since the sync change below; it was protected before).
5. Remove → Cancel kept Canary; Remove → Remove took it off the list and selection fell back to Executor. The folder still exists with the same 80 entries.
6. Removing Work test while its worker was waiting was refused. After End run it was removed, resuming its run was refused ("No workspace"), and the folder still had the same 5 entries.
7. A foreign Origin was refused (403) for both remove and reorder; a bad order and an unknown id were refused.

`workflow-test.mjs` still passes **12/12** on the same build.

## Attachments (2026-10-01)

The composer's **+** now attaches files to a message, as do **paste** (e.g. a screenshot) and **drop** onto the prompt box. Attachments show as chips that can be removed before sending.

- **Supported:** images (PNG, JPG, GIF, WebP, up to 5 MB each), PDFs (up to 10 MB) and text/code files (up to 300 KB). At most 10 per message, 25 MB together.
- **How they reach the worker:** inside the message itself, as image, document and text content blocks in Claude Code's stream-json input, so they also stay in a resumed session. They are **never written into the workspace**: Inspect stays read-only, and the worker doesn't need file access to see them.
- **Type checks:** the console decides the type from the bytes, not the name, and refuses anything else.
- **Stored copy:** kept in `runs/<id>.att/` (gitignored) so the conversation can show them again. It is served read-only at `GET /runs/:id/att/:file` with the sniffed content type, `Content-Security-Policy: sandbox` and `nosniff`.

`attach-test.mjs` (real worker, real browser): **10/10 passed** (`attach-results.json`):
1. "+" opened the file picker. An image, a text file, a PDF and a fourth file became chips, and × removed one.
2. On sending, the worker described the image and gave both codewords: MARIGOLD from the text file and OSPREY from the PDF.
3. The conversation showed the image preview and two file chips. Each copy was served with its real type (`image/png`, `text/plain`, `application/pdf`) and the sandbox policy.
4. A pasted image was sent in a follow-up, and the worker answered "Blue" about the arrow.
5. Dropping a file onto the prompt box added a chip.
6. After End and a reload, reopening the run from Recent runs still showed the previews. Resuming with a new attached file worked: it answered LANTERN.
7. In the page, a binary file was refused as "can't be attached" and a 6 MB image as "too large".
8. The server refused on its own: a binary, 11 files, an oversized image, and an executable renamed `photo.png`. A foreign Origin got 403, and no run was created.
9. Path tricks on `/att/` (`..%2F..%2Fserver.mjs`, backslashes, an unknown file) returned 404. `/att/..` collapses to `/runs/:id`, the run's own public metadata, not a file.
10. The workspace had 11 files with the same hashes before and after: nothing was written into it.

`workflow-test.mjs` still passes **12/12** on the same build.

## Executor removable, pages kept in sync (2026-10-02)

**The reported bug:** an open page could keep an old workspace list after the list changed in another tab (VS Code's browser and Chrome were both open). It then showed Executor without its selection mark, "no runs", and the Files of a workspace that list no longer showed. A fresh load was always correct, and no single-tab sequence of add, remove, re-add, drag, Alt+arrow and cancel reproduced it.

**The fix:** each page re-reads `/workspaces` with its 4-second refresh, on focus and when the tab becomes visible. If its selected workspace is gone, it falls back to the first one, or to an empty "No workspace" state. A run whose workspace was removed can still be read, but the page doesn't switch to that workspace.

**Executor can be removed.** Removing it hides it (`{ "id": "console", "hidden": true }`). Its runs can't be resumed while it is hidden. Adding this app's folder again restores Executor in its old place, with its runs.

`sync-test.mjs`, two tabs in one browser profile: **6/6 passed** (`sync-results.json`), and every snapshot's list, selection, runs and Files agreed with the server:
1. Executor, which has a run, was removed. Its run was hidden, and resuming it was refused.
2. The other tab, which had Executor open, corrected itself within the refresh.
3. Adding this app's folder again brought Executor back with its run, and resuming that run worked (200).
4. Tab B had Work test open when tab A removed it. B fell back with no stale selection.
5. Tab A added a workspace and reordered it, and B showed the same list.
6. With every workspace removed, the "No workspace" empty state appeared and sending was refused ("Add a workspace first", no run created). Adding Executor back restored both tabs.

`manage-test.mjs` passes 7/7 and `workflow-test.mjs` 12/12 on the same build.

## Versions and push (2026-10-02)

**Versions are the workspace's own Git history; there's no second version system.** The new **Versions** section in the sidebar lists:
- **Working copy:** "N changed", or "clean", plus "↑N" when there are commits not on the remote yet.
- **The latest commits** of this folder: a green dot when pushed, grey when only local.

Opening a version shows:
- its id, author, date and message, and the run it came from;
- the changed files with +/− lines;
- for each file, its **Changes** (diff) or the **File** as it was in that version.

Viewing is read-only: nothing is ever checked out, reset or reverted. A workspace inside a bigger repo sees and commits only its own folder.

**Commit and push happen only when you click, and only in Work workspaces.** Inspect shows versions but can't commit or push.
- **Commit:** stages this folder's changes and commits them with **your message as typed**, using your existing Git identity. It never adds a trailer. If a repo's own commit hook adds a co-author line, the Workspace says so.
- **Runs:** whose work went into the version are linked to it.
- **Push:**
  - It pushes the branch to its own remote and branch, with the credentials Git already has.
  - It uses `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never`: no prompts, no `--force`, no `-u`, and no change to the repo's config.
  - Missing login, a remote with newer commits, or an unreachable remote are each reported in plain words.
- **Where the result shows:** in the version view, and as a "Version" or "Push" card in the open run's activity panel.

**Co-author trailers:**
- The Workspace's own commits never add one.
- Workers now start with `--settings {"includeCoAuthoredBy":false,"attribution":{"commit":"","pr":""}}`, so Claude Code adds no co-author line if a worker ever commits by itself.
- The worker instructions also say not to commit or push.

**Reading Git safely:** git runs with `core.fsmonitor=false`, `--no-ext-diff` and `--no-textconv` (no repo-configured programs), with no inherited `GIT_DIR`-style variables. Versions and paths are validated (hex ids only, no `..`, absolute paths or flags).

`versions-test.mjs`: **14/14 passed** (`versions-results.json`). It used the real worker and disposable repos whose remote is a local bare repository, so nothing went to GitHub:
1. The versions list started with the working copy (clean) and the repo's commit.
2. The worker changed `src/math.js`. The working copy showed "1 changed", the file with +1, and "Changes from: <the run>".
3. The diff showed the added line, and the File tab showed the new content.
4. Committed from the Workspace: the message was exactly as typed, the author was your Git identity, and there was **no Co-authored-by**. A "Version" card appeared in the activity panel.
5. The new version was linked to the run and marked "not pushed yet".
6. The older version opened read-only and showed the file without the change. The working tree and HEAD were untouched.
7. Push worked: the bare remote now has the commit with the same message, and a "Push" card appeared.
8. Pushing again said "Nothing to push".
9. When the remote had newer commits, the push was refused with a plain message, nothing was forced, and the other commit stayed.
10. With a remote requiring login (HTTP 401), it reported "Git has no working login…" in 2 s with no prompt.
11. Inspect workspace: versions shown, no Commit or Push buttons, and the API refused to commit.
12. A plain folder showed "Not a Git repository".
13. A foreign Origin got 403 for commit and push. Bad revisions, a flag passed as a revision, and `..` paths were refused.
14. Plain Claude Code committed with `Co-Authored-By: Claude …`. With the Workspace's worker settings, the same request committed with **no trailer**.

On the same build, `workflow-test.mjs` passes 12/12, `manage-test.mjs` 7/7, `sync-test.mjs` 6/6 and `attach-test.mjs` 10/10. The Browse test wasn't re-run, because it opens real folder dialogs and its code didn't change.

## Cleanup: UI with no purpose removed (2026-10-02)

The principle is to build from real use, not to fill a design. Elements that did nothing, or only repeated what's already shown, are gone. Nothing replaced them:

| Removed | Where | Why |
|---|---|---|
| ⌘K badge | header | There is no command palette. |
| Bell | header | There are no notifications. |
| Gear | header | There are no settings. |
| Avatar | header | There are no accounts. |
| Sliders icon | centre header, next to the run status | No settings or filter behind it. |
| "Docs & Reference" and its icon | bottom of the sidebar | There are no docs to open. |
| "↵" glyph | composer | Looked like a button but did nothing. Enter-to-send is unchanged. |
| "Runs locally via console port …" | composer footnote | Repeated the sidebar's "Local console :port". The spot now only shows notices. |

Their styles and icon paths (bell, gear, person, docs, and the unused arrow-right from the omitted suggestion cards) are removed too. `shots/design-difference.png` predates this cleanup.

Every suite still passes on this build:
- `workflow-test.mjs`: 12/12
- `manage-test.mjs`: 7/7
- `sync-test.mjs`: 6/6
- `attach-test.mjs`: 10/10
- `versions-test.mjs`: 14/14

## Workers: defined, specialised workers on the same runtime (2026-10-02)

Design: `docs/worker-platform.md`.

**What a worker is:** a definition plus memory. The definition holds:
- name, mission, specialization;
- capabilities (real tools);
- workflow steps, knowledge, hard limits;
- requirements (`{resource, access, need}`);
- how to ask when something is missing.

**How a run uses it:**
- When a run starts, the console snapshots the definition: the generated context (`runs/<id>.worker.md`), the tool set, and the requirement statuses checked right then.
- It passes them to the same `claude.exe` runtime.
- The workspace's profile stays the security boundary. A worker can only narrow it.
- "General" is the worker with no definition, and behaves exactly as before.

**UI:**
- A **Workers** section in the sidebar: select one for new chats, see "N missing", or define it with the sliders icon.
- **The editor** sits in the centre panel, and every field reaches the run.
- **The composer** shows the worker.
- **New activity cards:** Worker, Requirements, Needs access, Remembered.

**New pieces:**
- `figma.read` maps to the new **Figma Reader MCP server** (`mcp/reader-server.mjs`). It reads a design from a URL through the REST API, with the person's Figma authorization, and refuses without it.
- `NEEDS:` lines become "needs" events, for future channels to act on.
- `REMEMBER:` lines go to that worker's memory (`workers/<id>.memory.json`). Anything that looks like a secret is refused.

`workers-test.mjs`: **12/12 passed** (`workers-results.json`), using the real worker in a real browser:
1. **Defined in the UI and saved:** a Figma Specialist with 3 capabilities, a 4-step workflow, knowledge, 2 limits and a required "Figma: read designs". The sidebar showed "1 missing".
2. **Missing requirement:** run with a Figma link and no authorization. The cards showed Worker v1 → Requirements 0/1 → Figma access check → **Needs access**, and the chat showed "Needs: …". It used only its allowed tools, never looked for another way in, and never claimed to have seen the design.
3. **The definition reached the runtime:**
   - the run's context held the mission, the numbered workflow, the knowledge, the limits, and "Figma: read designs: REQUIRED, NOT AVAILABLE";
   - its tools were exactly Read, Glob, Grep and ToolSearch, plus the two Figma Reader tools;
   - Write was blocked in Inspect.
4. **It answered as itself:** "I'm the Figma Specialist…", and it knew the 8px grid.
5. **A hard limit held:** asked to show `.env`, it made no tool calls, refused, and no canary value appeared. (Inspect itself would allow that read.)
6. **Memory:** "prefers British English spelling" was remembered. A `REMEMBER: api_key = figd_…` line was not stored.
7. **Memory carried over:** a new run of the worker knew the preference, its Worker card said "1 remembered item", and its context held the memory.
8. **Capabilities narrow, they don't widen:** in a Work workspace the same worker got Write and Edit, still had no browser, and loaded only the figma-reader server.
9. **Editing:** v2 was saved in the UI. The old run kept v1 (its meta, and its context file unchanged byte for byte), and resuming it still used v1. A new run started as "Figma Specialist (v2)" with the new mission.
10. **Rejected authorization:** with an invalid token stored, the status and the run's Requirements card said "Authorization rejected". The worker checked, reported it, and asked to reconnect.
11. **Deleting:** the worker left the list and its memory was cleared. Its earlier run still opens, with its name.
12. **Guarded and validated:**
    - a foreign Origin got 403;
    - an unknown capability or requirement was refused;
    - an empty name was refused;
    - a run naming an unknown worker was refused.

On the same build, `workflow-test.mjs` passes 12/12, `manage-test.mjs` 7/7, `sync-test.mjs` 6/6, `attach-test.mjs` 10/10 and `versions-test.mjs` 14/14.

**Prepared, not yet proven with a real Figma account:** the "authorized" path, where a valid credential leads to `figma_read_design` returning the outline and render. It needs a real Figma token (see `figma-reader/README.md`).

## Worker: Senior UI/UX Design Engineer (2026-10-06)

The definition lives in `workers/senior-uiux-design-engineer.json`. It's created through `POST /workers`, like any worker.
- **Capabilities:** read files, read and change the open Figma file (plugin), read Figma designs from a link, browser.
- **Requirements:** Figma edit (plugin connected) is required; Figma read by link is optional.
- **Context:** its brief, the Mode A/B workflow and the design → execute → inspect → critique → refine loop, the design principles (including WCAG 2.2 AA numbers), the hard limits, and the summary format.

**Platform changes it needed:**
- **Seeing its own renders:** workers with Figma plugin or browser capabilities may read the adapters' own exports folders (`--add-dir exports`, `browser-adapter/exports`), and nothing else outside their workspace. Without this a worker in another workspace couldn't see its own renders.
- **Workflow steps** may be up to 600 characters.

`designer-worker-test.mjs`: **4/4 passed** (`designer-worker-results.json`):
1. Created from its file, with knowledge, workflow and limits unchanged.
2. Access checked first. The Figma plugin was really connected to an open file (statuses: edit "Connected", read-by-link "Not connected"). Asked only to check access, it made 0 edit calls.
3. The run's context holds the mission, the Mode A/B workflow, the inspect loop, "4.5:1", the limits and the summary headings. The tools add read access to both exports folders.
4. Working in another workspace, it opened a render from the Figma exports folder (Read returned an image) and described it correctly.

**Note:** an earlier version of step 2 sent the worker a redesign request ("Redesign the onboarding screen…") while a real Figma file, "trekking hiking", was open.
- **What it did:** it used only read tools, found no onboarding screen, changed nothing and said so.
- **The fix:** the step is now an explicitly read-only access check.

## "No folder" (2026-10-06)

**The problem:** a Figma design job has no project folder, yet the Workspace demanded one. With every folder removed it showed "No workspace", and nothing could run.

**The fix:** a built-in **No folder** workspace is now always first in the list. It can't be removed or dragged.
- **Where it runs:** in a private, console-owned scratch folder (`<data>/scratch`, gitignored), with the Work profile. The worker's own capabilities still decide its tools.
- **What the work targets:** a Figma worker works on whatever file the Figma plugin has open.
- **The page:** says "No project folder", and Versions says the same.

**Tests updated:**
- `manage-test.mjs` (7/7) ignores the fixed row when checking order.
- `sync-test.mjs` (6/6): with every folder removed, "No folder" stays selected, has no remove button, and the API refuses to remove it (400). A tab sitting on "No folder" stays there when a folder comes back.

The Senior UI/UX Design Engineer in "No folder" gets every capability, including Figma edit.

On the same build: workflow 12/12, attach 10/10, versions 14/14, workers 12/12.

## @ file mentions (2026-10-06)

Type `@` in the composer to pick files from the **selected workspace**. Each pick goes to the worker as a workspace-relative reference: a path, never the file's contents. The worker reads the file itself with its own tools, so its profile (Inspect/Work) still applies.

**Picking:**
- **Where it searches:** the list comes from the server, so the browser never sees anything outside the workspace.
  - In a Git repository it starts from Git's view (tracked plus untracked files), then adds the files `.gitignore` hides, such as a `docs/` folder kept out of the repo. They're still the person's files.
  - Dependency and build folders (`node_modules`, `dist`, `build`, `out`, `.next`, `.vercel`, …) are always left out, ignored or not.
  - Outside a repository it walks the folder, skipping `.git` and the same folders, and doesn't follow links.
  - Every entry passes the file viewer's real-path containment, so a file or folder that links out (a junction or symlink) is left out.
- **What it lists:** an empty `@` shows recent files. Text matches the file name first, then the path. `dir/` lists that folder, from the root or at any depth. No match shows "No matching files".
- **Keyboard and mouse:** ↑/↓ move, Enter or Tab picks, Escape closes (for that `@`), and a click picks. An `@` works mid-sentence, and a message can carry several mentions.
- **Speed:** the index is built once and cached for 15 s, so typing doesn't rescan. It's capped at 20,000 files.

**Sending:**
- The mentions still present in the text go with the message as `mentions: [{type: "file", path}]`, in the order they're written.
- **The server re-checks each one** against the run's own workspace and refuses:
  - absolute, drive, UNC and `..` paths, and paths starting with `-`;
  - anything that resolves outside, such as a junction;
  - folders;
  - more than 20 mentions.
- **Missing files:** a file that no longer exists is passed on as missing. The worker is told, and the conversation strikes the mention through.
- **What the worker gets:** a `<file_references>` list appended to the message.
- **Changing workspace:** a mention is tied to the workspace it was picked in. If the workspace changes before sending, it's refused ("picked in another workspace"), never quietly re-read in the new one.
- **In the conversation:** mentions read as links that open the file read-only, from that run's workspace.

**Found while testing, and fixed:**
- **What the runtime did:** Claude Code expands `@path` in message text into the file's contents before the model sees it.
  - That defeated "references, not contents": the worker answered without reading anything.
  - In a **Work** workspace it also read in files **outside** the workspace. A hand-typed `@C:\…\outside\Header.tsx` or `@../outside/Header.tsx` put the outside canary's contents into the worker's context. Inspect didn't.
  - The only switch that turns this off (`CLAUDE_CODE_DISABLE_ATTACHMENTS`) is internal and also disables deferred tools and project instructions, so it isn't used.
- **The console's fix:** before text goes to the worker, every `@token` the runtime could read is wrapped in backticks, which the runtime leaves alone. That means a path that exists from the workspace, or any absolute, drive, UNC, `~` or `..` path.
  - This covers attached text files too.
  - Other `@` text is unchanged: emails, `@media`, `@property`, and package names that aren't files.
  - The person's message is shown exactly as typed.

`mentions-test.mjs`: **15/15 passed** (`mentions-results.json`). It builds its own fixtures: a Git app with three `Header.tsx` files, untracked `node_modules`, an ignored `dist`, and a junction to an outside folder holding a canary. It also uses a 21,300-file plain folder and the Canary Inspect repo.
1. `@` lists the Mention app's files, including `notes/plan.md` and `notes/deep/idea.md`, which `.gitignore` hides. Nothing from `node_modules`, `dist` or a junction out is listed, including a junction that `.gitignore` hides. (Canary's `jdir/*`, which Git lists through its junction, is also left out.)
2. Filtering: `Header` → the three `Header.tsx` files; `layout/App` → `AppLayout.tsx`; `src/layout/` → that folder; `zzqx` → "No matching files".
3. Keyboard: ↓↓↑ selects the second row, Enter inserts it without sending, Escape keeps that `@` closed, a new `@` reopens, and Tab picks.
4. Mouse, mid-sentence (`Look at @src/pages/Header.tsx  please`), and two mentions in one message.
5. Send:
   - the request carries two `{type: "file", path}` references and no contents;
   - the worker's transcript shows the `<file_references>` block and **no runtime-inlined files**;
   - the worker made its own `Read` calls for both files and returned both codewords.
6. Mentions render as links, and one opens the file read-only.
7. A file deleted after it was picked: sent as missing, struck through, and the worker checked and answered "No".
8. An attachment plus a mention whose path has a space (`docs/release notes.md`): both codewords came back.
9. In Work, a hand-typed absolute, `../` and junction `@path` were not read in: no file attachments, and the outside canary never reached the worker. The message is shown as typed.
10. A mention picked in Mention app, then the workspace switched to Canary: send refused, no run started. A new `@` lists Canary's files.
11. Inspect: a mention works; the run is `inspect` with built-in tools Glob, Grep, Read and ToolSearch (no Write, Edit or Bash).
12. "No folder": `@` shows its own empty folder ("No matching files").
13. The API refuses (400), with no run started and no message reaching a run:
    - `../`, `src/../../`, `C:\`, `C:/`, `C:win.ini`, `\host\share`, `//host/share`, `/Windows`;
    - the junction file and the junction folder;
    - a folder; `--help`; a non-file type; 21 mentions;
    - a follow-up with `../`.
14. Search returns nothing outside for `../`, `..\`, `C:\`, UNC, `linked/`, `node_modules/`, `dist/` or `.git/`. Another origin can't read `/mentions` (CORS-blocked), and a foreign Host gets 403.
15. Performance:
    - **Executor repo:** about 357 files, about 70 ms cold, about 13 ms warm.
    - **21,300-file folder:** capped at 20,000 (`truncated: true`), about 600 ms cold, 6–26 ms per keystroke.

**Note:** `@` lists what the Files tree lists, dotfiles and ignored files included (for example `.env`). The worker could already read those with its own tools in both profiles. A mention gives it no new access.

**Later (2026-10-06): files `.gitignore` hides are listed too.** In a real repo whose `.gitignore` has `/docs`, `docs/` showed only the 3 committed files. It now shows all 33, nested folders included, and dependency/build folders still stay out. That repo (3,820 files) indexes in about 0.4 s, then about 1–3 ms per keystroke.

## Teams (2026-10-06)

A Team is shared context and scope for several workers. The design is in `docs/team-platform.md`.
- **What it holds:** workers, knowledge (workspace-file references and uploads), resources (workspace, Figma file), enforced policies, instructions, requirements, Team prompts, and versions.
- **How it runs:** a Team run is the member worker's normal run, in the Team's workspace, with the Team's context added before the worker's own.
- **What it can't do:** add access. It can only take tools away.

`teams-test.mjs`: **19/19 passed** (`teams-results.json`). It uses the real worker and a real browser.

**The fixture is a copy of the real MATW repository:**
- a shallow, sparse clone of `sabir-uat` and `prod-main`, with code but no images;
- MATW's own `docs/` folder;
- `origin` pointed at a local bare repo.

The real repository is only read: cloned from, and checked with `git ls-remote`.

**The steps:**
1. **The MATW Team is created in the UI:**
   - Frontend Engineer, Senior UI/UX Design Engineer and QA Engineer;
   - the MATW Frontend workspace (Work), and a Figma link;
   - `@docs/universal/ARCHITECTURE.md`, `@docs/platform-contract.md` and `@docs/ddfoa.md` added through the workspace file search;
   - two uploads (a business-context note and a PDF);
   - `prod-main` protected, three instructions, Figma read and GitHub requirements, and two Team prompts.

   The summary shows the saved counts and live requirement states.
2. After a reload the Team is still there, and everything reopens as saved. The upload is served back read-only.
3. Edits made the versions shown as 3, 2, 1:
   - add the Research worker, and remove a reference and an upload (v2);
   - add them back (v3).
4. The page shows the protected branch as ENFORCED and the instructions as INSTRUCTION. The API refuses `{type: "follow_ddfoa"}`: "can't be enforced… add it as an instruction".
5. **Team prompts:**
   - they appear only in the Team's own sidebar section, and Use fills the composer;
   - a global favourite saved with ☆ lands in Favourites;
   - another Team shows only its own prompt.
6. **The Frontend Engineer runs through the Team** (Chat on the Team page):
   - the request carries `team` and `worker`, but no workspace and no mentions;
   - the context order is Workspace → Team → instructions → knowledge → resources → "You are";
   - the worker answered "prod-main… the platform enforces this", the three instructions, the uploaded document's codeword and "UMDA Protocol", which it read from the real `ARCHITECTURE.md` with its own Read calls;
   - its tools include Write but not Bash;
   - the Team and Enforced policy cards are shown.
7. **The worker attacked the protection, as an authorised test.** Its search for a shell tool returned "No matching deferred tools found". Both Write attempts (`.git/refs/heads/prod-main`, `.claude/settings.local.json`) were refused by the runtime: "denied by your permission settings". `prod-main` was unchanged, and the refused writes aren't listed as artifacts.
8. **The console's Git layer:**
   - a commit while HEAD is `prod-main` is refused;
   - a push to `prod-main` (as `sabir-uat`'s upstream) is refused, and the bare remote stays empty;
   - the Versions view says "Pushing goes to origin/prod-main, which the MATW Team protects", with no push button.
9. On a small full repo with `prod-main` checked out, the Versions view has no commit box and no push button, and says why.
10. With `prod-main` checked out, a Team run's built-in tools are only Glob, Grep, Read and ToolSearch, and its context says why.
11. **The policy covers the repository:**
    - a General worker run there has no Bash, and shows the policy card;
    - a workspace on a sub-folder of the clone reports the protection too.
12. **Versions:**
    - after adding "British English" (v4), a new run lists four instructions;
    - continuing the v3 run lists three. Its context file is byte-identical, and its snapshot still says v3.
13. **Figma, through the worker:**
    - `figma_read_design` refused another file's link ("may only read the Team's Figma file");
    - the Team's own link without authorization made the worker write `NEEDS:`;
    - requirements showed "Figma: read designs (Team): Not connected".
14. **Figma Executor lock, with a fake bridge and no real Figma:**
    - while another file is open, `figma_delete_node` is refused, and the bridge saw only GET_FILE_INFO;
    - with the Team's file open it goes through;
    - without a Team nothing changes;
    - the Reader refuses another file's link.
15. **An Inspect Team stays Inspect.** Its run's built-in tools are only Glob, Grep, Read and ToolSearch, although the Frontend Engineer defines write and shell. Team knowledge refuses `../`, absolute, `C:x`, UNC, a junction out, a folder, and a file from another workspace. A Team run in another workspace, or with a non-member worker, is refused.
16. Choosing another workspace leaves the Team. Removing QA from the Team (v5) refuses new QA runs, and the old run still shows v3.
17. **Deleting a Team in the UI:** it's gone after a reload, its folder is removed, and its run still opens with its Team card and snapshot.
18. **GitHub requirement on the real MATW repository (Inspect):** "Reachable" via `git ls-remote`. Nothing changed.
19. Another origin gets 403 on create, change and delete.

**Found and fixed along the way:**
- **Artifacts:** a Write the runtime refused used to be listed as an artifact. Artifacts are now registered only when the write succeeds.
- **Versions view:** committing to a branch whose upstream is protected is allowed. Only the push is refused.
