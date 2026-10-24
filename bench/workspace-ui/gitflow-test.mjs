// The Git workflow worker end to end: created through the describe-the-work flow, configured, its
// commit explorer, plans for each strategy, guarded execution, its read-only tools, a real worker
// run, the page, and a read-only pass over the real MATW repository (if present) that proves no
// branch there moves. Write experiments happen only in a disposable fixture (bench/gitflow/fixture.mjs).
//   DATA=<console data dir>   node bench/workspace-ui/gitflow-test.mjs <port>     (run-suite.sh gitflow)
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync, spawn } from "node:child_process";
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
let W, cfgPath, createdBranch;
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

await step("prod-main is off-limits: refused as a relationship, never copied into the private repository, never listed or used for authors; an older saved setup is upgraded", async () => {
  const c = (await gf("GET", "/config")).body.config;
  const refused = await gf("PUT", "/config", { ...c, mappings: [...c.mappings, { source: "sabir-uat", destination: "prod-main", kind: "promote" }] });
  const names = (await gf("GET", "/repo")).body.branches.map((x) => x.name), au = (await gf("GET", "/authors")).body;
  const scratchRefs = execFileSync("git", ["for-each-ref", "--format=%(refname)"], { cwd: join(DATA, "gitflow", W.id, "scratch"), encoding: "utf8" });
  // a configuration saved by the first version: prod-main, main and master in "shared", nothing off-limits
  const f = join(DATA, "gitflow", W.id, "config.json"), raw = JSON.parse(readFileSync(f, "utf8"));
  writeFileSync(f, JSON.stringify({ ...raw, shared: ["dev-main", "uat-main", "preprod-main", "prod-main", "main", "master"], forbidden: undefined }));
  const upgraded = (await gf("GET", "/config")).body.config;
  writeFileSync(f, JSON.stringify(raw));
  assert(refused.status === 400 && /off-limits/.test(refused.body.error), JSON.stringify(refused.body));
  assert(!names.includes("prod-main") && !/^refs\/(heads|remotes\/origin)\/prod-main$/m.test(scratchRefs) && !au.branches.includes("prod-main") && !au.authors.some((a) => a.name === "Prod Hotfixer"), JSON.stringify({ names, branches: au.branches }));
  assert(upgraded.shared.join() === "dev-main,uat-main,preprod-main" && upgraded.forbidden.join() === "prod-main", JSON.stringify(upgraded));
  return { refused: refused.body.error, listed: names.includes("prod-main"), upgraded: { shared: upgraded.shared, forbidden: upgraded.forbidden } };
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
  assert(f1.destination.shared && /nothing is ever pushed or written to it/.test(f1.execution) && /pull request into preprod-main/.test(f1.execution), f1.execution);
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
  createdBranch = r.body.branch;
  return { branch: r.body.branch, recovery: r.body.recovery };
});

