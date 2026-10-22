// Worker templates and their setup (the shared definitions in workers/*.json with a template block),
// through the console's API and the page:
//  - each template offers only its own settings (a Builder editor has Publishing, a frontend
//    engineer has Run scripts), and the page shows only those;
//  - a choice maps to capabilities from the fixed catalogue and nothing else: unknown settings and
//    choices are refused, capabilities sent alongside are ignored;
//  - a choice isn't authorization: "May publish" is still cut by an Inspect workspace, its
//    requirement still says Not connected / production refused, and the run's adapter profile is
//    decided by the console (read in Inspect, draft or full in Work);
//  - the first-run guide, the catalogue, setup, the new-task readiness and the full definition.
// Runs are started only to read what the console generated for them (MCP config), then stopped:
// no model call is needed. Builder's API is the local mock.
//   CANARY=<inspect folder> WORK=<work folder> DATA=<console data dir> BUILDER_DIR=<console's BUILDER_ADAPTER_DIR>
//   node bench/workspace-ui/templates-test.mjs <port>     (run-suite.sh templates)
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
const until = async (fn, ms = 60000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("timeout"); await sleep(300); } };
const creds = (c) => { mkdirSync(BDIR, { recursive: true }); if (c) writeFileSync(join(BDIR, "credentials.json"), JSON.stringify(c)); else rmSync(join(BDIR, "credentials.json"), { force: true }); };
// What the console generated for a run of this worker here: its MCP servers. The run is stopped at once.
async function mcpFor(worker, workspace) {
  const r = (await call("POST", "/runs", { prompt: "Reply with exactly: OK", workspace, worker })).body;
  assert(r?.id, `run not started: ${JSON.stringify(r)}`);
  const f = join(DATA, "runs", `${r.id}.mcp.json`);
  await until(() => existsSync(f), 20000);
  await call("POST", `/runs/${r.id}/stop`);
  await until(async () => !(await call("GET", "/runs")).body.active, 30000);
  return JSON.parse(readFileSync(f, "utf8")).mcpServers;
}
const tpls = async (ws) => (await call("GET", `/templates?workspace=${ws}`)).body.templates;
const add = async (id, choices, extra = {}) => call("POST", `/templates/${id}/workers`, { choices, ...extra });

const mock = await startMock({ port: 8789 }); // the console's BUILDER_*_BASE point here (run-suite.sh)
creds(null);
const canary = (await call("POST", "/workspaces", { name: "Canary", path: process.env.CANARY, mode: "inspect" })).body;
const work = (await call("POST", "/workspaces", { name: "Work test", path: process.env.WORK, mode: "work" })).body;

await step("the catalogue: every template's settings name only real capabilities and requirements; each worker has only its own settings", async () => {
  const list = await tpls(work.id), caps = new Set((await call("GET", "/workers")).body.capabilities.map((c) => c.id));
  const by = Object.fromEntries(list.map((t) => [t.id, t.options.map((o) => o.id)]));
  for (const t of list) for (const o of t.options) for (const c of o.choices) for (const x of c.capabilities) assert(caps.has(x), `${t.id}.${o.id}.${c.id}: ${x}`);
  assert(by["frontend-engineer"].join() === "commands,browser", JSON.stringify(by));
  assert(by["builder-content-editor"].join() === "publishing,browser", JSON.stringify(by));
  assert(!by["frontend-engineer"].includes("publishing") && !by["builder-content-editor"].includes("commands"), "irrelevant settings leaked");
  return { templates: list.length, settings: by };
});

await step("refused: an unknown choice, an unknown setting, an unknown template; capabilities sent alongside are ignored", async () => {
  const badChoice = await add("builder-content-editor", { publishing: "everything" });
  const badSetting = await add("builder-content-editor", { commands: "on" });
  const noTpl = await call("POST", "/templates/nope/workers", {});
  const smuggled = (await add("builder-content-editor", { publishing: "read", browser: "off" }, { capabilities: ["shell", "files.write", "builder.write"] })).body;
  assert(badChoice.status === 400 && badSetting.status === 400 && noTpl.status === 404, JSON.stringify([badChoice, badSetting, noTpl]));
  assert(smuggled.capabilities.join() === "builder.read", smuggled.capabilities.join());
  await call("DELETE", `/workers/${smuggled.id}`);
  return { badChoice: badChoice.body.error, badSetting: badSetting.body.error, smuggled: smuggled.capabilities };
});

