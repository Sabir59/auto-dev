// @ file mentions in the composer, end to end with the real worker: "@" lists files of the selected
// workspace only (Git's view of it, or a walk outside a repository), filters by name and path,
// navigates "dir/", works with the keyboard and the mouse; picked files go to the worker as
// workspace-relative references (not contents) and the worker reads them itself; the server
// re-checks every mention; a mention never changes meaning when the workspace changes.
//   MFIX=<empty scratch dir> CANARY=<inspect folder> FIX=<attachment fixtures> DATA=<console data dir>
//   node bench/workspace-ui/mentions-test.mjs <port>
import { chromium } from "../../browser-adapter/node_modules/playwright/index.mjs";
import { writeFileSync, readFileSync, readdirSync, mkdirSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import http from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url));
const [port = "8797"] = process.argv.slice(2);
const BASE = `http://127.0.0.1:${port}`, { MFIX, CANARY, FIX, DATA } = process.env;
const H = { origin: BASE, "x-worker-console": "1", "content-type": "application/json" };
const call = (method, path, data) => fetch(BASE + path, { method, headers: H, body: data ? JSON.stringify(data) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

// ---- fixtures: a small app repo, a folder outside it reached by a junction, a large plain folder
const APP = join(MFIX, "app"), OUT = join(MFIX, "outside"), BIG = join(MFIX, "big");
rmSync(MFIX, { recursive: true, force: true });
const put = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
put(join(OUT, "Header.tsx"), 'export const secret = "CODEWORD-OUTSIDE-BASALT";\n');
put(join(APP, "src/components/Header.tsx"), 'export function Header() {\n  // CODEWORD-HEADER-ORCHID\n  return <header className="site-header">Mention app</header>;\n}\n');
put(join(APP, "src/layout/Header.tsx"), 'export function LayoutHeader() { return <div className="layout-header" />; }\n');
put(join(APP, "src/pages/Header.tsx"), "export default function HeaderPage() { return <main>Header page</main>; }\n");
put(join(APP, "src/layout/AppLayout.tsx"), 'import { Header } from "../components/Header";\n// CODEWORD-LAYOUT-CEDAR\nexport function AppLayout({ children }) { return <><Header />{children}</>; }\n');
put(join(APP, "README.md"), "# Mention app\nA fixture for @ mentions.\n");
put(join(APP, "docs/release notes.md"), "Release notes. CODEWORD-NOTES-JUNIPER\n");
put(join(APP, ".gitignore"), "dist/\n/notes\n/linked-hidden\n");
const g = (...a) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...a], { cwd: APP, stdio: "pipe" });
g("init", "-q"); g("add", "-A"); g("commit", "-qm", "fixture");
put(join(APP, "node_modules/lib/Header.js"), 'module.exports = "dependency header";\n'); // untracked, and .gitignore forgets it
put(join(APP, "dist/Header.js"), "built header\n");                                     // ignored
put(join(APP, "src/Draft.tsx"), "export const draft = 1;\n");                            // untracked, not ignored
put(join(APP, "notes/plan.md"), "Plan.\n");                                              // hidden by .gitignore: still the person's
put(join(APP, "notes/deep/idea.md"), "Idea.\n");
execFileSync("cmd", ["/c", "mklink", "/J", join(APP, "linked"), OUT], { stdio: "pipe" });
execFileSync("cmd", ["/c", "mklink", "/J", join(APP, "linked-hidden"), OUT], { stdio: "pipe" }); // hidden by .gitignore and links out
for (let d = 0; d < 105; d++) for (let f = 0; f < 200; f++) put(join(BIG, `pkg${d}`, `sub${f % 4}`, `file-${d * 200 + f}.txt`), "x");
for (let f = 0; f < 300; f++) put(join(BIG, "node_modules", `dep${f}.js`), "x");

