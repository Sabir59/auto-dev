// A connection that comes up (or goes away) during a task changes the worker's tools in that same
// task, within what the run was given at its start. A console with its own data; a stand-in for
// Claude (fake-claude.mjs) that really starts and connects the run's tool servers, answers the
// runtime's mcp_status with what they list, replies "ok" and logs what it was sent; and a stand-in
// Figma bridge whose plugin is opened and closed on cue. Nothing reaches a model or Figma.
//   node bench/integrations/live-test.mjs
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", "..");
const PORT = process.env.PORT || "8786", BRIDGE = "8777";
const ROOT = join(tmpdir(), `live-${Date.now()}`), DATA = join(ROOT, "data"), OUT = join(ROOT, "fake"), STALE = join(ROOT, "stale"); mkdirSync(DATA, { recursive: true });
const BASE = `http://127.0.0.1:${PORT}`, H = { origin: BASE, "x-worker-console": "1", "content-type": "application/json" };
const call = (m, p, b) => fetch(BASE + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const results = [];
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail).slice(0, 300)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 1200)); }
};
const assert = (c, m) => { if (!c) throw new Error(typeof m === "string" ? m : JSON.stringify(m)); };

let plugin = "off", file = { key: "k1", name: "Test file" };
const bridge = http.createServer((q, s) => {
  let b = ""; q.on("data", (d) => (b += d)); q.on("end", () => {
    s.writeHead(200, { "content-type": "application/json" });
    if (q.url.startsWith("/command")) return s.end(JSON.stringify({ ok: true, result: { pong: true }, session: "s1", fileName: "Test file" }));
    s.end(JSON.stringify({ bridge: "figma-ai-executor", protocol: 2, pid: 0, port: Number(BRIDGE), pluginConnected: plugin === "on", sessions: plugin === "on" ? [{ session: "s1", fileName: file.name, fileKey: file.key }] : [] }));
  });
});
await new Promise((ok, no) => bridge.listen(Number(BRIDGE), "127.0.0.1", ok).on("error", no));

const env = { ...process.env, WORKER_CONSOLE_PORT: PORT, WORKER_CONSOLE_DATA: DATA, CLAUDE_BIN: process.execPath, CLAUDE_BIN_ARGS: JSON.stringify([join(HERE, "fake-claude.mjs")]), FAKE_CLAUDE_OUT: OUT,
  FAKE_CLAUDE_MCP: "1", FAKE_CLAUDE_REPLY: "1", FAKE_CLAUDE_STALE_FILE: STALE, FAKE_CLAUDE_SESSIONS: "1", WORKER_CONSOLE_CLAUDE_CONFIG_DIR: join(ROOT, "claude"),
  FIGMA_BRIDGE_PORT: BRIDGE, BUILDER_ADAPTER_DIR: join(DATA, "builder"), FIGMA_READER_DIR: join(DATA, "figma-reader"), GITHUB_CONNECTOR_DIR: join(DATA, "github") };
