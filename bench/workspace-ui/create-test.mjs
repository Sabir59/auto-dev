// Creating a worker for the work a person describes (worker-ui/integrations.mjs, worker-platform.md
// §13), through the console's API and the page. Covers:
//   1–5  Shopify, Google Sheets, WordPress, Next.js and Builder.io requests each get their own
//        questions and configuration, and nothing unrelated (no Builder publishing for Sheets);
//   6    a request combining several tools;
//   7    an integration with no connector: an honest explanation, and no worker from it alone;
//   8    missing credentials: the requirement says exactly what to connect;
//   9    permissions the workspace or platform doesn't allow stay denied, whatever was asked;
//   10   the created worker is stored and runs through the existing runtime (a real run).
// Shopify, Google Sheets and WordPress have NO connector: what's tested is the honest answer and
// what's composed instead (files, code, browser), not those services. Builder's API is the local
// mock. Step 10 starts the real worker (Claude Code sign-in needed; it asks for one short reply).
//   CANARY=<inspect folder> WORK=<work folder> DATA=<console data dir> BUILDER_DIR=<console's BUILDER_ADAPTER_DIR>
//   node bench/workspace-ui/create-test.mjs <port>     (run-suite.sh create)
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { startMock, KEYS } from "../builder/mock-builder.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", "..");
const { chromium } = createRequire(join(REPO, "browser-adapter", "package.json"))("playwright");
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
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const until = async (fn, ms = 60000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("timeout"); await sleep(400); } };
const creds = (c) => { mkdirSync(BDIR, { recursive: true }); if (c) writeFileSync(join(BDIR, "credentials.json"), JSON.stringify(c)); else rmSync(join(BDIR, "credentials.json"), { force: true }); };
const draft = async (b) => { const r = await call("POST", "/worker-drafts/preview", b); assert(r.status === 200, `preview ${r.status}: ${JSON.stringify(r.body)}`); return r.body; };
const create = (b) => call("POST", "/workers/from-request", b);
const REG = (await call("GET", "/integrations")).body.integrations;
const questionsOf = (d) => d.integrations.flatMap((id) => Object.keys(d.answers[id] || {}).map((q) => `${id}.${q}`));
const labelsOf = (d) => d.integrations.flatMap((id) => REG.find((i) => i.id === id).questions.filter((q) => q.id in (d.answers[id] || {})).map((q) => q.label));
const BUILDER_CAPS = ["builder.read", "builder.write", "builder.write.draft"];

const mock = await startMock({ port: 8789 }); // the console's BUILDER_*_BASE point here (run-suite.sh)
creds(null);
const canary = (await call("POST", "/workspaces", { name: "Canary", path: process.env.CANARY, mode: "inspect" })).body;
const work = (await call("POST", "/workspaces", { name: "Work test", path: process.env.WORK, mode: "work" })).body;
const created = [];

await step("1. Shopify: recognised as having no connector; asks what to work on (no guess); products → an exported CSV, and the live store stays out of reach", async () => {
  const d0 = await draft({ description: "Manage products and inventory in my Shopify store", workspace: work.id });
  assert(d0.integrations.join() === "shopify" && d0.unsupported[0]?.label === "Shopify" && d0.pending.length === 1 && d0.pending[0].question === "scope", JSON.stringify(d0));
  const blocked = await create({ description: "Manage products and inventory in my Shopify store" });
  assert(blocked.status === 400 && /Answer first/.test(blocked.body.error), JSON.stringify(blocked));
  const d = await draft({ description: "Manage products and inventory in my Shopify store", answers: { shopify: { store: "matw-test.myshopify.com", scope: ["catalog"] } }, workspace: work.id });
  assert(d.integrations.join() === "shopify,files" && d.addedBy.files === "Shopify" && d.definition.capabilities.includes("files.write"), JSON.stringify(d.integrations));
  assert(!d.definition.capabilities.some((c) => BUILDER_CAPS.includes(c) || c.startsWith("figma")) && d.unsupported.some((u) => /live store/.test(u.why)), JSON.stringify(d.definition.capabilities));
  assert(/CSV exported in Shopify admin/.test(d.definition.knowledge) && /matw-test.myshopify.com/.test(d.definition.knowledge) && d.definition.name === "Shopify worker", d.definition.knowledge);
  return { questions: labelsOf(d), capabilities: d.definition.capabilities, notPossible: d.unsupported.map((u) => u.label) };
});

