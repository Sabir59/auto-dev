// A local worker's file tools stay inside its workspace, and never reach credentials, below the model.
// The real console (local mode) starts the real Claude Code runtime exactly as it does for a person;
// only the model is a scripted stand-in (stub-model.mjs), which asks for each tool call and records
// what the runtime answered. So every result here is the runtime's own enforcement (deny rules and the
// file guard), not a model's judgement. Dummy credentials only, in a temp folder; the console's Claude
// config dir is a temp folder too, so the person's own settings and sessions are never touched.
//   node bench/integrations/file-boundary-test.mjs        (CLAUDE_BIN to choose the real binary)
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startStubModel, planLine } from "./stub-model.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", "..");
const PORT = process.env.PORT || "8771";
const results = [];
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail).slice(0, 260)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 1200)); }
};
const assert = (c, m) => { if (!c) throw new Error(typeof m === "string" ? m : JSON.stringify(m)); };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

const real = process.env.CLAUDE_BIN || (process.env.PATH || "").split(delimiter).map((d) => join(d, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")).find((f) => existsSync(f));
if (!real) { console.log("BLOCKED: no Claude Code binary found (set CLAUDE_BIN)"); process.exit(3); }

// ---- the files: a workspace, dummy credentials and other files around it ----
const ROOT = join(tmpdir(), `fileb-${Date.now()}`), WS = join(ROOT, "ws"), DATA = join(ROOT, "data"), CFG = join(ROOT, "config");
const D = { builder: join(ROOT, "builder"), github: join(ROOT, "github"), figma: join(ROOT, "figma"), elsewhere: join(ROOT, "elsewhere") };
for (const d of [WS, DATA, CFG, join(CFG, "projects", "other-project"), join(WS, ".claude"), ...Object.values(D)]) mkdirSync(d, { recursive: true });
const M = { builder: "DUMMY-BUILDER-7731", github: "DUMMY-GITHUB-5521", figma: "DUMMY-FIGMA-3317", other: "DUMMY-OTHER-9902", signin: "DUMMY-SIGNIN-4410", transcript: "DUMMY-TRANSCRIPT-2208" };
writeFileSync(join(D.builder, "credentials.json"), JSON.stringify({ label: "dummy", environment: "test", publicKey: "x", privateKey: M.builder }));
writeFileSync(join(D.github, "token.json"), JSON.stringify({ token: M.github }));
writeFileSync(join(D.figma, "credentials.json"), JSON.stringify({ token: M.figma }));
writeFileSync(join(D.elsewhere, "notes.txt"), M.other);
writeFileSync(join(CFG, ".credentials.json"), JSON.stringify({ accessToken: M.signin }));
writeFileSync(join(CFG, "projects", "other-project", "other-session.jsonl"), JSON.stringify({ text: M.transcript }) + "\n");
writeFileSync(join(WS, "ok.txt"), "WS-OK-1111\n");
// a repository's own settings trying to switch every hook off (the guard must stay on)
writeFileSync(join(WS, ".claude", "settings.json"), JSON.stringify({ disableAllHooks: true }));
execFileSync("git", ["init", "-q", WS]);
const link = join(WS, "link");
if (process.platform === "win32") execFileSync("cmd", ["/c", "mklink", "/J", link, D.builder], { stdio: "ignore" });
else execFileSync("ln", ["-s", D.builder, link]);
// an 8.3 short name for the outside file, when the volume has them (another spelling of the same path)
let short = null;
if (process.platform === "win32") { try { const o = execFileSync("cmd", ["/c", "for %I in (\"" + join(D.elsewhere, "notes.txt") + "\") do @echo %~sI"], { encoding: "utf8" }).trim(); if (o && o.toLowerCase() !== join(D.elsewhere, "notes.txt").toLowerCase()) short = o; } catch {} }

// ---- the console, starting the real runtime with the stand-in model ----
const stub = await startStubModel();
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC|AI_AGENT|AIW_|WORKER_CONSOLE_)/i.test(k))),
  CLAUDE_BIN: process.execPath, CLAUDE_BIN_ARGS: JSON.stringify([join(HERE, "stub-claude.mjs")]), STUB_REAL_CLAUDE: real, STUB_MODEL_URL: stub.url,
  WORKER_CONSOLE_PORT: PORT, WORKER_CONSOLE_DATA: DATA, WORKER_CONSOLE_CLAUDE_CONFIG_DIR: CFG,
  BUILDER_ADAPTER_DIR: D.builder, GITHUB_CONNECTOR_DIR: D.github, FIGMA_READER_DIR: D.figma, FIGMA_BRIDGE_PORT: "8772" };
