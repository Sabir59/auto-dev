// The worker-side repository tools (mcp/repo-server.mjs), run for real over stdio exactly as a
// worker's runtime starts them, against a real local checkout whose origin is a local bare
// repository (standing in for GitHub). No model, no console, no network.
//   node bench/github/repo-tools-test.mjs
import { Client } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", "..");
const must = (c, m) => { if (!c) throw new Error(m); };
const g = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
export function makeRepo(root, name) {
  const bare = join(root, `${name}-remote.git`), work = join(root, name);
  g(root, "init", "-q", "--bare", "-b", "main", bare);
  g(root, "clone", "-q", bare, work);
  g(work, "config", "user.name", "Test Person"); g(work, "config", "user.email", "test@example.invalid");
  writeFileSync(join(work, "README.md"), "# fixture\n"); g(work, "add", "-A"); g(work, "commit", "-q", "-m", "Initial"); g(work, "push", "-q", "origin", "main");
  return { bare, work, url: pathToFileURL(bare).href };
}

const results = [];
const step = async (name, fn) => { try { const d = await fn(); results.push({ step: name, ok: true, detail: d }); console.log("PASS", name, JSON.stringify(d).slice(0, 220)); } catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 300)); } };
async function client(env) {
  const c = new Client({ name: "repo-tools-test", version: "1" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(REPO, "mcp", "repo-server.mjs")], env: { ...process.env, ...env } }));
  const call = async (name, args = {}) => { const r = await c.callTool({ name, arguments: args }); const text = r.content?.[0]?.text || ""; let json = null; try { json = JSON.parse(text); } catch {} return { isError: !!r.isError, text, json }; };
  return { c, call, tools: (await c.listTools()).tools.map((t) => t.name) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = mkdtempSync(join(tmpdir(), "repo-tools-")), A = makeRepo(root, "site"), B = makeRepo(root, "other");
  const base = { REPO_ROOT: A.work, REPO_URL: A.url, REPO_NAME: "alice/site", REPO_DEFAULT_BRANCH: "main" };
  await step("read access: only status, log and diff exist; status reports the checkout", async () => {
    const { c, call, tools } = await client({ ...base, REPO_LEVEL: "read" });
    writeFileSync(join(A.work, "notes.txt"), "uncommitted\n");
    const s = (await call("repo_status")).json, commit = await call("repo_commit", { message: "x" });
    await c.close();
    must(tools.sort().join() === "repo_diff,repo_log,repo_status" && s.branch.startsWith("main") && s.changeCount === 1 && commit.isError, JSON.stringify({ tools, s, commit: commit.text.slice(0, 100) }));
    return { tools, branch: s.branch, changes: s.changes, commitTool: "not registered" };
  });
  await step("commit access: the default branch is refused; a work branch is created and committed for real", async () => {
    const { c, call, tools } = await client({ ...base, REPO_LEVEL: "commit" });
    const onMain = await call("repo_commit", { message: "Should not land on main" });
    const br = (await call("repo_create_branch", { name: "work/notes" })).json;
    const done = (await call("repo_commit", { message: "Add notes" })).json, push = await call("repo_push");
    await c.close();
    const real = g(A.work, "log", "-1", "--format=%H%x1f%s");
    must(onMain.isError && /protected/.test(onMain.text) && br.branch === "work/notes" && done.committed && real === `${done.hash}\x1fAdd notes` && push.isError && !tools.includes("repo_push"), JSON.stringify({ onMain: onMain.text, br, done, push: push.text }));
    return { refusedOnMain: onMain.text.slice(0, 90), branch: br.branch, commit: done.short, gitLogAgrees: true, pushTool: "not registered" };
  });
  await step("push access: pushes the work branch (read back from the remote); the default branch is refused; never forced", async () => {
    const { c, call } = await client({ ...base, REPO_LEVEL: "push" });
    const p = (await call("repo_push")).json;
    const remote = g(A.bare, "rev-parse", "refs/heads/work/notes"), local = g(A.work, "rev-parse", "HEAD");
    g(A.work, "switch", "-q", "main");
    const onMain = await call("repo_push");
    // The remote moves ahead: the push is refused, not forced.
    g(A.work, "switch", "-q", "work/notes");
    const other = join(root, "site-2"); g(root, "clone", "-q", "-b", "work/notes", A.bare, other); g(other, "config", "user.name", "T"); g(other, "config", "user.email", "t@example.invalid");
    writeFileSync(join(other, "x.txt"), "x"); g(other, "add", "-A"); g(other, "commit", "-q", "-m", "elsewhere"); g(other, "push", "-q", "origin", "work/notes");
    writeFileSync(join(A.work, "y.txt"), "y"); await call("repo_commit", { message: "Local change" });
    const behind = await call("repo_push"), remoteAfter = g(A.bare, "rev-parse", "refs/heads/work/notes");
    await c.close();
    must(p.pushed && remote === local && onMain.isError && /protected/.test(onMain.text) && behind.isError && /never forced|doesn't have/.test(behind.text) && remoteAfter === g(other, "rev-parse", "HEAD"), JSON.stringify({ p, onMain: onMain.text, behind: behind.text }));
    return { pushed: p.verified, refusedOnMain: true, rejectedNotForced: behind.text.slice(0, 90) };
  });
  await step("workers on the default branch only when the workspace allows it", async () => {
    g(A.work, "switch", "-q", "main"); writeFileSync(join(A.work, "z.txt"), "z");
    const { c, call } = await client({ ...base, REPO_LEVEL: "commit", REPO_WORKERS_ON_DEFAULT: "1" });
    const r = (await call("repo_commit", { message: "Allowed on main here" })).json; await c.close();
    must(r?.committed && r.branch === "main", JSON.stringify(r));
    return { committedOn: r.branch };
  });
  await step("a Team-protected branch is refused even with push access and workers allowed on the default branch", async () => {
    const { c, call } = await client({ ...base, REPO_LEVEL: "push", REPO_WORKERS_ON_DEFAULT: "1", REPO_PROTECT: "main" });
    writeFileSync(join(A.work, "w.txt"), "w"); const r = await call("repo_commit", { message: "nope" }), p = await call("repo_push"); await c.close();
    must(r.isError && p.isError, JSON.stringify({ r: r.text, p: p.text }));
    return { commit: r.text.slice(0, 80), push: p.text.slice(0, 80) };
  });
  await step("a checkout whose origin isn't the registered repository is refused for every tool", async () => {
    const { c, call } = await client({ ...base, REPO_URL: B.url, REPO_LEVEL: "push" });
    const s = await call("repo_status"), l = await call("repo_log"); await c.close();
    must(s.isError && l.isError && /not alice\/site/.test(s.text), s.text);
    return { refused: s.text.slice(0, 140) };
  });
  await step("forged arguments: paths outside the repository, option-like paths and bad branch names are refused", async () => {
    const { c, call } = await client({ ...base, REPO_LEVEL: "commit" });
    const bad = await Promise.all([call("repo_diff", { path: "../site-remote.git/config" }), call("repo_diff", { path: "C:\\Windows\\win.ini" }), call("repo_log", { path: "--output=x" }),
      call("repo_create_branch", { name: "../x" }), call("repo_create_branch", { name: "-f" }), call("repo_commit", { message: "m", paths: ["../../outside.txt"] })]);
    await c.close();
    must(bad.every((r) => r.isError) && !existsSync(join(A.work, "x")), JSON.stringify(bad.map((r) => r.text.slice(0, 60))));
    return { refused: bad.length };
  });
  writeFileSync(join(HERE, "repo-tools-results.json"), JSON.stringify({ when: new Date().toISOString(), results }, null, 1));
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
}
