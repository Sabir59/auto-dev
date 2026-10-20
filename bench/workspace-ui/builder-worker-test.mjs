// The real Builder workflow, done by the real worker through the Workspace UI and the native Builder
// adapter, against the owner's personal Builder dev space (model matw-next-application). Everything
// the worker claims is checked here with separate raw Builder requests and the live page.
// Nothing here calls the adapter on the worker's behalf.
//   DATA=<console data dir> SITE=<site rendering the dev space, e.g. http://localhost:3000>
//   node bench/workspace-ui/builder-worker-test.mjs <port>     (run-suite.sh builder-real)
import { chromium } from "../../browser-adapter/node_modules/playwright/index.mjs";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const [port = "8797"] = process.argv.slice(2);
const BASE = `http://127.0.0.1:${port}`, DATA = process.env.DATA, SITE = process.env.SITE || "http://localhost:3000";
const MODEL = "matw-next-application", LEFTOVER_DRAFT = "6d946049fd6b45258bbea6eb3a438473"; // a known real draft
const H = { origin: BASE, "x-worker-console": "1", "content-type": "application/json" };
const call = (method, path, data) => fetch(BASE + path, { method, headers: H, body: data ? JSON.stringify(data) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const cred = JSON.parse(readFileSync(join(process.env.BUILDER_ADAPTER_DIR || join(homedir(), ".builder-adapter"), "credentials.json"), "utf8"));
const results = [];
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail).slice(0, 300)); return detail; }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 400)); return null; }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Independent Builder reads, made here. By id returns drafts too, so "live" = published + url lookup.
const cdn = async (params) => {
  const u = new URL(`https://cdn.builder.io/api/v3/content/${MODEL}`);
  u.searchParams.set("apiKey", cred.publicKey); u.searchParams.set("cachebust", "true");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u); assert(r.ok, `independent read ${r.status}`); return (await r.json()).results || [];
};
const byId = async (id) => (await cdn({ "query.id": id, includeUnpublished: "true", limit: "1" })).find((e) => e.id === id) || null;
const liveAt = async (url) => (await cdn({ "userAttributes.urlPath": url, limit: "1" }))[0]?.id ?? null;
const sitePage = async (path, marker) => {
  let last;
  for (let i = 0; i < 12; i++) { const r = await fetch(new URL(path, SITE)); last = { status: r.status, hasMarker: marker ? (await r.text()).includes(marker) : null }; if (last.status === 200 && (!marker || last.hasMarker)) break; await sleep(5000); }
  return last;
};

