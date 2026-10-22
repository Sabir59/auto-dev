// The first-time customer journey in a real browser, end to end: Discover → Configure → Connect →
// Delegate → Observe → Review → continue. Sign in, the getting-started guide, a project folder, a worker
// described in the person's own words and configured from it (with what the platform doesn't provide
// marked), their request run by the real runtime, live activity, the result (what it reported, what failed, files
// written), the real diff from "Review the changes", and a follow-up that needs the person.
// The gateway, the console, the Claude Code CLI and the tools are real; the MODEL IS THE FAKE
// PROVIDER (fake-anthropic.mjs), scripted, so this proves the product's side of each step, not what
// a real model would do. Screenshots: bench/hosted/shots/journey-*.png.
//   node bench/hosted/journey-test.mjs     (Windows or Linux; AIW_ISOLATION=none)
import { chromium } from "../../browser-adapter/node_modules/playwright/index.mjs";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { startFakeAnthropic } from "./fake-anthropic.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = resolve(HERE, "../..");
const BASE = Number(process.env.JOURNEY_TEST_PORT_BASE) || 8750, O = `http://127.0.0.1:${BASE}`;
const KEY = "sk-ant-test-" + randomBytes(20).toString("hex");
const DATA = mkdtempSync(join(tmpdir(), "aiw-journey-"));
const results = [], errors = [];
const must = (c, m) => { if (!c) throw new Error(m); };
let page;
const shot = (n) => page.screenshot({ path: join(HERE, "shots", `journey-${n}.png`) }).catch(() => {});
const step = async (name, fn) => { try { const d = await fn(); results.push({ step: name, ok: true, detail: d }); console.log("PASS", name, JSON.stringify(d ?? null).slice(0, 220)); } catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 300)); await shot(`fail-${results.length}`); } };
const script = (name, steps) => fetch(`http://127.0.0.1:${BASE + 1}/__script`, { method: "POST", body: JSON.stringify({ name, steps }) });
const git = (cwd, ...a) => spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...a], { cwd, encoding: "utf8" });

