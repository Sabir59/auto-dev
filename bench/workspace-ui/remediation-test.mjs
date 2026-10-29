// The UX remediation (docs/ux-remediation.md), checked in a real browser against a test console
// and, where the behaviour comes from the runtime, the real worker (Haiku, to keep it cheap).
// Everything it changes is disposable: the suite's own console data dir, the WORK fixture folder,
// and a throwaway Git repository it creates next to the data dir.
//   CANARY=<inspect folder> WORK=<work folder> DATA=<console data dir> node bench/workspace-ui/remediation-test.mjs <port>
import { chromium } from "../../browser-adapter/node_modules/playwright/index.mjs";
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const [port = "8797"] = process.argv.slice(2);
const BASE = `http://127.0.0.1:${port}`, { CANARY, WORK, DATA } = process.env;
const H = { origin: BASE, "x-worker-console": "1", "content-type": "application/json" };
const call = (method, path, data) => fetch(BASE + path, { method, headers: H, body: data ? JSON.stringify(data) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const must = (c, m) => { if (!c) throw new Error(m); };
const results = [], errors = [];
const b = await chromium.launch();
let page = await b.newPage({ viewport: { width: 1280, height: 1000 } });
page.on("pageerror", (e) => errors.push(e.message));
const shot = (n) => page.screenshot({ path: join(HERE, "shots", n) });
const step = async (name, fn) => {
  try { const d = await fn(); results.push({ step: name, ok: true, detail: d }); console.log("PASS", name, JSON.stringify(d ?? null).slice(0, 220)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 300)); await page.screenshot({ path: join(HERE, "shots", `remediation-fail-${results.length}.png`) }).catch(() => {}); }
};
const status = () => page.evaluate(() => ({ status: document.querySelector("#runChip").dataset.status, outcome: document.querySelector("#runChip").dataset.outcome, label: document.querySelector("#rState").textContent }));
const waitLife = (st, timeout = 300000) => page.waitForFunction((s) => s.includes(document.querySelector("#runChip").dataset.status), [].concat(st), { timeout });
const dialog = () => page.evaluate(() => new Promise((ok) => setTimeout(() => ok(document.getElementById("dlg").open ? document.getElementById("dlgT").textContent : null), 250)));
const meta = async (id) => (await call("GET", `/runs/${id}`)).body;
const runIdNow = () => page.evaluate(() => runId);
const sendText = async (t) => { await page.fill("#input", t); await page.click("#send"); };

await page.goto(BASE, { waitUntil: "networkidle" });
const work = (await call("POST", "/workspaces", { name: "Work test", path: WORK, mode: "work" })).body;
const canary = (await call("POST", "/workspaces", { name: "Canary", path: CANARY, mode: "inspect" })).body;
await page.evaluate(() => { localStorage.setItem("model", "haiku"); localStorage.setItem("effort", ""); });
await page.reload({ waitUntil: "networkidle" });
await page.click(`#wsList [data-ws="${work.id}"]`);

// ---- A. drafts and destructive actions (no worker) ----
await step("UX-001: Escape on a worker page with unsaved changes asks; Keep editing keeps the draft", async () => {
  await page.click("#addWk"); await page.click("#wkBlank"); await page.waitForSelector("#wkForm");
  await page.fill("#wkN", "Draft Worker"); await page.fill("#wkK", "Knowledge typed but not saved");
  await page.keyboard.press("Escape");
  const t = await dialog(); must(t === "Unsaved changes", `dialog: ${t}`);
  await shot("remediation-unsaved.png");
  await page.click('#dlg [data-dlg="keep"]');
  const v = { view: await page.evaluate(() => view), knowledge: await page.inputValue("#wkK") };
  must(v.view === "worker" && v.knowledge === "Knowledge typed but not saved", JSON.stringify(v));
  return v;
});
await step("UX-001: leaving through the sidebar asks; Discard leaves without saving", async () => {
  await page.click(`#wsList [data-ws="${canary.id}"]`);
  must((await dialog()) === "Unsaved changes", "no dialog on sidebar navigation");
  must(await page.evaluate(() => view) === "worker", "navigated before the answer");
  await page.click('#dlg [data-dlg="discard"]');
  await page.waitForFunction((id) => wsId === id && view === "chat", canary.id);
  const saved = (await call("GET", "/workers")).body.workers.some((w) => w.name === "Draft Worker");
  must(!saved, "a discarded draft was saved");
  return { view: "chat", workspace: canary.name, saved };
});
await step("UX-001: New task (Alt+N) from a changed page asks; Save keeps the work, then goes on", async () => {
  await page.click("#addWk"); await page.click("#wkBlank"); await page.waitForSelector("#wkForm");
  await page.fill("#wkN", "Saved On Leave"); await page.fill("#wkM", "Made by the remediation test");
  await page.keyboard.press("Alt+N");
  must((await dialog()) === "Unsaved changes", "Alt+N didn't ask");
  await page.click('#dlg [data-dlg="save"]');
  await page.waitForFunction(() => view === "chat" && !runId, null, { timeout: 15000 });
  const w = (await call("GET", "/workers")).body.workers.find((x) => x.name === "Saved On Leave");
  must(w, "not saved");
  return { saved: w.name, version: w.version };
});
await step("UX-001: an unchanged page closes with Escape without asking", async () => {
  await page.click('#wkList .wkr:has-text("Saved On Leave") [data-wk-edit]'); await page.waitForSelector("#wkForm");
  await page.keyboard.press("Escape");
  const t = await dialog(); await page.waitForFunction(() => view === "chat");
  must(t === null, `asked: ${t}`);
  return { asked: false };
});
await step("UX-013: every defined worker has a visible Edit control (not hover-only); General says it has no definition", async () => {
  const vis = await page.locator("#wkList [data-wk-edit]").evaluateAll((els) => els.map((e) => getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0));
  const general = await page.locator('#wkList [data-wk=""]').innerText();
  must(vis.length >= 1 && vis.every(Boolean) && /no definition/.test(general), JSON.stringify({ vis, general }));
  return { editButtons: vis.length, general: general.replace(/\s+/g, " ") };
});
await step("UX-017: Clear learnings asks; Cancel keeps it, confirming clears it", async () => {
  const w = (await call("GET", "/workers")).body.workers.find((x) => x.name === "Saved On Leave");
  mkdirSync(join(DATA, "workers"), { recursive: true });
  writeFileSync(join(DATA, "workers", `${w.id}.memory.json`), JSON.stringify([{ text: "The client prefers British English", at: new Date().toISOString() }, { text: "Staging is at staging.example", at: new Date().toISOString() }]));
  await page.click('#wkList .wkr:has-text("Saved On Leave") [data-wk-edit]'); await page.waitForSelector("#wkMemClear");
  await page.click("#wkMemClear"); must(/Clear 2 learnings/.test((await dialog()) || ""), "no confirmation");
  await page.click('#dlg [data-dlg="cancel"]'); await page.waitForTimeout(300);
  const kept = (await call("GET", `/workers/${w.id}/memory`)).body.length;
  await page.click("#wkMemClear"); await dialog(); await page.click('#dlg [data-dlg="clear"]');
  await page.waitForFunction(() => /Nothing yet/.test(document.querySelector("#wkMem")?.textContent || ""));
  const after = (await call("GET", `/workers/${w.id}/memory`)).body.length;
  await page.click("#vClose");
  must(kept === 2 && after === 0, JSON.stringify({ kept, after }));
  return { afterCancel: kept, afterConfirm: after };
});
await step("UX-006: opening a team only shows it; Work with this team enters it; Leave team is visible", async () => {
  const t = (await call("POST", "/teams", { name: "Remediation team", workers: [(await call("GET", "/workers")).body.workers[0].id], workspace: work.id })).body;
  await page.reload({ waitUntil: "networkidle" });
  const before = await page.evaluate(() => ({ tmId, wsId, wkId }));
  await page.click(`#tmList [data-tm="${t.id}"]`); await page.waitForSelector("#tmForm");
  const viewing = await page.evaluate(() => ({ tmId, wsId, wkId }));
  must(JSON.stringify(before) === JSON.stringify(viewing), `viewing changed context: ${JSON.stringify({ before, viewing })}`);
  await page.click("#tmEnter");
  await page.waitForFunction((id) => tmId === id && view === "chat", t.id);
  const inTeam = { who: await page.innerText("#wkName"), leave: await page.locator("#cLeave").isVisible() };
  await page.click("#cLeave");
  const left = await page.evaluate(() => tmId);
  must(/Remediation team/.test(inTeam.who) && inTeam.leave && left === null, JSON.stringify({ inTeam, left }));
  await call("DELETE", `/teams/${t.id}`);
  return { viewingKeptContext: true, inTeam, left };
});

// ---- B. lifecycle states from the runtime (real worker) ----
let R;
await page.click(`#wsList [data-ws="${work.id}"]`);
await page.click('#wkList [data-wk=""]'); // the General worker (saving a worker above selected that one, which only reads)
await step("UX-003: a turn the worker reports DONE shows Done (data-outcome=done), from the server's outcome", async () => {
  await sendText("Reply with exactly this one line and nothing else: DONE: nothing needed doing");
  await waitLife(["running", "starting"], 60000); await waitLife("waiting");
  R = await runIdNow();
  await page.waitForFunction(() => document.querySelector("#runChip").dataset.outcome === "done", null, { timeout: 10000 });
  const s = await status(), m = await meta(R);
  must(s.label === "Done" && m.outcome === "done", JSON.stringify({ s, outcome: m.outcome }));
  return { ...s, serverOutcome: m.outcome };
});
await step("UX-003: a turn that NEEDS something shows Needs your action, distinct from Done; the run list says so too", async () => {
  await sendText("Reply with exactly this one line and nothing else: NEEDS: read access to the staging database");
  await waitLife(["running", "starting"], 60000); await waitLife("waiting");
  await page.waitForFunction(() => document.querySelector("#runChip").dataset.outcome === "needs", null, { timeout: 10000 });
  const s = await status(), m = await meta(R), row = await page.locator(`#runList [data-run="${R}"] .meta`).innerText();
  must(s.label === "Needs your action" && m.outcome === "needs" && /Needs your action/.test(row), JSON.stringify({ s, outcome: m.outcome, row }));
  await shot("remediation-needs.png");
  return { ...s, serverOutcome: m.outcome, runRow: row };
});
await step("UX-003: a plain reply shows Your turn; the header pill names the conversation's state and workspace", async () => {
  await sendText("Reply with the single word OK.");
  await waitLife(["running", "starting"], 60000); await waitLife("waiting");
  await page.waitForFunction(() => document.querySelector("#runChip").dataset.outcome === "replied", null, { timeout: 10000 });
  const s = await status(), pill = await page.innerText("#wState");
  must(s.label === "Your turn" && /Your turn · Work test/.test(pill), JSON.stringify({ s, pill }));
  return { ...s, pill };
});
await step("UX-008: one counting rule: the reply's summary, its Activity rows and its finish row agree", async () => {
  await sendText("Read README.md, then reply with its first line only.");
  await waitLife(["running", "starting"], 60000); await waitLife("waiting");
  await page.waitForTimeout(500);
  const c = await page.evaluate(() => {
    const groups = [...document.querySelectorAll("#acts .tgrp")], g = groups[groups.length - 1];
    const tools = g.querySelectorAll(".card.k-tool").length, end = g.querySelector(".card.k-end .cb")?.textContent || "";
    const sums = [...document.querySelectorAll(".xsum")], sum = sums[sums.length - 1]?.textContent || "";
    return { tools, end, sum, earlierFolded: groups.slice(0, -1).every((x) => !x.querySelector("details").open) };
  });
  const n = (s) => Number((/(\d+) actions?/.exec(s) || [])[1]);
  must(c.tools >= 1 && n(c.end) === c.tools && n(c.sum) === c.tools && c.earlierFolded, JSON.stringify(c));
  return c;
});
await step("UX-004/011: with a conversation open, a new task says before sending that it will close it; the run is findable from anywhere", async () => {
  await page.click("#newTask");
  await page.click(`#wsList [data-ws="${canary.id}"]`);
  const note = await page.locator("#runNote").innerText(), inList = await page.locator(`#runList [data-run="${R}"]`).count();
  await page.click('#leftNav .scope [data-scope="all"]');
  const inAll = await page.locator(`#runList [data-run="${R}"]`).count();
  await page.click('#leftNav .scope [data-scope="ws"]');
  must(/Sending here closes it/.test(note) && inList === 0 && inAll === 1, JSON.stringify({ note, inList, inAll }));
  await page.click("#wPill"); await page.waitForFunction((id) => runId === id, R);
  return { note, listedInCanary: inList, listedInAll: inAll, pillOpened: true };
});
await step("UX-005: while the worker works, Send is disabled, Stop is separate, and Enter keeps the message in the box", async () => {
  await sendText("Write a 600-word essay about lighthouses, in plain prose.");
  await waitLife(["running", "starting"], 60000);
  await page.fill("#input", "my next instruction");
  await page.press("#input", "Enter");
  const s = { send: await page.locator("#send").isDisabled(), stop: await page.locator("#stopBtn").isVisible(), box: await page.inputValue("#input"), life: (await status()).status, note: await page.innerText("#footL") };
  must(s.send && s.stop && s.box === "my next instruction" && ["running", "starting"].includes(s.life) && /still working/.test(s.note), JSON.stringify(s));
  return s;
});
await step("UX-004: a busy conversation is never closed by another task: the attempt is refused with a link to it", async () => {
  await page.click("#newTask");
  await page.click(`#wsList [data-ws="${canary.id}"]`);
  const note = await page.locator("#runNote").innerText();
  await sendText("Say hello.");
  await page.waitForFunction(() => /busy with/.test(document.querySelector("#footL").textContent), null, { timeout: 10000 });
  const foot = await page.innerText("#footL"), link = await page.locator("#footL [data-open-run]").count(), still = (await meta(R)).status;
  must(/busy with/.test(note) && link === 1 && ["running", "starting"].includes(still), JSON.stringify({ note, foot, link, still }));
  await page.click("#footL [data-open-run]"); await page.waitForFunction((id) => runId === id, R);
  await page.click("#stopBtn"); await waitLife("stopped", 60000);
  return { note, refusal: foot, otherRunStatus: still, stoppedWithStop: true };
});
await step("UX-007: a named deliverable and an incidental file are told apart, with one Activity link each", async () => {
  await page.fill("#input", "");
  await sendText("Create notes/result.txt containing the line RESULT and notes/scratch.txt containing the line SCRATCH. Then write the line ARTIFACT: notes/result.txt and nothing else.");
  await waitLife(["running", "starting"], 60000); await waitLife("waiting");
  await page.waitForTimeout(500);
  const m = await meta(R), x = await page.evaluate(() => ({
    pin: document.querySelector("#lArt").textContent, delivRows: [...document.querySelectorAll("#artList .artrow.deliv")].map((e) => e.textContent.trim()),
    links: [...document.querySelectorAll("#acts [data-art]")].map((e) => e.dataset.art), tagged: [...document.querySelectorAll("#acts .card .tag.deliv")].length,
    thread: document.querySelector(".xarts")?.textContent || "", other: [...document.querySelectorAll(".xfiles summary")].map((e) => e.textContent).pop() || "" }));
  must(m.declared?.includes("notes/result.txt") && !m.declared.includes("notes/scratch.txt") && m.artifacts.includes("notes/scratch.txt"), JSON.stringify({ declared: m.declared, artifacts: m.artifacts }));
  must(x.pin === "Deliverables" && x.delivRows.some((r) => /result\.txt/.test(r)) && !x.delivRows.some((r) => /scratch/.test(r)) && x.links.filter((l) => l === "notes/result.txt").length === 1 && x.tagged === 1 && /result\.txt/.test(x.thread) && /1 other file written/.test(x.other), JSON.stringify(x));
  await shot("remediation-deliverables.png");
  return { declared: m.declared, ...x };
});
await step("UX-009: Continue explains itself first, and an unchecked draft stays in the box", async () => {
  await page.fill("#input", "DRAFT-I-KEEP");
  await page.click('#telCard [data-tel="continue"]');
  const t = await dialog(), body = await page.locator("#dlgB").innerText();
  must(t === "Continue in a fresh session?" && /DRAFT-I-KEEP/.test(body) && /handoff/.test(body), JSON.stringify({ t, body }));
  await page.uncheck("#dlgUseDraft"); await page.click('#dlg [data-dlg="go"]');
  await page.waitForSelector('#acts .card:has(.ct:text-is("Continued"))', { timeout: 300000 });
  const next = (await meta(R)).continuedIn, handoff = JSON.parse(readFileSync(join(DATA, "runs", `${next}.handoff.json`), "utf8"));
  const box = await page.inputValue("#input");
  must(box === "DRAFT-I-KEEP" && !handoff.instruction, JSON.stringify({ box, instruction: handoff.instruction }));
  return { box, instruction: handoff.instruction, next };
});
await step("UX-010: the continued conversation is listed once, titled after the original request, with its sessions", async () => {
  await page.reload({ waitUntil: "networkidle" });
  const rows = await page.locator("#runList [data-run]").allInnerTexts(), titled = rows.filter((r) => /Reply with exactly this one line/.test(r));
  must(titled.length === 1 && /2 sessions/.test(titled[0]) && !rows.some((r) => /^# Continuing/.test(r)), JSON.stringify(rows));
  return { row: titled[0].replace(/\s+/g, " ") };
});
await step("cleanup: close the open conversation", async () => {
  const a = (await call("GET", "/runs")).body.active;
  if (a) { await call("POST", `/runs/${a}/stop`); }
  return { closed: a || null };
});

// ---- Scratch: a mode with a folder per conversation ----
const settle = async (id, timeout = 300000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const m = await meta(id); if (!["starting", "running"].includes(m.status)) return m; await new Promise((ok) => setTimeout(ok, 1500)); } throw new Error(`run ${id} didn't settle`); };
const closeActive = async () => { const a = (await call("GET", "/runs")).body.active; if (a) { await call("POST", `/runs/${a}/end`); for (let i = 0; i < 50 && (await call("GET", "/runs")).body.active; i++) await new Promise((ok) => setTimeout(ok, 200)); } };
let SA, SB;
await step("Scratch: each conversation gets its own empty folder; one's files are invisible to the other and to Scratch itself", async () => {
  await closeActive();
  SA = (await call("POST", "/runs", { prompt: "Create the file note.txt containing the single line ALPHA-ONLY. Then reply OK.", workspace: "scratch", model: "haiku" })).body; must(SA?.id, JSON.stringify(SA));
  await settle(SA.id); await closeActive();
  SB = (await call("POST", "/runs", { prompt: "List the files in your working directory with Glob, then reply with their names, or NONE.", workspace: "scratch", model: "haiku" })).body; must(SB?.id, JSON.stringify(SB));
  await settle(SB.id);
  const a = await meta(SA.id), bm = await meta(SB.id);
  const inA = (await call("GET", `/tree?run=${SA.id}`)).body.map((e) => e.name), inB = (await call("GET", `/tree?run=${SB.id}`)).body.map((e) => e.name);
  const scratchTree = (await call("GET", "/tree?workspace=scratch")).body, viaWs = (await fetch(`${BASE}/file?workspace=scratch&path=note.txt`)).status;
  const ownFile = await (await fetch(`${BASE}/file?run=${SA.id}&path=note.txt`)).text();
  const replyB = (readFileSync(join(DATA, "runs", `${SB.id}.jsonl`), "utf8").split("\n").filter(Boolean).map(JSON.parse).filter((e) => e.type === "reply").pop() || {}).summary || "";
  must(a.workspace.root !== bm.workspace.root && /scratch-runs/.test(a.workspace.root) && inA.includes("note.txt") && !inB.includes("note.txt") && !/note\.txt/.test(replyB), JSON.stringify({ a: a.workspace.root, b: bm.workspace.root, inA, inB, replyB }));
  must(Array.isArray(scratchTree) && scratchTree.length === 0 && viaWs === 404 && /ALPHA-ONLY/.test(ownFile), JSON.stringify({ scratchTree, viaWs, ownFile }));
  return { folderA: a.workspace.root.split(/[\\/]/).slice(-2).join("/"), folderB: bm.workspace.root.split(/[\\/]/).slice(-2).join("/"), filesA: inA, filesB: inB, scratchItself: scratchTree.length };
});
await step("Scratch: the worker is told what its folder is (no project files, no Git)", async () => {
  const ctx = readFileSync(join(DATA, "runs", `${SA.id}.worker.md`), "utf8");
  must(/## Workspace: Scratch/.test(ctx) && /isn't under version control/.test(ctx), ctx.slice(-400));
  return { contextHasScratchSection: true };
});
await step("Scratch: continuing in a fresh session keeps working in the same folder", async () => {
  await closeActive();
  const c = await call("POST", `/runs/${SA.id}/continue`, { instruction: "Read note.txt and reply with its contents." });
  must(c.status === 200, JSON.stringify(c.body));
  let next; for (let i = 0; i < 200 && !(next = (await meta(SA.id)).continuedIn); i++) await new Promise((ok) => setTimeout(ok, 1500));
  must(next, "no continuation"); const n = await settle(next);
  await closeActive();
  const files = (await call("GET", `/tree?run=${next}`)).body.map((e) => e.name);
  must(n.workspace.root === (await meta(SA.id)).workspace.root && files.includes("note.txt"), JSON.stringify({ root: n.workspace.root, files }));
  return { sameFolder: true, filesInContinuation: files };
});
await step("Scratch: a conversation from before per-conversation folders keeps its shared folder (nothing moved or lost)", async () => {
  const id = "2026-01-01T00-00-00-000Z";
  writeFileSync(join(DATA, "scratch", "legacy.txt"), "LEGACY-FILE\n");
  writeFileSync(join(DATA, "runs", `${id}.jsonl`), ""); writeFileSync(join(DATA, "runs", `${id}.raw.jsonl`), "");
  writeFileSync(join(DATA, "runs", `${id}.meta.json`), JSON.stringify({ id, prompt: "an old scratch task", workspace: { id: "scratch", root: join(DATA, "scratch"), profile: "full" }, createdAt: "2026-01-01T00:00:00.000Z", status: "finished", messages: 1, envs: {}, artifacts: [], failures: 0 }));
  const r = await fetch(`${BASE}/file?run=${id}&path=legacy.txt`), text = await r.text();
  must(r.status === 200 && /LEGACY-FILE/.test(text), `${r.status} ${text}`);
  return { legacyFileServed: true };
});
await step("Scratch: a team in Scratch can't reference project files; Scratch has no Git", async () => {
  const w = (await call("GET", "/workers")).body.workers[0];
  const t = await call("POST", "/teams", { name: "Scratch team", workers: [w.id], workspace: "scratch", knowledge: [{ type: "workspace_file", path: "note.txt" }] });
  const git = await call("POST", "/git/commit", { workspace: "scratch", message: "x" }), repo = await call("PUT", "/workspaces/scratch/repo", { repo: "gh-1" });
  must(t.status === 400 && /upload the document/.test(t.body.error) && git.status >= 400 && repo.status >= 400, JSON.stringify({ team: t.body, git: git.body, repo: repo.body }));
  return { team: t.body.error, git: git.body.error, repo: repo.body.error };
});
await step("Scratch in the UI: listed apart from project folders and explained; never the fallback while a project exists", async () => {
  await closeActive(); // an open conversation would (rightly) be reopened on load, in its own workspace
  await page.evaluate(() => localStorage.setItem("ws", "no-such-workspace"));
  await page.reload({ waitUntil: "networkidle" });
  const fallback = await page.evaluate(() => wsId);
  await page.click('#wsList [data-ws="scratch"]');
  await page.waitForFunction(() => /no version history/.test(document.querySelector("#verList").textContent), null, { timeout: 10000 });
  const row = await page.locator("#wsList .scratchrow").innerText(), divider = await page.locator("#wsList .wsdiv").innerText();
  const note = await page.locator("#scratchNote").innerText(), tree = await page.locator("#tree").innerText(), ver = await page.locator("#verList").innerText();
  await page.click("#input"); await page.keyboard.type("@"); await page.waitForSelector("#mPick:not([hidden]) .mempty");
  const at = await page.locator("#mPick .mempty").innerText(); await page.keyboard.press("Escape"); await page.fill("#input", "");
  await shot("remediation-scratch.png");
  must(fallback !== "scratch" && /a new folder per conversation/.test(row) && /Project folders/.test(divider) && /own empty folder/.test(note) && /own folder/.test(tree) && /no version history/.test(ver) && /empty folder/.test(at), JSON.stringify({ fallback, row, divider, note, tree, ver, at }));
  // the conversation is listed through its newest session (SA was continued); opening it shows its own folder
  await page.click("#runList [data-run] >> nth=0");
  await page.waitForFunction(() => document.querySelector('#tree [data-path="note.txt"]'), null, { timeout: 15000 });
  const runTree = await page.locator("#tree").innerText();
  return { fallback, row: row.replace(/\s+/g, " "), tree, versions: ver, at, openRunTree: runTree.replace(/\s+/g, " ") };
});

// ---- C. Git scope and keys (disposable repository) ----
const REPO = `${DATA}-git`;
rmSync(REPO, { recursive: true, force: true }); mkdirSync(REPO, { recursive: true });
const g = (...a) => execFileSync("git", a, { cwd: REPO, encoding: "utf8" });
g("init", "-q", "-b", "main"); g("config", "user.email", "test@example.invalid"); g("config", "user.name", "Remediation Test");
writeFileSync(join(REPO, "a.txt"), "one\n"); g("add", "."); g("commit", "-q", "-m", "initial");
writeFileSync(join(REPO, "a.txt"), "one\ntwo\n"); writeFileSync(join(REPO, "b.txt"), "new\n");
await step("UX-016: the commit button names the files and the branch; Enter adds a line, Ctrl+Enter commits", async () => {
  const repoWs = (await call("POST", "/workspaces", { name: "Git test", path: REPO, mode: "work" })).body;
  await page.reload({ waitUntil: "networkidle" });
  await page.click(`#wsList [data-ws="${repoWs.id}"]`);
  await page.click('#verList [data-rev="WORKTREE"]'); await page.waitForSelector("#cBtn");
  const label = await page.innerText("#cBtn"), scope = await page.locator(".vact.col .txt").innerText();
  await page.fill("#cMsg", "Add two and b"); await page.press("#cMsg", "Enter");
  const afterEnter = { commits: g("rev-list", "--count", "HEAD").trim(), msg: await page.inputValue("#cMsg") };
  await page.press("#cMsg", "Control+Enter");
  await page.waitForFunction(() => /Committed/.test(document.querySelector(".vres")?.textContent || ""), null, { timeout: 15000 });
  const afterCtrl = g("rev-list", "--count", "HEAD").trim();
  must(label === "Commit 2 files to main" && /all 2 changed files/.test(scope) && afterEnter.commits === "1" && afterEnter.msg.includes("\n") && afterCtrl === "2", JSON.stringify({ label, scope, afterEnter, afterCtrl }));
  return { label, afterEnter: afterEnter.commits, afterCtrlEnter: afterCtrl };
});

// ---- D. narrow windows, keyboard, shortcuts ----
await step("UX-024/I: at 700px the navigation is a drawer (Escape closes it), the access mode stays visible, nothing scrolls sideways", async () => {
  await page.setViewportSize({ width: 700, height: 820 });
  await page.click(`#wsList [data-ws="${work.id}"]`).catch(() => {}); // may be inside the closed drawer
  await page.click("#navToggle"); const open = await page.locator("#leftNav").isVisible();
  await page.keyboard.press("Escape"); const closed = !(await page.locator("#leftNav").isVisible());
  const x = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, mode: getComputedStyle(document.querySelector("#mTag")).display !== "none" }));
  await shot("remediation-700.png");
  await page.setViewportSize({ width: 1280, height: 1000 });
  must(open && closed && !x.overflow && x.mode, JSON.stringify({ open, closed, ...x }));
  return { drawerOpens: open, escapeCloses: closed, ...x };
});
await step("UX-027: shortcuts are listed in a dialog that keyboard users can open and close", async () => {
  await page.click("#kbdBtn"); const t = await dialog(), body = await page.locator("#dlgB").innerText();
  await page.keyboard.press("Escape"); const closed = !(await page.evaluate(() => document.getElementById("dlg").open));
  must(t === "Keyboard shortcuts" && /Alt/.test(body) && /Ctrl/.test(body) && closed, JSON.stringify({ t, closed }));
  return { title: t, closesWithEscape: closed, aria: await page.getAttribute("#newTask", "aria-keyshortcuts") };
});

writeFileSync(join(HERE, "remediation-results.json"), JSON.stringify({ when: new Date().toISOString(), results, pageErrors: errors }, null, 1));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed; page errors: ${errors.length ? errors.join(" | ") : "none"}`);
await b.close();
rmSync(REPO, { recursive: true, force: true });
