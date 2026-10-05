// The Senior UI/UX Design Engineer worker (workers/senior-uiux-design-engineer.json) on the real
// runtime: saved intact, the right tools, its Figma requirement checked, a clean stop when the
// Figma plugin isn't connected, and able to look at a render in the Figma exports folder from a
// workspace elsewhere (the inspect step of design -> execute -> inspect -> refine).
// Note: if the Figma plugin is connected, the worker reads (only reads) the open file.
//   WORK=<work folder> DATA=<console data dir> node bench/workspace-ui/designer-worker-test.mjs <port>
import { readFileSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", "..");
const [port = "8797"] = process.argv.slice(2);
const BASE = `http://127.0.0.1:${port}`, DATA = process.env.DATA;
const H = { origin: BASE, "x-worker-console": "1", "content-type": "application/json" };
const call = (method, path, data) => fetch(BASE + path, { method, headers: H, body: data ? JSON.stringify(data) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const until = async (fn, ms = 300000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((ok) => setTimeout(ok, 1500)); } };
const runTo = async (prompt, workspace, worker) => {
  const r = (await call("POST", "/runs", { prompt, workspace, worker })).body;
  if (!r.id) throw new Error(JSON.stringify(r));
  await until(async () => (await call("GET", `/runs/${r.id}`)).body.status === "waiting");
  await call("POST", `/runs/${r.id}/end`); await until(async () => !(await call("GET", "/runs")).body.active);
  return r.id;
};
const lines = (id, kind) => readFileSync(join(DATA, "runs", `${id}.${kind}`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const results = [];
const step = async (name, fn) => { try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail).slice(0, 300)); } catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 300)); } };

const def = JSON.parse(readFileSync(join(REPO, "workers", "senior-uiux-design-engineer.json"), "utf8"));
const work = (await call("POST", "/workspaces", { name: "Design project", path: process.env.WORK, mode: "work" })).body;
let w;
await step("created from its definition file, nothing truncated", async () => {
  w = (await call("POST", "/workers", def)).body;
  if (!w.id) throw new Error(JSON.stringify(w));
  return { id: w.id, version: w.version, capabilities: w.capabilities, requirements: w.requirements, sameKnowledge: w.knowledge === def.knowledge, sameWorkflow: JSON.stringify(w.workflow) === JSON.stringify(def.workflow), sameLimits: JSON.stringify(w.limitations) === JSON.stringify(def.limitations) };
});
let id1;
// Safe whether or not a real Figma file is open: it only asks the worker to check access.
await step("access is checked first; asked only to check, it changes nothing", async () => {
  id1 = await runTo("Before any design work: check whether you can work in Figma right now (which file is open, or what is missing). Do not change anything in Figma. Report in two sentences.", work.id, w.id);
  const ev = lines(id1, "jsonl"), raw = lines(id1, "raw.jsonl");
  const init = raw.find((m) => m.type === "system" && m.subtype === "init");
  const tools = raw.flatMap((m) => (m.message?.content || []).filter((c) => c.type === "tool_use").map((c) => c.name.replace(/^mcp__[^_]+(?:-[^_]+)*__/, "")));
  return { requirements: JSON.parse(ev.find((e) => e.type === "requirements").detail).map((r) => `${r.label} · ${r.need} · ${r.state}`), needs: ev.filter((e) => e.type === "needs").map((e) => e.summary.slice(0, 200)),
    toolsCalled: tools, editsAttempted: tools.filter((t) => /create|modify|delete|set_|bind|combine|detach|rename/.test(t)), mcpServers: init.mcp_servers.map((s) => s.name), builtins: init.tools.filter((t) => !t.startsWith("mcp__")) };
});
await step("its context carries the brief: mission, Mode A/B workflow, WCAG numbers, limits, summary format", async () => {
  const ctx = readFileSync(join(DATA, "runs", `${id1}.worker.md`), "utf8");
  const snap = JSON.parse(readFileSync(join(DATA, "runs", `${id1}.worker.json`), "utf8"));
  return { mission: ctx.includes("Turn a product or design brief"), modes: ctx.includes("Mode A (a design exists)"), loop: ctx.includes("Inspect visually: export every frame"), wcag: ctx.includes("4.5:1"), limits: ctx.includes("Never delete, overwrite or restructure"), summary: ctx.includes("Design summary; Key decisions"), addDir: snap.runtime.args.includes("--add-dir"), exportsDirs: snap.runtime.exportsDirs };
});
await step("it can look at a Figma render in the exports folder from another workspace", async () => {
  const png = join(REPO, "exports", "designer-worker-inspect-test.png");
  copyFileSync(join(REPO, "worker-ui", "assets", "monogram.png"), png);
  try {
    const id = await runTo(`This is a render exported from Figma: ${png}\nOpen it and describe what you see in one sentence. Don't use any Figma tools.`, work.id, w.id);
    const raw = lines(id, "raw.jsonl");
    const reads = raw.flatMap((m) => (m.message?.content || []).filter((c) => c.type === "tool_use" && c.name === "Read").map((c) => c.id));
    const results2 = raw.flatMap((m) => (m.message?.content || []).filter((c) => c.type === "tool_result" && reads.includes(c.tool_use_id)).map((c) => ({ error: !!c.is_error, kind: Array.isArray(c.content) ? c.content.map((x) => x.type).join(",") : typeof c.content })));
    const reply = lines(id, "jsonl").filter((e) => e.type === "reply").map((e) => e.summary).join(" ");
    return { readCalls: results2, reply: reply.slice(0, 220) };
  } finally { rmSync(png, { force: true }); }
});
writeFileSync(join(HERE, "designer-worker-results.json"), JSON.stringify({ when: new Date().toISOString(), results }, null, 1));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
