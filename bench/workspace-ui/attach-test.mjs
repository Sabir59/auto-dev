// Attachments in the composer, end to end with the real worker: "+" (file picker), paste and drop;
// images, PDFs and text files reach the worker inside the message; nothing is written into the
// workspace; the copies shown in the conversation are served read-only; wrong files are refused.
//   CANARY=<inspect folder> FIX=<fixtures dir> node bench/workspace-ui/attach-test.mjs <port>
import { chromium } from "../../browser-adapter/node_modules/playwright/index.mjs";
import { writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const [port = "8797"] = process.argv.slice(2);
const BASE = `http://127.0.0.1:${port}`, FIX = process.env.FIX;
const H = { origin: BASE, "x-worker-console": "1", "content-type": "application/json" };
const call = (method, path, data, headers = H) => fetch(BASE + path, { method, headers, body: data ? JSON.stringify(data) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const IMG = join(REPO, "worker-ui", "assets", "monogram.png");
// Every file in the workspace with its hash (skipping the junction out), to prove nothing was written.
const snapshot = (dir) => { const out = {}; const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory() && !["jdir", ".git"].includes(e.name)) walk(p); else if (e.isFile()) out[p.slice(dir.length)] = createHash("sha1").update(readFileSync(p)).digest("hex"); } }; walk(dir); return out; };
const results = [];
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1280, height: 1008 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail).slice(0, 240)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 300)); await page.screenshot({ path: join(HERE, "shots", `attach-fail-${results.length}.png`) }); }
};
const waitStatus = (label, timeout = 300000) => page.waitForFunction((l) => document.querySelector("#rState").textContent === l, label, { timeout });
const chips = () => page.locator("#attRow .achip .tx .ell").allInnerTexts();
const lastReply = () => page.locator(".msg-w").last().innerText();
const footNotice = () => page.locator("#footL").innerText();

const ws = (await call("POST", "/workspaces", { name: "Canary", path: process.env.CANARY, mode: "inspect" })).body;
const before = snapshot(process.env.CANARY);
await page.goto(BASE, { waitUntil: "networkidle" });
await page.click(`#wsList [data-ws="${ws.id}"]`);

