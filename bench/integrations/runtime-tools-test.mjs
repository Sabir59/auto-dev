// The real Claude Code runtime picks up a tool server's tools coming on and going off in the same
// session (notifications/tools/list_changed), as mcp/authz.mjs relies on. The real binary is started
// the way the console starts it (stream-json, --mcp-config, --strict-mcp-config) with the real Figma
// Executor server, whose live set comes from a stand-in console here. Only control requests
// (mcp_status) are sent, never a message: nothing reaches a model. It runs in a config folder of its
// own, so it doesn't touch the person's Claude settings or sessions.
//   node bench/integrations/runtime-tools-test.mjs        (CLAUDE_BIN to choose the binary)
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", "..");
const ROOT = join(tmpdir(), `runtime-tools-${Date.now()}`); mkdirSync(join(ROOT, "config"), { recursive: true });
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const results = [];
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail).slice(0, 300)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 900)); }
};
const assert = (c, m) => { if (!c) throw new Error(typeof m === "string" ? m : JSON.stringify(m)); };

const bin = process.env.CLAUDE_BIN || "claude";
let version = "";
try { version = execFileSync(bin, ["--version"], { encoding: "utf8", shell: process.platform === "win32" && !/\.exe$/i.test(bin), timeout: 30000 }).trim(); }
catch { console.log(`SKIP: no Claude Code binary (${bin})`); process.exit(0); }

// The stand-in console: the live set on cue; every call allowed (the per-call check is tested elsewhere).
let live = { live: [], v: 1 };
const consoleStub = http.createServer((q, s) => { s.writeHead(200, { "content-type": "application/json" }); s.end(JSON.stringify(q.url.includes("/live") ? live : { ok: true })); });
await new Promise((ok) => consoleStub.listen(0, "127.0.0.1", ok));
const mcpFile = join(ROOT, "mcp.json");
writeFileSync(mcpFile, JSON.stringify({ mcpServers: { "figma-executor": { command: process.execPath, args: [join(REPO, "mcp", "server.mjs")],
  env: { FIGMA_EXECUTOR_PROFILE: "edit", FIGMA_BRIDGE_PORT: "8776", AIW_AUTHZ_URL: `http://127.0.0.1:${consoleStub.address().port}/authz/r1`, AIW_AUTHZ_TOKEN: "t", AIW_AUTHZ_SERVER: "figma-executor" } } } }));

const p = spawn(bin, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--mcp-config", mcpFile, "--tools", "ToolSearch"],
  { cwd: ROOT, env: { ...process.env, CLAUDE_CONFIG_DIR: join(ROOT, "config") }, shell: process.platform === "win32" && !/\.exe$/i.test(bin) });
let buf = "", n = 0, err = ""; const waits = new Map();
p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); if (m.type === "control_response") waits.get(m.response.request_id)?.(m.response); } catch {} } });
p.stderr.on("data", (d) => (err += d));
const status = () => new Promise((ok) => { const id = `s${++n}`; const t = setTimeout(() => ok(null), 20000); waits.set(id, (r) => { clearTimeout(t); ok(r.response?.mcpServers || null); }); p.stdin.write(JSON.stringify({ type: "control_request", request_id: id, request: { subtype: "mcp_status" } }) + "\n"); });
const tools = async () => { const st = await status(); const row = st?.find((s) => s.name === "figma-executor"); return row ? { status: row.status, tools: (row.tools || []).map((t) => t.name) } : { status: st ? "missing" : "no answer", tools: [] }; };
async function until(what, fn, ms = 15000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(500); } }

await step(`the runtime (${version}) starts the tool server with its tools off when nothing is connected`, async () => {
  const t = await until("the server to connect", async () => { const x = await tools(); return x.status === "connected" ? x : null; }, 30000);
  assert(t.tools.length === 0, t);
  return t;
});
await step("a connection coming up turns the tools on in the same session (no restart): the runtime lists them within seconds", async () => {
  const t0 = Date.now(); live = { live: ["figma.plugin.read", "figma.plugin.edit"], v: 2 };
  const t = await until("the tools to appear", async () => { const x = await tools(); return x.tools.length ? x : null; });
  assert(t.tools.includes("figma_ping") && t.tools.includes("figma_create_frame"), t);
  return { took: `${Date.now() - t0} ms`, tools: t.tools.length };
});
await step("a connection going away turns them off again; reading only turns on only the read tools", async () => {
  live = { live: [], v: 3 };
  const off = await until("the tools to go", async () => { const x = await tools(); return x.tools.length === 0 ? x : null; });
  live = { live: ["figma.plugin.read"], v: 4 };
  const read = await until("the read tools", async () => { const x = await tools(); return x.tools.length ? x : null; });
  assert(off.tools.length === 0 && read.tools.includes("figma_ping") && !read.tools.includes("figma_create_frame"), { off, read: read.tools.length });
  return { off: 0, readOnly: read.tools.length };
});

p.stdin.end(); p.kill(); consoleStub.close();
if (results.some((r) => !r.ok) && err) console.log("runtime stderr:", err.slice(-600));
writeFileSync(join(HERE, "runtime-tools-results.json"), JSON.stringify({ at: new Date().toISOString(), runtime: version, results }, null, 1));
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
