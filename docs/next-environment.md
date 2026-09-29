# Next environment: smallest sensible experiment

**Browser**, via Playwright (or CDP directly).

## Why this is the smallest real next step

It's a genuinely different observe/act loop (DOM instead of a node tree, a screenshot instead of `EXPORT_NODE`, navigation instead of page-switching) — not a re-skin of the Figma work — while reusing the exact same proven pattern: MCP tool → thin adapter → real environment → observable result.

It's also simpler to build than the Figma adapter, which is the useful part to notice: Playwright already gives one Node process direct control over both the page's state *and* the network, with no sandbox/iframe split to route around. The bridge's WebSocket relay existed only because Figma's plugin model forces that split — a browser adapter doesn't need it. That's a concrete, working illustration of `docs/execution-layer.md`'s claim that the 3-hop transport was Figma-specific, not general.

## Smallest shape

A single new adapter process (no bridge needed — Playwright runs in-process), exposing a handful of tools mirroring the primitives already proven useful:

| Tool | Figma equivalent |
|---|---|
| `browser_navigate(url)` | opening/switching to a page |
| `browser_get_dom_state(selector?)` | `GET_DOCUMENT_STATE` |
| `browser_click(selector)` / `browser_fill(selector, value)` | `MODIFY_NODE` |
| `browser_screenshot()` | `EXPORT_NODE` |

## The experiment

One real, small task, run through this new adapter's tools only (not Playwright driven directly, not curl): open a real page, read its structure, fill a field, click something, screenshot the result, verify the expected change actually happened — the same observe → act → observe → correct → verify loop as the Figma benchmark, proving the general contract generalizes without touching `plugin/code.js`, `bridge/server.js`, or any existing `figma_*` tool.