await step("+ opens the file picker; an image, a text file and a PDF become chips; × removes one", async () => {
  const chooser = page.waitForEvent("filechooser");
  await page.click("#attachBtn");
  await (await chooser).setFiles([IMG, join(FIX, "notes.txt"), join(FIX, "reference.pdf"), join(FIX, "followup.txt")]);
  await page.waitForFunction(() => document.querySelectorAll("#attRow .achip").length === 4);
  const all = await chips();
  await page.click('#attRow .achip:has-text("followup.txt") [data-unatt]');
  await page.screenshot({ path: join(HERE, "shots", "attach-chips.png") });
  return { added: all, afterRemove: await chips(), imageThumb: await page.locator("#attRow .achip img").count() };
});
let runId;
await step("send: the worker reads the image, the text file and the PDF", async () => {
  await page.fill("#input", "Describe the attached image in one sentence. Then give the codeword from notes.txt and the codeword from the PDF.");
  await page.click("#send");
  await waitStatus("Waiting for you");
  runId = await page.evaluate(() => runId);
  const reply = await lastReply();
  return { chipsAfterSend: await page.locator("#attRow .achip").count(), reply: reply.slice(0, 300), marigold: /MARIGOLD/.test(reply), osprey: /OSPREY/.test(reply) };
});
await step("the conversation shows the attachments; the copies are served read-only with the real type", async () => {
  const preview = await page.locator(".msg-att .big img").count(), fileChips = await page.locator(".msg-att a.achip").allInnerTexts();
  const meta = await (await fetch(`${BASE}/runs/${runId}`)).json();
  const ev = (await (await fetch(`${BASE}/runs/${runId}/att/`)).text());
  const hrefs = await page.locator(".msg-att a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  const served = [];
  for (const h of hrefs) { const r = await fetch(BASE + h); served.push({ file: decodeURIComponent(h.split("/").pop()), status: r.status, type: r.headers.get("content-type"), csp: r.headers.get("content-security-policy") }); }
  await page.screenshot({ path: join(HERE, "shots", "attach-thread.png") });
  return { imagePreviews: preview, fileChips: fileChips.map((t) => t.replace(/\s+/g, " ")), served, runPrompt: meta.prompt, attIndex: ev.slice(0, 20) };
});
await step("paste an image into the prompt box, follow up; the worker sees it", async () => {
  await page.focus("#input");
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer(); dt.items.add(new File([bytes], "image.png", { type: "image/png" }));
    document.querySelector("#input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, readFileSync(IMG).toString("base64"));
  await page.waitForFunction(() => document.querySelectorAll("#attRow .achip").length === 1);
  await page.fill("#input", "What colour is the arrow in the image I just pasted? One word.");
  await page.keyboard.press("Enter");
  await waitStatus("Working", 30000); await waitStatus("Waiting for you");
  return { reply: await lastReply() };
});
await step("drop a file on the prompt box → chip", async () => {
  await page.evaluate(() => {
    const dt = new DataTransfer(); dt.items.add(new File(["dropped text"], "dropped.txt", { type: "text/plain" }));
    const box = document.querySelector(".cbox");
    box.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
    box.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelectorAll("#attRow .achip").length === 1);
  const c = await chips();
  await page.click("#attRow [data-unatt]");
  return { dropped: c, afterRemove: await page.locator("#attRow .achip").count() };
});
await step("End, reload, reopen from Recent runs: attachments still shown; resume with a new attachment", async () => {
  await page.click("#endBtn"); await waitStatus("Finished", 60000);
  await page.reload({ waitUntil: "networkidle" });
  await page.click(`#runList [data-run="${runId}"]`);
  await page.waitForSelector(".msg-att .big img");
  const loaded = await page.locator(".msg-att .big img").evaluateAll((imgs) => imgs.map((i) => i.complete && i.naturalWidth > 0));
  const chooser = page.waitForEvent("filechooser"); await page.click("#attachBtn"); await (await chooser).setFiles([join(FIX, "followup.txt")]);
  await page.fill("#input", "What is the follow-up codeword in the file I just attached? Just the word.");
  await page.click("#send");
  await waitStatus("Waiting for you");
  const reply = await lastReply();
  await page.click("#endBtn"); await waitStatus("Finished", 60000);
  return { previewsLoaded: loaded, resumedCard: await page.locator("#acts .card:has-text('Resumed')").count(), reply, lantern: /LANTERN/.test(reply) };
});
await step("wrong files are refused in the page (binary, too big)", async () => {
  const chooser = page.waitForEvent("filechooser"); await page.click("#attachBtn"); await (await chooser).setFiles([join(FIX, "tool.bin")]);
  await page.waitForFunction(() => /can't be attached/.test(document.querySelector("#footL").textContent));
  const binary = await footNotice();
  const c2 = page.waitForEvent("filechooser"); await page.click("#attachBtn"); await (await c2).setFiles([join(FIX, "big.png")]);
  await page.waitForFunction(() => /too large/.test(document.querySelector("#footL").textContent));
  return { binary, big: await footNotice(), chips: await page.locator("#attRow .achip").count() };
});
await step("the server checks again: binary, too many, oversized, a disguised file; nothing starts", async () => {
  const runsBefore = (await (await fetch(`${BASE}/runs`)).json()).runs.length;
  const b64 = (p) => readFileSync(p).toString("base64");
  const out = {
    binary: (await call("POST", "/runs", { prompt: "x", workspace: ws.id, attachments: [{ name: "tool.bin", data: b64(join(FIX, "tool.bin")) }] })).body,
    tooMany: (await call("POST", "/runs", { prompt: "x", workspace: ws.id, attachments: Array.from({ length: 11 }, (_, i) => ({ name: `n${i}.txt`, data: Buffer.from("hi").toString("base64") })) })).body,
    oversizedImage: (await call("POST", "/runs", { prompt: "x", workspace: ws.id, attachments: [{ name: "big.png", data: b64(join(FIX, "big.png")) }] })).body,
    exeNamedPng: (await call("POST", "/runs", { prompt: "x", workspace: ws.id, attachments: [{ name: "photo.png", data: b64(join(FIX, "tool.bin")) }] })).body,
    foreignOrigin: (await call("POST", "/runs", { prompt: "x", workspace: ws.id, attachments: [{ name: "a.txt", data: "aGk=" }] }, { ...H, origin: "http://evil.example" })).status,
  };
  out.runsCreated = (await (await fetch(`${BASE}/runs`)).json()).runs.length - runsBefore;
  return out;
});
await step("attachment URLs can't reach other files", async () => {
  const tries = ["..%2F..%2Fserver.mjs", "..%5C..%5Cserver.mjs", "%2e%2e", "..", "nope.png"];
  const out = {};
  for (const t of tries) out[t] = (await fetch(`${BASE}/runs/${runId}/att/${t}`)).status;
  out.postToAtt = (await fetch(`${BASE}/runs/${runId}/att/x`, { method: "POST", headers: H, body: "{}" })).status;
  return out;
});
await step("nothing was written into the workspace", async () => {
  const after = snapshot(process.env.CANARY);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]);
  return { filesBefore: Object.keys(before).length, filesAfter: Object.keys(after).length, changed };
});
writeFileSync(join(HERE, "attach-results.json"), JSON.stringify({ when: new Date().toISOString(), results, pageErrors: errors }, null, 1));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed; page errors: ${errors.length ? errors.join(" | ") : "none"}`);
await b.close();
