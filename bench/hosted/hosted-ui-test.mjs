// The hosted website in a real browser: sign in, the workspace page as a hosted person sees it
// (no local services, no folder paths, their identity, sign-out), a workspace made from the page, a
// task run from the composer with live activity, the Figma page, and sign-out. The gateway, the
// console and the Claude Code CLI are real; the model is the FAKE provider (fake-anthropic.mjs).
//   node bench/hosted/hosted-ui-test.mjs     (Windows or Linux; AIW_ISOLATION=none)
import { chromium } from "../../browser-adapter/node_modules/playwright/index.mjs";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { startFakeAnthropic } from "./fake-anthropic.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = resolve(HERE, "../..");
const BASE = Number(process.env.HOSTED_TEST_PORT_BASE) || 8740, O = `http://127.0.0.1:${BASE}`;
const KEY = "sk-ant-test-" + randomBytes(20).toString("hex");
const DATA = mkdtempSync(join(tmpdir(), "aiw-ui-"));
const results = [], errors = [];
const must = (c, m) => { if (!c) throw new Error(m); };
let page;
const shot = (n) => page.screenshot({ path: join(HERE, "shots", n) }).catch(() => {});
const step = async (name, fn) => { try { const d = await fn(); results.push({ step: name, ok: true, detail: d }); console.log("PASS", name, JSON.stringify(d ?? null).slice(0, 200)); } catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 300)); await shot(`ui-fail-${results.length}.png`); } };

