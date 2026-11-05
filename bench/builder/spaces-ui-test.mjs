// The Builder.io page and the worker editor's space picker, in a real browser (Chromium via the browser
// adapter's Playwright), against a console with its own data and the local Builder stand-in.
//   node bench/builder/spaces-ui-test.mjs
// Connect a production space and a test space from the page (the test one only after ticking the
// confirmation), see them listed without keys, give a worker read on one and read-and-write on the
// other in its editor (write can't be picked for production), and see the page list the workers.
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { startMock, KEYS, KEYS_B } from "./mock-builder.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", ".."), SHOTS = join(HERE, "shots"); mkdirSync(SHOTS, { recursive: true });
const { chromium } = createRequire(join(REPO, "browser-adapter", "package.json"))("playwright");
const PORT = 8823, BASE = `http://127.0.0.1:${PORT}`, H = { origin: BASE, "x-worker-console": "1", "content-type": "application/json" };
const ROOT = join(tmpdir(), `bspui-${Date.now()}`), DATA = join(ROOT, "data"); mkdirSync(DATA, { recursive: true });
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const results = [];
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail ?? null).slice(0, 240)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 900)); }
};
const assert = (c, m) => { if (!c) throw new Error(typeof m === "string" ? m : JSON.stringify(m)); };

const mock = await startMock();
const env = { ...process.env, WORKER_CONSOLE_PORT: String(PORT), WORKER_CONSOLE_DATA: DATA, AIW_CREDENTIAL_KEY: randomBytes(32).toString("base64"),
  BUILDER_ADMIN_BASE: `http://127.0.0.1:${mock.port}`, BUILDER_CONTENT_BASE: `http://127.0.0.1:${mock.port}`, BUILDER_WRITE_BASE: `http://127.0.0.1:${mock.port}`,
  BUILDER_ADAPTER_DIR: join(DATA, "builder"), FIGMA_READER_DIR: join(DATA, "figma-reader"), GITHUB_CONNECTOR_DIR: join(DATA, "github"), FIGMA_BRIDGE_PORT: "8824" };
