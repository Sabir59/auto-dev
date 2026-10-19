// The local access boundaries a worker or a web page could otherwise cross, tested without a model:
//  - the Figma bridge (an isolated instance on port 8788) refuses web pages and foreign Host names,
//    and accepts local programs and the plugin's sandboxed iframe (Origin "null");
//  - the browser adapter (the real MCP server, full profile, started in a "workspace" folder) can't
//    reach the platform's own ports by any route, and opens file:// only inside its workspace.
//   node bench/security/local-boundaries-test.mjs
import { Client } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import http from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", "..");
const WebSocket = createRequire(join(REPO, "bridge", "package.json"))("ws");
const must = (c, m) => { if (!c) throw new Error(m); };
const results = [];
const step = async (name, fn) => { try { const d = await fn(); results.push({ step: name, ok: true, detail: d }); console.log("PASS", name, JSON.stringify(d).slice(0, 220)); } catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 300)); } };
const BP = 8788, SVC = 8781, WEBP = 8782; // test bridge, a stand-in "console" (blocked), an ordinary local site (allowed)

// ---- the bridge
const bridge = spawn(process.execPath, [join(REPO, "bridge", "server.js")], { env: { ...process.env, FIGMA_BRIDGE_PORT: String(BP) }, stdio: "ignore" });
for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${BP}/status`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
const post = (path, headers = {}) => new Promise((ok) => { const r = http.request({ host: "127.0.0.1", port: BP, path, method: "POST", headers: { "content-type": "application/json", ...headers } }, (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => ok({ status: res.statusCode, body: b })); }); r.end('{"type":"PING"}'); });
const wsTry = (headers) => new Promise((ok) => { const s = new WebSocket(`ws://127.0.0.1:${BP}/ws`, { headers }); s.on("open", () => { s.close(); ok("open"); }); s.on("unexpected-response", (_, res) => ok(res.statusCode)); s.on("error", (e) => ok("error " + e.message)); });
try {
  await step("bridge: a web page's command is refused; a local program's goes through (no plugin here: 503)", async () => {
    const page = await post("/command", { origin: "https://evil.example" }), local = await post("/command"), stop = await post("/shutdown", { origin: "http://localhost:3000" });
    const still = (await fetch(`http://127.0.0.1:${BP}/status`)).status;
    must(page.status === 403 && local.status === 503 && stop.status === 403 && still === 200, JSON.stringify({ page, local, stop, still }));
    return { webPage: page.status, localProgram: local.status, webPageShutdown: stop.status, bridgeStillUp: true };
  });
  await step("bridge: a DNS-rebinding style Host is refused", async () => {
    const r = await post("/command", { host: `attacker.example:${BP}` });
    must(r.status === 403 && /Host/.test(r.body), r.body);
    return { status: r.status };
  });
  await step("bridge: the plugin's WebSocket (Origin null) and local programs connect; a web page's is refused", async () => {
    const page = await wsTry({ origin: "https://evil.example" }), plugin = await wsTry({ origin: "null" }), local = await wsTry({});
    must([401, 403].includes(page) && plugin === "open" && local === "open", JSON.stringify({ page, plugin, local }));
    return { webPage: page, figmaPluginOriginNull: plugin, localProgram: local };
  });

  // ---- the browser adapter
  const hits = []; // anything reaching the stand-in "console"
  const svc = http.createServer((req, res) => { hits.push(req.url); res.end("<title>CONSOLE</title>console data"); }).listen(SVC, "127.0.0.1");
  const web = http.createServer((req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { location: `http://127.0.0.1:${SVC}/runs` }); return res.end(); }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<title>site</title><p id="t">site</p><iframe src="http://127.0.0.1:${SVC}/frame"></iframe>
      <script>fetch("http://localhost:${SVC}/fetch").catch(()=>{}); const w=new WebSocket("ws://127.0.0.1:${BP}/ws"); w.onopen=()=>document.title="ws-open"; w.onerror=w.onclose=()=>{ if(document.title!=="ws-open") document.title="ws-blocked"; };</script>`);
  }).listen(WEBP, "127.0.0.1");
  const ws = mkdtempSync(join(tmpdir(), "bws-")), outside = mkdtempSync(join(tmpdir(), "bout-"));
  writeFileSync(join(ws, "page.html"), "<title>inside</title>inside the workspace"); writeFileSync(join(outside, "secret.txt"), "TOP-SECRET");
  const mcp = new Client({ name: "boundaries", version: "1" });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [join(REPO, "browser-adapter", "server.mjs")], cwd: ws, env: { ...process.env, BROWSER_EXECUTOR_PROFILE: "full", BROWSER_BLOCK_PORTS: `${SVC},${BP}` } }));
  const call = async (name, args = {}) => { const r = await mcp.callTool({ name, arguments: args }); return { isError: !!r.isError, text: r.content?.[0]?.text || "" }; };
  try {
    await step("browser: the platform's ports can't be opened, however the address is written", async () => {
      const urls = [`http://127.0.0.1:${SVC}/`, `http://localhost:${SVC}/file?path=x`, `http://[::1]:${SVC}/`, `http://127.1:${SVC}/`, `http://0x7f000001:${SVC}/`, `http://foo.localhost:${SVC}/`, `http://127.0.0.1:${BP}/status`];
      const r = await Promise.all(urls.map((url) => call("browser_navigate", { url })));
      must(r.every((x) => x.isError && /own local service/.test(x.text)) && hits.length === 0, JSON.stringify({ r: r.map((x) => x.text.slice(0, 80)), hits }));
      return { refused: urls.length, requestsThatArrived: hits.length };
    });
    await step("browser: an ordinary local site works; its frame, script fetch and WebSocket to the platform are blocked", async () => {
      const r = await call("browser_navigate", { url: `http://127.0.0.1:${WEBP}/` });
      await new Promise((x) => setTimeout(x, 1500));
      const dom = await call("browser_get_dom_state", { selector: "#t" }), status = await (await fetch(`http://127.0.0.1:${BP}/status`)).json(), title = JSON.parse(dom.text).text;
      const pageTitle = JSON.parse(r.text).title;
      must(!r.isError && title === "site" && hits.length === 0 && status.pluginConnected === false && pageTitle !== "ws-open", JSON.stringify({ r: r.text, hits, status }));
      return { siteOpened: true, frameAndFetchArrived: hits.length, pageWebSocket: pageTitle, bridgeTakenOver: status.pluginConnected };
    });
    await step("browser: a redirect into the platform is caught; the page is reset and nothing is returned", async () => {
      const r = await call("browser_navigate", { url: `http://127.0.0.1:${WEBP}/redirect` }), dom = await call("browser_get_dom_state");
      must(r.isError && /reset to about:blank/.test(r.text) && !/console data/.test(dom.text), JSON.stringify({ r: r.text, dom: dom.text.slice(0, 200) }));
      return { refused: r.text.slice(0, 90), contentReturned: false, redirectedGetArrived: hits.length, note: "a redirect is followed by the browser itself: the GET reaches the service once; its answer never reaches the worker" };
    });
    await step("browser: file pages only inside the workspace (no other files, no folder listings outside it)", async () => {
      const inside = await call("browser_navigate", { url: pathToFileURL(join(ws, "page.html")).href });
      const secret = await call("browser_navigate", { url: pathToFileURL(join(outside, "secret.txt")).href }), parent = await call("browser_navigate", { url: pathToFileURL(dirname(ws)).href });
      const dom = await call("browser_get_dom_state");
      must(!inside.isError && secret.isError && parent.isError && !/TOP-SECRET/.test(dom.text), JSON.stringify({ inside: inside.text, secret: secret.text, parent: parent.text }));
      return { insideWorkspace: "opened", outside: secret.text.slice(0, 80), parentFolder: "refused" };
    });
  } finally { await mcp.close(); svc.close(); web.close(); }
  await step("bridge: the dashboard's stop (devctl sends the bridge's own origin) still works", async () => {
    const r = await post("/shutdown", { origin: `http://127.0.0.1:${BP}` });
    await new Promise((x) => setTimeout(x, 500));
    const after = await fetch(`http://127.0.0.1:${BP}/status`).then(() => "still up", () => "stopped");
    must(r.status === 200 && after === "stopped", JSON.stringify({ r, after }));
    return { status: r.status, bridge: after };
  });
} finally { bridge.kill(); }
mkdirSync(HERE, { recursive: true });
writeFileSync(join(HERE, "local-boundaries-results.json"), JSON.stringify({ when: new Date().toISOString(), results }, null, 1));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
