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

// Profile, chosen by whoever launches the adapter (the env of its MCP config entry).
//   full:    any URL Playwright accepts (benchmarks open local file:// pages), and
//            browser_screenshot, which writes PNGs to exports/.
//   inspect: http: and https: pages only, and no screenshot tool. Anything other than "full",
//            unset included, is inspect, so a launcher that forgets the variable gets less.
// The URL check is here, before navigation, because the caller's permission rules match the URL
// as a case-sensitive string: FILE:///, File:/// and view-source:file:/// got past url:file:*.
const PROFILE = process.env.BROWSER_EXECUTOR_PROFILE === "full" ? "full" : "inspect";
const WEB = new Set(["http:", "https:"]);
// Parse as the browser does (WHATWG), check the scheme, and navigate to the parsed form, so the
// browser never gets a string it could read differently from this check.
function inspectUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error(`Inspect profile: not a valid URL: ${JSON.stringify(raw)}`); }
  if (!WEB.has(u.protocol)) throw new Error(`Inspect profile: only http: and https: URLs can be opened, not ${u.protocol}`);
  return u.href;
}
// After anything that can navigate (a redirect, a clicked link), the page must still be a web
// page; if not, it's reset to about:blank before anything can be read from it.
async function assertOnWeb(p) {
  if (PROFILE === "full") return;
  const at = p.url();
  if (at === "about:blank" || WEB.has(new URL(at).protocol)) return;
  await p.goto("about:blank");
  throw new Error(`Inspect profile: the page left http(s) (to ${at}); it was reset to about:blank`);
}

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
  if (!page || page.isClosed()) page = await browser.newPage(PROFILE === "full" ? {} : { acceptDownloads: false });
  return page;
}

function toolResult(result) {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
}

const server = new McpServer({ name: "browser-executor", version: "0.1.0" });

server.registerTool(
  "browser_navigate",
  {
    description: "Navigate to a URL (launches the browser on first call). viewport sets the page size first (it stays for later calls), e.g. 1440x900 or 390x844, to see a layout at a given screen size. waitUntil 'networkidle' also waits for images and fonts, for screenshots that compare renders.",
    inputSchema: {
      url: z.string().url(),
      viewport: z.object({ width: z.number().int().min(200).max(3840), height: z.number().int().min(200).max(4000) }).optional(),
      waitUntil: z.enum(["domcontentloaded", "load", "networkidle"]).optional().describe("Default domcontentloaded"),
    },
  },
  async ({ url, viewport, waitUntil = "domcontentloaded" }) => {
    const target = PROFILE === "full" ? url : inspectUrl(url);
    const p = await getPage();
    if (viewport) await p.setViewportSize(viewport);
    await p.goto(target, { waitUntil });
    if (waitUntil !== "domcontentloaded") await p.evaluate(() => document.fonts.ready).catch(() => {});
    await assertOnWeb(p);
    return toolResult({ url: p.url(), title: await p.title(), viewport: p.viewportSize() });
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
    await assertOnWeb(p);
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
    await assertOnWeb(p);
    await p.click(selector);
    await assertOnWeb(p);
    return toolResult({ clicked: selector });
  }
);

server.registerTool(
  "browser_fill",
  { description: "Fill a form field.", inputSchema: { selector: z.string(), value: z.string() } },
  async ({ selector, value }) => {
    const p = await getPage();
    await assertOnWeb(p);
    await p.fill(selector, value);
    return toolResult({ filled: selector, value });
  }
);

// Writes to disk, so it exists only in the full profile.
if (PROFILE === "full") server.registerTool(
  "browser_screenshot",
  {
    description: "Screenshot the page (or one element). fullPage:true captures the whole scrollable page, not just the viewport. Returns a local file path and the image size — read that file to see the result, same pattern as figma_export_node.",
    inputSchema: { selector: z.string().optional(), fullPage: z.boolean().optional().describe("Whole page, top to bottom (ignored with a selector)") },
  },
  async ({ selector, fullPage = false }) => {
    const p = await getPage();
    const bytes = selector ? await p.locator(selector).first().screenshot() : await p.screenshot({ fullPage });
    const fileName = `${Date.now()}.png`;
    const filePath = join(EXPORTS_DIR, fileName);
    writeFileSync(filePath, bytes);
    return toolResult({ path: filePath, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
