// Builder capabilities through the platform's own access control, with the real worker: which
// Builder tools a run actually gets (Claude Code's own init report), per workspace mode and per
// capability; what the requirements say for no / production / test credentials; and that no
// Builder key or API base reaches the worker. Builder's API is the local mock (no real Builder).
//   CANARY=<inspect folder> WORK=<work folder> DATA=<console data dir> BUILDER_DIR=<console's BUILDER_ADAPTER_DIR>
//   node bench/workspace-ui/builder-access-test.mjs <port>     (run-suite.sh builder)
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, KEYS } from "../builder/mock-builder.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const [port = "8797"] = process.argv.slice(2);
const BASE = `http://127.0.0.1:${port}`, DATA = process.env.DATA, BDIR = process.env.BUILDER_DIR;
const H = { origin: BASE, "x-worker-console": "1", "content-type": "application/json" };
const call = (method, path, data) => fetch(BASE + path, { method, headers: H, body: data ? JSON.stringify(data) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const results = [];
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail).slice(0, 260)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 300)); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const raw = (id) => readFileSync(join(DATA, "runs", `${id}.raw.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const initTools = (id) => raw(id).find((m) => m.type === "system" && m.subtype === "init")?.tools || [];
const until = async (fn, ms = 300000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((ok) => setTimeout(ok, 1000)); } };
const creds = (c) => { mkdirSync(BDIR, { recursive: true }); if (c) writeFileSync(join(BDIR, "credentials.json"), JSON.stringify(c)); else rmSync(join(BDIR, "credentials.json"), { force: true }); };
const builderTools = (t) => t.filter((x) => x.startsWith("mcp__builder__")).map((x) => x.replace("mcp__builder__", "")).sort();
async function runOnce(workspace, worker) {
  const r = (await call("POST", "/runs", { prompt: "Reply with exactly: OK", workspace, worker })).body;
  assert(r?.id, `run not started: ${JSON.stringify(r)}`);
  await until(async () => ["waiting", "finished", "failed"].includes((await call("GET", `/runs/${r.id}`)).body.status));
  await call("POST", `/runs/${r.id}/end`);
  await until(async () => !(await call("GET", "/runs")).body.active, 60000);
  return { id: r.id, tools: builderTools(initTools(r.id)), mcp: JSON.parse(readFileSync(join(DATA, "runs", `${r.id}.mcp.json`), "utf8")).mcpServers.builder };
}

const mock = await startMock({ port: 8789 }); // the console's BUILDER_*_BASE point here (run-suite.sh)
const canary = (await call("POST", "/workspaces", { name: "Canary", path: process.env.CANARY, mode: "inspect" })).body;
const work = (await call("POST", "/workspaces", { name: "Work test", path: process.env.WORK, mode: "work" })).body;
const REQS = [{ resource: "builder", access: "read", need: "required" }, { resource: "builder", access: "write", need: "required" }];
const editor = (await call("POST", "/workers", { name: "Builder Editor", mission: "Edit Builder content.", capabilities: ["builder.read", "builder.write"], requirements: REQS })).body;
const reader = (await call("POST", "/workers", { name: "Builder Reader", mission: "Read Builder content.", capabilities: ["builder.read"], requirements: [REQS[0]] })).body;
const status = async (wid) => (await call("GET", `/workers?workspace=${work.id}`)).body.workers.find((w) => w.id === wid).status.map((s) => `${s.access}:${s.state}`);

await step("the catalogue offers builder.read (both modes) and builder.write (Work only)", async () => {
  const caps = (await call("GET", "/workers")).body.capabilities.filter((c) => c.id.startsWith("builder"));
  assert(caps.find((c) => c.id === "builder.read").profiles.join() === "full,inspect" && caps.find((c) => c.id === "builder.write").profiles.join() === "full", JSON.stringify(caps));
  return caps;
});

await step("requirements: no credentials → both Not connected", async () => {
  creds(null);
  const s = await status(editor.id);
  assert(s.join() === "read:Not connected,write:Not connected", s.join());
  return s;
});

await step("requirements: a production space → read Connected, write refused", async () => {
  creds({ label: "Prod", environment: "production", publicKey: KEYS.public, privateKey: KEYS.private });
  const s = await status(editor.id);
  assert(s.join() === "read:Connected,write:Production space: writes refused", s.join());
  return s;
});

await step("requirements: a test space → write available", async () => {
  creds({ label: "Test", environment: "test", publicKey: KEYS.public, privateKey: KEYS.private });
  const s = await status(editor.id);
  assert(s.includes("write:Test space"), s.join());
  return s;
});

await step("Inspect workspace: the editor's run gets only the read tools; its server is read-only", async () => {
  const r = await runOnce(canary.id, editor.id);
  assert(r.tools.join() === "builder_access_status,builder_get_content,builder_list_content,builder_list_models,builder_verify_content", r.tools.join());
  assert(r.mcp.env.BUILDER_ADAPTER_PROFILE === "read" && !("BUILDER_UPLOAD_ROOT" in r.mcp.env), JSON.stringify(r.mcp.env));
  return r;
});

await step("Work workspace: the editor's run gets the write tools too", async () => {
  const r = await runOnce(work.id, editor.id);
  for (const t of ["builder_create_draft", "builder_update_content", "builder_publish_content", "builder_upload_asset"]) assert(r.tools.includes(t), r.tools.join());
  assert(r.mcp.env.BUILDER_ADAPTER_PROFILE === "full", JSON.stringify(r.mcp.env));
  return r;
});

await step("Work workspace, read-only worker: no write tools (capabilities narrow, never widen)", async () => {
  const r = await runOnce(work.id, reader.id);
  assert(!r.tools.some((t) => /create_draft|update_content|publish_content|upload_asset/.test(t)) && r.tools.includes("builder_get_content"), r.tools.join());
  assert(!("BUILDER_UPLOAD_ROOT" in r.mcp.env), "a read-only worker gets no file access");
  return r;
});

await step("no Builder key or API base reaches the worker: a profile, the credentials folder, and its own workspace as the only upload root", async () => {
  const r = await runOnce(work.id, editor.id);
  const keys = Object.keys(r.mcp.env).sort();
  assert(keys.join() === "BUILDER_ADAPTER_DIR,BUILDER_ADAPTER_PROFILE,BUILDER_UPLOAD_ROOT", keys.join());
  assert(r.mcp.env.BUILDER_UPLOAD_ROOT.toLowerCase() === process.env.WORK.toLowerCase(), `${r.mcp.env.BUILDER_UPLOAD_ROOT} vs ${process.env.WORK}`);
  const rawText = readFileSync(join(DATA, "runs", `${r.id}.raw.jsonl`), "utf8") + readFileSync(join(DATA, "runs", `${r.id}.worker.md`), "utf8");
  assert(!rawText.includes(KEYS.private) && !rawText.includes(KEYS.public), "a key appears in the run's transcript or context");
  return { env: keys };
});

await step("a General worker (no definition) gets no Builder tools", async () => {
  const r = (await call("POST", "/runs", { prompt: "Reply with exactly: OK", workspace: work.id })).body;
  await until(async () => ["waiting", "finished", "failed"].includes((await call("GET", `/runs/${r.id}`)).body.status));
  await call("POST", `/runs/${r.id}/end`);
  await until(async () => !(await call("GET", "/runs")).body.active, 60000);
  const t = builderTools(initTools(r.id));
  assert(t.length === 0, t.join());
  return { builderTools: t.length };
});

creds(null);
await mock.close();
writeFileSync(join(HERE, "builder-access-results.json"), JSON.stringify({ when: new Date().toISOString(), results }, null, 1));
console.log(`\n${results.filter((x) => x.ok).length}/${results.length} passed`);