const srv = spawn(process.execPath, [join(REPO, "worker-ui", "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; srv.stdout.on("data", (d) => (log += d)); srv.stderr.on("data", (d) => (log += d));
for (let i = 0; ; i++) { try { await fetch(BASE + "/"); break; } catch { if (i > 80) throw new Error(`console didn't start: ${log.slice(-500)}`); await sleep(250); } }
const dir = join(ROOT, "work"); mkdirSync(dir); execFileSync("git", ["init", "-q", dir]); writeFileSync(join(dir, "a.txt"), "a");
const WS = (await call("POST", "/workspaces", { name: "Work", path: dir, mode: "work" })).body.id;
// A Figma worker that changes the open file and reads links (the Reader has no token here: it waits too).
const W = (await call("POST", "/workers/from-request", { description: "Update designs in Figma", answers: { figma: { edit: "edit", links: "yes" } }, workspace: WS })).body;

const runsDir = join(DATA, "runs");
const events = (id) => readFileSync(join(runsDir, `${id}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const meta = async (id) => (await call("GET", `/runs/${id}`)).body;
const launches = () => (existsSync(OUT) ? readdirSync(OUT) : []).filter((f) => /^\d+-\d+\.json$/.test(f)).sort();
const lastOf = (suffix, launch) => { const f = join(OUT, launch.replace(/\.json$/, suffix)); return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };
async function until(what, fn, ms = 15000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(200); } }
const figmaTools = (row) => (row?.servers || []).find((s) => s.name === "figma-executor")?.tools || [];
async function start() {
  const before = launches().length;
  const r = await call("POST", "/runs", { prompt: "hello", workspace: WS, worker: W.id });
  assert(r.status === 200, r.body);
  await until("the stand-in to start and connect its servers", () => launches().length > before && lastOf(".status.jsonl", launches().at(-1)).some((x) => x.initial && x.servers[0].name === "figma-executor"));
  await until("the first reply", async () => (await meta(r.body.id)).status === "waiting");
  return { id: r.body.id, launch: launches().at(-1), mcp: JSON.parse(readFileSync(join(runsDir, `${r.body.id}.mcp.json`), "utf8")).mcpServers };
}
const stop = async (id) => { await call("POST", `/runs/${id}/stop`, {}); await until("the run to stop", async () => !(await call("GET", "/runs")).body.active); };

let run;
await step("plugin closed at the start: the Figma tools are loaded but off (the executor can edit once it's connected); the run and the worker's context say they're waiting and will come on in this task, not 'not loaded'", async () => {
  plugin = "off"; run = await start();
  const fx = run.mcp["figma-executor"], initial = lastOf(".status.jsonl", run.launch).find((x) => x.initial && x.servers[0].name === "figma-executor");
  const ev = events(run.id), ctx = readFileSync(join(runsDir, `${run.id}.worker.md`), "utf8");
  assert(fx && fx.env.FIGMA_EXECUTOR_PROFILE === "edit" && run.mcp["figma-reader"] && figmaTools(initial).length === 0, { servers: Object.keys(run.mcp), profile: fx?.env.FIGMA_EXECUTOR_PROFILE, initial });
  assert(ev.some((e) => e.type === "capability" && /^Waiting for: .*Change the open Figma file/.test(e.summary)) && !ev.some((e) => e.type === "note" && /^Not loaded/.test(e.summary)), ev.filter((e) => /capability|note/.test(e.type)));
  assert(/Waiting for a connection: .*Change the open Figma file/.test(ctx) && /never ask for a new task/.test(ctx) && !/Not loaded in this run/.test(ctx), ctx.slice(0, 400));
  return { initialFigmaTools: figmaTools(initial).length, waiting: ev.find((e) => e.type === "capability").summary };
});

await step("the plugin opens mid-task: its tools come on in the same worker process (no restart, no resume), the tool server and the runtime both list them, and the run shows 'Connected' with nothing to reload", async () => {
  const t0 = Date.now(); plugin = "on";
  const connected = await until("a Connected event", () => events(run.id).find((e) => e.type === "capability" && /^Connected: /.test(e.summary)));
  const took = Date.now() - t0;
  const seen = await until("the runtime's mcp_status to list the Figma tools", () => lastOf(".status.jsonl", run.launch).filter((x) => !x.initial).find((x) => figmaTools(x).length));
  await sleep(1500);
  const tools = figmaTools(seen), ev = events(run.id);
  assert(launches().at(-1) === run.launch && tools.includes("figma_ping") && tools.includes("figma_create_frame") && !ev.some((e) => e.type === "capability" && /reload/i.test(e.summary)), { launches: launches().length, tools: tools.slice(0, 8), ev: ev.filter((e) => e.type === "capability") });
  assert(/Change the open Figma file/.test(connected.summary) && took < 12000, { connected: connected.summary, took });
  return { took: `${took} ms`, toolsNow: tools.length, sameProcess: true };
});

await step("the worker hears about it with the person's next message (once), while the person's own message is shown as typed", async () => {
  const r = await call("POST", `/runs/${run.id}/message`, { text: "The plugin is open now, go on" });
  assert(r.status === 200, r.body);
  await until("the stand-in to get it", () => lastOf(".messages.jsonl", run.launch).length >= 2);
  await until("the reply", async () => (await meta(run.id)).status === "waiting");
  await call("POST", `/runs/${run.id}/message`, { text: "And again" });
  await until("the second message", () => lastOf(".messages.jsonl", run.launch).length >= 3);
  const msgs = lastOf(".messages.jsonl", run.launch).map((m) => m.text), user = events(run.id).filter((e) => e.type === "user").map((e) => e.summary);
  assert(/^\[Console: since your last turn, now connected, its tools are available \(search with ToolSearch\): .*Change the open Figma file.*\]\n\nThe plugin is open now, go on$/.test(msgs[1]) && msgs[2] === "And again" && user.includes("The plugin is open now, go on"), { msgs, user });
  await until("the reply", async () => (await meta(run.id)).status === "waiting");
  return { told: msgs[1].split("\n")[0].slice(0, 160) };
});

await step("only what the run was given can come on: the live set never holds a capability outside the worker; a wrong token gets nothing; a call for one it wasn't given is refused", async () => {
  const { AIW_AUTHZ_URL: url, AIW_AUTHZ_TOKEN: token } = run.mcp["figma-executor"].env;
  const live = await (await fetch(`${url}/live`, { headers: { "x-aiw-authz": token } })).json();
  const bad = await fetch(`${url}/live`, { headers: { "x-aiw-authz": "x".repeat(token.length) } }), badBody = await bad.json();
  const builder = await (await fetch(`${url}?cap=builder.read&tool=t`, { headers: { "x-aiw-authz": token } })).json();
  assert(live.live.join() === "figma.plugin.read,figma.plugin.edit" && bad.status === 403 && badBody.live.length === 0 && builder.ok === false && /isn't given/.test(builder.reason), { live, badBody, builder });
  return { live: live.live, wrongToken: bad.status };
});

await step("the plugin closes mid-task: its tools go off at the next check and calls are refused with the reason; the run says so and offers 'Check connections'", async () => {
  plugin = "off";
  const off = await until("an Unavailable event", () => events(run.id).find((e) => e.type === "capability" && /^Unavailable: /.test(e.summary)));
  const { AIW_AUTHZ_URL: url, AIW_AUTHZ_TOKEN: token } = run.mcp["figma-executor"].env;
  await sleep(10500); // past the per-call check's reuse window
  const refused = await (await fetch(`${url}?cap=figma.plugin.edit&tool=t`, { headers: { "x-aiw-authz": token } })).json();
  const live = await (await fetch(`${url}/live`, { headers: { "x-aiw-authz": token } })).json();
  assert(/Plugin not running/.test(off.summary) && JSON.parse(off.detail).waiting === true && refused.ok === false && /Plugin not running/.test(refused.reason) && live.live.length === 0, { off: off.summary, refused, live });
  return { off: off.summary.slice(0, 140) };
});

await step("'Check connections' turns what came up on at once (no second check needed); with nothing connected it says what's still missing", async () => {
  const still = await call("POST", `/runs/${run.id}/recheck`, {});
  plugin = "on";
  const t0 = Date.now(), now = await call("POST", `/runs/${run.id}/recheck`, {}), took = Date.now() - t0;
  assert(still.status === 200 && still.body.waiting.some((w) => /Plugin not running/.test(w.why)) && now.status === 200 && now.body.connected.includes("Change the open Figma file (plugin)") && took < 3000, { still: still.body, now: now.body, took });
  return { before: still.body.waiting.map((w) => w.why), after: now.body.connected, took: `${took} ms` };
});

await step("a resumed run starts with what's connected now, not what its first start found: the plugin closed while it wasn't running, so its tools start off and the run says so", async () => {
  await call("POST", `/runs/${run.id}/end`, {});
  await until("the process to end", async () => !(await call("GET", "/runs")).body.active);
  plugin = "off";
  const n = launches().length;
  const r = await call("POST", `/runs/${run.id}/message`, { text: "Continue" });
  assert(r.status === 200, r.body);
  await until("the resumed process", () => launches().length > n && lastOf(".status.jsonl", launches().at(-1)).some((x) => x.initial && x.servers[0].name === "figma-executor"));
  const launch = launches().at(-1), rec = JSON.parse(readFileSync(join(OUT, launch), "utf8")), initial = lastOf(".status.jsonl", launch).find((x) => x.initial && x.servers[0].name === "figma-executor");
  const off = await until("an Unavailable event after the resume", () => events(run.id).filter((e) => e.type === "capability" && /^Unavailable: /.test(e.summary)).length >= 2);
  assert(rec.resume && figmaTools(initial).length === 0 && off, { resume: rec.resume, initial });
  run.launch = launch;
  await until("the reply", async () => (await meta(run.id)).status === "waiting");
  return { resumed: true, figmaToolsAtStart: 0 };
});

await step("a runtime that doesn't pick up the change is noticed: 'Reload tools' is offered; reloading ends the process between turns, and the next message continues the same conversation with the tools on", async () => {
  writeFileSync(STALE, "1"); // the stand-in now answers mcp_status with its tools from connection time
  plugin = "on";
  const warn = await until("the reload offer", () => events(run.id).find((e) => e.type === "capability" && JSON.parse(e.detail || "{}").reload));
  const busy = await call("POST", `/runs/${run.id}/reload-tools`, {}); // waiting: allowed
  await until("the process to end", async () => !(await call("GET", "/runs")).body.active);
  const m = await meta(run.id); rmSync(STALE);
  const n = launches().length, r = await call("POST", `/runs/${run.id}/message`, { text: "Try again" });
  await until("the resumed process", () => launches().length > n && lastOf(".status.jsonl", launches().at(-1)).some((x) => x.initial && x.servers[0].name === "figma-executor"));
  const launch = launches().at(-1), rec = JSON.parse(readFileSync(join(OUT, launch), "utf8")), initial = lastOf(".status.jsonl", launch).find((x) => x.initial && x.servers[0].name === "figma-executor");
  assert(/didn't pick up the new tools/.test(warn.summary) && busy.status === 200 && m.status === "finished" && r.status === 200 && rec.resume && figmaTools(initial).includes("figma_create_frame"), { warn: warn.summary, busy: busy.body?.error, status: m.status, initial });
  run.launch = launch;
  await until("the reply", async () => (await meta(run.id)).status === "waiting");
  return { offered: warn.summary.slice(0, 120), afterReload: `${figmaTools(initial).length} Figma tools at start` };
});

await step("the plugin reopened in another file mid-task: the person and the worker are told which file the Figma tools act on now (with the next message)", async () => {
  file = { key: "k2", name: "Other file" };
  const ev = await until("a file-change event", () => events(run.id).find((e) => e.type === "capability" && JSON.parse(e.detail || "{}").file));
  await call("POST", `/runs/${run.id}/message`, { text: "Carry on" });
  await until("the stand-in to get it", () => lastOf(".messages.jsonl", run.launch).some((m) => /Carry on$/.test(m.text)));
  const told = lastOf(".messages.jsonl", run.launch).find((m) => /Carry on$/.test(m.text)).text;
  file = { key: "k1", name: "Test file" };
  assert(/now in "Other file" \(was "Test file"\)/.test(ev.summary) && /Figma plugin is now in "Other file".*figma_get_file_info/.test(told), { ev: ev.summary, told });
  await until("the reply", async () => (await meta(run.id)).status === "waiting");
  return { shown: ev.summary.slice(0, 120) };
});

await step("the access preview shows what a run would wait for", async () => {
  plugin = "off";
  const pv = (await call("GET", `/access/preview?worker=${W.id}&workspace=${WS}`)).body;
  assert(pv.waiting["figma.plugin.edit"] && pv.waiting["figma.read"] && pv.effective.usable.includes("figma.plugin.edit"), { waiting: pv.waiting, usable: pv.effective.usable });
  return { waiting: Object.keys(pv.waiting) };
});

await step("the page: the run's Activity shows each connection change (Waiting, Connected, Unavailable, file changed, reload offer), and 'Check connections' answers in place", async () => {
  const { chromium } = await import("../../browser-adapter/node_modules/playwright/index.mjs");
  const b = await chromium.launch(), page = await b.newPage({ viewport: { width: 1440, height: 900 } }), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    plugin = "off";
    await until("the plugin to be seen closed", () => events(run.id).filter((e) => e.type === "capability" && /^Unavailable: /.test(e.summary)).length >= 3, 15000).catch(() => {});
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.click(`#runList [data-run="${run.id}"]`);
    await page.waitForSelector("#acts .card", { timeout: 10000 });
    const titles = await page.$$eval("#acts .card .ct", (els) => els.map((e) => e.textContent));
    const btn = page.locator('#acts [data-tel="recheck"]').last();
    await btn.scrollIntoViewIfNeeded(); await btn.click();
    await page.waitForFunction(() => [...document.querySelectorAll("#acts .cx .m11")].some((e) => /Still waiting|Everything/.test(e.textContent)), null, { timeout: 10000 });
    const answer = await page.$$eval("#acts .cx .m11", (els) => els.map((e) => e.textContent).find((t) => /Still waiting|Everything/.test(t)));
    mkdirSync(join(HERE, "shots"), { recursive: true });
    await page.screenshot({ path: join(HERE, "shots", "live-connections.png") });
    for (const t of ["Waiting for a connection", "Connected", "Tools not picked up", "Figma file changed"]) assert(titles.includes(t), { missing: t, titles });
    assert(/Still waiting: .*Plugin not running/.test(answer) && !errors.length, { answer, errors });
    return { cards: titles.filter((t) => /connect|Connected|Tools|Figma file/i.test(t)), answer: answer.slice(0, 160) };
  } finally { await b.close(); }
});

await stop(run.id).catch(() => {});
srv.kill(); bridge.close();
writeFileSync(join(HERE, "live-results.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