await step("2. Google Sheets: its own questions only; no Builder.io publishing or any Builder setting", async () => {
  const d = await draft({ description: "Update and organise our Google Sheets", answers: { sheets: { scope: "edit" } }, workspace: work.id });
  const qs = questionsOf(d), labels = labelsOf(d);
  assert(d.integrations.join() === "sheets,files" && !qs.some((q) => q.startsWith("builder")) && !labels.some((l) => /publish/i.test(l)), JSON.stringify(qs));
  assert(!d.definition.capabilities.some((c) => BUILDER_CAPS.includes(c)) && d.unsupported.some((u) => /Google Sheet/.test(u.why)), JSON.stringify(d));
  return { questions: labels, capabilities: d.definition.capabilities };
});

await step("3. WordPress: asks what part of the site; content has no connector (pages read in a browser), theme or plugin code gets repository questions", async () => {
  const d0 = await draft({ description: "Maintain my WordPress website", workspace: work.id });
  assert(d0.integrations.includes("wordpress") && d0.pending.some((x) => x.integration === "wordpress"), JSON.stringify(d0.integrations));
  const d = await draft({ description: "Maintain my WordPress website", integrations: ["wordpress"], answers: { wordpress: { site: "https://example.org", scope: ["content", "code"] } }, workspace: work.id });
  assert(d.integrations.join() === "wordpress,browser,code" && d.answers.code.stack === "WordPress (PHP)" && "change" in d.answers.code, JSON.stringify(d.answers));
  assert(d.unsupported.some((u) => /REST API/.test(u.why)) && d.definition.capabilities.includes("browser"), JSON.stringify(d.unsupported));
  return { questions: labelsOf(d), notPossible: d.unsupported.map((u) => u.label) };
});

await step("4. Next.js: repository, stack (recognised), conventions, editing, Node scripts, browser checks; answers change the tools", async () => {
  const d = await draft({ description: "Build features in my Next.js repository", workspace: work.id });
  assert(d.integrations.join() === "code" && d.answers.code.stack === "Next.js" && d.definition.name === "Next.js engineer", JSON.stringify(d.answers));
  assert(["files.write", "shell", "browser"].every((c) => d.definition.capabilities.includes(c)) && d.definition.requirements.some((r) => r.resource === "workspace" && r.access === "write"), JSON.stringify(d.definition));
  const ro = await draft({ description: "Build features in my Next.js repository", answers: { code: { change: "read", scripts: "no", browser: "no", conventions: "docs/architecture.md" } }, workspace: work.id });
  assert(ro.definition.capabilities.join() === "files.read" && /docs\/architecture.md/.test(ro.definition.knowledge), JSON.stringify(ro.definition));
  return { questions: labelsOf(d), default: d.definition.capabilities, readOnly: ro.definition.capabilities };
});

await step("5. Builder.io: space, models, and what it may do with content (read / drafts / publish); drafts by default", async () => {
  const d = await draft({ description: "Create and maintain landing pages in Builder.io", workspace: "scratch" });
  assert(d.integrations.join() === "builder" && d.definition.capabilities.includes("builder.write.draft") && !d.definition.capabilities.includes("builder.write"), JSON.stringify(d.definition.capabilities));
  const pub = await draft({ description: "Create and maintain landing pages in Builder.io", answers: { builder: { space: "MATW test", models: "page", publishing: "publish" } }, workspace: "scratch" });
  assert(pub.definition.capabilities.includes("builder.write") && /Builder space: MATW test/.test(pub.definition.knowledge), JSON.stringify(pub.definition));
  return { questions: labelsOf(d), drafts: d.definition.capabilities, publish: pub.definition.capabilities };
});

await step("6. a combination: research competitors, keep a spreadsheet, check their sites — three tools composed, not a role", async () => {
  const d = await draft({ description: "Research competitors, keep a research spreadsheet up to date and check their websites", workspace: "scratch" });
  assert(["web", "files", "browser"].every((i) => d.integrations.includes(i)) && ["web", "files.write", "browser"].every((c) => d.definition.capabilities.includes(c)), JSON.stringify(d.integrations));
  return { integrations: d.integrations, name: d.definition.name, capabilities: d.definition.capabilities };
});

