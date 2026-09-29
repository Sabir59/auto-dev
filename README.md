# figma-ai-executor (v0.1 POC)

Goal: prove `AI -> Executor -> Figma -> result -> AI` with zero human copy/paste,
using only the current Figma Plugin API + a tiny local bridge.

## Why this shape

Figma plugins run in two isolated contexts and there is no way around this:

- **Plugin sandbox** (`plugin/code.js`) — full access to the Figma document
  (create/modify/inspect nodes) but **no network access** (no fetch/WebSocket).
- **Plugin UI iframe** (`plugin/ui.html`) — full browser APIs (WebSocket etc.)
  but **no access to the Figma document**.

So the network leg (talking to us) and the document leg (talking to Figma)
are necessarily two different files, connected by `postMessage`. The bridge
server is what turns that into something an external process can call over
plain HTTP.

```
AI (curl / script)
   │  HTTP POST http://localhost:8787/command
   ▼
bridge/server.js   (Node, http + ws)
   │  WebSocket  ws://localhost:8787/ws
   ▼
plugin/ui.html     (iframe — owns the socket)
   │  postMessage
   ▼
plugin/code.js     (sandbox — Figma Plugin API)
   │
   ▼
Figma document  →  result flows back up the same path  →  HTTP response
```

## Known limitation (can't be engineered away)

Figma requires a human to launch the plugin once per session (Plugins menu).
There is no public API to auto-launch a plugin from outside Figma. After that
one-time launch, the AI drives it directly — no further manual steps.

Separately, Figma has been observed to occasionally tear down a running
plugin's iframe runtime (not a WebSocket timeout — the whole JS context gets
killed). `ui.html` has basic auto-reconnect for this; if the bridge reports
"No Figma plugin connected", re-run the plugin from the Plugins menu.

## Setup

1. **Start the bridge:**
   ```
   cd figma-ai-executor/bridge
   npm install
   npm start
   ```
   You should see: `Bridge listening: HTTP+WS on http://localhost:8787 ...`

2. **Load the plugin in Figma (desktop app):**
   - Figma menu → Plugins → Development → Import plugin from manifest…
   - Select `figma-ai-executor/plugin/manifest.json`
   - Open any file → Plugins → Development → "AI Executor (POC)" → Run
   - A small window appears; it should say **connected** within a second or
     two (matching a `plugin connected` line in the bridge's console log).

3. **Send a command (from anywhere — this is the "AI" side for now):**
   ```
   curl -X POST http://localhost:8787/command \
     -H "Content-Type: application/json" \
     -d '{"type":"CREATE_FRAME","params":{"width":375,"height":812,"name":"AI Test"}}'
   ```
   Expected response:
   ```json
   {"id":"...","ok":true,"result":{"id":"1:2","name":"AI Test","width":375,"height":812,"summary":"SUCCESS: Created frame \"AI Test\", 375x812"}}
   ```
   And the frame appears in the currently open Figma file.

   Health check: `curl -X POST http://localhost:8787/command -d '{"type":"PING"}'`
   Inspect: `curl -X POST http://localhost:8787/command -d '{"type":"GET_SELECTION"}'`

## Command protocol (v0.1)

Request: `{"type": "COMMAND_NAME", "params": {...}}`
Response: `{"id", "ok": true, "result": {...}}` or `{"id", "ok": false, "error": "..."}`

Implemented so far: `PING`, `CREATE_FRAME`, `GET_SELECTION`, `CREATE_TEXT`,
`MODIFY_NODE`, `GET_DOCUMENT_STATE`.

```
curl -X POST http://localhost:8787/command -d '{"type":"CREATE_TEXT","params":{"content":"Hello","x":20,"y":20,"fontSize":24}}'
curl -X POST http://localhost:8787/command -d '{"type":"GET_DOCUMENT_STATE"}'
curl -X POST http://localhost:8787/command -d '{"type":"MODIFY_NODE","params":{"id":"<node id from a previous result>","props":{"name":"Renamed","width":400,"fill":{"r":0.2,"g":0.6,"b":1}}}}'
```

Note: `documentAccess: "dynamic-page"` is set in the manifest (now required
for new plugins). This means `figma.getNodeById` throws — `MODIFY_NODE` uses
`figma.getNodeByIdAsync` instead. `CREATE_TEXT` calls `figma.loadFontAsync()`
before touching `.characters`, which is required or text edits silently fail.

Adding a command = one entry in the `handlers` map in `plugin/code.js`. Next
candidate: `CREATE_RECTANGLE`.

**After editing `manifest.json` or `code.js`, re-run the plugin** (Plugins >
Development > "AI Executor (POC)") to pick up the changes — Figma re-reads
the files from disk each time you run it.

## What this does NOT prove yet

- Multiple concurrent plugin connections / multiple files.
- Recovery automation for the runtime-kill issue (currently just reconnects
  the socket; if Figma kills the iframe context itself, the plugin needs to
  be re-run manually — see Known limitation above).
- Auth (fine for a localhost-only POC; would need a token before any
  non-localhost exposure).