const results = [];
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1280, height: 1008 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail).slice(0, 260)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 300)); await page.screenshot({ path: join(HERE, "shots", `mentions-fail-${results.length}.png`) }); }
};
const waitStatus = (label, timeout = 300000) => page.waitForFunction((l) => ({ starting: "Starting", running: "Working", waiting: "Waiting for you", finished: "Finished", stopped: "Stopped", failed: "Failed", interrupted: "Interrupted" }[document.querySelector("#runChip").dataset.status] || "Ready") === l, label, { timeout });
const lastReply = () => page.locator(".msg-w").last().innerText();
// the picker's list for exactly this query (its rows as full paths), once it has arrived
const listFor = async (q) => {
  await page.waitForSelector(`#mPick:not([hidden])[data-q="${q.replace(/"/g, '\\"')}"]`, { timeout: 10000 });
  return page.locator("#mPick .mrow").evaluateAll((bs) => bs.map((b) => { const d = b.querySelector(".d").textContent; return (d ? d + "/" : "") + b.querySelector(".n").textContent; }));
};
const pickerOpen = () => page.locator("#mPick").isVisible();
const input = () => page.inputValue("#input");
const runsCount = async () => (await (await fetch(`${BASE}/runs`)).json()).runs.length;
const transcript = (session) => { const p = join(homedir(), ".claude", "projects"); for (const d of readdirSync(p)) { const f = join(p, d, `${session}.jsonl`); if (existsSync(f)) return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } return null; };
const initTools = (id) => { const l = readFileSync(join(DATA, "runs", `${id}.raw.jsonl`), "utf8").split("\n").find((x) => x.includes('"subtype":"init"')); return l ? JSON.parse(l).tools : null; };

const app = (await call("POST", "/workspaces", { name: "Mention app", path: APP, mode: "work" })).body;
const canary = (await call("POST", "/workspaces", { name: "Canary", path: CANARY, mode: "inspect" })).body;
const big = (await call("POST", "/workspaces", { name: "Big", path: BIG, mode: "inspect" })).body;
await page.goto(BASE, { waitUntil: "networkidle" });
await page.click(`#wsList [data-ws="${app.id}"]`);

