# Baseline — Figma AI Executor POC (`executor-poc-v0.1`)

**Tag:** `executor-poc-v0.1` — `git show executor-poc-v0.1` for the exact commit.
**Date:** 2026-09-29

This is the immutable snapshot of the working proof-of-concept, captured before splitting execution capabilities from transport (the MCP adapter work). If anything in that next phase breaks, `git checkout executor-poc-v0.1` returns to exactly this state.

## What this proves

An AI session (this one, via its own Claude Code subscription — not a separate API-key-based agent) can directly operate a running Figma file: inspect it, create and modify real nodes, verify results by rendering and reading them back, and correct mistakes — without a human copy-pasting scripts into Figma's Scripter console. Concretely proven, not assumed:

- File/page inspection: file identity, page list, document-state dumps (shallow or deep), node search by name/text/type.
- Node creation: frames, components, text, vectors, ellipses, instances; auto layout (direction, gap, padding, alignment, sizing modes FIXED/HUG/FILL); component variants (`combineAsVariants`).
- Modification: arbitrary property edits on existing nodes (position, size, fills, strokes, radius, effects, opacity, text, layout), reparenting.
- Real Figma mechanisms, not workarounds: Variable binding (`setBoundVariableForPaint`), team-library component import by key (`importComponentByKeyAsync`), instance detachment.
- Visual verification loop: export any node to PNG, read the rendered image back, compare against a reference, correct, re-verify.
- A full multi-app build exercise (16-screen "AI Visa Agent" product) run end-to-end through this loop, including many real bugs found and fixed through iteration (icon aspect-ratio distortion, auto-layout sizing quirks, reference-fidelity drift, etc. — see conversation history / earlier exports for detail).
- A live design-data extraction layer: reading a real, independently-authored Figma file ("Umrah & Hajj Guide") and reproducing every piece of a known-good reference design-spec export (tokens, typography, icons, components incl. variants, screens incl. all 28, prototype reactions incl. all 28, screenshots, illustration SVGs) with byte-for-byte / exact-deep-equal fidelity against that reference. See `docs/capabilities-log.md` for the full, dated record of each capability and how it was verified.

## Architecture

```
AI session (Claude Code)
   │  HTTP POST /command   { type, params }
   ▼
bridge/server.js  (Node, http+ws, port 8787)
   │  WebSocket /ws        { id, type, params }
   ▼
plugin/ui.html   (Figma plugin's iframe — network access, no document access)
   │  postMessage
   ▼
plugin/code.js   (Figma plugin's sandbox — full document API, no network access)
```

Full detail (setup steps, request/response shape, the reason for the two-process split): `docs/how-to-drive.md`.

## Current commands (`plugin/code.js` → `handlers`)

`PING`, `GET_FILE_INFO`, `LIST_PAGES`, `CREATE_PAGE`, `RENAME_PAGE`, `SWITCH_PAGE`, `GET_SELECTION`, `SEARCH_NODES`, `GET_DOCUMENT_STATE`, `GET_VARIABLES`, `GET_STYLES`, `GET_ICON_COMPONENTS`, `GET_COMPONENT_TREE`, `GET_SCREEN_TREE`, `GET_PROTOTYPE`, `BIND_VARIABLE_TO_FILL`, `IMPORT_COMPONENT_BY_KEY`, `CREATE_FRAME`, `CREATE_COMPONENT`, `CREATE_TEXT`, `CREATE_VECTOR`, `CREATE_ELLIPSE`, `CREATE_INSTANCE`, `COMBINE_AS_VARIANTS`, `SET_AUTO_LAYOUT`, `MODIFY_NODE`, `DETACH_INSTANCE`, `DELETE_NODE`, `EXPORT_NODE` (PNG/JPG/SVG/PDF).

Full params for each: read `plugin/code.js` directly (the `handlers` object) — it's the source of truth, and it changes.

## How to run it

1. `node bridge/server.js` from `figma-ai-executor/` — listens on `http://localhost:8787`.
2. Open the target file in the Figma desktop app.
3. Plugins → Development → AI Executor (POC) — must be run manually once per file-open; Figma has no auto-launch API.
4. `GET http://localhost:8787/status` → `{"pluginConnected": true}` confirms the link is live.
5. `POST http://localhost:8787/command` with `{"type": "...", "params": {...}}` to drive it.

## Known limitations (real, not hedging)

- **Page-load flakiness.** The first access to a page that hasn't been visited since the plugin's sandbox last reset (which happens automatically on every `code.js` edit) sometimes fails with Figma's own "Unable to establish connection to Figma" error via both `page.loadAsync()` and `SWITCH_PAGE` (`setCurrentPageAsync`) — reliably fixed only by a human clicking that page's tab in Figma's own UI. Root cause not fully understood; not solved, just documented.
- **`ui.html` doesn't hot-reload.** Editing `code.js` reloads automatically; editing `ui.html` needs a full plugin re-run.
- **The bridge is a separate long-running process.** Editing `bridge/server.js` does nothing until that process is restarted — and `pkill -f "node server.js"` can silently fail to match it if it was started a while ago, leaving stale code running. Verify via the actual listening PID (`netstat -ano`), not the kill command's exit status.
- **One plugin connection at a time** (the bridge holds a single `pluginSocket`).
- **No auth/scoping on the bridge** — it's `localhost`-only, single-user, POC-grade by design.
- Icon SVG construction (when a Lucide icon is added to Figma from scratch) requires manual arc→bezier path conversion, since Figma's `vectorPaths` has no arc command — a real, disclosed constraint, not a bug.
- `figma.mixed` (a Symbol) shows up on several raw properties (`cornerRadius`, `strokeWeight`, fills) when a value differs across corners/sides/characters — must be explicitly guarded everywhere, it silently crashes plain template-literal interpolation otherwise.
- Prototype/style/variable reads were tested thoroughly against one real file's actual data; not yet fuzzed against exotic cases (e.g. `BOOLEAN`-type variables, multi-hop variable aliases across differently-moded collections, `AFTER_TIMEOUT`/media triggers).

## What's explicitly NOT part of this baseline

- `agent/` — an earlier, since-abandoned experiment building a *separate*, Anthropic-API-key-based tool-use loop. Built from a misunderstanding early in the project (the actual working model is this Claude Code session driving the bridge directly, not a second billed integration). Left in the repo, untouched, not exercised by anything else here.
- `intent-create-html/` — artifacts from an earlier, unrelated pixel-matching experiment (comparing an HTML mock against a screenshot), not part of the Figma Executor loop.
- `reference/umrah-app-starter/design/` — read-only example data (a known-good design-spec export) used purely to verify the extraction commands above against ground truth. Not code, not modified by the Executor.
