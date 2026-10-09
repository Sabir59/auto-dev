// The browser adapter's capture options, through its real MCP server: a viewport size on
// browser_navigate (kept for later calls), waitUntil networkidle, and fullPage screenshots with
// their real pixel size; the inspect profile still has no screenshot tool.
//   node bench/browser/capture-test.mjs
import { Client } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", "..");
// A 2000px-tall page whose content reports the viewport it was laid out in.
const PAGE = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}div{height:2000px;background:linear-gradient(#01abe6,#0d2053)}</style><div id="tall"></div><p id="vw"></p><script>document.getElementById("vw").textContent=innerWidth+"x"+innerHeight</script>`;
const site = http.createServer((q, s) => { s.writeHead(200, { "content-type": "text/html" }); s.end(PAGE); });
await new Promise((ok) => site.listen(0, "127.0.0.1", ok));
const URL_ = `http://127.0.0.1:${site.address().port}/`;
const results = [];
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail).slice(0, 220)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 300)); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
async function connect(profile) {
  const client = new Client({ name: "capture-test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(REPO, "browser-adapter", "server.mjs")], env: { ...process.env, BROWSER_EXECUTOR_PROFILE: profile }, cwd: join(REPO, "browser-adapter") }));
  const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); const t = r.content.map((c) => c.text).join(""); return { isError: !!r.isError, json: (() => { try { return JSON.parse(t); } catch { return t; } })() }; };
  return { client, call };
}
const png = (p) => { const b = readFileSync(p); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };
const F = await connect("full");

await step("mobile viewport (390x844) + networkidle: the page is laid out at that size", async () => {
  const n = await F.call("browser_navigate", { url: URL_, viewport: { width: 390, height: 844 }, waitUntil: "networkidle" });
  const vw = await F.call("browser_get_dom_state", { selector: "#vw" });
  assert(n.json.viewport.width === 390 && vw.json.text === "390x844", JSON.stringify({ n: n.json, vw: vw.json.text }));
  return { viewport: n.json.viewport, pageSaw: vw.json.text };
});

await step("fullPage screenshot: the whole 2000px page at 390 wide; plain screenshot: the viewport only", async () => {
  const full = await F.call("browser_screenshot", { fullPage: true });
  const view = await F.call("browser_screenshot", {});
  const a = png(full.json.path), b = png(view.json.path);
  assert(a.w === 390 && a.h >= 2000 && full.json.width === a.w && full.json.height === a.h, JSON.stringify({ full: a, reported: full.json }));
  assert(b.w === 390 && b.h === 844, JSON.stringify(b));
  return { fullPage: a, viewportOnly: b };
});

await step("the viewport is kept for later navigations; a new one replaces it (1440x900)", async () => {
  await F.call("browser_navigate", { url: URL_ });
  const kept = (await F.call("browser_get_dom_state", { selector: "#vw" })).json.text;
  await F.call("browser_navigate", { url: URL_, viewport: { width: 1440, height: 900 }, waitUntil: "load" });
  const full = await F.call("browser_screenshot", { fullPage: true });
  assert(kept === "390x844" && png(full.json.path).w === 1440, JSON.stringify({ kept, full: png(full.json.path) }));
  return { kept, desktopFullPage: png(full.json.path) };
});

await step("invalid viewport sizes are refused", async () => {
  const r = await F.call("browser_navigate", { url: URL_, viewport: { width: 50, height: 844 } });
  assert(r.isError, JSON.stringify(r.json));
  return { refused: String(r.json).slice(0, 80) };
});
await F.client.close();

await step("inspect profile: viewport works, but there is still no screenshot tool", async () => {
  const I = await connect("inspect");
  const tools = (await I.client.listTools()).tools.map((t) => t.name);
  const n = await I.call("browser_navigate", { url: URL_, viewport: { width: 390, height: 844 } });
  await I.client.close();
  assert(!tools.includes("browser_screenshot") && n.json.viewport.width === 390, JSON.stringify({ tools, n: n.json }));
  return { tools };
});

site.close();
writeFileSync(join(HERE, "capture-results.json"), JSON.stringify({ when: new Date().toISOString(), results }, null, 1));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
if (results.some((r) => !r.ok)) process.exitCode = 1;
