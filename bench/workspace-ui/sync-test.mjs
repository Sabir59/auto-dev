// Executor can be removed (hidden) and restored with its runs; the page copes with no workspaces;
// and two open pages stay consistent when one of them removes, adds or reorders workspaces.
//   WORK=<folder> node bench/workspace-ui/sync-test.mjs <port>
import { chromium } from "../../browser-adapter/node_modules/playwright/index.mjs";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const [port = "8797"] = process.argv.slice(2);
const BASE = `http://127.0.0.1:${port}`;
const H = { origin: BASE, "x-worker-console": "1", "content-type": "application/json" };
const call = (method, path, data) => fetch(BASE + path, { method, headers: H, body: data ? JSON.stringify(data) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const results = [];
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 1008 } }); // one browser profile, two tabs
const A = await ctx.newPage(), B = await ctx.newPage();
const errors = [];
for (const p of [A, B]) p.on("pageerror", (e) => errors.push(e.message));
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail).slice(0, 240)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 300)); }
};
// What the page shows, and whether it agrees with itself and with the server.
const state = async (p) => {
  const srv = (await (await fetch(BASE + "/workspaces")).json()).map((w) => w.id);
  const s = await p.evaluate(() => ({ wsId, rows: [...document.querySelectorAll("#wsList .row.ws")].map((e) => e.dataset.ws), current: [...document.querySelectorAll("#wsList [aria-current=true]")].map((e) => e.dataset.ws), cName: document.querySelector("#cName").textContent, runs: document.querySelectorAll("#runList [data-run]").length, tree: [...document.querySelectorAll("#tree > li > .row")].map((e) => e.innerText.trim()).slice(0, 4) }));
  return { ...s, consistent: JSON.stringify(s.rows) === JSON.stringify(srv) && (srv.length ? s.current[0] === s.wsId : s.wsId === null) };
};
const removeIn = async (p, id) => { await p.hover(`#wsList [data-ws-item="${id}"]`); await p.click(`#wsList [data-ws-item="${id}"] [data-rm]`); await p.click("[data-rm-ok]"); await p.waitForFunction((i) => !document.querySelector(`#wsList [data-ws-item="${i}"]`) && !document.querySelector("[data-rm-ok]"), id); };
const addIn = async (p, name, path, mode = "work") => { await p.click("#addWs"); await p.fill("#fName", name); await p.fill("#fPath", path); await p.click(`.seg [data-mode="${mode}"]`); await p.click('#addForm button[type="submit"]'); };

// A finished run in Executor, so there's history to hide and bring back.
const r = (await call("POST", "/runs", { prompt: "Reply with exactly: EXECUTOR-RUN", workspace: "console" })).body;
for (let i = 0; i < 300; i++) { const m = (await call("GET", `/runs/${r.id}`)).body; if (m.status === "waiting") break; await new Promise((ok) => setTimeout(ok, 1000)); }
await call("POST", `/runs/${r.id}/end`);
for (let i = 0; i < 60; i++) { if (!(await call("GET", "/runs")).body.active) break; await new Promise((ok) => setTimeout(ok, 500)); }
const work = (await call("POST", "/workspaces", { name: "Work test", path: process.env.WORK, mode: "work" })).body;
await A.goto(BASE, { waitUntil: "networkidle" }); await B.goto(BASE, { waitUntil: "networkidle" });

await step("Executor: remove it (it has a run) → off the list, its run hidden", async () => {
  await A.click('#wsList [data-ws="console"]');
  const runsBefore = (await state(A)).runs;
  await removeIn(A, "console");
  const resume = await call("POST", `/runs/${r.id}/message`, { text: "still there?" });
  return { runsShownBefore: runsBefore, after: await state(A), resumeHiddenRun: resume };
});
await step("the other tab corrects itself within the refresh (it had Executor open)", async () => {
  await B.waitForFunction(() => !document.querySelector('#wsList [data-ws-item="console"]'), null, { timeout: 10000 });
  await B.waitForTimeout(300);
  return await state(B);
});
await step("add this app's folder again → Executor comes back with its run", async () => {
  await addIn(A, "Executor", REPO, "work");
  await A.waitForFunction(() => document.querySelector("#cName").textContent === "Executor");
  await A.waitForFunction(() => document.querySelectorAll("#runList [data-run]").length > 0, null, { timeout: 10000 });
  const resume = await call("POST", `/runs/${r.id}/message`, { text: "Reply with exactly: BACK" });
  for (let i = 0; i < 300; i++) { const m = (await call("GET", `/runs/${r.id}`)).body; if (m.status === "waiting") break; await new Promise((ok) => setTimeout(ok, 1000)); }
  await call("POST", `/runs/${r.id}/end`);
  for (let i = 0; i < 60; i++) { if (!(await call("GET", "/runs")).body.active) break; await new Promise((ok) => setTimeout(ok, 500)); }
  return { after: await state(A), resumeRestoredRun: resume.status };
});
await step("tab B has Work test open; tab A removes it → B falls back, no stale selection", async () => {
  await B.reload({ waitUntil: "networkidle" });
  await B.click(`#wsList [data-ws="${work.id}"]`);
  await B.waitForFunction((i) => wsId === i, work.id);
  await removeIn(A, work.id);
  await B.waitForFunction((i) => wsId !== i, work.id, { timeout: 10000 });
  await B.waitForTimeout(300);
  return await state(B);
});
await step("tab A adds a workspace and reorders; tab B shows the same list", async () => {
  await addIn(A, "Work test", process.env.WORK, "inspect");
  await A.waitForFunction(() => document.querySelector("#cName").textContent === "Work test");
  const id = await A.evaluate(() => wsId);
  await A.focus(`#wsList [data-ws="${id}"]`); await A.keyboard.press("Alt+ArrowUp");
  await A.waitForFunction((i) => document.querySelector("#wsList .row.ws").dataset.ws === i, id);
  await B.waitForFunction((i) => document.querySelector("#wsList .row.ws")?.dataset.ws === i, id, { timeout: 10000 });
  return { A: await state(A), B: await state(B) };
});
await step("remove everything → empty state; sending is refused politely; adding brings it back", async () => {
  for (const id of (await (await fetch(BASE + "/workspaces")).json()).map((w) => w.id)) await removeIn(A, id);
  const empty = await state(A);
  const heading = await A.locator(".emptyst h1").innerText();
  await A.fill("#input", "hello"); await A.click("#send");
  await A.waitForFunction(() => /Add a workspace first/.test(document.querySelector("#footL").textContent));
  const runsBefore = (await call("GET", "/runs")).body.runs.length;
  await A.screenshot({ path: join(HERE, "shots", "no-workspace.png") });
  await addIn(A, "Executor", REPO, "work");
  await A.waitForFunction(() => document.querySelector("#cName").textContent === "Executor");
  await B.waitForFunction(() => document.querySelector("#cName").textContent === "Executor" && document.querySelectorAll("#wsList .row.ws").length === 1, null, { timeout: 10000 });
  return { empty, heading, notice: await A.locator("#footL").innerText(), runsCreated: (await call("GET", "/runs")).body.runs.length - runsBefore, restoredA: await state(A), restoredB: await state(B) };
});
writeFileSync(join(HERE, "sync-results.json"), JSON.stringify({ when: new Date().toISOString(), results, pageErrors: errors }, null, 1));
console.log(`\n${results.filter((x) => x.ok).length}/${results.length} passed; page errors: ${errors.length ? errors.join(" | ") : "none"}`);
await b.close();
