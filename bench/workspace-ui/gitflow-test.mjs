// The Git workflow worker end to end: created through the describe-the-work flow, configured, its
// commit explorer, plans for each strategy, guarded execution, its read-only tools, a real worker
// run, the page, and a read-only pass over the real MATW repository (if present) that proves no
// branch there moves. Write experiments happen only in a disposable fixture (bench/gitflow/fixture.mjs).
//   DATA=<console data dir>   node bench/workspace-ui/gitflow-test.mjs <port>     (run-suite.sh gitflow)
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { buildFixture, fixtureConfig } from "../gitflow/fixture.mjs";
import { GitFlow, normalizeConfig } from "../../worker-ui/gitflow.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", "..");
const { chromium } = createRequire(join(REPO, "browser-adapter", "package.json"))("playwright");
const { Client } = await import("../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js");
const { StdioClientTransport } = await import("../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js");
const [port = "8797"] = process.argv.slice(2);
const BASE = `http://127.0.0.1:${port}`, DATA = process.env.DATA;
const H = { origin: BASE, "x-worker-console": "1", "content-type": "application/json" };
const call = (method, path, data) => fetch(BASE + path, { method, headers: H, body: data ? JSON.stringify(data) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const results = [];
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail).slice(0, 260)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 400)); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const until = async (fn, ms = 60000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("timeout"); await sleep(400); } };
const refsOf = (repo) => execFileSync("git", ["for-each-ref", "--format=%(refname) %(objectname)"], { cwd: repo, encoding: "utf8" });

const fx = buildFixture(join(DATA, "fixture"));
const S = fx.shas, name = (sha) => Object.entries(S).find(([, v]) => v === sha)?.[0] || sha.slice(0, 7);
execFileSync("git", ["config", "user.name", "Sabir"], { cwd: fx.repo }); execFileSync("git", ["config", "user.email", "sabir@matw.test"], { cwd: fx.repo });
const ws = (await call("POST", "/workspaces", { name: "MATW fixture", path: fx.repo, mode: "inspect" })).body;
const originRefs0 = refsOf(fx.origin);
let W, cfgPath;
const gf = (m, p, b) => call(m, `/gitflow/${W.id}${p}`, b);
const analysis = async (mapping = "dev-main-to-sabir-dev") => (await gf("GET", `/analysis?mapping=${mapping}`)).body;
const preview = async (b) => { const r = await gf("POST", "/preview", { mapping: "dev-main-to-sabir-dev", strategy: "selective", ...b }); assert(r.status === 200, JSON.stringify(r.body)); return r.body; };

await step("created through the existing flow: described in words, recognised as Git branch sync, read-only Git tools only, a starting configuration from the answers", async () => {
  const d = (await call("POST", "/worker-drafts/preview", { description: "Keep sabir-dev in sync with dev-main and sabir-uat with uat-main, and promote our UAT changes to preprod-main", workspace: ws.id })).body;
  assert(d.integrations.join() === "gitsync" && d.answers.gitsync.mappings.includes("sabir-uat → preprod-main"), JSON.stringify(d.integrations));
  W = (await call("POST", "/workers/from-request", { description: "Keep sabir-dev in sync with dev-main and sabir-uat with uat-main, and promote our UAT changes to preprod-main", answers: { gitsync: { team: "BAU", others: "Innovax", writes: "propose" } }, workspace: ws.id })).body;
  assert(W.capabilities.join() === "files.read,gitflow.read" && W.name === "BAU branch sync worker", JSON.stringify(W.capabilities));
  const c = (await gf("GET", "/config")).body.config;
  assert(c.workspace === ws.id && c.mappings.map((m) => `${m.source}>${m.destination}:${m.kind}:${m.strategy}`).join() === "dev-main>sabir-dev:sync:selective,uat-main>sabir-uat:sync:selective,sabir-uat>preprod-main:promote:feature" && c.teams.map((t) => `${t.name}${t.ours ? "*" : ""}`).join() === "BAU*,Innovax" && c.proposals, JSON.stringify(c));
  return { worker: W.name, capabilities: W.capabilities, mappings: c.mappings.map((m) => `${m.source} → ${m.destination} (${m.kind}, ${m.strategy})`) };
});

