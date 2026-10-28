#!/usr/bin/env node
// Git tools for a worker in a workspace assigned to a registered repository. The console starts
// one per run with the worker's effective access, and only the tools that access allows are
// registered (a read-only worker has no commit or push tool to call):
//   read    repo_status, repo_log, repo_diff
//   commit  + repo_create_branch, repo_commit
//   push    + repo_push
// ("write", editing files, is the runtime's own Write/Edit tools; this server adds nothing for it.)
//
// Every call works only on the run's own checkout (REPO_ROOT, fixed by the console: no tool takes
// a repository or a folder), and first checks that the checkout's origin is still the registered
// repository (REPO_URL); a mismatch refuses everything. Arguments go to git as separate arguments,
// never through a shell. Nothing here forces, resets, rebases, deletes branches or discards changes.
// Commits use the person's own Git identity; pushes use the person's own Git sign-in, never a prompt.
// Branches the console protects (a Team policy, and the default branch unless the workspace allows
// workers on it) are never committed to or pushed to.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { guardTools } from "./authz.mjs";
import { z } from "zod";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { canonRemote } from "../worker-ui/github.mjs";

const ROOT = process.env.REPO_ROOT, URL_ = process.env.REPO_URL, NAME = process.env.REPO_NAME || "the repository";
const LEVELS = ["read", "write", "commit", "push"], LEVEL = LEVELS.indexOf(process.env.REPO_LEVEL || "read");
const DEFAULT_BRANCH = process.env.REPO_DEFAULT_BRANCH || "";
const PROTECTED = new Set([...(process.env.REPO_PROTECT || "").split(",").filter(Boolean), ...(process.env.REPO_WORKERS_ON_DEFAULT === "1" || !DEFAULT_BRANCH ? [] : [DEFAULT_BRANCH])]);
if (!ROOT || !URL_ || LEVEL < 0) { console.error("repo-server: REPO_ROOT, REPO_URL and REPO_LEVEL are required"); process.exit(1); }

