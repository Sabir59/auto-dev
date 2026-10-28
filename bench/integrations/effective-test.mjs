// What every kind of worker actually gets when its run starts, at the process boundary: the built-in
// tools, the allowed tools, the MCP servers and the profile each runs in. A console with its own data
// and a stand-in for Claude (fake-claude.mjs) that records how it was started; nothing reaches a model.
//
//   node bench/integrations/effective-test.mjs --capture   records today's behaviour (golden-effective.json, golden-compose.json)
//   node bench/integrations/effective-test.mjs             checks now against the recording
//
// Checked: (1) what each worker is planned to get (its definition ∩ workspace, before accounts) equals
// the recording, apart from the changes in intentional.mjs, each with its reason; (2) each real launch
// gets exactly the effective plan; (3) effective = planned minus the tools whose accounts aren't
// available here (fail-closed), and nothing else: this console has no Figma token, a Figma bridge
// with no plugin, no Builder keys and no GitHub; (4) workers made by the creation flow resolve to the
// same tools and requirements the flow composed.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", "..");
const CAPTURE = process.argv.includes("--capture"), PORT = process.env.PORT || "8784", BRIDGE = "8779";
const ROOT = join(tmpdir(), `eff-${Date.now()}`), DATA = join(ROOT, "data"), OUT = join(ROOT, "fake");
mkdirSync(DATA, { recursive: true });
const BASE = `http://127.0.0.1:${PORT}`, H = { origin: BASE, "x-worker-console": "1", "content-type": "application/json" };
const call = (m, p, b) => fetch(BASE + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const results = [];
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail).slice(0, 240)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 1500)); }
};

// ---- the workers ----
// Shaped like the person's real workers (their tools and requirements, not their text), and one with
// exactly the core tools the General worker gets by default.
const DEFINED = {
  designer: { name: "Designer", capabilities: ["files.read", "files.write", "shell", "web", "browser", "figma.read", "figma.plugin.read", "figma.plugin.edit"], requirements: [{ resource: "figma", access: "edit", need: "required" }, { resource: "figma", access: "read", need: "optional" }] },
  builderEngineer: { name: "Builder engineer", capabilities: ["files.read", "files.write", "shell", "web", "browser", "figma.read", "figma.plugin.read", "figma.plugin.edit", "builder.read", "builder.write", "builder.write.draft"], requirements: [{ resource: "builder", access: "read", need: "required" }, { resource: "builder", access: "write", need: "required" }, { resource: "browser", access: "use", need: "required" }] },
  branchSync: { name: "Branch sync", capabilities: ["files.read", "gitflow.read"], requirements: [] },
  ...(CAPTURE ? {} : { coreDefault: { name: "Core default", capabilities: ["files.read", "files.write", "shell", "web", "browser"], requirements: [] } }),
};
// Made the usual way, from what the person asks for (the creation flow and its questions).
const REQUESTS = {
  gitsync: { description: "Keep sabir-dev in sync with dev-main and promote to preprod-main", answers: { gitsync: { team: "BAU", others: "Innovax", writes: "propose" } } },
  codeEdit: { description: "Build features in my Next.js repository", answers: {} },
  codeRead: { description: "Explain my React codebase", answers: { code: { change: "read", scripts: "no", browser: "no" } } },
  builderDrafts: { description: "Prepare Builder.io pages", answers: { builder: { publishing: "drafts", check: "yes" } } },
  builderPublish: { description: "Publish Builder.io content", answers: { builder: { publishing: "publish", check: "no" } } },
  figmaEdit: { description: "Design screens in Figma", answers: { figma: { edit: "edit", links: "yes" } } },
  figmaLook: { description: "Review designs in Figma", answers: { figma: { edit: "look", links: "no" } } },
  browser: { description: "Check our websites in a browser", answers: {} },
  research: { description: "Research competitors and summarise sources", answers: {} },
  filesEdit: { description: "Clean up the CSV reports in this folder", answers: { files: { change: "edit" } } },
  shopify: { description: "Manage products in my Shopify store", answers: { shopify: { scope: ["catalog", "theme"] } } },
  sheets: { description: "Analyse our Google Sheets", answers: { sheets: { scope: "analyse" } } },
  wordpress: { description: "Update my WordPress website", answers: { wordpress: { scope: ["content", "code"] } } },
  figmaBuilder: { description: "Turn Figma designs into Builder.io pages", answers: { figma: { edit: "look", links: "yes" }, builder: { publishing: "drafts", check: "yes" } } },
};

