// Remove and reorder workspaces through the page: drag and drop, Alt+arrow keys, remove with an
// inline confirm. Checks the order survives a reload, the folders on disk are untouched, Executor
// can't be removed, a workspace with a running worker can't be removed, and a removed
// workspace's run can't be resumed.
//   CANARY=<folder> WORK=<folder> DATA=<console data dir> node bench/workspace-ui/manage-test.mjs <port>
import { chromium } from "../../browser-adapter/node_modules/playwright/index.mjs";
import { writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const [port = "8797"] = process.argv.slice(2);
const BASE = `http://127.0.0.1:${port}`;
const H = { origin: BASE, "x-worker-console": "1", "content-type": "application/json" };
const call = (method, path, data) => fetch(BASE + path, { method, headers: H, body: data ? JSON.stringify(data) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const results = [];
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1280, height: 1008 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail).slice(0, 220)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message); await page.screenshot({ path: join(HERE, "shots", `manage-fail-${results.length}.png`) }); }
};
const order = () => page.locator("#wsList .row.ws .grow .ell").allInnerTexts();
const fileState = (dir) => readdirSync(dir, { recursive: true }).length;
const registry = () => JSON.parse(readFileSync(join(process.env.DATA, "workspaces.json"), "utf8")).map((w) => w.name || w.id);
const status = () => page.innerText("#rState");

const canary = await call("POST", "/workspaces", { name: "Canary", path: process.env.CANARY, mode: "inspect" });
const work = await call("POST", "/workspaces", { name: "Work test", path: process.env.WORK, mode: "work" });
const filesBefore = { canary: fileState(process.env.CANARY), work: fileState(process.env.WORK) };
await page.goto(BASE, { waitUntil: "networkidle" });

await step("starting order", async () => ({ ui: await order() }));
await step("drag Work test above Executor; the order survives a reload", async () => {
  await page.locator('[data-ws-item]:has-text("Work test")').dragTo(page.locator('[data-ws-item]:has-text("Executor")'), { targetPosition: { x: 40, y: 4 } });
  await page.waitForFunction(() => document.querySelector("#wsList .row.ws .grow .ell").textContent === "Work test");
  const after = await order();
  await page.reload({ waitUntil: "networkidle" });
  return { afterDrag: after, afterReload: await order(), registry: registry() };
});
await step("Alt+↓ on Work test moves it down one; focus stays on it", async () => {
  await page.focus('#wsList [data-ws]:has-text("Work test")');
  await page.keyboard.press("Alt+ArrowDown");
  await page.waitForFunction(() => document.querySelectorAll("#wsList .row.ws .grow .ell")[1]?.textContent === "Work test");
  const focused = await page.evaluate(() => document.activeElement?.dataset.ws);
  await page.reload({ waitUntil: "networkidle" });
  return { afterKey: await order(), focusedId: focused, afterReload: await order() };
});
await step("Executor has no remove button, and the API refuses it", async () => {
  await page.hover('[data-ws-item="console"]');
  return { removeButtons: await page.locator('[data-ws-item="console"] [data-rm]').count(), api: await call("DELETE", "/workspaces/console") };
});
await step("remove → Cancel keeps it; remove → Remove takes it off the list; folder untouched", async () => {
  await page.click('#wsList [data-ws]:has-text("Canary")');
  await page.hover('[data-ws-item]:has-text("Canary")');
  await page.click('[data-ws-item]:has-text("Canary") [data-rm]');
  const prompt = await page.locator('#wsList [role="group"]').innerText();
  await page.screenshot({ path: join(HERE, "shots", "remove-confirm.png") });
  await page.click("[data-rm-cancel]");
  const afterCancel = await order();
  await page.hover('[data-ws-item]:has-text("Canary")');
  await page.click('[data-ws-item]:has-text("Canary") [data-rm]');
  await page.click("[data-rm-ok]");
  await page.waitForFunction(() => !document.querySelector("[data-rm-ok]") && ![...document.querySelectorAll("#wsList .row.ws .grow .ell")].some((e) => e.textContent === "Canary"));
  return { confirmText: prompt.replace(/\s+/g, " "), afterCancel, afterRemove: await order(), selectedNow: await page.innerText("#cName"), registry: registry(),
    canaryFolderFiles: [filesBefore.canary, fileState(process.env.CANARY)], canaryStillExists: existsSync(process.env.CANARY) };
});
await step("a workspace with a running worker can't be removed until the run ends", async () => {
  await page.click('#wsList [data-ws]:has-text("Work test")');
  await page.fill("#input", "Reply with exactly: HELLO");
  await page.click("#send");
  await page.waitForFunction(() => document.querySelector("#rState").textContent === "Waiting for you", null, { timeout: 300000 });
  const runId = await page.evaluate(() => runId);
  await page.hover('[data-ws-item]:has-text("Work test")');
  await page.click('[data-ws-item]:has-text("Work test") [data-rm]');
  await page.click("[data-rm-ok]");
  await page.waitForFunction(() => document.querySelector("#rmErr")?.textContent);
  const refused = await page.innerText("#rmErr");
  await page.click("[data-rm-cancel]");
  await page.click("#endBtn");
  await page.waitForFunction(() => document.querySelector("#rState").textContent === "Finished", null, { timeout: 60000 });
  await page.hover('[data-ws-item]:has-text("Work test")');
  await page.click('[data-ws-item]:has-text("Work test") [data-rm]');
  await page.click("[data-rm-ok]");
  await page.waitForFunction(() => !document.querySelector("[data-rm-ok]") && ![...document.querySelectorAll("#wsList .row.ws .grow .ell")].some((e) => e.textContent === "Work test"));
  const resume = await call("POST", `/runs/${runId}/message`, { text: "still there?" });
  return { whileRunning: refused, afterEnd: await order(), selectedNow: await page.innerText("#cName"), resumeRemovedRun: resume,
    workFolderFiles: [filesBefore.work, fileState(process.env.WORK)] };
});
await step("guarded: foreign origin can't remove or reorder; a bad order is refused", async () => {
  const foreign = await fetch(`${BASE}/workspaces/${work.body.id}`, { method: "DELETE", headers: { ...H, origin: "http://evil.example" } });
  const foreignOrder = await fetch(`${BASE}/workspaces/order`, { method: "POST", headers: { ...H, origin: "http://evil.example" }, body: JSON.stringify({ ids: ["console"] }) });
  return { foreignDelete: foreign.status, foreignOrder: foreignOrder.status, badOrder: await call("POST", "/workspaces/order", { ids: ["console", "nope"] }), unknownDelete: (await call("DELETE", "/workspaces/nope")).body };
});
writeFileSync(join(HERE, "manage-results.json"), JSON.stringify({ when: new Date().toISOString(), added: [canary.status, work.status], results, pageErrors: errors }, null, 1));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed; page errors: ${errors.length ? errors.join(" | ") : "none"}`);
await b.close();
