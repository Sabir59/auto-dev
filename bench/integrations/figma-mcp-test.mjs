// Figma desktop's MCP for workers (mcp/figma-mcp-server.mjs, capability figma.mcp.read), against a
// stand-in for Figma desktop's Dev Mode MCP server: only its read tools reach a worker and only read
// tools are ever called on it; links and node ids; the design's images saved into the workspace and
// the code pointing at them; a Team run held to its own file; Figma desktop off; the console's
// per-call check; and the console's status check. No Figma account or app needed.
// With FIGMA_MCP_LIVE=1 it also reads one node from the real Figma desktop (read-only), if it's on:
//   FIGMA_MCP_LIVE=1 FIGMA_MCP_LIVE_NODE=123:456 node bench/integrations/figma-mcp-test.mjs
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { Client } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { McpServer } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js";
import { StreamableHTTPServerTransport } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js";
import { z } from "../../mcp/node_modules/zod/index.js";
import { desktopStatus } from "../../mcp/figma-desktop.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", "..");
const ROOT = join(tmpdir(), `figma-mcp-${Date.now()}`); mkdirSync(ROOT, { recursive: true });
const results = [];
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail).slice(0, 300)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 900)); }
};
const assert = (c, m) => { if (!c) throw new Error(typeof m === "string" ? m : JSON.stringify(m)); };
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

// ---- the stand-in for Figma desktop: the same tool names and output shape as Figma's server ----
const calls = [];
function figmaDesktop() {
  const s = new McpServer({ name: "Figma Dev Mode MCP Server", version: "1.0.0" });
  const node = { nodeId: z.string().optional(), clientLanguages: z.string().optional(), clientFrameworks: z.string().optional(), excludeScreenshot: z.boolean().optional(), contentsOnly: z.boolean().optional() };
  const rec = (name) => (args) => { calls.push({ name, args }); return null; };
  const port = () => server.address().port;
  s.registerTool("get_design_context", { inputSchema: node }, async (a) => { rec("get_design_context")(a); return { content: [
    { type: "text", text: `const img1 = "http://localhost:${port()}/assets/aaaa1111.png";\nexport default function Frame() { return <div data-node-id="${a.nodeId}"><img src={img1} /></div>; }` },
    { type: "text", text: "SUPER CRITICAL: convert to the target stack." },
    { type: "text", text: `Image assets are stored on a localhost server. e.g. const image = 'http://localhost:${port()}/assets/example0000.png'` },
    { type: "text", text: `Use variables like 'http://localhost:${port()}/assets/example0000.png' in prose.` },
    ...(a.excludeScreenshot ? [] : [{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }]),
    { type: "text", text: "Figma recommends using the remote MCP server for workflows between design and code: https://example.invalid/" } ] }; });
  s.registerTool("get_metadata", { inputSchema: node }, async (a) => { rec("get_metadata")(a); return { content: [{ type: "text", text: `<frame id="${a.nodeId}" name="Banner" />` }] }; });
  s.registerTool("get_variable_defs", { inputSchema: node }, async (a) => { rec("get_variable_defs")(a); return { content: [{ type: "text", text: '{"bg/secondary":"#01abe6"}' }] }; });
  s.registerTool("get_screenshot", { inputSchema: node }, async (a) => { rec("get_screenshot")(a); return { content: [{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }] }; });
  for (const w of ["add_code_connect_map", "send_code_connect_mappings"]) s.registerTool(w, { inputSchema: node }, async (a) => { rec(w)(a); return { content: [{ type: "text", text: "changed" }] }; });
  return s;
}
const server = http.createServer(async (q, r) => {
  if (q.url.startsWith("/assets/")) { if (q.url.includes("example")) { r.writeHead(500); return r.end(); } r.writeHead(200, { "content-type": "image/png" }); return r.end(PNG); }
  if (!q.url.startsWith("/mcp")) { r.writeHead(404); return r.end(); }
  let body = ""; for await (const d of q) body += d;
  const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const s = figmaDesktop(); await s.connect(t);
  r.on("close", () => { t.close(); s.close(); });
  await t.handleRequest(q, r, body ? JSON.parse(body) : undefined);
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const DESKTOP = `http://127.0.0.1:${server.address().port}/mcp`;

// A stand-in console for the per-call check (mcp/authz.mjs): all on and allowed, or everything refused.
let allow = true;
const consoleStub = http.createServer((q, s) => { s.writeHead(200, { "content-type": "application/json" });
  s.end(JSON.stringify(q.url.includes("/live") ? { live: allow ? ["figma.mcp.read"] : [], v: allow ? 1 : 2 } : allow ? { ok: true } : { ok: false, reason: "Figma desktop: Not running" })); });
await new Promise((ok) => consoleStub.listen(0, "127.0.0.1", ok));

async function proxy(env = {}) {
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(REPO, "mcp", "figma-mcp-server.mjs")], env: { ...process.env, FIGMA_DESKTOP_MCP_URL: DESKTOP, ...env } }));
  return c;
}
const texts = (r) => (r.content || []).filter((p) => p.type === "text").map((p) => p.text).join("\n");