// What a launch says about access (no paths, ports or tokens: those change from run to run).
const PROFILE_ENV = ["FIGMA_EXECUTOR_PROFILE", "BUILDER_ADAPTER_PROFILE", "BROWSER_EXECUTOR_PROFILE", "GITFLOW_READ_ONLY"];
const shape = (r) => ({ tools: r.tools, allowedTools: [...(r.allowedTools || [])].sort(), restricted: r.restricted, settingSources: r.settingSources, permissionPrompts: r.permissionPrompts,
  servers: Object.fromEntries(Object.entries(r.servers || {}).sort(([a], [b]) => a.localeCompare(b)).map(([n, s]) => [n, Object.fromEntries(PROFILE_ENV.filter((k) => s.env?.[k] != null).map((k) => [k, s.env[k]]))])) });
// The same record from a launch plan's arguments (as fake-claude.mjs reads them).
function recordOf(args, servers) {
  const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  const list = (f) => { const i = args.indexOf(f); if (i < 0) return null; const r = []; for (let k = i + 1; k < args.length && !args[k].startsWith("--"); k++) r.push(args[k]); return r; };
  return { tools: val("--tools"), allowedTools: list("--allowedTools"), restricted: args.includes("--restricted"), settingSources: val("--setting-sources"), permissionPrompts: val("--permission-prompts"), servers };
}

// ---- a Figma bridge with no plugin, so a run never starts a real bridge here ----
const bridge = http.createServer((q, s) => { s.writeHead(200, { "content-type": "application/json" }); s.end(JSON.stringify({ bridge: "figma-ai-executor", protocol: 2, pid: 0, port: Number(BRIDGE), pluginConnected: false, sessions: [] })); });
await new Promise((ok, no) => bridge.listen(Number(BRIDGE), "127.0.0.1", ok).on("error", no));

// ---- the console ----
const env = { ...process.env, WORKER_CONSOLE_PORT: PORT, WORKER_CONSOLE_DATA: DATA, CLAUDE_BIN: process.execPath, CLAUDE_BIN_ARGS: JSON.stringify([join(HERE, "fake-claude.mjs")]), FAKE_CLAUDE_OUT: OUT,
  FIGMA_BRIDGE_PORT: BRIDGE, BUILDER_ADAPTER_DIR: join(DATA, "builder"), FIGMA_READER_DIR: join(DATA, "figma-reader"), GITHUB_CONNECTOR_DIR: join(DATA, "github") };
let busy = false; try { await fetch(BASE + "/"); busy = true; } catch {}
if (busy) { console.log(`port ${PORT} is in use: stop that process first`); process.exit(1); }
const srv = spawn(process.execPath, [join(REPO, "worker-ui", "server.mjs")], { env, stdio: ["ignore", "ignore", "pipe"] });
let srvErr = ""; srv.stderr.on("data", (d) => (srvErr += d));
for (let i = 0; ; i++) { try { await fetch(BASE + "/"); break; } catch { if (i > 80 || srv.exitCode != null) throw new Error(`console didn't start: ${srvErr.slice(-600)}`); await sleep(250); } }
const folder = (n) => { const d = join(ROOT, n); mkdirSync(d, { recursive: true }); execFileSync("git", ["init", "-q", d]); writeFileSync(join(d, "README.md"), n); return d; };
const WS = { work: (await call("POST", "/workspaces", { name: "Work folder", path: folder("work"), mode: "work" })).body.id, inspect: (await call("POST", "/workspaces", { name: "Inspect folder", path: folder("inspect"), mode: "inspect" })).body.id };

