// Builder spaces as a platform capability, end to end on two consoles (two people), with a local
// Builder stand-in that has two spaces (mock-builder.mjs), a stand-in for Claude that keeps a run alive
// (fake-claude.mjs) and the real Builder tool server, called through the MCP SDK as a worker would.
// Nothing reaches a model or Builder.
//   node bench/builder/spaces-test.mjs
// Covers: connecting several spaces from the console (keys checked, wrong and mismatched keys refused,
// a test space only with explicit confirmation), encryption at rest, per-person isolation, per-worker
// space permissions (read / read and write), production write prevention (on save, at the tool, and
// when a space is marked as production during a run), only the run's own spaces released to its tool
// server, export/import without credentials or space mapping, and clone keeping the mapping.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startMock, KEYS, KEYS_B } from "./mock-builder.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", "..");
const { Client } = await import("../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js");
const { StdioClientTransport } = await import("../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js");
const { unzip } = await import("../../worker-ui/workerpack.mjs").catch(() => ({}));
const ROOT = join(tmpdir(), `bspaces-${Date.now()}`); mkdirSync(ROOT, { recursive: true });
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const results = [];
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail ?? null).slice(0, 240)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 900)); }
};
const assert = (c, m) => { if (!c) throw new Error(typeof m === "string" ? m : JSON.stringify(m)); };
const KEY_TEXT = [KEYS.public, KEYS.private, KEYS_B.public, KEYS_B.private];
const noKeys = (text, where) => { for (const k of KEY_TEXT) assert(!String(text).includes(k), `${where} contains a key (${k.slice(0, 8)}…)`); };

const mock = await startMock();
const BASES = { BUILDER_ADMIN_BASE: `http://127.0.0.1:${mock.port}`, BUILDER_CONTENT_BASE: `http://127.0.0.1:${mock.port}`, BUILDER_WRITE_BASE: `http://127.0.0.1:${mock.port}` };
Object.assign(process.env, BASES); // the tool servers this test starts get them too

// One console per person: own data, own folders, own credential key (as the hosted gateway gives each).
async function startConsole(name, port) {
  const DATA = join(ROOT, name, "data"), key = randomBytes(32).toString("base64"), OUT = join(ROOT, name, "fake");
  mkdirSync(DATA, { recursive: true });
  const env = { ...process.env, WORKER_CONSOLE_PORT: String(port), WORKER_CONSOLE_DATA: DATA, AIW_CREDENTIAL_KEY: key, CLAUDE_BIN: process.execPath, CLAUDE_BIN_ARGS: JSON.stringify([join(REPO, "bench", "integrations", "fake-claude.mjs")]), FAKE_CLAUDE_OUT: OUT,
    BUILDER_ADAPTER_DIR: join(DATA, "builder"), FIGMA_READER_DIR: join(DATA, "figma-reader"), GITHUB_CONNECTOR_DIR: join(DATA, "github"), FIGMA_BRIDGE_PORT: String(port + 1) };
  const p = spawn(process.execPath, [join(REPO, "worker-ui", "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; p.stdout.on("data", (d) => (log += d)); p.stderr.on("data", (d) => (log += d));
  const BASE = `http://127.0.0.1:${port}`, H = { origin: BASE, "x-worker-console": "1", "content-type": "application/json" };
  for (let i = 0; ; i++) { try { await fetch(BASE + "/"); break; } catch { if (i > 80) throw new Error(`${name}'s console didn't start: ${log.slice(-800)}`); await sleep(250); } }
  const call = (m, path, b) => fetch(BASE + path, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, text: await r.clone().text(), body: await r.json().catch(() => null) }));
  const dir = join(ROOT, name, "work"); mkdirSync(dir, { recursive: true }); execFileSync("git", ["init", "-q", dir]); writeFileSync(join(dir, "a.txt"), "a");
  const ws = (await call("POST", "/workspaces", { name: `${name} work`, path: dir, mode: "work" })).body.id;
  return { name, port, BASE, H, call, DATA, key, ws, dir, proc: p, log: () => log, credFile: join(DATA, "builder", "credentials.json") };
}
const A = await startConsole("alice", 8811), B = await startConsole("bob", 8814);
const runsDir = (c) => join(c.DATA, "runs");
async function startRun(c, worker) {
  const r = await c.call("POST", "/runs", { prompt: "hello", workspace: c.ws, worker });
  assert(r.status === 200, r.body);
  for (let i = 0; i < 100; i++) { const a = (await c.call("GET", "/runs")).body; if (a.active === r.body.id && existsSync(join(runsDir(c), `${r.body.id}.mcp.json`))) break; await sleep(100); }
  await sleep(300);
  return { id: r.body.id, mcp: JSON.parse(readFileSync(join(runsDir(c), `${r.body.id}.mcp.json`), "utf8")).mcpServers };
}
const stopRun = async (c, id) => { await c.call("POST", `/runs/${id}/stop`, {}); for (let i = 0; i < 50; i++) { if (!(await c.call("GET", "/runs")).body.active) break; await sleep(100); } };
async function builderClient(run) {
  const s = run.mcp.builder; assert(s, `the run has no builder server: ${Object.keys(run.mcp).join(", ")}`);
  const client = new Client({ name: "spaces-test", version: "1" });
  await client.connect(new StdioClientTransport({ command: s.command, args: s.args, env: { ...process.env, ...s.env } }));
  for (let i = 0; i < 30 && !(await client.listTools()).tools.length; i++) await sleep(200); // the tools turn on once the console says Builder is connected
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  const callTool = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); const text = r.content?.[0]?.text || ""; let json = null; try { json = JSON.parse(text); } catch {} return { isError: !!r.isError, text, json }; };
  return { client, tools, call: callTool, env: s.env, close: () => client.close() };
}
const workerBody = (name, spaces, publishing = "publish") => ({ schema: 2, name, specialization: "Builder pages", mission: "Edit Builder content", core: ["files.read"], workflow: [], limitations: [], knowledge: "",
  integrations: [{ id: "builder", version: "1.1.0", config: { spaces, models: "page", publishing, check: "no" } }] });
