// The worker's home in a real browser: opening a worker, its tabs, the person's own edits, the
// context preview, the assistant pane (a real Claude Code runtime with a scripted model), undo,
// approvals, and starting a task from the home. Temp data and config; dummy content only.
//   node bench/studio/home-ui-test.mjs     (PLAYWRIGHT_BROWSERS_PATH if the browsers live elsewhere)
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { startStubModel, planLine } from "../integrations/stub-model.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", "..");
const { chromium } = createRequire(join(REPO, "browser-adapter", "package.json"))("playwright");
const PORT = process.env.PORT || "8776", SHOTS = join(HERE, "shots");
mkdirSync(SHOTS, { recursive: true });
const results = [];
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail ?? "").slice(0, 200)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 1200)); }
};
const assert = (c, m) => { if (!c) throw new Error(typeof m === "string" ? m : JSON.stringify(m)); };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const real = process.env.CLAUDE_BIN || (process.env.PATH || "").split(delimiter).map((d) => join(d, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")).find((f) => existsSync(f));
if (!real) { console.log("BLOCKED: no Claude Code binary found (set CLAUDE_BIN)"); process.exit(3); }

const ROOT = join(tmpdir(), `home-ui-${Date.now()}`), WS = join(ROOT, "ws"), DATA = join(ROOT, "data"), CFG = join(ROOT, "config"), EMPTY = join(ROOT, "none");
for (const d of [WS, DATA, CFG, EMPTY]) mkdirSync(d, { recursive: true });
writeFileSync(join(WS, "readme.md"), "# A project\n");
const stub = await startStubModel();
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC|AI_AGENT|AIW_|WORKER_CONSOLE_)/i.test(k))),
  CLAUDE_BIN: process.execPath, CLAUDE_BIN_ARGS: JSON.stringify([join(REPO, "bench", "integrations", "stub-claude.mjs")]), STUB_REAL_CLAUDE: real, STUB_MODEL_URL: stub.url,
  WORKER_CONSOLE_PORT: PORT, WORKER_CONSOLE_DATA: DATA, WORKER_CONSOLE_CLAUDE_CONFIG_DIR: CFG,
  BUILDER_ADAPTER_DIR: EMPTY, GITHUB_CONNECTOR_DIR: EMPTY, FIGMA_READER_DIR: EMPTY, FIGMA_BRIDGE_PORT: "8777", WORKER_CONSOLE_DEVCTL_PORT: "8778" };
