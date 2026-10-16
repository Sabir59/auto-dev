// Model and effort switching, end to end with the real runtime: the composer's model chip lists the
// models this account can use (the runtime's own list_models), a choice for new chats is sent when a
// run starts (--model/--effort), and a choice on an open run switches the live worker (set_model /
// effort setting) or applies when it continues. "Actually switched" is checked against the model
// the runtime itself reports for each turn (its init message) and the model of its replies.
//   DATA=<console data dir> node bench/workspace-ui/model-test.mjs <port>
import { chromium } from "../../browser-adapter/node_modules/playwright/index.mjs";
import { writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const [port = "8797"] = process.argv.slice(2);
const BASE = `http://127.0.0.1:${port}`, DATA = process.env.DATA;
const H = { origin: BASE, "x-worker-console": "1", "content-type": "application/json" };
const call = (method, path, data, headers = H) => fetch(BASE + path, { method, headers, body: data ? JSON.stringify(data) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const results = [];
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail).slice(0, 240)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 300)); await page.screenshot({ path: join(HERE, "shots", `model-fail-${results.length}.png`) }); }
};
const waitStatus = (labels, timeout = 300000) => page.waitForFunction((l) => l.includes(document.querySelector("#rState").textContent), labels, { timeout });
const openMenu = async () => { if (await page.locator("#mdlPop").isHidden()) await page.click("#mdlBtn"); await page.waitForSelector("#mdlPop .mrowm"); };
const chip = async () => (await page.locator("#mdlBtn").innerText()).replace(/\s+/g, " ").trim();
// What the runtime said, per turn: the model in its init message, and the models of its replies
const turns = (id) => { const t = []; for (const l of readFileSync(join(DATA, "runs", `${id}.raw.jsonl`), "utf8").split("\n")) { let m; try { m = JSON.parse(l); } catch { continue; } if (m.type === "system" && m.subtype === "init") t.push({ init: m.model, replies: [] }); if (m.type === "assistant" && t.length) t.at(-1).replies.push(m.message.model); } return t; };
const catalogue = (await call("GET", "/models")).body.models;
const find = (name) => catalogue.find((m) => m.displayName === name);
const haiku = catalogue.find((m) => m.value === "haiku"), sonnet = catalogue.find((m) => m.value === "sonnet");

