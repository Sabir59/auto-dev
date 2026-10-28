// The page for worker evolution: a proposal (made through the worker's evolve tools) shown in the
// worker's editor with its diff, state and checks; approving it (an unverified one needs the box
// ticked); the versions list; comparing and restoring. A console with its own data and a stand-in for
// Claude; no Builder account (so the proposal is blocked, which the page must say). No model.
//   node bench/evolution/ui-test.mjs
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", ".."), SHOTS = join(HERE, "shots"); mkdirSync(SHOTS, { recursive: true });
const { chromium } = createRequire(join(REPO, "browser-adapter", "package.json"))("playwright");
const PORT = process.env.PORT || "8769", ROOT = join(tmpdir(), `evo-ui-${Date.now()}`), DATA = join(ROOT, "data"); mkdirSync(DATA, { recursive: true });
const BASE = `http://127.0.0.1:${PORT}`, H = { origin: BASE, "x-worker-console": "1", "content-type": "application/json" };
const call = (m, p, b) => fetch(BASE + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const results = [];
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail).slice(0, 260)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 900)); }
};
const assert = (c, m) => { if (!c) throw new Error(typeof m === "string" ? m : JSON.stringify(m)); };

const env = { ...process.env, WORKER_CONSOLE_PORT: PORT, WORKER_CONSOLE_DATA: DATA, CLAUDE_BIN: process.execPath, CLAUDE_BIN_ARGS: JSON.stringify([join(REPO, "bench", "integrations", "fake-claude.mjs")]), FAKE_CLAUDE_OUT: join(ROOT, "fake"), FAKE_CLAUDE_REPLY: "1",
  BUILDER_ADAPTER_DIR: join(ROOT, "builder"), FIGMA_READER_DIR: join(ROOT, "figma"), GITHUB_CONNECTOR_DIR: join(ROOT, "github"), FIGMA_BRIDGE_PORT: "8768" };