const srv = spawn(process.execPath, [join(REPO, "worker-ui", "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; srv.stdout.on("data", (d) => (log += d)); srv.stderr.on("data", (d) => (log += d));
const BASE = `http://localhost:${PORT}`, H = { origin: BASE, "x-worker-console": "1", "content-type": "application/json" };
const call = (m, p, b) => fetch(BASE + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
for (let i = 0; ; i++) { try { await fetch(BASE + "/"); break; } catch { if (i > 80 || srv.exitCode != null) { console.log(`FAIL console didn't start: ${log.slice(-800)}`); process.exit(1); } await sleep(250); } }
const ws = (await call("POST", "/workspaces", { name: "Project", path: WS, mode: "work" })).body.id;
const w = (await call("POST", "/workers", { schema: 2, name: "Frontend Engineer", specialization: "React frontend for the donation site", mission: "Builds and maintains the donation site's frontend.", outcomes: ["Pages match the design system"],
  integrations: [], core: ["files.read", "files.write", "web"], workflow: ["Read the request", "Change the code", "Verify"], knowledge: "We use React 18 and Tailwind.", limitations: ["Never push to production branches"], onMissing: "Ask plainly.", extraRequirements: [], repos: [] })).body;
await call("POST", `/workers/${w.id}/edit`, { baseVersion: w.version, change: { knowledge: { add: [{ title: "Architecture", text: "Dumb features, smart domains. Cart writes go through useCart()." }] }, references: { add: [{ kind: "repository", title: "Site", value: "acme/site", branch: "dev" }] } } });
const stored = () => JSON.parse(readFileSync(join(DATA, "workers.json"), "utf8")).find((x) => x.id === w.id);

const browser = await chromium.launch(), ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } }), page = await ctx.newPage();
const pageErrors = []; page.on("pageerror", (e) => pageErrors.push(e.message));
await page.goto(BASE + "/"); await page.waitForSelector(`#wkList [data-wk="${w.id}"]`);
const shot = (n) => page.screenshot({ path: join(SHOTS, `${n}.png`) });

await step("clicking a worker opens its home: identity, purpose, at a glance, readiness, its assistant", async () => {
  await page.click(`#wkList [data-wk="${w.id}"]`); await page.waitForSelector("#whName");
  const t = await page.locator(".whome").innerText();
  assert(/Frontend Engineer/.test(t) && /Builds and maintains/.test(t) && /Pages match the design system/.test(t) && /At a glance/.test(t) && /Ready to work in/.test(t) && await page.locator("#whAssist #hmAIn").count() === 1, t.slice(0, 400));
  assert(await page.locator(".composer").isHidden(), "the task composer shows on the home");
  await shot("home-overview");
  return { tabs: await page.locator(".whtabs [role=tab]").allInnerTexts() };
});
await step("Overview: editing the purpose saves a new version", async () => {
  const v = stored().version;
  await page.click('[data-hm-edit="identity"]'); await page.fill('[data-hm-form="identity"] textarea[name="mission"]', "Builds, reviews and maintains the donation site's frontend.");
  await page.click('[data-hm-form="identity"] button[type="submit"]'); await page.waitForSelector("text=Builds, reviews and maintains");
  assert(stored().version === v + 1 && stored().mission.startsWith("Builds, reviews"), stored());
  return { version: stored().version };
});
await step("Knowledge & instructions: entries with their source, add one, remove one (confirmed), see what a task receives", async () => {
  await page.click('[data-hm-tab="context"]'); await page.waitForSelector("text=Knowledge entries");
  const t = await page.locator("#whPanel").innerText();
  assert(/Architecture/.test(t) && /acme\/site/.test(t) && /branch dev/.test(t) && /We use React 18/.test(t) && /Never push to production/.test(t), t.slice(0, 600));
  await page.click('[data-hm-add="knowledge"]');
  await page.fill('[data-hm-form="knowledge"] input[name="title"]', "Release rules"); await page.fill('[data-hm-form="knowledge"] textarea[name="text"]', "Releases go out on Tuesdays after QA sign-off.");
  await page.click('[data-hm-form="knowledge"] button[type="submit"]'); await page.waitForSelector("#whPanel >> text=Release rules");
  assert(stored().context.knowledge.some((k) => k.title === "Release rules" && k.source.kind === "owner"), stored().context);
  await page.click('[data-hm-rm="knowledge"][data-name="Release rules"]'); await page.click('#dlgA [data-dlg="rm"]');
  await page.waitForFunction(() => !document.querySelector("#whPanel")?.innerText.includes("Release rules"));
  assert(!stored().context.knowledge.some((k) => k.title === "Release rules"), "not removed");
  await page.click('[data-hm-act="preview"]'); await page.waitForSelector("#whPanel details.whitem");
  const secs = await page.locator("#whPanel details.whitem summary").allInnerTexts();
  assert(secs.some((s) => /Knowledge entries/.test(s) && /This worker's context/.test(s)) && secs.some((s) => /Platform/.test(s)), secs);
  await shot("home-context");
  return { sections: secs.length };
});
await step("Tools & access: the person's accounts kept apart from what this worker has", async () => {
  await page.click('[data-hm-tab="access"]'); await page.waitForSelector("text=Your accounts on this console");
  const t = await page.locator("#whPanel").innerText();
  assert(/Connecting an account doesn't give it to any worker/.test(t) && /Figma/.test(t) && /Builder\.io/.test(t) && /GitHub/.test(t) && /What Frontend Engineer has/.test(t) && /Read files in the workspace/.test(t) && /available here/.test(t) && /Boundaries/.test(t), t.slice(0, 800));
  assert(!/Shopify[^,]*connected/i.test(t), "an integration without a connector is shown as usable");
  await shot("home-access");
  return "ok";
});
await step("Assistant pane: a message runs a real assistant conversation; its change shows as a card with Undo; the home refreshes", async () => {
  await page.click('[data-hm-tab="overview"]');
  const v = stored().version;
  const line = planLine([{ name: "ToolSearch", input: { query: "select:mcp__assistant__worker_inspect,mcp__assistant__worker_change", max_results: 5 } }, { name: "mcp__assistant__worker_inspect", input: {} },
    { name: "mcp__assistant__worker_change", input: { baseVersion: v, summary: "Add a deployment skill", change: { skills: { add: [{ name: "Deploy to staging", description: "When asked to deploy", instructions: "1. Build\n2. Deploy\n3. Report the URL" }] } } } },
    { name: "mcp__assistant__worker_change", input: { baseVersion: v + 1, summary: "Remove the architecture entry", change: { knowledge: { remove: [stored().context.knowledge[0].id] } } } }]);
  await page.fill("#hmAIn", `${line}\nCreate a skill for our deployment process.`); await page.click('#hmAForm button[type="submit"]');
  await page.waitForSelector("#whAssist .am-c", { timeout: 240000 }); await page.waitForSelector("#whAssist .am-c.wait", { timeout: 120000 });
  await page.waitForFunction(() => !/Working…/.test(document.querySelector("#whAssist .ah")?.innerText || ""), null, { timeout: 120000 });
  const t = await page.locator("#whAssist").innerText();
  assert(/Read its configuration/.test(t) && /Submitted a change/.test(t) && /Changed Frontend Engineer: now version/.test(t) && /Waiting for your approval/.test(t) && /Undo \(restore v/.test(t), t.slice(0, 900));
  assert(stored().context.skills.some((s) => s.name === "Deploy to staging"), stored().context);
  await page.waitForSelector('.whtabs [data-hm-tab="history"] .n');
  await shot("home-assistant");
  return { version: stored().version };
});
await step("History: the pending change can be approved; versions list who changed what; Undo restores the version before the skill", async () => {
  await page.click('.whtabs [data-hm-tab="history"]'); await page.waitForSelector("text=Waiting for your approval");
  const t = await page.locator("#whPanel").innerText();
  assert(/Remove the architecture entry/.test(t) && /Changed by its assistant/.test(t) && /Changed by you/.test(t), t.slice(0, 700));
  await shot("home-history");
  await page.click('[data-hm-change="approve"]'); await page.waitForFunction(() => !document.querySelector('[data-hm-change="approve"]'));
  assert(!stored().context.knowledge.some((k) => k.title === "Architecture"), "approve didn't apply");
  const before = stored().version;
  await page.click('#whAssist [data-hm-undo]');
  await page.waitForFunction((v) => fetch("/workers").then((r) => r.json()).then((j) => j.workers.some((x) => x.version > v)), before);
  await sleep(500);
  assert(!stored().context?.skills?.some((s) => s.name === "Deploy to staging") && stored().context.knowledge.some((k) => k.title === "Architecture"), stored().context);
  return { version: stored().version };
});
await step("Activity lists the assistant conversation; New task opens the composer with this worker chosen", async () => {
  await page.click('.whtabs [data-hm-tab="activity"]'); await page.waitForSelector("#whPanel [data-hm-asst]");
  await page.click("#whNewTask"); await page.waitForSelector(".composer", { state: "visible" });
  const who = await page.locator("#wkName").innerText();
  assert(who.includes("Frontend Engineer"), who);
  return { composer: who };
});
await step("no page errors", async () => { assert(!pageErrors.length, pageErrors); return "none"; });

await page.setViewportSize({ width: 1000, height: 900 }); await page.click(`#wkList [data-wk="${w.id}"]`).catch(() => {}); await page.waitForSelector("#whName").catch(() => {}); await shot("home-narrow");
await browser.close(); srv.kill(); stub.close();
const passed = results.filter((r) => r.ok).length;
writeFileSync(join(HERE, "home-ui-results.json"), JSON.stringify({ ran: new Date().toISOString(), passed, total: results.length, steps: results }, null, 1));
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
