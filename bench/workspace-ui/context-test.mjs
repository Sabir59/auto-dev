// Run telemetry, context warnings, compaction and fresh-session continuation, end to end with the
// real worker in a real browser. Uses Haiku to keep it cheap (none of this depends on the model).
// Every number shown is checked against the runtime's own stream (runs/<id>.raw.jsonl).
//   WORK=<work folder> DATA=<console data dir> node bench/workspace-ui/context-test.mjs <port>
import { chromium } from "../../browser-adapter/node_modules/playwright/index.mjs";
import { writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const [port = "8797"] = process.argv.slice(2);
const BASE = `http://127.0.0.1:${port}`, { WORK, DATA } = process.env;
const H = { origin: BASE, "x-worker-console": "1", "content-type": "application/json" };
const call = (method, path, data) => fetch(BASE + path, { method, headers: H, body: data ? JSON.stringify(data) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const must = (c, m) => { if (!c) throw new Error(m); };
const results = [];
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const step = async (name, fn) => { try { const d = await fn(); results.push({ step: name, ok: true, detail: d }); console.log("PASS", name, JSON.stringify(d).slice(0, 240)); } catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 300)); await page.screenshot({ path: join(HERE, "shots", `context-fail-${results.length}.png`) }); } };
const waitStatus = (labels, timeout = 300000) => page.waitForFunction((l) => l.includes(document.querySelector("#rState").textContent), labels, { timeout });
const meta = async (id) => (await call("GET", `/runs/${id}`)).body;
const raw = (id) => readFileSync(join(DATA, "runs", `${id}.raw.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
const events = (id) => readFileSync(join(DATA, "runs", `${id}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const transcript = (session) => { const p = join(homedir(), ".claude", "projects"); for (const d of require_readdir(p)) { const f = join(p, d, `${session}.jsonl`); if (existsSync(f)) return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } return []; };
import { readdirSync as require_readdir } from "node:fs";
const SENTINEL = "SENTINEL-TRANSCRIPT-ONLY-4471", SFILE = join(WORK, "context-sentinel.txt");
writeFileSync(SFILE, Array.from({ length: 60 }, (_, i) => (i === 30 ? `line ${i}: ${SENTINEL}` : `line ${i}: filler text for the context test`)).join("\n") + "\n");

await page.goto(BASE, { waitUntil: "networkidle" });
const work = (await call("POST", "/workspaces", { name: "Work test", path: WORK, mode: "work" })).body;
await page.reload({ waitUntil: "networkidle" });
await page.click(`#wsList [data-ws="${work.id}"]`);
await page.evaluate(() => { localStorage.setItem("model", "haiku"); localStorage.setItem("effort", ""); });
await page.reload({ waitUntil: "networkidle" });
let runId;
await step("the Context & usage card shows the runtime's context and token numbers, and measured tool counts, matching the raw stream", async () => {
  await page.fill("#input", "Read README.md, src/math.js and context-sentinel.txt, then reply with the total number of lines in the three files. Nothing else.");
  await page.click("#send");
  await waitStatus(["Waiting for you"]);
  runId = await page.evaluate(() => runId);
  await page.waitForSelector("#telCard");
  const m = await meta(runId), t = m.telemetry, r = raw(runId);
  const ids = new Set(), uses = []; let lastCtx = 0;
  for (const x of r) if (x.type === "assistant") { if (!ids.has(x.message.id)) { ids.add(x.message.id); const u = x.message.usage; lastCtx = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens; } for (const c of x.message.content) if (c.type === "tool_use" && c.name !== "ToolSearch") uses.push(c.name); }
  const res = r.filter((x) => x.type === "result").at(-1), mu = Object.values(res.modelUsage)[0];
  const card = await page.locator("#telCard").innerText();
  must(t.modelRequests === ids.size && t.tools.total === uses.length && t.context.last === lastCtx && t.tokens.cacheRead === mu.cacheReadInputTokens && t.context.window === mu.contextWindow, JSON.stringify({ t, ids: ids.size, uses: uses.length, lastCtx, mu }));
  must(/Context per request/.test(card) && /RUNTIME/i.test(card) && /MEASURED/i.test(card) && /document reads/.test(card), card);
  await page.screenshot({ path: join(HERE, "shots", "context-card.png") });
  return { modelRequests: t.modelRequests, tools: t.tools.total, context: t.context, tokens: t.tokens, card: card.replace(/\s+/g, " ").slice(0, 260) };
});
await step("a context warning fires at a configurable threshold (console-settings.json), and is labelled in the card", async () => {
  const none = events(runId).filter((e) => e.type === "context").length;
  writeFileSync(join(DATA, "console-settings.json"), JSON.stringify({ contextWarnTokens: 3000, autoFreshSession: false }));
  await page.fill("#input", "DECISION: the accent colour is #FF6B35. Acknowledge with the single word NOTED.");
  await page.click("#send");
  await waitStatus(["Working"], 30000); await waitStatus(["Waiting for you"]);
  const warns = events(runId).filter((e) => e.type === "context");
  await page.waitForSelector("#telContext.warn");
  const card = await page.locator('#acts .card:has(.ct:text-is("Context warning"))').first().innerText();
  must(none === 0 && warns.length >= 1 && /warning at 3k/.test(warns[0].summary), JSON.stringify({ none, warns }));
  return { beforeSetting: none, warning: warns[0].summary, card: card.replace(/\s+/g, " ").slice(0, 160) };
});
let preCompact;
await step("Compact (the card's button): Claude Code compacts, the context drops, and the decision survives", async () => {
  preCompact = (await meta(runId)).telemetry.context.last;
  await page.click('#telCard [data-tel="compact"]');
  await page.waitForSelector('#acts .card:has(.ct:text-is("Compacted"))', { timeout: 180000 });
  await waitStatus(["Waiting for you"]);
  const t = (await meta(runId)).telemetry, c = t.compactions.at(-1);
  await page.fill("#input", "What accent colour was decided? Reply with the hex value only.");
  await page.click("#send");
  await waitStatus(["Working"], 30000); await waitStatus(["Waiting for you"]);
  const reply = await page.locator(".msg-w").last().innerText();
  must(c && c.trigger === "manual" && c.post < c.pre && /FF6B35/i.test(reply), JSON.stringify({ c, reply }));
  return { compaction: c, replyAfter: reply.trim() };
});
let nextId;
await step("Continue in a fresh session: a handoff (task state + the worker's summary) starts a new run; the old run keeps its history", async () => {
  await page.fill("#input", "Reply with the accent colour's hex value, then a line starting DONE:.");
  await page.click('#telCard [data-tel="continue"]');
  await page.waitForSelector('#acts .card:has(.ct:text-is("Continued"))', { timeout: 300000 });
  const old = await meta(runId);
  nextId = old.continuedIn;
  const next = await meta(nextId), st = (await call("GET", `/runs/${nextId}/state`)).body, oldState = (await call("GET", `/runs/${runId}/state`)).body;
  const handoff = JSON.parse(readFileSync(join(DATA, "runs", `${nextId}.handoff.json`), "utf8"));
  const first = events(nextId).find((e) => e.type === "user").summary;
  must(nextId && next.continuedFrom === runId && st.continuedFrom === runId && handoff.from === runId && handoff.workerSummary, JSON.stringify({ nextId, cf: next.continuedFrom }));
  must(/Original objective/.test(first) && /context-sentinel\.txt/.test(first) && /FF6B35/i.test(first) && /Reply with the accent colour/.test(first), first.slice(0, 600));
  must(oldState.objective && [...oldState.requests, ...oldState.milestones].some((x) => /FF6B35/.test(x.text)) && existsSync(join(DATA, "runs", `${runId}.raw.jsonl`)), JSON.stringify(oldState).slice(0, 300));
  return { newRun: nextId, handoffChars: first.length, oldRequests: oldState.requests.map((x) => x.text), oldMilestones: oldState.milestones.map((x) => `${x.tag}: ${x.text}`), workerSummaryChars: handoff.workerSummary.length };
});
await step("the new session got the handoff, not the old transcript: no old tool output in it, and a smaller first context than the old run reached", async () => {
  await page.click(`#acts [data-open-run="${nextId}"]`);
  // Wait on the new run itself (the status line can still show the old run for a moment).
  let m;
  for (let i = 0; i < 300; i++) { m = await meta(nextId); if (m.sessionId && !["starting", "running"].includes(m.status)) break; await new Promise((r) => setTimeout(r, 1000)); }
  await waitStatus(["Waiting for you", "Finished"]);
  const oldM = await meta(runId);
  // Claude Code writes its transcript file asynchronously: wait until the first message is on disk.
  let tr = [];
  for (let i = 0; i < 60 && !tr.some((e) => e.type === "user" && !e.isMeta); i++) { tr = transcript(m.sessionId); if (!tr.some((e) => e.type === "user" && !e.isMeta)) await new Promise((r) => setTimeout(r, 500)); }
  const users = tr.filter((e) => e.type === "user" && !e.isMeta).map((e) => ({ message: { content: typeof e.message?.content === "string" ? e.message.content : (e.message?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n") } })).filter((u) => u.message.content);
  const firstCtx = (() => { for (const x of raw(nextId)) if (x.type === "assistant") { const u = x.message.usage; return u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens; } })();
  const reply = await page.locator(".msg-w").last().innerText();
  // The old run read a 60-line file; the worker's handoff may mention facts from it, but the raw
  // tool output (its filler lines) must not reach the new session: it gets the handoff only.
  const handoffSent = events(nextId).find((e) => e.type === "user").summary, newFirstInput = users[0]?.message.content || "";
  const rawOldOutput = "line 45: filler text for the context test";
  must(JSON.stringify(raw(runId)).includes(rawOldOutput) && !JSON.stringify(tr).includes(rawOldOutput), "raw tool output from the old run reached the new session (or the old run never read the file)");
  must(newFirstInput.startsWith(handoffSent.slice(0, 200)) && /Original objective/.test(newFirstInput) && /FF6B35/i.test(reply), JSON.stringify({ users: users.length, reply }));
  must(firstCtx < oldM.telemetry.context.max, `new session's first request carried ${firstCtx} tokens, the old run up to ${oldM.telemetry.context.max}`);
  return { oldMaxContext: oldM.telemetry.context.max, newFirstContext: firstCtx, firstInputIsTheHandoff: true, oldRawToolOutputInNew: false, reply: reply.trim().slice(0, 120) };
});
await step("compact and continue are refused while the worker is mid-step; Stop still works; the run then resumes", async () => {
  await page.click(`#runList [data-run="${nextId}"]`).catch(() => {});
  await page.fill("#input", "Read README.md, then src/math.js, then context-sentinel.txt, one at a time, and after each one write a 150-word essay about it.");
  await page.click("#send");
  await waitStatus(["Working"], 60000);
  const c = await call("POST", `/runs/${nextId}/compact`, {}), k = await call("POST", `/runs/${nextId}/continue`, {});
  await page.click("#send"); // the send button is Stop while working
  await waitStatus(["Stopped"], 60000);
  await page.fill("#input", "Reply with the single word BACK.");
  await page.click("#send");
  await waitStatus(["Working"], 60000); await waitStatus(["Waiting for you"]);
  const reply = await page.locator(".msg-w").last().innerText();
  await page.click("#endBtn"); await waitStatus(["Finished"], 60000);
  must(c.status === 400 && k.status === 400 && /middle of a step/.test(c.body.error) && /BACK/.test(reply), JSON.stringify({ c, k, reply }));
  return { compactWhileBusy: c.body.error, continueWhileBusy: k.body.error, afterStopAndResume: reply.trim() };
});
await step("cost is counted once: the run's cost equals the runtime's own per-process totals, not their running sum", async () => {
  // The runtime's total_cost_usd is a running total per worker process; a drop marks a new process.
  let sum = 0, last = 0, runningSum = 0;
  for (const x of raw(runId)) if (x.type === "result") { const c = x.total_cost_usd || 0; runningSum += c; if (c < last) sum += last; last = c; }
  sum += last;
  const m = await meta(runId);
  must(Math.abs(m.costUsd - sum) < 1e-9 && runningSum > sum, JSON.stringify({ shown: m.costUsd, runtime: sum, oldWay: runningSum }));
  return { shown: m.costUsd, runtimePerProcessTotals: sum, whatTheOldCodeWouldShow: runningSum };
});
rmSync(SFILE, { force: true }); rmSync(join(DATA, "console-settings.json"), { force: true });
writeFileSync(join(HERE, "context-results.json"), JSON.stringify({ when: new Date().toISOString(), results, pageErrors: errors }, null, 1));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed; page errors: ${errors.length ? errors.join(" | ") : "none"}`);
await b.close();
