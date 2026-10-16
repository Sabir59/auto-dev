// The Workspace page driven in a real browser against a console with its own data dir, using the
// real headless worker. Every step goes through the UI the way a person would.
//   CANARY=<inspect folder> WORK=<work folder> node bench/workspace-ui/workflow-test.mjs <port> <shots dir>
import { chromium } from "../../browser-adapter/node_modules/playwright/index.mjs";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const [port = "8797", shots = join(HERE, "shots")] = process.argv.slice(2);
const BASE = `http://127.0.0.1:${port}`;
mkdirSync(shots, { recursive: true });
const results = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const detail = await fn(); results.push({ step: name, ok: true, seconds: Math.round((Date.now() - t0) / 100) / 10, detail }); console.log("PASS", name, detail ? JSON.stringify(detail).slice(0, 160) : ""); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message); await page.screenshot({ path: join(shots, `fail-${results.length}.png`) }); }
};
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1280, height: 1008 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const text = (sel) => page.locator(sel).innerText();
const waitStatus = (labels, timeout = 300000) => page.waitForFunction((l) => l.includes(document.querySelector("#rState").textContent), labels, { timeout });
const shot = (n) => page.screenshot({ path: join(shots, n) });

await page.goto(BASE, { waitUntil: "networkidle" });

await step("add an Inspect workspace through the form", async () => {
  await page.click("#addWs");
  await page.fill("#fName", "Canary");
  await page.fill("#fPath", process.env.CANARY);
  await page.click('.seg [data-mode="inspect"]');
  await page.click('#addForm button[type="submit"]');
  await page.waitForFunction(() => document.querySelector("#cName").textContent === "Canary");
  return { selected: await text("#cName"), mode: await text("#mName"), badge: await text('#wsList [aria-current="true"] .badge') };
});
await step("the form refuses a folder that doesn't exist and a drive root", async () => {
  await page.click("#addWs");
  await page.fill("#fName", "Nope"); await page.fill("#fPath", "C:\\definitely\\not\\here");
  await page.click('#addForm button[type="submit"]');
  await page.waitForFunction(() => document.querySelector("#fErr").textContent.length > 0);
  const e1 = await text("#fErr");
  await page.fill("#fPath", "C:\\"); await page.click('#addForm button[type="submit"]');
  await page.waitForFunction((p) => document.querySelector("#fErr").textContent !== p, e1);
  const e2 = await text("#fErr");
  await page.click("#fCancel");
  return { missing: e1, root: e2 };
});
await step("add a Work workspace", async () => {
  await page.click("#addWs");
  await page.fill("#fName", "Work test"); await page.fill("#fPath", process.env.WORK);
  await page.click('.seg [data-mode="work"]'); await page.click('#addForm button[type="submit"]');
  await page.waitForFunction(() => document.querySelector("#cName").textContent === "Work test");
  await page.click('#wsList [data-ws]:has-text("Canary")');
  await page.waitForFunction(() => document.querySelector("#cName").textContent === "Canary");
  return { workspaces: await page.locator("#wsList .row").allInnerTexts() };
});
await step("file explorer lists the workspace and opens a file read-only", async () => {
  await page.waitForSelector('#tree [data-path="README.md"]');
  const names = await page.locator("#tree > li > .row").allInnerTexts();
  await page.click('#tree [data-path="README.md"]');
  await page.waitForSelector(".code .tx");
  const content = await text(".code .tx");
  await shot("file-viewer.png");
  const linkedOut = names.some((n) => n.trim() === "jdir");
  await page.click("#vClose");
  return { entries: names.map((n) => n.trim()), junctionToOutsideListed: linkedOut, readmeFirstLine: content.split("\n")[0], editable: await page.locator(".code [contenteditable]").count() };
});
await step("a hostile HTML file is shown as text, not run", async () => {
  const before = (await (await fetch(`${BASE}/runs`)).json()).runs.length;
  await page.click('#tree [data-path="evil.html"]');
  await page.waitForSelector(".code .tx");
  const shown = await text(".code .tx");
  const direct = await fetch(`${BASE}/file?workspace=${encodeURIComponent(await page.evaluate(() => wsId))}&path=evil.html`);
  const tab = await b.newPage(); await tab.goto(direct.url); await tab.waitForTimeout(1500); await tab.close();
  const after = (await (await fetch(`${BASE}/runs`)).json()).runs.length;
  await page.click("#vClose");
  return { shownAsText: shown.includes("<script>"), csp: direct.headers.get("content-security-policy"), runsBefore: before, runsAfterOpeningItDirectly: after };
});
await step("start a run, see live activity, get the result (Inspect)", async () => {
  await page.fill("#input", "Read README.md in this folder and summarise it in one sentence.");
  await page.click("#send");
  await waitStatus(["Starting", "Working"], 30000);
  await page.waitForSelector(".working", { timeout: 30000 });
  const liveSeen = await page.locator("#live:not([hidden])").count();
  const sendIsStop = await page.getAttribute("#send", "aria-label");
  await page.waitForSelector(".card:has-text('Read')", { timeout: 120000 });
  await shot("run-working.png");
  await waitStatus(["Waiting for you"]);
  await shot("run-result.png");
  const cards = await page.locator("#acts .card .ch").allInnerTexts();
  return { liveSeen: !!liveSeen, sendIsStop, cards: cards.map((c) => c.replace(/\s+/g, " ")), reply: (await page.locator(".msg-w").last().innerText()).slice(0, 160) };
});
await step("follow-up in the same worker process", async () => {
  await page.fill("#input", "Which file did you read? Answer with just the file name.");
  await page.keyboard.press("Enter");
  await waitStatus(["Working"], 30000);
  await waitStatus(["Waiting for you"]);
  const procs = await page.locator("#acts .card:has-text('Worker started')").count();
  return { reply: await page.locator(".msg-w").last().innerText(), workerStartedCards: procs, turnDividers: await page.locator("#acts .turn").count() };
});
await step("save the prompt as a favourite, use it, remove it", async () => {
  await page.fill("#input", "List the files in src and say what each one does.");
  await page.click("#saveP");
  await page.waitForSelector('#favList [data-p]');
  const fav = await text("#favList .fav");
  await page.fill("#input", "");
  await page.click("#favList [data-p]");
  const filled = await page.inputValue("#input");
  await page.hover("#favList .fav"); await page.click("#favList [data-del]");
  await page.waitForSelector("#favList .empty");
  await page.fill("#input", "");
  return { saved: fav.trim(), composerAfterClick: filled, afterRemove: await text("#favList") };
});
await step("End run, then it appears in Recent runs as finished", async () => {
  await page.click("#endBtn");
  await waitStatus(["Finished"], 60000);
  await page.waitForFunction(() => document.querySelectorAll("#runList [data-run]").length > 0, null, { timeout: 10000 });
  return { recent: (await page.locator("#runList [data-run]").allInnerTexts()).map((t) => t.replace(/\s+/g, " ")) };
});
await step("reload, open the run from Recent runs, continue it (resume)", async () => {
  await page.reload({ waitUntil: "networkidle" });
  await page.click('#wsList [data-ws]:has-text("Canary")');
  await page.click("#runList [data-run]");
  await page.waitForSelector(".msg-u");
  const replayed = await page.locator(".msg-u, .msg-w").count();
  await page.fill("#input", "What did I first ask you? One sentence.");
  await page.click("#send");
  await waitStatus(["Starting", "Working"], 30000);
  await waitStatus(["Waiting for you"]);
  return { replayedMessages: replayed, resumedCard: await page.locator("#acts .card:has-text('Resumed')").count(), reply: (await page.locator(".msg-w").last().innerText()).slice(0, 200) };
});
await step("Stop a busy run with the send button", async () => {
  await page.fill("#input", "Read every file in this folder one at a time, then write a long detailed report about each of them.");
  await page.click("#send");
  await waitStatus(["Working"], 30000);
  await page.waitForFunction(() => document.querySelector("#send").classList.contains("stop"));
  await page.click("#send");
  await waitStatus(["Stopped"], 30000);
  return { status: await text("#rState"), thread: (await page.locator(".sys").allInnerTexts()).slice(-1) };
});
await step("Work workspace: the worker writes a file, it shows as an artifact, it opens in the viewer", async () => {
  await page.click('#wsList [data-ws]:has-text("Work test")');
  await page.fill("#input", "Create the file notes/summary.md containing one line: Workspace artifact test. Then report it with an ARTIFACT: line.");
  await page.click("#send");
  await page.waitForSelector("#acts [data-art]", { timeout: 300000 });
  await waitStatus(["Waiting for you"]);
  const art = await text("#acts [data-art]");
  await page.click("#acts [data-art]");
  await page.waitForSelector(".code .tx");
  const content = await text(".code .tx");
  await shot("artifact.png");
  await page.click("#vClose");
  await page.click("#endBtn"); await waitStatus(["Finished"], 60000);
  return { artifact: art, content, onDisk: existsSync(join(process.env.WORK, "notes", "summary.md")) && readFileSync(join(process.env.WORK, "notes", "summary.md"), "utf8").trim() };
});
await step("a worker that moves into a sub-folder of its workspace (cd) keeps working on the next message, and after a resume", async () => {
  await page.click('#wsList [data-ws]:has-text("Work test")'); // a fresh chat in the Work workspace
  await page.fill("#input", 'Run exactly this one shell command and nothing else: cd src && node -e "console.log(process.cwd())" . Then reply with the folder it printed.');
  await page.click("#send");
  await waitStatus(["Waiting for you"]);
  const id = await page.evaluate(() => runId);
  // the same process takes the next message: its shell is now in src/, and the runtime reports that
  await page.fill("#input", "Reply with the single word NEXT.");
  await page.click("#send");
  await waitStatus(["Working"], 30000); await waitStatus(["Waiting for you", "Failed"]);
  const sameProcess = await text("#rState"), reply1 = await page.locator(".msg-w").last().innerText();
  await page.click("#endBtn"); await waitStatus(["Finished"], 60000);
  // a resume starts a new process on the same session, whose transcript now records src/ too
  await page.fill("#input", "Reply with the single word AGAIN.");
  await page.click("#send");
  await waitStatus(["Working"], 60000); await waitStatus(["Waiting for you", "Failed"]);
  const resumed = await text("#rState"), reply2 = await page.locator(".msg-w").last().innerText();
  const inits = readFileSync(join(process.env.DATA, "runs", `${id}.raw.jsonl`), "utf8").split("\n").filter((l) => l.includes('"subtype":"init"')).map((l) => JSON.parse(l).cwd);
  await page.click("#endBtn"); await waitStatus(["Finished"], 60000);
  if (sameProcess !== "Waiting for you" || resumed !== "Waiting for you" || !/NEXT/.test(reply1) || !/AGAIN/.test(reply2)) throw new Error(JSON.stringify({ sameProcess, resumed, reply1, reply2, inits }));
  return { reportedCwds: inits.map((c) => c.split(/[\\/]/).slice(-2).join("/")), nextMessage: sameProcess, afterResume: resumed };
});
writeFileSync(join(HERE, "results.json"), JSON.stringify({ when: new Date().toISOString(), results, pageErrors: errors }, null, 1));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed; page errors: ${errors.length ? errors.join(" | ") : "none"}`);
await b.close();
