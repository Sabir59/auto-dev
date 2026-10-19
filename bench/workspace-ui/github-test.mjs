// GitHub centralization, end to end: the console (its own test instance and data), the real page
// in a real browser, a mock GitHub API (bench/github/mock-github.mjs, no real credentials) and real
// local Git repositories whose "GitHub" remotes are local bare repositories. Two short real worker
// runs (Haiku) prove what the runtime actually gives a worker at each access level.
//   via bench/workspace-ui/run-suite.sh github  (sets GITHUB_API_BASE / GITHUB_CONNECTOR_DIR)
import { chromium } from "../../browser-adapter/node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { startMock, TOKENS } from "../github/mock-github.mjs";
import { makeRepo } from "../github/repo-tools-test.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const [port = "8797"] = process.argv.slice(2);
const BASE = `http://127.0.0.1:${port}`, { DATA, GHDIR } = process.env;
const H = { origin: BASE, "x-worker-console": "1", "content-type": "application/json" };
const call = (method, path, data) => fetch(BASE + path, { method, headers: H, body: data ? JSON.stringify(data) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const must = (c, m) => { if (!c) throw new Error(m); };
const g = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const results = [], errors = [];
const step = async (name, fn) => { try { const d = await fn(); results.push({ step: name, ok: true, detail: d }); console.log("PASS", name, JSON.stringify(d).slice(0, 240)); } catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 300)); await page.screenshot({ path: join(HERE, "shots", `github-fail-${results.length}.png`) }).catch(() => {}); } };
const raw = (id) => readFileSync(join(DATA, "runs", `${id}.raw.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
const inits = (id) => raw(id).filter((x) => x.type === "system" && x.subtype === "init");
// After End, the worker process takes a moment to exit; the next run waits for it.
async function idle() { for (let i = 0; i < 60; i++) { if (!(await call("GET", "/runs")).body.active) return; await new Promise((r) => setTimeout(r, 500)); } throw new Error("a worker is still running"); }
async function settle(id, ms = 240000) { const t0 = Date.now(); for (;;) { const m = (await call("GET", `/runs/${id}`)).body; if (!["starting", "running"].includes(m.status)) return m; if (Date.now() - t0 > ms) throw new Error("run didn't settle"); await new Promise((r) => setTimeout(r, 1500)); } }

const root = mkdtempSync(join(tmpdir(), "gh-")), A = makeRepo(root, "site"), B = makeRepo(root, "other"), D = makeRepo(root, "docs");
const mock = await startMock(8785, [{ owner: "alice", name: "site", private: true, url: A.url }, { owner: "alice", name: "docs", url: D.url }, { owner: "bob", name: "other", private: true, url: B.url }]);
const setMock = (j) => fetch(`${mock.url}/__mock`, { method: "POST", body: JSON.stringify(j) });
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1280, height: 1000 } });
page.on("pageerror", (e) => errors.push(e.message));
const credFile = join(GHDIR, "credentials.json");
let site, siteId, reader, committer, runA;

try {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await step("16a. the GitHub page: not connected, nothing registered (empty states), discovery disabled", async () => {
    await page.click("#ghOpen");
    await page.waitForSelector("#ghBody .wstat");
    const t = await page.locator("#ghBody").innerText();
    must(/Not connected/.test(t) && /None yet/.test(t) && await page.locator("#ghFind").isDisabled() && (await page.locator("#ghState").innerText()) === "Not connected", t);
    return { state: "Not connected", empty: true };
  });
  await step("1. connection: a malformed token and a rejected one are refused (nothing saved); a valid one connects", async () => {
    const bad = await call("POST", "/github/connection", { token: "hello" }), rejected = await call("POST", "/github/connection", { token: "github_pat_" + "Z".repeat(40) });
    must(bad.status === 400 && rejected.status === 401 && /rejected/.test(rejected.body.error) && !existsSync(credFile), JSON.stringify({ bad, rejected }));
    await page.fill("#ghToken", TOKENS.alice); await page.click("#ghConnect");
    await page.waitForFunction(() => /Connected as @alice/.test(document.querySelector("#ghBody")?.innerText || ""));
    return { malformed: bad.body.error.slice(0, 60), rejected: rejected.body.error.slice(0, 70), connected: "@alice", savedOutsideData: existsSync(credFile) };
  });
  await step("the token never comes back: not in the page's API, the registry file, the page or the console's log", async () => {
    const api = JSON.stringify((await call("GET", "/github")).body), reg = readFileSync(join(DATA, "github.json"), "utf8"), html = await page.content(), log = readFileSync(join(DATA, "console.log"), "utf8");
    const leaks = Object.entries({ api, reg, html, log }).filter(([, v]) => v.includes(TOKENS.alice)).map(([k]) => k);
    must(!leaks.length && !credFile.toLowerCase().startsWith(DATA.toLowerCase() + "\\"), JSON.stringify({ leaks, credFile }));
    return { inApi: false, inRegistry: false, inPage: false, inLog: false, credentialFolder: "outside the console's data" };
  });
  await step("2. discovery lists only what this identity can see (with a loading state)", async () => {
    await setMock({ delayMs: 1200 });
    await page.click("#ghFind");
    const loading = await page.locator("#ghFind").innerText();
    await page.waitForSelector(".ghfound");
    await setMock({ delayMs: 0 });
    const names = await page.locator(".ghfound .ell").allInnerTexts();
    must(loading === "Looking…" && names.sort().join() === "alice/docs,alice/site", JSON.stringify({ loading, names }));
    return { loading, found: names, notListed: "bob/other" };
  });
  await step("3-4. register from discovery; a duplicate, an invisible repository and a bad name are refused safely", async () => {
    await page.click('[data-gh-reg="alice/site"]');
    await page.waitForFunction(() => /Registered alice\/site/.test(document.querySelector("#ghMsg")?.innerText || ""));
    const gh = (await call("GET", "/github")).body; site = gh.repos.find((r) => r.fullName === "alice/site");
    const dup = await call("POST", "/github/repos", { fullName: "alice/site" }), hidden = await call("POST", "/github/repos", { fullName: "bob/other" }), badName = await call("POST", "/github/repos", { fullName: "../etc" });
    await call("POST", "/github/repos", { fullName: "alice/docs" });
    must(site?.id === "gh-1000" && site.defaultBranch === "main" && site.private && dup.status === 409 && hidden.status === 404 && badName.status === 400 && (await call("GET", "/github")).body.repos.length === 2, JSON.stringify({ site, dup, hidden, badName }));
    return { entry: { id: site.id, fullName: site.fullName, defaultBranch: site.defaultBranch, url: site.url.slice(-30) }, duplicate: dup.status, invisible: hidden.status, badName: badName.status };
  });
  await step("5. refresh reads metadata again; a revoked repository is marked inaccessible, then recovers", async () => {
    await setMock({ set: { "alice/site": { defaultBranch: "trunk" } } });
    const r1 = (await call("POST", `/github/repos/${site.id}/refresh`)).body;
    await setMock({ revoked: ["alice/site"] });
    const r2 = (await call("POST", `/github/repos/${site.id}/refresh`)).body;
    await setMock({ revoked: [], set: { "alice/site": { defaultBranch: "main" } } });
    const r3 = (await call("POST", `/github/repos/${site.id}/refresh`)).body;
    must(r1.defaultBranch === "trunk" && r2.status === "inaccessible" && /can't see it/.test(r2.error) && r3.status === "ok" && r3.defaultBranch === "main", JSON.stringify({ r1, r2, r3 }));
    return { refreshed: r1.defaultBranch, revoked: r2.status, recovered: r3.status };
  });
  await step("14. rate limits and GitHub failures give useful errors (API and page)", async () => {
    await setMock({ rateLimited: true });
    const d = await call("GET", "/github/discover?refresh=1"), v = await call("POST", "/github/connection/verify");
    await page.click("#ghFind"); await page.waitForSelector("#ghBody .err");
    const shown = await page.locator("#ghBody .err").first().innerText();
    await setMock({ rateLimited: false });
    must(d.status === 429 && /rate limit/.test(d.body.error) && v.status === 429 && /rate limit/.test(shown), JSON.stringify({ d, v, shown }));
    await call("POST", "/github/connection/verify");
    return { discover: d.body.error, pageShows: shown.slice(0, 80) };
  });
  await step("6. assignment: a folder whose origin is another repository is refused; the checkout is assigned and persists; it can be changed", async () => {
    const ws1 = (await call("POST", "/workspaces", { name: "Site", path: A.work, mode: "work" })).body, ws2 = (await call("POST", "/workspaces", { name: "Other", path: B.work, mode: "work" })).body;
    siteId = ws1.id;
    const wrong = await call("PUT", `/workspaces/${ws2.id}/repo`, { repo: site.id }), scratch = await call("PUT", "/workspaces/scratch/repo", { repo: site.id }), forged = await call("PUT", `/workspaces/${siteId}/repo`, { repo: "gh-999" });
    await call("PUT", `/workspaces/${siteId}/repo`, { repo: site.id, general: "read" });
    const a = (await call("PUT", `/workspaces/${siteId}/repo`, { repo: site.id, general: "write" })).body;
    const listed = (await call("GET", "/workspaces")).body.find((w) => w.id === siteId), file = JSON.parse(readFileSync(join(DATA, "workspaces.json"), "utf8")).find((w) => w.id === siteId);
    must(wrong.status === 400 && /origin/.test(wrong.body.error) && scratch.status === 400 && forged.status === 400 && a.repo.general === "write" && listed.repo.fullName === "alice/site" && file.repo.id === site.id, JSON.stringify({ wrong, scratch, forged, a, listed }));
    return { mismatched: wrong.body.error.slice(0, 90), forgedId: forged.body.error, assigned: listed.repo };
  });
  await step("worker definitions: access only to registered repositories at known levels", async () => {
    const caps = ["files.read", "files.write", "shell"];
    const none = (await call("POST", "/workers", { name: "No Access", capabilities: caps })).body;
    reader = (await call("POST", "/workers", { name: "Repo Reader", capabilities: caps, repos: [{ repo: site.id, level: "read" }] })).body;
    committer = (await call("POST", "/workers", { name: "Repo Committer", capabilities: caps, repos: [{ repo: site.id, level: "commit" }] })).body;
    const forged = await call("POST", "/workers", { name: "Forged", capabilities: caps, repos: [{ repo: "gh-12345", level: "push" }] }), badLevel = await call("POST", "/workers", { name: "Bad", capabilities: caps, repos: [{ repo: site.id, level: "admin" }] });
    must(none.repos.length === 0 && reader.repos[0].level === "read" && forged.status === 400 && badLevel.status === 400, JSON.stringify({ none, forged, badLevel }));
    globalThis.noneId = none.id;
    return { reader: reader.repos, committer: committer.repos, forgedRepo: forged.body.error, badLevel: badLevel.body.error };
  });
  await step("7. a worker without access to the workspace's repository can't start there (nothing runs)", async () => {
    const before = (await call("GET", "/runs")).body.runs.length;
    const r = await call("POST", "/runs", { prompt: "List the files.", workspace: siteId, worker: globalThis.noneId, model: "haiku" });
    must(r.status === 400 && /no access to alice\/site/.test(r.body.error) && (await call("GET", "/runs")).body.runs.length === before, JSON.stringify(r));
    return { refused: r.body.error.slice(0, 120) };
  });
  await step("8. read access, as the runtime gives it: no Write, Edit or shell; repo tools read-only; .git not writable", async () => {
    const r = (await call("POST", "/runs", { prompt: "Reply with the single word OK.", workspace: siteId, worker: reader.id, model: "haiku" })).body;
    await settle(r.id);
    const tools = inits(r.id)[0].tools, mcp = JSON.parse(readFileSync(join(DATA, "runs", `${r.id}.mcp.json`), "utf8")).mcpServers.repo, ctx = readFileSync(join(DATA, "runs", `${r.id}.worker.md`), "utf8"), snap = JSON.parse(readFileSync(join(DATA, "runs", `${r.id}.worker.json`), "utf8"));
    await call("POST", `/runs/${r.id}/end`); await idle();
    const settings = JSON.parse(snap.runtime.args[snap.runtime.args.indexOf("--settings") + 1]);
    must(!tools.some((t) => ["Write", "Edit", "Bash"].includes(t)) && tools.includes("mcp__repo__repo_status") && !tools.some((t) => /repo_(commit|push|create_branch)/.test(t)) && mcp.env.REPO_LEVEL === "read" && !JSON.stringify(mcp).includes(TOKENS.alice)
      && /Your access: Read/.test(ctx) && settings.permissions.deny.includes("Edit(.git/**)") && snap.runtime.args.includes("--restricted"), JSON.stringify({ tools, mcp: mcp.env, settings }));
    return { runtimeTools: tools.filter((t) => !t.startsWith("mcp__") || t.startsWith("mcp__repo")), repoLevel: mcp.env.REPO_LEVEL, denied: settings.permissions.deny };
  });
  await step("9-10. commit access, end to end: the worker branches, edits and commits for real through the repo tools; the commit is linked to its run", async () => {
    const r = (await call("POST", "/runs", { prompt: "Use repo_create_branch to create the branch work/hello. Then create the file hello.txt containing the single line hi. Then use repo_commit with the message \"Add hello\". Finally reply with the commit hash the tool returned.", workspace: siteId, worker: committer.id, model: "haiku" })).body;
    runA = r.id;
    const m = await settle(r.id);
    const branch = g(A.work, "rev-parse", "--abbrev-ref", "HEAD"), log = g(A.work, "log", "-1", "--format=%H%x1f%s%x1f%an%x1f%B"), [hash, subject, author, body] = log.split("\x1f");
    const tools = inits(r.id)[0].tools;
    must(branch === "work/hello" && subject === "Add hello" && author === "Test Person" && !/co-authored-by/i.test(body) && g(A.work, "show", "--format=", "--name-only", hash) === "hello.txt" && (m.commits || []).includes(hash)
      && tools.includes("mcp__repo__repo_commit") && !tools.includes("mcp__repo__repo_push") && g(A.bare, "branch", "--list", "work/hello") === "", JSON.stringify({ branch, log, commits: m.commits, tools }));
    return { branch, commit: hash.slice(0, 7), author, linkedToRun: true, pushTool: "not given (commit access)", remoteUntouched: true };
  });
  await step("changing a worker's access applies at its next start, and a run never gets more than it started with", async () => {
    await call("PUT", `/workers/${committer.id}`, { ...committer, repos: [{ repo: site.id, level: "read" }] });
    await call("POST", `/runs/${runA}/end`); await idle();
    const sent = await call("POST", `/runs/${runA}/message`, { text: "Reply with the single word OK." }); must(sent.status === 200, JSON.stringify(sent));
    await settle(runA);
    const all = inits(runA), last = all[all.length - 1].tools;
    await call("POST", `/runs/${runA}/end`); await idle();
    must(all.length >= 2 && !last.includes("mcp__repo__repo_commit") && !last.includes("Write"), JSON.stringify({ inits: all.length, last }));
    return { processes: all.length, nowHas: last.filter((t) => t.startsWith("mcp__repo")) };
  });
  await step("12. a checkout whose origin no longer matches is refused: no run starts, the person's push is refused too", async () => {
    g(A.work, "remote", "set-url", "origin", B.bare);
    const run = await call("POST", "/runs", { prompt: "x", workspace: siteId, worker: reader.id, model: "haiku" }), push = await call("POST", "/git/push", { workspace: siteId });
    g(A.work, "remote", "set-url", "origin", A.bare);
    must(run.status === 400 && /origin/.test(run.body.error) && push.status === 400 && /not alice\/site/.test(push.body.error), JSON.stringify({ run, push }));
    return { run: run.body.error.slice(0, 100), push: push.body.error.slice(0, 100) };
  });
  await step("15. existing Git features still work in an assigned workspace: versions list, diff, the person's commit", async () => {
    writeFileSync(join(A.work, "person.txt"), "by the person\n");
    const s = (await call("GET", `/git?workspace=${siteId}`)).body, d = (await call("GET", `/git/diff?workspace=${siteId}&rev=WORKTREE&path=person.txt`)).body;
    const c = (await call("POST", "/git/commit", { workspace: siteId, message: "Person's own commit" })).body;
    must(s.repo && s.changes.some((x) => x.path === "person.txt") && /by the person/.test(d.diff) && c.short && g(A.work, "log", "-1", "--format=%s") === "Person's own commit", JSON.stringify({ s: s.changes, c }));
    return { changes: s.changeCount, commit: c.short };
  });
  await step("13. removing a registration: refused while assigned; afterwards only the entry goes (folder, changes, commits stay) and grants are dropped", async () => {
    writeFileSync(join(A.work, "uncommitted.txt"), "keep me\n");
    const head = g(A.work, "rev-parse", "HEAD");
    const busy = await call("DELETE", `/github/repos/${site.id}`);
    await call("DELETE", `/workspaces/${siteId}/repo`);
    const gone = (await call("DELETE", `/github/repos/${site.id}`)).body, workers = (await call("GET", "/workers")).body.workers;
    must(busy.status === 409 && /Unassign/.test(busy.body.error) && gone.removed === "alice/site" && existsSync(join(A.work, "uncommitted.txt")) && g(A.work, "rev-parse", "HEAD") === head && workers.every((w) => !(w.repos || []).some((x) => x.repo === site.id)), JSON.stringify({ busy, gone }));
    return { whileAssigned: busy.body.error, removed: gone.removed, folderIntact: true, grantsRemoved: gone.grantsRemoved };
  });
  await step("16b. the page: registered list, detail, and disconnect with confirmation (token deleted, registry kept)", async () => {
    await page.click("#vClose"); await page.click("#ghOpen");
    await page.waitForSelector("[data-gh-open]");
    await page.click('[data-gh-open="gh-1001"]');
    const det = await page.locator(".ghdet").innerText();
    await page.screenshot({ path: join(HERE, "shots", "github-page.png") });
    await page.click("#ghDisc"); const sure = await page.locator("#ghDisc").innerText();
    await page.click("#ghDisc"); await page.waitForFunction(() => /Not connected/.test(document.querySelector("#ghBody")?.innerText || ""));
    must(/Default branch/.test(det) && /main/.test(det) && sure === "Disconnect: sure?" && !existsSync(credFile) && (await call("GET", "/github")).body.repos.length === 1, JSON.stringify({ det, sure }));
    return { detail: det.split("\n").slice(0, 4), confirm: sure, tokenDeleted: true, registryKept: 1 };
  });
} finally {
  await b.close(); mock.close();
}
writeFileSync(join(HERE, "github-results.json"), JSON.stringify({ when: new Date().toISOString(), results, pageErrors: errors }, null, 1));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed; page errors: ${errors.length ? errors.join(" | ").slice(0, 200) : "none"}`);
