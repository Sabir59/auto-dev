// The Git workflow's read-only switch and test-environment label, end to end. Starts its own two
// consoles (their own data folders, a disposable fixture repository, ports 8791 and 8792 by default):
//  - GITFLOW_READ_ONLY=1 (+ GITFLOW_ENV_LABEL): every route that could write to a repository or a
//    remote is refused (403) and nothing moves; reading and simulating still work; the page says so on
//    every screen and turns the write buttons off;
//  - a normal console: no banner, and the same buttons work as before.
//   node bench/workspace-ui/gitflow-safety-test.mjs [roPort] [normalPort]
// Prints PASS/FAIL lines; the evidence is written to <temp>/gitflow-safety-<time>/results.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { buildFixture, fixtureConfig } from "../gitflow/fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", "..");
const { chromium } = createRequire(join(REPO, "browser-adapter", "package.json"))("playwright");
const [roPort = "8792", okPort = "8791"] = process.argv.slice(2);
const ROOT = join(tmpdir(), `gitflow-safety-${Date.now()}`); mkdirSync(ROOT, { recursive: true });
const results = [], procs = [];
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail).slice(0, 220)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 400)); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const refsOf = (repo) => execFileSync("git", ["for-each-ref", "--format=%(refname) %(objectname)"], { cwd: repo, encoding: "utf8" });

