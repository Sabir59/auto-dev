# How to drive Figma from Claude Code

This repo lets this Claude Code session act directly on a running Figma file — no copy-pasting scripts into Figma's Scripter console, no separate API-key-based agent. This session *is* the operator.

## Architecture

```
Claude Code (this session)
   │  HTTP POST /command   { type, params }
   ▼
bridge/server.js  (Node, http+ws, port 8787)
   │  WebSocket /ws        { id, type, params }
   ▼
plugin/ui.html   (Figma plugin's iframe — owns the WebSocket, no document access)
   │  postMessage
   ▼
plugin/code.js   (Figma plugin's sandbox — full document API, no network access)
```

Figma plugins are split in two, and this split is why the bridge exists:
- **Sandbox** (`code.js`): full Plugin API (create/read/modify nodes), but **no network access at all**.
- **UI iframe** (`ui.html`): full browser APIs (WebSocket, `fetch`, `btoa`), but **no document access**.

They talk to each other only via `figma.ui.postMessage` / `figma.ui.onmessage`. The bridge is a tiny local Node server that turns that into something an external process (this session) can call over plain HTTP.

## One-time setup per Figma session

1. Start the bridge: `node bridge/server.js` (from `figma-ai-executor/`). Listens on `http://localhost:8787`. Through the MCP server this is automatic: the first Figma call starts it (`bridge/launcher.mjs`).
2. Open the target Figma file in the desktop app.
3. Run the plugin manually: **Plugins → Development → AI Executor (POC)**. Figma has no auto-launch API — this must be done by a human once per file-open. If Figma kills the plugin's iframe (it does this unpredictably), just re-run it from the same menu.
4. Confirm connection: `GET http://localhost:8787/status` → `{"pluginConnected": true, "sessions": [{"fileName", "fileKey", ...}]}` (or the `figma_executor_status` tool), or watch the plugin's own UI panel, which shows "connected" and logs each command.

## Sending commands

```bash
curl -s -X POST http://localhost:8787/command \
  -H "Content-Type: application/json" \
  -d '{"type":"GET_FILE_INFO","params":{}}'
```

Or from a `.mjs` script (the pattern every script in `scripts/` uses):

```js
const BRIDGE = "http://localhost:8787/command";
async function cmd(type, params = {}) {
  const res = await fetch(BRIDGE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, params }) });
  const data = await res.json();
  if (!data.ok) throw new Error(`${type} failed: ${JSON.stringify(data.error)}`);
  return data.result;
}
```

Response shape: `{ ok: true, result }` or `{ ok: false, error }`. Requests time out after 30s if the plugin doesn't answer (plugin not running, or Figma silently killed it — re-launch it).

## Command reference (`plugin/code.js` → `handlers`)

| Command | Purpose |
|---|---|
| `PING` | Liveness check |
| `GET_FILE_INFO` | File name/key, current page, root children |
| `LIST_PAGES` / `CREATE_PAGE` / `RENAME_PAGE` | Page management |
| `GET_SELECTION` | What's currently selected in the Figma UI |
| `SEARCH_NODES` | Find nodes by name/text substring and/or type, across a subtree |
| `GET_DOCUMENT_STATE` | Serialize a node (shallow or `depth`-limited recursive), or a whole page via `pageId` |
| `CREATE_FRAME` / `CREATE_COMPONENT` / `CREATE_TEXT` / `CREATE_VECTOR` / `CREATE_ELLIPSE` / `CREATE_INSTANCE` | Create nodes |
| `MODIFY_NODE` | Change properties of an existing node (fills, position, size, layout, reparent, text, etc.) |
| `SET_AUTO_LAYOUT` | Configure/enable auto layout on a frame |
| `COMBINE_AS_VARIANTS` | Merge components into a component set |
| `DETACH_INSTANCE` | Break an instance's link to its master (needed before adding children Figma otherwise forbids) |
| `IMPORT_COMPONENT_BY_KEY` | Pull a published component from a team library by key, create an instance |
| `BIND_VARIABLE_TO_FILL` | Bind a fill to a real Figma Variable (not just a resolved literal) |
| `DELETE_NODE` | Remove a node |
| `EXPORT_NODE` | Render a node to PNG; bridge writes it to `exports/<id>.png` and returns the file path |

Full params for each are in `plugin/code.js` (search the `handlers` object) — read it directly rather than trusting a paraphrase, since it gets extended over time.

## Known real constraints (learned empirically, not assumed)

- `documentAccess: "dynamic-page"` (this manifest's setting) means `figma.getNodeById()` and `node.mainComponent` throw synchronously — the async equivalents (`getNodeByIdAsync`, `getMainComponentAsync`) must be used everywhere.
- `vectorPaths` only supports `M`/`L`/`C`/`Z` — no arc (`A`) command, and needs whitespace around every command letter.
- `node.resize(w, h)` does **not** preserve aspect ratio — always compute the correct proportional target size from the node's actual bounding box first.
- Instances cannot have children added or removed at all — `detachInstance()` first.
- `appendChild` always appends at the end; use `insertIndex` (backed by `insertChild`) to control order.
- Auto-hugging frames (`primaryAxisSizingMode: "AUTO"`) do not grow to contain `layoutPositioning: "ABSOLUTE"` children — resize explicitly after adding them.
- `layoutPositioning: "ABSOLUTE"` must be set **before** `x`/`y` in the same `MODIFY_NODE` call, or Figma recomputes the flow position and discards it.

## Reload behavior when editing the Executor

The three pieces reload differently — knowing which is which avoids wasted debugging:
- **`plugin/code.js`** (the sandbox): Figma hot-reloads this automatically on save. No action needed, though the reload resets which pages are "warm" (see `SWITCH_PAGE` below).
- **`plugin/ui.html`** (the iframe): does **not** hot-reload. A `code.js`-only edit takes effect immediately, but an edit to `ui.html` needs the human to fully re-run the plugin (Plugins → Development → re-run) — just clicking a page tab isn't enough.
- **`bridge/server.js`**: a separate long-running Node process — editing it does nothing until that process is actually restarted. `pkill -f "node server.js"` can silently fail to match the real Windows process if it was started a while ago (e.g. via `nohup … &` in an earlier shell), leaving the *old* code running underneath an apparently-successful "restart." Verify by checking the actual listening PID (`netstat -ano | grep :8787`) and killing that PID directly (`taskkill //PID <pid> //F` in Git Bash) if in doubt — don't trust the kill command's exit status alone.

## Extending the Executor

When a pipeline step needs a capability the Executor doesn't have:
1. Add a new command to the `handlers` map in `plugin/code.js` — general-purpose, never specific to one app's content.
2. Exercise it for real against the live file (not just "should work").
3. Log it in `docs/capabilities-log.md`: what it does, why it was needed, how it was verified.