const writesTo = (since, priv) => mock.log.slice(since).filter((r) => /\/api\/v1\/(write|upload)/.test(r.path) && r.auth === `Bearer ${priv}`);

let SA = null, SB = null; // space ids: A is the test space, B the production space
await step("connecting a space: wrong keys, keys from two different spaces, and a test space without confirmation are all refused; nothing is stored", async () => {
  const wrong = await A.call("POST", "/builder/spaces", { label: "Wrong", publicKey: KEYS.public, privateKey: "bpk-not-the-right-key-000000" });
  const mixed = await A.call("POST", "/builder/spaces", { label: "Mixed", publicKey: KEYS.public, privateKey: KEYS_B.private });
  const unconfirmed = await A.call("POST", "/builder/spaces", { label: "Site (test)", publicKey: KEYS.public, privateKey: KEYS.private, environment: "test" });
  const malformed = await A.call("POST", "/builder/spaces", { label: "Bad", publicKey: "x", privateKey: "nope" });
  assert(wrong.status === 400 && /rejected the private key/.test(wrong.body.error), wrong.body);
  assert(mixed.status === 400 && /different Builder spaces/.test(mixed.body.error), mixed.body);
  assert(unconfirmed.status === 400 && /Confirm that this is a test/.test(unconfirmed.body.error), unconfirmed.body);
  assert(malformed.status === 400, malformed.body);
  for (const r of [wrong, mixed, unconfirmed, malformed]) noKeys(r.text, "an error");
  assert(!existsSync(A.credFile), "nothing should be stored");
  return { wrong: wrong.body.error, mixed: mixed.body.error, unconfirmed: unconfirmed.body.error.slice(0, 60) };
});