await page.goto(BASE, { waitUntil: "networkidle" });
await page.click('#wsList [data-ws="scratch"]');
let runId;
await step("the chip opens the models this account can use, as the runtime lists them; Default is selected", async () => {
  await openMenu();
  const names = await page.locator("#mdlPop .mrowm .n").allInnerTexts(), sel = await page.locator('#mdlPop .mrowm[aria-selected="true"] .n').innerText();
  await page.screenshot({ path: join(HERE, "shots", "model-menu.png") });
  must(JSON.stringify(names) === JSON.stringify(catalogue.map((m) => m.displayName)) && /^Default/.test(sel), JSON.stringify({ names, sel }));
  return { models: names.length, first: names.slice(0, 4), selected: sel };
});
await step("Haiku takes no effort level (the menu says so); Sonnet 5 + Low for new chats is remembered across a reload", async () => {
  await page.locator(`#mdlPop [data-model="${haiku.value}"]`).click();
  const noEffort = await page.locator("#mdlPop .effrow").innerText(), dotsForHaiku = await page.locator("#mdlPop .edot").count();
  await page.locator(`#mdlPop [data-model="${sonnet.value}"]`).click();
  await page.locator('#mdlPop [data-effort="low"]').click();
  const before = await chip();
  await page.reload({ waitUntil: "networkidle" });
  const after = await chip();
  must(/not available/.test(noEffort) && dotsForHaiku === 0, noEffort);
  must(/Sonnet 5\s*Low/.test(before) && before === after, JSON.stringify({ before, after }));
  return { haiku: noEffort.replace(/\s+/g, " "), chip: after };
});
await step("a new chat starts on the chosen model and effort (the runtime reports Sonnet 5)", async () => {
  await page.click('#wsList [data-ws="scratch"]');
  await page.fill("#input", "Reply with the single word OK.");
  const req = page.waitForRequest((r) => r.url().endsWith("/runs") && r.method() === "POST");
  await page.click("#send");
  const sent = (await req).postDataJSON();
  await waitStatus(["Waiting for you"]);
  runId = await page.evaluate(() => runId);
  const m = (await call("GET", `/runs/${runId}`)).body, t = turns(runId);
  must(sent.model === "sonnet" && sent.effort === "low" && m.model === "sonnet" && m.effort === "low", JSON.stringify({ sent, m: { model: m.model, effort: m.effort } }));
  must(t[0].init === sonnet.resolvedModel && t[0].replies.every((x) => x === sonnet.resolvedModel), JSON.stringify(t));
  return { sent: { model: sent.model, effort: sent.effort }, runtimeReported: t[0], chip: await chip() };
});
await step("switch the live worker to Haiku 4.5: the next turn runs on Haiku (the runtime's own report)", async () => {
  await openMenu();
  await page.locator(`#mdlPop [data-model="${haiku.value}"]`).click();
  await page.waitForFunction(() => /Haiku/.test(document.querySelector("#mdlBtn").textContent));
  const note = await page.locator("#mdlNote").innerText();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => [...document.querySelectorAll("#acts .card .ct")].some((c) => c.textContent === "Model"));
  const card = await page.locator('#acts .card:has(.ct:text-is("Model"))').last().innerText();
  await page.fill("#input", "Reply with the single word AGAIN.");
  await page.click("#send");
  await waitStatus(["Working"], 30000); await waitStatus(["Waiting for you"]);
  const t = turns(runId), m = (await call("GET", `/runs/${runId}`)).body;
  await page.screenshot({ path: join(HERE, "shots", "model-switched.png") });
  must(/now/.test(note) && /Switched/.test(card), JSON.stringify({ note, card }));
  must(t.at(-1).init === haiku.resolvedModel && t.at(-1).replies.length && t.at(-1).replies.every((x) => x === haiku.resolvedModel) && m.model === "haiku" && m.modelUsed === haiku.resolvedModel, JSON.stringify({ t, model: m.model, used: m.modelUsed }));
  must(!m.effort && !/effort/.test(card), `Haiku takes no effort, but the run kept ${m.effort} (${card})`);
  return { card: card.replace(/\s+/g, " "), runtimeReported: t.at(-1), chip: await chip() };
});
await step("the server refuses what the account or model can't do; another site can't switch a run", async () => {
  const noEffort = await call("POST", `/runs/${runId}/settings`, { model: "haiku", effort: "high" });
  const unknown = await call("POST", `/runs/${runId}/settings`, { model: "gpt-5" });
  const badEffort = await call("POST", `/runs/${runId}/settings`, { effort: "turbo" });
  const foreign = await call("POST", `/runs/${runId}/settings`, { model: "sonnet" }, { ...H, origin: "http://evil.example" });
  const newRun = await call("POST", "/runs", { prompt: "x", workspace: "scratch", model: "nope" });
  const m = (await call("GET", `/runs/${runId}`)).body;
  must(noEffort.status === 400 && unknown.status === 400 && badEffort.status === 400 && foreign.status === 403 && newRun.status === 400 && m.model === "haiku", JSON.stringify({ noEffort, unknown, badEffort, foreign: foreign.status, newRun }));
  return { haikuWithEffort: noEffort.body.error, unknownModel: unknown.body.error, badEffort: badEffort.body.error, foreignOrigin: foreign.status, newRunUnknownModel: newRun.body.error };
});
await step("on an ended run the choice applies when it continues: the resumed worker starts on Sonnet 5 at Medium", async () => {
  await page.click("#endBtn"); await waitStatus(["Finished"], 60000);
  await openMenu();
  await page.locator(`#mdlPop [data-model="${sonnet.value}"]`).click();
  await page.waitForFunction(() => /Sonnet 5/.test(document.querySelector("#mdlBtn").textContent));
  await page.locator('#mdlPop [data-effort="medium"]').click();
  await page.waitForFunction(() => /Medium/.test(document.querySelector("#mdlBtn").textContent));
  const note = await page.locator("#mdlNote").innerText();
  await page.keyboard.press("Escape");
  await page.fill("#input", "Reply with the single word BACK.");
  await page.click("#send");
  await waitStatus(["Working"], 60000); await waitStatus(["Waiting for you"]);
  const t = turns(runId), m = (await call("GET", `/runs/${runId}`)).body;
  await page.click("#endBtn"); await waitStatus(["Finished"], 60000);
  must(/continues/.test(note) && t.at(-1).init === sonnet.resolvedModel && t.at(-1).replies.every((x) => x === sonnet.resolvedModel) && m.model === "sonnet" && m.effort === "medium", JSON.stringify({ note, t: t.at(-1), m: { model: m.model, effort: m.effort } }));
  return { note, runtimeReported: t.at(-1), turnsByModel: t.map((x) => x.init) };
});
await step("a new chat after that still uses the new-chat choice, not the run's", async () => {
  await page.click('#wsList [data-ws="scratch"]');
  const c = await chip();
  must(/Sonnet 5\s*Low/.test(c), c);
  return { chip: c };
});
writeFileSync(join(HERE, "model-results.json"), JSON.stringify({ when: new Date().toISOString(), results, pageErrors: errors }, null, 1));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed; page errors: ${errors.length ? errors.join(" | ") : "none"}`);
await b.close();
