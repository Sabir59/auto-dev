# Execution layer: general vs. Figma-specific

## General (would carry over to any environment)

- **The tool contract.** MCP tool → `{type, params}` in, `{ok, result|error}` out, correlated by request id. `bridge/server.js` implements this with zero knowledge of what any `type` means (confirmed by removing the one place it checked a command name — see Phase 1 commit).
- **Binary/large-result handling.** "If the result carries a base64 payload, write it to disk and return a path" is keyed off shape, not command name — works for any environment that needs to hand back an image/file.
- **Error surfacing.** A thrown error becomes a clean string the AI can read and reason about (`isError: true` + message), not a crash — proven in Phase 3 (a bad node id, an invalid MCP argument) without any per-command error handling.
- **The tool-registry/schema pattern itself** (name, description, typed input) — `mcp/server.mjs`'s shape doesn't reference Figma anywhere in its plumbing, only in each tool's own schema/description.

## Figma-specific (lives in `plugin/code.js` + each tool's schema in `mcp/server.mjs`)

- Every actual capability: nodes, variables, styles, components, screens, prototype reactions, export formats — all Figma Plugin API concepts.
- The 3-hop transport (sandbox ↔ iframe ↔ bridge) exists **only** because Figma's own extension model splits "has the document" from "has the network" across two contexts. An environment without that split (e.g. a Node-controllable browser) won't need this hop at all.
- The two real Figma quirks in `docs/baseline.md` (`figma.mixed`, page-load flakiness, the ambiguous "connection" error on a bad node id) are Figma implementation details, not general lessons about AI-driven execution.

## The adapter boundary, concretely

```
AI (Claude Code)
   │  MCP tool call
   ▼
mcp/server.mjs        — GENERAL: translates a tool call to {type, params}, POSTs it, returns the JSON. No Figma logic.
   │  HTTP
   ▼
bridge/server.js       — GENERAL: WS relay + binary-to-file. Doesn't know what any command means.
   │  WebSocket
   ▼
plugin/code.js         — FIGMA-SPECIFIC: 100% of the actual capabilities.
   ▼
Figma Plugin API
```

The boundary that matters is **between `mcp/server.mjs` and `bridge/server.js`**. Everything above it is reusable as-is. A second environment needs its own equivalent of everything below it — not a rewrite of the MCP layer.

## What a second environment needs

1. A way to **execute an action** and a way to **observe resulting state** — the two irreducible primitives (Figma gave us both via its Plugin API for free).
2. A thin transport with the same `{type, params}` → `{ok, result|error}` contract, correlated by id — doesn't have to be HTTP+WS specifically if the environment doesn't force a process split the way Figma does.
3. A capability map analogous to `code.js`'s `handlers` — one function per real, verified action.
4. A verification primitive analogous to `EXPORT_NODE` + reading the file — something that lets the AI **see** the result, not just trust it happened.
