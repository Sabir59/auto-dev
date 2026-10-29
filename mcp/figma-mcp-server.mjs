#!/usr/bin/env node
// Figma desktop's own MCP server (Dev Mode, http://127.0.0.1:3845/mcp) for workers, read-only.
// The worker never talks to Figma's server directly: this server passes on only its read tools
// (design context, variables, screenshot, outline) and never its write tools (Code Connect
// mappings), so a worker can't change anything in Figma through it. Images the design uses are
// served by Figma desktop on localhost; they're saved into FIGMA_MCP_ASSETS_DIR (the run's
// workspace, figma-assets/) and the design's code points at those files instead.
//
// Access is the person's: Figma desktop reads the file open in it, as the person signed in there
// (with a Dev seat, a view-only file can be read this way even when "copy and export" is off for
// viewers, which blocks Figma's REST API). Figma desktop's server doesn't say which file is open;
// the tools say that, and in a Team run (FIGMA_ALLOWED_KEYS) a link to another file is refused.
// Nothing here starts Figma or opens a file: when it isn't available, the tools say what the
// person has to do.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { guardTools } from "./authz.mjs";
import { z } from "zod";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DESKTOP_MCP_URL, SETUP } from "./figma-desktop.mjs";

const ASSETS_DIR = process.env.FIGMA_MCP_ASSETS_DIR || "";
const ALLOWED_KEYS = (process.env.FIGMA_ALLOWED_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
const text = (t) => ({ content: [{ type: "text", text: t }] });
const refuse = (t) => ({ isError: true, content: [{ type: "text", text: t }] });
const OPEN_FILE = "Figma desktop reads the file that's open and in front in the app; it doesn't report which file that is, so check the frame names match the design you were given.";

let client = null;
async function desktop() {
  if (client) return client;
  const c = new Client({ name: "ai-workforce-figma-mcp", version: "1.0.0" });
  try { await c.connect(new StreamableHTTPClientTransport(new URL(DESKTOP_MCP_URL))); }
  catch (e) { throw Object.assign(new Error(`Figma desktop's MCP server isn't reachable (${e.cause?.code || e.message}). ${SETUP} Don't try another way in.`), { setup: true }); }
  c.onclose = () => { client = null; };
  return (client = c);
}

// "35499-70295", "35499:70295" or a figma.com link with ?node-id=…; "" = the current selection.
function target({ link, nodeId }) {
  let key = null, node = nodeId ? String(nodeId).trim() : "";
  if (link) {
    let u; try { u = new URL(link); } catch { throw new Error("That isn't a link. Give a figma.com design link, or a node id like 123:456."); }
    if (!/(^|\.)figma\.com$/.test(u.hostname)) throw new Error("That isn't a figma.com link.");
    key = u.pathname.match(/\/(?:design|file|proto|board)\/([A-Za-z0-9]+)/)?.[1] || null;
    node = node || u.searchParams.get("node-id") || "";
  }
  node = node.replace("-", ":");
  if (node && !/^\d+:\d+$/.test(node)) throw new Error(`"${node}" isn't a node id (like 123:456).`);
  if (ALLOWED_KEYS.length && (!key || !ALLOWED_KEYS.includes(key))) throw new Error(`Refused: this run may only read the Team's Figma file (${ALLOWED_KEYS.join(", ")}). Give its link with the node-id.`);
  return { key, node };
}

// Figma desktop serves the design's images at http://localhost:3845/assets/<hash>.<ext>: save each
// into the assets folder and point the code at the saved file.
async function saveAssets(s) {
  const urls = [...new Set(s.match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/assets\/[\w-]+\.\w{2,5}/g) || [])];
  if (!urls.length || !ASSETS_DIR) return { text: s, saved: [] };
  mkdirSync(ASSETS_DIR, { recursive: true });
  const base = new URL(DESKTOP_MCP_URL), saved = [], failed = [];
  for (const u of urls) {
    const name = u.split("/").pop(), to = join(ASSETS_DIR, name);
    try {
      if (!existsSync(to)) {
        const src = new URL(u); src.protocol = base.protocol; src.host = base.host; // the server we were given, whatever host it wrote
        const r = await fetch(src, { signal: AbortSignal.timeout(30000) });
        if (!r.ok) throw new Error(String(r.status));
        writeFileSync(to, Buffer.from(await r.arrayBuffer()));
      }
      s = s.split(u).join(to.replace(/\\/g, "/")); saved.push(to);
    } catch (e) { failed.push(`${name} (${e.message})`); }
  }
  return { text: s, saved, failed };
}