const srv = spawn(process.execPath, [join(REPO, "worker-ui", "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; srv.stdout.on("data", (d) => (log += d)); srv.stderr.on("data", (d) => (log += d));
for (let i = 0; ; i++) { try { await fetch(BASE + "/"); break; } catch { if (i > 80) throw new Error(`console didn't start: ${log.slice(-800)}`); await sleep(250); } }
const call = (m, p, b) => fetch(BASE + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const dir = join(ROOT, "work"); mkdirSync(dir); execFileSync("git", ["init", "-q", dir]); writeFileSync(join(dir, "a.txt"), "a");
await call("POST", "/workspaces", { name: "Work", path: dir, mode: "work" });
const W = (await call("POST", "/workers", { schema: 2, name: "Landing pages", specialization: "Builder pages", mission: "Edit Builder pages", core: ["files.read"], workflow: [], limitations: [], knowledge: "",
  integrations: [{ id: "builder", version: "1.1.0", config: { spaces: [], models: "page", publishing: "drafts", check: "no" } }] })).body;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = []; page.on("pageerror", (e) => errors.push(e.message));
await page.goto(BASE + "/"); await page.waitForSelector("#bdOpen");
const shot = (n) => page.screenshot({ path: join(SHOTS, `${n}.png`) });

await step("the sidebar has Builder.io under Integrations; the page offers Connect when nothing is connected", async () => {
  await page.waitForFunction(() => document.querySelector("#bdState").textContent !== "Builder spaces");
  assert(/Not connected/.test(await page.textContent("#bdState")), await page.textContent("#bdState"));
  await page.click("#bdOpen"); await page.waitForSelector("#bdConnect");
  const text = await page.textContent("#bdBody");
  assert(/No Builder space connected yet/.test(text) && /Public API key/.test(text) && !/README/.test(text), text.slice(0, 300));
  await shot("spaces-ui-empty");
  return { state: await page.textContent("#bdState") };
});

await step("connect a production space (the default), then a test space only after ticking the confirmation", async () => {
  await page.fill("#bdName", "Live site"); await page.fill("#bdPub", KEYS_B.public); await page.fill("#bdPriv", KEYS_B.private);
  await page.click("#bdConnect"); await page.waitForFunction(() => /Connected “Live site”/.test(document.querySelector("#bdMsg")?.textContent || ""));
  await page.waitForFunction(() => document.querySelectorAll(".bdsp").length === 1 && !document.querySelector("#bdName").value); // the page redraws with the new space
  await page.fill("#bdName", "Site (test)"); await page.fill("#bdPub", KEYS.public); await page.fill("#bdPriv", KEYS.private);
  await page.click('[data-bd-env="test"]');
  assert(await page.inputValue("#bdPriv") === KEYS.private, "typed keys were lost when choosing Test");
  await page.click("#bdConnect");
  const refused = await page.textContent("#bdMsg");
  assert(/Tick the confirmation/.test(refused), refused);
  await page.check("#bdAddConfirm"); await page.click("#bdConnect");
  await page.waitForFunction(() => /Connected “Site \(test\)”/.test(document.querySelector("#bdMsg")?.textContent || ""));
  await page.waitForFunction(() => document.querySelectorAll(".bdsp").length === 2);
  const html = await page.content();
  for (const k of [KEYS.private, KEYS_B.private]) assert(!html.includes(k), "a private key is in the page");
  const cards = await page.$$eval(".bdsp", (els) => els.map((e) => e.querySelector(".ih").textContent.replace(/\s+/g, " ").trim()));
  assert(/Live site.*Production: read-only/.test(cards[0]) && /Site \(test\).*Test space/.test(cards[1]), cards);
  assert(/2 spaces/.test(await page.textContent("#bdState")) && /1 test · 1 production/.test(await page.textContent("#bdMeta")), "sidebar");
  await shot("spaces-ui-connected");
  return { cards, sidebar: `${await page.textContent("#bdState")} · ${await page.textContent("#bdMeta")}` };
});

await step("the worker editor lists the connected spaces: write can't be picked for production; read and read-and-write are saved", async () => {
  await page.evaluate((id) => openWorkerEditor(id), W.id);
  await page.waitForSelector('[data-sp="wk"]');
  const ids = (await call("GET", "/builder")).body.spaces.map((s) => [s.label, s.id]), live = ids.find(([l]) => l === "Live site")[1], test = ids.find(([l]) => l === "Site (test)")[1];
  const disabled = await page.$eval(`[data-sp="wk"][data-space="${live}"][data-acc="write"]`, (b) => b.disabled);
  assert(disabled, "write is selectable for a production space");
  assert(/No space given yet/.test(await page.textContent("#wkInts")), "no warning while no space is given");
  await page.click(`[data-sp="wk"][data-space="${live}"][data-acc="read"]`);
  await page.click(`[data-sp="wk"][data-space="${test}"][data-acc="write"]`);
  await shot("spaces-ui-editor");
  await page.click('#wkForm button[type="submit"]');
  await page.waitForFunction(() => /Saved|saved/.test(document.querySelector("#wkMsg")?.textContent || "") || document.body.dataset.view !== "worker", null, { timeout: 8000 }).catch(() => {});
  let saved;
  for (let i = 0; i < 30; i++) { saved = (await call("GET", "/workers")).body.workers.find((w) => w.id === W.id); if ((saved.integrations[0].config.spaces || []).length === 2) break; await sleep(200); }
  assert(saved.integrations[0].config.spaces.slice().sort().join() === [`${live}:read`, `${test}:write`].sort().join(), saved.integrations[0].config);
  const st = saved.status.filter((s) => s.resource === "builder").map((s) => `${s.access}:${s.ok}`);
  assert(st.join() === "read:true,write:true", st);
  return { spaces: saved.integrations[0].config.spaces, status: st };
});

await step("the Builder.io page shows which workers each space is given to; marking a space as test asks for confirmation", async () => {
  await page.click("#bdOpen"); await page.waitForSelector(".bdsp");
  await page.waitForFunction(() => /Landing pages/.test(document.querySelector("#bdBody")?.textContent || ""));
  const cards = await page.$$eval(".bdsp", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ")));
  assert(/Given to: Landing pages \(read\)/.test(cards[0]) && /Given to: Landing pages \(read and write\)/.test(cards[1]), cards);
  await page.locator(".bdsp").first().locator("[data-bd-ask]").click(); await page.waitForSelector("#bdConfirmBox");
  await page.click("[data-bd-test]");
  assert(/Tick the confirmation/.test(await page.textContent("#bdMsg")), "marked as test without confirmation");
  await page.click("[data-bd-cancel]");
  await shot("spaces-ui-workers");
  assert((await call("GET", "/builder")).body.spaces[0].environment === "production", "changed without confirmation");
  return { cards: cards.map((c) => c.slice(0, 120)) };
});

await step("no page errors", async () => { assert(!errors.length, errors); return { errors: errors.length }; });

await browser.close(); srv.kill(); await mock.close();
const passed = results.filter((r) => r.ok).length;
writeFileSync(join(HERE, "spaces-ui-results.json"), JSON.stringify({ at: new Date().toISOString(), passed, failed: results.length - passed, results }, null, 1));
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