const fake = await startFakeAnthropic(BASE + 1, { apiKey: KEY });
spawnSync(process.execPath, [join(REPO, "worker-ui", "users.mjs"), "add", "dana@pilot.test", "--name", "Dana", "--password-stdin"], { env: { ...process.env, AIW_DATA: DATA }, input: "correct-horse-battery-1\n" });
const gw = spawn(process.execPath, [join(REPO, "worker-ui", "gateway.mjs")], { env: { ...process.env, AIW_ENV: "test", AIW_DATA: DATA, AIW_PUBLIC_ORIGIN: O, AIW_PORT: String(BASE), AIW_BIND: "127.0.0.1", AIW_MODEL_PORT: String(BASE + 2), AIW_CONSOLE_PORT_BASE: String(BASE + 3), AIW_ISOLATION: "none", ANTHROPIC_API_KEY: KEY, ANTHROPIC_UPSTREAM_URL: `http://127.0.0.1:${BASE + 1}` }, stdio: "ignore" });
for (let i = 0; i < 100; i++) { try { if ((await fetch(O + "/healthz")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }

const browser = await chromium.launch();
page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => errors.push(e.message));
let ws;

await step("Discover: after sign-in a new person sees what this is, the three pieces, and is asked what they'd like a worker to do", async () => {
  await page.goto(O + "/");
  await page.fill("#email", "dana@pilot.test"); await page.fill("#password", "correct-horse-battery-1"); await page.click("#go");
  await page.waitForURL(O + "/"); await page.waitForSelector("#gsGuide #gsDesc");
  const h1 = await page.textContent("#gsGuide h1"), concepts = await page.locator("#gsGuide .concept b").allInnerTexts(), ask = await page.textContent("#gsGuide .gs-ask .lab");
  must(concepts.join() === "Worker,Workspace,Team" && /What would you like your AI worker to do/.test(ask), JSON.stringify({ concepts, ask }));
  await shot("1-guide");
  return { h1, concepts, ask };
});

await step("Connect: their project folder (Work), a Git repository with one commit", async () => {
  await page.click("#addWs");
  await page.fill("#fName", "Shop"); await page.click('.seg [data-mode="work"]'); await page.click('#addForm button[type="submit"]');
  await page.waitForFunction(() => [...document.querySelectorAll("#wsList [data-ws]")].some((b) => /Shop/.test(b.textContent)));
  ws = await page.evaluate(async () => (await (await fetch("/workspaces")).json()).find((w) => w.name === "Shop"));
  mkdirSync(join(ws.root, "src"), { recursive: true });
  writeFileSync(join(ws.root, "src", "Button.jsx"), "export function CheckoutButton({ onClick }) {\n  return <button onClick={onClick}>Donate now</button>;\n}\n");
  git(ws.root, "init", "-q", "-b", "main"); git(ws.root, "add", "-A"); git(ws.root, "commit", "-q", "-m", "Checkout button");
  await page.click(`#wsList [data-ws="${ws.id}"]`);
  await page.waitForSelector("#gsGuide #gsDesc");
  return { workspace: ws.name };
});

await step("Configure: their own words → the code repository's questions only (stack recognised); the review marks what this platform doesn't provide and works in Shop", async () => {
  await page.fill("#gsDesc", "Add a loading state to the checkout button in my React app's repository");
  await page.click('[data-gs="describe"]'); await page.waitForSelector('.isec:has-text("Code repository")');
  const chips = await page.locator(".ichip").allInnerTexts(), questions = await page.locator(".isec .qlab").allInnerTexts(), stack = await page.inputValue('[data-q="code.stack"]');
  must(chips.length === 1 && /Code repository/.test(chips[0]) && stack === "React" && questions.includes("Run Node scripts, such as tests and builds") && !questions.some((q) => /publish|Shopify|Figma/i.test(q)), JSON.stringify({ chips, questions, stack }));
  await shot("2-questions");
  await page.click('[data-next="3"]'); await page.waitForSelector("#crName");
  const off = await page.locator("#crCaps .cchip.off").allInnerTexts(), where = await page.inputValue("#crWs"), name = await page.inputValue("#crName");
  must(off.some((x) => /node and curl[\s\S]*not available here/.test(x)) && where === ws.id && name === "React engineer", JSON.stringify({ off, where, name }));
  await shot("3-review");
  await page.click('[data-next="4"]'); await page.waitForSelector("#readyBox");
  return { tools: chips.map((c) => c.split("\n")[0]), questions, notAvailableHere: off };
});

await step("Delegate: the new task names the worker and workspace, what it may change, and offers their own request as the first task", async () => {
  const ready = await page.textContent("#readyBox"), who = await page.textContent("#wkName"), where = await page.textContent("#bName"), first = await page.locator('[data-gs="example"]').first().innerText();
  must(/Shop/.test(ready) && /change files/.test(ready) && who === "React engineer" && where === "Shop" && /loading state/.test(first), JSON.stringify({ ready, who, where, first }));
  await shot("4-new-task");
  return { composer: `${who} · ${where}`, readiness: ready.replace(/\s+/g, " ").slice(0, 160), firstTask: first.split("\n")[0] };
});

await step("Observe: an example task runs for real (a failed read, a read, an edit) with each step live in Activity", async () => {
  const file = join(ws.root, "src", "Button.jsx");
  await script("journey", [
    { tool: { name: "Read", input: { file_path: join(ws.root, "src", "Cart.jsx") } } },
    { tool: { name: "Read", input: { file_path: file } } },
    { tool: { name: "Edit", input: { file_path: file, old_string: "  return <button onClick={onClick}>Donate now</button>;", new_string: "  return <button onClick={onClick} disabled={busy} aria-busy={busy}>{busy ? \"Processing…\" : \"Donate now\"}</button>;" } } },
    { text: "I added a loading state to the checkout button: while `busy` is true it's disabled and says Processing….\n\nVERIFICATION: Read src/Button.jsx back after the edit: the button is disabled and labelled Processing… while busy.\nDONE: Added a loading state to the checkout button in src/Button.jsx. I didn't run it in a browser." }]);
  await page.locator('[data-gs="example"]').first().click();
  await page.fill("#input", (await page.inputValue("#input")) + " FAKE-SCRIPT:journey");
  await page.click("#send");
  await page.waitForFunction(() => document.querySelector("#runChip").dataset.outcome === "done", null, { timeout: 120000 });
  const tools = await page.locator("#acts .card.k-tool .cm").allInnerTexts();
  must(tools.length === 3 && /^Failed/.test(tools[0]) && tools.slice(1).every((t) => /^Success/.test(t)), JSON.stringify(tools));
  await shot("5-observe");
  return { toolCalls: tools };
});

await step("Review: the result separates what the worker reported from what failed, lists the file, and the next actions are real", async () => {
  const res = page.locator(".xres").last();
  const text = (await res.innerText()).replace(/\s+/g, " ");
  must(/Reported done/.test(text) && /1 file written/.test(text) && /1 tool call failed/.test(text) && /Checks it reported \(its own words/.test(text) && /Read src\/Button.jsx back/.test(text), text);
  must(await res.locator('[data-res="review"]').count() === 1 && await res.locator('[data-res="new"]').count() === 1, "next actions missing");
  await shot("6-result");
  await res.locator('[data-res="review"]').click();
  // The working copy: the changed file, the conversation it came from, and the commit box; the file opens its diff.
  await page.waitForFunction(() => /Changes from:/.test(document.querySelector("#canvas").innerText), null, { timeout: 15000 });
  const list = (await page.textContent("#canvas")).replace(/\s+/g, " ");
  must(/src\/Button.jsx/.test(list) && /Add a loading state/.test(list) && /Commit 1 file/.test(list), list.slice(0, 300));
  await shot("7-review");
  await page.click('.vfile[data-path="src/Button.jsx"]');
  await page.waitForFunction(() => /Processing…/.test(document.querySelector("#canvas").innerText), null, { timeout: 15000 });
  await shot("7b-review-diff");
  return { result: text.slice(0, 240), review: "working copy lists src/Button.jsx from this conversation; its diff shows the edit" };
});

await step("Continue: a follow-up the worker can't finish alone ends as Needs your action, saying what the person has to do", async () => {
  await page.click("#vClose");
  await script("needs", [{ text: "To check it in a browser I need the site running.\n\nNEEDS: browser use: start the dev server (npm start in the Shop folder), then tell me its address." }]);
  await page.fill("#input", "Now check it in the browser. FAKE-SCRIPT:needs"); await page.click("#send");
  await page.waitForFunction(() => document.querySelector("#runChip").dataset.outcome === "needs", null, { timeout: 120000 });
  const res = (await page.locator(".xres").last().innerText()).replace(/\s+/g, " ");
  const earlier = await page.locator(".xres").first().locator("[data-res]").count();
  must(/Needs your action/.test(res) && /What it needs from you/.test(res) && /npm start/.test(res) && /Reply below once you've done it/.test(res) && earlier === 0, JSON.stringify({ res, earlier }));
  await shot("8-needs");
  return { result: res.slice(0, 200), olderResultsHaveNoButtons: true };
});

await browser.close();
gw.kill("SIGTERM"); await fake.close?.();
await new Promise((r) => setTimeout(r, 1500));
try { rmSync(DATA, { recursive: true, force: true }); } catch {}
writeFileSync(join(HERE, "journey-results.json"), JSON.stringify({ when: new Date().toISOString(), platform: process.platform, model: "FAKE (scripted)", results, pageErrors: errors }, null, 1));
console.log(`${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed, page errors: ${errors.length}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