const fake = await startFakeAnthropic(BASE + 1, { apiKey: KEY });
spawnSync(process.execPath, [join(REPO, "worker-ui", "users.mjs"), "add", "alice@pilot.test", "--name", "Alice", "--password-stdin"], { env: { ...process.env, AIW_DATA: DATA }, input: "correct-horse-battery-1\n" });
const gw = spawn(process.execPath, [join(REPO, "worker-ui", "gateway.mjs")], { env: { ...process.env, AIW_ENV: "test", AIW_DATA: DATA, AIW_PUBLIC_ORIGIN: O, AIW_PORT: String(BASE), AIW_BIND: "127.0.0.1", AIW_MODEL_PORT: String(BASE + 2), AIW_CONSOLE_PORT_BASE: String(BASE + 3), AIW_ISOLATION: "none", ANTHROPIC_API_KEY: KEY, ANTHROPIC_UPSTREAM_URL: `http://127.0.0.1:${BASE + 1}` }, stdio: "ignore" });
for (let i = 0; i < 100; i++) { try { if ((await fetch(O + "/healthz")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }

const browser = await chromium.launch();
page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => errors.push(e.message));

await step("opening the site signed out shows the sign-in page; a wrong password says so", async () => {
  await page.goto(O + "/");
  must(new URL(page.url()).pathname === "/login", page.url());
  await page.fill("#email", "alice@pilot.test"); await page.fill("#password", "not-the-password"); await page.click("#go");
  await page.waitForFunction(() => document.querySelector("#err").textContent.length > 0);
  const err = await page.textContent("#err");
  must(/incorrect/.test(err), err);
  await shot("hosted-login.png");
  return { url: page.url(), error: err };
});
await step("signing in opens the workspace page as a hosted person sees it: no local services, no folder path, Executor absent", async () => {
  await page.fill("#password", "correct-horse-battery-1"); await page.click("#go");
  await page.waitForURL(O + "/"); await page.waitForSelector("#wsList [data-ws]");
  const st = await page.evaluate(() => ({ hosted: document.body.dataset.hosted, title: document.title, lfoot: document.querySelector(".lfoot").hidden,
    ws: [...document.querySelectorAll("#wsList [data-ws]")].map((b) => b.dataset.ws) }));
  must(st.hosted === "1" && st.lfoot && !st.ws.includes("console"), JSON.stringify(st));
  await page.click("#addWs");
  must(!(await page.isVisible("#fPath")) && !(await page.isVisible("#fBrowse")), "the folder path is shown");
  await page.fill("#fName", "Website"); await page.click('.seg [data-mode="work"]');
  const help = await page.textContent("#fHelp");
  must(/shell commands aren't available/.test(help), help);
  await page.click('#addForm button[type="submit"]');
  await page.waitForFunction(() => [...document.querySelectorAll("#wsList [data-ws]")].some((b) => /Website/.test(b.textContent)));
  await shot("hosted-workspace.png");
  return st;
});
await step("the account panel names the signed-in person and the model provider, with Sign out", async () => {
  await page.click("#acctBtn"); await page.waitForSelector("#acctOut");
  const t = await page.textContent("#acctPop");
  must(/alice@pilot\.test/.test(t) && /Anthropic API through the platform's model gateway/.test(t), t);
  must(!/claude auth login|Login folder|Plan/.test(t), "subscription details shown: " + t);
  await page.keyboard.press("Escape");
  return { text: t.replace(/\s+/g, " ").slice(0, 160) };
});
await step("a task from the composer runs on the server: live activity, the file as a deliverable, Done", async () => {
  await fetch(`http://127.0.0.1:${BASE + 1}/__script`, { method: "POST", body: JSON.stringify({ name: "ui", steps: [
    { tool: { name: "Write", input: { file_path: "PLACEHOLDER", content: "made on the platform\n" } } }, { text: "DONE: wrote notes.md" }] }) });
  // The file path is the workspace's real folder, which only the server knows: ask it.
  const ws = await page.evaluate(async () => (await (await fetch("/workspaces")).json()).find((w) => w.name === "Website"));
  await fetch(`http://127.0.0.1:${BASE + 1}/__script`, { method: "POST", body: JSON.stringify({ name: "ui", steps: [
    { tool: { name: "Write", input: { file_path: join(ws.root, "notes.md"), content: "made on the platform\n" } } }, { text: "DONE: wrote notes.md" }] }) });
  await page.click(`#wsList [data-ws="${ws.id}"]`);
  await page.fill("#input", "Write the notes. FAKE-SCRIPT:ui"); await page.click("#send");
  await page.waitForFunction(() => document.querySelector("#runChip").dataset.outcome === "done", null, { timeout: 90000 });
  const brand = await page.textContent(".para"), foot = await page.textContent("#footR");
  must(/AI Worker/.test(brand) && /pilot/.test(brand) && !/local/.test(brand), `header: ${brand}`);
  must(/no shell commands/.test(foot) && !/run commands/.test(foot), `footer: ${foot}`);
  const act = await page.textContent("aside.right");
  must(/notes\.md/.test(act), "the deliverable isn't in the activity");
  must(readFileSync(join(ws.root, "notes.md"), "utf8") === "made on the platform\n", "file not written");
  await shot("hosted-run.png");
  return { chip: await page.textContent("#runChip") };
});
await step("the worker editor marks what the hosted platform doesn't provide", async () => {
  await page.click("#addWk"); await page.click("#wkBlank"); await page.waitForSelector("#wkForm");
  const marks = await page.$$eval(".cap .needs.off", (els) => els.map((e) => e.closest(".cap").textContent.replace(/\s+/g, " ").slice(0, 60)));
  must(marks.length === 3 && marks.some((m) => /node and curl/.test(m)) && marks.some((m) => /Change the open Figma file/.test(m)), JSON.stringify(marks));
  await shot("hosted-worker-editor.png");
  await page.click("#vClose").catch(() => {});
  const dlg = await page.$('#dlg [data-dlg="discard"]'); if (dlg) await dlg.click();
  return marks;
});
await step("the Figma page connects reading by token and says that editing isn't available hosted", async () => {
  await page.click("#fgOpen"); await page.waitForSelector("#fgToken");
  const t = await page.textContent("#fgBody");
  must(/Not connected/.test(t) && /desktop app/.test(t), t);
  await page.fill("#fgToken", "not-a-token"); await page.click("#fgConnect");
  await page.waitForFunction(() => /figd_/.test(document.querySelector("#fgMsg").textContent));
  await shot("hosted-figma.png");
  return { message: await page.textContent("#fgMsg") };
});
await step("Sign out ends the session: the page returns to sign-in and the API refuses", async () => {
  await page.click("#acctBtn"); await page.waitForSelector("#acctOut"); await page.click("#acctOut");
  await page.waitForURL(O + "/login");
  const r = await page.evaluate(async () => (await fetch("/runs")).status);
  must(r === 401, `after sign-out /runs → ${r}`);
  await page.goto(O + "/"); must(new URL(page.url()).pathname === "/login", page.url());
  return { runs: r };
});

await browser.close();
if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(gw.pid), "/T", "/F"]); else gw.kill("SIGTERM"); // the whole tree: gateway, console, workers
await fake.close();
const failed = results.filter((r) => !r.ok).length;
writeFileSync(join(HERE, "hosted-ui-results.json"), JSON.stringify({ when: new Date().toISOString(), platform: process.platform, results, pageErrors: errors }, null, 1));
console.log(`${results.length - failed} passed, ${failed} failed, page errors: ${errors.length}`);
rmSync(DATA, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
