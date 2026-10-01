// Browse in the Add workspace form, end to end: the page's Browse button opens the real Windows
// folder dialog, which dialog-driver.ps1 operates like a person (no mouse), and the chosen path
// goes through the normal add-workspace checks. Then the new workspace runs a real worker.
//   PROJECT=<real project folder> node bench/workspace-ui/browse-test.mjs <port> <shots dir>
import { chromium } from "../../browser-adapter/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const [port = "8797", shots = join(HERE, "shots")] = process.argv.slice(2);
const BASE = `http://127.0.0.1:${port}`, PROJECT = process.env.PROJECT;
mkdirSync(shots, { recursive: true });
const results = [];
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1280, height: 1008 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail).slice(0, 220)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message); await page.screenshot({ path: join(shots, `browse-fail-${results.length}.png`) }); }
};
const driver = (...args) => new Promise((ok) => {
  const p = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(HERE, "dialog-driver.ps1"), ...args]);
  let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d)); p.on("exit", () => ok(out.trim()));
});
const val = (sel) => page.inputValue(sel);
// Click Browse, let the "person" act in the dialog, wait for the button to come back.
async function browse(...args) {
  await page.click("#fBrowse");
  await page.waitForFunction(() => document.querySelector("#fBrowse").textContent === "Choosing…");
  const said = await driver(...args);
  await page.waitForFunction(() => document.querySelector("#fBrowse").textContent === "Browse", null, { timeout: 30000 });
  return said;
}
async function add() {
  const before = await page.locator("#wsList .row").count();
  await page.evaluate(() => { document.querySelector("#fErr").textContent = ""; });
  await page.click('#addForm button[type="submit"]');
  await page.waitForFunction((n) => document.querySelector("#fErr").textContent || document.querySelectorAll("#wsList .row").length > n, before, { timeout: 10000 });
  return (await page.locator("#fErr").innerText()) || null;
}

await page.goto(BASE, { waitUntil: "networkidle" });
await page.click("#addWs");

await step("Browse → pick a real project folder → path and name filled in", async () => {
  const said = await browse("select", PROJECT);
  await page.screenshot({ path: join(shots, "browse-picked.png") });
  return { dialog: said, path: await val("#fPath"), name: await val("#fName"), error: await page.locator("#fErr").innerText() };
});
await step("Browse → Cancel → form unchanged, no error", async () => {
  await page.fill("#fPath", "keep-this-value"); await page.fill("#fName", "keep-name");
  const said = await browse("cancel");
  return { dialog: said, path: await val("#fPath"), name: await val("#fName"), error: await page.locator("#fErr").innerText(), button: await page.innerText("#fBrowse") };
});
await step("Browse → drive root → Add refused", async () => {
  await page.fill("#fName", "Root");
  const said = await browse("select", "C:\\");
  return { dialog: said, path: await val("#fPath"), addError: await add() };
});
await step("Browse → home folder → Add refused", async () => {
  await page.fill("#fName", "Home");
  const said = await browse("select", homedir());
  return { dialog: said, path: await val("#fPath"), addError: await add() };
});
await step("typed: missing folder, a file, a UNC path → refused", async () => {
  const out = {};
  for (const [k, p] of [["missing", "C:\\definitely\\not\\here"], ["file", join(REPO, "README.md")], ["unc", "\\\\localhost\\c$"]]) { await page.fill("#fPath", p); out[k] = await add(); }
  return out;
});
await step("Browse → the real project → Add (Inspect) → selected", async () => {
  await page.fill("#fName", "");
  await browse("select", PROJECT);
  await page.click('.seg [data-mode="inspect"]');
  const err = await add();
  if (err) throw new Error(err);
  await page.waitForFunction((n) => document.querySelector("#cName").textContent === n, basename(PROJECT));
  return { selected: await page.innerText("#cName"), mode: await page.innerText("#mName"), branch: await page.locator("#cBranch").innerText().catch(() => null) };
});
await step("Browse the same project again → duplicate refused; this repo → duplicate of Executor", async () => {
  await page.click("#addWs"); await page.fill("#fName", "");
  await browse("select", PROJECT); const dup = await add();
  await page.fill("#fName", "");
  await browse("select", REPO); const dupRepo = await add();
  await page.click("#fCancel");
  return { sameProject: dup, thisRepo: dupRepo };
});
await step("the Browse-added workspace runs exactly as before (Inspect worker, real folder)", async () => {
  await page.fill("#input", "Using Glob only (do not open any file), list the top-level folders in this workspace. One line.");
  await page.click("#send");
  await page.waitForFunction(() => document.querySelector("#rState").textContent === "Waiting for you", null, { timeout: 300000 });
  const meta = await page.evaluate(async (id) => (await fetch(`/runs/${id}`)).json(), await page.evaluate(() => runId));
  await page.screenshot({ path: join(shots, "browse-run.png") });
  await page.click("#endBtn");
  await page.waitForFunction(() => document.querySelector("#rState").textContent === "Finished", null, { timeout: 60000 });
  return { boundTo: meta.workspace, cards: (await page.locator("#acts .card .ch").allInnerTexts()).map((c) => c.replace(/\s+/g, " ")), reply: (await page.locator(".msg-w").last().innerText()).slice(0, 200) };
});
await step("a foreign page can't open the picker", async () => {
  const r = await fetch(`${BASE}/pick-folder`, { method: "POST", headers: { origin: "http://evil.example", "x-worker-console": "1", "content-type": "application/json" }, body: "{}" });
  const g = await fetch(`${BASE}/pick-folder`);
  return { foreignPost: r.status, get: g.status };
});
writeFileSync(join(HERE, "browse-results.json"), JSON.stringify({ when: new Date().toISOString(), results, pageErrors: errors }, null, 1));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed; page errors: ${errors.length ? errors.join(" | ") : "none"}`);
await b.close();
