// Integrations over a worker's life: recommendations (P4), pinned versions and upgrades (P5), and
// migrating workers made before integrations (P7), through the API and the page (P3). A console with
// its own data, a stand-in for Claude, and a COPY of the integration catalogue with three extra
// releases made here (released through release.mjs, as a reviewer would):
//   builder 1.1.0 — one more step; nothing else changes
//   builder 2.0.0 — "Read only" now also prepares drafts (more access); "models" replaced by "locale"
//   figma   1.1.0 — needs the web core capability too (more access)
//   node bench/integrations/lifecycle-test.mjs
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import http from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", "..");
const { chromium } = createRequire(join(REPO, "browser-adapter", "package.json"))("playwright");
const PORT = process.env.PORT || "8786", BRIDGE = "8776";
const ROOT = join(tmpdir(), `life-${Date.now()}`), DATA = join(ROOT, "data"), OUT = join(ROOT, "fake"), CAT = join(ROOT, "integrations"); mkdirSync(DATA, { recursive: true });
const BASE = `http://127.0.0.1:${PORT}`, H = { origin: BASE, "x-worker-console": "1", "content-type": "application/json" };
const call = (m, p, b) => fetch(BASE + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const results = [];
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail).slice(0, 240)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 1200)); }
};
const assert = (c, m) => { if (!c) throw new Error(typeof m === "string" ? m : JSON.stringify(m)); };

// ---- the catalogue copy, with three new releases ----
cpSync(join(REPO, "worker-ui", "integrations"), CAT, { recursive: true });
const mf = (id, v) => JSON.parse(readFileSync(join(CAT, id, `${v}.json`), "utf8")), put = (m) => writeFileSync(join(CAT, m.id, `${m.version}.json`), JSON.stringify(m, null, 2));
{ const m = mf("builder", "1.0.0"); m.version = "1.1.0"; m.instructions.steps = [...m.instructions.steps, "Check the page in each locale before saying it's done"]; m.changes = { "1.1.0": "One more step: check every locale." }; put(m); }
{ const m = mf("builder", "1.0.0"); m.version = "2.0.0"; m.changes = { "2.0.0": "Read-only workers also prepare drafts; “Models and pages” is replaced by “Locale”." };
  const pub = m.questions.find((q) => q.id === "publishing"); Object.assign(pub.choices.find((c) => c.id === "read"), { enables: ["builder.write.draft"], requires: [{ resource: "builder", access: "write", need: "required" }] });
  m.questions = m.questions.filter((q) => q.id !== "models"); m.questions.splice(1, 0, { id: "locale", type: "text", label: "Locale", knowledge: "Locale" });
  delete m.config.schema.properties.models; m.config.schema.properties.locale = { type: "string", maxLength: 300 }; put(m); }
{ const m = mf("figma", "1.0.0"); m.version = "1.1.0"; m.base.core = [...m.base.core, "web"]; m.coreWhy = { ...m.coreWhy, web: "Looks up design references on the web." }; m.changes = { "1.1.0": "Also looks up design references on the web." }; put(m); }
execFileSync(process.execPath, [join(REPO, "worker-ui", "integrations", "release.mjs"), "builder@1.1.0", "builder@2.0.0", "figma@1.1.0"], { env: { ...process.env, AIW_INTEGRATIONS_DIR: CAT } });