await step("7. no connector: Gmail (and a named \"Zendesk\") are explained, and no worker is created from them alone", async () => {
  const d = await draft({ description: "Answer customer emails in Gmail", others: ["Zendesk"], workspace: "scratch" });
  assert(d.nothingSupported && d.unsupported.map((u) => u.label).join() === "Gmail,Zendesk" && /no Gmail connector/i.test(d.unsupported[0].why), JSON.stringify(d.unsupported));
  const r = await create({ description: "Answer customer emails in Gmail", others: ["Zendesk"] });
  assert(r.status === 400 && /Nothing in this request can be done/.test(r.body.error), JSON.stringify(r));
  return { notPossible: d.unsupported, refused: r.body.error };
});

await step("8. missing credentials: Builder says Not connected and what to do; with a production space, writes are refused; only a test space is ready", async () => {
  const b = { description: "Create and maintain landing pages in Builder.io", workspace: "scratch" };
  const st = async () => (await draft(b)).status.map((s) => `${s.access}:${s.state}`).join();
  const none = await draft(b);
  assert(none.status.every((s) => !s.ok && s.state === "Not connected" && /keys|test space/.test(s.how)), JSON.stringify(none.status));
  creds({ label: "Prod", environment: "production", publicKey: KEYS.public, privateKey: KEYS.private }); const prod = await st();
  creds({ label: "Test", environment: "test", publicKey: KEYS.public, privateKey: KEYS.private }); const test = await st();
  creds(null);
  assert(prod === "read:Connected,write:Production space: writes refused" && test === "read:Connected,write:Test space", JSON.stringify({ prod, test }));
  return { noKeys: none.status.map((s) => `${s.label}: ${s.state} → ${s.how}`), production: prod, testSpace: test };
});

let nextWorker;
await step("9. what the workspace or platform doesn't allow stays denied: Inspect cuts edits and scripts; capabilities sent by the page are ignored; unknown answers are refused", async () => {
  const insp = await draft({ description: "Build features in my Next.js repository", workspace: canary.id });
  assert(["files.write", "shell"].every((c) => insp.blocked.includes(c) && !insp.usable.includes(c)) && insp.status.some((s) => s.access === "write" && !s.ok), JSON.stringify(insp));
  const smuggle = await create({ description: "Research competitors", answers: {}, capabilities: ["shell", "files.write", "figma.plugin.edit", "builder.write"], requirements: [], name: "Researcher" });
  assert(smuggle.status === 200 && smuggle.body.capabilities.join() === "files.read,web", JSON.stringify(smuggle.body.capabilities));
  created.push(smuggle.body.id);
  const bad = await Promise.all([
    create({ description: "x", integrations: ["shopify-admin"] }), create({ description: "x", integrations: ["code"], answers: { code: { sudo: "yes" } } }),
    create({ description: "x", integrations: ["code"], answers: { code: { change: "everything" } } }), create({ description: "" })]);
  assert(bad.every((r) => r.status === 400), JSON.stringify(bad.map((r) => r.body)));
  nextWorker = (await create({ description: "Build features in my Next.js repository", name: "Next.js engineer" })).body;
  created.push(nextWorker.id);
  const mcpOf = async (worker, workspace) => {
    const r = (await call("POST", "/runs", { prompt: "Reply with exactly: OK", workspace, worker })).body; assert(r?.id, JSON.stringify(r));
    const f = join(DATA, "runs", `${r.id}.worker.json`); await until(() => existsSync(f), 20000);
    await call("POST", `/runs/${r.id}/stop`); await until(async () => !(await call("GET", "/runs")).body.active, 30000);
    return JSON.parse(readFileSync(f, "utf8")).runtime;
  };
  const rt = await mcpOf(nextWorker.id, canary.id);
  assert(!rt.usable.includes("files.write") && !rt.usable.includes("shell") && rt.blocked.includes("files.write") && !rt.args.join(" ").includes("Bash"), JSON.stringify(rt.usable));
  return { inspectBlocked: insp.blocked, smuggledIgnored: smuggle.body.capabilities, refused: bad.map((r) => r.body.error), runInInspect: rt.usable };
});