await step("configured: people, identities and branch patterns saved and validated (a bad branch pair, two 'our' teams and a bad override are refused)", async () => {
  const full = { ...fixtureConfig(ws.id), teams: [{ id: "bau", name: "BAU", ours: true, branchPatterns: ["bau/*", "sabir-*"] }, { id: "innovax", name: "Innovax", ours: false, branchPatterns: ["innovax/*"] }] };
  const r = await gf("PUT", "/config", full);
  assert(r.status === 200 && r.body.config.people.length === 3, JSON.stringify(r.body));
  const bad = await Promise.all([gf("PUT", "/config", { ...full, mappings: [{ source: "a..b", destination: "x" }] }), gf("PUT", "/config", { ...full, teams: full.teams.map((t) => ({ ...t, ours: true })) }), gf("PUT", "/config", { ...full, overrides: [{ ref: "not-a-sha", team: "bau" }] })]);
  assert(bad.every((x) => x.status === 400), JSON.stringify(bad.map((x) => x.body)));
  return { people: r.body.config.people.map((p) => `${p.name} (${p.team})`), refused: bad.map((x) => x.body.error) };
});

await step("explorer: dev-main → sabir-dev from real Git state; Sameem's four commits by email (plus one only by name, uncertain); PR and ticket grouping; copy, revert and unknown author found", async () => {
  const a = await analysis();
  const git = execFileSync("git", ["rev-list", "--count", "origin/sabir-dev..origin/dev-main"], { cwd: fx.repo, encoding: "utf8" }).trim();
  const by = Object.fromEntries(a.commits.map((c) => [name(c.sha), c]));
  const sameem = a.commits.filter((c) => c.attribution.person === "sameem").map((c) => `${name(c.sha)}:${c.attribution.confidence}`);
  assert(String(a.pendingCount) === git, `pending ${a.pendingCount} vs git ${git}`);
  assert(sameem.sort().join() === "N1:uncertain,S1:confirmed,S2:confirmed,S3:confirmed,S5:likely", sameem.join());
  assert(by.S5.presence.state === "copy" && by.S5.presence.sha === S.S5copy && by.S4.revertedBy?.sha === S.R1 && by.R1.kinds.includes("revert") && by.U1.attribution.confidence === "unknown", JSON.stringify({ s5: by.S5.presence, s4: by.S4.revertedBy }));
  const t101 = a.tasks.find((t) => t.id === "pr-101");
  assert(t101 && t101.shas.map(name).sort().join() === "PR101,S1,S2" && by.S1.tickets.join() === "DON-12" && by.PR101.kinds.includes("pr-merge"), JSON.stringify(t101));
  assert(by.N1.attribution.evidence.some((e) => /names aren't unique/.test(e.text)), "name evidence not marked weak");
  return { pending: a.pendingCount, sameem, tasks: a.tasks.map((t) => `${t.kind}:${t.shas.map(name).join("+")}`) };
});

await step("configuration changes the results: moving Sameem to Innovax makes PR #101 uncertain (the evidence disagrees); an override confirms N1", async () => {
  const c = (await gf("GET", "/config")).body.config;
  await gf("PUT", "/config", { ...c, people: c.people.map((p) => (p.id === "sameem" ? { ...p, team: "innovax" } : p)) });
  const moved = (await analysis()).commits.find((x) => x.sha === S.S1).attribution;
  await gf("PUT", "/config", { ...c, overrides: [{ ref: S.N1.slice(0, 12), team: "bau", note: "Sameem's laptop email" }] });
  const n1 = (await analysis()).commits.find((x) => x.sha === S.N1).attribution;
  assert(moved.confidence === "uncertain" && moved.evidence.some((e) => e.kind === "conflict"), JSON.stringify(moved));
  assert(n1.confidence === "confirmed" && n1.team === "bau" && n1.evidence[0].kind === "override", JSON.stringify(n1));
  await gf("PUT", "/config", c);
  return { movedS1: moved.confidence, overriddenN1: n1.confidence };
});

await step("setup reads the repository: real branches and origin, relationships suggested from branch names, the actual commit authors grouped by person with all their emails; Fetch now works", async () => {
  const r = (await gf("GET", "/repo")).body, names = r.branches.map((x) => x.name);
  assert(["dev-main", "uat-main", "preprod-main", "sabir-dev", "sabir-uat"].every((x) => names.includes(x)) && r.remotes[0]?.name === "origin", JSON.stringify(names));
  const fresh = new GitFlow({ root: fx.repo, dir: join(DATA, "suggest-check"), config: normalizeConfig({ refs: "remote" }) });
  const sugg = fresh.suggestMappings(r.branches).map((s) => `${s.source}>${s.destination}:${s.kind}`).sort();
  assert(sugg.join() === "dev-main>sabir-dev:sync,sabir-uat>preprod-main:promote,uat-main>sabir-uat:sync", sugg.join());
  const au = (await gf("GET", "/authors")).body.authors, sameem = au.find((a) => a.name === "Sameem");
  assert(sameem && sameem.emails.sort().join() === "sameem.k@gmail.test,sameem@matw.test" && sameem.configured?.team === "bau" && au.some((a) => a.name === "Dev Bot" && !a.configured), JSON.stringify(au));
  const f = await gf("POST", "/fetch");
  assert(f.status === 200 && refsOf(fx.origin) === originRefs0, JSON.stringify(f.body));
  return { branches: names.length, suggested: sugg, authors: au.map((a) => `${a.name} (${a.emails.length} email${a.emails.length > 1 ? "s" : ""}, ${a.commits})`) };
});

await step("a remote URL instead of a folder: the console clones it into the worker's data, and the analysis matches git on that remote", async () => {
  const c = (await gf("GET", "/config")).body.config;
  const url = "file:///" + fx.origin.replace(/\\/g, "/");
  const r = await gf("PUT", "/config", { ...c, source: "remote", url });
  assert(r.status === 200 && r.body.config.refs === "local", JSON.stringify(r.body));
  const a = await analysis(), git = execFileSync("git", ["rev-list", "--count", "sabir-dev..dev-main"], { cwd: fx.origin, encoding: "utf8" }).trim();
  const bad = await gf("PUT", "/config", { ...c, source: "remote", url: "https://user:token@github.com/x/y.git" });
  await gf("PUT", "/config", c);
  assert(String(a.pendingCount) === git && existsSync(join(DATA, "gitflow", W.id, "remote.git", "HEAD")) && bad.status === 400, JSON.stringify({ pending: a.pendingCount, git, bad: bad.body }));
  return { cloned: true, pending: a.pendingCount, refusedCredentialsInUrl: bad.body.error };
});

await step("one commit: files, a browsable diff and the raw Git evidence", async () => {
  const d = (await gf("GET", `/commit/${S.S3}`)).body;
  assert(d.numstat.map((f) => f.path).join() === "src/cart.js" && /banner/.test(d.diff) && /^commit /.test(d.raw) && d.author.email === "sameem@matw.test", JSON.stringify({ files: d.numstat, raw: d.raw.slice(0, 80) }));
  return { files: d.numstat, rawHead: d.raw.split("\n")[0] };
});

let readyPlan;
await step("plans (simulated with Git): S1+S2 ready; S3 blocked by a predicted conflict and its cross-team dependency; S4 blocked as reverted; S5 already present; N1 blocked as uncertain", async () => {
  readyPlan = await preview({ select: [S.S1, S.S2] });
  const s3 = await preview({ select: [S.S3] }), s4 = await preview({ select: [S.S4] }), s5 = await preview({ select: [S.S5] }), n1 = await preview({ select: [S.N1] });
  assert(readyPlan.status === "ready" && readyPlan.result.files.join() === "src/donate.css,src/donate.js", JSON.stringify(readyPlan.result));
  assert(s3.status === "blocked" && s3.items[0].status === "conflict" && s3.items[0].conflicts.includes("src/cart.js") && s3.dependencies.some((d) => d.on === S.I1 && d.crossTeam), JSON.stringify(s3.items));
  assert(s4.status === "blocked" && s4.hazards.some((h) => h.kind === "revert"), JSON.stringify(s4));
  assert(s5.status === "nothing" && s5.items[0].status === "present", JSON.stringify(s5.items));
  assert(n1.status === "blocked" && n1.blockers.some((b) => /uncertain/.test(b)), JSON.stringify(n1.blockers));
  const again = await preview({ select: [S.S2, S.S1] });
  assert(again.id === readyPlan.id, "the same inputs gave a different plan id");
  return { ready: readyPlan.id, s3: s3.blockers, s4: s4.blockers, s5: s5.items[0].reasons, n1: n1.blockers };
});

await step("rules decide block vs review: with 'block reverted changes' off, S4 needs review (not ready)", async () => {
  const c = (await gf("GET", "/config")).body.config;
  await gf("PUT", "/config", { ...c, exclude: { ...c.exclude, reverted: false } });
  const p = await preview({ select: [S.S4] });
  await gf("PUT", "/config", c);
  assert(p.status === "review" && p.reviews.some((r) => /reverted/.test(r)), JSON.stringify(p));
  return { status: p.status, reviews: p.reviews };
});

await step("strategies: merging dev-main (keeping history) is blocked because it carries Innovax's work; promoting PR #201 to preprod-main is ready; PR #202 (cut from dev-main) is blocked", async () => {
  const anc = await preview({ strategy: "ancestry" });
  const f1 = await preview({ mapping: "sabir-uat-to-preprod-main", strategy: "feature", select: ["201"] }), f2 = await preview({ mapping: "sabir-uat-to-preprod-main", strategy: "feature", select: ["202"] });
  assert(anc.status === "blocked" && anc.blockers.some((b) => /Innovax/.test(b)), JSON.stringify(anc.blockers));
  assert(f1.status === "ready" && f1.items.some((i) => i.sha === S.RC), JSON.stringify(f1.items));
  assert(f2.status === "blocked" && f2.items.some((i) => i.sha === S.I1 && i.status === "blocked"), JSON.stringify(f2.blockers));
  assert(f1.destination.shared && /nothing is ever written to it/.test(f1.execution), f1.execution);
  return { ancestry: anc.blockers.length + " blockers", feature201: f1.status, feature202: f2.blockers[0] };
});

await step("execution is guarded: a blocked plan is refused; an approved ready plan creates only a NEW branch (copies record their originals); no existing branch, remote-tracking branch or origin ref changes", async () => {
  const blocked = await preview({ select: [S.S3] });
  const refused = await gf("POST", "/execute", { plan: blocked.id });
  assert(refused.status === 400 && /Blocked/.test(refused.body.error), JSON.stringify(refused.body));
  const before = refsOf(fx.repo);
  const r = await gf("POST", "/execute", { plan: readyPlan.id });
  assert(r.status === 200 && /^gitflow\/sabir-dev-\d{8}-\d{6}$/.test(r.body.branch) && r.body.changedExisting.length === 0, JSON.stringify(r.body));
  const after = refsOf(fx.repo), added = after.split("\n").filter((l) => !before.includes(l));
  assert(added.length === 1 && added[0].startsWith(`refs/heads/${r.body.branch} `) && before.split("\n").every((l) => !l || after.includes(l)), JSON.stringify({ added }));
  const log = execFileSync("git", ["log", "--format=%an|%cn|%B", `origin/sabir-dev..${r.body.branch}`], { cwd: fx.repo, encoding: "utf8" });
  assert(log.includes(`cherry picked from commit ${S.S1}`) && log.includes(`cherry picked from commit ${S.S2}`) && log.startsWith("Sameem|Sabir|"), log.slice(0, 300));
  assert(refsOf(fx.origin) === originRefs0, "origin changed");
  return { branch: r.body.branch, recovery: r.body.recovery };
});

await step("a stale plan (the destination moved) and a preview-only worker are refused; the audit trail records previews, refusals and the execution", async () => {
  const p = await preview({ select: [S.S1] });
  const moved = execFileSync("git", ["commit-tree", "-p", "refs/remotes/origin/sabir-dev", "-m", "someone else", "refs/remotes/origin/sabir-dev^{tree}"], { cwd: fx.repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" } }).trim();
  const old = execFileSync("git", ["rev-parse", "refs/remotes/origin/sabir-dev"], { cwd: fx.repo, encoding: "utf8" }).trim();
  execFileSync("git", ["update-ref", "refs/remotes/origin/sabir-dev", moved], { cwd: fx.repo }); // the fixture's "fetch" brought a new commit
  const stale = await gf("POST", "/execute", { plan: p.id });
  execFileSync("git", ["update-ref", "refs/remotes/origin/sabir-dev", old], { cwd: fx.repo });
  const c = (await gf("GET", "/config")).body.config;
  await gf("PUT", "/config", { ...c, proposals: false });
  const p2 = await preview({ select: [S.S2] }), off = await gf("POST", "/execute", { plan: p2.id });
  await gf("PUT", "/config", c);
  const audit = (await gf("GET", "/audit")).body.audit.map((e) => e.action);
  assert(stale.status === 400 && /changed since this plan/.test(stale.body.error) && off.status === 400 && /preview only/.test(off.body.error), JSON.stringify([stale.body, off.body]));
  assert(["preview", "execute", "refused", "config"].every((x) => audit.includes(x)), audit.join());
  return { stale: stale.body.error, previewOnly: off.body.error, audit: [...new Set(audit)] };
});

await step("the worker's tools (MCP): read-only on Git (no branch, merge or push tool); it reads Sameem's commits and saves an explanation the explorer shows as its own", async () => {
  const client = new Client({ name: "t", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(REPO, "mcp", "gitflow-server.mjs")], env: { ...process.env, GITFLOW_ROOT: fx.repo, GITFLOW_DIR: join(DATA, "gitflow", W.id) } }));
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  const rows = JSON.parse((await client.callTool({ name: "gitflow_commits", arguments: { mapping: "dev-main-to-sabir-dev", person: "sameem" } })).content[0].text);
  await client.callTool({ name: "gitflow_save_note", arguments: { sha: S.S3, summary: "Adds a banner() helper to the cart that reports how many items it holds.", related: [] } });
  await client.close();
  const shown = (await analysis()).commits.find((c) => c.sha === S.S3).note;
  assert(tools.join() === "gitflow_commit,gitflow_commits,gitflow_overview,gitflow_preview,gitflow_save_note" && rows.commits.length === 5 && shown?.by === "worker" && /banner/.test(shown.summary), JSON.stringify({ tools, n: rows.commits.length, shown }));
  return { tools, sameemCommits: rows.commits.length };
});

await step("a real run of the worker (Claude): its runtime gets the gitflow tools, not Write or Bash, and it answers from gitflow_overview", async () => {
  const r = (await call("POST", "/runs", { prompt: "Call gitflow_overview and reply with only the team names, comma-separated.", workspace: ws.id, worker: W.id, model: "haiku" })).body;
  assert(r?.id, JSON.stringify(r));
  const m = await until(async () => { const x = (await call("GET", `/runs/${r.id}`)).body; return ["waiting", "finished", "failed"].includes(x.status) ? x : null; }, 180000);
  const raw = readFileSync(join(DATA, "runs", `${r.id}.raw.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const init = raw.find((x) => x.type === "system" && x.subtype === "init"), reply = raw.filter((x) => x.type === "result").pop()?.result || "";
  const used = raw.filter((x) => x.type === "assistant").flatMap((x) => x.message.content.filter((b) => b.type === "tool_use").map((b) => b.name));
  await call("POST", `/runs/${r.id}/end`); await until(async () => !(await call("GET", "/runs")).body.active, 60000);
  assert(m.status === "waiting" && init.tools.includes("mcp__gitflow__gitflow_overview") && !init.tools.includes("Write") && !init.tools.includes("Bash") && used.includes("mcp__gitflow__gitflow_overview") && /BAU/.test(reply) && /Innovax/.test(reply), JSON.stringify({ status: m.status, tools: init?.tools, used, reply }));
  return { used, reply };
});

// ---- the page ----
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1440, height: 950 } });
const pageErrors = []; page.on("pageerror", (e) => pageErrors.push(e.message));
const shot = (n) => page.screenshot({ path: join(HERE, "shots", `gitflow-${n}.png`) });
await page.goto(BASE, { waitUntil: "networkidle" });
await page.click(`#wsList [data-ws="${ws.id}"]`);

await step("page: the worker's new task offers its Git workflow; Commits lists real changes; choosing Sameem shows his commits; a commit shows evidence, its diff and the worker's explanation", async () => {
  await page.click(`#wkList [data-wk="${W.id}"]`); await page.waitForSelector("#gfCard");
  await page.click('[data-gs="gitflow"]'); await page.waitForSelector(".gfc");
  await page.click('[data-gf-person="sameem"]'); await sleep(300);
  const rows = await page.locator(".gfc").count();
  await page.click(`[data-gf-open="${S.S3}"]`); await page.waitForFunction(() => /banner/.test(document.querySelector("#gfDetail")?.innerText || ""));
  const detail = await page.locator("#gfDetail").innerText();
  await shot("commits");
  assert(rows === 5 && /Ownership: BAU · confirmed/i.test(detail) && /The worker's explanation/i.test(detail) && /banner\(\) helper/.test(detail) && /src\/cart.js/.test(detail), JSON.stringify({ rows, detail: detail.slice(0, 300) }));
  return { sameemRows: rows };
});

await step("page: select PR #101's task → plan Ready → approve (confirm) → the new branch and 'existing branches changed: none'", async () => {
  await page.click('[data-gf-person=""]');
  await page.check('[data-gf-task="pr-101"]');
  await page.click("#gfToPlan"); await page.waitForSelector("#gfPreview"); await page.click("#gfPreview");
  await page.waitForSelector(".gfstatus"); const status = await page.locator(".gfstatus").first().innerText();
  await shot("plan-ready");
  await page.click("#gfApprove"); await page.waitForSelector("#dlg[open]"); await page.click('[data-dlg="go"]');
  await page.waitForFunction(() => /Created gitflow\//.test(document.querySelector("#gfBody").innerText));
  const out = await page.locator(".gfstatus").last().innerText();
  await shot("plan-created");
  assert(/^Ready/.test(status) && /Existing branches changed: none/.test(out), JSON.stringify({ status, out }));
  return { status: status.split("\n")[0], outcome: out.split("\n")[0] };
});

await step("page: S3 alone is blocked with the predicted conflict and the cross-team dependency, and can't be approved; History lists what happened", async () => {
  await page.click('[data-gf-tab="commits"]'); await page.waitForSelector(".gfc");
  await page.click("#gfClear"); await page.waitForFunction(() => !document.querySelector("[data-gf-sel]:checked"));
  await page.check(`[data-gf-sel="${S.S3}"]`); await page.click("#gfToPlan"); await page.click("#gfPreview"); await page.waitForSelector(".gfstatus");
  const txt = await page.locator("#gfBody").innerText(), disabled = await page.locator("#gfApprove").isDisabled();
  await shot("plan-blocked");
  await page.click('[data-gf-tab="history"]'); await page.waitForSelector(".gfaudit"); const hist = await page.locator(".gfaudit").innerText();
  assert(/Blocked/.test(txt) && /Conflicts: src\/cart.js/.test(txt) && /another team/.test(txt) && disabled && /execute/.test(hist), JSON.stringify({ txt: txt.slice(0, 400), disabled }));
  return { blocked: true, approveDisabled: disabled };
});
await step("page: Setup shows the repository and its authors; giving 'Dev Bot' a team from the list and saving adds them to the rules with their email", async () => {
  await page.click('[data-gf-tab="setup"]'); await page.waitForSelector(".gfauth"); await page.waitForSelector(".gfrepo");
  const repoCard = await page.locator(".gfrepo").innerText();
  const idx = await page.locator('.gfauth tr:has-text("Dev Bot") select').getAttribute("data-gf-auth");
  await page.selectOption(`[data-gf-auth="${idx}"]`, "innovax");
  await page.click("#gfSave"); await page.waitForFunction(() => /Saved/.test(document.querySelector("#gfMsg")?.textContent || ""));
  const people = (await gf("GET", "/config")).body.config.people, bot = people.find((p) => p.name === "Dev Bot");
  await shot("setup");
  assert(/origin/.test(repoCard) && /Fetch now/.test(repoCard) && bot?.team === "innovax" && bot.emails.join() === "bot@ci.test", JSON.stringify({ repoCard, bot }));
  const c = (await gf("GET", "/config")).body.config; await gf("PUT", "/config", { ...c, people: c.people.filter((p) => p.name !== "Dev Bot") });
  return { added: bot };
});
await b.close();

const MATW = process.env.MATW_SRC || "C:\\Users\\hp\\Desktop\\MATW\\matw-revamp-main-frontend-site";
await step("real MATW repository, read-only: dev-main → sabir-dev analysed in a private copy; the count matches git; no ref in MATW changed", async () => {
  if (!existsSync(join(MATW, ".git"))) return { skipped: "MATW repository not on this computer" };
  const before = refsOf(MATW);
  const eng = new GitFlow({ root: MATW, dir: join(DATA, "matw-readonly"), config: normalizeConfig({ refs: "remote", teams: [{ name: "BAU", ours: true }], mappings: [{ source: "dev-main", destination: "sabir-dev" }] }) });
  const a = await eng.analyse(eng.config.mappings[0], { limit: 300 });
  const git = execFileSync("git", ["rev-list", "--count", "origin/sabir-dev..origin/dev-main"], { cwd: MATW, encoding: "utf8" }).trim();
  assert(refsOf(MATW) === before, "a MATW ref changed");
  assert(String(a.pendingCount) === git || a.truncated, `${a.pendingCount} vs ${git}`);
  return { pending: a.pendingCount, git, prs: a.prs.length, copiesInDestination: a.commits.filter((c) => c.presence.state === "copy").length, refsUnchanged: true };
});

writeFileSync(join(HERE, "gitflow-results.json"), JSON.stringify({ when: new Date().toISOString(), results, pageErrors }, null, 1));
console.log(`\n${results.filter((x) => x.ok).length}/${results.length} passed; page errors: ${pageErrors.length ? pageErrors.join(" | ") : "none"}`);
