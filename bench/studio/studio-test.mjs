// The worker's home, its own context, and its assistant (worker-ui/worker-context.mjs,
// worker-change.mjs, mcp/assistant-server.mjs, the /workers/:id/… and /assist/… routes).
// The real console starts the real Claude Code runtime exactly as it does for a person; only the model
// is a scripted stand-in (bench/integrations/stub-model.mjs), so the assistant's tool calls and what the
// runtime and console answered are real. Temp data and config dirs; dummy content only.
//   node bench/studio/studio-test.mjs          (CLAUDE_BIN to choose the real binary)
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startStubModel, planLine } from "../integrations/stub-model.mjs";
import * as wp from "../../worker-ui/workerpack.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", "..");
const PORT = process.env.PORT || "8773";
const results = [];
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail ?? "").slice(0, 240)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 1500)); }
};
const assert = (c, m) => { if (!c) throw new Error(typeof m === "string" ? m : JSON.stringify(m)); };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const real = process.env.CLAUDE_BIN || (process.env.PATH || "").split(delimiter).map((d) => join(d, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")).find((f) => existsSync(f));
if (!real) { console.log("BLOCKED: no Claude Code binary found (set CLAUDE_BIN)"); process.exit(3); }

const ROOT = join(tmpdir(), `studio-${Date.now()}`), WS = join(ROOT, "ws"), DATA = join(ROOT, "data"), CFG = join(ROOT, "config"), EMPTY = join(ROOT, "none");
for (const d of [WS, DATA, CFG, EMPTY]) mkdirSync(d, { recursive: true });
writeFileSync(join(WS, "readme.md"), "# A project\n");
// A worker made before integrations (schema 1), as the person's real ones were: migrated in step 1.
const OLD = { id: "old-designer-aa11", name: "Old designer", mission: "Designs pages.", specialization: "UI", capabilities: ["files.read", "files.write", "web"], knowledge: "Our brand blue is #0055AA.\nUse 8px spacing.",
  workflow: ["Read the brief", "Design", "Verify"], limitations: ["Never publish anything"], requirements: [], onMissing: "Ask plainly.", repos: [], version: 4, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" };
writeFileSync(join(DATA, "workers.json"), JSON.stringify([OLD], null, 1));

const stub = await startStubModel();
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC|AI_AGENT|AIW_|WORKER_CONSOLE_)/i.test(k))),
  CLAUDE_BIN: process.execPath, CLAUDE_BIN_ARGS: JSON.stringify([join(REPO, "bench", "integrations", "stub-claude.mjs")]), STUB_REAL_CLAUDE: real, STUB_MODEL_URL: stub.url,
  WORKER_CONSOLE_PORT: PORT, WORKER_CONSOLE_DATA: DATA, WORKER_CONSOLE_CLAUDE_CONFIG_DIR: CFG,
  BUILDER_ADAPTER_DIR: EMPTY, GITHUB_CONNECTOR_DIR: EMPTY, FIGMA_READER_DIR: EMPTY, FIGMA_BRIDGE_PORT: "8774", WORKER_CONSOLE_DEVCTL_PORT: "8775" };