// The run's own record: every tool call the worker made, with what each tool returned.
const raw = (id) => readFileSync(join(DATA, "runs", `${id}.raw.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
function toolTrace(id) {
  const msgs = raw(id), uses = [], out = {};
  for (const m of msgs) for (const c of m.message?.content || []) {
    if (c.type === "tool_use") uses.push({ id: c.id, tool: c.name.replace(/^mcp__builder__/, ""), input: c.input });
    if (c.type === "tool_result") out[c.tool_use_id] = { isError: !!c.is_error, text: (Array.isArray(c.content) ? c.content.map((x) => x.text || "").join("") : String(c.content || "")) };
  }
  return uses.map((u) => { const r = out[u.id] || {}; let json = null; try { json = JSON.parse(r.text); } catch {} return { ...u, isError: r.isError, result: json ?? r.text }; });
}

const NAME = `worker-proof-${Date.now()}`, URL_ = `/${NAME}`;
const evidence = { name: NAME, url: URL_ };
let runId, trace = [];

await step("before: inspect existing entries (no leftover with this name; earlier worker-proof entries noted)", async () => {
  const all = await cdn({ includeUnpublished: "true", limit: "100", fields: "id,name,published,data.url" });
  const prior = all.filter((e) => /^worker-proof-/.test(e.name)).map((e) => `${e.id} ${e.name} ${e.published}`);
  assert(!all.some((e) => e.name === NAME || e.data?.url === URL_), "the name or url already exists");
  const site = await fetch(new URL(URL_, SITE)); evidence.siteBefore = site.status;
  assert(site.status === 404, `site should 404 for ${URL_} before the run: ${site.status}`);
  return { entries: all.length, priorWorkerProofEntries: prior, siteBefore: site.status };
});

const worker = (await call("POST", "/workers", {
  name: "Builder Editor", mission: "Create, update and publish Builder.io content in the test space, and verify it.",
  capabilities: ["builder.read", "builder.write"],
  requirements: [{ resource: "builder", access: "read", need: "required" }, { resource: "builder", access: "write", need: "required" }],
  limitations: ["Never create a second entry for content that already exists: update it.", "Never claim a page is live unless builder_verify_content says servedAsLive: true."],
})).body;

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1280, height: 1008 } });
const pageErrors = []; page.on("pageerror", (e) => pageErrors.push(e.message));
await page.goto(BASE, { waitUntil: "networkidle" });

await step("the worker, in the UI, gets the Builder tools and its requirements are met", async () => {
  await page.click('#wsList [data-ws="scratch"]');
  await page.click('#wkList [data-wk]:has-text("Builder Editor")');
  const st = (await call("GET", "/workers?workspace=scratch")).body.workers.find((w) => w.id === worker.id).status.map((s) => `${s.access}:${s.state}`);
  assert(st.join() === "read:Connected,write:Test space", st.join());
  return { requirements: st };
});

const PROMPT = `Use only your Builder tools, in model ${MODEL}, and don't ask me anything; just do it and report:
1. Check Builder access, then list the models.
2. Read the existing entry whose url is /test-adapter: report its id and publication state.
3. List the model's entries; if one named ${NAME} or at url ${URL_} already exists, use it instead of creating another.
4. Create a draft named ${NAME} at url ${URL_} with data { "title": "${NAME} v1" }.
5. Verify it and report whether it is live.
6. Also verify the existing entry ${LEFTOVER_DRAFT} and report whether it is live.
7. Update the draft's title to "${NAME} v2".
8. Publish it.
9. Verify it again and report its state, whether it's served as live, and its url.`;

await step("the worker runs the workflow (prompt typed in the composer)", async () => {
  await page.fill("#input", PROMPT);
  await page.click("#send");
  await page.waitForFunction(() => ["Working", "Starting"].includes(({ starting: "Starting", running: "Working", waiting: "Waiting for you", finished: "Finished", stopped: "Stopped", failed: "Failed", interrupted: "Interrupted" }[document.querySelector("#runChip").dataset.status] || "Ready")), null, { timeout: 30000 });
  await page.waitForFunction(() => ["Waiting for you", "Failed", "Finished"].includes(({ starting: "Starting", running: "Working", waiting: "Waiting for you", finished: "Finished", stopped: "Stopped", failed: "Failed", interrupted: "Interrupted" }[document.querySelector("#runChip").dataset.status] || "Ready")), null, { timeout: 600000 });
  runId = (await call("GET", "/runs")).body.runs[0].id;
  const state = await page.evaluate(() => ({ starting: "Starting", running: "Working", waiting: "Waiting for you", finished: "Finished", stopped: "Stopped", failed: "Failed", interrupted: "Interrupted" }[document.querySelector("#runChip").dataset.status] || "Ready"));
  mkdirSync(join(HERE, "shots"), { recursive: true });
  await page.screenshot({ path: join(HERE, "shots", "builder-worker-run.png") });
  trace = toolTrace(runId);
  const fail = raw(runId).find((m) => m.type === "result")?.is_error;
  assert(state === "Waiting for you" && !fail, `run ended as ${state}: ${raw(runId).find((m) => m.type === "result")?.result}`);
  return { runId, state, toolCalls: trace.map((t) => t.tool) };
});

const calls = (tool) => trace.filter((t) => t.tool === tool);
let created;
await step("its tool calls cover the workflow, in order, through the native adapter", async () => {
  const order = trace.map((t) => t.tool);
  const need = ["builder_access_status", "builder_list_models", "builder_create_draft", "builder_update_content", "builder_publish_content"];
  for (const t of need) assert(order.includes(t), `missing ${t}: ${order.join(", ")}`);
  assert(order.indexOf("builder_create_draft") < order.indexOf("builder_update_content") && order.indexOf("builder_update_content") < order.lastIndexOf("builder_publish_content"), `order: ${order.join(", ")}`);
  assert(!order.some((t) => !t.startsWith("builder_") && !["ToolSearch"].includes(t)), `non-Builder tools used: ${order.join(", ")}`);
  const ok = calls("builder_create_draft").filter((c) => !c.isError);
  assert(ok.length === 1, `${ok.length} successful creates`);
  created = ok[0].result;
  evidence.createdId = created.id;
  return { order, createdId: created.id };
});

await step("it read /test-adapter and reported a published editor page", async () => {
  const reads = [...calls("builder_get_content"), ...calls("builder_list_content"), ...calls("builder_verify_content")].map((c) => JSON.stringify(c.result));
  assert(reads.some((r) => r.includes("de5d576a9404479baae0fd401a12c80c")), "no tool result mentions /test-adapter's id");
  return { readCalls: calls("builder_get_content").length + calls("builder_list_content").length };
});

await step("drafts are never reported as live (its own draft, and an existing draft)", async () => {
  const v = calls("builder_verify_content").map((c) => c.result);
  const own = v.find((r) => r?.url === URL_ && r?.state === "draft"), leftover = v.find((r) => r?.state === "draft" && r?.url !== URL_);
  assert(own && own.servedAsLive === false, `its draft's verification: ${JSON.stringify(own)}`);
  assert(leftover && leftover.servedAsLive === false, `the existing draft's verification: ${JSON.stringify(leftover)}`);
  const ind = await byId(LEFTOVER_DRAFT), at = await liveAt(ind.data.url), site = await fetch(new URL(ind.data.url, SITE));
  assert(ind.published === "draft" && at !== LEFTOVER_DRAFT && site.status === 404, "independent: the existing draft isn't live");
  return { ownDraft: own, existingDraft: leftover, independentExistingDraft: { state: ind.published, servedAtUrl: at === LEFTOVER_DRAFT, site: site.status } };
});

await step("its final verification says published and live", async () => {
  const last = calls("builder_verify_content").map((c) => c.result).filter((r) => r?.url === URL_).at(-1);
  const pub = calls("builder_publish_content").find((c) => !c.isError)?.result;
  assert(pub?.verification?.servedAsLive === true && last?.state === "published" && last?.servedAsLive === true, JSON.stringify({ pub, last }));
  return { publish: pub, lastVerify: last };
});

await step("INDEPENDENT Builder check: one entry, published, v2 content, served at its url", async () => {
  const e = await byId(evidence.createdId);
  const same = (await cdn({ includeUnpublished: "true", limit: "100", fields: "id,name" })).filter((x) => x.name === NAME);
  const at = await liveAt(URL_);
  assert(e?.published === "published" && e.data?.title === `${NAME} v2`, JSON.stringify({ state: e?.published, title: e?.data?.title }));
  assert(same.length === 1, `${same.length} entries named ${NAME}`);
  assert(at === evidence.createdId, `url lookup returns ${at}`);
  return (evidence.builder = { id: e.id, state: e.published, title: e.data.title, entriesWithThisName: same.length, servedAtUrl: true });
});

await step("INDEPENDENT live page: the site serves it with the v2 content", async () => {
  const s = await sitePage(URL_, `${NAME} v2`);
  assert(s.status === 200 && s.hasMarker, JSON.stringify(s));
  return (evidence.siteAfter = { url: new URL(URL_, SITE).href, ...s });
});

await step("no credential appears in the transcript, events, context or UI", async () => {
  const files = [`${runId}.raw.jsonl`, `${runId}.jsonl`, `${runId}.worker.md`, `${runId}.worker.json`, `${runId}.mcp.json`].map((f) => readFileSync(join(DATA, "runs", f), "utf8"));
  const ui = await page.content();
  const leaked = [cred.privateKey, cred.publicKey].filter((k) => [...files, ui].some((t) => t.includes(k)));
  assert(!leaked.length, `${leaked.length} key(s) found`);
  return { filesChecked: files.length + 1 };
});

await b.close();
writeFileSync(join(HERE, "builder-worker-results.json"), JSON.stringify({ when: new Date().toISOString(), note: "REAL worker, REAL Builder dev space, REAL site; keys redacted by construction (never written here).", evidence, toolCalls: trace.map((t) => ({ tool: t.tool, input: t.input, isError: t.isError, result: t.result })), results, pageErrors }, null, 1));
console.log(`\n${results.filter((x) => x.ok).length}/${results.length} passed; page errors: ${pageErrors.length ? pageErrors.join(" | ") : "none"}`);
