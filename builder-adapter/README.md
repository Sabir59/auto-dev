# Builder adapter

Native Builder.io tools for the worker. It makes direct HTTP calls to Builder's documented APIs and uses no Builder MCP server, SDK or model calls. The worker decides what to do, and the adapter carries it out deterministically.

```
worker ──MCP stdio──► mcp/builder-server.mjs ──► builder-adapter/builder.mjs ──HTTPS──► Builder
                                                   Admin API   POST cdn.builder.io/api/v2/admin      (private key)  models
                                                   Content API GET  cdn.builder.io/api/v3/content/M  (public key)   read
                                                   Write API   POST/PATCH builder.io/api/v1/write/M  (private key)  create, update, publish
```

## Connecting spaces (on the platform, not on a computer)

People connect Builder in the console: **Integrations → Builder.io**. Nobody edits a file.

1. **Connect a space.** Give it a name, plus its *Public API key* (Builder → Account settings → Space) and a *Private key* (Builder → Account settings → Private keys; it starts `bpk-`). The console checks both keys with Builder before anything is kept: the private key must list the space's models, the public key must read its content, and the content must belong to those models, so the two keys can't come from different spaces. A person can connect up to 20 spaces.
2. **Production or test.** A new space is **production** unless the person chooses *Test or development* and ticks the confirmation. They can mark a space as test later (with the same confirmation) or as production again (immediately). A production space is never written to.
3. **Give spaces to workers.** In a worker's editor, under Builder.io → *Builder spaces it can use*, each connected space is set to *No access*, *Read* or *Read and write*. *Read and write* can't be chosen for a production space, and the console refuses to save it.

Storage: one file per person, `credentials.json` in `BUILDER_ADAPTER_DIR` (default `~/.builder-adapter`; hosted, the person's own folder), `{ "v": 2, "spaces": [...] }`, encrypted at rest with the person's credential key (`worker-ui/secret-file.mjs`, AES-256-GCM). Nothing but the console reads it. A space's id (`sp_` + 12 hex) is derived from its public key, so reconnecting the same space keeps the workers given it. A file in the earlier single-space form is read as one space.

## How a run gets its spaces

- The console starts the run's Builder tool server with the run's authz token, never the person's credential key and never a key in its MCP config.
- At every call the tool server asks its own console (`/authz/<run>/builder-spaces`) for the spaces this run may use. The console answers with only the spaces given to the worker that are still connected, each with its access now. Write access requires both a test space and a run with Builder write tools.
- So removing a space, or marking it as production, takes effect on the worker's next call.
- With several spaces the worker names one (`space`: its id or name); with one, it's used by default.
- The write tools are registered only when the worker has Builder write tools and at least one test space with write access.
- Run on its own, outside a console (the adapter's tests, a person's own scripts), the server reads the file directly. Every space is readable, and only test spaces are writable.

## Worker packages

The space mapping is account-specific, so it's never exported (`config.secret: ["spaces"]` in the Builder manifest). A package carries Builder's version, its permission level (*What may it do with content?*) and its requirements (`builder read`, `builder write`). Whoever installs it connects their own spaces and gives the worker theirs. A clone on the same console keeps the mapping.

## Tools

| Tool | What it does | Available |
|---|---|---|
| `builder_access_status` | The spaces available to this worker: each one's id, name, test or production, whether it may write, and whether its keys work | Inspect + Work |
| `builder_list_models` | The space's models (id, name, kind) | Inspect + Work |
| `builder_list_content` | Entries of a model, drafts included (or live only), read fresh, bypassing Builder's CDN cache | Inspect + Work |
| `builder_get_content` | One entry by id: its state and data | Inspect + Work |
| `builder_verify_content` | Two independent fresh reads: the entry's state, and whether the public Content API serves it live. It also returns the entry's URL so the page itself can be checked with the browser tools | Inspect + Work |
| `builder_create_draft` | A new entry with `published: "draft"`. Refused if an entry with the same name or URL already exists | Work, `builder.write`, a test space given with write access |
| `builder_update_content` | PATCH by id: name, top-level data fields, and/or `breakpoints`. Data can come from a JSON file in the workspace (`dataFile`). It never creates an entry and never changes publication state. On a **published** entry it needs `draft: true` (an autosave: the live page is unchanged, preview it at the returned `previewUrl`) or `live: true`. The current breakpoints go along with every write | Work, `builder.write`, test space |
| `builder_publish_content` | Publishes the **latest saved version**, including a pending draft, then checks it with independent reads. The result reports what those reads show, not only what Builder's response said | Work, `builder.write`, test space |
| `builder_upload_asset` | Uploads an image or font from the workspace (and only from there) to the space's asset library, and returns its CDN URL | Work, `builder.write`, test space |

Every tool takes an optional `space`. Worker capabilities: `builder.read` (read tools, both modes) and `builder.write` (write tools, Work only). Requirements: `builder read` and `builder write`. With no space available, the tools answer `NEEDS: builder read: …`, which points the person to the Builder.io page.

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
- `node bench/builder/spaces-test.mjs`: Builder spaces as a platform capability, on two consoles (two people). It covers connecting (wrong and mismatched keys refused, a test space only with confirmation), encryption at rest and per-person isolation, per-worker read and write permissions, and production writes refused on save, at the tool, and when a space is marked as production mid-run. It also checks that only the run's spaces are released to its tool server, that export and import carry no keys or mapping, and that a clone keeps the mapping.
- `bash bench/workspace-ui/run-suite.sh builder`: the platform's access control with the real worker. Builder itself is mocked.
- `BUILDER_TEST_MODEL=page node bench/builder/real-builder-test.mjs`: the real proof. It needs credentials for a space marked `"test"`. Optional settings: `BUILDER_TEST_ENTRY_ID`, an existing unpublished entry made in Builder's editor, which is the case that matters; and `BUILDER_TEST_SITE`, a site that renders the test space.

## Limits

- **No production writes.** Allowing them later must be a deliberate change, for example per Team, with explicit confirmation.
- **"Test space" is the person's statement.** Builder has no test flag. The console verifies the keys, and the person confirms the space is a test or development one.
- **No Team-level lock.** A Team can't yet pin a space or model the way it pins a Figma file.
- **Locally, without a credential key, the file is plain JSON**, as the other local credentials are. A worker with the `shell` capability could read it with `node` (`docs/PROJECT_HANDOFF.md` §15). Hosted, it's encrypted, and the worker runs as the person's own uid without the key.
- **No delete or archive tools**, and none for symbols or assets.