await step("two spaces connected from the console: a confirmed test space and a production space (the default)", async () => {
  const t = await A.call("POST", "/builder/spaces", { label: "Site (test)", publicKey: KEYS.public, privateKey: KEYS.private, environment: "test", confirmTest: true });
  const p = await A.call("POST", "/builder/spaces", { label: "Live site", publicKey: KEYS_B.public, privateKey: KEYS_B.private });
  assert(t.status === 200 && p.status === 200, [t.body, p.body]);
  const r = (await A.call("GET", "/builder")).body;
  assert(r.spaces.length === 2, r);
  const [a, b] = r.spaces; SA = a.id; SB = b.id;
  assert(a.environment === "test" && a.testConfirmedAt && a.models === 2 && b.environment === "production" && !b.testConfirmedAt && b.models === 1, r.spaces);
  assert(/^sp_[a-f0-9]{12}$/.test(SA) && SA !== SB, [SA, SB]);
  noKeys(JSON.stringify(r) + t.text + p.text, "the Builder page's data");
  const dup = await A.call("POST", "/builder/spaces", { label: "live SITE", publicKey: KEYS.public, privateKey: KEYS.private });
  assert(dup.status === 400 && /already called/.test(dup.body.error), dup.body);
  return { spaces: r.spaces.map((s) => `${s.label}: ${s.environment} (${s.id})`) };
});

await step("encrypted at rest: the file holds no key and no space name; another person's key can't read it", async () => {
  const raw = readFileSync(A.credFile, "utf8"), rec = JSON.parse(raw);
  assert(rec.enc === "aes-256-gcm" && rec.v === 1 && rec.ct && !("spaces" in rec), Object.keys(rec));
  noKeys(raw, "the stored file"); assert(!raw.includes("Site (test)") && !raw.includes("Live site"), "space names in clear");
  const read = (key) => spawnSync(process.execPath, ["--input-type=module", "-e", `const B = await import(${JSON.stringify(new URL("../../builder-adapter/builder.mjs", import.meta.url).href)}); try { console.log(JSON.stringify(B.readSpaces().map((s) => s.label))); } catch (e) { console.log("ERR " + e.code); }`],
    { env: { ...process.env, BUILDER_ADAPTER_DIR: dirname(A.credFile), AIW_CREDENTIAL_KEY: key }, encoding: "utf8" }).stdout.trim();
  const own = read(A.key), other = read(B.key), none = read("");
  assert(own === '["Site (test)","Live site"]', own);
  assert(other === "ERR BAD_CREDENTIALS" && none === "ERR BAD_CREDENTIALS", [other, none]);
  return { own, otherPersonsKey: other, noKey: none };
});

await step("isolation: the other person's console has no spaces, and can't use the first person's space ids", async () => {
  const r = (await B.call("GET", "/builder")).body;
  assert(r.spaces.length === 0, r);
  const w = await B.call("POST", "/workers", workerBody("Bob's Builder worker", [`${SA}:write`]));
  assert(w.status === 200, w.body); // an id that isn't connected here is kept but gives nothing
  const st = (await B.call("GET", "/workers")).body.workers.find((x) => x.name === "Bob's Builder worker").status.find((s) => s.resource === "builder" && s.access === "read");
  assert(!st.ok && /No Builder space connected/.test(st.state) && /Builder\.io page/.test(st.how) && !/README/.test(st.how), st);
  return { bobSpaces: r.spaces.length, status: st.state, how: st.how };
});

let W1, W2, W3;
await step("per-worker permissions on save: write access to a production space is refused; read is allowed", async () => {
  const bad = await A.call("POST", "/workers", workerBody("Bad", [`${SA}:write`, `${SB}:write`]));
  assert(bad.status === 400 && /"Live site" is a production Builder space/.test(bad.body.error), bad.body);
  W1 = (await A.call("POST", "/workers", workerBody("Editor", [`${SA}:write`, `${SB}:read`]))).body;
  W2 = (await A.call("POST", "/workers", workerBody("Reader", [`${SB}:read`], "read"))).body;
  W3 = (await A.call("POST", "/workers", workerBody("Unassigned", []))).body;
  assert(W1.id && W2.id && W3.id, [W1, W2, W3]);
  const r = (await A.call("GET", "/builder")).body, byId = Object.fromEntries(r.spaces.map((s) => [s.id, s.workers.map((w) => `${w.name}:${w.access}`).sort()]));
  assert(byId[SA].join() === "Editor:write" && byId[SB].join() === "Editor:read,Reader:read", byId);
  const status = Object.fromEntries((await A.call("GET", "/workers")).body.workers.filter((w) => [W1.id, W3.id].includes(w.id)).map((w) => [w.name, w.status.filter((s) => s.resource === "builder").map((s) => `${s.access}:${s.ok ? "ok" : s.state}`)]));
  assert(status.Editor.join() === "read:ok,write:ok" && /No Builder space given to this worker/.test(status.Unassigned.join()), status);
  return { refused: bad.body.error, onThePage: byId, status };
});

