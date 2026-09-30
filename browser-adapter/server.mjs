#!/usr/bin/env node
// Second execution-layer adapter, proving the same MCP tool contract
// generalizes to a different real environment. Unlike figma-executor,
// there's no separate bridge process here: Playwright already gives this
// one Node process direct control over both page state and network, so
// the WebSocket relay that Figma's sandbox/iframe split forced isn't
// needed. That's the point of this file existing — see
// docs/execution-layer.md and docs/next-environment.md.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { chromium } from "playwright";
import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EXPORTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "exports");
mkdirSync(EXPORTS_DIR, { recursive: true });

// Lazily launched, kept alive across tool calls (the same "one live
// connection" shape as the Figma bridge's single pluginSocket).
// A browser that died (crash, killed process) stays assigned but unusable,
// so relaunch whenever it's disconnected or the page is closed. The new
// browser starts with a fresh, empty session.
let browser, page;
async function getPage() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch();
    page = undefined;
  }
  if (!page || page.isClosed()) page = await browser.newPage();
  return page;
}

function toolResult(result) {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
}

const server = new McpServer({ name: "browser-executor", version: "0.1.0" });

server.registerTool(
  "browser_navigate",
  { description: "Navigate to a URL (launches the browser on first call).", inputSchema: { url: z.string().url() } },
  async ({ url }) => {
    const p = await getPage();
    await p.goto(url, { waitUntil: "domcontentloaded" });
    return toolResult({ url: p.url(), title: await p.title() });
  }
);

server.registerTool(
  "browser_get_dom_state",
  {
    description:
      "Inspect the current page. With no selector: a structured accessibility tree of the whole page (role, name, children — analogous to figma_get_document_state's node tree). With a selector: that one element's tag, text, attributes and bounding box.",
    inputSchema: { selector: z.string().optional() },
  },
  async ({ selector }) => {
    const p = await getPage();
    if (selector) {
      const loc = p.locator(selector).first();
      const count = await p.locator(selector).count();
      if (count === 0) throw new Error(`No element matches selector: ${selector}`);
      const [tag, text, box, attrs] = await Promise.all([
        loc.evaluate((el) => el.tagName.toLowerCase()),
        loc.innerText().catch(() => ""),
        loc.boundingBox(),
        loc.evaluate((el) => Object.fromEntries(Array.from(el.attributes).map((a) => [a.name, a.value]))),
      ]);
      return toolResult({ selector, matches: count, tag, text, box, attrs });
    }
    // page.accessibility.snapshot() was removed from Playwright — the
    // current equivalent is ariaSnapshotJSON (found by reading the
    // installed version's own type definitions, not assumed from memory).
    const snapshot = await p.ariaSnapshotJSON();
    return toolResult({ url: p.url(), title: await p.title(), tree: snapshot });
  }
);

server.registerTool(
  "browser_click",
  { description: "Click an element.", inputSchema: { selector: z.string() } },
  async ({ selector }) => {
    const p = await getPage();
    await p.click(selector);
    return toolResult({ clicked: selector });
  }
);

server.registerTool(
  "browser_fill",
  { description: "Fill a form field.", inputSchema: { selector: z.string(), value: z.string() } },
  async ({ selector, value }) => {
    const p = await getPage();
    await p.fill(selector, value);
    return toolResult({ filled: selector, value });
  }
);

server.registerTool(
  "browser_screenshot",
  {
    description: "Screenshot the page (or one element). Returns a local file path — read that file to see the result, same pattern as figma_export_node.",
    inputSchema: { selector: z.string().optional() },
  },
  async ({ selector }) => {
    const p = await getPage();
    const target = selector ? p.locator(selector).first() : p;
    const bytes = await target.screenshot();
    const fileName = `${Date.now()}.png`;
    const filePath = join(EXPORTS_DIR, fileName);
    writeFileSync(filePath, bytes);
    return toolResult({ path: filePath });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