// ---- workers made before integrations (schema 1), as an earlier console saved them ----
const now = new Date().toISOString(), v1 = (o) => ({ repos: [], specialization: "", knowledge: "", workflow: [], limitations: [], requirements: [], onMissing: "", version: 3, createdAt: now, updatedAt: now, ...o });
const LEGACY = [
  v1({ id: "designer-aaaa", name: "Designer", mission: "Design screens", capabilities: ["files.read", "files.write", "shell", "web", "browser", "figma.read", "figma.plugin.read", "figma.plugin.edit"], requirements: [{ resource: "figma", access: "edit", need: "required" }, { resource: "figma", access: "read", need: "optional" }],
    workflow: ["Understand the brief", "Inspect the existing design (pages, styles, components) before changing anything", "Report"], limitations: ["Never delete or replace existing designs unless the task asks for it.", "Ask before publishing"] }),
  v1({ id: "builder-eng-bbbb", name: "Builder engineer", mission: "Build pages", capabilities: ["files.read", "browser", "builder.read", "builder.write", "builder.write.draft"], requirements: [{ resource: "builder", access: "read", need: "required" }, { resource: "builder", access: "write", need: "required" }] }),
  v1({ id: "bau-sync-cccc", name: "BAU branch sync worker", mission: "Keep our team's Git branches in sync", capabilities: ["files.read", "gitflow.read"],
    workflow: ["Understand the request and what done means; ask one precise question if something essential is missing", "Read the Git workflow configuration (gitflow_overview) before anything else"],
    knowledge: "Set up from this request: \"Keep our team's Git branches in sync\"\nTeam: BAU",
    fromRequest: { description: "Keep our team's Git branches in sync", integrations: ["gitsync"], answers: { gitsync: { team: "BAU", others: "", mappings: "", writes: "preview" } }, others: [], workspace: "project", unsupported: [], starters: ["Explain the changes"], at: now } }),
];
writeFileSync(join(DATA, "workers.json"), JSON.stringify(LEGACY, null, 1));
const bridge = http.createServer((q, s) => { s.writeHead(200, { "content-type": "application/json" }); s.end(JSON.stringify({ bridge: "figma-ai-executor", protocol: 2, pluginConnected: false, sessions: [] })); });
await new Promise((ok, no) => bridge.listen(Number(BRIDGE), "127.0.0.1", ok).on("error", no));
const srv = spawn(process.execPath, [join(REPO, "worker-ui", "server.mjs")], { env: { ...process.env, WORKER_CONSOLE_PORT: PORT, WORKER_CONSOLE_DATA: DATA, AIW_INTEGRATIONS_DIR: CAT, CLAUDE_BIN: process.execPath, CLAUDE_BIN_ARGS: JSON.stringify([join(HERE, "fake-claude.mjs")]), FAKE_CLAUDE_OUT: OUT,
  FIGMA_BRIDGE_PORT: BRIDGE, BUILDER_ADAPTER_DIR: join(DATA, "builder"), FIGMA_READER_DIR: join(DATA, "figma-reader"), GITHUB_CONNECTOR_DIR: join(DATA, "github") }, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; srv.stderr.on("data", (d) => (log += d));
for (let i = 0; ; i++) { try { await fetch(BASE + "/"); break; } catch { if (i > 80 || srv.exitCode != null) throw new Error(`console didn't start: ${log.slice(-800)}`); await sleep(250); } }
const dir = join(ROOT, "work"); mkdirSync(dir); execFileSync("git", ["init", "-q", dir]); writeFileSync(join(dir, "a.txt"), "a");
const WS = (await call("POST", "/workspaces", { name: "Work", path: dir, mode: "work" })).body.id;
const workers = async () => (await call("GET", `/workers?workspace=${WS}`)).body.workers;
// What a worker gets at launch, as sets (the order tools are listed in doesn't change access).
const planned = async (id) => {
  const p = (await call("GET", `/access/preview?worker=${id}&workspace=${WS}`)).body, a = p.planned.args, val = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : null; };
  const list = (f) => { const i = a.indexOf(f); if (i < 0) return []; const r = []; for (let k = i + 1; k < a.length && !a[k].startsWith("--"); k++) r.push(a[k]); return r; };
  return { tools: (val("--tools") || "").split(",").sort().join(), allowed: list("--allowedTools").sort(), restricted: a.includes("--restricted"), prompts: val("--permission-prompts"),
    servers: Object.fromEntries(Object.entries(p.planned.servers).sort(([x], [y]) => x.localeCompare(y)).map(([n, s]) => [n, Object.fromEntries(Object.entries(s.env || {}).filter(([k]) => /PROFILE|READ_ONLY/.test(k)))])) };
};
async function runOnce(worker) {
  const r = await call("POST", "/runs", { prompt: "hello", workspace: WS, worker }); assert(r.status === 200, r.body);
  for (let i = 0; i < 100; i++) { if ((await call("GET", "/runs")).body.active === r.body.id) break; await sleep(100); }
  await sleep(300); await call("POST", `/runs/${r.body.id}/stop`, {}); for (let i = 0; i < 50; i++) { if (!(await call("GET", "/runs")).body.active) break; await sleep(100); }
  return r.body.id;
}

// ---- P4: recommendations ----
await step("recommendations (deterministic): a Shopify worker gets Shopify, not Builder.io; Builder.io is optional, with its reason, only for a headless storefront's content; branch sync gets no CI unless the work mentions deploying; nothing is added or changed by recommending", async () => {
  const rec = async (text, current = []) => (await call("POST", "/integrations/recommend", { text, current })).body.items.map((i) => `${i.id}:${i.kind}`);
  const before = JSON.stringify(await workers());
  const shop = await rec("Manage products in my Shopify store"), headless = (await call("POST", "/integrations/recommend", { text: "Manage the headless storefront content for our Shopify store" })).body.items;
  const sync = await rec("Keep sabir-dev in sync with dev-main"), deploy = await rec("Sync our branches, then deploy after the CI pipeline passes");
  assert(shop.join() === "shopify:required" && headless.map((i) => `${i.id}:${i.kind}`).join() === "shopify:required,builder:optional" && /headless/.test(headless[1].reasons[0].text), { shop, headless });
  assert(sync.join() === "gitsync:required" && deploy.includes("code:optional") && JSON.stringify(await workers()) === before, { sync, deploy });
  return { shop, headless: headless.map((i) => `${i.id}:${i.kind} (${i.reasons.map((r) => r.text).join(" ")})`), deploy };
});

// ---- P5: pinned versions and upgrades ----
let PIN;
await step("pinned: a worker made with builder 1.0.0 keeps 1.0.0 although 1.1.0 and 2.0.0 are released; its tools and instructions are 1.0.0's", async () => {
  PIN = (await call("POST", "/workers", { schema: 2, name: "Pinned builder", mission: "Pages", integrations: [{ id: "builder", version: "1.0.0", config: { space: "Test", models: "page", publishing: "read", check: "no" } }], core: ["files.read"] })).body;
  const w = (await workers()).find((x) => x.id === PIN.id), steps = w.integrationInstructions[0].steps;
  assert(PIN.schema === 2 && w.integrations[0].version === "1.0.0" && w.capabilities.join() === "files.read,builder.read" && !steps.some((s) => /each locale/.test(s)) && w.resolution.integrations[0].upgrade === "2.0.0", { caps: w.capabilities, steps, res: w.resolution.integrations[0] });
  return { pinned: "builder 1.0.0", capabilities: w.capabilities, upgradeAvailable: w.resolution.integrations[0].upgrade };
});
await step("upgrade diff (builder 1.0.0 → 2.0.0): more access (drafts), a setting no longer used (models) and a new one (locale), its instructions; refused without approval (nothing changes), applied with it; a lower version is refused", async () => {
  const up = (await call("GET", `/workers/${PIN.id}/upgrades`)).body.upgrades[0];
  const refused = await call("POST", `/workers/${PIN.id}/upgrade`, { integration: "builder", to: "2.0.0" }), still = (await workers()).find((x) => x.id === PIN.id);
  const minor = await call("POST", `/workers/${PIN.id}/upgrade`, { integration: "builder", to: "1.1.0" }), afterMinor = (await workers()).find((x) => x.id === PIN.id);
  const major = await call("POST", `/workers/${PIN.id}/upgrade`, { integration: "builder", to: "2.0.0", approveExpansion: true }), afterMajor = (await workers()).find((x) => x.id === PIN.id);
  const down = await call("POST", `/workers/${PIN.id}/upgrade`, { integration: "builder", to: "1.0.0", approveExpansion: true });
  assert(up.to === "2.0.0" && up.expands && up.capabilities.added.join() === "builder.write.draft" && up.config.dropped.join() === "models" && up.config.defaulted.includes("locale") && up.accounts.added.includes("builder:write") && up.notes["2.0.0"], up);
  assert(refused.status === 400 && /Approve that/.test(refused.body.error) && still.version === PIN.version && still.integrations[0].version === "1.0.0", { refused: refused.body, still: still.integrations });
  assert(minor.status === 200 && afterMinor.integrations[0].version === "1.1.0" && afterMinor.capabilities.join() === "files.read,builder.read" && afterMinor.integrationInstructions[0].steps.some((s) => /each locale/.test(s)) && afterMinor.version === PIN.version + 1, afterMinor);
  assert(major.status === 200 && afterMajor.integrations[0].version === "2.0.0" && afterMajor.capabilities.includes("builder.write.draft") && !("models" in afterMajor.integrations[0].config) && "locale" in afterMajor.integrations[0].config && down.status === 400, { afterMajor: afterMajor.integrations, down: down.body });
  return { diff: { added: up.capabilities.added, dropped: up.config.dropped, defaulted: up.config.defaulted, accounts: up.accounts.added }, refused: refused.body.error.slice(0, 90) };
});
await step("an upgrade that needs another core tool (figma 1.1.0 needs web) is more access too: it lists the tool to grant, needs approval, and grants it only then", async () => {
  const w = (await call("POST", "/workers", { schema: 2, name: "Figma reader", mission: "Read designs", integrations: [{ id: "figma", version: "1.0.0", config: { file: "", edit: null, links: "yes" } }], core: ["files.read"] })).body;
  const up = (await call("GET", `/workers/${w.id}/upgrades`)).body.upgrades[0], no = await call("POST", `/workers/${w.id}/upgrade`, { integration: "figma", to: "1.1.0" });
  const yes = await call("POST", `/workers/${w.id}/upgrade`, { integration: "figma", to: "1.1.0", approveExpansion: true }), after = (await workers()).find((x) => x.id === w.id);
  assert(up.core.toGrant.join() === "web" && up.expands && no.status === 400 && yes.status === 200 && after.core.join() === "files.read,web" && after.capabilities.includes("web"), { up: up.core, after: after.core });
  return { toGrant: up.core.toGrant, coreAfter: after.core };
});

// ---- P7: migration ----
let BEFORE = {}, preRun;
await step("migration proposals: the worker made from a request maps exactly (its integrations and answers), the designer likely (one Figma setting gives its tools), the Builder engineer is ambiguous (publish and drafts-only contradict) with choices that say what each loses", async () => {
  for (const w of LEGACY) BEFORE[w.id] = await planned(w.id);
  preRun = await runOnce("designer-aaaa");
  const p = Object.fromEntries((await call("GET", "/migration")).body.workers.map((x) => [x.worker, x]));
  const d = p["designer-aaaa"], b = p["builder-eng-bbbb"], s = p["bau-sync-cccc"];
  assert(s.status === "exact" && s.integrations[0].id === "gitsync" && s.integrations[0].config.team === "BAU" && s.equal && s.own.moved.steps.includes("Read the Git workflow configuration (gitflow_overview) before anything else") && s.own.moved.knowledge.includes("Team: BAU"), s);
  assert(d.status === "likely" && d.equal && d.integrations[0].id === "figma" && d.integrations[0].config.edit === "edit" && d.integrations[0].config.links === "yes" && d.core.join() === "files.read,files.write,shell,web,browser" && d.own.moved.limits.length === 1 && d.own.limitations.join() === "Ask before publishing", d);
  assert(b.status === "ambiguous" && b.choices.length >= 2 && b.choices.every((c) => c.loses.length >= 1), b.choices.map((c) => c.gives));
  return { exact: s.integrations.map((i) => i.id), likely: d.integrations.map((i) => `${i.id} ${JSON.stringify(i.config)}`), ambiguous: b.choices.map((c) => `${c.gives.join("+")} (loses ${c.loses.join("+")})`) };
});
await step("migration is refused for an ambiguous worker without a choice, and for a choice that changes its tools until that change is accepted; nothing is written", async () => {
  const raw = readFileSync(join(DATA, "workers.json"), "utf8");
  const noChoice = await call("POST", "/migration/apply", { workers: [{ id: "builder-eng-bbbb" }] }), notAccepted = await call("POST", "/migration/apply", { workers: [{ id: "builder-eng-bbbb", choice: 0 }] });
  assert(noChoice.status === 400 && /choose one of its options/.test(noChoice.body.error) && notAccepted.status === 400 && /Accept that change/.test(notAccepted.body.error) && readFileSync(join(DATA, "workers.json"), "utf8") === raw, { noChoice: noChoice.body, notAccepted: notAccepted.body });
  return { refused: [noChoice.body.error.slice(0, 70), notAccepted.body.error.slice(0, 90)] };
});
let BACKUP;
await step("migrating the exact and likely ones: schema 2, pinned integrations, explicit core, their own text separated — and their access at launch is exactly what it was; a backup is kept; earlier runs still read", async () => {
  const r = await call("POST", "/migration/apply", { workers: [{ id: "designer-aaaa" }, { id: "bau-sync-cccc" }] }); BACKUP = r.body.backup;
  const ws = await workers(), d = ws.find((x) => x.id === "designer-aaaa"), s = ws.find((x) => x.id === "bau-sync-cccc");
  const same = JSON.stringify(await planned("designer-aaaa")) === JSON.stringify(BEFORE["designer-aaaa"]) && JSON.stringify(await planned("bau-sync-cccc")) === JSON.stringify(BEFORE["bau-sync-cccc"]);
  const run = await call("GET", `/runs/${preRun}`);
  assert(r.status === 200 && existsSync(join(DATA, "backups", BACKUP)) && d.schema === 2 && s.schema === 2 && d.migratedFrom.mapping === "likely" && s.migratedFrom.mapping === "exact" && d.version === 4, { d: d.migratedFrom, s: s.migratedFrom });
  assert(same && run.status === 200 && !s.workflow.includes("Read the Git workflow configuration (gitflow_overview) before anything else") && s.integrationInstructions[0].steps.includes("Read the Git workflow configuration (gitflow_overview) before anything else"), { same });
  return { migrated: r.body.migrated.map((m) => `${m.name} (${m.mapping})`), backup: BACKUP, accessUnchanged: same };
});
await step("after migration a run's context keeps the integration's instructions apart from the worker's own", async () => {
  const id = await runOnce("bau-sync-cccc"), ctx = readFileSync(join(DATA, "runs", `${id}.worker.md`), "utf8");
  assert(/## From the Git branch sync and promotion integration \(gitsync 1\.0\.0\)/.test(ctx) && /Read the Git workflow configuration/.test(ctx) && /Team: BAU/.test(ctx) && /## How you work\n1\. Understand the request/.test(ctx), ctx.slice(0, 600));
  return { section: "From the Git branch sync and promotion integration (gitsync 1.0.0)" };
});
await step("the ambiguous one, with a choice and its change accepted: it keeps what that choice gives and loses only what was shown; undo restores workers.json exactly as it was before", async () => {
  const p = (await call("GET", "/migration")).body.workers.find((x) => x.worker === "builder-eng-bbbb"), k = p.choices.findIndex((c) => c.gives.includes("builder.write.draft"));
  const r = await call("POST", "/migration/apply", { workers: [{ id: "builder-eng-bbbb", choice: k, acceptChanges: true }] });
  const w = (await workers()).find((x) => x.id === "builder-eng-bbbb");
  const pre = readFileSync(join(DATA, "backups", BACKUP), "utf8");
  const u1 = await call("POST", "/migration/undo", { backup: r.body.backup }), u2 = await call("POST", "/migration/undo", { backup: BACKUP });
  const restored = readFileSync(join(DATA, "workers.json"), "utf8"), all = await workers();
  assert(r.status === 200 && w.capabilities.includes("builder.write.draft") && !w.capabilities.includes("builder.write") && w.migratedFrom.changes.join() === "-builder.write", { caps: w.capabilities, m: w.migratedFrom });
  assert(u1.status === 200 && u2.status === 200 && restored === pre && all.every((x) => x.schema !== 2 || ["Pinned builder", "Figma reader"].includes(x.name)), { restoredEqual: restored === pre });
  return { chosen: p.choices[k].gives, lost: w.migratedFrom.changes, undone: [r.body.backup, BACKUP] };
});

// ---- P3: the page ----
const b = await chromium.launch(), page = await b.newPage({ viewport: { width: 1440, height: 950 } }), pageErrors = []; page.on("pageerror", (e) => pageErrors.push(e.message));
const SHOTS = join(HERE, "shots"); mkdirSync(SHOTS, { recursive: true });
await step("page: a worker made before integrations shows its tools as they are and leads to its migration; choosing an option and accepting its change migrates it; Undo puts it back", async () => {
  await page.goto(BASE + "/"); await page.waitForSelector('[data-wk-edit="builder-eng-bbbb"]');
  const side = await page.locator("#migWk").innerText();
  await page.click('[data-wk-edit="builder-eng-bbbb"]'); await page.waitForSelector("#wkLegacy");
  const legacyTools = await page.locator("#wkCaps [data-legacy-cap]").count();
  await page.click("#wkMigrate"); await page.waitForSelector('[data-mig="builder-eng-bbbb"]');
  const applyOff = await page.locator("#mgApply").isDisabled();
  await page.locator('[data-mig-choice="builder-eng-bbbb"]').first().check(); await page.waitForSelector('[data-mig-accept="builder-eng-bbbb"]');
  await page.screenshot({ path: join(SHOTS, "migration-review.png") });
  await page.check('[data-mig-accept="builder-eng-bbbb"]'); await page.click("#mgApply"); await page.waitForFunction(() => /Migrated 1 worker/.test(document.querySelector("#mgBody")?.innerText || ""));
  const migrated = (await workers()).find((x) => x.id === "builder-eng-bbbb").schema;
  await page.click("#mgUndo"); await page.waitForFunction(() => /Migration undone/.test(document.querySelector("#mgBody")?.innerText || ""));
  const undone = (await workers()).find((x) => x.id === "builder-eng-bbbb").schema;
  assert(/Review 3 older workers/.test(side) && legacyTools === 5 && !applyOff === false && migrated === 2 && undone !== 2, { side, legacyTools, applyOff, migrated, undone });
  return { sidebar: side, migratedThenUndone: [migrated, undone ?? 1] };
});
await step("page: the editor shows each integration's state (pinned version, configured, account missing) and an upgrade that asks for approval before giving more access", async () => {
  const w = (await call("POST", "/workers", { schema: 2, name: "Builder drafts", mission: "Pages", integrations: [{ id: "builder", version: "1.0.0", config: { space: "", models: "", publishing: "read", check: "no" } }], core: ["files.read"] })).body;
  await page.goto(BASE + "/"); await page.click(`[data-wk-edit="${w.id}"]`); await page.waitForSelector('#wkInts [data-int="builder"]'); await sleep(500);
  const card = (await page.locator('#wkInts [data-int="builder"]').innerText()).replace(/\s+/g, " ");
  await page.click('[data-wk-upgrade="builder"]'); await page.waitForSelector("#dlg[open] #upDiff");
  const dlg = await page.locator("#dlgB").innerText(), off = await page.locator('[data-dlg="go"]').isDisabled();
  await page.screenshot({ path: join(SHOTS, "upgrade-diff.png") });
  await page.check("#upApprove"); const on = !(await page.locator('[data-dlg="go"]').isDisabled()); await page.click('[data-dlg="go"]');
  await page.waitForFunction(() => /Upgraded Builder\.io to 2\.0\.0/.test(document.querySelector("#wkMsg")?.textContent || ""));
  const after = (await workers()).find((x) => x.id === w.id);
  assert(/v1\.0\.0/.test(card) && /configured/i.test(card) && /account missing/i.test(card) && /Upgrade to v2\.0\.0/.test(card), card);
  assert(/\+ Create and change Builder\.io content as drafts only/.test(dlg) && /no longer used: models/.test(dlg) && off && on && after.integrations[0].version === "2.0.0", { dlg: dlg.slice(0, 500), off, on });
  return { card: card.slice(0, 160), approvedUpgrade: after.integrations[0].version };
});
await step("page: the General worker's settings offer core capabilities only; turning one off narrows what it gets", async () => {
  await page.click("[data-wk-general]"); await page.waitForSelector("#gnCore");
  const offered = await page.locator("[data-gcore]").evaluateAll((xs) => xs.map((x) => x.dataset.gcore));
  await page.uncheck('[data-gcore="shell"]'); await page.click('#gnForm button[type="submit"]'); await page.waitForFunction(() => /Saved/.test(document.querySelector("#gnMsg")?.textContent || ""));
  const g = (await call("GET", "/general")).body, p = (await call("GET", `/access/preview?worker=general&workspace=${WS}`)).body;
  await call("PUT", "/general", { core: ["files.read", "files.write", "shell", "web", "browser"] });
  assert(offered.join() === "files.read,files.write,shell,web,browser" && !g.core.includes("shell") && !p.planned.args.some((a) => /Bash/.test(a)), { offered, core: g.core });
  return { offered, saved: g.core };
});
await step("page: creating a worker suggests what else belongs, with reasons (Builder.io for a headless Shopify storefront), and adds it only when asked", async () => {
  await page.click("#addWk"); await page.waitForSelector("#crDesc"); await page.fill("#crDesc", "Manage the headless storefront content for our Shopify store"); await page.click('[data-next="2"]');
  await page.waitForSelector('.irec [data-cr-addi="builder"]'); const before = await page.locator(".ichip").allInnerTexts(), rec = await page.locator(".irec").innerText();
  await page.screenshot({ path: join(SHOTS, "create-suggestions.png") });
  await page.click('.irec [data-cr-addi="builder"]'); await page.waitForSelector('.ichip:has-text("Builder.io")');
  const after = await page.locator(".ichip").allInnerTexts();
  assert(before.length === 1 && /Shopify/.test(before[0]) && /headless/.test(rec) && after.some((t) => /Builder\.io/.test(t)), { before, after, rec });
  await page.click("#crCancel").catch(() => {});
  return { suggested: rec.replace(/\s+/g, " ").slice(0, 160) };
});
await step("page: no script errors", async () => { assert(!pageErrors.length, pageErrors.join(" | ")); return { pageErrors: 0 }; });
await b.close(); srv.kill(); bridge.close();
writeFileSync(join(HERE, "lifecycle-results.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
