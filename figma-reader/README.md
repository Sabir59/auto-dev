# Figma Reader

The Figma Reader reads a Figma design from its **URL** through Figma's official REST API. It needs no plugin, no open Figma window and no bridge. It only reads; changing a design stays the job of the Figma Executor plugin (`plugin/`, `bridge/`, `mcp/server.mjs`).

```
Figma URL -> file key (+ node id) -> authenticated REST requests -> outline + render -> the worker
```

- `reader.mjs`: URL parsing, authentication, requests (429 retry), and the compact outline.
- `read.mjs`: command line. `node figma-reader/read.mjs "<url>" --out dir` writes `design.md`, `render.png` and `raw.json`.
- `../mcp/reader-server.mjs`: the same, as MCP tools (`figma_read_design`, `figma_access_status`). Workers with the "Read Figma designs from a link" capability get these tools.
- `oauth.mjs`: the one-time OAuth authorization (the production route).
- `compare-plugin.mjs`: checks the REST data against the plugin's data for the same node.

## Connecting Figma (once, by a person who can open the designs)

A link never grants access. The Reader acts as the Figma account that was connected, and sees exactly the files that account can open: its own, those shared with it, and those in its teams. If that account can't open a file, the Reader says so, and doesn't try another way in.

**Personal access token** (quickest):
1. figma.com → your avatar → Settings → Security → Personal access tokens → Generate new token.
2. Choose an expiry (90 days at most) and the scope **File content: Read** (`file_content:read`).
3. In your own terminal, not in a chat:

```powershell
New-Item -ItemType Directory -Force $HOME\.figma-reader | Out-Null
'{"type":"pat","token":"PASTE_TOKEN"}' | Out-File -Encoding ascii $HOME\.figma-reader\credentials.json
```

**OAuth app** (production):
1. Create an app at https://www.figma.com/developers/apps, linked to your team, with the redirect URL `http://localhost:3007/callback`.
2. Run `node figma-reader/oauth.mjs --client-id <id> --client-secret <secret>` and approve in the browser.
3. Access tokens last 90 days, and the Reader refreshes them itself.
4. A draft app works for you and your plan's admins; a private app works for your team; a public app needs Figma's review.

Credentials live in `~/.figma-reader/` (or in `FIGMA_READER_DIR`), never in a repository. `FIGMA_TOKEN` is accepted for command-line use, but is never passed to workers.

## Limits that matter

- Reading files, nodes and renders is Figma's "Tier 1". **On a Starter (free) team, or with a View/Collab seat, that's only a few requests a month.** Figma's page says both "up to 20" and "6". With a Dev or Full seat on a paid plan it's 10–20 per minute.
- A link with `node-id` costs two Tier-1 requests (the node and its render). A link without one costs three.
- Variables (`/variables/*`) need Enterprise; elsewhere you get only variable ids in `boundVariables`.
- Components and styles endpoints list **published** library items only. The file JSON still carries every component and style the node uses.
