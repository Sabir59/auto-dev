// Worker evolution, deterministic: versions, restore, the integrity check, the evolve tools and their
// boundaries, proposals (validation, approval, stale, trial runs, grading), and what a run gets.
// A console with its own data, a stand-in for Claude (fake-claude.mjs, answering "SAY: …" lines),
// and a stand-in Builder (a local mock) for the console's grading reads. Nothing reaches a model.
//   node bench/integrations/evolve-test.mjs
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", "..");
const { Client } = await import("../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js");
const { StdioClientTransport } = await import("../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js");
const evolve = await import("../../worker-ui/evolve.mjs");
const PORT = process.env.PORT || "8783", MOCK = "8773";
const ROOT = join(tmpdir(), `evolve-${Date.now()}`), DATA = join(ROOT, "data"), OUT = join(ROOT, "fake"), BDIR = join(ROOT, "builder"); mkdirSync(DATA, { recursive: true }); mkdirSync(BDIR, { recursive: true });
const BASE = `http://127.0.0.1:${PORT}`, H = { origin: BASE, "x-worker-console": "1", "content-type": "application/json" };
const call = (m, p, b, h = H) => fetch(BASE + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const results = [];
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail).slice(0, 260)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 900)); }
};
const assert = (c, m) => { if (!c) throw new Error(typeof m === "string" ? m : JSON.stringify(m)); };

// ---- a stand-in Builder: models (the account check) and content (the grading reads) ----
const MODEL = "page"; let entries = [];
const mock = http.createServer((q, s) => {
  let b = ""; q.on("data", (d) => (b += d)); q.on("end", () => {
    s.writeHead(200, { "content-type": "application/json" });
    const u = new URL(q.url, "http://x");
    if (u.pathname === "/api/v2/admin") return s.end(JSON.stringify({ data: { models: [{ id: "m1", name: MODEL, kind: "page" }] } }));
    if (u.pathname === `/api/v3/content/${MODEL}`) { const id = u.searchParams.get("query.id"), off = Number(u.searchParams.get("offset") || 0); const rows = id ? entries.filter((e) => e.id === id) : entries.slice(off, off + 100); return s.end(JSON.stringify({ results: rows })); }
    s.end("{}");
  });
});
await new Promise((ok, no) => mock.listen(Number(MOCK), "127.0.0.1", ok).on("error", no));
const CRED = join(BDIR, "credentials.json"), connectBuilder = () => writeFileSync(CRED, JSON.stringify({ label: "Mock test space", environment: "test", publicKey: "pub-mock", privateKey: "bpk-mock" }));
connectBuilder();

const env = { ...process.env, WORKER_CONSOLE_PORT: PORT, WORKER_CONSOLE_DATA: DATA, CLAUDE_BIN: process.execPath, CLAUDE_BIN_ARGS: JSON.stringify([join(HERE, "fake-claude.mjs")]), FAKE_CLAUDE_OUT: OUT, FAKE_CLAUDE_REPLY: "1",
  BUILDER_ADAPTER_DIR: BDIR, BUILDER_ADMIN_BASE: `http://127.0.0.1:${MOCK}`, BUILDER_CONTENT_BASE: `http://127.0.0.1:${MOCK}`, BUILDER_WRITE_BASE: `http://127.0.0.1:${MOCK}`,
  FIGMA_READER_DIR: join(DATA, "figma-reader"), GITHUB_CONNECTOR_DIR: join(DATA, "github"), FIGMA_BRIDGE_PORT: "8774" };