await step("a run's tool server gets only that worker's spaces, never the person's credential key; writes go only to the test space it may write to", async () => {
  const run = await startRun(A, W1.id);
  const env = run.mcp.builder.env;
  assert(env.BUILDER_ADAPTER_PROFILE === "full" && !("AIW_CREDENTIAL_KEY" in env), env);
  noKeys(readFileSync(join(runsDir(A), `${run.id}.mcp.json`), "utf8"), "the run's MCP config");
  const keyReq = await fetch(`${env.AIW_AUTHZ_URL}/credential-key?server=builder`, { headers: { "x-aiw-authz": env.AIW_AUTHZ_TOKEN } });
  const wrongToken = await fetch(`${env.AIW_AUTHZ_URL}/builder-spaces?server=builder`, { headers: { "x-aiw-authz": "nope" } });
  const otherServer = await fetch(`${env.AIW_AUTHZ_URL}/builder-spaces?server=figma-reader`, { headers: { "x-aiw-authz": env.AIW_AUTHZ_TOKEN } });
  assert(keyReq.status === 403 && wrongToken.status === 403 && otherServer.status === 403, [keyReq.status, wrongToken.status, otherServer.status]);
  const c = await builderClient(run);
  const since = mock.log.length;
  const st = await c.call("builder_access_status");
  assert(st.json.connected && st.json.spaces.length === 2, st.text);
  const a = st.json.spaces.find((s) => s.id === SA), b = st.json.spaces.find((s) => s.id === SB);
  assert(a.access === "write" && b.access === "read" && /production/.test(b.writes), st.json);
  noKeys(st.text, "access status");
  const ambiguous = await c.call("builder_list_models");
  const modelsB = await c.call("builder_list_models", { space: "Live site" });
  const created = await c.call("builder_create_draft", { model: "page", space: SA, name: "From the editor worker" });
  const refusedB = await c.call("builder_create_draft", { model: "page", space: SB, name: "Must not exist" });
  const refusedPublish = await c.call("builder_publish_content", { model: "page", id: "secondlive0001", space: "live site" });
  assert(ambiguous.isError && /Several Builder spaces/.test(ambiguous.text), ambiguous.text);
  assert(modelsB.json?.map((m) => m.id).join() === "b-page", modelsB.text);
  assert(!created.isError && created.json.published === "draft", created.text);
  assert(refusedB.isError && /production spaces are never written to/.test(refusedB.text) && refusedPublish.isError, [refusedB.text, refusedPublish.text]);
  assert(writesTo(since, KEYS_B.private).length === 0 && writesTo(since, KEYS.private).length === 1, mock.log.slice(since).map((r) => `${r.method} ${r.path}`));
  // The person marks the test space as production during the run: the next write is refused at once.
  const toProd = await A.call("PUT", `/builder/spaces/${SA}`, { environment: "production" });
  assert(toProd.status === 200, toProd.body);
  const s2 = mock.log.length, after = await c.call("builder_create_draft", { model: "page", space: SA, name: "After marking production" });
  assert(after.isError && /production spaces are never written to/.test(after.text) && writesTo(s2, KEYS.private).length === 0, after.text);
  const noConfirm = await A.call("PUT", `/builder/spaces/${SA}`, { environment: "test" });
  const back = await A.call("PUT", `/builder/spaces/${SA}`, { environment: "test", confirmTest: true });
  assert(noConfirm.status === 400 && back.status === 200, [noConfirm.body, back.body]);
  await c.close(); await stopRun(A, run.id);
  return { tools: c.tools.length, statusSpaces: st.json.spaces.map((s) => `${s.space}:${s.access}`), created: created.json.id, refused: refusedB.text.slice(0, 80), afterMarkedProduction: after.text.slice(0, 80) };
});

