// The Figma Executor's lifecycle without a person in the loop, as far as Figma allows: the bridge
// starts itself, reports what's connected, routes each command to the right file's plugin, notices a
// plugin that drops (or stops answering), recovers when the bridge restarts, and refuses what a run
// may not do. A REAL bridge (bridge/server.js, on its own port) and the REAL MCP server
// (mcp/server.mjs, over stdio), with FAKE plugins: WebSocket clients that behave like plugin/ui.html.
// Nothing touches Figma, so this proves the plumbing, not Figma itself (see live-batch-test.mjs).
//   node bench/figma-executor/lifecycle-test.mjs
import { Client } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import http from "node:http";
import { createRequire } from "node:module";
import { writeFileSync, mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureBridge, bridgeStatus } from "../../bridge/launcher.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", "..");
const WebSocket = createRequire(join(REPO, "bridge", "package.json"))("ws");
const must = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const PORT = 8790, BASE = `http://localhost:${PORT}`, URL_ = `${BASE}/command`;
const FILE_A = { fileName: "Alpha", fileKey: "AAAAAAAAAAAAAAAAAAAAAA" }, FILE_B = { fileName: "Beta", fileKey: "BBBBBBBBBBBBBBBBBBBBBB" };
const results = [];
const step = async (name, fn) => { try { const d = await fn(); results.push({ step: name, ok: true, detail: d }); console.log("PASS", name, JSON.stringify(d).slice(0, 240)); } catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 400)); } };

// ---- a fake plugin: plugin/ui.html's socket behaviour (hello with its file, reconnect with backoff),
// answering commands from an in-memory document. hang: never answers (to test disconnects).
function fakePlugin(file, { reconnect = true, autoPong = true, hang = [], fail = {} } = {}) {
  const p = { file, received: [], nodes: new Map(), seq: 1, socket: null, closed: false, connects: 0 };
  const answer = (msg) => {
    const reply = (ok, x) => p.socket.send(JSON.stringify(ok ? { id: msg.id, ok: true, result: x } : { id: msg.id, ok: false, error: x }));
    if (hang.includes(msg.type)) return;
    if (fail[msg.type]) return reply(false, fail[msg.type]);
    const n = msg.params?.id && p.nodes.get(msg.params.id);
    switch (msg.type) {
      case "PING": return reply(true, { pong: true });
      case "GET_FILE_INFO": return reply(true, { ...file, editorType: "figma", currentPage: { id: "0:1", name: "Page" } });
      case "CREATE_FRAME": { const id = `${file.fileKey.slice(0, 1)}:${p.seq++}`; p.nodes.set(id, { id, name: msg.params.name || "Frame", type: "FRAME", x: 0, y: 0, width: msg.params.width || 100, height: msg.params.height || 100, fills: [{ type: "SOLID", hex: "#ffffff" }] }); return reply(true, { id, name: msg.params.name || "Frame", summary: "SUCCESS: Created frame" }); }
      case "MODIFY_NODE": if (!n) return reply(false, `Node not found: ${msg.params.id}`); Object.assign(n, msg.params.props || {}); return reply(true, { id: n.id, summary: "SUCCESS: modified" });
      case "GET_DOCUMENT_STATE": if (!n) return reply(false, `Node not found: ${msg.params.id}`); return reply(true, { node: n });
      default: return reply(false, `Unknown command type: ${msg.type}`);
    }
  };
  const connect = () => {
    if (p.closed) return;
    const s = new WebSocket(`ws://localhost:${PORT}/ws`, { autoPong });
    s.on("open", () => { p.socket = s; p.connects++; s.send(JSON.stringify({ type: "__hello__", role: "plugin", file: { ...file, editorType: "figma", rootId: "0:0" } })); });
    s.on("message", (raw) => { const msg = JSON.parse(raw.toString()); p.received.push(msg.type); answer(msg); });
    s.on("close", () => { if (p.socket === s) p.socket = null; if (reconnect && !p.closed) setTimeout(connect, 300); });
    s.on("error", () => {});
  };
  p.close = () => { p.closed = true; p.socket?.close(); };
  p.drop = () => p.socket?.terminate(); // the iframe going away; reconnects if reconnect
  connect();
  return p;
}
const until = async (fn, ms = 8000, what = "condition") => { for (const t = Date.now() + ms; Date.now() < t; await sleep(100)) if (await fn()) return; throw new Error(`timed out waiting for ${what}`); };
const shutdown = async () => { try { await fetch(`${BASE}/shutdown`, { method: "POST" }); } catch {} await until(async () => !(await bridgeStatus(BASE, { timeout: 300 })).reachable, 5000, "bridge to stop"); };