async function call(name, args) {
  let c; try { c = await desktop(); } catch (e) { return refuse(e.message); }
  let r;
  try { r = await c.callTool({ name, arguments: args }, undefined, { timeout: 120000 }); }
  catch (e) { client = null; try { await c.close(); } catch {} return refuse(`Figma desktop's MCP server stopped answering (${e.message}). ${SETUP}`); }
  const out = [];
  for (const part of r.content || []) {
    if (part.type !== "text") { out.push(part); continue; }
    if (/remote MCP server/i.test(part.text) && part.text.length < 300) continue; // Figma's own advert, not design
    if (/^Image assets are stored on a localhost server/i.test(part.text)) continue; // not true here: they're saved files now
    if (!/data-node-id=/.test(part.text)) { out.push(part); continue; } // only the design's code names its images
    const a = await saveAssets(part.text);
    out.push({ type: "text", text: a.text });
    if (a.saved.length) out.push({ type: "text", text: `Saved ${a.saved.length} image file(s) the design uses into ${ASSETS_DIR.replace(/\\/g, "/")} (the paths above point at them).${a.failed?.length ? ` Not saved: ${a.failed.join(", ")}.` : ""}` });
    else if (a.failed?.length) out.push({ type: "text", text: `Couldn't save the design's images: ${a.failed.join(", ")}.` });
  }
  return { ...(r.isError ? { isError: true } : {}), content: out.length ? out : [{ type: "text", text: "(Figma desktop returned nothing for this node.)" }] };
}

const server = new McpServer({ name: "figma-mcp", version: "1.0.0" });
// Each tool call is checked with the console first when it runs this server for a worker (authz.mjs).
guardTools(server, () => "figma.mcp.read");

const where = { link: z.string().optional().describe("The figma.com link of the frame or layer (with ?node-id=…)"), nodeId: z.string().optional().describe("Or its node id, like 123:456. With neither, Figma desktop uses the person's current selection.") };
const go = (fn) => async (args) => { let t; try { t = target(args); } catch (e) { return refuse(e.message); } return fn(t, args); };
const LANG = { clientLanguages: "html,css,javascript", clientFrameworks: "react" };

server.registerTool("figma_mcp_status", {
  description: "Check whether Figma desktop's MCP server (Dev Mode) is running, so the other figma_mcp_* tools can read the file open in Figma desktop. Read-only.",
}, async () => {
  try { const c = await desktop(); const v = c.getServerVersion(); return text(JSON.stringify({ available: true, server: v?.name, version: v?.version, note: OPEN_FILE })); }
  catch (e) { return text(JSON.stringify({ available: false, why: e.message })); }
});

server.registerTool("figma_mcp_design", {
  description: `Read a Figma frame or layer through Figma desktop (Dev Mode MCP): reference code (React + Tailwind) with exact sizes, spacing, colours, fonts and text, plus a screenshot. Images it uses are saved into the workspace (figma-assets/) and the code points at them. Use it for one section at a time on large pages (figma_mcp_outline gives the section ids). Read-only. ${OPEN_FILE}`,
  inputSchema: { ...where, screenshot: z.boolean().optional().describe("Include the screenshot (default true)") },
}, go(({ node }, { screenshot = true }) => call("get_design_context", { ...(node ? { nodeId: node } : {}), ...LANG, ...(screenshot ? {} : { excludeScreenshot: true }) })));

server.registerTool("figma_mcp_outline", {
  description: `The structure of a Figma frame or page through Figma desktop: node ids, layer types, names, positions and sizes (no styles). Use it to find the sections of a large frame, then read each with figma_mcp_design. Read-only. ${OPEN_FILE}`,
  inputSchema: where,
}, go(({ node }) => call("get_metadata", { ...(node ? { nodeId: node } : {}), ...LANG })));

server.registerTool("figma_mcp_variables", {
  description: `The design variables (colours, fonts, spacing, effects) a Figma frame or layer uses, with their values, through Figma desktop. Read-only. ${OPEN_FILE}`,
  inputSchema: where,
}, go(({ node }) => call("get_variable_defs", { ...(node ? { nodeId: node } : {}), ...LANG })));

server.registerTool("figma_mcp_screenshot", {
  description: `A screenshot of a Figma frame or layer, through Figma desktop, to compare your result with. Read-only. ${OPEN_FILE}`,
  inputSchema: where,
}, go(({ node }) => call("get_screenshot", node ? { nodeId: node } : {})));

await server.connect(new StdioServerTransport());