await step("a read-only worker: its server has no write tools, sees only its own space, and can't name another", async () => {
  const run = await startRun(A, W2.id);
  assert(run.mcp.builder.env.BUILDER_ADAPTER_PROFILE === "read", run.mcp.builder.env);
  const c = await builderClient(run);
  assert(!c.tools.some((t) => /create|update|publish|upload/.test(t)), c.tools);
  const st = await c.call("builder_access_status"), other = await c.call("builder_list_models", { space: SA }), own = await c.call("builder_list_models");
  const released = await (await fetch(`${c.env.AIW_AUTHZ_URL}/builder-spaces?server=builder`, { headers: { "x-aiw-authz": c.env.AIW_AUTHZ_TOKEN } })).json();
  assert(st.json.spaces.length === 1 && st.json.spaces[0].id === SB, st.text);
  assert(other.isError && /No space available to this worker is/.test(other.text) && !own.isError, [other.text, own.text]);
  assert(released.spaces.length === 1 && released.spaces[0].id === SB && released.spaces[0].access === "read", released.spaces.map((s) => s.id));
  await c.close(); await stopRun(A, run.id);
  return { tools: c.tools, spaces: st.json.spaces.map((s) => s.space) };
});

await step("a worker given no space: told to connect and assign one on the platform (not a README)", async () => {
  const run = await startRun(A, W3.id);
  const released = await (await fetch(`${run.mcp.builder.env.AIW_AUTHZ_URL}/builder-spaces?server=builder`, { headers: { "x-aiw-authz": run.mcp.builder.env.AIW_AUTHZ_TOKEN } })).json();
  await stopRun(A, run.id);
  const st = (await A.call("GET", "/workers")).body.workers.find((w) => w.id === W3.id).status.find((s) => s.resource === "builder" && s.access === "read");
  assert(released.spaces.length === 0, released);
  assert(/Builder\.io page/.test(st.how) && !/README|on this computer/.test(st.how), st.how);
  // the tool server's own answer, run on its own with no space in its file
  const c = new Client({ name: "spaces-test", version: "1" }), empty = join(ROOT, "empty-builder"); mkdirSync(empty, { recursive: true });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(REPO, "mcp", "builder-server.mjs")], env: { ...process.env, BUILDER_ADAPTER_DIR: empty } }));
  const text = (await c.callTool({ name: "builder_access_status", arguments: {} })).content[0].text; await c.close();
  assert(/NEEDS: builder read/.test(text) && /Builder\.io page/.test(text) && !/README/.test(text), text);
  return { how: st.how, server: JSON.parse(text).why.slice(0, 120) };
});

let packB64 = null;
await step("export: the package declares Builder and its permission level, with no keys and no space mapping", async () => {
  const pv = (await A.call("GET", `/workers/${W1.id}/export/preview`)).body;
  const r = await fetch(`${A.BASE}/workers/${W1.id}/export`, { headers: A.H });
  if (r.status !== 200) throw new Error(await r.text());
  const buf = Buffer.from(await r.arrayBuffer()); packB64 = buf.toString("base64");
  const files = unzip ? unzip(buf) : null, all = files ? [...files.values()].map((b) => b.toString("utf8")).join("\n") : buf.toString("latin1");
  noKeys(all, "the package"); assert(!all.includes(SA) && !all.includes(SB) && !/sp_[a-f0-9]{12}/.test(all), "the package contains space ids");
  const def = JSON.parse(files.get("worker.json").toString("utf8")), ref = def.integrations.find((x) => x.id === "builder");
  assert(ref.version === "1.1.0" && ref.config.publishing === "publish" && !("spaces" in ref.config), ref);
  const deps = JSON.parse(files.get("dependencies.json").toString("utf8"));
  assert(deps.requirements.some((x) => x.resource === "builder" && x.access === "write"), deps.requirements);
  assert(pv.preview.excluded.some((x) => /tied to your own accounts.*builder: spaces/.test(x)), pv.preview.excluded);
  return { config: ref.config, requirements: deps.requirements.map((x) => `${x.resource} ${x.access}`), excluded: pv.preview.excluded.find((x) => /accounts/.test(x)) };
});