const connect = async (env = {}) => {
  const c = new Client({ name: "lifecycle-test", version: "1" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(REPO, "mcp", "server.mjs")], env: { ...process.env, FIGMA_BRIDGE_URL: URL_, FIGMA_BRIDGE_AUTOSTART: "1", FIGMA_PLUGIN_WAIT_MS: "6000", ...env } }));
  const call = async (name, args = {}) => { const r = await c.callTool({ name, arguments: args }); const text = r.content?.[0]?.text || ""; let json = null; try { json = JSON.parse(text); } catch {} return { isError: !!r.isError, text, json }; };
  return { c, call, close: () => c.close() };
};

if ((await bridgeStatus(BASE, { timeout: 500 })).reachable) await shutdown();
const plugins = [];
try {
  const mcp = await connect();

  await step("1. no bridge running: the first status call starts it; the plugin isn't running, and only the person can fix that", async () => {
    must(!(await bridgeStatus(BASE)).reachable, "a bridge was already running");
    const r = await mcp.call("figma_executor_status");
    const s = await bridgeStatus(BASE);
    must(r.json.bridge.started === true && s.isBridge && !s.outdated, JSON.stringify(r.json));
    must(r.json.state === "PLUGIN_NOT_CONNECTED" && r.json.ready === false && r.json.userActionRequired === true && /run Plugins → Development → AI Executor/.test(r.json.nextStep), JSON.stringify(r.json));
    return { state: r.json.state, started: r.json.bridge.started, pid: r.json.bridge.pid, nextStep: r.json.nextStep.slice(0, 90) };
  });

  await step("2. health: /status is machine-readable (protocol, pid, sessions, last disconnect)", async () => {
    const j = await (await fetch(`${BASE}/status`)).json();
    must(j.bridge === "figma-ai-executor" && j.protocol === 2 && j.pid && j.pluginConnected === false && Array.isArray(j.sessions) && j.lastDisconnect === null, JSON.stringify(j));
    return j;
  });

  await step("3. an edit with no plugin fails with PLUGIN_NOT_CONNECTED (after a short wait, since the bridge just started); nothing claims success", async () => {
    const t = Date.now(), r = await mcp.call("figma_create_frame", { name: "X" });
    must(r.isError && /^PLUGIN_NOT_CONNECTED:/.test(r.text) && Date.now() - t < 10000, r.text);
    return { error: r.text.slice(0, 120), ms: Date.now() - t };
  });

  const a = fakePlugin(FILE_A); plugins.push(a);
  await until(async () => (await bridgeStatus(BASE)).status?.sessions?.length === 1, 5000, "plugin A to connect");

  await step("4. a plugin connects: status READY names its file; an edit goes through and says which file it hit", async () => {
    const st = await mcp.call("figma_executor_status");
    must(st.json.state === "READY" && st.json.canEdit && st.json.plugin.sessions[0].fileKey === FILE_A.fileKey && st.json.plugin.sessions[0].fileName === "Alpha", JSON.stringify(st.json));
    const r = await mcp.call("figma_create_frame", { name: "Hero", width: 400, height: 200 });
    must(!r.isError && r.json.id && a.received.includes("CREATE_FRAME"), r.text);
    const raw = await (await fetch(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "PING" }) })).json();
    must(raw.file?.fileKey === FILE_A.fileKey, JSON.stringify(raw));
    return { state: st.json.state, created: r.json.id, routedTo: raw.file };
  });

  await step("5. a refused write is an error with Figma's reason (COMMAND_FAILED), never a success", async () => {
    const r = await mcp.call("figma_modify_node", { id: "9:999", props: { name: "nope" } });
    must(r.isError && /^COMMAND_FAILED: Node not found: 9:999/.test(r.text), r.text);
    return { error: r.text };
  });

  await step("6. verification reads the node back: matching values pass, a wrong one is reported with expected vs actual", async () => {
    const id = [...a.nodes.keys()][0];
    const good = await mcp.call("figma_verify_nodes", { checks: [{ id, expect: { name: "Hero", width: 400, height: 200.3, fill: "#FFFFFF" } }] });
    const bad = await mcp.call("figma_verify_nodes", { checks: [{ id, expect: { name: "Footer" } }, { id: "9:999" }] });
    must(good.json.verified === true && good.json.failed === 0, good.text);
    must(bad.json.verified === false && bad.json.results[0].mismatches[0].actual === "Hero" && bad.json.results[1].exists === false, bad.text);
    return { good: good.json.verified, bad: bad.json.results.map((x) => x.mismatches || x.error?.slice(0, 40)) };
  });

  await step("7. figma_batch verify:true reads back every node it made or changed, and reports one that isn't there", async () => {
    const ok = await mcp.call("figma_batch", { ops: [{ tool: "create_frame", ref: "s", args: { name: "S" } }, { tool: "modify_node", args: { id: "$s", props: { name: "S2" } } }], verify: true });
    must(ok.json.ok === 2 && ok.json.readBack?.verified === true && ok.json.readBack.checked === 1, ok.text);
    // the plugin "loses" the node it reports creating: confirmation without the document holding it
    const orig = a.nodes.set.bind(a.nodes); a.nodes.set = (k, v) => (v.name === "Ghost" ? a.nodes : orig(k, v));
    const ghost = await mcp.call("figma_batch", { ops: [{ tool: "create_frame", args: { name: "Ghost" } }], verify: true });
    a.nodes.set = orig;
    must(ghost.json.ok === 1 && ghost.json.readBack.verified === false && ghost.json.readBack.failed[0].exists === false, ghost.text);
    return { verified: ok.json.readBack, ghost: ghost.json.readBack };
  });

  await step("8. the plugin drops mid-command: the call fails at once with PLUGIN_DISCONNECTED (outcome unknown), not after 30s", async () => {
    const h = fakePlugin(FILE_B, { reconnect: false, hang: ["CREATE_FRAME"] }); plugins.push(h);
    await until(async () => (await bridgeStatus(BASE)).status?.sessions?.length === 2, 5000, "plugin B");
    const b = await connect({ FIGMA_EXPECTED_FILE_KEY: FILE_B.fileKey });
    const t = Date.now(), pending = b.call("figma_create_frame", { name: "Slow" });
    await until(() => h.received.includes("CREATE_FRAME"), 5000, "B to receive it");
    h.close();
    const r = await pending; await b.close();
    must(r.isError && /^PLUGIN_DISCONNECTED:/.test(r.text) && /may or may not have applied/.test(r.text) && Date.now() - t < 8000, r.text);
    const s = (await bridgeStatus(BASE)).status;
    must(s.sessions.length === 1 && s.lastDisconnect?.fileKey === FILE_B.fileKey, JSON.stringify(s));
    return { error: r.text.slice(0, 110), ms: Date.now() - t, lastDisconnect: s.lastDisconnect };
  });

  await step("9. a plugin that stops answering heartbeats is dropped (the bridge's own run, heartbeat 300ms)", async () => {
    await shutdown();
    const up = await (await import("node:child_process")).spawn(process.execPath, [join(REPO, "bridge", "server.js")], { env: { ...process.env, FIGMA_BRIDGE_PORT: String(PORT), FIGMA_BRIDGE_HEARTBEAT_MS: "300" }, stdio: "ignore" });
    await until(async () => (await bridgeStatus(BASE)).isBridge, 5000, "bridge with short heartbeat");
    const deaf = fakePlugin({ fileName: "Deaf", fileKey: "DDDDDDDDDDDDDDDDDDDDDD" }, { reconnect: false, autoPong: false }); plugins.push(deaf);
    await until(async () => (await bridgeStatus(BASE)).status.sessions.some((x) => x.fileName === "Deaf"), 3000, "deaf plugin to connect");
    await until(async () => !(await bridgeStatus(BASE)).status.sessions.some((x) => x.fileName === "Deaf"), 3000, "deaf plugin to be dropped");
    const aBack = (await bridgeStatus(BASE)).status.sessions.some((x) => x.fileKey === FILE_A.fileKey);
    must(aBack, "the answering plugin A should still be connected (it reconnected to this bridge and answers pings)");
    await shutdown(); up.kill();
    return { deafDropped: true, answeringKept: aBack };
  });

  await step("10. bridge goes away; the next call starts a new one, waits for the plugin to reconnect, and succeeds", async () => {
    must(!(await bridgeStatus(BASE)).reachable, "bridge should be down");
    const before = a.connects, t = Date.now();
    const r = await mcp.call("figma_create_frame", { name: "After restart" });
    must(!r.isError && r.json.id && a.connects > before, r.text);
    return { reconnects: a.connects - before, ms: Date.now() - t, created: r.json.id };
  });

  const b2 = fakePlugin(FILE_B); plugins.push(b2);
  await until(async () => (await bridgeStatus(BASE)).status?.sessions?.length === 2, 5000, "plugin B again");

  await step("11. two files open, no file named: refused as AMBIGUOUS_SESSION; figma_use_file(link) routes to that file only", async () => {
    const amb = await mcp.call("figma_create_frame", { name: "Where?" });
    must(amb.isError && /^AMBIGUOUS_SESSION:/.test(amb.text) && /Alpha/.test(amb.text) && /Beta/.test(amb.text), amb.text);
    const st = await mcp.call("figma_executor_status");
    must(st.json.state === "AMBIGUOUS_SESSION" && st.json.userActionRequired === false, st.text);
    const aBefore = a.received.length;
    const use = await mcp.call("figma_use_file", { url: `https://www.figma.com/design/${FILE_B.fileKey}/Beta?node-id=12-34` });
    must(use.json.state === "READY" && use.json.nodeId === "12:34" && use.json.fileScope.fileKey === FILE_B.fileKey, use.text);
    const r = await mcp.call("figma_create_frame", { name: "In Beta" });
    must(!r.isError && [...b2.nodes.values()].some((n) => n.name === "In Beta") && !a.received.slice(aBefore).includes("CREATE_FRAME"), r.text);
    return { ambiguous: amb.text.slice(0, 100), pinned: use.json.fileScope, wentTo: "Beta only" };
  });

  await step("12. file scope: a Team run can't pin another file, and is refused (nothing sent) while its file isn't open", async () => {
    const t = await connect({ FIGMA_EXPECTED_FILE_KEY: "CCCCCCCCCCCCCCCCCCCCCC" });
    const other = await t.call("figma_use_file", { fileKey: FILE_A.fileKey });
    const aBefore = a.received.length, bBefore = b2.received.length;
    const w = await t.call("figma_create_frame", { name: "Team" });
    const st = await t.call("figma_executor_status");
    await t.close();
    must(other.isError && /^WRONG_FILE:/.test(other.text), other.text);
    must(w.isError && /^FILE_NOT_OPEN:/.test(w.text) && /"Alpha"/.test(w.text) && a.received.length === aBefore && b2.received.length === bBefore, w.text);
    must(st.json.state === "FILE_NOT_OPEN" && st.json.userActionRequired, st.text);
    return { pinOther: other.text.slice(0, 90), write: w.text.slice(0, 110), sentToPlugins: 0 };
  });

  await step("13. read-only profile: no edit tool is registered, and the server itself refuses edits", async () => {
    const ro = await connect({ FIGMA_EXECUTOR_PROFILE: "read", FIGMA_EXPECTED_FILE_KEY: FILE_A.fileKey });
    const names = (await ro.c.listTools()).tools.map((x) => x.name);
    const edit = await ro.call("figma_create_frame", { name: "nope" });
    const read = await ro.call("figma_get_file_info");
    await ro.close();
    const writes = names.filter((n) => /create|modify|delete|batch|set_|import|export|switch|rename|detach|combine|bind/.test(n));
    must(!writes.length && names.includes("figma_executor_status") && names.includes("figma_verify_nodes") && names.includes("figma_get_document_state"), JSON.stringify(names));
    must(edit.isError && !read.isError && read.json.fileKey === FILE_A.fileKey, edit.text + read.text);
    return { tools: names.length, editToolsRegistered: writes, editCall: edit.text.slice(0, 80) };
  });

  await step("14. another program on the port: reported as PORT_IN_USE, nothing started over it", async () => {
    await shutdown();
    const squat = (host) => new Promise((ok) => { const s = http.createServer((req, res) => { res.writeHead(404); res.end("not a bridge"); }).listen(PORT, host, () => ok(s)); });
    const squatters = [await squat("127.0.0.1"), await squat("::1")];
    const r = await ensureBridge(`http://127.0.0.1:${PORT}`, { wait: 2000 });
    const st = await mcp.call("figma_executor_status");
    for (const q of squatters) { q.close(); q.closeAllConnections(); }
    must(!r.ok && r.code === "PORT_IN_USE" && st.json.state === "PORT_IN_USE" && st.json.userActionRequired, JSON.stringify({ r, st: st.json }));
    return { code: r.code, error: r.error };
  });

  await step("15. an older bridge (protocol 1) is replaced only while no plugin depends on it", async () => {
    let connected = true, stopped = false;
    const old = http.createServer((req, res) => {
      if (req.url === "/status") return res.end(JSON.stringify({ pluginConnected: connected }));
      if (req.url === "/shutdown") { res.end('{"ok":true}'); stopped = true; return setTimeout(() => { old.close(); old.closeAllConnections(); }, 50); }
      res.end("{}");
    }).listen(PORT, "127.0.0.1");
    await new Promise((ok) => old.once("listening", ok));
    const kept = await ensureBridge(`http://127.0.0.1:${PORT}`);
    must(kept.ok && kept.outdated && !stopped, JSON.stringify(kept));
    connected = false;
    const replaced = await ensureBridge(`http://127.0.0.1:${PORT}`);
    must(replaced.ok && replaced.restarted && stopped && (await bridgeStatus(BASE)).status.protocol === 2, JSON.stringify(replaced));
    return { whileConnected: "kept", whenIdle: "replaced by protocol 2" };
  });

  await step("16. missing dependency: a bridge folder without ws says to run npm install, and starts nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-nodeps-"));
    copyFileSync(join(REPO, "bridge", "launcher.mjs"), join(dir, "launcher.mjs"));
    copyFileSync(join(REPO, "bridge", "server.js"), join(dir, "server.js"));
    const { ensureBridge: ensureCopy } = await import(pathToFileURL(join(dir, "launcher.mjs")).href);
    const r = await ensureCopy("http://127.0.0.1:8791");
    rmSync(dir, { recursive: true, force: true });
    must(!r.ok && r.code === "MISSING_DEPENDENCY" && /npm install/.test(r.nextStep) && !(await bridgeStatus("http://127.0.0.1:8791", { timeout: 300 })).reachable, JSON.stringify(r));
    return { code: r.code, nextStep: r.nextStep };
  });

  await step("17. autostart off (FIGMA_BRIDGE_AUTOSTART=0): BRIDGE_UNAVAILABLE with the command to start it, and no bridge appears", async () => {
    await shutdown();
    const off = await connect({ FIGMA_BRIDGE_AUTOSTART: "0" });
    const r = await off.call("figma_ping");
    const st = await off.call("figma_executor_status");
    await off.close();
    must(r.isError && /^BRIDGE_UNAVAILABLE:/.test(r.text) && /node bridge\/server\.js/.test(r.text) && st.json.state === "BRIDGE_UNAVAILABLE" && !(await bridgeStatus(BASE, { timeout: 300 })).reachable, r.text + st.text);
    return { error: r.text.slice(0, 120) };
  });

  await mcp.close();
} finally {
  for (const p of plugins) p.close();
  await shutdown().catch(() => {});
}
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
writeFileSync(join(HERE, "lifecycle-results.json"), JSON.stringify({ at: new Date().toISOString(), passed, total: results.length, note: "Real bridge and MCP server, fake plugins. Not a live Figma test.", results }, null, 1));
process.exit(passed === results.length ? 0 : 1);
