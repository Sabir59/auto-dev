# Builder adapter

Native Builder.io tools for the worker. It makes direct HTTP calls to Builder's documented APIs and uses no Builder MCP server, SDK or model calls. The worker decides what to do, and the adapter carries it out deterministically.

```
worker ──MCP stdio──► mcp/builder-server.mjs ──► builder-adapter/builder.mjs ──HTTPS──► Builder
                                                   Admin API   POST cdn.builder.io/api/v2/admin      (private key)  models
                                                   Content API GET  cdn.builder.io/api/v3/content/M  (public key)   read
                                                   Write API   POST/PATCH builder.io/api/v1/write/M  (private key)  create, update, publish
```

## Connect a space (once per computer)

Create `~/.builder-adapter/credentials.json`, outside the repo. Never commit it and never paste keys into a chat:

```json
{ "label": "MATW test space", "environment": "test", "publicKey": "<public API key>", "privateKey": "bpk-<private key>" }
```

- **Public key:** Builder → Account settings → Space → *Public API Key*.
- **Private key:** Builder → Account settings → *Private keys* → create one for this integration (it starts `bpk-`).
- **`environment`:** only `"test"` allows writes. Anything else, including a missing value, is treated as **production**. Then every create, update and publish is refused before a request is sent. This version never writes to production.
- **`BUILDER_ADAPTER_DIR`:** moves the folder (the tests use this). The console passes on only this path and never the keys. Workers never receive `BUILDER_*` variables.

## Tools

| Tool | What it does | Available |
|---|---|---|
| `builder_access_status` | Whether credentials exist, which space (label, test or production), whether writes are allowed, and whether the key works | Inspect + Work |
| `builder_list_models` | The space's models (id, name, kind) | Inspect + Work |
| `builder_list_content` | Entries of a model, drafts included (or live only), read fresh, bypassing Builder's CDN cache | Inspect + Work |
| `builder_get_content` | One entry by id: its state and data | Inspect + Work |
| `builder_verify_content` | Two independent fresh reads: the entry's state, and whether the public Content API serves it live. It also returns the entry's URL so the page itself can be checked with the browser tools | Inspect + Work |
| `builder_create_draft` | A new entry with `published: "draft"`. Refused if an entry with the same name or URL already exists | Work, `builder.write`, test space |
| `builder_update_content` | PATCH by id: name, top-level data fields, and/or `breakpoints`. Data can come from a JSON file in the workspace (`dataFile`). It never creates an entry and never changes publication state. On a **published** entry it needs `draft: true` (an autosave: the live page is unchanged, preview it at the returned `previewUrl`) or `live: true`. The current breakpoints go along with every write | Work, `builder.write`, test space |
| `builder_publish_content` | Publishes the **latest saved version**, including a pending draft, then checks it with independent reads. The result reports what those reads show, not only what Builder's response said | Work, `builder.write`, test space |
| `builder_upload_asset` | Uploads an image or font from the workspace (and only from there) to the space's asset library, and returns its CDN URL | Work, `builder.write`, test space |

Worker capabilities: `builder.read` (read tools, both modes) and `builder.write` (write tools, Work only). Requirements: `builder read` and `builder write`. With no credentials, the tools answer `NEEDS: builder read: …`.

## What's documented vs. proven

These come from Builder's docs and a Builder staff answer on Builder's forum (checked 2026-10-09):
- The Write API needs a private key. `published` takes `"draft"`, `"published"` or `"archived"`. `PATCH` updates only the fields you send. `PUT` replaces the whole entry.
- A `PATCH` or `PUT` on a **published** entry is live immediately. `?autoSaveOnly=true` stores an autosave instead: nothing changes live, and the editor shows "Publish update". The adapter doesn't use autosave. This is a likely reason earlier experiments "wrote but didn't publish", but that's an inference, not a proven cause.
- The docs don't document a separate "publish" endpoint, how autosaved editor changes get published through the API, or exactly how the Content API returns drafts.

**Proven against real Builder (2026-10-09)** with MATW's dev space (non-production, confirmed by the owner), model `matw-next-application`, and a local `shopmaze` (Next.js, `@builder.io/sdk-react`). That site serves only published entries at their path and 404s otherwise. Evidence: `bench/builder/real-builder-results*.json`.
- **An existing page made in Builder's visual editor can be published through the API.** For `/test-adapter`, `PATCH published: "published"` changed its state from draft to published, a lookup by URL path returned it, and the site went from 404 to 200 (`real-builder-results-run1-editor-page.json`).
- **The adapter's own flow works end to end.** It created a draft, updated it (still one entry, still a draft, site 404), published it (state published, served at its URL), and the site returned 200 with the updated content (`real-builder-results.json`).
- **Builder returns drafts to a query by id**, with or without `includeUnpublished`, and even with `query.published=published`. So "returned by id" never means live. `builder_verify_content` decides "live" from the entry's `published` field plus a lookup by URL path, the way a site resolves pages. The real test caught this; the first version of the adapter and of the mock got it wrong.
- Content API reads with the public key and `includeUnpublished=true` do return drafts.

**The draft workflow (proven 2026-10-10, `bench/builder/real-draft-test.mjs`, 6/6):**
- `PATCH ?autoSaveOnly=true` on a published entry leaves the live page unchanged, both through the API and on the site.
- `preview=true` reads return the pending draft.
- A site using the Builder SDK renders the draft at its URL with `?builder.preview=<model>&builder.cachebust=true&builder.overrides.<model>=<id>`.
- **A bare `published: "published"` write discards a pending draft.** That's why `builder_publish_content` writes the draft's content back along with the flag.
- **A write without `meta` clears `meta.breakpoints`**, so every adapter write re-sends the current breakpoints.
- The site delivery returns the breakpoints, so the SDK uses them.
- **Delivery reads inject a tracking-pixel block** (`builder-pixel-…`) into `data.blocks`. The adapter strips it before any data is shown, compared or written back. The true stored content is the `preview=true` read.
- The site reads published content through Builder's CDN, which can lag a change by about 35 seconds. Preview URLs bypass the cache.
- Uploads work for images and **fonts**. A `.ttf` is served back byte for byte as `font/ttf` from `cdn.builder.io/api/v1/file/…`.

**Not proven yet:** a real worker calling these tools. The worker runtime's Claude login had expired. The worker does get the right tools, per the access suite.

## Tests

- `node bench/builder/adapter-test.mjs`: mocked Builder API, run through the real MCP server.
- `bash bench/workspace-ui/run-suite.sh builder`: the platform's access control with the real worker. Builder itself is mocked.
- `BUILDER_TEST_MODEL=page node bench/builder/real-builder-test.mjs`: the real proof. It needs credentials for a space marked `"test"`. Optional settings: `BUILDER_TEST_ENTRY_ID`, an existing unpublished entry made in Builder's editor, which is the case that matters; and `BUILDER_TEST_SITE`, a site that renders the test space.

## Limits

- **No production writes.** Allowing them later must be a deliberate change, for example per Team, with explicit confirmation.
- **No Team-level lock.** A Team can't yet pin a space or model the way it pins a Figma file. The space is whichever one the computer's credentials name.
- **Shell can read the key.** A worker with the `shell` capability (Work) could read the credentials file with `node`. The same is true for Figma's credentials today (`docs/PROJECT_HANDOFF.md` §15).
- **No delete or archive tools**, and none for symbols or assets.
