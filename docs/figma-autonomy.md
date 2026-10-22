# Figma editing without a person in the loop: what's possible, what changed (2026-10-21)

## What the Executor was

```
worker ─MCP stdio─► mcp/server.mjs ─HTTP /command─► bridge/server.js (:8787 loopback) ─WS─► plugin/ui.html ─postMessage─► plugin/code.js ─► Figma Plugin API
```

Before this change, each Figma session needed four manual steps:

1. open the file in the Figma desktop app;
2. start `node bridge/server.js`, or use the dashboard switch;
3. run Plugins → Development → AI Executor (POC);
4. keep the plugin open.

The plugin already reconnected by itself after a bridge restart (`ui.html` retry). It did not tell anyone which file it was in. The bridge held one plugin socket, and a second run silently replaced the first. The MCP server registered every edit tool in every profile, so an Inspect or read-only run was read-only only through the console's allow list.

## What Figma actually supports (checked 2026-10-21)

| Route | Can it change design nodes? | Source |
|---|---|---|
| REST API | **No.** The write endpoints in Figma's OpenAPI spec are comments and their reactions, webhooks, dev resources, `POST /v1/files/{key}/variables` (Enterprise only) and developer logs. Nothing creates or edits a node. | `github.com/figma/rest-api-spec` openapi.yaml; developers.figma.com/docs/rest-api |
| Token scopes | The only write scopes are `file_comments:write`, `file_dev_resources:write`, `file_variables:write` (Enterprise) and `webhooks:write`. A "read/edit" token means these, not canvas edits. Our stored token (a PAT) answers `/v1/me`. | developers.figma.com/docs/rest-api/scopes |
| Plugin API | **Yes**: full read and write, but only inside a plugin that a person runs in an open editor. There's no API to launch a plugin from outside, or to run one when a file opens. `setRelaunchData` only adds a button that a person still has to click. | developers.figma.com/docs/plugins; forum answers on auto-launch |
| Figma's remote MCP server (`https://mcp.figma.com/mcp`) | **Yes**: `use_figma` (create, edit, delete, inspect), `upload_assets`, `generate_figma_design` and others are remote-only. It runs on Figma's side, needs no desktop app or plugin, and is in beta (free for now, to become usage-based). It requires a Full seat to write outside drafts, an interactive OAuth sign-in, and a client from Figma's MCP catalogue (Claude Code is listed). A personal access token doesn't work for it. | developers.figma.com/docs/figma-mcp-server (tools-and-prompts, remote-server-installation) |
| Figma's desktop MCP server | No canvas writes (read context only). | same |

So the token can't edit the canvas, whatever its scopes. The supported routes for edits are a running plugin (ours) or Figma's own remote MCP server.

## The options

- **A. Persistent local Executor (implemented).** The bridge's lifecycle is automated. A person still has to run the plugin once in each file they open, because Figma allows nothing else. After that, bridge restarts, iframe teardowns that the plugin survives, and new runs need nobody.
- **B. Figma-native (remote MCP `use_figma`).** This is the only route with no desktop app and no plugin. It's officially supported, but it's beta. It needs a Full seat and a person's interactive OAuth grant, given once per client: Claude Code's own `/mcp`, not a token our console stores. Its edits are JavaScript that Figma runs, not our typed command set, so our file lock, read-only profile and batch reports don't apply to it. It's not wired into the workers: doing that is a product decision (seat cost, beta terms, a separate grant and a different safety model), not a fix. In this session the `figma` MCP server is configured but not authorized.
- **C. Hosted.** A hosted worker can't reach a person's desktop. No such mechanism exists, and we haven't built one. Hosted runs keep the Figma Reader only (REST, read). Option B is the only way a hosted worker could ever edit, and it would need the person's own OAuth grant held by the hosted runtime.

## What changed

- **The bridge starts itself** (`bridge/launcher.mjs`).
  - The first Figma call that finds nothing listening starts `bridge/server.js` detached (log: `bridge/bridge.log`). So does `figma_executor_status`, or a run start whose worker needs Figma edit access.
  - It never starts over another program on the port (`PORT_IN_USE`).
  - It replaces an older bridge only while no plugin is connected.
  - It reports a missing `npm install` as `MISSING_DEPENDENCY`.
  - Hosted it's off (`FIGMA_BRIDGE_AUTOSTART=0`), and the hosted image doesn't contain it.
