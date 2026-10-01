# Workspace UI: workflow and fidelity check (2026-10-01)

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

**Drawn but not interactive**, because no behaviour is defined for them: ⌘K, the bell, the gear, the avatar, the sliders icon, "+ attach" and "Docs & Reference".

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
  - Executor (this app's own folder) can't be removed.
  - A workspace with a running worker can't be removed until the run is stopped or ended.
- **Reorder:** drag a workspace, or press Alt+↑/↓ on a focused one. The order is saved to `workspaces.json` via `POST /workspaces/order`; Executor's position is kept as an `{ "id": "console" }` marker.

`manage-test.mjs`: **7/7 passed** (`manage-results.json`):
1. The starting order was Executor, Canary, Work test.
2. Work test was dragged above Executor, and the order was the same after a reload and in `workspaces.json`.
3. Alt+↓ moved Work test down one place, focus stayed on it, and the order persisted.
4. Executor showed no × and the API refused to remove it.
5. Remove → Cancel kept Canary; Remove → Remove took it off the list and selection fell back to Executor. The folder still exists with the same 80 entries.
6. Removing Work test while its worker was waiting was refused. After End run it was removed, resuming its run was refused ("No workspace"), and the folder still had the same 5 entries.
7. A foreign Origin was refused (403) for both remove and reorder; a bad order and an unknown id were refused.

`workflow-test.mjs` still passes **12/12** on the same build.
