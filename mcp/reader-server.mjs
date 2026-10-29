#!/usr/bin/env node
// Figma Reader as an MCP server: read a design from a Figma URL through Figma's REST API, with
// the authorization a person gave on this computer (figma-reader/README.md). Read-only; no
// plugin, no open Figma window. Changing a design stays with the Figma Executor (server.mjs).
//
// Access is Figma's: the tool reads only what the authorized Figma account can open. With no
// authorization, or a file that account can't see, the tool says so and what's needed. It never
// tries another way in.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { guardTools } from "./authz.mjs";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFigmaUrl, readNodes, readFile, renderNodes, download, outline, api, CRED_FILE } from "../figma-reader/reader.mjs";

const text = (t) => ({ content: [{ type: "text", text: t }] });
const refuse = (t) => ({ isError: true, content: [{ type: "text", text: t }] });
const NO_AUTH = "Figma authorization is missing on this computer, so this worker can't read Figma files. Someone with access to the design must connect Figma once (figma-reader/README.md). A Figma link alone does not grant access. Stop and ask for that authorization instead of trying another way.";
const ALLOWED_KEYS = (process.env.FIGMA_READER_ALLOWED_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
const authorized = () =>!!process.env.FIGMA_TOKEN || existsSync(CRED_FILE);
// FIGMA_READER_ALT: the console also gave this run Figma desktop's MCP (figma_mcp_* tools), which
// reads what the person sees in Figma desktop; Figma's API refuses some files it can show there.
const ALT = process.env.FIGMA_READER_ALT === "figma-mcp";
const figmaSays = (e) => e.message.match(/\((?:403|404)\): (.*?)\. The token's user/)?.[1] || "";
const explain = (e, ref) => e.status === 401 ? "Figma rejected the stored authorization (expired or revoked). Someone with access must connect Figma again. Don't try another way in."
  : /not exportable/i.test(figmaSays(e))
  ? `Figma says this file is "not exportable": its owner turned off copy and export for viewers, and the connected account is a viewer, so Figma's API refuses it whatever the token. ${ALT ? "Use the figma_mcp_* tools for this file instead (figma_mcp_status first): they read it through Figma desktop, where the person has it open." : "The owner must give the account edit access or turn on \"Viewers can copy, share and export\"; or give this worker the Figma desktop (Dev Mode MCP) tool."} File key: ${ref.fileKey}`
  : e.status === 403 || e.status === 404
  ? `The connected Figma account can't open this file (${e.status}${figmaSays(e) ? `: Figma says "${figmaSays(e)}"` : ""}). The file's owner must share it with that account (or a person who can open it must connect their own Figma account).${ALT ? " If the person has it open in Figma desktop, the figma_mcp_* tools can read it there." : " Don't try another way in."} File key: ${ref.fileKey}`
  : e.status === 429 ? `Figma's rate limit for this file was reached: ${e.message}. Try later or ask for a Figma seat with higher limits.`
  : `Figma API error: ${e.message}`;

const server = new McpServer({ name: "figma-reader", version: "0.1.0" });
// Each tool call is checked with the console first when it runs this server for a worker (authz.mjs).
guardTools(server, () => "figma.read");

server.registerTool("figma_access_status", {
  description: "Check whether this computer has a working Figma authorization for reading designs by URL, and which Figma account it acts as. Call this before promising anything that needs Figma.",
}, async () => {
  if (!authorized()) return text(JSON.stringify({ authorized: false, why: NO_AUTH }));
  try { const me = await api("/v1/me"); return text(JSON.stringify({ authorized: true, account: me.handle, email: me.email })); }
  catch (e) { return text(JSON.stringify({ authorized: false, why: e.status === 401 || e.status === 403 ? "The stored Figma authorization was rejected (expired or revoked). Someone must connect Figma again." : e.message })); }
});

server.registerTool("figma_read_design", {
  description: "Read a Figma design from its URL (https://www.figma.com/design/<key>/...?node-id=...): returns a compact outline of the node (sizes, layout, colours, text and type styles, effects, components) and a render image. Uses the person's Figma authorization; reads only files that account can open. Each call costs Figma two 'Tier 1' requests, which are scarce on some plans: read the node you need, not the whole file.",
  inputSchema: { url: z.string().describe("A figma.com design/file link; include ?node-id= to read one frame or layer"), render: z.boolean().optional().describe("Include a PNG render (default true)") },
}, async ({ url, render = true }) => {
  let ref; try { ref = parseFigmaUrl(url); } catch (e) { return refuse(e.message); }
  // In a Team's run, only the Team's Figma file (set by the console); checked before anything else.
  if (ALLOWED_KEYS.length && !ALLOWED_KEYS.includes(ref.fileKey)) return refuse(`Refused: this run may only read the Team's Figma file (${ALLOWED_KEYS.join(", ")}). ${ref.fileKey} is another file.`);
  if (!authorized()) return refuse(NO_AUTH);
  try {
    let target = ref.nodeId;
    if (!target) { const f = await readFile(ref.fileKey, { depth: 2 }); target = f.document.children.find((p) => p.children?.length)?.children[0]?.id; if (!target) return text(`"${f.name}" has no frames.`); }
    const res = await readNodes(ref.fileKey, [target]);
    const node = res.nodes?.[target];
    if (!node) return refuse(`Node ${target} isn't in this file, or the connected account can't see it.`);
    const o = outline(node.document, { components: node.components, styles: node.styles });
    const content = [{ type: "text", text: `# ${res.name} (file ${ref.fileKey}, version ${res.version})\nNode ${target}: ${node.document.name}, ${o.nodes} nodes${o.truncated ? " (truncated)" : ""}\n\n${o.text}` }];
    if (render) {
      const img = await renderNodes(ref.fileKey, [target], { format: "png", scale: 1 });
      if (img.images?.[target]) { const p = await download(img.images[target], join(tmpdir(), `figma-render-${ref.fileKey}-${target.replace(/\W/g, "_")}.png`)); content.push({ type: "image", data: readFileSync(p).toString("base64"), mimeType: "image/png" }); }
    }
    return { content };
  } catch (e) { return refuse(explain(e, ref)); }
});

await server.connect(new StdioServerTransport());