await step("10. the created worker is stored with its request and runs through the existing runtime (real run): the runtime reports its tools", async () => {
  const w = (await call("GET", "/workers")).body.workers.find((x) => x.id === nextWorker.id);
  assert(w && w.fromRequest?.description === "Build features in my Next.js repository" && w.fromRequest.workspace === "project" && w.version === 1, JSON.stringify(w));
  const r = (await call("POST", "/runs", { prompt: "Reply with exactly: OK", workspace: work.id, worker: w.id, model: "haiku" })).body;
  assert(r?.id, JSON.stringify(r));
  const m = await until(async () => { const x = (await call("GET", `/runs/${r.id}`)).body; return ["waiting", "finished", "failed"].includes(x.status) ? x : null; }, 180000);
  const raw = readFileSync(join(DATA, "runs", `${r.id}.raw.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const init = raw.find((x) => x.type === "system" && x.subtype === "init"), reply = raw.filter((x) => x.type === "result").pop();
  await call("POST", `/runs/${r.id}/end`); await until(async () => !(await call("GET", "/runs")).body.active, 60000);
  assert(m.status === "waiting" && m.worker?.id === w.id && init?.tools?.includes("Write") && init.tools.includes("Bash") && /OK/.test(reply?.result || ""), JSON.stringify({ status: m.status, tools: init?.tools, result: reply?.result }));
  return { status: m.status, worker: m.worker, tools: init.tools.filter((t) => !t.startsWith("mcp__")), reply: reply.result };
});
for (const id of created) await call("DELETE", `/workers/${id}`);

// ---- the page ----
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
const pageErrors = []; page.on("pageerror", (e) => pageErrors.push(e.message));
const shot = (n) => page.screenshot({ path: join(HERE, "shots", `create-${n}.png`) });
const describe = async (text) => { await page.click("#addWk"); await page.waitForSelector("#crDesc"); await page.fill("#crDesc", text); await page.click('[data-next="2"]'); await page.waitForSelector(".isec, .ichips"); };
const cancel = async () => { await page.click("#crCancel"); try { await page.waitForSelector("#dlg[open]", { timeout: 1500 }); await page.click('[data-dlg="discard"]'); } catch {} };
const qLabels = () => page.locator(".isec .qlab").allInnerTexts();
await page.goto(BASE, { waitUntil: "networkidle" });
await page.click(`#wsList [data-ws="${work.id}"]`);

await step("page: the guide asks what the worker should do; a Shopify example leads to Shopify's questions, which must be answered before review", async () => {
  await page.waitForSelector("#gsGuide #gsDesc");
  await page.click('[data-gs-ex="Manage products and inventory in my Shopify store"]'); await page.click('[data-gs="describe"]');
  await page.waitForSelector('.isec:has-text("Shopify")');
  const chips = await page.locator(".ichip").allInnerTexts(), labels = await qLabels(), why = await page.locator(".isec .why").first().innerText();
  await page.click('[data-next="3"]'); await sleep(600);
  const stillStep2 = await page.locator("#crName").count() === 0, pending = await page.locator(".opt.pend").count();
  assert(/Shopify/.test(chips.join()) && /no connector/.test(chips.join()) && labels.some((l) => /What should it work on/.test(l)) && /no Shopify connector/.test(why) && stillStep2 && pending === 1, JSON.stringify({ chips, labels, why, stillStep2, pending }));
  await shot("shopify-questions");
  return { chips, questions: labels };
});

await step("page: answering brings in what works today (a CSV in Files, marked “for Shopify”), the review says what's not possible, and Create lands on a first task", async () => {
  await page.click('[data-q="shopify.scope"][data-choice="catalog"]');
  await page.waitForSelector('.isec:has-text("Files in a folder")');
  const via = await page.locator('[data-q="shopify.scope"][data-choice="catalog"] .via').innerText();
  await page.click('[data-next="3"]'); await page.waitForSelector("#crName");
  const name = await page.inputValue("#crName"), not = await page.locator("#crNot").innerText(), caps = await page.locator("#crCaps").innerText();
  await shot("shopify-review");
  await page.click('[data-next="4"]'); await page.waitForSelector("#readyBox");
  const who = await page.textContent("#wkName"), firstTask = await page.locator('[data-gs="example"]').first().innerText();
  assert(via === "via Files in a folder" && name === "Shopify worker" && /Shopify Admin API/.test(not) && !/Builder|Figma/.test(caps) && who === "Shopify worker" && /Shopify store/.test(firstTask), JSON.stringify({ via, name, not, caps, who, firstTask }));
  await shot("shopify-created");
  return { name, notPossible: not.split("\n")[0], firstTask: firstTask.split("\n")[0] };
});

await step("page: Google Sheets shows no Builder.io or publishing setting; Next.js shows repository, editing, scripts and browser; Builder.io shows space, models and publishing", async () => {
  // The tools and questions shown (the Add menu lists every tool, so it isn't read).
  await describe("Update and organise our Google Sheets"); const sheets = [await page.locator(".ichips").innerText(), ...(await page.locator(".isec").allInnerTexts())].join(" | ");
  await cancel();
  await describe("Build features in my Next.js repository"); const next = await qLabels(), stack = await page.inputValue('[data-q="code.stack"]');
  await shot("nextjs-questions"); await cancel();
  await describe("Create and maintain landing pages in Builder.io"); const builder = await qLabels();
  await cancel();
  assert(!/Builder|publish/i.test(sheets) && /Google Sheets/.test(sheets), sheets.slice(0, 300));
  assert(["Framework and stack", "What may it do with the code?", "Run Node scripts, such as tests and builds", "Check the result in a browser"].every((l) => next.includes(l)) && stack === "Next.js" && !next.some((l) => /publish|Shopify/i.test(l)), JSON.stringify(next));
  assert(["Builder space", "Models and pages it works on", "What may it do with content?"].every((l) => builder.includes(l)) && !builder.some((l) => /scripts|code/i.test(l)), JSON.stringify(builder));
  return { nextjs: next, builder };
});

await step("page: a request with no connector (Gmail) can't go to review, and says why; a combination shows each of its tools", async () => {
  await describe("Answer customer emails in Gmail");
  await page.click('[data-next="3"]'); await sleep(500);
  const msg = await page.locator(".where").last().innerText(), stuck = await page.locator("#crName").count() === 0;
  await cancel();
  await describe("Research competitors, keep a research spreadsheet up to date and check their websites");
  const chips = await page.locator(".ichip").allInnerTexts();
  await cancel();
  assert(stuck && /Nothing here can be done with today's connectors/.test(msg), msg);
  assert(["Web research", "Files in a folder", "Websites in a browser"].every((x) => chips.some((c) => c.includes(x))), JSON.stringify(chips));
  return { gmail: msg, combination: chips.map((c) => c.split("\n")[0]) };
});

await step("page: tools can be removed and added; something unknown is named and marked as not connected; every setting is still one link away; leaving a typed request asks first", async () => {
  await describe("Build features in my Next.js repository");
  await page.selectOption("#crAdd", "figma"); await page.waitForSelector('.isec:has-text("Figma")');
  await page.click('[data-cr-rm="figma"]'); await page.waitForFunction(() => !document.querySelector('.isec b')?.textContent.includes("Figma") && ![...document.querySelectorAll(".isec b")].some((b) => b.textContent === "Figma"));
  await page.fill("#crOther", "Zendesk"); await page.click("#crOtherAdd"); await page.waitForSelector('.ichip:has-text("Zendesk")');
  const z = await page.locator('.ichip:has-text("Zendesk")').innerText();
  await page.click("#newTask"); await page.waitForSelector("#dlg[open]"); const asked = await page.locator("#dlgT").innerText(); await page.click('[data-dlg="discard"]');
  await page.click("#addWk"); await page.click("#wkBlank"); await page.waitForSelector("#wkForm"); await page.click("#wkCancel");
  assert(/no connector/.test(z) && /Unsaved/.test(asked), JSON.stringify({ z, asked }));
  return { other: z.replace(/\s+/g, " "), leaving: asked };
});

await b.close();
await mock.close();
writeFileSync(join(HERE, "create-results.json"), JSON.stringify({ when: new Date().toISOString(), results, pageErrors }, null, 1));
console.log(`\n${results.filter((x) => x.ok).length}/${results.length} passed; page errors: ${pageErrors.length ? pageErrors.join(" | ") : "none"}`);
