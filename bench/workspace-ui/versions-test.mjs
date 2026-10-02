// Versions (the workspace's Git history) and push, end to end with the real worker, in disposable
// repos whose "remote" is a local bare repository (nothing reaches GitHub). Also checks that no
// commit made by the Workspace carries a Co-authored-by trailer, and that the worker's Claude Code
// settings stop it adding one if it commits by itself.
//   SCRATCH=<empty scratch dir> node bench/workspace-ui/versions-test.mjs <port>
import { chromium } from "../../browser-adapter/node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url));
const [port = "8797"] = process.argv.slice(2);
const BASE = `http://127.0.0.1:${port}`, X = process.env.SCRATCH;
const H = { origin: BASE, "x-worker-console": "1", "content-type": "application/json" };
const call = (method, path, data, headers = H) => fetch(BASE + path, { method, headers, body: data ? JSON.stringify(data) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const g = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const CLAUDE = "C:/nvm4w/nodejs/node_modules/@anthropic-ai/claude-code/bin/claude.exe";

// Disposable repos: a Work repo pushing to a bare "remote", an Inspect repo, and a plain folder.
rmSync(X, { recursive: true, force: true }); mkdirSync(X, { recursive: true });
const REMOTE = join(X, "remote.git"), WORK = join(X, "app"), INSP = join(X, "inspect-repo"), PLAIN = join(X, "plain");
g(X, "init", "-q", "--bare", "-b", "main", REMOTE);
for (const d of [WORK, INSP]) { mkdirSync(join(d, "src"), { recursive: true }); g(d, "init", "-q", "-b", "main"); }
writeFileSync(join(WORK, "README.md"), "# Demo app\n"); writeFileSync(join(WORK, "src", "math.js"), "export const add = (a, b) => a + b;\n");
g(WORK, "add", "-A"); g(WORK, "commit", "-q", "-m", "Initial version"); g(WORK, "remote", "add", "origin", REMOTE); g(WORK, "push", "-q", "-u", "origin", "main");
writeFileSync(join(INSP, "a.txt"), "one\n"); g(INSP, "add", "-A"); g(INSP, "commit", "-q", "-m", "Inspect repo start"); writeFileSync(join(INSP, "a.txt"), "one\ntwo\n");
mkdirSync(PLAIN); writeFileSync(join(PLAIN, "x.txt"), "x\n");
const me = { name: g(WORK, "config", "user.name"), email: g(WORK, "config", "user.email") };

const results = [];
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1280, height: 1008 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail).slice(0, 260)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 300)); await page.screenshot({ path: join(HERE, "shots", `versions-fail-${results.length}.png`) }); }
};
const waitStatus = (l, timeout = 300000) => page.waitForFunction((x) => document.querySelector("#rState").textContent === x, l, { timeout });
const verRows = () => page.locator("#verList .row").allInnerTexts().then((a) => a.map((t) => t.replace(/\s+/g, " ").trim()));
const result = () => page.locator(".vres").innerText();
const openWT = async () => { await page.click('#verList [data-rev="WORKTREE"]'); await page.waitForSelector(".vbody2"); };

const ws = {};
for (const [k, name, path, mode] of [["work", "App", WORK, "work"], ["insp", "Inspect repo", INSP, "inspect"], ["plain", "Plain folder", PLAIN, "work"]]) ws[k] = (await call("POST", "/workspaces", { name, path, mode })).body.id;
await page.goto(BASE, { waitUntil: "networkidle" });

