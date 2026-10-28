// The console gives the Figma Executor the access a worker has, and nothing more: a worker that may
// only read Figma gets the read-only Executor (FIGMA_EXECUTOR_PROFILE=read: no edit tools at all), one
// that may edit gets the edit profile. A run of either starts the bridge itself at its start, so an open
// plugin connects before the worker's first call, and one opened later connects during the run. Without
// the plugin the Executor is still given, with its tools off until the plugin connects (the run says
// it's waiting). A test console (port 8798, its own data dir, a test bridge port 8792); nothing touches
// the real ones. Each run is stopped as soon as it starts: only its generated MCP config is checked.
import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", "..");
const DATA = mkdtempSync(join(tmpdir(), "figma-wiring-")), PORT = 8798, BP = 8792, B = `http://127.0.0.1:${PORT}`;
const must = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const step = async (name, fn) => { try { const d = await fn(); results.push({ step: name, ok: true, detail: d }); console.log("PASS", name, JSON.stringify(d).slice(0, 240)); } catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 400)); } };
const WebSocket = createRequire(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bridge", "package.json"))("ws");
// A stand-in for the plugin open in a Figma file (plugin/ui.html's hello), connected to the bridge.
const plugin = () => new Promise((ok, no) => { const s = new WebSocket(`ws://localhost:${BP}/ws`); s.on("open", () => { s.send(JSON.stringify({ type: "__hello__", role: "plugin", file: { fileName: "Wiring", fileKey: "WWWWWWWWWWWWWWWWWWWWWW", editorType: "figma", rootId: "0:0" } })); ok(s); }); s.on("message", (raw) => { const m = JSON.parse(raw.toString()); s.send(JSON.stringify({ id: m.id, ok: true, result: { pong: true } })); }); s.on("error", no); });
const bridgeUp = () => fetch(`http://127.0.0.1:${BP}/status`, { signal: AbortSignal.timeout(1000) }).then((r) => r.json()).catch(() => null);

const con = spawn(process.execPath, [join(REPO, "worker-ui", "server.mjs")], { env: { ...process.env, WORKER_CONSOLE_PORT: String(PORT), WORKER_CONSOLE_DATA: DATA, FIGMA_BRIDGE_PORT: String(BP) }, stdio: "ignore" });
for (let i = 0; i < 80; i++) { try { await fetch(B + "/"); break; } catch { await sleep(150); } }
const api = async (m, p, b) => { const r = await fetch(B + p, { method: m, headers: { "content-type": "application/json", "x-worker-console": "1", origin: B }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
const executorFor = async (worker) => {
  const run = (await api("POST", "/runs", { prompt: "Reply with the single word DONE and nothing else.", workspace: "scratch", worker: worker.id })).body;
  await api("POST", `/runs/${run.id}/stop`);
  const f = join(DATA, "runs", `${run.id}.mcp.json`);
  must(existsSync(f), `no MCP config for run ${run.id}`);
  const events = readFileSync(join(DATA, "runs", `${run.id}.jsonl`), "utf8");
  return { ...JSON.parse(readFileSync(f, "utf8")).mcpServers["figma-executor"], waiting: /"type":"capability","summary":"Waiting for: [^"]*Figma file/.test(events) };
};
try {
  must(!(await bridgeUp()), `something is already on the test bridge port ${BP}`);
  await step("a worker with figma.plugin.read only: its run start brings up the bridge; without the plugin it gets the read-only Executor with its tools waiting; with the plugin open, the read-only Executor and nothing waiting", async () => {
    const w = (await api("POST", "/workers", { name: "Figma reviewer", specialization: "review", mission: "Review the open Figma file.", capabilities: ["files.read", "figma.plugin.read"], requirements: [] })).body;
    const none = await executorFor(w), st = await bridgeUp();
    const p = await plugin(); await sleep(500);
    const cfg = await executorFor(w); p.close();
    must(none?.env?.FIGMA_EXECUTOR_PROFILE === "read" && none.waiting && st?.protocol === 2 && st.pluginConnected === false && cfg?.env?.FIGMA_EXECUTOR_PROFILE === "read" && !cfg.waiting && cfg.env.FIGMA_BRIDGE_PORT === String(BP), JSON.stringify({ none, st, cfg }));
    return { withoutPlugin: "read, waiting", withPlugin: cfg.env.FIGMA_EXECUTOR_PROFILE, bridgeStartedByRun: true };
  });
  await step("a worker with figma.plugin.edit: without the plugin open it gets the edit Executor with its tools waiting (they come on when the plugin connects); with it, the edit Executor and nothing waiting", async () => {
    const w = (await api("POST", "/workers", { name: "Figma editor", specialization: "edit", mission: "Edit the open Figma file.", capabilities: ["files.read", "figma.plugin.read", "figma.plugin.edit"], requirements: [{ resource: "figma", access: "edit", need: "required" }] })).body;
    const none = await executorFor(w), st = await bridgeUp();
    const p = await plugin(); await sleep(500);
    const cfg = await executorFor(w); p.close();
    must(none?.env?.FIGMA_EXECUTOR_PROFILE === "edit" && none.waiting && st?.protocol === 2 && cfg?.env?.FIGMA_EXECUTOR_PROFILE === "edit" && !cfg.waiting, JSON.stringify({ none, cfg, st }));
    return { env: cfg.env, bridge: { protocol: st.protocol, port: st.port } };
  });
} finally {
  try { await fetch(`http://127.0.0.1:${BP}/shutdown`, { method: "POST" }); } catch {}
  con.kill();
  await sleep(300);
  try { rmSync(DATA, { recursive: true, force: true }); } catch {}
}
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
writeFileSync(join(HERE, "console-wiring-results.json"), JSON.stringify({ at: new Date().toISOString(), passed, total: results.length, results }, null, 1));
process.exit(passed === results.length ? 0 : 1);