let busy = false; try { await fetch(BASE + "/"); busy = true; } catch {}
if (busy) { console.log(`port ${PORT} is in use`); process.exit(1); }
const srv = spawn(process.execPath, [join(REPO, "worker-ui", "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; srv.stdout.on("data", (d) => (log += d)); srv.stderr.on("data", (d) => (log += d));
for (let i = 0; ; i++) { try { await fetch(BASE + "/"); break; } catch { if (i > 80 || srv.exitCode != null) throw new Error(`console didn't start: ${log.slice(-600)}`); await sleep(250); } }

const seed = JSON.parse(readFileSync(join(REPO, "workers", "builder-content-editor.json"), "utf8"));
const W = (await call("POST", "/workers", seed)).body;
// A proposal, the way the worker makes one: its run's evolve tools, with its run's token.
const run = (await call("POST", "/runs", { prompt: "hello", workspace: "scratch", worker: W.id })).body;
let mcp; for (let i = 0; i < 100 && !mcp; i++) { await sleep(100); const f = join(DATA, "runs", `${run.id}.mcp.json`); if (existsSync(f)) mcp = JSON.parse(readFileSync(f, "utf8")).mcpServers.evolve; }
const prop = await fetch(mcp.env.EVOLVE_URL + "/propose", { method: "POST", headers: { "x-aiw-evolve": mcp.env.EVOLVE_TOKEN, "content-type": "application/json" }, body: JSON.stringify({
  baseVersion: 1, title: "A/B variant drafts in our convention", reason: "The person described their A/B convention; there are no A/B steps today.",
  changes: { workflow: [...seed.workflow, "For an A/B variant: a separate DRAFT entry \"<control> | <experiment> | <letter>\" with abExperiment, abVariant, abControlId, abHypothesis."] },
  uses: ["builder.write.draft"], needs: [{ what: "Builder's own A/B traffic split", why: "The Builder tools can't write an entry's variations." }],
  checks: [{ type: "builder_entry", model: "page", name: "\\| EXP-1 \\| B$", expect: { count: 1, published: "draft", fields: { abExperiment: "^EXP-1$" } } }], trialPrompt: "Create variant B for EXP-1." }) }).then((r) => r.json());
await call("POST", `/runs/${run.id}/stop`, {}); for (let i = 0; i < 50; i++) { if (!(await call("GET", "/runs")).body.active) break; await sleep(100); }

const b = await chromium.launch(), page = await b.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(BASE + "/"); await page.waitForSelector("#wkList [data-wk]");
const open = async () => { await page.click(`[data-wk-edit="${W.id}"]`); await page.waitForSelector("#wkEvo .evcard, #wkEvo h4"); };

await step("the worker's editor shows the proposal: title, waiting, blocked (no Builder account here), what isn't possible, the diff, its checks and where it came from", async () => {
  assert(prop.id, prop);
  await open(); await page.waitForSelector("#wkEvo .evcard");
  const card = await page.locator("#wkEvo .evcard").first().innerText();
  const diff = await page.locator("#wkEvo .evcard .evdiff .a").allInnerTexts();
  assert(/A\/B variant drafts/.test(card) && /proposed/.test(card) && /Blocked/.test(card) && /Not connected/.test(card) && /traffic split/.test(card) && /\| EXP-1 \\\| B\$|EXP-1/.test(card) && diff.some((x) => x.startsWith("+ For an A/B variant")), { card: card.slice(0, 900), diff });
  await page.locator("#wkEvo").scrollIntoViewIfNeeded(); await page.screenshot({ path: join(SHOTS, "evolution-proposal.png"), fullPage: false });
  return { card: card.split("\n").slice(0, 4) };
});
await step("approving an unverified proposal: the Approve button stays disabled until you tick that you approve it anyway; then it's v2", async () => {
  await page.click(`[data-ev-approve="${prop.id}"]`); await page.waitForSelector("#dlg[open] #evAck");
  const before = await page.locator('#dlgA [data-dlg="go"]').isDisabled();
  await page.screenshot({ path: join(SHOTS, "evolution-approve.png") });
  await page.check("#evAck"); const after = await page.locator('#dlgA [data-dlg="go"]').isDisabled();
  await page.click('#dlgA [data-dlg="go"]'); await page.waitForFunction(() => /Approved: this is v2/.test(document.querySelector("#wkMsg")?.innerText || ""));
  const w = (await call("GET", "/workers")).body.workers.find((x) => x.id === W.id);
  assert(before && !after && w.version === 2 && w.workflow.some((s) => s.startsWith("For an A/B variant")), { before, after, version: w.version });
  return { disabledUntilTicked: true, version: 2 };
});
await step("the versions list: v2 current (approved proposal, not tested), v1 created; compare shows the step; restore v1 makes v3", async () => {
  await page.waitForSelector("#wkEvo > .evlist li");
  const list = await page.locator("#wkEvo > .evlist").innerText();
  assert(/v2[\s\S]*current[\s\S]*approved proposal \(blocked\)/.test(list) && /v1[\s\S]*created/.test(list), list);
  await page.click('[data-ev-cmp="1"]'); await page.waitForSelector("#dlg[open] .evdiff");
  const cmp = await page.locator("#dlg .evdiff").innerText(); await page.click('#dlgA [data-dlg="ok"]');
  assert(/\+ For an A\/B variant/.test(cmp), cmp);
  await page.click('[data-ev-restore="1"]'); await page.waitForSelector("#dlg[open] .evdiff"); await page.click('#dlgA [data-dlg="go"]');
  await page.waitForFunction(() => /Restored v1: this is v3/.test(document.querySelector("#wkMsg")?.innerText || ""));
  const w = (await call("GET", "/workers")).body.workers.find((x) => x.id === W.id);
  assert(w.version === 3 && !w.workflow.some((s) => s.startsWith("For an A/B variant")), w.workflow);
  await page.locator("#wkEvo").scrollIntoViewIfNeeded(); await page.screenshot({ path: join(SHOTS, "evolution-versions.png") });
  return { list: list.split("\n").slice(0, 6), now: 3 };
});
await step("no errors in the page", async () => { assert(!errors.length, errors); return { errors: 0 }; });

await b.close(); srv.kill();
writeFileSync(join(HERE, "ui-results.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