// A console with its own data and a fixture repository, set up with the BAU worker.
async function consoleWith(port, env, name) {
  const DATA = join(ROOT, name), BASE = `http://127.0.0.1:${port}`, H = { origin: BASE, "x-worker-console": "1", "content-type": "application/json" };
  try { await fetch(BASE + "/"); throw new Error(`port ${port} is in use: stop that process first`); } catch (e) { if (/in use/.test(e.message)) throw e; }
  const p = spawn(process.execPath, [join(REPO, "worker-ui", "server.mjs")], { env: { ...process.env, WORKER_CONSOLE_PORT: port, WORKER_CONSOLE_DATA: DATA, BUILDER_ADAPTER_DIR: join(DATA, "builder"), FIGMA_READER_DIR: join(DATA, "figma-reader"), GITHUB_CONNECTOR_DIR: join(DATA, "github"), ...env }, stdio: "ignore" });
  procs.push(p);
  for (let i = 0; ; i++) { try { await fetch(BASE + "/"); break; } catch { if (i > 80) throw new Error("console didn't start"); await new Promise((ok) => setTimeout(ok, 250)); } }
  const call = (m, path, b) => fetch(BASE + path, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const fx = buildFixture(join(DATA, "fixture"));
  execFileSync("git", ["config", "user.name", "Test Approver"], { cwd: fx.repo }); execFileSync("git", ["config", "user.email", "approver@test.invalid"], { cwd: fx.repo });
  const ws = (await call("POST", "/workspaces", { name: "TEST fixture", path: fx.repo, mode: "inspect" })).body;
  const W = (await call("POST", "/workers/from-request", { description: "Keep sabir-dev in sync with dev-main and sabir-uat with uat-main, and promote our UAT changes to preprod-main", answers: { gitsync: { team: "BAU", others: "Innovax", writes: "propose" } }, workspace: ws.id })).body;
  await call("PUT", `/gitflow/${W.id}/config`, { ...fixtureConfig(ws.id), teams: [{ id: "bau", name: "BAU", ours: true, branchPatterns: ["bau/*", "sabir-*"] }, { id: "innovax", name: "Innovax", ours: false, branchPatterns: ["innovax/*"] }] });
  return { BASE, W, fx, gf: (m, path, b) => call(m, `/gitflow/${W.id}${path}`, b) };
}

const LABEL = "Safety test: disposable fixture repository, not MATW";
const ro = await consoleWith(roPort, { GITFLOW_READ_ONLY: "1", GITFLOW_ENV_LABEL: LABEL }, "read-only");
const ok = await consoleWith(okPort, {}, "normal");
const S = ro.fx.shas;

await step("read-only console: the configuration says so (and names the test environment); reading, analysing, previewing and exporting a patch still work", async () => {
  const c = (await ro.gf("GET", "/config")).body, a = await ro.gf("GET", "/analysis?mapping=dev-main-to-sabir-dev"), p = await ro.gf("POST", "/preview", { mapping: "dev-main-to-sabir-dev", strategy: "selective", select: [S.S1] });
  const patch = await fetch(`${ro.BASE}/gitflow/${ro.W.id}/patch?plan=${p.body.id}`, { headers: { "x-worker-console": "1" } });
  assert(c.env?.readOnly === true && c.env.label === LABEL && a.status === 200 && p.status === 200 && p.body.status === "ready" && patch.status === 200, JSON.stringify({ env: c.env, a: a.status, p: p.status, patch: patch.status }));
  return { env: c.env, plan: p.body.status, patch: patch.status };
});

await step("read-only console: creating a branch (directly or as a job), pushing / opening a pull request, deleting a branch, fetching and job controls are refused with 403, and no ref moves in the repository or its origin", async () => {
  const before = refsOf(ro.fx.repo), originBefore = refsOf(ro.fx.origin);
  const p = (await ro.gf("POST", "/preview", { mapping: "dev-main-to-sabir-dev", strategy: "selective", select: [S.S1] })).body;
  const tries = {
    execute: await ro.gf("POST", "/execute", { plan: p.id }), job: await ro.gf("POST", "/execute", { plan: p.id, async: true }),
    pr: await ro.gf("POST", "/pr", { branch: "gitflow/sabir-dev-20260101-000000" }), del: await ro.gf("POST", "/branch/delete", { branch: "gitflow/sabir-dev-20260101-000000" }),
    fetch: await ro.gf("POST", "/fetch"), cancel: await ro.gf("POST", "/jobs/x/cancel"),
  };
  const audit = (await ro.gf("GET", "/audit")).body.audit;
  assert(Object.values(tries).every((r) => r.status === 403 && r.body.readOnly === true), JSON.stringify(Object.fromEntries(Object.entries(tries).map(([k, v]) => [k, v.status]))));
  assert(refsOf(ro.fx.repo) === before && refsOf(ro.fx.origin) === originBefore && !audit.some((e) => ["execute", "pr", "fetch", "delete"].includes(e.action)), "a ref moved or a write was audited");
  return { refused: Object.keys(tries), message: tries.execute.body.error };
});

const b = await chromium.launch(), pageErrors = [];
const open = async (con, w = 1440) => { const page = await b.newPage({ viewport: { width: w, height: 900 } }); page.on("pageerror", (e) => pageErrors.push(e.message)); await page.goto(`${con.BASE}/?worker=${con.W.id}&view=gitflow&full=1`); await page.waitForSelector(".gfkpis"); return page; };
const toReadyPlan = async (page) => {
  await page.click('[data-gf-tab="changes"]'); await page.waitForSelector(`[data-gf-sel="${S.S1}"]`);
  await page.check(`[data-gf-sel="${S.S1}"]`); await page.click("#gfToPlan"); await page.waitForFunction(() => /^Ready/m.test(document.querySelector(".gfstatus")?.innerText || ""));
};

await step("read-only console, page: the banner says 'Read-only console' with the label on every tab; Create proposal branch, Fetch now (bar and Settings) are turned off and say why", async () => {
  const page = await open(ro), banners = {};
  for (const t of ["overview", "changes", "history", "settings"]) { await page.click(`[data-gf-tab="${t}"]`); await page.waitForTimeout(300); banners[t] = await page.locator("#gfEnv").innerText().catch(() => ""); }
  const fetchSettings = await page.locator("#gfFetch").evaluate((x) => ({ off: x.disabled, why: x.title })).catch(() => null);
  await toReadyPlan(page);
  const approve = await page.locator("#gfApprove").evaluate((x) => ({ off: x.disabled, why: x.title })), fetchBar = await page.locator("#gfFetchNow").evaluate((x) => ({ off: x.disabled, why: x.title }));
  await page.screenshot({ path: join(ROOT, "read-only-plan.png") });
  await page.close();
  assert(Object.values(banners).every((t) => /Read-only console/.test(t) && t.includes(LABEL) && /turned off here/.test(t)), JSON.stringify(banners));
  assert(approve.off && /Read-only console/.test(approve.why) && fetchBar.off && (!fetchSettings || fetchSettings.off), JSON.stringify({ approve, fetchBar, fetchSettings }));
  return { banner: banners.overview.split("\n")[0], approve, fetchBar };
});

await step("normal console (no switch): no banner; Create proposal branch works from the page and makes a new branch in its own fixture", async () => {
  const page = await open(ok), banner = await page.locator("#gfEnv").count();
  await toReadyPlan(page);
  const off = await page.locator("#gfApprove").isDisabled();
  await page.click("#gfApprove"); await page.waitForSelector("#dlg[open]"); await page.click('[data-dlg="go"]');
  await page.waitForFunction(() => /Branch created: gitflow\//.test(document.querySelector("#gfBody")?.innerText || ""));
  const branch = (await page.locator("#gfBody").innerText()).match(/Branch created: (gitflow\/\S+)/)[1];
  await page.close();
  assert(banner === 0 && !off && refsOf(ok.fx.repo).includes(`refs/heads/${branch} `), JSON.stringify({ banner, off, branch }));
  return { banner, created: branch };
});

await step("page: no script errors", async () => { assert(!pageErrors.length, pageErrors.join(" | ")); return { pageErrors: 0 }; });
await b.close();
for (const p of procs) p.kill();
writeFileSync(join(ROOT, "results.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed · evidence in ${ROOT}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