let pub, drafts, look;
await step("choices become the definition: publish → builder.write, drafts → builder.write.draft, read only → neither; browser off → no browser", async () => {
  pub = (await add("builder-content-editor", { publishing: "publish" }, { name: "Publisher" })).body;
  drafts = (await add("builder-content-editor", {}, { name: "Drafter" })).body;
  const ro = (await add("builder-content-editor", { publishing: "read", browser: "off" })).body;
  assert(pub.capabilities.includes("builder.write") && !pub.capabilities.includes("builder.write.draft"), pub.capabilities.join());
  assert(drafts.capabilities.includes("builder.write.draft") && !drafts.capabilities.includes("builder.write"), drafts.capabilities.join());
  assert(ro.capabilities.join() === "builder.read" && !ro.requirements.some((r) => r.access === "write"), JSON.stringify(ro));
  assert(pub.fromTemplate.id === "builder-content-editor" && pub.fromTemplate.choices.publishing === "publish", JSON.stringify(pub.fromTemplate));
  await call("DELETE", `/workers/${ro.id}`);
  return { publish: pub.capabilities, drafts: drafts.capabilities, readOnly: ro.capabilities };
});

await step("\"May publish\" is not authorization: an Inspect workspace cuts the write tools; the requirement stays unmet without keys, and a production space is refused", async () => {
  const pv = (await call("POST", "/templates/builder-content-editor/preview", { choices: { publishing: "publish" }, workspace: canary.id })).body;
  assert(!pv.usable.includes("builder.write") && pv.blocked.includes("builder.write"), JSON.stringify(pv));
  const st = async () => (await call("GET", `/workers?workspace=${work.id}`)).body.workers.find((w) => w.id === pub.id).status.map((s) => `${s.access}:${s.state}`).join();
  const none = await st();
  creds({ label: "Prod", environment: "production", publicKey: KEYS.public, privateKey: KEYS.private });
  const prod = await st();
  creds({ label: "Test", environment: "test", publicKey: KEYS.public, privateKey: KEYS.private });
  const test = await st();
  assert(none === "read:Not connected,write:Not connected", none);
  assert(prod === "read:Connected,write:Production space: writes refused", prod);
  assert(test === "read:Connected,write:Test space", test);
  return { inspect: { usable: pv.usable, blocked: pv.blocked }, noKeys: none, production: prod, testSpace: test };
});

await step("at run time the console decides the adapter's profile: publish in Inspect → read; drafts in Work → draft; publish in Work → full", async () => {
  const inspect = (await mcpFor(pub.id, canary.id)).builder?.env?.BUILDER_ADAPTER_PROFILE;
  const draft = (await mcpFor(drafts.id, work.id)).builder?.env?.BUILDER_ADAPTER_PROFILE;
  const full = (await mcpFor(pub.id, work.id)).builder?.env?.BUILDER_ADAPTER_PROFILE;
  assert(inspect === "read" && draft === "draft" && full === "full", JSON.stringify({ inspect, draft, full }));
  return { inspect, draft, full };
});

await step("Figma \"Only look\": no edit capability, and the run gets the read-only Executor", async () => {
  look = (await add("senior-uiux-design-engineer", { figma: "look", links: "off" }, { name: "Design reviewer" })).body;
  assert(look.capabilities.includes("figma.plugin.read") && !look.capabilities.includes("figma.plugin.edit") && !look.requirements.some((r) => r.resource === "figma"), JSON.stringify(look));
  const env = (await mcpFor(look.id, "scratch"))["figma-executor"]?.env;
  assert(env?.FIGMA_EXECUTOR_PROFILE === "read", JSON.stringify(env));
  return { capabilities: look.capabilities, executor: env.FIGMA_EXECUTOR_PROFILE };
});