const srv = spawn(process.execPath, [join(REPO, "worker-ui", "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; srv.stdout.on("data", (d) => (log += d)); srv.stderr.on("data", (d) => (log += d));
const BASE = `http://127.0.0.1:${PORT}`, H = { origin: BASE, "x-worker-console": "1", "content-type": "application/json" };
const call = (m, p, b, h = H) => fetch(BASE + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null), headers: r.headers }));
const raw = (p) => fetch(BASE + p).then(async (r) => ({ status: r.status, headers: r.headers, buf: Buffer.from(await r.arrayBuffer()) }));
for (let i = 0; ; i++) { try { await fetch(BASE + "/"); break; } catch { if (i > 80 || srv.exitCode != null) { console.log(`FAIL console didn't start: ${log.slice(-800)}`); process.exit(1); } await sleep(250); } }
const ws = (await call("POST", "/workspaces", { name: "Project", path: WS, mode: "work" })).body.id;
const home = async (id) => (await call("GET", `/workers/${id}/home?workspace=${ws}`)).body;
const stored = () => JSON.parse(readFileSync(join(DATA, "workers.json"), "utf8"));
const waitFor = async (id, states, ms = 240000) => { const t0 = Date.now(); for (;;) { const m = (await call("GET", `/runs/${id}`)).body; if (states.includes(m?.status) || Date.now() - t0 > ms) return m; await sleep(700); } };
const events = (id) => readFileSync(join(DATA, "runs", `${id}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const W = OLD.id;

// ---- 1. migrating a schema-1 worker keeps what it is and what it can do, and can be undone ----
await step("migration: schema 1 → 2 keeps its tools, steps, limits and knowledge; access the same; undo restores it", async () => {
  const before = (await call("GET", `/access/preview?worker=${W}&workspace=${ws}`)).body;
  const props = (await call("GET", "/migration")).body.workers;
  assert(props.length === 1, props);
  const r = await call("POST", "/migration/apply", { workers: [{ id: W }] });
  assert(r.status === 200, r.body);
  const after = (await call("GET", `/access/preview?worker=${W}&workspace=${ws}`)).body, w = (await home(W)).worker;
  const sorted = (x) => JSON.stringify({ args: [...x.planned.args].sort(), servers: Object.keys(x.planned.servers).sort(), usable: [...x.planned.usable].sort() });
  assert(sorted(before) === sorted(after), { before: before.planned.usable, after: after.planned.usable });
  assert(w.schema === 2 && w.workflow.join() === OLD.workflow.join() && w.limitations.join() === OLD.limitations.join() && w.knowledge === OLD.knowledge && w.mission === OLD.mission, w);
  const undo = await call("POST", "/migration/undo", { backup: r.body.backup });
  assert(undo.status === 200 && stored()[0].schema === undefined && stored()[0].version === 4, stored()[0]);
  const again = await call("POST", "/migration/apply", { workers: [{ id: W }] }); // and migrated again, for the rest of the test
  assert(again.status === 200 && stored()[0].schema === 2, again.body);
  return { usable: after.planned.usable, version: stored()[0].version };
});

// ---- 2. the home: one read with the worker, its configuration, connections and history ----
await step("worker home: identity, configuration (inspect), connections, versions, no context yet", async () => {
  const h = await home(W);
  assert(h.worker.name === OLD.name && h.inspect.identity.mission === OLD.mission && h.inspect.instructions.workflow.length === 3 && h.inspect.limits[0] === OLD.limitations[0], h.inspect);
  assert(h.connections && "figma" in h.connections && Array.isArray(h.connections.builder.spaces) && h.connections.github.connected === false, h.connections);
  assert(h.versions.some((v) => v.source.kind === "migration") && h.inspect.context.knowledge.length === 0 && h.tasks.length === 0, h.versions);
  assert(!JSON.stringify(h).match(/privateKey|token"/i), "home leaks a key field");
  return { versions: h.versions.map((v) => `${v.version}:${v.source.kind}`) };
});

// ---- 3. the owner's own edits on the page: context with identities and sources, versioned ----
let v0;
await step("owner edits: knowledge entry, skill and references are added as a new version, with source and ids", async () => {
  v0 = stored()[0].version;
  const r = await call("POST", `/workers/${W}/edit`, { baseVersion: v0, summary: "Context from the owner", change: {
    knowledge: { add: [{ title: "Brand", text: "Primary colour is blue #0055AA. Headings use Inter." }, { title: "Old notes", text: "To be removed later." }] },
    skills: { add: [{ name: "Landing page review", description: "When asked to review a landing page", instructions: "1. Check the hero\n2. Check the donation form\n3. Report" }] },
    references: { add: [{ kind: "repository", title: "Site", value: "acme/site", branch: "dev" }, { kind: "link", title: "Design system", value: "https://example.com/ds" }] } } });
  assert(r.status === 200 && r.body.status === "applied" && r.body.version === v0 + 1, r.body);
  const c = stored()[0].context;
  assert(c.knowledge.length === 2 && c.skills.length === 1 && c.references.length === 2 && c.knowledge.every((k) => /^k-/.test(k.id) && k.source.kind === "owner"), c);
  const hist = JSON.parse(readFileSync(join(DATA, "workers", W, "history", `v${v0 + 1}.json`), "utf8"));
  assert(hist.source.kind === "owner" && hist.definition.context.skills[0].name === "Landing page review", hist.source);
  return { version: r.body.version, changed: r.body.changed };
});
await step("owner edits are refused when stale, when they hold a credential, or when they'd give something the editor wouldn't", async () => {
  const v = stored()[0].version;
  const stale = await call("POST", `/workers/${W}/edit`, { baseVersion: v - 1, change: { knowledge: { add: [{ title: "x", text: "y" }] } } });
  const secret = await call("POST", `/workers/${W}/edit`, { baseVersion: v, change: { knowledge: { add: [{ title: "Keys", text: "api_key = sk-ant-abcdefghijklmnopqrstuv" }] } } });
  const badCore = await call("POST", `/workers/${W}/edit`, { baseVersion: v, change: { access: { core: ["figma.plugin.edit"] } } });
  const unknown = await call("POST", `/workers/${W}/edit`, { baseVersion: v, change: { credentials: { github: "x" } } });
  assert(stale.status === 409 && secret.status === 400 && badCore.status === 400 && unknown.status === 400 && stored()[0].version === v, { stale: stale.body, secret: secret.body, badCore: badCore.body, unknown: unknown.body });
  return { secret: secret.body.error.slice(0, 90), badCore: badCore.body.error.slice(0, 90) };
});
await step("a document uploaded by the owner is stored with the worker (content-addressed) and served read-only", async () => {
  const v = stored()[0].version;
  const r = await call("POST", `/workers/${W}/documents`, { baseVersion: v, name: "style guide.md", data: Buffer.from("# Style guide\nCODEWORD-STYLE-4471: buttons are pill-shaped.\n").toString("base64"), title: "Style guide", note: "Read before designing" });
  assert(r.status === 200 && r.body.version === v + 1, r.body);
  const ref = stored()[0].context.references.find((x) => x.kind === "document");
  assert(ref && /^[a-f0-9]{16}-style_guide\.md$/.test(ref.doc.file) && existsSync(join(DATA, "workers", W, "documents", ref.doc.file)), ref);
  const g = await raw(`/workers/${W}/documents/${encodeURIComponent(ref.doc.file)}`);
  assert(g.status === 200 && g.headers.get("content-security-policy") === "sandbox" && g.buf.toString().includes("CODEWORD-STYLE-4471"), g.status);
  return { file: ref.doc.file };
});
await step("saving in the existing editor form (which sends no context) keeps the worker's context", async () => {
  const w = stored()[0];
  const r = await call("PUT", `/workers/${W}`, { schema: 2, name: w.name, specialization: w.specialization, mission: "Designs pages and reviews them.", outcomes: w.outcomes, integrations: w.integrations, core: w.core, workflow: w.workflow, knowledge: w.knowledge, limitations: w.limitations, onMissing: w.onMissing, extraRequirements: [], repos: [] });
  assert(r.status === 200 && stored()[0].context?.knowledge.length === 2 && stored()[0].context.references.length === 3 && stored()[0].mission.startsWith("Designs pages and"), { status: r.status, ctx: stored()[0].context });
  return { version: stored()[0].version };
});

// ---- 4. what a task gets: the context preview, and a real task run ----
await step("context preview: the sections a task would get, each with its source", async () => {
  const p = (await call("GET", `/workers/${W}/context-preview?workspace=${ws}`)).body;
  const by = (re) => p.sections.find((s) => re.test(s.title));
  assert(by(/^Knowledge entries/)?.source === "This worker's context" && by(/^Skills/)?.text.includes("Landing page review") && by(/^Hard limits/)?.source === "This worker's instructions" && p.sections[0].source === "Platform", p.sections.map((s) => `${s.title} ← ${s.source}`));
  return p.sections.map((s) => `${s.title.slice(0, 30)} ← ${s.source}`);
});
let taskRun;
await step("a task run gets the knowledge, skills, references and a read-only copy of the document", async () => {
  const docFile = stored()[0].context.references.find((x) => x.kind === "document").doc.file;
  const calls = [{ name: "Read", input: { file_path: "DOCS/" + docFile } }];
  // The copy's folder is known only once the run exists: the plan reads it from the run's own context.
  const line = planLine([{ name: "Glob", input: { pattern: "*.md", path: "." } }]);
  const r = await call("POST", "/runs", { prompt: `${line}\nFollow the plan.`, workspace: ws, worker: W });
  assert(r.status === 200, r.body);
  taskRun = r.body.id;
  const m = await waitFor(taskRun, ["waiting", "finished", "failed"]);
  const ctx = readFileSync(join(DATA, "runs", `${taskRun}.worker.md`), "utf8"), docs = join(DATA, "runs", `${taskRun}.docs`);
  assert(/## Knowledge entries/.test(ctx) && ctx.includes("Primary colour is blue") && /### Skill: Landing page review/.test(ctx) && ctx.includes("acme/site (branch dev)") && ctx.includes(docFile) && existsSync(join(docs, docFile)), { status: m.status, ctx: ctx.slice(-1500) });
  const rec = readdirSync(join(DATA, "runs")).filter((f) => f.startsWith(taskRun) && f.endsWith(".mcp.json"));
  assert(rec.length === 1, rec);
  return { status: m.status, docs: readdirSync(docs), calls: calls.length };
});
await step("in that run the worker can read its document copy and can't change it (runtime-enforced)", async () => {
  await call("POST", `/runs/${taskRun}/end`, {}); await waitFor(taskRun, ["finished", "failed", "stopped", "interrupted"], 20000);
  const docFile = stored()[0].context.references.find((x) => x.kind === "document").doc.file, copy = join(DATA, "runs", `${taskRun}.docs`, docFile);
  const line = planLine([{ name: "Read", input: { file_path: copy } }, { name: "Write", input: { file_path: copy, content: "changed" } }]);
  const r = await call("POST", `/runs/${taskRun}/message`, { text: `${line}\nFollow the plan.` });
  assert(r.status === 200, r.body);
  await waitFor(taskRun, ["waiting", "finished", "failed"]);
  const got = stub.results(line);
  assert(got.length === 2 && !got[0].isError && got[0].text.includes("CODEWORD-STYLE-4471") && got[1].isError && readFileSync(copy, "utf8").includes("CODEWORD-STYLE-4471"), got);
  await call("POST", `/runs/${taskRun}/end`, {}); await waitFor(taskRun, ["finished", "failed", "stopped", "interrupted"], 20000);
  return { read: got[0].isError ? "refused" : "ok", write: got[1].text.slice(0, 120) };
});

// ---- 5. the assistant: a real conversation, with the assistant's tools only ----
let asst, vA;
const load = { name: "ToolSearch", input: { query: "select:mcp__assistant__worker_inspect,mcp__assistant__worker_change,mcp__assistant__worker_add_document", max_results: 5 } };
await step("assistant conversation: inspects the worker, applies a low-risk change at once, sends removals and access for approval, refuses a credential, keeps an attached document", async () => {
  vA = stored()[0].version;
  const entry = stored()[0].context.knowledge.find((k) => k.title === "Old notes").id;
  const calls = [load, { name: "mcp__assistant__worker_inspect", input: {} },
    { name: "mcp__assistant__worker_change", input: { baseVersion: vA, summary: "Add a deployment skill", change: { skills: { add: [{ name: "Deploy to staging", description: "When asked to deploy", instructions: "1. Build\n2. Deploy to staging\n3. Report the URL" }] } } } },
    { name: "mcp__assistant__worker_change", input: { baseVersion: vA + 1, summary: "Remove old notes", change: { knowledge: { remove: [entry] } } } },
    { name: "mcp__assistant__worker_change", input: { baseVersion: vA + 1, summary: "Store a key", change: { knowledge: { add: [{ title: "Key", text: "token = ghp_abcdefghijklmnopqrstuvwxyz0123" }] } } } },
    { name: "mcp__assistant__worker_change", input: { baseVersion: vA + 1, summary: "Give it the browser", change: { access: { core: ["files.read", "files.write", "web", "browser"] } } } },
    { name: "mcp__assistant__worker_add_document", input: { baseVersion: vA + 1, attachment: "deploy.md", title: "Deployment runbook", note: "For deploys" } }];
  const line = planLine(calls);
  const r = await call("POST", `/workers/${W}/assistant`, { prompt: `${line}\nAdd a skill for our deployment process, and keep the attached runbook.`, attachments: [{ name: "deploy.md", data: Buffer.from("# Deploy\nRUNBOOK-8812: deploy with `npm run deploy:staging`.\n").toString("base64") }] });
  assert(r.status === 200 && r.body.assistant?.worker === W && !r.body.worker, r.body);
  asst = r.body.id;
  const m = await waitFor(asst, ["waiting", "finished", "failed"]);
  const got = stub.results(line);
  assert(got.length === calls.length, { status: m.status, got: got.map((g) => g.tool), log: log.slice(-600) });
  const [, insp, add, rm, sec, acc, doc] = got;
  const inspected = JSON.parse(insp.text);
  assert(!insp.isError && inspected.version === vA && inspected.context.skills.length === 1 && inspected.limits.includes("Never publish anything") && !/privateKey/.test(insp.text), insp.text.slice(0, 300));
  assert(!add.isError && JSON.parse(add.text).status === "applied" && JSON.parse(add.text).version === vA + 1, add.text);
  assert(!rm.isError && JSON.parse(rm.text).status === "waiting-for-approval", rm.text);
  assert(sec.isError && /password, key or token/.test(sec.text), sec.text);
  assert(!acc.isError && JSON.parse(acc.text).status === "waiting-for-approval", acc.text);
  assert(!doc.isError && JSON.parse(doc.text).status === "applied" && JSON.parse(doc.text).version === vA + 2, doc.text);
  const w = stored()[0];
  assert(w.version === vA + 2 && w.context.skills.some((s) => s.name === "Deploy to staging" && s.source.kind === "assistant" && s.source.run === asst) && w.context.knowledge.some((k) => k.title === "Old notes") && w.core.join() === "files.read,files.write,web" && !JSON.stringify(w).includes("ghp_"), w);
  assert(w.context.references.filter((x) => x.kind === "document").length === 2, w.context.references);
  const ev = events(asst).filter((e) => e.type === "worker-change");
  assert(ev.length === 4, ev.map((e) => e.summary));
  return { results: got.slice(1).map((g) => (g.isError ? `refused: ${g.text.slice(0, 60)}` : JSON.parse(g.text).status || "ok")) };
});
await step("the assistant has only its own tools: no files, shell, web or integrations, and no evolve tools", async () => {
  const mcp = JSON.parse(readFileSync(join(DATA, "runs", `${asst}.mcp.json`), "utf8")).mcpServers;
  const req = stub.requests.filter((x) => x.tools.some((t) => t.startsWith("mcp__assistant__")));
  const tools = [...new Set(req.flatMap((x) => x.tools))];
  assert(Object.keys(mcp).join() === "assistant" && !tools.some((t) => ["Read", "Write", "Edit", "Bash", "WebFetch", "WebSearch", "Glob", "Grep"].includes(t) || /^mcp__(evolve|builder|figma|browser|repo)/.test(t)), { servers: Object.keys(mcp), tools });
  return { tools };
});
await step("while the assistant conversation is open, a task can run; a second assistant conversation can't open", async () => {
  const m = (await call("GET", `/runs/${asst}`)).body;
  assert(m.status === "waiting", m.status);
  const second = await call("POST", `/workers/${W}/assistant`, { prompt: "hello" });
  const line = planLine([{ name: "Glob", input: { pattern: "*", path: "." } }]);
  const task = await call("POST", "/runs", { prompt: `${line}\nFollow the plan.`, workspace: ws, worker: W });
  assert(second.status === 409 && task.status === 200, { second: second.body, task: task.body });
  await waitFor(task.body.id, ["waiting", "finished", "failed"]); await call("POST", `/runs/${task.body.id}/end`, {});
  return { second: second.body.error, task: "started" };
});
await step("the assistant's endpoints answer only its own run's token, and only for an assistant conversation", async () => {
  const bad = await call("GET", `/assist/${asst}/inspect`, null, { "x-aiw-assist": "0".repeat(36) });
  const none = await call("GET", `/assist/${asst}/inspect`, null, {});
  const notAsst = await call("GET", `/assist/${taskRun}/inspect`, null, { "x-aiw-assist": "x" });
  const approveViaToken = await call("POST", `/assist/${asst}/approve`, {}, { "x-aiw-assist": "x", "content-type": "application/json" });
  assert(bad.status === 403 && none.status === 403 && notAsst.status === 403 && approveViaToken.status === 403, [bad.status, none.status, notAsst.status, approveViaToken.status]);
  return [bad.status, none.status, notAsst.status, approveViaToken.status];
});
await step("pending changes: the owner approves one (applied as a new version) and rejects the other; nothing is applied twice", async () => {
  await call("POST", `/runs/${asst}/end`, {}); await waitFor(asst, ["finished", "failed", "stopped", "interrupted"], 20000);
  const list = (await call("GET", `/workers/${W}/changes`)).body.changes.filter((c) => c.status === "pending");
  assert(list.length === 2, list);
  const rm = list.find((c) => c.summary === "Remove old notes"), acc = list.find((c) => c.summary === "Give it the browser");
  // Both were made for the version before the document was added: approving one now is stale.
  const stale = await call("POST", `/workers/${W}/changes/${rm.id}/approve`, {});
  assert(stale.status === 409 && stale.body.code === "stale", stale.body);
  const rej = await call("POST", `/workers/${W}/changes/${acc.id}/reject`, { reason: "not now" });
  assert(rej.status === 200 && rej.body.status === "rejected" && stored()[0].core.join() === "files.read,files.write,web", rej.body);
  // A fresh one, made for the current version, is approved.
  const v = stored()[0].version, entry = stored()[0].context.knowledge.find((k) => k.title === "Old notes").id;
  writeFileSync(join(DATA, "workers", W, "changes", `${rm.id}.json`), JSON.stringify({ ...rm, base: v }, null, 1));
  const ok = await call("POST", `/workers/${W}/changes/${rm.id}/approve`, {});
  const twice = await call("POST", `/workers/${W}/changes/${rm.id}/approve`, {});
  assert(ok.status === 200 && ok.body.result.version === v + 1 && !stored()[0].context.knowledge.some((k) => k.id === entry) && twice.status === 400, { ok: ok.body, twice: twice.body });
  return { approved: ok.body.result.version, rejected: acc.id };
});
await step("every change is a version that can be restored: restoring brings the removed entry back", async () => {
  const v = stored()[0].version;
  const r = await call("POST", `/workers/${W}/restore`, { version: v - 1, reason: "undo" });
  assert(r.status === 200 && stored()[0].context.knowledge.some((k) => k.title === "Old notes") && stored()[0].version === v + 1, r.body);
  const h = await home(W);
  assert(h.versions[0].source.kind === "restore" && h.versions.some((x) => x.source.kind === "assistant") && h.versions.some((x) => x.source.kind === "owner") && h.assistant.length === 1 && h.tasks.length >= 2, h.versions.slice(0, 6));
  return h.versions.slice(0, 8).map((x) => `${x.version}:${x.source.kind}`);
});

// ---- 6. portability: export, import and clone carry the context and documents; never secrets ----
let bytes;
await step("export: format 3 with context.json and the documents; a worker without context still exports as format 2", async () => {
  const pre = (await call("GET", `/workers/${W}/export/preview`)).body;
  assert(pre.preview.format === 3 && pre.context.skills.length === 2 && pre.preview.included.filter((n) => n.startsWith("documents/")).length === 2, pre.preview);
  const r = await raw(`/workers/${W}/export`); bytes = r.buf;
  const pkg = wp.readPackage(bytes);
  assert(pkg.manifest.formatVersion === 3 && pkg.context.knowledge.length === 2 && pkg.documents.size === 2 && [...pkg.documents.values()].some((b) => b.toString().includes("RUNBOOK-8812")), pkg.files);
  assert(!JSON.stringify(pkg.context).includes('"source"') && !JSON.stringify(pkg.context).includes("updatedAt"), "who/when travels in the package");
  const plain = await call("POST", "/workers", { schema: 2, name: "Plain", integrations: [], core: ["files.read"], workflow: [], limitations: [] });
  const p2 = wp.readPackage((await raw(`/workers/${plain.body.id}/export`)).buf);
  assert(p2.manifest.formatVersion === 2 && !p2.files.includes("context.json"), p2.files);
  return { files: pkg.files };
});
await step("import and clone: a new, independent worker with the same context and its own copies of the documents", async () => {
  const pv = await call("POST", "/workerpacks/preview", { data: bytes.toString("base64") });
  assert(pv.status === 200 && pv.body.package.context.skills.includes("Deploy to staging"), pv.body);
  const ins = await call("POST", `/workerpacks/${pv.body.token}/install`, { name: "Imported designer" });
  assert(ins.status === 200, ins.body);
  const nw = stored().find((w) => w.name === "Imported designer");
  const docs = nw.context.references.filter((x) => x.kind === "document");
  assert(nw.id !== W && nw.version === 1 && nw.context.skills.length === 2 && nw.context.knowledge.every((k) => k.source.kind === "package") && docs.length === 2 && docs.every((d) => existsSync(join(DATA, "workers", nw.id, "documents", d.doc.file))), nw.context);
  const cl = await call("POST", `/workers/${W}/clone`, { name: "Designer copy" });
  const cw = stored().find((w) => w.name === "Designer copy");
  assert(cl.status === 200 && cw.context.skills.length === 2 && cw.context.references.filter((x) => x.kind === "document").every((d) => existsSync(join(DATA, "workers", cw.id, "documents", d.doc.file))), cl.body);
  return { imported: nw.id, clone: cw.id };
});
await step("packages are checked: a stray document, a context in an older format, a newer format are refused", async () => {
  const files = wp.unzip(bytes), m = JSON.parse(files.get("manifest.json"));
  const rezip = (mut) => { const f = new Map(files), man = structuredClone(m); mut(f, man); const sha = (b) => require_sha(b); for (const [n, b] of f) if (n !== "manifest.json") man.files[n] = { sha256: sha(b), size: b.length }; for (const n of Object.keys(man.files)) if (!f.has(n)) delete man.files[n]; f.set("manifest.json", Buffer.from(JSON.stringify(man))); return wp.zip([...f]); };
  const code = (buf) => { try { wp.readPackage(buf); return "accepted"; } catch (e) { return e.code; } };
  const stray = code(rezip((f) => f.set("documents/0123456789abcdef-extra.md", Buffer.from("x"))));
  const old = code(rezip((f, man) => { man.formatVersion = 2; }));
  const newer = code(rezip((f, man) => { man.formatVersion = 4; }));
  assert(stray === "malformed" && old === "malformed" && newer === "incompatible", { stray, old, newer });
  return { stray, old, newer };
});
import { createHash } from "node:crypto";
function require_sha(b) { return createHash("sha256").update(b).digest("hex"); }

srv.kill(); stub.close();
const passed = results.filter((r) => r.ok).length;
writeFileSync(join(HERE, "studio-results.json"), JSON.stringify({ ran: new Date().toISOString(), passed, total: results.length, steps: results }, null, 1));
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
