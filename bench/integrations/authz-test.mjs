// Authorization, fail-closed, at the start of a run and at each integration tool call. A console with
// its own data, a stand-in for Claude (fake-claude.mjs) that keeps the run alive, and a stand-in Figma
// bridge whose plugin connects, disconnects or stops answering on cue. Nothing reaches a model or Figma.
//   node bench/integrations/authz-test.mjs
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", "..");
const { Client } = await import("../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js");
const { StdioClientTransport } = await import("../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js");
const PORT = process.env.PORT || "8785", BRIDGE = "8778";
const ROOT = join(tmpdir(), `authz-${Date.now()}`), DATA = join(ROOT, "data"), OUT = join(ROOT, "fake"); mkdirSync(DATA, { recursive: true });
const BASE = `http://127.0.0.1:${PORT}`, H = { origin: BASE, "x-worker-console": "1", "content-type": "application/json" };
const call = (m, p, b) => fetch(BASE + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const results = [];
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail).slice(0, 260)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 900)); }
};
const assert = (c, m) => { if (!c) throw new Error(typeof m === "string" ? m : JSON.stringify(m)); };

// The stand-in bridge: plugin "on", "off", or "hang" (doesn't answer).
let plugin = "on";
const bridge = http.createServer((q, s) => {
  if (plugin === "hang") return; // never answers
  let b = ""; q.on("data", (d) => (b += d)); q.on("end", () => {
    s.writeHead(200, { "content-type": "application/json" });
    if (q.url.startsWith("/command")) return s.end(JSON.stringify({ ok: true, result: { pong: true }, session: "s1", fileName: "Test file" }));
    s.end(JSON.stringify({ bridge: "figma-ai-executor", protocol: 2, pid: 0, port: Number(BRIDGE), pluginConnected: plugin === "on", sessions: plugin === "on" ? [{ session: "s1", fileName: "Test file", fileKey: "k1" }] : [] }));
  });
});
await new Promise((ok, no) => bridge.listen(Number(BRIDGE), "127.0.0.1", ok).on("error", no));

const env = { ...process.env, WORKER_CONSOLE_PORT: PORT, WORKER_CONSOLE_DATA: DATA, CLAUDE_BIN: process.execPath, CLAUDE_BIN_ARGS: JSON.stringify([join(HERE, "fake-claude.mjs")]), FAKE_CLAUDE_OUT: OUT,
  FIGMA_BRIDGE_PORT: BRIDGE, BUILDER_ADAPTER_DIR: join(DATA, "builder"), FIGMA_READER_DIR: join(DATA, "figma-reader"), GITHUB_CONNECTOR_DIR: join(DATA, "github") };