const workers = {};
for (const [k, d] of Object.entries(DEFINED)) { const r = await call("POST", "/workers", { ...d, mission: k }); if (r.status !== 200) throw new Error(`${k}: ${JSON.stringify(r.body)}`); workers[k] = r.body.id; }
const composed = {}, created = {};
for (const [k, q] of Object.entries(REQUESTS)) {
  const pv = await call("POST", "/worker-drafts/preview", { ...q, workspace: WS.work });
  composed[k] = { integrations: pv.body.integrations, definition: pv.body.definition, starters: pv.body.starters, unsupported: pv.body.unsupported?.map((u) => u.id) };
  const r = await call("POST", "/workers/from-request", { ...q, workspace: WS.work });
  if (r.status !== 200) throw new Error(`${k}: ${JSON.stringify(r.body)}`);
  workers[`req:${k}`] = r.body.id; created[k] = r.body;
}

// One run per worker and workspace: started, recorded by the stand-in, stopped.
async function launch(worker, ws) {
  const before = new Set(existsSync(OUT) ? readdirSync(OUT) : []);
  const r = await call("POST", "/runs", { prompt: "hello", workspace: ws, ...(worker ? { worker } : {}) });
  if (r.status !== 200) return { refused: r.body?.error || r.status };
  let file; for (let i = 0; i < 100 && !file; i++) { await sleep(100); file = (existsSync(OUT) ? readdirSync(OUT) : []).find((f) => !before.has(f)); }
  if (!file) throw new Error(`no launch recorded for ${worker || "General"} in ${ws}`);
  await sleep(150);
  const rec = JSON.parse(readFileSync(join(OUT, file), "utf8"));
  await call("POST", `/runs/${r.body.id}/stop`, {});
  for (let i = 0; i < 50; i++) { const a = (await call("GET", "/runs")).body.active; if (!a) break; await sleep(100); }
  return { shape: shape(rec), env: rec.servers };
}
const observed = {}, planned = {}, effective = {}, gates = {}, authzEnv = {}, usable = {};
for (const [k, id] of [["General", null], ...Object.entries(workers)]) for (const [m, ws] of Object.entries(WS)) {
  const key = `${k} @ ${m}`;
  if (!CAPTURE) {
    const pv = (await call("GET", `/access/preview?worker=${id || "general"}&workspace=${ws}`)).body;
    planned[key] = shape(recordOf(pv.planned.args, pv.planned.servers)); effective[key] = shape(recordOf(pv.effective.args, pv.effective.servers)); gates[key] = pv.gate; usable[key] = { planned: pv.planned.usable, effective: pv.effective.usable, waiting: Object.keys(pv.waiting || {}) };
  }
  const l = await launch(id, ws); observed[key] = l.shape; authzEnv[key] = l.env;
}
srv.kill(); bridge.close();

const GOLD_E = join(HERE, "golden-effective.json"), GOLD_C = join(HERE, "golden-compose.json");
if (CAPTURE) {
  writeFileSync(GOLD_E, JSON.stringify({ capturedAt: new Date().toISOString(), note: "Effective access at the process boundary, recorded before the integration architecture changed (P0).", observed }, null, 1));
  writeFileSync(GOLD_C, JSON.stringify({ capturedAt: new Date().toISOString(), composed }, null, 1));
  console.log(`captured ${Object.keys(observed).length} launches and ${Object.keys(composed).length} compositions`);
  process.exit(0);
}