await step("versions list: working copy (clean) and the repo's commits", async () => {
  await page.click(`#wsList [data-ws="${ws.work}"]`);
  await page.waitForFunction(() => document.querySelectorAll("#verList .row").length >= 2);
  return { rows: await verRows() };
});
let runId;
await step("the worker changes a file; the working copy shows it, linked to the run", async () => {
  await page.fill("#input", "In src/math.js add one line: export const mul = (a, b) => a * b; Keep the rest unchanged. Report it as an ARTIFACT.");
  await page.click("#send");
  await waitStatus("Waiting for you");
  runId = await page.evaluate(() => runId);
  await page.waitForFunction(() => /1 changed/.test(document.querySelector('#verList [data-rev="WORKTREE"]')?.textContent || ""), null, { timeout: 10000 });
  await openWT();
  await page.screenshot({ path: join(HERE, "shots", "versions-working-copy.png") });
  return { rows: await verRows(), files: await page.locator(".vfile").allInnerTexts().then((a) => a.map((t) => t.replace(/\s+/g, " "))), changesFrom: await page.locator(".vruns").innerText() };
});
await step("diff and file views of the change", async () => {
  await page.click('.vfile[data-path="src/math.js"]');
  await page.waitForSelector(".diff");
  const added = await page.locator(".diff .add").allInnerTexts();
  await page.click('.vtabs [data-m="file"]'); await page.waitForSelector(".code .tx");
  const file = await page.locator(".code .tx").innerText();
  await page.click("#vBack"); await page.waitForSelector(".vbody2");
  return { addedLines: added, fileHasMul: /mul/.test(file) };
});
let committed;
await step("commit from the Workspace: the typed message, your identity, no trailer; activity shows it", async () => {
  await page.fill("#cMsg", "Add mul() to math");
  await page.click("#cBtn");
  await page.waitForSelector(".vres");
  const res = await result();
  const head = g(WORK, "log", "-1", "--format=%H%n%an%n%ae%n%B");
  const [hash, an, ae, ...msg] = head.split("\n");
  committed = hash;
  const card = await page.locator('#acts .card:has-text("Version")').innerText().catch(() => null);
  return { result: res, message: msg.join("\n").trim(), coAuthoredBy: /co-authored-by/i.test(head), author: an === me.name && ae === me.email, activityCard: card && card.replace(/\s+/g, " "), rows: await verRows() };
});
await step("the new version is linked to the run and marked not pushed", async () => {
  await page.click(`#verList [data-rev="${committed.slice(0, 7)}"]`);
  await page.waitForSelector(".vmeta");
  return { meta: (await page.locator(".vmeta").first().innerText()).replace(/\s+/g, " "), files: await page.locator(".vfile").allInnerTexts().then((a) => a.map((t) => t.replace(/\s+/g, " "))) };
});
await step("an older version opens read-only, with the file as it was then", async () => {
  await page.click('#verList .row:has-text("Initial version")');
  await page.waitForSelector(".vfile");
  await page.click('.vfile[data-path="src/math.js"]');
  await page.click('.vtabs [data-m="file"]'); await page.waitForSelector(".code .tx");
  const old = await page.locator(".code .tx").innerText();
  await page.screenshot({ path: join(HERE, "shots", "versions-old-file.png") });
  return { oldFile: old, hasMul: /mul/.test(old), workingTreeUnchanged: /mul/.test(readFileSync(join(WORK, "src", "math.js"), "utf8")), head: g(WORK, "rev-parse", "HEAD") === committed };
});
await step("push to the remote; the result shows in the version view and the activity panel", async () => {
  await openWT();
  const bar = await page.locator(".vact").last().innerText();
  await page.click("#pBtn");
  await page.waitForFunction(() => /Pushed|failed|Push/i.test(document.querySelector(".vres")?.textContent || ""));
  const card = await page.locator('#acts .card:has-text("Push")').innerText().catch(() => null);
  return { before: bar.replace(/\s+/g, " "), result: await result(), remoteHead: g(REMOTE, "rev-parse", "main") === committed, remoteMessage: g(REMOTE, "log", "-1", "--format=%B"), activityCard: card && card.replace(/\s+/g, " "), rows: await verRows() };
});
await step("nothing left to push", async () => ({ api: (await call("POST", "/git/push", { workspace: ws.work })).body, view: await page.locator(".vact").last().innerText() }));
await step("push refused when the remote has newer commits (no force push)", async () => {
  const other = join(X, "other"); g(X, "clone", "-q", REMOTE, other);
  writeFileSync(join(other, "OTHER.md"), "x\n"); g(other, "add", "-A"); g(other, "commit", "-q", "-m", "Someone else"); g(other, "push", "-q");
  writeFileSync(join(WORK, "LOCAL.md"), "y\n");
  await call("POST", "/git/commit", { workspace: ws.work, message: "Local change" });
  const r = await call("POST", "/git/push", { workspace: ws.work });
  return { push: r, remoteStillHasOthers: g(REMOTE, "log", "-1", "--format=%s") };
});
await step("missing authentication is reported, never prompted for", async () => {
  const srv = http.createServer((req, res) => { res.writeHead(401, { "www-authenticate": 'Basic realm="test"' }); res.end(); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  g(WORK, "remote", "set-url", "--push", "origin", `http://127.0.0.1:${srv.address().port}/repo.git`);
  const t0 = Date.now(); const r = await call("POST", "/git/push", { workspace: ws.work }); const secs = (Date.now() - t0) / 1000;
  srv.close(); g(WORK, "remote", "set-url", "--push", "origin", REMOTE);
  return { push: r, seconds: secs };
});
await step("Inspect workspace: versions are shown, but no commit or push", async () => {
  await page.click(`#wsList [data-ws="${ws.insp}"]`);
  await page.waitForFunction(() => /1 changed/.test(document.querySelector('#verList [data-rev="WORKTREE"]')?.textContent || ""));
  await openWT();
  const api = await call("POST", "/git/commit", { workspace: ws.insp, message: "should not happen" });
  return { view: await page.locator(".vact").innerText(), commitButtons: await page.locator("#cBtn, #pBtn").count(), api, stillUncommitted: g(INSP, "status", "--porcelain") };
});
await step("a folder that isn't a Git repo says so", async () => {
  await page.click(`#wsList [data-ws="${ws.plain}"]`);
  await page.waitForFunction(() => /Not a Git repository/.test(document.querySelector("#verList").textContent));
  return { versions: await page.locator("#verList").innerText(), api: (await call("POST", "/git/commit", { workspace: ws.plain, message: "x" })).body };
});
await step("guarded and validated: foreign origin, bad versions and paths", async () => {
  const foreign = { ...H, origin: "http://evil.example" };
  return {
    foreignCommit: (await call("POST", "/git/commit", { workspace: ws.work, message: "x" }, foreign)).status,
    foreignPush: (await call("POST", "/git/push", { workspace: ws.work }, foreign)).status,
    badRev: (await call("GET", `/git/version?workspace=${ws.work}&rev=HEAD~1`)).body,
    revFlag: (await call("GET", `/git/version?workspace=${ws.work}&rev=--output=x`)).body,
    traversal: (await call("GET", `/git/diff?workspace=${ws.work}&rev=WORKTREE&path=../remote.git/config`)).body,
    fileTraversal: (await fetch(`${BASE}/git/file?workspace=${ws.work}&rev=${committed.slice(0, 7)}&path=..%2F..%2Fx`)).status,
  };
});
await step("Claude Code's own co-author trailer: present by default, absent with the Workspace's worker settings", async () => {
  const run = (dir, extra) => {
    mkdirSync(dir, { recursive: true }); g(dir, "init", "-q", "-b", "main"); writeFileSync(join(dir, "f.txt"), "x\n");
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/.test(k)));
    execFileSync(CLAUDE, ["-p", "--allowedTools", "Bash(git:*)", ...extra], { cwd: dir, env: { ...env, CLAUDE_CONFIG_DIR: join(process.env.USERPROFILE, ".claude") }, input: "Commit all files in this repository with git, message: Add f.txt", encoding: "utf8", timeout: 240000 });
    return existsSync(join(dir, ".git")) ? g(dir, "log", "-1", "--format=%B") : "";
  };
  const plain = run(join(X, "cc-default"), []);
  const ours = run(join(X, "cc-ours"), ["--settings", JSON.stringify({ includeCoAuthoredBy: false, attribution: { commit: "", pr: "" } })]);
  return { defaultMessage: plain, defaultHasTrailer: /co-authored-by/i.test(plain), workspaceSettingsMessage: ours, workspaceSettingsHasTrailer: /co-authored-by/i.test(ours) };
});
writeFileSync(join(HERE, "versions-results.json"), JSON.stringify({ when: new Date().toISOString(), results, pageErrors: errors }, null, 1));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed; page errors: ${errors.length ? errors.join(" | ") : "none"}`);
await b.close();