await step("into a destination only by pull request: the approved proposal branch is pushed under its own new name (no other origin branch changes); anything else is refused", async () => {
  const bad = await Promise.all([gf("POST", "/pr", { branch: "sabir-dev" }), gf("POST", "/pr", { branch: "gitflow/not-from-a-plan" }), gf("POST", "/pr", { branch: "preprod-main" })]);
  assert(bad.every((x) => x.status === 400), JSON.stringify(bad.map((x) => x.body)));
  const r = await gf("POST", "/pr", { branch: createdBranch });
  const now = refsOf(fx.origin).split("\n"), was = originRefs0.split("\n");
  const added = now.filter((l) => l && !was.includes(l));
  assert(r.status === 200 && r.body.pushed && r.body.base === "sabir-dev" && added.length === 1 && added[0].startsWith(`refs/heads/${createdBranch} `) && was.every((l) => !l || now.includes(l)), JSON.stringify({ body: r.body, added }));
  assert(/plan /.test(r.body.title) && /Review before merging/.test(r.body.body) && /Branch created with the approval of Sabir <sabir@matw.test>; pushed and opened with the approval of Sabir <sabir@matw.test>/.test(r.body.body) && /\*\*Not in this pull request\*\*/.test(r.body.body) && /rule: other teams' changes/.test(r.body.body), r.body.body);
  return { pushed: createdBranch, base: r.body.base, originAdded: added.length, refused: bad.map((x) => x.body.error) };
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

await step("D1: another team's earlier change to the same file, not selected, needs explicit confirmation only when Git applies the selected change cleanly; a conflict, an unknown owner, or selecting the other team's change still blocks", async () => {
  const s6 = await preview({ select: [S.S6] }), s7 = await preview({ select: [S.S7] }), s3 = await preview({ select: [S.S3] }), both = await preview({ select: [S.S6, S.I2] });
  const ov = s6.reviewItems.find((r) => r.kind === "cross-team-overlap");
  assert(s6.status === "review" && !s6.blockers.length && ov?.on === S.I2 && ov.files.join() === "src/receipt-mail.js" && s6.dependencies.find((d) => d.sha === S.S6)?.decision === "confirm", JSON.stringify({ status: s6.status, blockers: s6.blockers, reviewItems: s6.reviewItems }));
  assert(s7.status === "blocked" && s7.blockers.some((b) => /owner is unknown/.test(b)) && s7.dependencies.find((d) => d.on === S.U1)?.decision === "block", JSON.stringify(s7.blockers));
  assert(s3.status === "blocked" && s3.blockers.some((b) => /predicted conflict/.test(b)) && s3.blockers.some((b) => /may depend on/.test(b)) && s3.dependencies.find((d) => d.on === S.I1)?.decision === "block" && !s3.reviewItems.length, JSON.stringify(s3.blockers));
  assert(both.status === "blocked" && both.items.find((i) => i.sha === S.I2)?.status === "blocked" && both.blockers.some((b) => /other teams' changes/.test(b)), JSON.stringify(both.blockers));
  return { S6: `${s6.status}: ${ov.id}`, S7: s7.blockers[0], S3: s3.blockers, "S6+I2": both.blockers };
});

await step("D1: the confirmation must be the plan's exact list: missing, a plain yes, a wrong id or an extra id are refused (and audited); the exact list creates a branch without Innovax's change, and the audit records who confirmed what", async () => {
  const p = await preview({ select: [S.S6] }), ids = p.reviewItems.map((r) => r.id);
  const bad = [await gf("POST", "/execute", { plan: p.id }), await gf("POST", "/execute", { plan: p.id, acknowledge: true }), await gf("POST", "/execute", { plan: p.id, acknowledge: ["overlap:000000000:111111111"] }), await gf("POST", "/execute", { plan: p.id, acknowledge: [...ids, "owner:000000000"] })];
  const before = refsOf(fx.repo), ok = await gf("POST", "/execute", { plan: p.id, acknowledge: ids });
  assert(bad.every((x) => x.status === 400) && /Confirm each point/.test(bad[0].body.error) && /Confirm each point/.test(bad[1].body.error) && /doesn't match/.test(bad[2].body.error) && /doesn't match/.test(bad[3].body.error), JSON.stringify(bad.map((x) => x.body.error)));
  assert(ok.status === 200, JSON.stringify(ok.body));
  const mail = execFileSync("git", ["show", `${ok.body.branch}:src/receipt-mail.js`], { cwd: fx.repo, encoding: "utf8" });
  const log = execFileSync("git", ["log", "--format=%s", `origin/sabir-dev..${ok.body.branch}`], { cwd: fx.repo, encoding: "utf8" }).trim().split("\n");
  const added = refsOf(fx.repo).split("\n").filter((l) => l && !before.includes(l));
  assert(/signature = 'The MATW team'/.test(mail) && /subject = 'Your receipt'/.test(mail) && !/Your MATW receipt/.test(mail) && log.join() === "DON-16 receipt signature" && added.length === 1, JSON.stringify({ mail, log, added }));
  const audit = (await gf("GET", "/audit")).body.audit, ex = audit.find((e) => e.action === "execute" && e.branch === ok.body.branch);
  const refusals = audit.filter((e) => e.action === "refused" && e.plan === p.id).map((e) => e.why);
  assert(ex.confirmed.map((c) => c.id).join() === ids.join() && ex.confirmed[0].kind === "cross-team-overlap" && /Sabir <sabir@matw.test>/.test(ex.approvedBy), JSON.stringify(ex));
  assert(refusals.includes("not confirmed") && refusals.includes("confirmation doesn't match"), refusals.join());
  return { refused: bad.map((x) => x.body.error.slice(0, 60)), branch: ok.body.branch, confirmed: ex.confirmed.map((c) => c.id), approvedBy: ex.approvedBy };
});

await step("D5: unknown owners have their own rule, on by default: a configuration saved before it existed still blocks them even with 'uncertain' off; relaxing 'uncertain' doesn't let an unknown author through; only turning 'unknown' off makes it a point to confirm", async () => {
  const c = (await gf("GET", "/config")).body.config, f = join(DATA, "gitflow", W.id, "config.json"), saved = readFileSync(f, "utf8"), raw = JSON.parse(saved);
  delete raw.exclude.unknown; raw.exclude.uncertain = false; writeFileSync(f, JSON.stringify(raw));
  const old = (await gf("GET", "/config")).body.config, u1old = await preview({ select: [S.U1] }), n1old = await preview({ select: [S.N1] });
  writeFileSync(f, saved);
  await gf("PUT", "/config", { ...c, exclude: { ...c.exclude, uncertain: false } }); const u1a = await preview({ select: [S.U1] }), n1a = await preview({ select: [S.N1] });
  await gf("PUT", "/config", { ...c, exclude: { ...c.exclude, unknown: false } }); const u1b = await preview({ select: [S.U1] });
  await gf("PUT", "/config", c);
  assert(c.exclude.unknown === true && old.exclude.unknown === true && old.exclude.uncertain === false && u1old.status === "blocked" && u1old.blockers.some((b) => /rule: unknown owner/.test(b)) && n1old.status === "review", JSON.stringify({ old: old.exclude, u1old: u1old.blockers, n1old: n1old.status }));
  assert(u1a.status === "blocked" && n1a.status === "review" && n1a.reviewItems.some((r) => r.id.startsWith("owner:")), JSON.stringify({ u1a: u1a.blockers, n1a: n1a.reviews }));
  assert(u1b.status === "review" && u1b.reviewItems.some((r) => r.kind === "owner" && /unknown/.test(r.text)), JSON.stringify(u1b.reviews));
  return { oldConfig: old.exclude, uncertainOff: { U1: u1a.status, N1: n1a.status }, unknownOff: { U1: u1b.status } };
});

await step("settings: each save is audited with what changed (from → to) and who; a plan made before a settings change is refused as stale", async () => {
  const c = (await gf("GET", "/config")).body.config, p = await preview({ select: [S.S1] });
  await gf("PUT", "/config", { ...c, exclude: { ...c.exclude, reverted: false } });
  const r = await gf("POST", "/execute", { plan: p.id });
  await gf("PUT", "/config", c);
  const audit = (await gf("GET", "/audit")).body.audit, e = audit.find((x) => x.action === "config" && x.changes?.some((ch) => ch.field === "exclude.reverted" && ch.to === "false"));
  const ch = e?.changes.find((x) => x.field === "exclude.reverted");
  assert(r.status === 400 && /changed since this plan/.test(r.body.error), JSON.stringify(r.body));
  assert(e && ch.from === "true" && /Sabir <sabir@matw.test>/.test(e.by) && e.exclude.unknown === true, JSON.stringify(e));
  return { refused: r.body.error, audited: { by: e.by, changes: e.changes } };
});

await step("one writer at a time: 13 requests at once for this worker (analyses, repository reads, authors, previews, a fetch) and 3 analyses from another process all succeed, with the same results, and leave no lock behind", async () => {
  const child = join(DATA, "gf-other.mjs");
  writeFileSync(child, `import { GitFlow, normalizeConfig } from ${JSON.stringify("file:///" + join(REPO, "worker-ui", "gitflow.mjs").replace(/\\/g, "/"))};
const cfg = normalizeConfig({}, JSON.parse(process.argv[2]));
const r = await Promise.all([0, 1, 2].map(() => new GitFlow({ root: process.argv[3], dir: process.argv[4], config: cfg }).analyse(cfg.mappings[0]).then((a) => a.pendingCount)));
console.log(JSON.stringify(r));`);
  const cfg = (await gf("GET", "/config")).body.config;
  const other = new Promise((ok, fail) => { const p = spawn(process.execPath, [child, JSON.stringify(cfg), fx.repo, join(DATA, "gitflow", W.id)]); let o = "", e = ""; p.stdout.on("data", (d) => (o += d)); p.stderr.on("data", (d) => (e += d)); p.on("close", (code) => (code ? fail(new Error(e.slice(0, 400))) : ok(JSON.parse(o)))); });
  const reqs = [...[0, 1, 2, 3].map(() => gf("GET", "/analysis?mapping=dev-main-to-sabir-dev")), ...[0, 1, 2].map(() => gf("GET", "/repo")), ...[0, 1].map(() => gf("GET", "/authors")),
    ...[0, 1].map(() => gf("POST", "/preview", { mapping: "dev-main-to-sabir-dev", strategy: "selective", select: [S.S1, S.S2] })), gf("POST", "/fetch"), gf("GET", "/analysis?mapping=uat-main-to-sabir-uat")];
  const [rs, otherCounts] = await Promise.all([Promise.all(reqs), other]);
  const counts = rs.slice(0, 4).map((x) => x.body.pendingCount), ids = rs.slice(9, 11).map((x) => x.body.id);
  assert(rs.every((x) => x.status === 200), JSON.stringify(rs.map((x) => x.status + (x.status !== 200 ? " " + x.body?.error : ""))));
  assert(new Set([...counts, ...otherCounts]).size === 1 && ids[0] === ids[1] && !existsSync(join(DATA, "gitflow", W.id, "repo.lock")) , JSON.stringify({ counts, otherCounts, ids }));
  return { requests: rs.length, otherProcess: otherCounts, pending: counts[0] };
});

await step("identity, per-file statistics and Git graph data: this clone's Git identity matches Sabir (for 'Mine'); plans carry line counts per file; the analysis carries the merge base and the destination's own commits (S5's copy)", async () => {
  const me = (await gf("GET", "/identity")).body, a = await analysis(), p = await preview({ select: [S.S1, S.S2] });
  assert(me.identity?.email === "sabir@matw.test" && me.person?.id === "sabir", JSON.stringify(me));
  assert(p.result.stats.map((s) => `${s.path}:+${s.added}`).sort().join() === "src/donate.css:+1,src/donate.js:+1", JSON.stringify(p.result.stats));
  assert(a.graph.base && a.graph.destination.some((c) => c.sha === S.S5copy) && a.graph.destinationTotal >= 1, JSON.stringify(a.graph).slice(0, 300));
  return { me: me.person, stats: p.result.stats, base: a.graph.baseShort, destinationOnly: a.graph.destination.map((c) => c.subject) };
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

// ---- the page (design: Figma "Git Sync v2 · Screens") ----
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1440, height: 950 } });
const pageErrors = []; page.on("pageerror", (e) => pageErrors.push(e.message));
const shot = (n) => page.screenshot({ path: join(HERE, "shots", `gitflow-${n}.png`) });
const bodyText = () => page.locator("#gfBody").innerText();
await page.goto(BASE, { waitUntil: "networkidle" });
await page.click(`#wsList [data-ws="${ws.id}"]`);

await step("page: the worker's new task opens its Git workflow on Overview (counts, branch rules, mode); Changes lists your team's selectable changes; Sameem's two excluded ones appear only when asked, and can't be ticked; a commit shows evidence, its diff and the worker's explanation", async () => {
  await page.click(`#wkList [data-wk="${W.id}"]`); await page.waitForSelector("#gfCard");
  await page.click('[data-gs="gitflow"]'); await page.waitForSelector(".gfkpis");
  await page.waitForFunction(() => /PENDING COMMITS\s*\n?\s*\d+/i.test(document.querySelector(".gfkpis")?.innerText || ""));
  const ov = await bodyText(); await shot("overview");
  await page.click('[data-gf-tab="changes"]'); await page.waitForSelector(".gfc");
  await page.click('[data-gf-person="sameem"]'); await sleep(300);
  const selectable = await page.locator(".gfc").count();
  await page.click("#gfShowEx"); await sleep(300);
  const all = await page.locator(".gfc").count(), locked = await page.locator(".gfc input:disabled").count();
  await page.click(`[data-gf-open="${S.S3}"]`); await page.waitForFunction(() => /banner/.test(document.querySelector("#gfDetail")?.innerText || ""));
  const detail = await page.locator("#gfDetail").innerText();
  await shot("changes");
  assert(/prod-main/.test(ov) && /off-limits/i.test(ov) && /Proposals allowed/.test(ov) && /dev-main/.test(ov), ov.slice(0, 400));
  assert(selectable === 3 && all === 5 && locked === 2, JSON.stringify({ selectable, all, locked }));
  assert(/Ownership: BAU · confirmed/i.test(detail) && /The worker's explanation/i.test(detail) && /banner\(\) helper/.test(detail) && /src\/cart.js/.test(detail), detail.slice(0, 300));
  return { sameem: { selectable, all, locked } };
});

await step("page: other teams', reverted and unknown-owner changes can't be ticked; S3 is flagged (same file as Innovax's I1) and its plan is blocked by the conflict and the dependency; Create and Export patch stay disabled; leaving S3 out gives a ready plan of PR #101", async () => {
  await page.click('[data-gf-person=""]'); await page.click('[data-gf-who="all"]'); await sleep(200);
  const locked = await Promise.all([S.I1, S.U1, S.S4, S.N1].map((s) => page.locator(`[data-gf-sel="${s}"]`).isDisabled()));
  await page.click("#gfShowEx"); await sleep(200); // hide them again
  await page.check('[data-gf-task="pr-101"]'); await page.check(`[data-gf-sel="${S.S3}"]`);
  await page.waitForFunction(() => /plan is blocked/.test(document.querySelector("#gfBody").innerText));
  const warn = await bodyText();
  await page.click("#gfToPlan"); await page.waitForSelector(".gfstatus");
  const blocked = await page.locator(".gfstatus").innerText(), noCreate = (await page.locator("#gfApprove").count()) === 0;
  const createOff = await page.locator('.gfdock button:has-text("Create proposal branch")').isDisabled(), patchOff = await page.locator('.gfdock button:has-text("Export patch")').isDisabled();
  const graphOn = !(await page.locator('[role="tab"]:has-text("Git graph")').isDisabled());
  await page.click("#gfResolve"); await page.waitForSelector("#gfLeaveOut");
  const deps = await bodyText(); await shot("plan-blocked");
  await page.click("#gfLeaveOut"); await page.waitForFunction(() => /^Ready/m.test(document.querySelector(".gfstatus")?.innerText || ""));
  const ready = await page.locator(".gfstatus").innerText(), items = await page.locator(".gfit").count();
  await shot("plan-ready");
  assert(locked.every(Boolean), JSON.stringify(locked));
  assert(/another team's unselected/.test(warn) && /never included/.test(warn) && /plan is blocked/.test(warn), warn.slice(0, 300));
  assert(/Blocked/.test(blocked) && /predicted conflict/.test(blocked) && noCreate && createOff && patchOff && graphOn, JSON.stringify({ blocked, noCreate, createOff, patchOff, graphOn }));
  assert(/conflicts when applied/.test(deps) && /may depend on/.test(deps) && /not in v1/i.test(deps), deps.slice(0, 400));
  assert(items === 2, String(items));
  return { blocked: blocked.split("\n")[0], leftOut: "S3", ready: ready.split("\n")[0] };
});

await step("page: Create asks first (what's created, what isn't), then shows the new branch and 'existing branches changed: none'; pushing asks a second time and pushes only the new branch", async () => {
  await page.click("#gfApprove"); await page.waitForSelector("#dlg[open]");
  const dlg1 = await page.locator("#dlgB").innerText(); await page.click('[data-dlg="go"]');
  await page.waitForFunction(() => /Created gitflow\//.test(document.querySelector("#gfBody").innerText));
  const out = await bodyText(); await shot("plan-created");
  await page.click("#gfPR"); await page.waitForSelector("#dlg[open]");
  const dlg2 = await page.locator("#dlgB").innerText(); await page.click('[data-dlg="go"]');
  await page.waitForSelector("#gfPrDone"); const pr = await page.locator("#gfPrDone").innerText();
  await shot("plan-pr");
  assert(/It will not/.test(dlg1) && /push anything/.test(dlg1) && /UTC time/.test(dlg1), dlg1);
  assert(/Existing branches changed: none/.test(out) && /To discard/.test(out), out.slice(0, 400));
  assert(/Nothing is pushed to sabir-dev/.test(dlg2) && /Pushed gitflow\//.test(pr), JSON.stringify({ dlg2, pr }));
  return { created: out.match(/Created (gitflow\/\S+)/)?.[1], pr: pr.split("\n")[0] };
});

await step("page: 'Mine' shows this clone's own changes (Sabir); S6's plan asks to confirm Innovax's same-file change; the Git graph tab shows both sides and the merge base; creating the branch with it confirmed leaves Innovax's change out", async () => {
  await page.click("#gfDone"); await page.waitForSelector(".gfc");
  await page.click('[data-gf-who="mine"]'); await sleep(300);
  const metas = await page.locator(".gfc .meta").allInnerTexts();
  await page.check(`[data-gf-sel="${S.S6}"]`);
  await page.waitForFunction(() => /never included/.test(document.querySelector("#gfBody").innerText));
  await page.click("#gfToPlan"); await page.waitForFunction(() => /Needs your review/.test(document.querySelector(".gfstatus")?.innerText || ""));
  await page.click('[data-gf-ptab="graph"]'); await page.waitForFunction(() => /Merge base/i.test(document.querySelector("#gfBody").innerText));
  const graph = await bodyText(); await shot("plan-graph");
  await page.click("#gfApprove"); await page.waitForSelector("#dlg[open]");
  const dlg = await page.locator("#dlgB").innerText(), off = await page.locator('[data-dlg="go"]').isDisabled();
  await page.check("[data-gf-ack]"); await page.click('[data-dlg="go"]');
  await page.waitForFunction(() => /Created gitflow\//.test(document.querySelector("#gfBody").innerText));
  const branch = (await bodyText()).match(/Created (gitflow\/\S+)/)[1];
  const mail = execFileSync("git", ["show", `${branch}:src/receipt-mail.js`], { cwd: fx.repo, encoding: "utf8" });
  assert(metas.length >= 2 && metas.every((m) => /Sabir/.test(m)), JSON.stringify(metas));
  assert(/Merge base/i.test(graph) && /Tweak the footer/.test(graph) && /Who wrote what/.test(graph), graph.slice(0, 400));
  assert(/Another team's change stays out/.test(dlg) && off, dlg);
  assert(/The MATW team/.test(mail) && !/Your MATW receipt/.test(mail), mail);
  return { mine: metas.length, branch, innovaxChangeLeftOut: true };
});

await step("page: Settings shows 'uncertain owner' and 'unknown owner' as separate rules, unknown on by default (D5); turning 'block reverted' off makes S4 need review, and Create stays disabled until the review point is ticked", async () => {
  await page.click("#gfDone"); await page.waitForSelector(".gfc");
  await page.click('[data-gf-tab="settings"]'); await page.waitForSelector("#gfExRev");
  const unc = await page.locator("#gfExUnc").evaluate((x) => ({ checked: x.checked, disabled: x.disabled })), unk = await page.locator("#gfExUnk").evaluate((x) => ({ checked: x.checked, disabled: x.disabled }));
  await page.uncheck("#gfExRev"); await page.waitForFunction(() => document.querySelector("#gfDirty")?.textContent === "Unsaved changes");
  await page.click("#gfSave"); await page.waitForFunction(() => /Saved/.test(document.querySelector("#gfMsg")?.textContent || ""));
  const saved = (await gf("GET", "/config")).body.config.exclude;
  await page.click('[data-gf-tab="changes"]'); await page.waitForSelector(`[data-gf-sel="${S.S4}"]`);
  await page.check(`[data-gf-sel="${S.S4}"]`); await page.click("#gfToPlan");
  await page.waitForFunction(() => /Needs your review/.test(document.querySelector(".gfstatus")?.innerText || ""));
  await page.click("#gfApprove"); await page.waitForSelector("#dlg[open]");
  const before = await page.locator('[data-dlg="go"]').isDisabled();
  await page.check("[data-gf-ack]"); const after = await page.locator('[data-dlg="go"]').isDisabled();
  await shot("plan-review-confirm");
  await page.click('[data-dlg="cancel"]');
  assert(unc.checked && !unc.disabled && unk.checked && !unk.disabled && saved.uncertain === true && saved.unknown === true && saved.reverted === false, JSON.stringify({ unc, unk, saved }));
  assert(before === true && after === false, JSON.stringify({ before, after }));
  return { d5: { uncertain: unc, unknown: unk }, createDisabledUntilTicked: { before, after } };
});

await step("page: a stale plan (the destination moved after the preview) is refused and shown as out of date with Preview again; History lists the creation, the push and the refusal", async () => {
  const moved = execFileSync("git", ["commit-tree", "-p", "refs/remotes/origin/sabir-dev", "-m", "someone else", "refs/remotes/origin/sabir-dev^{tree}"], { cwd: fx.repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" } }).trim();
  const old = execFileSync("git", ["rev-parse", "refs/remotes/origin/sabir-dev"], { cwd: fx.repo, encoding: "utf8" }).trim();
  execFileSync("git", ["update-ref", "refs/remotes/origin/sabir-dev", moved], { cwd: fx.repo });
  let stale;
  try {
    await page.click("#gfApprove"); await page.waitForSelector("#dlg[open]"); await page.check("[data-gf-ack]"); await page.click('[data-dlg="go"]');
    await page.waitForFunction(() => /out of date/.test(document.querySelector("#gfBody").innerText));
    stale = await bodyText(); await shot("plan-stale");
  } finally { execFileSync("git", ["update-ref", "refs/remotes/origin/sabir-dev", old], { cwd: fx.repo }); }
  const again = await page.locator("#gfPreview2").count();
  await page.click('[data-gf-tab="history"]'); await page.waitForSelector(".gfaudit"); const hist = await page.locator(".gfaudit").innerText();
  await shot("history");
  assert(/This plan is out of date/.test(stale) && again === 1 && (await page.locator("#gfApprove").count()) === 0, stale.slice(0, 300));
  assert(/Branch created/.test(hist) && /Pushed/.test(hist) && /Refused/.test(hist) && /stale/.test(hist), hist.slice(0, 500));
  return { stale: "refused and shown", history: [...new Set(hist.split("\n").filter((l) => /Branch created|Pushed|Refused|Settings saved|Preview/.test(l)))].slice(0, 6) };
});

await step("page: Settings shows the repository and its authors; giving 'Dev Bot' a team marks unsaved changes, leaving asks first, and saving adds them with their email", async () => {
  await page.click('[data-gf-tab="settings"]'); await page.waitForSelector(".gfauth"); await page.waitForSelector(".gfrepo");
  const repoCard = await page.locator(".gfrepo").innerText();
  const idx = await page.locator('.gfauth tr:has-text("Dev Bot") select').getAttribute("data-gf-auth");
  await page.selectOption(`[data-gf-auth="${idx}"]`, "innovax");
  await page.waitForFunction(() => document.querySelector("#gfDirty")?.textContent === "Unsaved changes");
  await page.click('[data-gf-tab="overview"]'); await page.waitForSelector("#dlg[open]"); const ask = await page.locator("#dlgB").innerText();
  await page.click('[data-dlg="keep"]'); await sleep(200); const still = await page.locator("#gfSetup").count();
  await page.click("#gfSave"); await page.waitForFunction(() => /Saved/.test(document.querySelector("#gfMsg")?.textContent || ""));
  const c = (await gf("GET", "/config")).body.config, bot = c.people.find((p) => p.name === "Dev Bot");
  await shot("settings");
  assert(/origin/.test(repoCard) && /Fetch now/.test(repoCard) && /Git workflow settings/.test(ask) && still === 1 && bot?.team === "innovax" && bot.emails.join() === "bot@ci.test", JSON.stringify({ repoCard, ask, still, bot }));
  await gf("PUT", "/config", { ...c, people: c.people.filter((p) => p.name !== "Dev Bot"), exclude: { ...c.exclude, reverted: true } });
  return { added: bot, askedBeforeLeaving: true };
});

await step("page: at 820 px the Changes page doesn't scroll sideways and its action bar stays on screen", async () => {
  await page.setViewportSize({ width: 820, height: 760 }); await sleep(300);
  await page.click('[data-gf-tab="changes"]'); await page.waitForSelector(".gfc");
  const m = await page.evaluate(() => { const b = document.querySelector("#gfBody"), d = document.querySelector(".gfdock").getBoundingClientRect(); return { sw: b.scrollWidth, cw: b.clientWidth, dockTop: Math.round(d.top), dockBottom: Math.round(d.bottom), h: window.innerHeight }; });
  await shot("narrow");
  assert(m.sw <= m.cw + 1 && m.dockBottom <= m.h + 1 && m.dockTop < m.h, JSON.stringify(m));
  return m;
});
await step("page: no script errors", async () => { assert(!pageErrors.length, pageErrors.join(" | ")); return { pageErrors: 0 }; });
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