// ---- checking against the recording ----
const INTENTIONAL = (await import("./intentional.mjs")).default;
const gold = JSON.parse(readFileSync(GOLD_E, "utf8")).observed;
await step("planned access (definition ∩ workspace, before accounts) matches the recording for every worker, apart from the intentional changes (each with its reason)", async () => {
  const diffs = [];
  for (const [k, g] of Object.entries(gold)) {
    const want = INTENTIONAL.expect(k, structuredClone(g), planned), got = planned[k];
    if (JSON.stringify(want) !== JSON.stringify(got)) diffs.push({ launch: k, expected: want, got });
  }
  if (diffs.length) throw new Error(JSON.stringify(diffs.slice(0, 3), null, 1) + (diffs.length > 3 ? `\n… and ${diffs.length - 3} more` : ""));
  return { launches: Object.keys(gold).length, intentional: INTENTIONAL.reasons };
});
await step("every real launch starts with exactly the effective plan (the stand-in's record equals /access/preview's effective)", async () => {
  const diffs = Object.keys(observed).filter((k) => JSON.stringify(observed[k]) !== JSON.stringify(effective[k])).map((k) => ({ launch: k, effective: effective[k], launched: observed[k] }));
  if (diffs.length) throw new Error(JSON.stringify(diffs.slice(0, 2), null, 1));
  return { launches: Object.keys(observed).length };
});
await step("fail-closed: an integration tool whose account isn't available here starts off and waits for its connection (Figma: no token, no plugin; Builder: no keys), each saying why; nothing is taken away or added", async () => {
  const NEED = { "figma.read": /Figma: read designs/, "figma.plugin.read": /Figma: change the open file/, "figma.plugin.edit": /Figma: change the open file/, "builder.read": /Builder\.io: read content/, "builder.write": /Builder\.io/, "builder.write.draft": /Builder\.io/ };
  const wrong = [];
  for (const [k, gate] of Object.entries(gates)) {
    for (const [c, why] of Object.entries(gate)) if (!NEED[c] || !NEED[c].test(why)) wrong.push({ launch: k, gated: c, why });
    // Integration capabilities stay loaded with their tools off (they come on in the run when connected): the
    // launch keeps exactly what was planned, and what's gated is exactly what waits.
    if (JSON.stringify(usable[k].planned) !== JSON.stringify(usable[k].effective)) wrong.push({ launch: k, planned: usable[k].planned, effective: usable[k].effective });
    const gated = Object.keys(gate).filter((c) => usable[k].planned.includes(c)).sort(), waiting = [...usable[k].waiting].sort();
    if (JSON.stringify(gated) !== JSON.stringify(waiting)) wrong.push({ launch: k, gated, waiting });
  }
  if (wrong.length) throw new Error(JSON.stringify(wrong.slice(0, 4), null, 1));
  return { gatedLaunches: Object.entries(gates).filter(([, g]) => Object.keys(g).length).length, example: gates["designer @ work"] };
});
await step("integration tool servers get the per-call check (an authorization address and the run's token); core ones don't need it", async () => {
  const bad = [];
  for (const [k, servers] of Object.entries(authzEnv)) for (const [n, s] of Object.entries(servers || {})) {
    const guarded = ["figma-executor", "figma-reader", "builder", "gitflow", "repo"].includes(n), has = !!(s.env?.AIW_AUTHZ_URL && s.env?.AIW_AUTHZ_TOKEN);
    if (guarded !== has) bad.push(`${k}: ${n}`);
  }
  if (bad.length) throw new Error(bad.join(", "));
  return { checked: Object.keys(authzEnv).length };
});
await step("workers made by the creation flow are schema 2 (integrations pinned, core tools explicit) and resolve to the tools and requirements the flow composed", async () => {
  const gc = JSON.parse(readFileSync(GOLD_C, "utf8")).composed, wrong = [];
  for (const [k, g] of Object.entries(gc)) {
    const want = INTENTIONAL.compose(k, structuredClone(g)), got = composed[k], w = created[k];
    const pick = (x) => ({ integrations: x.integrations, capabilities: [...x.definition.capabilities].sort(), requirements: x.definition.requirements, name: x.definition.name, specialization: x.definition.specialization, unsupported: x.unsupported, starters: x.starters });
    if (JSON.stringify(pick(want)) !== JSON.stringify(pick(got))) wrong.push({ request: k, composedNow: pick(got), recorded: pick(want) });
    if (w.schema !== 2 || w.integrations.map((i) => i.id).join() !== got.integrations.join() || w.integrations.some((i) => !/^\d+\.\d+\.\d+$/.test(i.version))) wrong.push({ request: k, stored: { schema: w.schema, integrations: w.integrations } });
    if ([...w.capabilities].sort().join() !== [...got.definition.capabilities].sort().join() || JSON.stringify(w.requirements) !== JSON.stringify(got.definition.requirements)) wrong.push({ request: k, resolved: { capabilities: w.capabilities, requirements: w.requirements }, composed: { capabilities: got.definition.capabilities, requirements: got.definition.requirements } });
    if (w.core.some((c) => !["files.read", "files.write", "shell", "web", "browser"].includes(c))) wrong.push({ request: k, core: w.core });
  }
  if (wrong.length) throw new Error(JSON.stringify(wrong.slice(0, 3), null, 1));
  return { requests: Object.keys(gc).length };
});
writeFileSync(join(HERE, "effective-results.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