await step("changing a setup: a new version with the new capabilities; edits made in the full definition are kept, and so is the template link", async () => {
  const w0 = (await call("GET", "/workers")).body.workers.find((w) => w.id === pub.id);
  const edited = (await call("PUT", `/workers/${pub.id}`, { ...w0, knowledge: "Our space is called Winter." })).body;
  assert(edited.fromTemplate?.id === "builder-content-editor", "the full editor dropped the template link");
  const w = (await call("PUT", `/workers/${pub.id}/setup`, { choices: { publishing: "drafts" } })).body;
  assert(w.version === edited.version + 1 && w.capabilities.includes("builder.write.draft") && !w.capabilities.includes("builder.write"), JSON.stringify(w));
  assert(w.knowledge === "Our space is called Winter." && w.fromTemplate.choices.publishing === "drafts", JSON.stringify(w));
  const plain = (await call("POST", "/workers", { name: "Plain", capabilities: ["files.read"] })).body;
  const refused = await call("PUT", `/workers/${plain.id}/setup`, { template: "builder-content-editor", choices: { publishing: "publish" } });
  assert(refused.status === 400, JSON.stringify(refused));
  await call("DELETE", `/workers/${plain.id}`);
  return { versions: [w0.version, edited.version, w.version], capabilities: w.capabilities, notFromTemplate: refused.body.error };
});
creds(null);
for (const w of [pub, drafts, look]) if (w) await call("DELETE", `/workers/${w.id}`);

// ---- the page ----
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
const pageErrors = []; page.on("pageerror", (e) => pageErrors.push(e.message));
// Cancel on a changed setup asks first (the dialog opens on the next tick): discard.
const cancelSetup = async () => { await page.click("#setCancel"); try { await page.waitForSelector("#dlg[open]", { timeout: 1500 }); await page.click('[data-dlg="discard"]'); } catch {} };
const shot = (n) => page.screenshot({ path: join(HERE, "shots", `templates-${n}.png`) });
await page.goto(BASE, { waitUntil: "networkidle" });
await page.click(`#wsList [data-ws="${work.id}"]`);

await step("first run: the guide explains Worker, Workspace and Team and lists the specialists with their real readiness", async () => {
  await page.waitForSelector("#gsGuide .tcard");
  const concepts = await page.locator("#gsGuide .concept b").allInnerTexts();
  const cards = await page.locator("#gsGuide .tcard b").allInnerTexts();
  const builderReady = await page.locator('#gsGuide .tcard:has-text("Builder.io Content Editor") .ready').innerText();
  assert(concepts.join() === "Worker,Workspace,Team" && cards.length === 5 && /Needs: Builder.io/.test(builderReady), JSON.stringify({ concepts, cards, builderReady }));
  await shot("guide");
  return { concepts, cards, builderReady };
});

await step("setup pages show only their worker's settings: Frontend has Run scripts, not Publishing; Builder the reverse", async () => {
  await page.click("#addWk"); await page.waitForSelector("#tplList .tcard");
  await page.click('[data-tpl-setup="frontend-engineer"]'); await page.waitForSelector("#setupForm");
  const fe = await page.locator("#setupForm .opt > span:first-child").allInnerTexts();
  await page.click("#setCancel");
  await page.click("#addWk"); await page.click('[data-tpl-setup="builder-content-editor"]'); await page.waitForSelector("#setupForm");
  const bu = await page.locator("#setupForm .opt > span:first-child").allInnerTexts();
  assert(fe.join() === "Run scripts,Check its work in a browser" && bu.join() === "Publishing,Check the page on the site", JSON.stringify({ fe, bu }));
  return { frontend: fe, builder: bu };
});