let busy = false; try { await fetch(BASE + "/"); busy = true; } catch {}
if (busy) { console.log(`port ${PORT} is in use: stop that process first`); process.exit(1); }
const srv = spawn(process.execPath, [join(REPO, "worker-ui", "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; srv.stdout.on("data", (d) => (log += d)); srv.stderr.on("data", (d) => (log += d));
for (let i = 0; ; i++) { try { await fetch(BASE + "/"); break; } catch { if (i > 80 || srv.exitCode != null) throw new Error(`console didn't start: ${log.slice(-800)}`); await sleep(250); } }
const dir = join(ROOT, "work"); mkdirSync(dir); execFileSync("git", ["init", "-q", dir]); writeFileSync(join(dir, "a.txt"), "a");
const WS = (await call("POST", "/workspaces", { name: "Work", path: dir, mode: "work" })).body.id;

const seed = JSON.parse(readFileSync(join(REPO, "workers", "builder-content-editor.json"), "utf8"));
const raw = () => JSON.parse(readFileSync(join(DATA, "workers.json"), "utf8"));
const storedOf = (id) => raw().find((w) => w.id === id);
const hist = (id) => join(DATA, "workers", id, "history");
const runsDir = join(DATA, "runs");
async function start(worker, prompt = "hello", extra = {}) {
  const r = await call("POST", "/runs", { prompt, workspace: WS, ...(worker ? { worker } : {}), ...extra });
  if (r.status !== 200) return r;
  for (let i = 0; i < 100; i++) { const a = (await call("GET", "/runs")).body; if (a.active === r.body.id && existsSync(join(runsDir, `${r.body.id}.mcp.json`))) break; await sleep(100); }
  await sleep(300);
  return { status: 200, id: r.body.id, mcp: JSON.parse(readFileSync(join(runsDir, `${r.body.id}.mcp.json`), "utf8")).mcpServers };
}
const stopAll = async () => { const a = (await call("GET", "/runs")).body.active; if (a) await call("POST", `/runs/${a}/stop`, {}); for (let i = 0; i < 50; i++) { if (!(await call("GET", "/runs")).body.active) break; await sleep(100); } };
// The stand-in's record of how this run was started: matched by the run's own MCP config file
// (<runs>/<id>.mcp.json in its argv), waiting for it to be written. Never another run's record: the
// General worker's run has no evolve or authz URL to tell it apart, and the stand-in can start slowly.
const fakeRecord = async (runId) => {
  for (let i = 0; i < 50; i++) {
    const recs = existsSync(OUT) ? readdirSync(OUT).filter((f) => /^\d+-\d+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(OUT, f), "utf8"))) : [];
    const hit = recs.find((r) => (r.argv || []).some((a) => a.includes(`${runId}.mcp.json`)));
    if (hit) return hit;
    await sleep(100);
  }
  throw new Error(`no record of how run ${runId} was started`);
};
const events = (id) => readFileSync(join(runsDir, `${id}.jsonl`), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
async function waitTurn(id) { for (let i = 0; i < 100; i++) { const m = (await call("GET", `/runs/${id}`)).body; if (m.status === "waiting") return m; await sleep(100); } throw new Error(`run ${id} didn't finish its turn`); }

let W;
// ---------------- versions ----------------
await step("creating a worker records version 1; each save records the next version with its parent and reason, never overwriting one", async () => {
  W = (await call("POST", "/workers", seed)).body;
  const e = await call("PUT", `/workers/${W.id}`, { ...storedOf(W.id), knowledge: seed.knowledge + "\nEdited once.", reason: "a clarification" });
  assert(e.status === 200 && e.body.version === 2, e.body);
  const v1 = JSON.parse(readFileSync(join(hist(W.id), "v1.json"), "utf8")), v2 = JSON.parse(readFileSync(join(hist(W.id), "v2.json"), "utf8"));
  assert(v1.parent === null && v1.source.kind === "create" && v2.parent === 1 && v2.source.kind === "edit" && v2.reason === "a clarification" && JSON.stringify(v2.definition) === JSON.stringify(storedOf(W.id)), { v1: v1.source, v2: { parent: v2.parent, source: v2.source } });
  const l = (await call("GET", `/workers/${W.id}/versions`)).body;
  assert(l.current === 2 && l.recorded && l.versions.map((v) => v.version).join() === "2,1" && !l.integrity, l);
  const d = (await call("GET", `/workers/${W.id}/versions/1/diff`)).body;
  assert(d.from === 1 && d.to === 2 && d.diff.length === 1 && d.diff[0].field === "knowledge" && d.diff[0].lines.some((x) => x.op === "+" && x.text === "Edited once."), d);
  return { versions: l.versions.map((v) => `${v.version}:${v.source.kind}`), diff: d.diff.map((x) => x.field) };
});
await step("restore: an earlier version comes back as a NEW version (history kept); restoring the current one is refused", async () => {
  const r = await call("POST", `/workers/${W.id}/restore`, { version: 1, reason: "back to the original" });
  assert(r.status === 200 && r.body.version === 3, r.body);
  const v1 = JSON.parse(readFileSync(join(hist(W.id), "v1.json"), "utf8")).definition, now = storedOf(W.id), v3 = JSON.parse(readFileSync(join(hist(W.id), "v3.json"), "utf8"));
  const strip = ({ version, updatedAt, ...x }) => x;
  assert(JSON.stringify(strip(now)) === JSON.stringify(strip(v1)) && v3.source.kind === "restore" && v3.source.restoredFrom === 1 && v3.parent === 2 && existsSync(join(hist(W.id), "v2.json")), { now: strip(now).knowledge.slice(-20), v3: v3.source });
  const again = await call("POST", `/workers/${W.id}/restore`, { version: 3 });
  assert(again.status === 400, again);
  return { restored: "v1 → v3", kept: [1, 2, 3] };
});
await step("a worker from before history gets its previous form recorded on its first change (so it can be compared and restored)", async () => {
  const list = raw(); list.push({ ...structuredClone(list[0]), id: "legacy-0001", name: "Legacy worker", version: 4 }); writeFileSync(join(DATA, "workers.json"), JSON.stringify(list, null, 1));
  const r = await call("PUT", `/workers/legacy-0001`, { ...storedOf("legacy-0001"), knowledge: "changed" });
  const v4 = JSON.parse(readFileSync(join(hist("legacy-0001"), "v4.json"), "utf8")), v5 = JSON.parse(readFileSync(join(hist("legacy-0001"), "v5.json"), "utf8"));
  assert(r.body.version === 5 && v4.source.kind === "before-history" && v5.parent === 4, { v4: v4.source, v5: v5.parent });
  return { recorded: ["v4 before-history", "v5 edit"] };
});

// ---------------- integrity ----------------
await step("integrity: a definition changed outside the console (the file edited directly) isn't run; saving it in the editor records it and it runs again", async () => {
  const list = raw(); list.find((w) => w.id === W.id).limitations = []; writeFileSync(join(DATA, "workers.json"), JSON.stringify(list, null, 1));
  const r = await call("POST", "/runs", { prompt: "hello", workspace: WS, worker: W.id });
  assert(r.status === 409 && /changed outside the console/.test(r.body.error), r);
  const l = (await call("GET", `/workers/${W.id}/versions`)).body; assert(/changed outside/.test(l.integrity || ""), l);
  const fixed = await call("PUT", `/workers/${W.id}`, { ...storedOf(W.id), limitations: seed.limitations, reason: "reviewed after an outside change" });
  assert(fixed.status === 200, fixed);
  const ok = await start(W.id); assert(ok.status === 200, ok); await stopAll();
  return { refused: r.body.error.slice(0, 120), thenRecorded: fixed.body.version };
});

// ---------------- what a run gets ----------------
let run;
await step("a defined worker's run gets the evolve tools (with its run's token) and the platform's deny rules; the General worker gets no evolve tools", async () => {
  run = await start(W.id);
  const ev = run.mcp.evolve, rec = await fakeRecord(run.id);
  assert(ev && ev.env.EVOLVE_URL.endsWith(`/evolve/${run.id}`) && ev.env.EVOLVE_TOKEN.length >= 32 && rec.allowedTools.includes("mcp__evolve"), { servers: Object.keys(run.mcp), allowed: rec.allowedTools });
  const deny = rec.deny, d = (p) => deny.some((x) => x.includes(p));
  const want = ["/workers.json)", "/workers/**)", "/teams/**)", "/runs/**)", "integrations/**)", "worker-instructions.md)", "Edit(.claude/**)", "Edit(**/CLAUDE.md)", "Edit(**/AGENTS.md)", "Edit(**/CLAUDE.local.md)"];
  const missing = want.filter((p) => !(p === "/workers.json)" ? deny.some((x) => x.endsWith("/*.json)")) : d(p)));
  assert(!missing.length, { missing, deny });
  await stopAll();
  const g = await start(null); const grec = await fakeRecord(g.id);
  assert(!g.mcp.evolve && !grec.allowedTools?.includes("mcp__evolve") && grec.deny.some((x) => x.includes("Edit(**/CLAUDE.md)")), { servers: Object.keys(g.mcp), allowed: grec.allowedTools });
  await stopAll();
  run = await start(W.id, "hello");
  return { evolve: true, denyRules: want.length };
});

// ---------------- the evolve tools' boundaries ----------------
await step("the evolve endpoints answer only this run's token, for its own worker: a wrong token, another run or another Host is refused", async () => {
  const { EVOLVE_URL: url, EVOLVE_TOKEN: token } = run.mcp.evolve.env || {};
  assert(url, { why: "no EVOLVE_URL", run });
  const ok = await fetch(url + "/self", { headers: { "x-aiw-evolve": token } }), bad = await fetch(url + "/self", { headers: { "x-aiw-evolve": "x".repeat(token.length) } });
  const other = await fetch(url.replace(run.id, "2020-01-01T00-00-00-000Z") + "/self", { headers: { "x-aiw-evolve": token } });
  const host = await new Promise((done) => http.get(url + "/self", { headers: { "x-aiw-evolve": token, host: "evil.example" } }, (r) => { r.resume(); done(r.statusCode); }).on("error", () => done("error")));
  const self = await ok.json();
  assert(ok.status === 200 && bad.status === 403 && other.status === 403 && host === 403 && self.id === W.id && self.version === storedOf(W.id).version && self.canChange.includes("workflow") && !self.canChange.includes("capabilities"), { ok: ok.status, bad: bad.status, other: other.status, host, self });
  return { self: { version: self.version, canChange: self.canChange, tools: self.tools.map((t) => t.id) } };
});
await step("the worker's token can't reach the person's endpoints (approve, edit, restore): the console's guard refuses it", async () => {
  const { EVOLVE_TOKEN: token } = run.mcp.evolve, h = { "x-aiw-evolve": token, "content-type": "application/json" };
  const put = await call("PUT", `/workers/${W.id}`, { ...storedOf(W.id), knowledge: "x" }, h), restore = await call("POST", `/workers/${W.id}/restore`, { version: 1 }, h);
  assert(put.status === 403 && restore.status === 403, { put, restore });
  return { put: put.body.error, restore: restore.body.error };
});

// ---------------- proposing through the real tool server ----------------
let mcp, P1;
const listP = () => (existsSync(join(DATA, "workers", W.id, "proposals")) ? readdirSync(join(DATA, "workers", W.id, "proposals")) : []);
const goodProposal = (v) => ({ baseVersion: v, title: "A/B variant drafts in our convention", reason: "The person described their A/B convention; the definition has no A/B steps.",
  expected: "Variant drafts named and tagged the organisation's way.", acceptance: ["One draft per variant", "Tagged with abExperiment and abVariant"],
  changes: { workflow: [...seed.workflow, "For an A/B variant: create a separate DRAFT entry named \"<control name> [AB <experiment> <letter>]\", data.abExperiment, data.abVariant, data.abControlId."] },
  uses: ["builder.read", "builder.write.draft"], needs: [{ what: "Native Builder A/B variations", why: "The Builder tools can't write an entry's variations field." }],
  checks: [{ type: "builder_entry", model: MODEL, name: "\\[AB EXP-1 B\\]$", expect: { count: 1, published: "draft", fields: { abExperiment: "^EXP-1$", abVariant: "^B$", variations: { absent: true } } } }],
  trialPrompt: "Create variant B of the control page for experiment EXP-1." });
await step("through the evolve tool server (MCP): read itself, then proposals that touch access, use tools it doesn't have, carry a secret or target an old version are refused with the reasons", async () => {
  const s = run.mcp.evolve; mcp = new Client({ name: "test", version: "1" });
  await mcp.connect(new StdioClientTransport({ command: s.command, args: s.args, env: { ...process.env, ...s.env }, stderr: "ignore" }));
  const tools = (await mcp.listTools()).tools.map((t) => t.name);
  assert(tools.join() === "evolve_read_self,evolve_propose", tools);
  const self = JSON.parse((await mcp.callTool({ name: "evolve_read_self", arguments: {} })).content[0].text), v = self.version;
  const tryIt = async (args) => { const r = await mcp.callTool({ name: "evolve_propose", arguments: args }); return { error: !!r.isError, text: r.content[0].text }; };
  const access = await fetch(run.mcp.evolve.env.EVOLVE_URL + "/propose", { method: "POST", headers: { "x-aiw-evolve": s.env.EVOLVE_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ ...goodProposal(v), changes: { capabilities: ["shell"], core: ["shell"], integrations: [], workflow: ["x"] } }) }).then((r) => r.json());
  const tool = await tryIt({ ...goodProposal(v), uses: ["builder.write"] });
  const secret = await tryIt({ ...goodProposal(v), changes: { knowledge: "api_key = bpk-0123456789abcdef" } });
  const stale = await tryIt({ ...goodProposal(v - 1) });
  assert(access.errors?.some((e) => /capabilities: a proposal can't change its tools/.test(e)) && access.errors.some((e) => /core: /.test(e)) && access.errors.some((e) => /integrations: /.test(e)), access);
  assert(tool.error && /builder.write isn't one of this worker's tools/.test(tool.text) && secret.error && /password, key or token/.test(secret.text) && stale.error && /version/.test(stale.text), { tool, secret, stale });
  assert(listP().length === 0, "a refused proposal was stored");
  return { refused: { access: access.errors.length, tool: tool.text.slice(0, 80), secret: true, stale: true } };
});
await step("a valid proposal is stored as proposed: its base version, provenance (this run), what it relies on checked now, and verification UNTESTED — nothing changed in the worker", async () => {
  const before = JSON.stringify(storedOf(W.id));
  const r = await mcp.callTool({ name: "evolve_propose", arguments: goodProposal(storedOf(W.id).version) }), j = JSON.parse(r.content[0].text);
  assert(!r.isError && j.status === "proposed" && j.verification.status === "untested", j);
  P1 = j.id;
  const v = (await call("GET", `/workers/${W.id}/proposals/${P1}`)).body;
  assert(v.createdBy.kind === "worker" && v.createdBy.run === run.id && v.base === storedOf(W.id).version && v.dependencies.every((d) => d.ok) && v.diff.length === 1 && v.diff[0].field === "workflow" && JSON.stringify(storedOf(W.id)) === before, v);
  assert(events(run.id).some((e) => e.type === "proposal" && e.summary.includes("waits for the person's review")), "no proposal event in the run");
  return { id: P1, base: v.base, verification: v.verification, deps: v.dependencies.map((d) => `${d.capability}:${d.ok}`) };
});
await mcp?.close().catch(() => {}); await stopAll();

// ---------------- trial runs and grading ----------------
let T1, B1;
await step("a trial run uses the proposed definition (marked, no evolve tools, the worker unchanged); a REMEMBER in a trial doesn't reach the worker's memory", async () => {
  const before = JSON.stringify(storedOf(W.id));
  const r = await call("POST", `/workers/${W.id}/proposals/${P1}/trial`, { prompt: "Create variant B.\nSAY: REMEMBER: a trial-only fact" });
  assert(r.status === 200, r); T1 = r.body.run;
  const m = await waitTurn(T1), snap = JSON.parse(readFileSync(join(runsDir, `${T1}.worker.json`), "utf8")), mcpCfg = JSON.parse(readFileSync(join(runsDir, `${T1}.mcp.json`), "utf8")).mcpServers;
  assert(m.candidate?.proposal === P1 && m.worker.candidate === P1 && snap.candidate.proposal === P1 && snap.definition.workflow.some((s) => s.includes("[AB <experiment> <letter>]")) && !mcpCfg.evolve && JSON.stringify(storedOf(W.id)) === before, { meta: m.candidate, servers: Object.keys(mcpCfg) });
  const mem = (await call("GET", `/workers/${W.id}/memory`)).body;
  assert(!mem.some((x) => /trial-only/.test(x.text)) && events(T1).some((e) => /trial run of a proposal doesn't change/.test(e.summary)), mem);
  await stopAll();
  return { run: T1, snapshotHasChange: true, memory: mem.length };
});
await step("grading: the console reads Builder itself; an entry made during the trial with the convention passes; the baseline (the worker as it is) finds none and fails", async () => {
  // The variant appears just after the trial started; the baseline starts well after it (the grader
  // allows 5 s of clock difference with Builder), so it can't count that entry as its own.
  const at = Date.parse((await call("GET", `/runs/${T1}`)).body.createdAt) + 10;
  entries = [{ id: "e-ctrl-0001", name: "Landing", published: "published", lastUpdated: at - 86400000, createdDate: at - 86400000, data: { url: "/landing" } },
    { id: "e-varb-0001", name: "Landing [AB EXP-1 B]", published: "draft", lastUpdated: at, createdDate: at, data: { url: "/landing-b", abExperiment: "EXP-1", abVariant: "B", abControlId: "e-ctrl-0001" } }];
  const g = await call("POST", `/workers/${W.id}/proposals/${P1}/grade`, { run: T1 });
  assert(g.status === 200 && g.body.verification.status === "passed" && g.body.trials[0].grade.results.every((x) => x.ran && x.ok), g.body);
  await sleep(5500);
  const b = await call("POST", `/workers/${W.id}/proposals/${P1}/trial`, { baseline: true }); B1 = b.body.run; await waitTurn(B1); await stopAll();
  const gb = await call("POST", `/workers/${W.id}/proposals/${P1}/grade`, { run: B1 });
  assert(gb.body.baseline && gb.body.baseline.ok === false && gb.body.verification.status === "passed", gb.body);
  return { candidate: g.body.verification, baseline: gb.body.baseline, detail: gb.body.trials[1].grade.results[0].detail };
});
await step("grading catches an impostor: a variant whose 'variations' is only a data field fails the check", async () => {
  const r = await evolve.grade(goodProposal(1).checks.map((c) => evolve.normalizeChecks([c]).checks[0]), { events: [], since: Date.now() - 1000, builder: {
    status: async () => ({ ok: true }), list: async () => [{ id: "x1", name: "Landing [AB EXP-1 B]", lastUpdated: Date.now() }],
    get: async () => ({ id: "x1", published: "draft", data: { abExperiment: "EXP-1", abVariant: "B", variations: { b: { testRatio: 0.5 } } } }) } });
  assert(!r[0].ok && r[0].ran && /variations is present/.test(r[0].detail), r);
  const t = await evolve.grade([{ type: "tool_called", tool: "builder_create_draft", min: 1 }], { events: [{ type: "tool", tool: "builder_create_draft", ref: "a" }, { type: "failure", ref: "a" }, { type: "tool", tool: "builder_create_draft", ref: "b" }, { type: "result", ref: "b" }], since: 0, builder: {} });
  assert(t[0].ok && /1 time/.test(t[0].detail), t);
  // A check's pattern runs in the console: nested repetition (catastrophic backtracking) is refused.
  const redos = evolve.normalizeChecks([{ type: "builder_entry", model: MODEL, name: "(a+)+$" }, { type: "builder_entry", model: MODEL, name: "x", expect: { fields: { f: "(.*a){20}" } } }]);
  assert(redos.errors.length === 2 && redos.errors.every((e) => /nested repetition/.test(e)), redos.errors);
  return { impostor: r[0].detail, toolCalled: t[0].detail, nestedRepetitionRefused: 2 };
});

// ---------------- the person's decision ----------------
let P2;
await step("approving needs the person's request; a verified proposal becomes the next recorded version (source: the proposal), and is decided once", async () => {
  const v0 = storedOf(W.id).version;
  const a = await call("POST", `/workers/${W.id}/proposals/${P1}/approve`, { reason: "matches our convention" });
  assert(a.status === 200 && a.body.worker.version === v0 + 1 && a.body.proposal.status === "approved", a.body);
  const rec = JSON.parse(readFileSync(join(hist(W.id), `v${v0 + 1}.json`), "utf8"));
  assert(rec.source.kind === "proposal" && rec.source.proposal === P1 && rec.source.verification.status === "passed" && rec.parent === v0 && JSON.stringify(rec.definition.capabilities) === JSON.stringify(seed.capabilities), rec);
  const again = await call("POST", `/workers/${W.id}/proposals/${P1}/approve`, {});
  assert(again.status === 400, again);
  return { version: v0 + 1, source: rec.source };
});
await step("the next run loads the approved version: its snapshot records that version and its context has the new step", async () => {
  const r = await start(W.id); const m = (await call("GET", `/runs/${r.id}`)).body, ctx = readFileSync(join(runsDir, `${r.id}.worker.md`), "utf8"), snap = JSON.parse(readFileSync(join(runsDir, `${r.id}.worker.json`), "utf8"));
  assert(m.worker.version === storedOf(W.id).version && snap.definition.version === m.worker.version && ctx.includes("[AB <experiment> <letter>]") && ctx.includes("Changing how you work (proposals)"), { meta: m.worker });
  run = r;
  return { version: m.worker.version };
});
await step("an unverified proposal (Builder not connected: blocked, its checks not run) is never shown as passed, and approving it needs explicit acknowledgement", async () => {
  const s = run.mcp.evolve, h = { "x-aiw-evolve": s.env.EVOLVE_TOKEN, "content-type": "application/json" };
  rmSync(CRED);
  const p = await fetch(s.env.EVOLVE_URL + "/propose", { method: "POST", headers: h, body: JSON.stringify({ ...goodProposal(storedOf(W.id).version), title: "Variant C too", changes: { knowledge: storedOf(W.id).knowledge + "\nVariant letters go B, C, D." } }) }).then((r) => r.json());
  P2 = p.id; await stopAll();
  assert(p.verification.status === "blocked" && /Not connected/.test(p.verification.why), p);
  const t = await call("POST", `/workers/${W.id}/proposals/${P2}/trial`, {}); await waitTurn(t.body.run); await stopAll();
  const g = await call("POST", `/workers/${W.id}/proposals/${P2}/grade`, { run: t.body.run });
  assert(g.body.verification.status === "blocked" && g.body.trials[0].grade.results[0].ran === false && /Not checked/.test(g.body.trials[0].grade.results[0].detail), g.body);
  const a = await call("POST", `/workers/${W.id}/proposals/${P2}/approve`, {});
  assert(a.status === 400 && a.body.code === "acknowledge" && /isn't verified/.test(a.body.error), a);
  connectBuilder();
  return { verification: g.body.verification, approve: a.body.error.slice(0, 120) };
});
await step("stale: after the worker changes, an older proposal can't be tried or approved over the newer version", async () => {
  const cur = storedOf(W.id);
  await call("PUT", `/workers/${W.id}`, { ...cur, onMissing: "Say what's missing and stop.", reason: "unrelated edit" });
  const v = (await call("GET", `/workers/${W.id}/proposals/${P2}`)).body;
  const a = await call("POST", `/workers/${W.id}/proposals/${P2}/approve`, { acknowledge: true }), t = await call("POST", `/workers/${W.id}/proposals/${P2}/trial`, {});
  assert(v.status === "stale" && a.status === 409 && a.body.code === "stale" && t.status === 409 && !storedOf(W.id).knowledge.includes("Variant letters"), { status: v.status, a, t });
  const rj = await call("POST", `/workers/${W.id}/proposals/${P2}/reject`, { reason: "stale" });
  assert(rj.body.status === "rejected", rj.body);
  return { stale: a.body.error.slice(0, 100), rejected: true };
});
await step("restoring the version before the evolution takes the change back out, as a new version", async () => {
  const appr = (await call("GET", `/workers/${W.id}/proposals/${P1}`)).body.decision.version;
  const r = await call("POST", `/workers/${W.id}/restore`, { version: appr - 1, reason: "roll back the A/B change" });
  assert(r.status === 200 && !r.body.workflow.some((s) => s.includes("[AB")) && r.body.version > appr, r.body);
  return { restoredFrom: appr - 1, now: r.body.version };
});

srv.kill(); mock.close();
writeFileSync(join(HERE, "evolve-results.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
