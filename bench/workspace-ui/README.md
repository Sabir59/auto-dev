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

**Drawn but not interactive**, because no behaviour is defined for them: ⌘K, the bell, the gear, the avatar, the sliders icon and "Docs & Reference". ("+ attach" is now live: see Attachments below.)

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