await step("import on the other person's console: installs with no spaces; they connect their own and map it", async () => {
  const pv = await B.call("POST", "/workerpacks/preview", { data: packB64, workspace: B.ws });
  assert(pv.status === 200, pv.body);
  const inst = await B.call("POST", `/workerpacks/${pv.body.token}/install`, { workspace: B.ws });
  assert(inst.status === 200, inst.body);
  const w = (await B.call("GET", "/workers")).body.workers.find((x) => x.id === inst.body.worker.id);
  assert(!(w.integrations.find((x) => x.id === "builder").config.spaces || []).length, w.integrations);
  const before = w.status.find((s) => s.resource === "builder" && s.access === "read");
  assert(!before.ok, before);
  // Bob connects his own space (the second space of the stand-in, as production) and gives it to the worker.
  const con = await B.call("POST", "/builder/spaces", { label: "Bob's site", publicKey: KEYS_B.public, privateKey: KEYS_B.private });
  const sid = con.body.added;
  const writeRefused = await B.call("PUT", `/workers/${w.id}`, { ...w, integrations: w.integrations.map((x) => (x.id === "builder" ? { ...x, config: { ...x.config, spaces: [`${sid}:write`] } } : x)) });
  const mapped = await B.call("PUT", `/workers/${w.id}`, { ...w, integrations: w.integrations.map((x) => (x.id === "builder" ? { ...x, config: { ...x.config, spaces: [`${sid}:read`] } } : x)) });
  assert(writeRefused.status === 400 && /production Builder space/.test(writeRefused.body.error), writeRefused.body);
  assert(mapped.status === 200, mapped.body);
  const after = (await B.call("GET", "/workers")).body.workers.find((x) => x.id === w.id).status.find((s) => s.resource === "builder" && s.access === "read");
  assert(after.ok && /Bob's site/.test(after.detail), after);
  // Alice's own credential file is untouched by any of this.
  assert((await A.call("GET", "/builder")).body.spaces.length === 2, "alice's spaces changed");
  return { installed: w.name, before: before.state, after: `${after.state} · ${after.detail}` };
});

await step("clone on the same console keeps the worker's space mapping (it never leaves this person)", async () => {
  const r = await A.call("POST", `/workers/${W1.id}/clone`, { name: "Editor copy" });
  assert(r.status === 200, r.body);
  const w = (await A.call("GET", "/workers")).body.workers.find((x) => x.id === r.body.worker.id);
  const spaces = w.integrations.find((x) => x.id === "builder").config.spaces;
  assert(spaces.slice().sort().join() === [`${SA}:write`, `${SB}:read`].sort().join(), spaces);
  return { spaces };
});

await step("an earlier single-space credentials file is read as one space, with the same id it gets when connected from the console", async () => {
  const C = join(ROOT, "legacy"); mkdirSync(C, { recursive: true });
  writeFileSync(join(C, "credentials.json"), JSON.stringify({ label: "Old test space", environment: "test", publicKey: KEYS.public, privateKey: KEYS.private }));
  const out = spawnSync(process.execPath, ["--input-type=module", "-e", `const B = await import(${JSON.stringify(new URL("../../builder-adapter/builder.mjs", import.meta.url).href)}); const s = B.readSpaces(); console.log(JSON.stringify(s.map(B.publicSpace)));`],
    { env: { ...process.env, BUILDER_ADAPTER_DIR: C, AIW_CREDENTIAL_KEY: "" }, encoding: "utf8" }).stdout.trim();
  const list = JSON.parse(out);
  assert(list.length === 1 && list[0].environment === "test" && list[0].id === SA && !("privateKey" in list[0]), list);
  return { legacy: list[0] };
});

for (const c of [A, B]) c.proc.kill();
await mock.close();
const passed = results.filter((r) => r.ok).length;
writeFileSync(join(HERE, "spaces-results.json"), JSON.stringify({ at: new Date().toISOString(), passed, failed: results.length - passed, results }, null, 1));
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