const srv = spawn(process.execPath, [join(REPO, "worker-ui", "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; srv.stdout.on("data", (d) => (log += d)); srv.stderr.on("data", (d) => (log += d));
for (let i = 0; ; i++) { try { await fetch(BASE + "/"); break; } catch { if (i > 80) throw new Error(`console didn't start: ${log.slice(-500)}`); await sleep(250); } }
const dir = join(ROOT, "work"); mkdirSync(dir); execFileSync("git", ["init", "-q", dir]); writeFileSync(join(dir, "a.txt"), "a");
const WS = (await call("POST", "/workspaces", { name: "Work", path: dir, mode: "work" })).body.id;
const W = (await call("POST", "/workers/from-request", { description: "Review designs in Figma", answers: { figma: { edit: "look", links: "no" } }, workspace: WS })).body;

const runsDir = join(DATA, "runs");
async function start(worker) {
  const r = await call("POST", "/runs", { prompt: "hello", workspace: WS, ...(worker ? { worker } : {}) });
  assert(r.status === 200, r.body);
  for (let i = 0; i < 100; i++) { const a = (await call("GET", "/runs")).body; if (a.active === r.body.id && existsSync(join(runsDir, `${r.body.id}.mcp.json`))) break; await sleep(100); }
  await sleep(300);
  return { id: r.body.id, mcp: JSON.parse(readFileSync(join(runsDir, `${r.body.id}.mcp.json`), "utf8")).mcpServers };
}
const stop = async (id) => { await call("POST", `/runs/${id}/stop`, {}); for (let i = 0; i < 50; i++) { if (!(await call("GET", "/runs")).body.active) break; await sleep(100); } };
const ask = async (url, token, cap) => { const r = await fetch(`${url}?cap=${encodeURIComponent(cap)}&tool=test`, { headers: { "x-aiw-authz": token } }); return { status: r.status, ...(await r.json()) }; };

let run;
await step("at the start: with the Figma plugin running, the worker's Figma tool is loaded, and its server gets the per-call check", async () => {
  plugin = "on"; run = await start(W.id);
  const fx = run.mcp["figma-executor"];
  assert(fx && fx.env.AIW_AUTHZ_URL.endsWith(`/authz/${run.id}`) && fx.env.AIW_AUTHZ_TOKEN.length >= 32 && fx.env.FIGMA_EXECUTOR_PROFILE === "read", run.mcp);
  return { servers: Object.keys(run.mcp) };
});

await step("each call: allowed for a tool given to this run; refused with a wrong token, for a tool not given to it (Figma edit, Builder), and from another address", async () => {
  const { AIW_AUTHZ_URL: url, AIW_AUTHZ_TOKEN: token } = run.mcp["figma-executor"].env;
  const ok = await ask(url, token, "figma.plugin.read"), badToken = await ask(url, "x".repeat(token.length), "figma.plugin.read"), edit = await ask(url, token, "figma.plugin.edit"), builder = await ask(url, token, "builder.read");
  // (fetch won't send another Host header; a raw request does, as a DNS-rebinding page would)
  const otherHost = await new Promise((ok) => http.get(`${url}?cap=figma.plugin.read`, { headers: { "x-aiw-authz": token, host: "evil.example" } }, (r) => { r.resume(); ok(r.statusCode); }).on("error", () => ok("error")));
  assert(ok.status === 200 && ok.ok && badToken.status === 403 && edit.status === 403 && /isn't given/.test(edit.reason) && builder.status === 403 && otherHost === 403, { ok, badToken, edit, builder, otherHost });
  return { allowed: "figma.plugin.read", refused: { badToken: badToken.reason, edit: edit.reason, builder: builder.reason } };
});

await step("mid-run: the plugin disconnecting is noticed at the next call (within 10 seconds) and refused; reconnecting allows it again; a bridge that stops answering is refused, not waited on", async () => {
  const { AIW_AUTHZ_URL: url, AIW_AUTHZ_TOKEN: token } = run.mcp["figma-executor"].env;
  plugin = "off"; await sleep(10500); const off = await ask(url, token, "figma.plugin.read");
  plugin = "on"; await sleep(10500); const back = await ask(url, token, "figma.plugin.read");
  plugin = "hang"; await sleep(10500); const t0 = Date.now(), hang = await ask(url, token, "figma.plugin.read"), took = Date.now() - t0;
  plugin = "on";
  assert(off.status === 403 && /Plugin not running/.test(off.reason) && back.status === 200 && hang.status === 403 && took < 10000, { off, back, hang, took });
  return { disconnected: off.reason, hung: `${hang.reason} (${took} ms)` };
});

await step("the tool server itself: a tool that's listed is still checked at each call (NOT_AUTHORIZED, nothing reaches Figma); allowed, the call goes through; its tools follow the live set, and with no answer they're all off", async () => {
  // A stand-in console: the live set lists the plugin, and the per-call answer is set on cue.
  let verdict = { ok: false, reason: "Figma: change the open file: Plugin not running" }, live = { live: ["figma.plugin.read"], v: 1 }, answer = true;
  const stub = http.createServer((q, s) => {
    if (!answer) return; // never answers
    s.writeHead(q.url.startsWith("/authz/r1/live") ? 200 : verdict.ok ? 200 : 403, { "content-type": "application/json" });
    s.end(JSON.stringify(q.url.startsWith("/authz/r1/live") ? live : verdict));
  });
  await new Promise((ok) => stub.listen(0, "127.0.0.1", ok));
  const fx = run.mcp["figma-executor"], client = new Client({ name: "authz-test", version: "1" });
  await client.connect(new StdioClientTransport({ command: fx.command, args: fx.args, env: { ...process.env, ...fx.env, AIW_AUTHZ_URL: `http://127.0.0.1:${stub.address().port}/authz/r1`, AIW_AUTHZ_TOKEN: "t" } }));
  const listed = (await client.listTools()).tools.map((t) => t.name);
  const refused = await client.callTool({ name: "figma_ping", arguments: {} });
  verdict = { ok: true }; const allowed = await client.callTool({ name: "figma_ping", arguments: {} });
  live = { live: [], v: 2 }; await sleep(2600); const offList = (await client.listTools()).tools.length;
  live = { live: ["figma.plugin.read"], v: 3 }; await sleep(2600); const onList = (await client.listTools()).tools.length;
  answer = false; await sleep(12500); const silentList = (await client.listTools()).tools.length;
  await client.close(); stub.close();
  const text = (r) => r.content?.[0]?.text || "";
  assert(listed.includes("figma_ping") && refused.isError && /^NOT_AUTHORIZED: Figma/.test(text(refused)) && !/NOT_AUTHORIZED/.test(text(allowed)), { listed: listed.length, refused: text(refused), allowed: text(allowed).slice(0, 200) });
  assert(offList === 0 && onList === listed.length && silentList === 0, { listed: listed.length, offList, onList, silentList });
  return { refused: text(refused).slice(0, 120), tools: { listed: listed.length, off: offList, on: onList, noAnswer: silentList } };
});

await step("after the run stops, its tool servers' calls are refused", async () => {
  const { AIW_AUTHZ_URL: url, AIW_AUTHZ_TOKEN: token } = run.mcp["figma-executor"].env;
  await stop(run.id);
  const after = await ask(url, token, "figma.plugin.read");
  assert(after.status === 403 && /isn't active/.test(after.reason), after);
  return { after: after.reason };
});

await step("fail-closed at the start: with the plugin not running, the Figma tool server is loaded with its tools off (the live set is empty, a call is refused), the run says it's waiting, and its context tells the worker why and that they'll come on in this task", async () => {
  plugin = "off"; const r = await start(W.id);
  const events = readFileSync(join(runsDir, `${r.id}.jsonl`), "utf8"), ctx = readFileSync(join(runsDir, `${r.id}.worker.md`), "utf8"), snap = JSON.parse(readFileSync(join(runsDir, `${r.id}.worker.json`), "utf8"));
  const { AIW_AUTHZ_URL: url, AIW_AUTHZ_TOKEN: token } = r.mcp["figma-executor"].env;
  const live = await (await fetch(`${url}/live`, { headers: { "x-aiw-authz": token } })).json(), call1 = await ask(url, token, "figma.plugin.read");
  await stop(r.id); plugin = "on";
  assert(r.mcp["figma-executor"] && live.live.length === 0 && call1.status === 403 && /Plugin not running/.test(call1.reason), { servers: Object.keys(r.mcp), live, call1 });
  assert(/Waiting for: Read the open Figma file/.test(events) && !/Not loaded: /.test(events) && /Waiting for a connection: Read the open Figma file/.test(ctx) && /Plugin not running/.test(snap.gate["figma.plugin.read"]), { gate: snap.gate });
  return { gate: snap.gate, live: live.live };
});

await step("General worker (decision 1): only its granted core tools; never an integration's (granting one is refused); narrowing its grant narrows its launch", async () => {
  const g = (await call("GET", "/general")).body, bad = await call("PUT", "/general", { core: ["files.read", "figma.plugin.edit"] });
  const r1 = await start(null); const rec1 = JSON.parse(readFileSync(join(OUT, readdirSync(OUT).sort().slice(-1)[0]), "utf8")); await stop(r1.id);
  const put = await call("PUT", "/general", { core: ["files.read"] });
  const r2 = await start(null); const rec2 = JSON.parse(readFileSync(join(OUT, readdirSync(OUT).sort().slice(-1)[0]), "utf8")); await stop(r2.id);
  await call("PUT", "/general", { core: g.core });
  assert(g.core.join() === "files.read,files.write,web,browser" && !g.saved && bad.status === 400 && /isn't a core capability/.test(bad.body.error), { g, bad: bad.body });
  assert(!Object.keys(r1.mcp).includes("figma-executor") && !rec1.allowedTools.some((t) => /figma/.test(t)) && rec1.tools && rec1.permissionPrompts === "none", rec1);
  assert(put.status === 200 && rec2.tools === "ToolSearch,Read,Glob,Grep" && !Object.keys(r2.mcp).length, rec2);
  return { default: g.core, narrowed: rec2.tools };
});

await step("run snapshots stay readable: an earlier run's record and events load", async () => {
  const list = (await call("GET", "/runs")).body.runs, one = list[0], ev = await call("GET", `/runs/${one.id}`);
  assert(list.length >= 4 && ev.status === 200, { n: list.length, status: ev.status });
  return { runs: list.length };
});

srv.kill(); bridge.close();
writeFileSync(join(HERE, "authz-results.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