const GIT_OPTS = ["-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "-c", "color.ui=false"];
function git(args, { timeout = 30000, input } = {}) {
  return new Promise((ok, fail) => {
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_|REPO_)/.test(k))), GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
    const p = spawn("git", [...GIT_OPTS, ...args], { cwd: ROOT, env, windowsHide: true });
    const out = [], err = []; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill(); }, timeout);
    p.stdout.on("data", (d) => out.push(d)); p.stderr.on("data", (d) => err.push(d));
    p.on("error", (e) => { clearTimeout(timer); fail(new Error(`Couldn't run git: ${e.message}`)); });
    p.on("close", (code) => { clearTimeout(timer); const so = Buffer.concat(out).toString("utf8"), se = Buffer.concat(err).toString("utf8").trim(); code === 0 ? ok(so) : fail(new Error(timedOut ? "git timed out" : se || `git exited with code ${code}`)); });
    p.stdin.end(input);
  });
}
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n) + "…" : String(s));
const ok = (v) => ({ content: [{ type: "text", text: JSON.stringify(v, null, 1) }] });
const refuse = (m) => ({ isError: true, content: [{ type: "text", text: m }] });
// Before anything: this folder is the checkout, and its origin is the registered repository.
async function guard() {
  const top = realpathSync.native((await git(["rev-parse", "--show-toplevel"])).trim());
  const root = realpathSync.native(ROOT);
  if (top.toLowerCase() !== root.toLowerCase() && !root.toLowerCase().startsWith(top.toLowerCase() + "\\") && !root.toLowerCase().startsWith(top.toLowerCase() + "/")) throw new Error("This folder isn't the workspace's checkout.");
  const origin = (await git(["remote", "get-url", "origin"]).catch(() => "")).trim();
  if (canonRemote(origin) !== canonRemote(URL_)) throw new Error(`Refused: this checkout's origin (${clip(origin.replace(/^(\w+:\/\/)[^@/]+@/, "$1"), 120) || "none"}) is not ${NAME}. The person must fix the folder's remote or the workspace's assignment.`);
}
const tool = (fn) => async (args) => { try { await guard(); return ok(await fn(args || {})); } catch (e) { return refuse(clip(e.message, 600)); } };
const branchNow = async () => (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
const relPath = z.string().max(400).regex(/^(?![\/\\])(?![A-Za-z]:)(?!-)(?!.*(^|[\/\\])\.\.([\/\\]|$))[^\0]+$/, "a path inside the repository").optional();
const NO_PROGRAMS = ["--no-ext-diff", "--no-textconv"];

const server = new McpServer({ name: "repo", version: "0.1.0" });
// Each tool call is checked with the console first when it runs this server for a worker (authz.mjs).
guardTools(server, () => "repo");

server.registerTool("repo_status", { description: `The checkout of ${NAME}: current branch, commits ahead/behind its remote branch (as last fetched), and changed files. Your access here: ${LEVELS[LEVEL]}${PROTECTED.size ? `; never committed to or pushed to: ${[...PROTECTED].join(", ")}` : ""}.` },
  tool(async () => {
    const out = await git(["status", "--porcelain=v1", "--branch", "--untracked-files=all"]);
    const [head, ...files] = out.split(/\r?\n/).filter(Boolean);
    return { repository: NAME, access: LEVELS[LEVEL], defaultBranch: DEFAULT_BRANCH || null, protectedBranches: [...PROTECTED], branch: head.replace(/^## /, ""), changes: files.slice(0, 200), changeCount: files.length };
  }));
server.registerTool("repo_log", { description: "Recent commits (newest first), optionally only those touching one path.", inputSchema: { max: z.number().int().min(1).max(100).optional(), path: relPath } },
  tool(async ({ max = 20, path }) => (await git(["log", "-n", String(max), "--format=%h%x1f%an%x1f%aI%x1f%s", "--", ...(path ? [path] : [])])).split(/\r?\n/).filter(Boolean).map((l) => { const [hash, author, date, subject] = l.split("\x1f"); return { hash, author, date, subject }; })));
server.registerTool("repo_diff", { description: "A unified diff: uncommitted changes (default), staged ones, or one commit (rev). Long output is cut.", inputSchema: { rev: z.string().regex(/^[0-9a-f]{7,40}$/).optional(), staged: z.boolean().optional(), path: relPath } },
  tool(async ({ rev, staged, path }) => {
    const args = rev ? ["show", "--format=%h %s", ...NO_PROGRAMS, rev] : ["diff", ...(staged ? ["--cached"] : []), ...NO_PROGRAMS];
    const d = await git([...args, "--", ...(path ? [path] : [])]);
    return { diff: clip(d, 60000), truncated: d.length > 60000 };
  }));

const BRANCH = z.string().min(1).max(100).regex(/^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)(?!.*\/$)[\w.\-/]+$/, "a branch name");
if (LEVEL >= LEVELS.indexOf("commit")) {
  server.registerTool("repo_create_branch", { description: "Create a new branch from the current commit and switch to it. Uncommitted changes come along; nothing is discarded. Use one per task (e.g. work/short-topic) instead of committing to a protected branch.", inputSchema: { name: BRANCH } },
    tool(async ({ name }) => {
      await git(["check-ref-format", "--branch", name]);
      if (PROTECTED.has(name)) throw new Error(`${name} is protected here; pick another name.`);
      if (await git(["rev-parse", "--verify", "-q", `refs/heads/${name}`]).then(() => true, () => false)) throw new Error(`A branch named ${name} already exists.`);
      await git(["switch", "-c", name]);
      return { branch: await branchNow(), from: (await git(["rev-parse", "--short", "HEAD"])).trim() };
    }));
  server.registerTool("repo_commit", { description: "Commit the current changes (all of them, or only the given paths) on the current branch, with your message as given. Refused on a protected branch. The result is the real commit: report its hash.", inputSchema: { message: z.string().min(1).max(5000), paths: z.array(relPath.unwrap()).max(200).optional() } },
    tool(async ({ message, paths }) => {
      const branch = await branchNow();
      if (branch === "HEAD") throw new Error("Not on a branch (detached HEAD). Create a branch first.");
      if (PROTECTED.has(branch)) throw new Error(`Refused: ${branch} is protected here (nothing is committed to it by workers). Create a branch with repo_create_branch, then commit.`);
      await git(["add", "-A", "--", ...(paths?.length ? paths : ["."])]);
      if (!(await git(["diff", "--cached", "--name-only"])).trim()) throw new Error("There are no changes to commit.");
      try { await git(["commit", "-q", "-F", "-"], { input: message.replace(/\r\n/g, "\n").trim() + "\n", timeout: 120000 }); }
      catch (e) { throw new Error(/Author identity unknown|Please tell me who you are/i.test(e.message) ? "Git doesn't know who the person is (user.name / user.email aren't set). Ask them to set it." : `Commit failed: ${clip(e.message, 300)}`); }
      const [hash, short, subject] = (await git(["log", "-1", "--format=%H%x1f%h%x1f%s"])).trim().split("\x1f");
      return { committed: true, hash, short, subject, branch, files: (await git(["show", "--format=", "--name-only", hash])).split(/\r?\n/).filter(Boolean).length };
    }));
}
if (LEVEL >= LEVELS.indexOf("push")) {
  server.registerTool("repo_push", { description: "Push the current branch to origin under the same name. Never forced; refused for protected branches. Afterwards the remote branch is read back: the result says whether it now matches.", inputSchema: {} },
    tool(async () => {
      const branch = await branchNow();
      if (branch === "HEAD") throw new Error("Not on a branch (detached HEAD).");
      if (PROTECTED.has(branch)) throw new Error(`Refused: ${branch} is protected here; workers never push to it. Push a work branch instead.`);
      const head = (await git(["rev-parse", "HEAD"])).trim();
      try { await git(["push", "--porcelain", "origin", `HEAD:refs/heads/${branch}`], { timeout: 120000 }); }
      catch (e) {
        const m = e.message;
        throw new Error(/Authentication failed|could not read Username|terminal prompts disabled|Permission denied|returned error: 40[13]/i.test(m) ? "Git has no working sign-in for this remote on this computer. The person must sign in to GitHub with Git once."
          : /rejected|non-fast-forward|fetch first/i.test(m) ? `origin/${branch} has commits this checkout doesn't have. Nothing was pushed (never forced).` : `Push failed: ${clip(m, 300)}`);
      }
      const remote = (await git(["ls-remote", "origin", `refs/heads/${branch}`], { timeout: 60000 })).split(/\s/)[0] || "";
      return { pushed: remote === head, branch, commit: head.slice(0, 12), remoteNow: remote.slice(0, 12) || null, verified: remote === head ? "origin's branch now points at this commit (read back)" : "the remote branch doesn't match this commit: report it as NOT verified" };
    }));
}

await server.connect(new StdioServerTransport());
