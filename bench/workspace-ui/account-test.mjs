// The account & usage panel: the icon in the top bar opens a popup with the Claude login the
// workers run as (from the runtime's own `claude auth status`), the plan usage the runtime last
// reported to a worker (5-hour and 7-day windows), and this console's run totals.
//   DATA=<console data dir> node bench/workspace-ui/account-test.mjs <port>
import { chromium } from "../../browser-adapter/node_modules/playwright/index.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const [port = "8797"] = process.argv.slice(2);
const BASE = `http://127.0.0.1:${port}`, DATA = process.env.DATA;
const H = { origin: BASE, "x-worker-console": "1", "content-type": "application/json" };
const call = (method, path, data) => fetch(BASE + path, { method, headers: H, body: data ? JSON.stringify(data) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const results = [];
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail).slice(0, 240)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 300)); await page.screenshot({ path: join(HERE, "shots", `account-fail-${results.length}.png`) }); }
};
const open = async () => { if (await page.locator("#acctPop").isHidden()) await page.click("#acctBtn"); await page.waitForSelector("#acctPop .lab"); await page.waitForFunction(() => !/Checking/.test(document.querySelector("#acctPop").textContent), null, { timeout: 30000 }); };
// What the runtime itself says, run the same way the console runs it (same config dir as workers)
const exe = (() => { for (const d of process.env.PATH.split(";")) { const p = join(d, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"); try { execFileSync(p, ["--version"], { stdio: "ignore" }); return p; } catch {} } return "claude"; })();
const truth = JSON.parse(execFileSync(exe, ["auth", "status", "--json"], { env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/.test(k))), CLAUDE_CONFIG_DIR: join(homedir(), ".claude") }, encoding: "utf8" }));

// The results file and screenshot are kept in the repo: email addresses in them are masked (after the checks).
const mask = (v) => String(v).replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@/g, "$1***@");
const maskPage = () => page.evaluate(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let n; (n = w.nextNode());) n.nodeValue = n.nodeValue.replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@/g, "$1***@"); });
await page.goto(BASE, { waitUntil: "networkidle" });
await step("the account icon is in the top bar; the popup opens and shows the Claude login the workers use", async () => {
  must(await page.locator("#acctBtn").isVisible() && await page.locator("#acctPop").isHidden(), "icon missing or popup open");
  await open();
  const email = await page.locator("#acctEmail").innerText(), text = await page.locator("#acctPop").innerText();
  must(email === truth.email, `shown ${email}, runtime says ${truth.email}`);
  must(new RegExp(truth.subscriptionType, "i").test(text) && text.includes(truth.configDirectory.replace("/", "\\").replace(/\\\.claude$/, "\\.claude").slice(0, 10)), text);
  must(await page.locator("#acctBtn").getAttribute("aria-expanded") === "true", "aria-expanded");
  return { email: mask(email), plan: truth.subscriptionType, authMethod: truth.authMethod };
});
await step("usage is live from Claude Code (its own usage query, no model request): both windows and today's totals", async () => {
  const id = "2026-10-14T00-00-00-000Z";
  mkdirSync(join(DATA, "runs"), { recursive: true });
  writeFileSync(join(DATA, "runs", `${id}.jsonl`), "");
  writeFileSync(join(DATA, "runs", `${id}.meta.json`), JSON.stringify({ id, prompt: "seeded", workspace: { id: "scratch", root: DATA, profile: "full" }, createdAt: new Date().toISOString(), status: "finished", messages: 1, envs: {}, artifacts: [], failures: 0, costUsd: 1.25 }));
  const fresh = page.waitForResponse((r) => r.url().includes("/account?refresh=1"));
  await page.click("#acctRefresh");
  await fresh; await page.waitForTimeout(200);
  await page.waitForFunction(() => /Live from Claude Code/.test(document.querySelector("#acctAsOf")?.textContent || ""), null, { timeout: 60000 });
  const five = await page.locator("#acctFive").innerText(), week = await page.locator("#acctWeek").innerText(), text = await page.locator("#acctPop").innerText();
  const a = (await call("GET", "/account")).body, runs = (await call("GET", "/runs")).body.runs;
  await maskPage(); await page.screenshot({ path: join(HERE, "shots", "account-popup.png") });
  must(/\d+%/.test(five) && /\d+%/.test(week) && /(Resets in|Not started)/.test(five) && /(Resets in|Not started)/.test(week), JSON.stringify({ five, week }));
  must(a.usage?.source === "runtime" && runs.length === 1 && runs[0].id === id, JSON.stringify({ source: a.usage?.source, runs: runs.length }));
  must(/Runs today\s*1 · \$1\.25/.test(text), text);
  return { five: five.replace(/\s+/g, " "), week: week.replace(/\s+/g, " "), source: a.usage.source, workerRunsStarted: 0 };
});
await step("closes with Escape and with a click outside; Escape doesn't close anything else", async () => {
  await page.keyboard.press("Escape");
  const afterEsc = await page.locator("#acctPop").isHidden(), focus = await page.evaluate(() => document.activeElement?.id);
  await open(); await page.mouse.click(640, 500);
  const afterOutside = await page.locator("#acctPop").isHidden();
  await open(); await page.click("#acctPop .lab");
  const insideStays = await page.locator("#acctPop").isVisible();
  await page.keyboard.press("Escape");
  must(afterEsc && focus === "acctBtn" && afterOutside && insideStays, JSON.stringify({ afterEsc, focus, afterOutside, insideStays }));
  return { afterEsc, focusBack: focus, afterOutside, insideStays };
});
await step("a reading from before its window reset isn't shown as current: no %, no limit warning", async () => {
  await open();
  const r = (await call("GET", "/account")).body, past = Math.floor(Date.now() / 1000) - 600;
  r.usage = { ...r.usage, status: "rejected", limitType: "five_hour", fiveHour: { utilization: 1, resetsAt: past } };
  await page.evaluate((x) => renderAccount(x), r);
  const five = await page.locator("#acctFive").innerText(), limit = await page.locator("#acctLimit").count();
  must(/—/.test(five) && !/100%/.test(five) && /no reading since/.test(five) && limit === 0, JSON.stringify({ five, limit }));
  return { five: five.replace(/\s+/g, " "), limitWarning: limit > 0 };
});
await step("a reported limit shows the warning, a full bar and the reset time", async () => {
  await open();
  const r = (await call("GET", "/account")).body, now = Math.floor(Date.now() / 1000);
  r.usage = { ...r.usage, status: "rejected", limitType: "five_hour", fiveHour: { utilization: 1, resetsAt: now + 2 * 3600 + 15 * 60 }, sevenDay: { utilization: 0.59, resetsAt: now + 3 * 86400 + 4 * 3600 } };
  await page.evaluate((x) => renderAccount(x), r);
  const five = await page.locator("#acctFive").innerText(), week = await page.locator("#acctWeek").innerText(), limit = await page.locator("#acctLimit").innerText();
  must(/100%/.test(five) && /Resets in 2h 1[45]m/.test(five) && (await page.locator("#acctFive .bar.full").count()) === 1 && /59%/.test(week) && /Resets in 3d 4h/.test(week) && /Limit reached \(5-hour session\)/.test(limit), JSON.stringify({ five, week, limit }));
  await page.keyboard.press("Escape");
  return { five: five.replace(/\s+/g, " "), week: week.replace(/\s+/g, " "), limit };
});
await step("the route is read-only and carries no secrets", async () => {
  const a = (await call("GET", "/account")).body, post = await call("POST", "/account", {});
  const keys = Object.keys(a.account), raw = JSON.stringify(a);
  must(JSON.stringify(keys) === JSON.stringify(["loggedIn", "email", "orgName", "plan", "authMethod", "apiProvider", "configDir"]), JSON.stringify(keys));
  must(!/token|sk-ant|oauth|secret|orgId/i.test(raw) && post.status === 404, JSON.stringify({ post: post.status }));
  return { accountFields: keys, post: post.status };
});
writeFileSync(join(HERE, "account-results.json"), JSON.stringify({ when: new Date().toISOString(), results, pageErrors: errors }, null, 1));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed; page errors: ${errors.length ? errors.join(" | ") : "none"}`);
await b.close();
