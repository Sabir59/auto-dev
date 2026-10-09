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
| `builder_update_content` | PATCH by id (name and/or data). It never creates an entry and never changes publication state. If the entry is **published**, the change goes live immediately, so it's refused without `live: true` | Work, `builder.write`, test space |
| `builder_publish_content` | PATCH `published: "published"`, followed by independent reads. The result reports what those reads show, not only what Builder's response said | Work, `builder.write`, test space |

Worker capabilities: `builder.read` (read tools, both modes) and `builder.write` (write tools, Work only). Requirements: `builder read` and `builder write`. With no credentials, the tools answer `NEEDS: builder read: …`.

## What's documented vs. proven

These come from Builder's docs and a Builder staff answer on Builder's forum (checked 2026-10-09):
- The Write API needs a private key. `published` takes `"draft"`, `"published"` or `"archived"`. `PATCH` updates only the fields you send. `PUT` replaces the whole entry.
- A `PATCH` or `PUT` on a **published** entry is live immediately. `?autoSaveOnly=true` stores an autosave instead: nothing changes live, and the editor shows "Publish update". The adapter doesn't use autosave. This is a likely reason earlier experiments "wrote but didn't publish", but that's an inference, not a proven cause.
- The docs don't document a separate "publish" endpoint, how autosaved editor changes get published through the API, or exactly how the Content API returns drafts.

**Proven so far: only against the local mock** (`bench/builder/adapter-test.mjs`). That proves the adapter's requests and guards, not Builder's behaviour. Real publishing is proven only by `bench/builder/real-builder-test.mjs` against a real test space.

## Tests

- `node bench/builder/adapter-test.mjs`: mocked Builder API, run through the real MCP server.
- `bash bench/workspace-ui/run-suite.sh builder`: the platform's access control with the real worker. Builder itself is mocked.
- `BUILDER_TEST_MODEL=page node bench/builder/real-builder-test.mjs`: the real proof. It needs credentials for a space marked `"test"`. Optional settings: `BUILDER_TEST_ENTRY_ID`, an existing unpublished entry made in Builder's editor, which is the case that matters; and `BUILDER_TEST_SITE`, a site that renders the test space.

## Limits

- **No production writes.** Allowing them later must be a deliberate change, for example per Team, with explicit confirmation.
- **No Team-level lock.** A Team can't yet pin a space or model the way it pins a Figma file. The space is whichever one the computer's credentials name.
- **Shell can read the key.** A worker with the `shell` capability (Work) could read the credentials file with `node`. The same is true for Figma's credentials today (`docs/PROJECT_HANDOFF.md` §15).
- **No delete or archive tools**, and none for symbols or assets.