await step("only Figma desktop's read tools reach a worker; its write tools (Code Connect) are never offered", async () => {
  const c = await proxy({ FIGMA_MCP_ASSETS_DIR: join(ROOT, "ws1", "figma-assets") });
  const names = (await c.listTools()).tools.map((t) => t.name).sort();
  await c.close();
  assert(JSON.stringify(names) === JSON.stringify(["figma_mcp_design", "figma_mcp_outline", "figma_mcp_screenshot", "figma_mcp_status", "figma_mcp_variables"]), names);
  return { tools: names };
});

await step("a design link is read by its node id; the design's images are saved into the workspace and the code points at them; Figma's notes that aren't design are dropped", async () => {
  calls.length = 0;
  const assets = join(ROOT, "ws2", "figma-assets"), c = await proxy({ FIGMA_MCP_ASSETS_DIR: assets });
  const r = await c.callTool({ name: "figma_mcp_design", arguments: { link: "https://www.figma.com/design/KEY123/Site?node-id=35499-71541&m=dev" } });
  const v = await c.callTool({ name: "figma_mcp_variables", arguments: { nodeId: "35499-71541" } });
  const o = await c.callTool({ name: "figma_mcp_outline", arguments: { nodeId: "1:2" } });
  const sh = await c.callTool({ name: "figma_mcp_screenshot", arguments: { link: "https://figma.com/design/KEY123/Site?node-id=1-2" } });
  await c.close();
  const t = texts(r), saved = existsSync(assets) ? readdirSync(assets) : [];
  assert(!r.isError && calls[0]?.name === "get_design_context" && calls[0].args.nodeId === "35499:71541", calls);
  assert(saved.join() === "aaaa1111.png" && readFileSync(join(assets, "aaaa1111.png")).equals(PNG), { saved });
  assert(t.includes(join(assets, "aaaa1111.png").replace(/\\/g, "/")) && !/assets\/aaaa1111\.png"/.test(t.replace(join(assets, "aaaa1111.png").replace(/\\/g, "/"), "")), t.slice(0, 400));
  assert(!/remote MCP server/.test(t) && !/stored on a localhost server/.test(t) && /SUPER CRITICAL/.test(t) && !/Couldn't save/.test(t) && /Saved 1 image file/.test(t), t);
  assert(r.content.some((p) => p.type === "image"), "the screenshot is passed on");
  assert(texts(v).includes("#01abe6") && texts(o).includes("Banner") && sh.content.some((p) => p.type === "image"), { v: texts(v), o: texts(o) });
  assert(calls.every((x) => x.name.startsWith("get_")), calls.map((x) => x.name));
  return { called: calls.map((x) => `${x.name}(${x.args.nodeId || "selection"})`), saved };
});

await step("bad input is refused before Figma desktop is asked: not a figma.com link, not a node id", async () => {
  calls.length = 0;
  const c = await proxy({ FIGMA_MCP_ASSETS_DIR: join(ROOT, "ws3") });
  const a = await c.callTool({ name: "figma_mcp_design", arguments: { link: "https://figma.com.evil.example/design/K/x?node-id=1-2" } });
  const b = await c.callTool({ name: "figma_mcp_design", arguments: { nodeId: "../../etc" } });
  await c.close();
  assert(a.isError && /figma\.com link/.test(texts(a)) && b.isError && /isn't a node id/.test(texts(b)) && calls.length === 0, { a: texts(a), b: texts(b), calls });
  return { link: texts(a), node: texts(b) };
});

await step("a Team run reads only its own file: another file's link and a bare node id are refused, its own link is read", async () => {
  calls.length = 0;
  const c = await proxy({ FIGMA_MCP_ASSETS_DIR: join(ROOT, "ws4"), FIGMA_ALLOWED_KEYS: "TEAMKEY" });
  const other = await c.callTool({ name: "figma_mcp_design", arguments: { link: "https://www.figma.com/design/OTHER/x?node-id=1-2" } });
  const bare = await c.callTool({ name: "figma_mcp_outline", arguments: { nodeId: "1:2" } });
  const own = await c.callTool({ name: "figma_mcp_outline", arguments: { link: "https://www.figma.com/design/TEAMKEY/x?node-id=1-2" } });
  await c.close();
  assert(other.isError && bare.isError && /Team's Figma file/.test(texts(other)) && !own.isError && calls.length === 1, { other: texts(other), bare: texts(bare), calls });
  return { refused: 2, read: calls.map((x) => x.name) };
});

await step("each call is checked with the console first: refused there, nothing reaches Figma desktop", async () => {
  calls.length = 0; allow = false;
  const c = await proxy({ FIGMA_MCP_ASSETS_DIR: join(ROOT, "ws5"), AIW_AUTHZ_URL: `http://127.0.0.1:${consoleStub.address().port}/authz/r1`, AIW_AUTHZ_TOKEN: "t", AIW_AUTHZ_SERVER: "figma-mcp" });
  const listed = (await c.listTools()).tools.length;
  allow = true;
  await new Promise((ok) => setTimeout(ok, 2600)); // the live set is polled every 2 seconds
  const on = (await c.listTools()).tools.length;
  allow = false;
  const r = await c.callTool({ name: "figma_mcp_outline", arguments: { nodeId: "1:2" } });
  await c.close(); allow = true;
  assert(listed === 0 && on === 5 && r.isError && /NOT_AUTHORIZED/.test(texts(r)) && calls.length === 0, { listed, on, r: texts(r), calls });
  return { whileOff: listed, whenOn: on, refused: texts(r).slice(0, 120) };
});

await step("Figma desktop not running: the tools say so and how to turn it on, and the console's check says Not running", async () => {
  const c = await proxy({ FIGMA_MCP_ASSETS_DIR: join(ROOT, "ws6"), FIGMA_DESKTOP_MCP_URL: "http://127.0.0.1:9/mcp" });
  const st = JSON.parse(texts(await c.callTool({ name: "figma_mcp_status", arguments: {} })));
  const r = await c.callTool({ name: "figma_mcp_design", arguments: { nodeId: "1:2" } });
  await c.close();
  const down = await desktopStatus("http://127.0.0.1:9/mcp"), up = await desktopStatus(DESKTOP), other = await desktopStatus(`http://127.0.0.1:${consoleStub.address().port}/mcp`);
  assert(st.available === false && /Dev Mode/.test(st.why) && r.isError && /isn't reachable/.test(texts(r)) && /Don't try another way in/.test(texts(r)), { st, r: texts(r) });
  assert(!down.ok && down.state === "Not running" && up.ok && up.detail === "Figma Dev Mode MCP Server" && !other.ok, { down, up, other });
  return { status: st.available, consoleCheck: { down: down.state, up: up.state, other: other.state } };
});

if (process.env.FIGMA_MCP_LIVE === "1") await step("the real Figma desktop: status, and one node's outline (read-only)", async () => {
  const c = await proxy({ FIGMA_MCP_ASSETS_DIR: join(ROOT, "live"), FIGMA_DESKTOP_MCP_URL: "http://127.0.0.1:3845/mcp" });
  const st = JSON.parse(texts(await c.callTool({ name: "figma_mcp_status", arguments: {} })));
  const o = st.available ? await c.callTool({ name: "figma_mcp_outline", arguments: process.env.FIGMA_MCP_LIVE_NODE ? { nodeId: process.env.FIGMA_MCP_LIVE_NODE } : {} }) : null;
  await c.close();
  assert(st.available && o && !o.isError && texts(o).length > 0, { st, o: o && texts(o).slice(0, 300) });
  return { server: st.server, outlineChars: texts(o).length };
});

server.close(); consoleStub.close();
const ok = results.every((r) => r.ok);
writeFileSync(join(HERE, "figma-mcp-results.json"), JSON.stringify({ when: new Date().toISOString(), ok, results }, null, 1));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(ok ? 0 : 1);