await step("typing @ opens a list of this workspace's files, including ones .gitignore hides; no dependency or linked-out files", async () => {
  await page.click("#input"); await page.keyboard.type("@");
  const rows = await listFor("");
  const label = await page.locator("#mPick .lab").textContent();
  await page.screenshot({ path: join(HERE, "shots", "mentions-picker.png") });
  must(label.includes("Mention app"), `label: ${label}`);
  must(rows.includes("src/components/Header.tsx") && rows.includes("src/Draft.tsx") && rows.includes("docs/release notes.md"), `rows: ${rows}`);
  must(rows.includes("notes/plan.md") && rows.includes("notes/deep/idea.md"), `files .gitignore hides are missing: ${rows}`);
  const bad = rows.filter((r) => /node_modules|dist\/|linked|jdir|\.git\//.test(r));
  must(!bad.length, `should be left out: ${bad}`);
  return { label, rows };
});
await step("filters by file name and by path; \"dir/\" lists that folder; no match says so", async () => {
  await page.keyboard.type("Header");
  const byName = await listFor("Header");
  must(byName.length === 3 && byName.every((r) => r.endsWith("/Header.tsx")), `Header: ${byName}`);
  await page.fill("#input", ""); await page.keyboard.type("@layout/App");
  const byPath = await listFor("layout/App");
  must(byPath.length === 1 && byPath[0] === "src/layout/AppLayout.tsx", `layout/App: ${byPath}`);
  await page.fill("#input", ""); await page.keyboard.type("@src/layout/");
  const dir = await listFor("src/layout/");
  must(JSON.stringify(dir) === JSON.stringify(["src/layout/AppLayout.tsx", "src/layout/Header.tsx"]), `src/layout/: ${dir}`);
  await page.fill("#input", ""); await page.keyboard.type("@zzqx");
  await listFor("zzqx");
  const empty = await page.locator("#mPick .mempty").innerText();
  must(empty === "No matching files", empty);
  await page.screenshot({ path: join(HERE, "shots", "mentions-nomatch.png") });
  return { byName, byPath, dir, empty };
});
await step("keyboard: ↓/↑ move the selection, Enter picks it (and doesn't send), Escape closes", async () => {
  await page.fill("#input", ""); await page.keyboard.type("Explain @Header");
  const rows = await listFor("Header");
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowUp");
  const sel = await page.locator('#mPick .mrow[aria-selected="true"]').getAttribute("data-i");
  must(sel === "1", `selected ${sel}`);
  await page.keyboard.press("Enter");
  const v = await input();
  must(v === `Explain @${rows[1]} `, `value: ${v}`);
  must(!(await pickerOpen()), "picker still open");
  must(await page.evaluate(() => runId) === null && (await page.evaluate(() => ({ starting: "Starting", running: "Working", waiting: "Waiting for you", finished: "Finished", stopped: "Stopped", failed: "Failed", interrupted: "Interrupted" }[document.querySelector("#runChip").dataset.status] || "Ready"))) === "Ready", "Enter sent the message");
  await page.keyboard.type("and @");
  await listFor("");
  await page.keyboard.press("Escape");
  must(!(await pickerOpen()), "Escape didn't close");
  await page.keyboard.type("Head");
  await page.waitForTimeout(300);
  must(!(await pickerOpen()), "reopened for the dismissed @");
  await page.keyboard.type(" @Ap");
  const again = await listFor("Ap");
  await page.keyboard.press("Tab");
  return { picked: rows[1], afterEscape: "stays closed for that @, a new @ reopens", tabPicked: again[0], value: await input() };
});
await step("mouse: mid-sentence @ and several mentions; Enter sends once the list is closed", async () => {
  // an @ typed inside text already there: the path goes in at the caret, the rest of the text stays
  await page.fill("#input", "Look at  please");
  await page.evaluate(() => document.querySelector("#input").setSelectionRange(8, 8));
  await page.keyboard.type("@pages/");
  await listFor("pages/");
  await page.click('#mPick .mrow:has-text("Header.tsx")');
  const middle = await input();
  must(middle === "Look at @src/pages/Header.tsx  please", middle);
  await page.fill("#input", "What codewords are in "); await page.keyboard.press("End");
  await page.keyboard.type("@components");
  await listFor("components");
  await page.click('#mPick .mrow:has-text("Header.tsx")');
  await page.keyboard.type("and @AppLay");
  await listFor("AppLay");
  await page.locator("#mPick .mrow").first().click();
  await page.keyboard.type("? Reply with just the codewords.");
  const v = await input();
  must(v === "What codewords are in @src/components/Header.tsx and @src/layout/AppLayout.tsx ? Reply with just the codewords.", v);
  await page.screenshot({ path: join(HERE, "shots", "mentions-composed.png") });
  return { middle, value: v };
});
let runId, sent;
await step("send: the worker gets references (paths, not contents) and reads both files itself", async () => {
  const req = page.waitForRequest((r) => r.url().endsWith("/runs") && r.method() === "POST");
  await page.keyboard.press("Enter");
  sent = (await req).postDataJSON();
  must(JSON.stringify(sent.mentions) === JSON.stringify([{ type: "file", path: "src/components/Header.tsx" }, { type: "file", path: "src/layout/AppLayout.tsx" }]), `mentions sent: ${JSON.stringify(sent.mentions)}`);
  must(!/ORCHID|CEDAR/.test(JSON.stringify(sent)), "the request carried file contents");
  await waitStatus("Waiting for you");
  runId = await page.evaluate(() => runId);
  const meta = await (await fetch(`${BASE}/runs/${runId}`)).json();
  const reply = await lastReply();
  must(/ORCHID/.test(reply) && /CEDAR/.test(reply), `reply: ${reply}`);
  const tr = transcript(meta.sessionId);
  must(tr, "no session transcript");
  const firstUser = tr.find((e) => e.type === "user");
  const told = JSON.stringify(firstUser.message.content);
  must(told.includes("<file_references>") && told.includes("- src/components/Header.tsx") && told.includes("- src/layout/AppLayout.tsx"), `worker was told: ${told.slice(0, 400)}`);
  must(!/ORCHID|CEDAR/.test(told), "the worker's message carried file contents");
  const firstTurn = tr.slice(0, tr.findIndex((e) => e.type === "assistant"));
  const inlined = firstTurn.filter((e) => e.type === "attachment" && /file/.test(e.attachment?.type || "")).map((e) => e.attachment.filename);
  must(!inlined.length && !JSON.stringify(firstTurn).includes("ORCHID"), `the runtime inlined: ${inlined}`);
  const reads = tr.flatMap((e) => (e.message?.content || [])).filter((c) => c?.type === "tool_use").map((c) => `${c.name} ${c.input.file_path || c.input.path || c.input.pattern || ""}`);
  must(reads.some((r) => /^Read .*components[\\/]Header\.tsx$/.test(r)) && reads.some((r) => /^Read .*AppLayout\.tsx$/.test(r)), `tool calls: ${reads}`);
  return { sentMentions: sent.mentions, inlinedByRuntime: inlined, reply: reply.slice(0, 200), workerToldExcerpt: told.slice(told.indexOf("<file_references>"), told.indexOf("</file_references>") + 19), toolCalls: reads };
});
await step("in the conversation the mentions read as links; one opens the file (read-only, from the run's workspace)", async () => {
  const links = await page.locator(".msg-u .mention").allInnerTexts();
  must(links.length === 2, `links: ${links}`);
  await page.screenshot({ path: join(HERE, "shots", "mentions-thread.png") });
  await page.locator(".msg-u .mention").first().click();
  await page.waitForFunction(() => /CODEWORD-HEADER-ORCHID/.test(document.querySelector("#canvas").textContent), null, { timeout: 10000 });
  const shown = (await page.locator("#canvas").innerText()).slice(0, 120);
  await page.click(`#runList [data-run="${runId}"]`);
  await page.waitForSelector(".msg-u .mention");
  return { links, opened: shown };
});
await step("a file deleted after it was mentioned: the worker is told it's missing and says so", async () => {
  await page.click("#input"); await page.keyboard.type("Does @Draft");
  await listFor("Draft"); await page.keyboard.press("Enter");
  unlinkSync(join(APP, "src", "Draft.tsx"));
  await page.keyboard.type("exist in the workspace? Check, then answer only yes or no.");
  const req = page.waitForRequest((r) => r.url().endsWith(`/runs/${runId}/message`));
  await page.keyboard.press("Enter");
  const body = (await req).postDataJSON();
  await waitStatus("Working", 30000); await waitStatus("Waiting for you");
  const reply = await lastReply();
  const gone = await page.locator(".msg-u").last().locator(".mention.gone").count();
  must(gone === 1, `struck-through mentions: ${gone}`);
  must(/\bno\b/i.test(reply), `reply: ${reply}`);
  return { sent: body.mentions, shownAsMissing: gone, reply: reply.slice(0, 160) };
});
await step("an attachment and a mention in one message (a path with a space)", async () => {
  const chooser = page.waitForEvent("filechooser"); await page.click("#attachBtn"); await (await chooser).setFiles([join(FIX, "notes.txt")]);
  await page.waitForFunction(() => document.querySelectorAll("#attRow .achip").length === 1);
  await page.click("#input"); await page.keyboard.type("Give the codeword in the attached notes.txt and the codeword in @release");
  await listFor("release"); await page.keyboard.press("Enter");
  await page.keyboard.type("- just the two words.");
  const req = page.waitForRequest((r) => r.url().endsWith(`/runs/${runId}/message`));
  await page.keyboard.press("Enter");
  const body = (await req).postDataJSON();
  must(body.attachments.length === 1 && JSON.stringify(body.mentions) === JSON.stringify([{ type: "file", path: "docs/release notes.md" }]), JSON.stringify({ a: body.attachments.length, m: body.mentions }));
  await waitStatus("Working", 30000); await waitStatus("Waiting for you");
  const reply = await lastReply();
  must(/MARIGOLD/.test(reply) && /JUNIPER/.test(reply), `reply: ${reply}`);
  await page.click("#endBtn"); await waitStatus("Finished", 60000);
  return { attachments: body.attachments.map((a) => a.name), mentions: body.mentions, reply };
});
await step("a hand-typed @path outside the workspace isn't read in (Work), and the message is shown as typed", async () => {
  const text = `Reply with the single word DONE and nothing else. @${join(OUT, "Header.tsx")} @../outside/Header.tsx @linked/Header.tsx`;
  const r = await call("POST", "/runs", { prompt: text, workspace: app.id });
  must(r.status === 200, JSON.stringify(r.body));
  let m; for (;;) { m = await (await fetch(`${BASE}/runs/${r.body.id}`)).json(); if (m.status !== "starting" && m.status !== "running") break; await new Promise((ok) => setTimeout(ok, 1500)); }
  const tr = transcript(m.sessionId) || [];
  const files = tr.filter((e) => e.type === "attachment" && /file/.test(e.attachment?.type || "")).map((e) => e.attachment.filename);
  const leaked = JSON.stringify(tr).includes("CODEWORD-OUTSIDE-BASALT");
  const toWorker = JSON.stringify(tr.find((e) => e.type === "user")?.message.content);
  const shown = readFileSync(join(DATA, "runs", `${m.id}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === "user").summary;
  await call("POST", `/runs/${m.id}/end`);
  for (let i = 0; i < 40 && (await (await fetch(`${BASE}/runs/${m.id}`)).json()).status !== "finished"; i++) await new Promise((ok) => setTimeout(ok, 1000));
  must(!files.length && !leaked, `read in: ${files} leaked: ${leaked}`);
  must(shown === text, `shown: ${shown}`);
  await page.click(`#runList [data-run="${runId}"]`).catch(() => {});
  return { attachedByRuntime: files, outsideContentReachedWorker: leaked, workerGot: toWorker.slice(toWorker.indexOf("DONE") + 22, toWorker.indexOf("DONE") + 260), shownAsTyped: shown === text };
});
await step("switching workspace: a mention picked in the old one is refused (not re-read in the new one); new @ lists the new one", async () => {
  await page.click("#input"); await page.keyboard.type("Compare @components");
  await listFor("components"); await page.keyboard.press("Enter");
  const before = await runsCount();
  await page.click(`#wsList [data-ws="${canary.id}"]`);
  await page.click("#input"); await page.keyboard.press("End"); await page.keyboard.press("Enter");
  await page.waitForFunction(() => /picked in another workspace/.test(document.querySelector("#footL").textContent), null, { timeout: 5000 });
  const refused = await page.locator("#footL").innerText();
  must(await runsCount() === before, "a run started");
  await page.fill("#input", ""); await page.keyboard.type("@");
  const rows = await listFor("");
  const label = await page.locator("#mPick .lab").textContent();
  must(label.includes("Canary"), label);
  must(rows.includes("README.md") && !rows.some((r) => /Header\.tsx|jdir/.test(r)), `rows: ${rows}`);
  await page.keyboard.press("Escape");
  return { refused, canaryRows: rows, label };
});
await step("Inspect workspace: a mention works and the profile is unchanged (no write tools)", async () => {
  await page.fill("#input", ""); await page.keyboard.type("Quote the first line of @READ");
  await listFor("READ"); await page.keyboard.press("Enter");
  await page.keyboard.type("exactly.");
  await page.keyboard.press("Enter");
  await waitStatus("Waiting for you");
  const id = await page.evaluate(() => runId), meta = await (await fetch(`${BASE}/runs/${id}`)).json();
  const reply = await lastReply(), firstLine = readFileSync(join(CANARY, "README.md"), "utf8").split(/\r?\n/)[0].replace(/^#\s*/, "");
  const tools = initTools(id);
  must(meta.workspace.profile === "inspect", meta.workspace.profile);
  must(tools && !tools.some((t) => /^(Write|Edit|NotebookEdit|Bash)$/.test(t)), `tools: ${tools}`);
  must(reply.includes(firstLine), `reply: ${reply} / expected ${firstLine}`);
  await page.click("#endBtn"); await waitStatus("Finished", 60000);
  return { profile: meta.workspace.profile, builtinTools: tools.filter((t) => !t.startsWith("mcp__")), reply: reply.slice(0, 120) };
});
await step("Scratch: a new task has no files to reference, and @ says why (no other conversation's files)", async () => {
  await page.click('#wsList [data-ws="scratch"]');
  await page.click("#input"); await page.fill("#input", ""); await page.keyboard.type("@");
  await listFor("");
  const label = await page.locator("#mPick .lab").textContent(), empty = await page.locator("#mPick .mempty").innerText();
  must(label.includes("Scratch") && /starts with an empty folder/.test(empty), `${label} / ${empty}`);
  await page.keyboard.press("Escape"); await page.fill("#input", "");
  return { label, empty };
});
await step("the server re-checks every mention: outside, absolute, drive, UNC, junction, folder; nothing starts", async () => {
  const before = await runsCount(), out = {};
  const tries = { dotdot: "../outside/Header.tsx", innerDotdot: "src/../../outside/Header.tsx", absolute: "C:\\Windows\\win.ini", absoluteSlash: "C:/Windows/win.ini", driveRelative: "C:win.ini", unc: "\\\\localhost\\c$\\Windows\\win.ini", uncSlash: "//localhost/c$/Windows/win.ini", rooted: "/Windows/win.ini", junctionOut: "linked/Header.tsx", junctionDir: "linked", folder: "src", option: "--help" };
  for (const [k, p] of Object.entries(tries)) { const r = await call("POST", "/runs", { prompt: "x", workspace: app.id, mentions: [{ type: "file", path: p }] }); out[k] = `${r.status} ${r.body?.error}`; must(r.status === 400, `${k}: ${out[k]}`); }
  const wrongType = await call("POST", "/runs", { prompt: "x", workspace: app.id, mentions: [{ type: "url", path: "README.md" }] });
  const tooMany = await call("POST", "/runs", { prompt: "x", workspace: app.id, mentions: Array.from({ length: 21 }, () => ({ type: "file", path: "README.md" })) });
  const msgsBefore = (await (await fetch(`${BASE}/runs/${runId}`)).json()).messages;
  const followUp = await call("POST", `/runs/${runId}/message`, { text: "x", mentions: [{ type: "file", path: "../outside/Header.tsx" }] });
  must(wrongType.status === 400 && tooMany.status === 400 && followUp.status === 400, JSON.stringify({ wrongType, tooMany, followUp }));
  must(await runsCount() === before, "a run started");
  must((await (await fetch(`${BASE}/runs/${runId}`)).json()).messages === msgsBefore, "the refused follow-up reached the run");
  return { ...out, wrongType: wrongType.body.error, tooMany: tooMany.body.error, followUp: followUp.body.error, runsCreated: (await runsCount()) - before };
});
await step("search never returns anything outside the workspace, and another site can't read it", async () => {
  const qs = ["../", "..\\", "../outside", "BASALT", "C:\\", "C:/Windows", "//localhost/c$", "linked/", "linked-hidden/", "node_modules/", "dist/", ".git/"];
  const out = {};
  for (const q of qs) {
    const r = (await call("GET", `/mentions?workspace=${app.id}&q=${encodeURIComponent(q)}`)).body;
    out[q] = r.files;
    must(r.files.every((p) => !/^([a-z]:|[\\/])|(^|\/)\.\.(\/|$)/i.test(p)) && !r.files.some((p) => /linked|node_modules|dist\/|\.git\//.test(p)), `${q}: ${r.files}`);
  }
  const noWs = await call("GET", "/mentions?workspace=nope&q=");
  must(noWs.status === 400, `unknown workspace: ${noWs.status}`);
  const other = await b.newPage();
  await other.goto(`http://localhost:${port}/`, { waitUntil: "domcontentloaded" });
  const crossOrigin = await other.evaluate((u) => fetch(u).then((r) => `read ${r.status}`, (e) => `blocked: ${e.message}`), `${BASE}/mentions?workspace=${app.id}&q=`);
  await other.close();
  must(crossOrigin.startsWith("blocked"), crossOrigin);
  const foreignHost = await new Promise((ok) => http.get({ host: "127.0.0.1", port, path: `/mentions?workspace=${app.id}&q=`, headers: { host: "evil.example" } }, (r) => { r.resume(); ok(r.statusCode); }).on("error", (e) => ok(e.message)));
  must(foreignHost === 403, `foreign Host: ${foreignHost}`);
  return { results: out, unknownWorkspace: noWs.body.error, crossOrigin, foreignHost };
});
await step("performance: indexed once, then each keystroke is served from the index (and a huge folder is capped)", async () => {
  const t = async (ws, q) => { const t0 = Date.now(); const r = (await call("GET", `/mentions?workspace=${ws}&q=${encodeURIComponent(q)}`)).body; return { ...r, files: r.files.length, wall: Date.now() - t0 }; };
  const exCold = await t("console", ""), exWarm = await t("console", "server");
  const bigCold = await t(big.id, "");
  const keys = []; for (const q of ["f", "fi", "fil", "file", "file-", "file-2", "file-20", "file-209", "file-2099"]) keys.push((await t(big.id, q)).wall);
  must(exWarm.wall < 100 && Math.max(...keys) < 150, JSON.stringify({ exWarm: exWarm.wall, keys }));
  must(bigCold.indexed === 20000 && bigCold.truncated === true, `big: ${bigCold.indexed} ${bigCold.truncated}`);
  return { executor: { indexed: exCold.indexed, coldMs: exCold.wall, warmMs: exWarm.wall }, big: { onDisk: 21000 + 300, indexed: bigCold.indexed, truncated: bigCold.truncated, coldMs: bigCold.wall, keystrokeMs: keys } };
});
writeFileSync(join(HERE, "mentions-results.json"), JSON.stringify({ when: new Date().toISOString(), results, pageErrors: errors }, null, 1));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed; page errors: ${errors.length ? errors.join(" | ") : "none"}`);
await b.close();