await step("a choice updates what the console says it can do; in an Inspect workspace publishing shows as not available", async () => {
  await page.click('[data-opt="publishing"][data-choice="publish"]');
  await page.waitForFunction(() => /Create, change and publish/.test(document.querySelector("#setCaps").innerText) && !/drafts only/.test(document.querySelector("#setCaps").innerText));
  const work1 = await page.locator("#setCaps").innerText();
  await cancelSetup();
  await page.click(`#wsList [data-ws="${canary.id}"]`);
  await page.click("#addWk"); await page.click('[data-tpl-setup="builder-content-editor"]'); await page.waitForSelector("#setupForm");
  await page.click('[data-opt="publishing"][data-choice="publish"]');
  await page.waitForFunction(() => /not in Inspect/.test(document.querySelector("#setCaps").innerText));
  const insp = await page.locator("#setCaps .cchip.off").allInnerTexts();
  await shot("setup-inspect");
  assert(insp.some((x) => /Create, change and publish/.test(x)), JSON.stringify(insp));
  await cancelSetup();
  await page.click(`#wsList [data-ws="${work.id}"]`);
  return { work: work1.replace(/\n/g, " | "), inspectOff: insp };
});

await step("adding a worker lands on its new task: readiness, example tasks, and the composer set to it", async () => {
  await page.click("#addWk"); await page.click('[data-tpl-setup="qa-engineer"]'); await page.waitForSelector("#setupForm");
  await page.click('[data-opt="commands"][data-choice="off"]');
  await page.click("#setSave");
  await page.waitForSelector("#readyBox");
  const who = await page.locator("#wkName").innerText(), h1 = await page.locator(".emptyst h1").innerText();
  const ex = await page.locator('[data-gs="example"]').count();
  await page.locator('[data-gs="example"]').first().click();
  const typed = await page.inputValue("#input");
  const def = (await call("GET", "/workers")).body.workers.find((w) => w.name === "QA Engineer");
  assert(who === "QA Engineer" && h1 === "QA Engineer" && ex === 3 && typed.length > 10 && !def.capabilities.includes("shell"), JSON.stringify({ who, h1, ex, typed, caps: def.capabilities }));
  await shot("new-task");
  await page.fill("#input", "");
  return { composer: who, examples: ex, capabilities: def.capabilities };
});

await step("its pencil opens the short setup; Full definition opens every setting; Define from scratch opens the blank form", async () => {
  await page.hover('#wkList .wsi:has-text("QA Engineer")'); await page.click('#wkList .wsi:has-text("QA Engineer") [data-wk-edit]');
  await page.waitForSelector("#setupForm");
  const checked = await page.locator('[data-opt="commands"][aria-checked="true"]').innerText();
  await page.click("#setAdv"); await page.waitForSelector("#wkForm");
  const name = await page.inputValue("#wkN");
  await page.click("#wkCancel");
  await page.click("#addWk"); await page.click("#wkBlank"); await page.waitForSelector("#wkForm");
  const blank = await page.inputValue("#wkN");
  await page.click("#wkCancel");
  assert(checked === "Not allowed" && name === "QA Engineer" && blank === "", JSON.stringify({ checked, name, blank }));
  return { setupShows: checked, fullDefinition: name };
});

await step("an unsaved setup change asks before leaving", async () => {
  await page.click('#wkList .wsi:has-text("QA Engineer") [data-wk-edit]'); await page.waitForSelector("#setupForm");
  await page.click('[data-opt="browser"][data-choice="off"]');
  await page.click("#newTask");
  await page.waitForSelector("#dlg[open]");
  const title = await page.locator("#dlgT").innerText();
  await page.click('[data-dlg="discard"]');
  assert(/Unsaved/.test(title), title);
  return { asked: title };
});

await b.close();
await mock.close();
writeFileSync(join(HERE, "templates-results.json"), JSON.stringify({ when: new Date().toISOString(), results, pageErrors }, null, 1));
console.log(`\n${results.filter((x) => x.ok).length}/${results.length} passed; page errors: ${pageErrors.length ? pageErrors.join(" | ") : "none"}`);