const srv = spawn(process.execPath, [join(REPO, "worker-ui", "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; srv.stdout.on("data", (d) => (log += d)); srv.stderr.on("data", (d) => (log += d));
const BASE = `http://127.0.0.1:${PORT}`, H = { origin: BASE, "x-worker-console": "1", "content-type": "application/json" };
const call = (m, p, b) => fetch(BASE + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
for (let i = 0; ; i++) { try { await fetch(BASE + "/"); break; } catch { if (i > 80 || srv.exitCode != null) { console.log(`FAIL console didn't start: ${log.slice(-600)}`); process.exit(1); } await sleep(250); } }

async function runPlan(calls, { workspace, worker }) {
  const line = planLine(calls);
  const r = await call("POST", "/runs", { prompt: `${line}\nFollow the plan.`, workspace, ...(worker ? { worker } : {}) });
  assert(r.status === 200, { start: r.status, body: r.body });
  const id = r.body.id, t0 = Date.now(); let st;
  for (;;) { await sleep(1000); st = (await call("GET", `/runs/${id}`)).body; if (["waiting", "finished", "failed", "stopped"].includes(st?.status) || Date.now() - t0 > 240000) break; }
  await call("POST", `/runs/${id}/end`, {});
  for (let i = 0; i < 100; i++) { if (!(await call("GET", "/runs")).body?.active) break; await sleep(200); }
  const got = stub.results(line);
  assert(got.length === calls.length, { status: st?.status, answered: got.length, of: calls.length, log: log.slice(-400) });
  return { id, got, events: existsSync(join(DATA, "runs", `${id}.jsonl`)) ? readFileSync(join(DATA, "runs", `${id}.jsonl`), "utf8") : "" };
}
const R = (p) => ({ name: "Read", input: { file_path: p } });
const refused = (x) => x.isError && !Object.values(M).some((v) => x.text.includes(v));
const leaked = (text) => Object.entries(M).filter(([, v]) => text.includes(v)).map(([k]) => k);

const ws = (await call("POST", "/workspaces", { name: "Boundary", path: WS, mode: "work" })).body.id;
const wsRoot = (await call("POST", "/workspaces", { name: "Everything", path: ROOT, mode: "work" })).body.id;
const worker = (await call("POST", "/workers", { name: "Boundary probe", mission: "Test worker for the file boundary.", capabilities: ["files.read", "files.write", "shell"] })).body.id;
assert(ws && wsRoot && worker, "setup failed");

let runA;
await step("local console: credentials, other files, traversal, a junction, an 8.3 name and every file-reading route are refused; workspace files read normally (real runtime, local mode)", async () => {
  const cases = [
    ["workspace file (allowed)", R(join(WS, "ok.txt")), true],
    ["Builder credentials outside the workspace", R(join(D.builder, "credentials.json")), false],
    ["GitHub token outside the workspace", R(join(D.github, "token.json")), false],
    ["Figma credentials outside the workspace", R(join(D.figma, "credentials.json")), false],
    ["an ordinary file elsewhere on disk", R(join(D.elsewhere, "notes.txt")), false],
    ["the runtime's sign-in file", R(join(CFG, ".credentials.json")), false],
    ["another session's transcript", R(join(CFG, "projects", "other-project", "other-session.jsonl")), false],
    ["traversal: workspace\\..\\builder", R(join(WS, "..", "builder", "credentials.json")), false],
    ["relative traversal", R("../builder/credentials.json"), false],
    ["a junction in the workspace pointing at the credentials", R(join(link, "credentials.json")), false],
    ["Grep through the junction", { name: "Grep", input: { pattern: "DUMMY", path: link, output_mode: "content" } }, false],
    ["Grep on the credentials folder", { name: "Grep", input: { pattern: "DUMMY", path: D.builder, output_mode: "content" } }, false],
    ["Grep with a glob going up", { name: "Grep", input: { pattern: "DUMMY", glob: "../**/*.json", output_mode: "content" } }, false],
    ["Glob on the credentials folder", { name: "Glob", input: { pattern: "*", path: D.builder } }, false],
    ["Glob with an absolute pattern", { name: "Glob", input: { pattern: D.builder.replace(/\\/g, "/") + "/*" } }, false],
    ["Glob with a pattern going up", { name: "Glob", input: { pattern: "../**/*.json" } }, false],
    ["Grep in the workspace (allowed)", { name: "Grep", input: { pattern: "WS-OK", output_mode: "content" } }, true],
    ["Glob in the workspace (allowed)", { name: "Glob", input: { pattern: "*.txt" } }, true],
    ["Write outside the workspace", { name: "Write", input: { file_path: join(D.elsewhere, "written.txt"), content: "x" } }, false],
    ["Write in the workspace (allowed)", { name: "Write", input: { file_path: join(WS, "new.txt"), content: "fine" } }, true],
    ["large output saved by the runtime", { name: "Bash", input: { command: `node -e "process.stdout.write('y'.repeat(200000))"` } }, true],
    ["reading back the run's own saved output (allowed)", R("$PERSISTED"), true],
    ...(short ? [["an 8.3 short name for the outside file", R(short), false]] : []),
  ];
  runA = await runPlan(cases.map((c) => c[1]), { workspace: ws, worker });
  const wrong = cases.map(([what, , allowed], k) => ({ what, allowed, got: runA.got[k] })).filter(({ allowed, got }) => (allowed ? got.isError : !refused(got))).map(({ what, got }) => ({ what, isError: got.isError, text: got.text.slice(0, 160) }));
  assert(!wrong.length, wrong);
  assert(runA.got[0].text.includes("WS-OK-1111") && /y{100}/.test(runA.got[cases.length - (short ? 2 : 1)].text), "allowed reads didn't return content");
  assert(!existsSync(join(D.elsewhere, "written.txt")) && existsSync(join(WS, "new.txt")), "write boundary");
  return { cases: cases.length, refused: cases.filter((c) => !c[2]).length, shortName: !!short };
});

await step("no dummy secret reached the run's record, the tool results or the console's API answers", async () => {
  const all = runA.events + JSON.stringify(runA.got) + JSON.stringify((await call("GET", `/runs/${runA.id}`)).body);
  const l = leaked(all); assert(!l.length, { leaked: l });
  return { checked: ["run record", "tool results", "GET /runs/:id"] };
});

await step("when the workspace contains them, the deny rules still refuse credentials, the sign-in file, transcripts and run token files (second layer; the guard allows the folder)", async () => {
  const cases = [
    ["an ordinary file inside this workspace (allowed)", R(join(D.elsewhere, "notes.txt")), true],
    ["Builder credentials", R(join(D.builder, "credentials.json")), false],
    ["GitHub token", R(join(D.github, "token.json")), false],
    ["Figma credentials", R(join(D.figma, "credentials.json")), false],
    ["the runtime's sign-in file", R(join(CFG, ".credentials.json")), false],
    ["another session's transcript", R(join(CFG, "projects", "other-project", "other-session.jsonl")), false],
    ["another run's tool-server tokens", R(join(DATA, "runs", `${runA.id}.mcp.json`)), false],
    ["Grep across everything for the dummy secrets", { name: "Grep", input: { pattern: "DUMMY-(BUILDER|GITHUB|FIGMA|SIGNIN|TRANSCRIPT)", output_mode: "content" } }, true],
  ];
  const r = await runPlan(cases.map((c) => c[1]), { workspace: wsRoot, worker });
  const wrong = cases.map(([what, , allowed], k) => ({ what, allowed, got: r.got[k] })).filter(({ allowed, got }) => (allowed ? got.isError : !refused(got))).map(({ what, got }) => ({ what, text: got.text.slice(0, 160) }));
  assert(!wrong.length, wrong);
  const grep = r.got[cases.length - 1].text, l = leaked(grep).filter((k) => k !== "other");
  assert(!l.length, { grepLeaked: l, grep: grep.slice(0, 300) });
  assert(existsSync(join(DATA, "runs", `${runA.id}.mcp.json`)) && /AIW_AUTHZ_TOKEN|EVOLVE_TOKEN/.test(readFileSync(join(DATA, "runs", `${runA.id}.mcp.json`), "utf8")), "the token file this case protects wasn't there");
  return { cases: cases.length, grepFound: grep.split("\n").filter(Boolean).length };
});

await step("the General worker has no shell by default; granting shell explicitly adds it (and only then)", async () => {
  const pv = async () => (await call("GET", `/access/preview?worker=general&workspace=${ws}`)).body;
  const before = await pv(), g0 = (await call("GET", "/general")).body;
  assert(!g0.saved && !g0.core.includes("shell") && !before.planned.usable.includes("shell") && !before.planned.args.some((a) => /Bash/.test(a)), { core: g0.core, usable: before.planned.usable });
  await call("PUT", "/general", { core: [...g0.core, "shell"] });
  const after = await pv();
  assert(after.planned.usable.includes("shell") && after.planned.args.some((a) => /Bash\(node:\*\)/.test(a)), { usable: after.planned.usable });
  await call("PUT", "/general", { core: g0.core });
  const again = await pv(); assert(!again.planned.usable.includes("shell"), "shell stayed on after it was taken away");
  return { default: g0.core, granted: after.planned.usable };
});

await step("the settings and the worker editor warn wherever shell can be granted", async () => {
  const html = readFileSync(join(REPO, "worker-ui", "workspace.html"), "utf8");
  assert(/SHELL_WARN = .*full permissions/.test(html) && (html.match(/c\.id === "shell" \? SHELL_WARN/g) || []).length === 2, "warning not wired into both pickers");
  return { pickers: 2 };
});

srv.kill(); await stub.close();
writeFileSync(join(process.env.RESULTS_DIR || HERE, "file-boundary-results.json"), JSON.stringify({ at: new Date().toISOString(), runtime: execFileSync(real, ["--version"], { encoding: "utf8" }).trim(), results }, null, 1));
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