- **Sessions per file** (`bridge/server.js`, protocol 2).
  - The plugin's hello names its file (`plugin/code.js` → `ui.html`); an older plugin is asked with `GET_FILE_INFO`.
  - A command goes to the file it names (`fileKey`). Without one, it goes to the only open file, and it's refused as `AMBIGUOUS_SESSION` while several files have the plugin running.
  - A WebSocket heartbeat drops a plugin that stopped answering.
  - A plugin that disconnects mid-command fails that command immediately (`PLUGIN_DISCONNECTED`, outcome unknown), instead of after 30s.
  - `/status` is machine-readable: protocol, pid, sessions with file name and key, last disconnect.
- **Error codes** on every failure: `BRIDGE_UNAVAILABLE`, `BRIDGE_START_FAILED`, `MISSING_DEPENDENCY`, `PORT_IN_USE`, `PLUGIN_NOT_CONNECTED`, `FILE_NOT_OPEN`, `AMBIGUOUS_SESSION`, `WRONG_FILE`, `READ_ONLY`, `COMMAND_FAILED`, `TIMEOUT`, `PLUGIN_DISCONNECTED`. Each comes with the next step and says when only the person can act.
- **New tools** (`mcp/server.mjs`):
  - `figma_executor_status`: what works now, and who has to act.
  - `figma_use_file`: pins the run to a file by link or key; a Team run may pin only its own file.
  - `figma_verify_nodes`: reads nodes back from Figma and compares them with expected values.
  - `figma_batch` takes `verify: true` and reads back everything it made or changed.
- **Read-only runs are read-only in the server itself.** `FIGMA_EXECUTOR_PROFILE=read` registers no edit tool, and refuses any command that isn't a read. The console sets it for every run that can't use `figma.plugin.edit` (Inspect workspaces, read-only workers).
- **A call waits briefly for a plugin that's coming back.** That's when the bridge just started, or a plugin dropped less than 30s ago. A call never retries once a plugin may have received it.
- **The console's "Figma: change the open file" check** reads `/status`. At a run's start it brings the bridge up and names the connected file. In a Team run it reports a plugin that's running in another file.
- The Senior UI/UX worker's instructions use `figma_executor_status` and `figma_use_file`; `doctor.mjs` no longer treats a stopped bridge as a problem.

Credentials: none of this uses the Figma token. The plugin acts as the person who ran it, the token stays with the Figma Reader (`~/.figma-reader`), and no log or status shows it.

## What a person still has to do

1. **Once:** import the plugin (Plugins → Development → Import plugin from manifest → `plugin/manifest.json`), and `npm install` in `bridge/`.
2. **Each time a file is opened:** run the plugin in it (Plugins → Development → AI Executor (POC), or Figma's "Run last plugin" shortcut). Figma has no API for this; `figma_executor_status` says `userActionRequired: true` with this step.
3. **Keep the plugin running** while workers edit. If Figma closes the plugin itself, run it again; the bridge side recovers by itself.

No longer needed: starting or restarting the bridge, restarting it after an update while no plugin is connected, and re-running the plugin after a bridge restart.

## Proof

| Suite | Result | What it is |
|---|---|---|
| `bench/figma-executor/lifecycle-test.mjs` | 17/17 | real bridge + MCP server, fake plugins: autostart, health, no plugin, connect, refused write, read-back, batch verify, mid-command drop, heartbeat, recovery, two files, Team scope, read-only, port in use, older bridge, missing dependency, autostart off |
| `bench/figma-executor/console-wiring-test.mjs` | 2/2 | test console: a read-only worker gets the read-only Executor; an editing worker gets edit, and its run start brings the bridge up |
| `bench/figma-executor/live-lifecycle-test.mjs` | 5/5 | **live** Figma desktop, "Test Space", reads only: READY with the real file, `figma_use_file`, read-back on a real node, another file's lock refused, read-only tool list, bridge stopped and back with the real plugin reconnected in 1.3s |
| `bench/figma-executor/batch-test.mjs` | 10/10 | unchanged behaviour of batches and compact reads |
| `bench/security/local-boundaries-test.mjs` | 8/8 | bridge Origin/Host rules unchanged |
| `run-suite.sh devctl` | 16/16 | dashboard bridge switches |
| `bench/hosted/hosted-test.mjs` (win32) | 24 passed, 2 skipped (Linux-only) | hosted console without the bridge code |

**Not proven live:** a write. Each live test only read, because the open file is the person's own; a live write needs their go-ahead, or a scratch file (`live-batch-test.mjs` is the existing live write test). The plugin's own reconnect was proven live; the heartbeat drop was proven only with a fake plugin.
