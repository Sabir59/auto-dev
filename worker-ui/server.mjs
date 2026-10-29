#!/usr/bin/env node
// Local Worker Console server. It does NOT reason, plan or run tools. It:
//  - starts the existing worker: headless Claude Code in this repo, with this
//    repo's .mcp.json, in stream-json INPUT mode so one process takes several
//    chat messages (follow-ups keep the same context AND the same MCP/browser);
//  - forwards chat messages to the worker's stdin;
//  - translates the worker's own stream-json output into a small event contract;
//  - keeps run history (runs/<id>.jsonl + .meta.json) and a prompt library (prompts.json).
//
//   node worker-ui/server.mjs   ->  http://localhost:8799
//
// Every run is bound to one workspace (a folder + a capability profile) and to one Claude
// config directory for its whole life, resumes included. See "workspaces" below.
//
// Event contract, one JSON object per line in runs/<id>.jsonl:
//   { ts, type, env?, tool?, summary, detail? }
//   type: user | reply | status | start | tool | result | failure | artifact | completed
//         | plan | observation | decision | recovery | verification | done | note
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync, lstatSync, realpathSync, renameSync, rmSync, copyFileSync, openSync, readSync, closeSync } from "node:fs";
import { join, dirname, resolve, extname, delimiter, relative, isAbsolute, sep, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { api as figmaApi, CRED_FILE as FIGMA_CRED_FILE, CRED_DIR as FIGMA_CRED_DIR, parseFigmaUrl, saveCredentials as saveFigmaCredentials } from "../figma-reader/reader.mjs";
import * as builderApi from "../builder-adapter/builder.mjs";
import * as github from "./github.mjs";
import * as ghApp from "./github-app.mjs";
import { resolveProvider } from "./provider.mjs";
import * as drafts from "./integrations.mjs";
import * as gitflow from "./gitflow.mjs";
import * as workerpack from "./workerpack.mjs";
import * as catalog from "./catalog.mjs";
import * as workerdef from "./workerdef.mjs";
import * as migrate from "./migrate.mjs";
import * as evolve from "./evolve.mjs";
github.setRefresher(ghApp.refreshToken); // an expiring "Connect with GitHub" token is refreshed with the app's secret

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
// WORKER_CONSOLE_PORT / WORKER_CONSOLE_DATA exist so tests can run a second console with its own
// runs, prompts and workspaces without touching this one's.
const DATA = resolve(process.env.WORKER_CONSOLE_DATA || HERE);
const RUNS = join(DATA, "runs");
const PROMPTS = join(DATA, "prompts.json");
const WORKSPACES = join(DATA, "workspaces.json");
const WORKERS = join(DATA, "workers.json");
const MEMORY = join(DATA, "workers");
const TEAMS = join(DATA, "teams.json");
const TEAMDIR = join(DATA, "teams"); // per team: uploaded knowledge, and every saved version
const GITHUB = join(DATA, "github.json"); // the GitHub connection's status and the repository registry (no token)
const PORT = Number(process.env.WORKER_CONSOLE_PORT) || 8799;
// Hosted (AIW_HOSTED=1): this console is one person's, started by the hosted gateway
// (worker-ui/gateway.mjs) as that person's own OS user, with its own data dir. It answers only the
// gateway (AIW_INTERNAL_SECRET on every request), and the platform narrows what workers get (see
// HOSTED_OFF). Everything else (workers, Teams, workspaces, runs, Git) is the same code as locally.
// docs/HOSTED_ARCHITECTURE.md.
const HOSTED = process.env.AIW_HOSTED === "1";
const fatal = (m) => { console.error(`Worker Console can't start: ${m}`); process.exit(1); };
const INTERNAL_SECRET = process.env.AIW_INTERNAL_SECRET || "";
const PUBLIC_ORIGIN = HOSTED ? String(process.env.AIW_PUBLIC_ORIGIN || "").replace(/\/+$/, "") : null;
if (HOSTED && !/^[\w-]{32,}$/.test(INTERNAL_SECRET)) fatal("AIW_INTERNAL_SECRET is missing (a hosted console is started by the gateway).");
if (HOSTED && !/^https?:\/\/[^/]+$/.test(PUBLIC_ORIGIN)) fatal("AIW_PUBLIC_ORIGIN is missing or not an origin.");
// The model provider: how workers are authenticated (worker-ui/provider.mjs). No fallback.
const PROVIDER = (() => { try { return resolveProvider(process.env, { hosted: HOSTED }); } catch (e) { return fatal(e.message); } })();
// A hosted person's workspaces are folders the console creates under their own data dir: there's
// no server path to type or browse, and the platform's own folder is never a workspace.
const HOSTED_WS_ROOT = join(DATA, "workspaces");
// Capabilities the hosted platform doesn't provide, whatever a worker's definition says
// (Effective access = worker ∩ workspace mode ∩ Team scope ∩ platform security):
//  - shell: node/curl on the server would be arbitrary code with network access; the OS boundary
//    keeps one person from another, but egress control isn't proven yet (CLOUD_DEPLOYMENT.md §9);
//  - the Figma plugin tools: they drive the Figma desktop app on the person's own computer through
//    a bridge on that computer; a server can't reach it.
const HOSTED_OFF = {
  shell: "Shell commands aren't available in the hosted product.",
  "figma.plugin.read": "The Figma plugin runs in the Figma desktop app on your own computer; the hosted product can't reach it. Use Figma links (Figma Reader) instead.",
  "figma.plugin.edit": "Changing a Figma file needs the Figma desktop app and plugin on your own computer; the hosted product can't reach it.",
};
const offHere = (c) => HOSTED && !!HOSTED_OFF[c];
// WORKER_FIGMA_LEGACY=1: the Figma tools as they were before batches and compact reads (comparison runs).
const FIGMA_LEGACY = process.env.WORKER_FIGMA_LEGACY === "1";
// The platform rules every worker gets: the reporting convention, plus the efficiency rules (left
// out in legacy mode, so a comparison run gets exactly the earlier instructions).
const platformInstructions = () => [readFileSync(join(HERE, "worker-instructions.md"), "utf8").trim(), ...(FIGMA_LEGACY ? [] : ["", readFileSync(join(HERE, "worker-efficiency.md"), "utf8").trim()])].join("\n");
function platformInstructionsFile() { const f = join(DATA, "instructions.effective.md"); writeFileSync(f, platformInstructions() + "\n"); return f; }
mkdirSync(RUNS, { recursive: true });
if (HOSTED) mkdirSync(HOSTED_WS_ROOT, { recursive: true });
// Screenshots the browser adapter writes: the adapter's own folder locally, the person's data dir hosted.
const BROWSER_EXPORTS = HOSTED ? join(DATA, "browser-exports") : join(REPO, "browser-adapter", "exports");
// Scratch: work that has no project folder (a Figma design, Builder content, a browser task,
// research). It's a mode, not a project: every scratch conversation gets its own empty folder,
// <data>/scratch-runs/<run id>, created when it starts, kept with the conversation, and reused by
// the sessions that continue it (a fresh-session handoff). The Work profile applies; the worker's
// own capabilities still decide its tools. It has no Git, and no project files to reference.
// Conversations from before 2026-10-20 ran in one shared folder, <data>/scratch (SCRATCH_WS.root):
// they keep it, so nothing of theirs moves. "scratch" is always in the list and can't be removed.
const SCRATCH_WS = { id: "scratch", name: "Scratch", root: join(DATA, "scratch"), profile: "full" };
const SCRATCH_RUNS = join(DATA, "scratch-runs");
mkdirSync(SCRATCH_WS.root, { recursive: true }); mkdirSync(SCRATCH_RUNS, { recursive: true });
const isScratchFolder = (p) => { try { return samePath(dirname(realpathSync.native(p)), realpathSync.native(SCRATCH_RUNS)); } catch { return false; } };
const SCRATCH_NOTE = ["## Workspace: Scratch",
  "This conversation has no project folder. Your working directory is its own scratch folder: it started empty, only this conversation (and any session that continues it) uses it, and it isn't under version control. There are no project files here to find.",
  "Keep intermediate files here. Report anything the person should keep or open with an ARTIFACT: line."].join("\n");
if (!existsSync(PROMPTS)) writeFileSync(PROMPTS, "[]\n");
// Files rewritten while the console runs (a run's record, its state, memory, prompts) are written to
// a temporary file and renamed over the old one, so stopping the console mid-write (closing its
// window) leaves the old version, not an empty file. Windows can refuse the rename while another
// program has the file open: then it's written in place, as before.
const writeAtomic = (p, text) => {
  try { writeFileSync(p + ".tmp", text); renameSync(p + ".tmp", p); }
  catch { writeFileSync(p, text); try { rmSync(p + ".tmp", { force: true }); } catch {} }
};

// Tools the worker may use: MCP environments, files, node/curl in the shell, web.
const ALLOWED = [
  "mcp__figma-executor", "mcp__browser-executor",
  "Read", "Write", "Edit", "Glob", "Grep", "Bash(node:*)", "Bash(curl:*)", "WebFetch", "WebSearch", "ToolSearch",
];
// Inspect: look, don't touch. An allow-list, so anything not named here is unavailable:
//  - built-in tools: --tools keeps only these four; --restricted also drops shell/code tools and
//    ignores user, project and local settings (no repo hooks, no CLAUDE.md, no personal allow rules);
//  - MCP tools: only these are approved, and with --permission-prompts none nothing else can be;
//  - the browser adapter itself runs in its inspect profile (http/https only, no screenshot tool).
// Not named, so unavailable: Bash/PowerShell, Write, Edit, NotebookEdit, worktrees, subagents,
// WebSearch/WebFetch, Figma mutation, export and page switching (it changes what the person sees
// in Figma), browser click/fill/screenshot.
const INSPECT_BUILTINS = ["Read", "Glob", "Grep", "ToolSearch"];
const INSPECT_MCP = [
  ...["ping", "get_file_info", "list_pages", "get_selection", "search_nodes", "get_document_state", "get_variables", "get_styles", "get_icon_components", "get_component_tree", "get_screen_tree", "get_prototype",
    "executor_status", "use_file", "verify_nodes"].map((t) => `mcp__figma-executor__figma_${t}`),
  "mcp__browser-executor__browser_navigate", "mcp__browser-executor__browser_get_dom_state",
];
// Both profiles skip user settings, so a worker's capabilities never depend on which config dir's
// personal allow rules or model setting happen to be there.
// Commits are the person's: Claude Code must not add its co-author trailer to any commit or PR a
// worker might make (the Workspace's own commits never add one either; see "versions").
// WebFetch never reaches this computer's own services (the console's API, the Figma bridge, the
// dev-control daemon): the runtime refuses these, below the model. The browser adapter has its own
// block for the platform's ports (BROWSER_BLOCK_PORTS). Shell commands (node, curl) are not covered
// by either: a worker with shell can do what the person's account can (docs/second-developer.md).
// Hosted, also the cloud metadata services by name (a network egress rule is the real control for
// addresses: CLOUD_DEPLOYMENT.md §6).
const LOOPBACK_FETCH_DENY = ["localhost", "*.localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0", ...(HOSTED ? ["169.254.169.254", "metadata.google.internal", "metadata", "100.100.100.200", "[fd00:ec2::254]"] : [])].map((d) => `WebFetch(domain:${d})`);
// Every worker compacts itself before its conversation passes the console's context limit (the
// runtime's own autoCompactWindow: verified headless, it compacts between steps, mid-turn). The limit
// is console-settings.json's contextWarnTokens (default 250k; the runtime takes 100k to 1M).
const AUTOCOMPACT_WINDOW = (() => { let n = 250000; try { n = Number(JSON.parse(readFileSync(join(DATA, "console-settings.json"), "utf8")).contextWarnTokens) || n; } catch {} return Math.min(1000000, Math.max(100000, Math.round(n))); })();
const WORKER_SETTINGS = JSON.stringify({ includeCoAuthoredBy: false, attribution: { commit: "", pr: "" }, autoCompactWindow: AUTOCOMPACT_WINDOW, permissions: { deny: LOOPBACK_FETCH_DENY } });
// Ports the browser adapter must never open: this console, the main console, the bridge, devctl.
const PLATFORM_PORTS = [...new Set([Number(process.env.WORKER_CONSOLE_PORT) || 8799, 8799, Number(process.env.FIGMA_BRIDGE_PORT) || 8787, Number(process.env.WORKER_CONSOLE_DEVCTL_PORT) || 8796])].join(",");
const PROFILES = {
  full: { browser: "full", args: ["--settings", WORKER_SETTINGS, "--setting-sources", "project,local", "--allowedTools", ...ALLOWED] },
  inspect: { browser: "inspect", args: ["--settings", WORKER_SETTINGS, "--restricted", "--tools", INSPECT_BUILTINS.join(","), "--allowedTools", ...INSPECT_BUILTINS, ...INSPECT_MCP, "--permission-prompts", "none"] },
};
// The Figma Executor's settings: read or edit, the Team's file if any, and the bridge starting
// itself (never hosted: there, no run gets the Executor at all, see HOSTED_OFF).
const figmaEnv = (access, fileKey) => ({ FIGMA_EXECUTOR_PROFILE: access, FIGMA_BRIDGE_AUTOSTART: HOSTED ? "0" : "1",
  ...(fileKey ? { FIGMA_EXPECTED_FILE_KEY: fileKey } : {}), ...(FIGMA_LEGACY ? { FIGMA_EXECUTOR_LEGACY: "1" } : {}), ...(process.env.FIGMA_BRIDGE_PORT ? { FIGMA_BRIDGE_PORT: process.env.FIGMA_BRIDGE_PORT } : {}) });
// MCP config per profile, with absolute paths (the worker's cwd is its workspace, not this repo).
const mcpConfig = (profile) => {
  const file = join(DATA, `mcp.${profile}.json`);
  writeFileSync(file, JSON.stringify({ mcpServers: {
    "figma-executor": { command: process.execPath, args: [join(REPO, "mcp", "server.mjs")], env: figmaEnv(profile === "full" ? "edit" : "read") },
    "browser-executor": { command: process.execPath, args: [join(REPO, "browser-adapter", "server.mjs")], env: { BROWSER_EXECUTOR_PROFILE: PROFILES[profile].browser, BROWSER_BLOCK_PORTS: PLATFORM_PORTS } },
  } }, null, 1));
  return file;
};

// ---- workers ------------------------------------------------------------------------
// A worker definition says who a worker is, what it may use, what it needs and its rules. It runs
// on this same runtime: it only changes the context file, tools and MCP servers spawnWorker passes
// to claude.exe. It can narrow what the workspace's profile allows, never widen it (a capability
// that the profile doesn't allow is simply not loaded). The general worker (no definition) keeps
// the profile's full tool set, exactly as before workers existed. See docs/worker-platform.md.
//
// Capabilities name real tools. A capability turns tools on; it grants access to nothing.
const FIGMA_READ_TOOLS = INSPECT_MCP.filter((t) => t.startsWith("mcp__figma-executor__"));
const BUILDER_READ_TOOLS = ["access_status", "list_models", "list_content", "get_content", "verify_content"].map((t) => `mcp__builder__builder_${t}`);
const BUILDER_DRAFT_TOOLS = ["create_draft", "update_content", "upload_asset"].map((t) => `mcp__builder__builder_${t}`);
const CAPABILITIES = {
  "files.read": { label: "Read files in the workspace", tools: "Read, Glob, Grep", builtins: ["Read", "Glob", "Grep"], allow: ["Read", "Glob", "Grep"], profiles: ["full", "inspect"] },
  "files.write": { label: "Edit files in the workspace", tools: "Write, Edit", builtins: ["Write", "Edit"], allow: ["Write", "Edit"], profiles: ["full"] },
  shell: { label: "Run node and curl", tools: "Bash(node:*), Bash(curl:*)", builtins: ["Bash"], allow: ["Bash(node:*)", "Bash(curl:*)"], profiles: ["full"] },
  web: { label: "Search and fetch the web", tools: "WebSearch, WebFetch", builtins: ["WebSearch", "WebFetch"], allow: ["WebSearch", "WebFetch"], profiles: ["full"] },
  browser: { label: "Use a browser", tools: "browser-executor (in Inspect: open and read pages only)", mcp: "browser-executor", allow: { full: ["mcp__browser-executor"], inspect: ["mcp__browser-executor__browser_navigate", "mcp__browser-executor__browser_get_dom_state"] }, profiles: ["full", "inspect"] },
  "figma.read": { label: "Read Figma designs from a link", tools: "figma-reader: figma_read_design, figma_access_status (REST API)", mcp: "figma-reader", allow: ["mcp__figma-reader"], profiles: ["full", "inspect"] },
  "figma.plugin.read": { label: "Read the open Figma file (plugin)", tools: "figma-executor read tools; the plugin must be running", mcp: "figma-executor", allow: FIGMA_READ_TOOLS, profiles: ["full", "inspect"] },
  "figma.plugin.edit": { label: "Change the open Figma file (plugin)", tools: "figma-executor, all tools; the plugin must be running", mcp: "figma-executor", allow: ["mcp__figma-executor"], profiles: ["full"] },
  "builder.read": { label: "Read Builder.io content", tools: "builder: access status, models, content, verify (Builder APIs)", mcp: "builder", allow: BUILDER_READ_TOOLS, profiles: ["full", "inspect"] },
  "builder.write": { label: "Create, change and publish Builder.io content (test spaces only)", tools: "builder: create draft, update (as a draft or live, inline or from a file), publish, upload assets", mcp: "builder", allow: ["mcp__builder"], profiles: ["full"] },
  // Narrower than builder.write: drafts only, never publish, never live:true. Enforced twice, not
  // just by this allow list — builder_publish_content isn't even registered by the MCP server in
  // this mode, and the adapter itself refuses live:true below the tool layer (builder-adapter/
  // builder.mjs's assertPublishAllowed). A worker can't turn this into "builder.write": that would
  // require editing this file, which no worker capability grants access to.
  "builder.write.draft": { label: "Create and change Builder.io content as drafts only (test spaces only) — publishing is not available", tools: "builder: create draft, update as a draft (inline or from a file), upload assets", mcp: "builder", allow: BUILDER_DRAFT_TOOLS, profiles: ["full"] },
  // Read-only on Git (worker-ui/gitflow.mjs does the Git work): commits, evidence, simulated plans,
  // and the worker's own notes. Creating a branch from a plan is the person's action on the page.
  "gitflow.read": { label: "Inspect branches and simulate synchronisation plans (read-only)", tools: "gitflow: overview, commits, commit, preview, save note", mcp: "gitflow", allow: ["mcp__gitflow"], profiles: ["full", "inspect"] },
};
// A Team's Figma resource locks the Figma tools of its runs to that one file: the Executor refuses
// commands while another file is open, and the Reader refuses links to other files.
const MCP_SERVERS = {
  // Read-only unless figma.plugin.edit is usable here: then the server registers no edit tools and
  // refuses edit commands itself (FIGMA_EXECUTOR_PROFILE=read), not just the allow list.
  "figma-executor": (profile, scope = {}, usable = []) => ({ command: process.execPath, args: [join(REPO, "mcp", "server.mjs")],
    env: figmaEnv(profile === "full" && usable.includes("figma.plugin.edit") ? "edit" : "read", scope.figmaKey) }),
  "figma-reader": (profile, scope = {}) => ({ command: process.execPath, args: [join(REPO, "mcp", "reader-server.mjs")],
    ...(scope.figmaKey ? { env: { FIGMA_READER_ALLOWED_KEYS: scope.figmaKey, ...(process.env.FIGMA_READER_DIR ? { FIGMA_READER_DIR: process.env.FIGMA_READER_DIR } : {}) } } : {}) }),
  // Hosted: no address on this machine or a private network, and screenshots in the person's own folder.
  "browser-executor": (profile) => ({ command: process.execPath, args: [join(REPO, "browser-adapter", "server.mjs")], env: { BROWSER_EXECUTOR_PROFILE: PROFILES[profile].browser, BROWSER_BLOCK_PORTS: PLATFORM_PORTS, ...(HOSTED ? { BROWSER_BLOCK_PRIVATE: "1", BROWSER_EXPORTS_DIR: BROWSER_EXPORTS } : {}) } }),
  // The write tools are registered only when the worker may write here (builder.write or the
  // narrower builder.write.draft usable); otherwise the server itself is read-only, not just its
  // allow list. builder.write.draft gets BUILDER_ADAPTER_PROFILE=draft: builder_publish_content
  // isn't registered at all in that mode, and the adapter refuses live:true even if something
  // tried to call update_content that way (builder-adapter/builder.mjs). Local files it may read
  // (uploads, page data) are confined to the run's workspace (BUILDER_UPLOAD_ROOT), and only when
  // it may write.
  builder: (profile, scope = {}, usable = [], root = null) => {
    const full = profile === "full" && usable.includes("builder.write");
    const draft = !full && profile === "full" && usable.includes("builder.write.draft");
    const builderProfile = full ? "full" : draft ? "draft" : "read";
    return { command: process.execPath, args: [join(REPO, "mcp", "builder-server.mjs")],
      env: { BUILDER_ADAPTER_PROFILE: builderProfile, ...((full || draft) && root ? { BUILDER_UPLOAD_ROOT: root } : {}), ...(process.env.BUILDER_ADAPTER_DIR ? { BUILDER_ADAPTER_DIR: process.env.BUILDER_ADAPTER_DIR } : {}) } };
  },
  // The Git workflow worker's read-only tools, on the run's workspace and this worker's own data.
  gitflow: (profile, scope = {}, usable = [], root = null, def = null) => ({ command: process.execPath, args: [join(REPO, "mcp", "gitflow-server.mjs")],
    env: { GITFLOW_ROOT: (() => { try { const c = readGitflowConfig(def?.id); return c ? gitflowRoot(def.id, c) : root; } catch { return root; } })(), GITFLOW_DIR: gitflowDir(def?.id) } }),
  // The workspace's registered repository, at this worker's access (mcp/repo-server.mjs registers
  // only the tools that access allows). It gets the checkout and the expected remote, no token.
  repo: (profile, scope = {}, usable = [], root = null) => ({ command: process.execPath, args: [join(REPO, "mcp", "repo-server.mjs")],
    env: { REPO_ROOT: root, REPO_URL: scope.repo.url, REPO_NAME: scope.repo.fullName, REPO_LEVEL: scope.repo.level, REPO_DEFAULT_BRANCH: scope.repo.defaultBranch || "",
      REPO_WORKERS_ON_DEFAULT: scope.repo.workersOnDefault ? "1" : "0", REPO_PROTECT: (scope.protect || []).map((p) => p.branch).join(",") } }),
};
// Access a worker can have to a workspace's repository, lowest first, and the tools each adds.
const REPO_LEVELS = ["read", "write", "commit", "push"];
const REPO_LEVEL_LABELS = { read: "Read: status, history and diffs", write: "Write: also edit files", commit: "Commit: also create branches and commit", push: "Push: also push branches" };
const REPO_TOOLS = [["repo_status", "read"], ["repo_log", "read"], ["repo_diff", "read"], ["repo_create_branch", "commit"], ["repo_commit", "commit"], ["repo_push", "push"]];
// Deny rules are applied by the runtime itself, below the model. Absolute paths are written the
// runtime's way (//c/Users/...); tested: a Write into such a folder is refused.
// (POSIX: //var/data/...: the leading slash is part of the "//" prefix.)
const denyPath = (p) => "//" + resolve(p).replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase()).replace(/^\/+/, "");
const PROTECT_DENY = ["Edit(.git/**)", "Edit(**/.git/**)", "Edit(.claude/**)", "Edit(**/.claude/**)"];
// What a defined worker gets in a given profile: the context, the tools and the MCP servers.
// scope narrows it further, never widens it:
//  - protect: branches an enforced policy protects in this workspace. Shell commands are turned
//    off (node or curl can run git, or write .git, behind the console's back), .git and .claude
//    can't be written, and project settings are ignored (--restricted: a repo's hooks don't run).
//  - onProtected: a protected branch is checked out, so file edits are off too.
//  - knowledgeDir: the run's copy of uploaded Team knowledge, readable and not writable.
//  - figmaKey: the Team's Figma file (see MCP_SERVERS).
//  - repo: the registered repository assigned to the workspace and this worker's access to it
//    (repoScope). Git goes only through the repo tools of that access; shell commands are off
//    unless the assignment allows them (node can run git behind the console); .git and .claude
//    can't be written; read access also turns file edits off.
function workerRuntime(def, profile, scope = {}) {
  const protect = !!scope.protect?.length, repo = scope.repo || null, repoRank = repo ? REPO_LEVELS.indexOf(repo.level) : -1;
  const policyOff = new Set([...(protect || (repo && !repo.shell) ? ["shell"] : []), ...(scope.onProtected || (repo && repoRank < 1) ? ["files.write"] : [])]);
  const allowed = def.capabilities.filter((c) => CAPABILITIES[c]?.profiles.includes(profile) && !offHere(c));
  const usable = allowed.filter((c) => !policyOff.has(c));
  const builtins = ["ToolSearch", ...new Set(usable.flatMap((c) => CAPABILITIES[c].builtins || []))];
  const repoTools = repo ? REPO_TOOLS.filter(([, l]) => repoRank >= REPO_LEVELS.indexOf(l)).map(([t]) => `mcp__repo__${t}`) : [];
  const allow = ["ToolSearch", ...usable.flatMap((c) => { const a = CAPABILITIES[c].allow; return Array.isArray(a) ? a : a[profile] || []; }), ...repoTools];
  const servers = [...new Set([...usable.map((c) => CAPABILITIES[c].mcp).filter(Boolean), ...(repo ? ["repo"] : [])])];
  // Hosted, .git and .claude are never writable by a worker and a repository's own settings and
  // hooks never run (--restricted): a cloned repository is untrusted code on the platform's servers.
  const lockGit = protect || !!repo || HOSTED;
  const base = profile === "inspect" || lockGit ? ["--restricted"] : ["--setting-sources", "project,local"];
  // Renders the worker makes (figma_export_node, browser_screenshot) land in the adapters' own
  // exports folders; it may read those, and only those, outside its workspace, to look at its work.
  const exportsDirs = [...new Set(usable.flatMap((c) => (c.startsWith("figma.plugin") ? [join(REPO, "exports")] : c === "browser" ? [BROWSER_EXPORTS] : [])))];
  const readOnly = scope.knowledgeDir ? [scope.knowledgeDir] : [];
  const deny = [...(lockGit ? PROTECT_DENY : []), ...readOnly.map((d) => `Edit(${denyPath(d)}/**)`), ...platformDeny(), ...secretDeny()];
  const dirs = [...exportsDirs, ...readOnly];
  const settings = JSON.stringify({ ...JSON.parse(WORKER_SETTINGS), permissions: { deny: [...LOOPBACK_FETCH_DENY, ...deny] }, ...fileGuard([scope.root, ...dirs]) });
  return { usable, blocked: def.capabilities.filter((c) => !allowed.includes(c) && !offHere(c)), byPlatform: def.capabilities.filter(offHere), byPolicy: allowed.filter((c) => policyOff.has(c)), servers, exportsDirs, repoTools,
    args: ["--settings", settings, ...base, "--tools", builtins.join(","), "--allowedTools", ...allow, ...(dirs.length ? ["--add-dir", ...dirs] : []), "--permission-prompts", "none"] };
}
// What a run starts with: its runtime and MCP servers. gate: capabilities whose accounts weren't
// available when the run started. A capability served by an integration tool server (live) is
// still loaded, with its tools off until it's connected (mcp/authz.mjs follows run.authz.live, which
// the console keeps up to date during the run); any other (built-in tools, the browser) isn't
// loaded: a process's built-in tools can't change while it runs. run: when given, its integration
// servers get the per-call check (AIW_AUTHZ_URL/TOKEN → authorizeCall) and the live set, and the
// run keeps what it was given.
const AUTHZ_SERVERS = new Set(["figma-executor", "figma-reader", "builder", "gitflow", "repo"]);
const liveCap = (c) => AUTHZ_SERVERS.has(CAPABILITIES[c]?.mcp);
function launchPlan(def, ws, scope, gate = {}, run = null) {
  const fixed = Object.fromEntries(Object.entries(gate).filter(([c]) => !liveCap(c)));
  const rt = workerRuntime({ ...def, capabilities: def.capabilities.filter((c) => !fixed[c]) }, ws.profile, { ...scope, root: ws.root });
  rt.byAccount = Object.entries(fixed).filter(([c]) => def.capabilities.includes(c));
  rt.waiting = Object.entries(gate).filter(([c]) => liveCap(c) && rt.usable.includes(c));
  if (run) {
    const before = run.authz;
    run.authz = { token: before?.token || randomUUID(), caps: new Set(rt.usable), def, ctx: { profile: ws.profile, root: ws.root, figmaKey: scope.figmaKey || null }, repo: scope.repo || null, checks: new Map(),
      // what's connected now: at the start, what the gate just found; on a resume, what this run last
      // had (announced changes are against it), confirmed again before its tool servers get an answer
      live: before?.live ? new Set([...before.live].filter((c) => rt.usable.includes(c))) : new Set(rt.usable.filter((c) => liveCap(c) && !gate[c])),
      v: (before?.v || 0) + 1, ready: !before, streak: new Map(), synced: new Map(), why: Object.fromEntries(rt.waiting) };
  }
  // A defined worker can propose a change to its own definition (mcp/evolve-server.mjs: read itself,
  // propose; nothing that approves or edits). Not in a trial run of a proposal, and never the
  // General worker, which has no definition.
  if (def.id && !scope.candidate) { rt.args.splice(rt.args.indexOf("--allowedTools") + 1, 0, "mcp__evolve"); rt.servers.push("evolve"); rt.evolve = true; }
  const servers = Object.fromEntries(rt.servers.map((n) => {
    if (n === "evolve") return [n, { command: process.execPath, args: [join(REPO, "mcp", "evolve-server.mjs")], env: run ? { EVOLVE_URL: `http://127.0.0.1:${PORT}/evolve/${run.meta.id}`, EVOLVE_TOKEN: run.authz.token } : {} }];
    const s = MCP_SERVERS[n](ws.profile, scope, rt.usable, ws.root, def);
    return [n, run && AUTHZ_SERVERS.has(n) ? { ...s, env: { ...(s.env || {}), AIW_AUTHZ_URL: `http://127.0.0.1:${PORT}/authz/${run.meta.id}`, AIW_AUTHZ_TOKEN: run.authz.token, AIW_AUTHZ_SERVER: n } } : s];
  }));
  return { rt, args: rt.args, servers };
}
// What's connected, during a run: the run's live capabilities are checked again every few seconds
// (the same account checks as at its start; the slow ones are cached). A capability that stops
// being available is turned off at once; one that comes up is turned on after two checks in a row
// (at once when the person asks for a check, or when a resumed run starts), so a connection that
// flickers doesn't toggle tools. Only capabilities given to the run at its start can be turned on:
// nothing is ever added. Each change is shown in the run, told to the worker with the person's
// next message, and confirmed with the tool servers and the runtime (confirmLive).
const LIVE_EVERY = 3000;
async function refreshLive(run, { force = false } = {}) {
  const a = run.authz;
  if (!a) return;
  if (a.refreshing) return a.refreshing;
  a.refreshing = (async () => {
    const caps = [...a.caps].filter(liveCap);
    const gate = await accountGate(a.def, force ? { ...a.ctx, start: true } : a.ctx, caps); // a forced check also starts the Figma bridge if it isn't running
    if (run.authz !== a) return; // the run restarted its process meanwhile
    const added = [], removed = [];
    for (const c of caps) {
      if (gate[c]) { a.streak.delete(c); a.why[c] = gate[c]; if (a.live.has(c)) { a.live.delete(c); removed.push(c); } continue; }
      delete a.why[c];
      if (a.live.has(c)) continue;
      const n = (a.streak.get(c) || 0) + 1; a.streak.set(c, n);
      if (force || !a.ready || n >= 2) { a.live.add(c); a.streak.delete(c); added.push(c); }
    }
    a.ready = true;
    // The plugin reopened in another file (a Team run is pinned to its own file by the check above):
    // the person and the worker are told which file the Figma tools now act on.
    let fileNote = "";
    if (bridgeLauncher && !a.ctx.figmaKey && [...a.live].some((c) => c.startsWith("figma.plugin."))) {
      const st = (await bridgeLauncher.bridgeStatus(FIGMA_BRIDGE_BASE).catch(() => null))?.status, f = st?.pluginConnected ? (st.sessions || [])[0] : null;
      if (run.authz !== a) return;
      if (f?.fileKey && a.figmaFile && f.fileKey !== a.figmaFile.key) {
        emit(run, { type: "capability", summary: `The Figma plugin is now in "${f.fileName}" (was "${a.figmaFile.name}"). The Figma tools act on that file now.`, detail: JSON.stringify({ file: { from: a.figmaFile.name, to: f.fileName } }) });
        fileNote = `the Figma plugin is now in "${f.fileName}" (was "${a.figmaFile.name}"): Figma tools act on that file now; confirm with figma_get_file_info before changing anything`;
      }
      if (f?.fileKey) a.figmaFile = { key: f.fileKey, name: f.fileName };
    }
    if (!added.length && !removed.length) { if (fileNote) run.pendingNote = `[Console: since your last turn, ${fileNote}.]`; return; }
    a.v++;
    const label = (c) => CAPABILITIES[c]?.label || c;
    if (added.length) emit(run, { type: "capability", summary: `Connected: ${added.map(label).join(", ")}. Its tools are on in this task.`, detail: JSON.stringify({ added: added.map(label), v: a.v }) });
    if (removed.length) emit(run, { type: "capability", summary: `Unavailable: ${removed.map((c) => `${label(c)} (${a.why[c]})`).join("; ")}. Its tools are off until it's connected again.`, detail: JSON.stringify({ removed: removed.map((c) => ({ label: label(c), why: a.why[c] })), waiting: true, v: a.v }) });
    const note = [added.length ? `now connected, its tools are available (search with ToolSearch): ${added.map(label).join(", ")}` : "", removed.length ? `no longer available, its tools are off: ${removed.map((c) => `${label(c)} (${a.why[c]})`).join("; ")}` : "", fileNote].filter(Boolean).join("; ");
    run.pendingNote = `[Console: since your last turn, ${note}.]`;
    if (added.length) confirmLive(run, a, added).catch(() => {});
  })().finally(() => { a.refreshing = null; });
  return a.refreshing;
}
// A change reached the worker: each tool server hosting an added capability applied it (it reports
// the version it applied and how many tools it has on), and the runtime lists that many tools for
// it (mcp_status). A runtime that answers with fewer tools didn't pick the change up (an older Claude
// Code): the run offers "Reload tools" (end the process; the next message resumes the same
// conversation with the tools connected then). A runtime that doesn't report isn't claimed either way.
async function confirmLive(run, a, added) {
  const servers = [...new Set(added.map((c) => CAPABILITIES[c].mcp))], v = a.v;
  let tries = 0;
  while (servers.some((n) => !((a.synced.get(n)?.at ?? -1) >= v)) && tries++ < 20) await new Promise((ok) => setTimeout(ok, 500));
  if (run.authz !== a || !alive(run) || a.v !== v) return;
  if (servers.some((n) => !((a.synced.get(n)?.at ?? -1) >= v))) { emit(run, { type: "capability", summary: `The tool server didn't confirm the change (${servers.join(", ")}). If the worker can't find the tools, reload them.`, detail: JSON.stringify({ reload: true, v }) }); return; }
  await new Promise((ok) => setTimeout(ok, 1000)); // the runtime refreshes its list shortly after the notification
  const st = await mcpStatus(run);
  if (!st || run.authz !== a || a.v !== v) return;
  const missing = servers.filter((n) => { const row = st.find((s) => s.name === n); return !row || row.status !== "connected" || (row.tools || []).length < (a.synced.get(n)?.on ?? 1); });
  if (missing.length) emit(run, { type: "capability", summary: `The worker's runtime didn't pick up the new tools (${missing.join(", ")}). Reload tools to continue this conversation with them.`, detail: JSON.stringify({ reload: true, v }) });
}
// The runtime's own view of its MCP servers (the stream-json mcp_status control request). Null when
// it doesn't answer in time or doesn't report servers.
function mcpStatus(run, timeout = 5000) {
  if (!alive(run)) return Promise.resolve(null);
  const id = `mcp-status-${randomUUID()}`;
  return new Promise((ok) => {
    const done = (v) => { clearTimeout(timer); run.controlWaits?.delete(id); ok(v); };
    const timer = setTimeout(() => done(null), timeout);
    (run.controlWaits ||= new Map()).set(id, (r) => done(Array.isArray(r?.response?.mcpServers) ? r.response.mcpServers : null));
    try { run.child.stdin.write(JSON.stringify({ type: "control_request", request_id: id, request: { subtype: "mcp_status" } }) + "\n"); } catch { done(null); }
  });
}
// A tool server asking which of its run's capabilities are connected now (mcp/authz.mjs).
async function liveFor(runId, token, server, at, on) {
  const run = runs.get(runId), a = run?.authz;
  if (!a || !alive(run)) return null;
  const t = Buffer.from(String(token)), want = Buffer.from(a.token);
  if (t.length !== want.length || !timingSafeEqual(t, want)) return null;
  if (server && at !== "") a.synced.set(server, { at: Number(at), on: Number(on) || 0 });
  if (!a.ready) await Promise.race([refreshLive(run, { force: true }), new Promise((ok) => setTimeout(ok, 9000))]);
  if (run.authz !== a || !a.ready) return { live: [], v: -1 };
  return { live: [...a.live, ...(a.repo ? ["repo"] : [])], v: a.v };
}
// One account check, never throwing and never hanging: anything but a clear "available" is a no.
async function checkAccount(a, ctx, timeout = 15000) {
  const r = RESOURCES[a.resource]?.access[a.access], label = `${RESOURCES[a.resource]?.label || a.resource}: ${r?.label || a.access}`;
  if (!r) return { ok: false, state: "Unknown account", label };
  let timer;
  try { const st = await Promise.race([r.check(ctx), new Promise((_, no) => { timer = setTimeout(() => no(new Error("timed out")), timeout); })]); return { ...st, ok: st?.ok === true, label }; }
  catch (e) { return { ok: false, state: `Check failed: ${e.message}`, label }; }
  finally { clearTimeout(timer); }
}
// Fail-closed at the start of a run: each capability that would be loaded is checked against the
// accounts it needs (its integration manifest's, or the core catalogue's); one that isn't available,
// or can't be confirmed, isn't loaded. Returns { capability: why }.
async function accountGate(def, ctx, usable) {
  const gate = {}, seen = new Map(), bindings = def.resolution?.bindings || {};
  // Only a worker that can use the open Figma file has the Figma bridge started at its run's start
  // (so an open plugin connects first, and one opened later connects during the run); for any other
  // the bridge isn't started.
  ctx = { ...ctx, start: !!ctx.start && usable.some((c) => c.startsWith("figma.plugin.")) };
  for (const c of usable) {
    const accounts = bindings[c] ?? catalog.capabilityAccounts(c);
    if (accounts == null) { gate[c] = "not a capability this console knows"; continue; }
    for (const a of accounts) {
      const k = `${a.resource}:${a.access}`;
      if (!seen.has(k)) seen.set(k, await checkAccount(a, ctx));
      const st = seen.get(k); if (!st.ok) { gate[c] = `${st.label}: ${st.state}`; break; }
    }
  }
  return gate;
}
// Each integration tool call (mcp/authz.mjs): the run is active, the call comes from its own tool
// server, the capability was given to this run, and its accounts are still available (checked
// again; a result is reused for at most 10 seconds). Anything else is refused.
async function authorizeCall(runId, token, cap) {
  const run = runs.get(runId), a = run?.authz;
  if (!a || !alive(run)) return { ok: false, reason: "this run isn't active" };
  const t = Buffer.from(String(token)), want = Buffer.from(a.token);
  if (t.length !== want.length || !timingSafeEqual(t, want)) return { ok: false, reason: "the call didn't come from this run's tool server" };
  let accounts = [];
  if (cap === "repo") { if (!a.repo) return { ok: false, reason: "this run has no repository access" }; }
  else {
    if (!a.caps.has(cap)) return { ok: false, reason: `${CAPABILITIES[cap]?.label || cap} isn't given to this worker in this run` };
    accounts = a.def.resolution?.bindings?.[cap] ?? catalog.capabilityAccounts(cap);
    if (accounts == null) return { ok: false, reason: "not a capability this console knows" };
  }
  for (const acc of accounts) {
    const k = `${acc.resource}:${acc.access}`, hit = a.checks.get(k);
    const st = hit && Date.now() - hit.at < 10000 ? hit.value : await checkAccount(acc, a.ctx, 8000);
    if (!hit || hit.value !== st) a.checks.set(k, { at: Date.now(), value: st });
    if (!st.ok) return { ok: false, reason: `${st.label}: ${st.state}${st.detail ? ` (${st.detail})` : ""}` };
  }
  return { ok: true };
}
// On every console, local and hosted, a worker's file tools never read or write the person's
// integration credentials (GitHub, Figma, Builder), the runtime's sign-in and session records, the
// tool-server tokens of runs (runs/<id>.mcp.json) or common credential files in the home folder.
// Enforced by the runtime's permission rules, which follow junctions, symlinks and ../ and cover
// Grep and Glob too (bench/integrations/file-boundary-test.mjs). The runtime's config dir isn't
// denied as a whole: a run reads back its own large tool outputs from its session folder there
// (tested: a whole-folder deny refuses that); fileGuard keeps reads out of every other session.
// Hosted, the OS boundary (the person's own uid) is beneath it. Shell commands aren't held by
// these rules (see platformDeny).
const HOME_SECRETS = [".ssh", ".aws", ".azure", ".config/gcloud", ".config/gh", ".docker", ".kube", ".git-credentials", ".netrc", ".npmrc", ".pypirc"];
const CONFIG_SECRETS = [".credentials.json", "*.json", "*.jsonl", "projects/*/*.jsonl", "projects/*/*/subagents/**", "projects/*/memory/**", "sessions/**", "session-env/**", "shell-snapshots/**", "file-history/**", "backups/**", "todos/**", "debug/**"];
function secretDeny() {
  const dirs = [github.CRED_DIR, FIGMA_CRED_DIR, builderApi.CRED_DIR].map(denyPath), cfg = denyPath(CONFIG_DIR);
  const home = HOME_SECRETS.map((p) => denyPath(join(homedir(), p)));
  return [...dirs.flatMap((d) => [`Read(${d}/**)`, `Edit(${d}/**)`]),
    `Edit(${cfg}/**)`, ...CONFIG_SECRETS.map((p) => `Read(${cfg}/${p})`),
    `Read(${denyPath(RUNS)}/*.mcp.json)`,
    ...home.flatMap((d) => [`Read(${d})`, `Read(${d}/**)`, `Edit(${d})`, `Edit(${d}/**)`])];
}
// A run's file tools (Read, Glob, Grep, Write, Edit) stay inside its workspace and --add-dir
// folders; reads may also reach its own session folder (file-guard.mjs, a PreToolUse hook the
// runtime runs before each call). Without it a local run could read and write anywhere the
// person's account can (tested). disableAllHooks is pinned off: a repository's own settings
// can't switch the check off (tested: they could without it).
const FILE_GUARD = join(HERE, "file-guard.mjs");
const fileGuard = (roots) => ({ disableAllHooks: false, hooks: { PreToolUse: [{ matcher: "Read|Glob|Grep|Write|Edit|MultiEdit|NotebookEdit",
  hooks: [{ type: "command", command: `"${process.execPath}" "${FILE_GUARD}" ${Buffer.from(JSON.stringify({ roots: roots.filter(Boolean) })).toString("base64url")}` }] }] } });
// On every console, local and hosted, no worker's file tools may write:
//  - the console's own records: worker definitions, their versions, proposals and memory, Teams,
//    workspaces, settings, run logs, Git workflow configuration, backups (a worker could otherwise
//    rewrite its own definition and access, as a file, outside any review);
//  - the integration catalogue (manifests, core capabilities, the release lockfile) and the platform
//    instructions every run is given;
//  - the files the runtime reads as standing instructions or settings in a workspace — CLAUDE.md,
//    CLAUDE.local.md, AGENTS.md, .claude/ — which a worker could otherwise use to steer its own later
//    runs without anyone reviewing it (probed: a worker-written CLAUDE.md reached its next run).
// Verified by bench/evolution/boundary-probe.mjs. A worker WITH shell (node, curl) isn't held by
// these rules: it runs code as the person's OS user (see docs/worker-evolution.md, "Limits");
// the integrity check in newRun catches a definition changed outside the console.
const STANDING_INSTRUCTIONS = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"];
function platformDeny() {
  const d = denyPath(DATA);
  return [...["*.json", "*.md", "runs/**", "workers/**", "teams/**", "gitflow/**", "backups/**"].map((p) => `Edit(${d}/${p})`),
    `Edit(${denyPath(catalog.dir())}/**)`, ...["worker-instructions.md", "worker-efficiency.md"].map((f) => `Edit(${denyPath(join(HERE, f))})`),
    "Edit(.claude/**)", "Edit(**/.claude/**)", ...STANDING_INSTRUCTIONS.flatMap((f) => [`Edit(${f})`, `Edit(**/${f})`])];
}
// The general worker, as a definition: what it gets when a policy means it can't run on the plain
// profile flags (every capability the profile allows, except the ones the policy turns off).
// It has no definition, so it gets only the core capabilities granted to it in its settings
// (general.json; by default the catalogue's), within the workspace's, Team's and platform's limits.
// Never an integration's tools: those come with a worker that has the integration.
const GENERAL_FILE = join(DATA, "general.json");
const readGeneral = () => { try { const g = JSON.parse(readFileSync(GENERAL_FILE, "utf8")); return { core: (Array.isArray(g.core) ? g.core : []).filter((c) => catalog.isCore(c)), saved: true }; } catch { return { core: catalog.generalDefault(), saved: false }; } };
const generalDefinition = () => ({ id: null, name: "General", capabilities: readGeneral().core, workflow: [], limitations: [], requirements: [] });

// Requirements are generic {resource, access, need}; this registry knows how to check each one
// now, without showing any secret. A missing requirement doesn't block the run: the worker is
// told, and the tools themselves refuse without access.
// The bridge launcher (bridge/launcher.mjs) is local-only code: the hosted image doesn't contain it.
const bridgeLauncher = HOSTED ? null : await import("../bridge/launcher.mjs");
const FIGMA_BRIDGE_BASE = `http://127.0.0.1:${Number(process.env.FIGMA_BRIDGE_PORT) || 8787}`;
let figmaCheck = { at: 0, value: null }, builderCheck = { at: 0, value: null };
const RESOURCES = {
  figma: { label: "Figma", access: {
    read: { label: "read designs", how: HOSTED ? "Connect Figma on the Figma page (a Figma personal access token with file_content:read). The connected account must be able to open the file." : "Connect Figma on this computer once: a Figma personal access token with file_content:read, or the OAuth flow (figma-reader/README.md). The connected account must be able to open the file.",
      async check() {
        if (!existsSync(FIGMA_CRED_FILE)) return { ok: false, state: "Not connected" };
        if (figmaCheck.value && Date.now() - figmaCheck.at < (figmaCheck.value.ok ? 60000 : 5000)) return figmaCheck.value;
        let v; try { const me = await figmaApi("/v1/me"); v = { ok: true, state: "Connected", detail: me.handle ? `as ${me.handle}` : "" }; }
        catch (e) { v = { ok: false, state: e.status === 401 || e.status === 403 ? "Authorization rejected" : "Can't verify", detail: clip(e.message, 120) }; }
        figmaCheck = { at: Date.now(), value: v }; return v;
      } },
    edit: { label: "change the open file", how: HOSTED ? HOSTED_OFF["figma.plugin.edit"] : "Open the file in the Figma desktop app and run Plugins → Development → AI Executor (POC). The bridge starts by itself; Figma only runs a plugin when a person runs it.",
      // From the bridge's /status. At a run's start (ctx.start) the bridge is started if it isn't
      // running, so a plugin that's already open connects before the worker's first Figma call; a
      // Team run (ctx.figmaKey) needs the plugin in the Team's file.
      async check(ctx = {}) {
        if (HOSTED) return { ok: false, state: "Not available in the hosted product" };
        let fresh = false;
        if (ctx.start) {
          const up = await bridgeLauncher.ensureBridge(FIGMA_BRIDGE_BASE);
          if (!up.ok) return { ok: false, state: { MISSING_DEPENDENCY: "Bridge not installed", PORT_IN_USE: "Bridge port in use" }[up.code] || "Bridge can't start", detail: clip(`${up.error} ${up.nextStep || ""}`, 200) };
          fresh = up.started || up.restarted;
        }
        let s = await bridgeLauncher.bridgeStatus(FIGMA_BRIDGE_BASE);
        if (!s.isBridge) return s.reachable ? { ok: false, state: "Bridge port in use", detail: clip(s.error, 120) } : { ok: false, state: "Bridge not running", detail: "It starts by itself on the first Figma call." };
        if (fresh && !s.status.pluginConnected) s = await bridgeLauncher.waitForPlugin(FIGMA_BRIDGE_BASE, { fileKey: ctx.figmaKey || null, timeout: 6000 });
        const st = s.status || {}, sessions = st.sessions || [];
        if (!st.pluginConnected) return { ok: false, state: "Plugin not running", detail: "Run the AI Executor plugin in the Figma file." };
        const f = ctx.figmaKey ? sessions.find((x) => x.fileKey === ctx.figmaKey) : sessions[0];
        if (ctx.figmaKey && st.sessions && !f) return { ok: false, state: "Plugin running in another file", detail: clip(sessions.map((x) => x.fileName).join(", "), 120) };
        return { ok: true, state: "Connected", detail: f?.fileName ? `in "${f.fileName}"${sessions.length > 1 ? ` (+${sessions.length - 1} more)` : ""}` : "" };
      } },
  } },
  workspace: { label: "Workspace folder", access: {
    read: { label: "read files", how: "Run the worker in a workspace.", async check() { return { ok: true, state: "Available" }; } },
    write: { label: "edit files", how: "Run the worker in a Work workspace (Inspect workspaces are read-only).", async check(ctx) { return ctx.profile === "full" ? { ok: true, state: "Available" } : { ok: false, state: "Inspect workspace" }; } },
  } },
  browser: { label: "Browser", access: {
    use: { label: "open web pages", how: "Install the browser adapter (browser-adapter, npm install).", async check() { return existsSync(join(REPO, "browser-adapter", "node_modules", "playwright")) ? { ok: true, state: "Available" } : { ok: false, state: "Not installed" }; } },
  } },
  builder: { label: "Builder.io", access: {
    read: { label: "read content", how: "Add the Builder space's keys once on this computer (builder-adapter/README.md). A Builder link alone grants nothing.",
      async check() {
        if (!builderApi.credentialsPresent()) return { ok: false, state: "Not connected" };
        if (builderCheck.value && Date.now() - builderCheck.at < (builderCheck.value.ok ? 60000 : 5000)) return builderCheck.value;
        let v; try { const s = builderApi.accessSummary(); await builderApi.listModels(); v = { ok: true, state: "Connected", detail: `${s.label} (${s.environment})` }; }
        catch (e) { v = { ok: false, state: e.status === 401 || e.status === 403 ? "Key rejected" : "Can't verify", detail: clip(e.message, 120) }; }
        builderCheck = { at: Date.now(), value: v }; return v;
      } },
    write: { label: "change content", how: "Builder writes are only allowed in a space marked as a test space in builder-adapter's credentials; production spaces are never written by this adapter.",
      async check() {
        if (!builderApi.credentialsPresent()) return { ok: false, state: "Not connected" };
        try { const s = builderApi.accessSummary(); return s.environment === "test" ? { ok: true, state: "Test space", detail: s.label } : { ok: false, state: "Production space: writes refused", detail: s.label }; }
        catch (e) { return { ok: false, state: "Can't verify", detail: clip(e.message, 120) }; }
      } },
  } },
  // Whether Git on this computer can reach the workspace's GitHub remote with the person's own
  // login (git ls-remote: reads refs, changes nothing, never prompts). It can't tell whether a
  // push would be allowed; GitHub decides that at push time.
  github: { label: "GitHub", access: {
    read: { label: "reach the repository", how: HOSTED ? "Connect GitHub on the GitHub page, and choose this repository for the AI Worker app on GitHub." : "Sign in to GitHub with Git on this computer once (for example, run \"git fetch\" in a terminal in this folder).",
      async check(ctx) {
        if (!ctx.root) return { ok: false, state: "No workspace" };
        const url = safeUrl((await git(ctx.root, ["remote", "get-url", "origin"]).catch(() => "")).trim());
        if (!/github\.com[:/]/i.test(url)) return { ok: false, state: url ? "Not a GitHub remote" : "No remote" };
        const hit = githubChecks.get(url);
        if (hit && Date.now() - hit.at < 300000) return hit.value;
        let v; try { await git(ctx.root, ["ls-remote", "--heads", "origin"], { timeout: 20000, auth: true }); v = { ok: true, state: "Reachable", detail: url }; }
        catch (e) { v = { ok: false, state: e.timedOut ? "Timed out" : /Authentication|could not read|terminal prompts|403|401/i.test(e.message) ? "Not signed in" : "Can't reach", detail: url }; }
        githubChecks.set(url, { at: Date.now(), value: v }); return v;
      } },
  } },
};
const githubChecks = new Map();
async function requirementStatus(def, ctx) {
  return Promise.all((def.requirements || []).map(async (r) => {
    const a = RESOURCES[r.resource]?.access[r.access];
    const st = a ? await a.check(ctx).catch((e) => ({ ok: false, state: "Check failed", detail: e.message })) : { ok: false, state: "Unknown requirement" };
    return { ...r, label: `${RESOURCES[r.resource]?.label || r.resource}: ${a?.label || r.access}`, how: a?.how || "", ...st };
  }));
}
function checkRequirements(list) {
  const requirements = (list || []).map((r) => ({ resource: String(r.resource || ""), access: String(r.access || ""), need: r.need === "optional" ? "optional" : "required" }));
  for (const r of requirements) if (!RESOURCES[r.resource]?.access[r.access]) throw new Error(`Unknown requirement "${r.resource} ${r.access}".`);
  return requirements.filter((r, i) => requirements.findIndex((x) => x.resource === r.resource && x.access === r.access) === i);
}

// Workers are read resolved (workerdef.mjs: a schema-2 worker's tools, requirements and integration
// instructions come from its pinned manifests) and written in their stored form.
const readWorkersRaw = () => (existsSync(WORKERS) ? JSON.parse(readFileSync(WORKERS, "utf8")) : []);
const readWorkers = () => readWorkersRaw().map(workerdef.resolve);
// Every version of a worker is kept: workers/<id>/history/v<N>.json { version, parent, savedAt,
// source { kind, … }, reason, definition (stored form) }, written by writeWorkers for each worker whose
// stored definition changed — whoever changed it (the editor, an upgrade, a migration, an import, a
// restore, an approved proposal). A version number is never reused: if a write would land on a number
// that's already recorded with other content (after a migration was undone, say), it gets the next
// free one. A worker first changed after history began also gets its previous form recorded
// ("before-history"), so it can be compared and restored.
const historyDir = (id) => join(MEMORY, id, "history");
const historyVersions = (id) => (/^[\w-]+$/.test(id) && existsSync(historyDir(id)) ? readdirSync(historyDir(id)).map((f) => /^v(\d+)\.json$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b) : []);
const readVersion = (id, n) => { const f = join(historyDir(id), `v${Number(n)}.json`); return /^[\w-]+$/.test(id) && existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null; };
function recordVersion(stored, source, parent) {
  mkdirSync(historyDir(stored.id), { recursive: true });
  const f = join(historyDir(stored.id), `v${stored.version}.json`);
  if (existsSync(f)) throw new Error(`Version ${stored.version} of ${stored.name} is already recorded.`); // never overwritten
  writeAtomic(f, JSON.stringify({ version: stored.version, parent, savedAt: new Date().toISOString(), source: { kind: source.kind, ...(source.proposal ? { proposal: source.proposal } : {}), ...(source.restoredFrom ? { restoredFrom: source.restoredFrom } : {}), ...(source.verification ? { verification: source.verification } : {}) }, reason: String(source.reason || "").slice(0, 500), definition: stored }, null, 1));
}
const writeWorkers = (list, why = { kind: "save" }) => {
  const before = new Map(readWorkersRaw().map((w) => [w.id, w]));
  const out = list.map(workerdef.toStored);
  for (const w of out) {
    const prev = before.get(w.id);
    if (prev && JSON.stringify(prev) === JSON.stringify(w)) continue;
    let have = historyVersions(w.id);
    if (prev && !have.length) { recordVersion(prev, { kind: "before-history" }, null); have = [prev.version]; }
    const top = have.length ? have[have.length - 1] : 0;
    if (w.version <= top) { w.version = top + 1; w.updatedAt = new Date().toISOString(); }
    recordVersion(w, why, prev ? prev.version : null);
  }
  writeFileSync(WORKERS + ".tmp", JSON.stringify(out, null, 1)); renameSync(WORKERS + ".tmp", WORKERS);
  return out;
};
// A worker runs only as a version the console recorded: if its stored definition differs from the
// history file of its version (or that version was never recorded although it has history), it was
// changed outside the console — by hand, or by a program running as the person — and isn't run until
// someone saves it in the editor (which records it). Workers from before history are run as they are.
function integrityProblem(w) {
  const have = historyVersions(w.id);
  if (!have.length) return null;
  const rec = readVersion(w.id, w.version), stored = readWorkersRaw().find((x) => x.id === w.id);
  if (rec && JSON.stringify(rec.definition) === JSON.stringify(stored)) return null;
  return `${w.name}'s definition was changed outside the console (it doesn't match its recorded version ${w.version}${rec ? "" : ", which was never recorded"}). Open it in the editor, check it, and save it to make it a recorded version before running it.`;
}
const lines = (v, max, len) => (Array.isArray(v) ? v : String(v || "").split(/\r?\n/)).map((x) => String(x).trim()).filter(Boolean).slice(0, max).map((x) => x.slice(0, len));
// Everything the person can set, checked: unknown capabilities or requirements are refused.
function normalizeWorker(b, prev) {
  const name = String(b.name || "").trim();
  if (!name || name.length > 60) throw new Error("Give the worker a name (up to 60 characters).");
  // Schema 2: integrations pinned to versions, explicit core capabilities, its own text (workerdef.mjs).
  if (b.schema === workerdef.SCHEMA || (workerdef.isV2(prev) && b.schema !== 1)) return workerdef.resolve(normalizeWorkerV2(b, prev, name));
  const capabilities = [...new Set((b.capabilities || []).map(String))];
  for (const c of capabilities) if (!CAPABILITIES[c]) throw new Error(`Unknown capability "${c}".`);
  const requirements = (b.requirements || []).map((r) => ({ resource: String(r.resource || ""), access: String(r.access || ""), need: r.need === "optional" ? "optional" : "required" }));
  for (const r of requirements) if (!RESOURCES[r.resource]?.access[r.access]) throw new Error(`Unknown requirement "${r.resource} ${r.access}".`);
  // Access to registered repositories: none unless granted here, per repository.
  const known = new Set(readGithub().repos.map((r) => r.id)), repos = [];
  for (const g of (b.repos || []).slice(0, 50)) {
    const repo = String(g?.repo || ""), level = String(g?.level || "");
    if (!level || level === "none") continue;
    if (!known.has(repo)) throw new Error(`No registered repository "${repo}".`);
    if (!REPO_LEVELS.includes(level)) throw new Error(`Unknown repository access "${level}".`);
    if (!repos.some((x) => x.repo === repo)) repos.push({ repo, level });
  }
  const now = new Date().toISOString();
  return { id: prev?.id || `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "worker"}-${randomUUID().slice(0, 4)}`, name, repos,
    mission: String(b.mission || "").trim().slice(0, 600), specialization: String(b.specialization || "").trim().slice(0, 200),
    capabilities, knowledge: String(b.knowledge || "").trim().slice(0, 20000), workflow: lines(b.workflow, 30, 600), limitations: lines(b.limitations, 30, 300),
    requirements: requirements.filter((r, i) => requirements.findIndex((x) => x.resource === r.resource && x.access === r.access) === i), onMissing: String(b.onMissing || "").trim().slice(0, 1000),
    // The request it was created from (only ever set by the console: see worker drafts).
    ...(prev?.fromRequest ? { fromRequest: prev.fromRequest } : {}),
    // Where it came from when it was cloned or imported (only ever set by the console: see worker packages).
    ...(prev?.origin ? { origin: prev.origin } : {}),
    version: (prev?.version || 0) + 1, createdAt: prev?.createdAt || now, updatedAt: now };
}

function normalizeWorkerV2(b, prev, name) {
  const parts = workerdef.check(b, { resources: RESOURCES });
  const known = new Set(readGithub().repos.map((r) => r.id)), repos = [];
  for (const g of (b.repos || []).slice(0, 50)) {
    const repo = String(g?.repo || ""), level = String(g?.level || "");
    if (!level || level === "none") continue;
    if (!known.has(repo)) throw new Error(`No registered repository "${repo}".`);
    if (!REPO_LEVELS.includes(level)) throw new Error(`Unknown repository access "${level}".`);
    if (!repos.some((x) => x.repo === repo)) repos.push({ repo, level });
  }
  const now = new Date().toISOString();
  return { schema: workerdef.SCHEMA, id: prev?.id || `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "worker"}-${randomUUID().slice(0, 4)}`, name,
    specialization: String(b.specialization || "").trim().slice(0, 200), mission: String(b.mission || "").trim().slice(0, 600), outcomes: lines(b.outcomes, 10, 200),
    ...parts, workflow: lines(b.workflow, 30, 600), knowledge: String(b.knowledge || "").trim().slice(0, 20000), limitations: lines(b.limitations, 30, 300), onMissing: String(b.onMissing || "").trim().slice(0, 1000), repos,
    ...(prev?.fromRequest ? { fromRequest: prev.fromRequest } : {}), ...(prev?.origin ? { origin: prev.origin } : {}), ...(prev?.migratedFrom ? { migratedFrom: prev.migratedFrom } : {}),
    version: (prev?.version || 0) + 1, createdAt: prev?.createdAt || now, updatedAt: now };
}

// ---------------- worker drafts: a worker for the work a person describes ----------------
// The person says what the worker should do; the registry (integrations.mjs) recognises the tools
// and systems involved, asks only their questions, and composes an ordinary definition. The page
// sends the description and the answers, never capabilities: they're computed here, from the fixed
// catalogues, and the result runs through the same workerRuntime as any worker (capabilities ∩
// workspace mode ∩ Team scope ∩ platform). Integrations without a connector are answered honestly.
drafts.checkRegistry(CAPABILITIES, RESOURCES);
// A Git workflow worker's data: <data>/gitflow/<worker id>/ (config.json, plans/, audit.jsonl,
// notes.json, and scratch/: the private repository its analysis and simulations write to).
function gitflowDir(id) { if (!/^[\w-]+$/.test(String(id || ""))) throw new Error("No worker for the Git workflow tools."); return join(DATA, "gitflow", id); }
// Read through normalizeConfig, so a configuration saved by an earlier version gets today's rules
// (e.g. off-limits branches) without anyone re-saving it.
function readGitflowConfig(id) { const f = join(gitflowDir(id), "config.json"); try { if (!existsSync(f)) return null; const raw = JSON.parse(readFileSync(f, "utf8")); try { return { ...gitflow.normalizeConfig({}, raw), updatedAt: raw.updatedAt }; } catch { return raw; } } catch { return null; } }
function writeGitflowConfig(id, cfg) { mkdirSync(gitflowDir(id), { recursive: true }); writeAtomic(join(gitflowDir(id), "config.json"), JSON.stringify(cfg, null, 1)); }
const gitflowAudit = (id, e) => new gitflow.GitFlow({ root: null, dir: gitflowDir(id), config: {} }).audit(e);
// Plan executions running as jobs (their steps, and a cancel requested before the branch is created).
const gitflowJobs = new Map();
// GITFLOW_READ_ONLY=1: the Git workflow may look but never write: no branch is created, pushed or
// deleted and nothing is fetched (for checking it against a real repository). GITFLOW_ENV_LABEL names
// a test environment; the page shows both on every screen of the workflow.
const GITFLOW_ENV = { readOnly: process.env.GITFLOW_READ_ONLY === "1", label: String(process.env.GITFLOW_ENV_LABEL || "").slice(0, 160) };
const gitflowWrites = (parts, method) => method === "POST" && (["execute", "pr", "fetch", "jobs"].includes(parts[2]) || (parts[2] === "branch" && parts[3] === "delete"));
// The repository a Git workflow reads: a workspace's folder, or the console's own clone of a URL.
function gitflowRoot(id, cfg) {
  if (cfg.source === "remote") { const d = join(gitflowDir(id), "remote.git"); if (!existsSync(join(d, "HEAD"))) throw new Error("The repository hasn't been cloned yet: save the setup with its URL."); return d; }
  if (!cfg.workspace) throw new Error("Choose the repository in the Git workflow setup.");
  return resolveWorkspace(cfg.workspace).root;
}
// The Git identity of a repository (user.name / user.email), or null.
function gitIdentity(root) {
  if (!root) return null;
  const id = (k) => (spawnSync("git", ["config", k], { cwd: root, encoding: "utf8", windowsHide: true }).stdout || "").trim();
  const name = id("user.name"), email = id("user.email");
  return name || email ? { name, email } : null;
}
// Who approved or changed something, for the audit and pull requests: the signed-in person (hosted),
// else this clone's Git identity, else "person at this console".
function gitflowActor(root) {
  if (HOSTED) return process.env.AIW_USER_EMAIL || "person";
  const i = gitIdentity(root);
  return i ? `${i.name || "?"} <${i.email || "?"}>` : "person at this console";
}
function gitflowEngine(id, cfg, noRepo = false) {
  return new gitflow.GitFlow({ root: noRepo ? null : gitflowRoot(id, cfg), dir: gitflowDir(id), config: cfg });
}
// A draft as the page shows it: the composition, what it would get in a workspace, and its
// requirements checked now.
async function draftPreview(b) {
  const d = drafts.compose(b);
  let w = { profile: "full", root: null, name: "" }; try { w = resolveWorkspace(b.workspace || "scratch"); } catch {}
  const rt = workerRuntime({ capabilities: d.definition.capabilities }, w.profile);
  return { ...d, profile: w.profile, usable: rt.usable, blocked: rt.blocked, byPlatform: rt.byPlatform,
    status: await requirementStatus({ requirements: d.definition.requirements }, { profile: w.profile, root: w.root }) };
}
// Creating it: refused while a required follow-up is unanswered, or when nothing asked for can be
// done with today's connectors. The person can rename it and reword its mission; nothing else.
function workerFromRequest(b) {
  const d = drafts.compose(b);
  if (d.pending.length) throw Object.assign(new Error(`Answer first: ${d.pending.map((x) => x.label).join("; ")}.`), { status: 400 });
  if (d.nothingSupported) throw Object.assign(new Error(`Nothing in this request can be done with the connectors this platform has: ${d.unsupported.map((u) => u.label).join(", ") || "no tools or systems named"}.`), { status: 400 });
  const name = String(b.name || "").trim() || d.definition.name, mission = String(b.mission || "").trim() || d.definition.mission;
  // Schema 2: the integrations it involves, pinned at the versions it was composed with.
  return { ...normalizeWorker({ ...workerdef.fromDraft(d), name, mission, specialization: d.definition.specialization }), fromRequest: { description: d.description, integrations: d.integrations, answers: d.answers, others: d.others,
    workspace: d.workspace, unsupported: d.unsupported.map((u) => u.label), starters: d.starters, at: new Date().toISOString() } };
}
// ---------------- worker packages: cloning and sharing (worker-ui/workerpack.mjs) ----------------
// Export, clone and import share one path: a worker becomes a package (the allowlist in
// workerpack.mjs), the package is read and checked as untrusted input, and installing it creates a
// new worker through normalizeWorker, the same as any worker made here. What it may do is decided by
// this console: its catalogues, the workspace it runs in, the accounts connected here, its policies.
const packCatalog = () => ({ capabilities: Object.fromEntries(Object.entries(CAPABILITIES).map(([id, c]) => [id, c.label])),
  resources: Object.fromEntries(Object.entries(RESOURCES).flatMap(([id, r]) => Object.entries(r.access).map(([a, x]) => [`${id}:${a}`, `${r.label}: ${x.label}`]))) });
// local: a clone on this console keeps its paths (they're this computer's own) and isn't stopped by
// text that looks like a credential (nothing leaves the computer); an export is.
const packWorker = (w, local = false) => workerpack.buildPackage({ worker: w, local, gitflow: w.capabilities.includes("gitflow.read") ? readGitflowConfig(w.id) : null,
  repoName: (id) => readGithub().repos.find((r) => r.id === id)?.fullName || null, catalog: packCatalog(), generator: { name: "ai-workforce-console", version: `workerpack ${workerpack.FORMAT_VERSION}` },
  secretFields: (id, version) => catalog.get(id, version)?.config.secret || [], integrationInfo: (id, version) => { const m = catalog.get(id, version) || catalog.latest(id); return m ? { label: m.label, status: m.status } : null; } });
// A package's pinned integrations, as this console has them: the exact version; else another version
// of the same major (its settings carried over), which installs only with the person's consent; else
// missing (nothing of that version here) or unknown (no such integration here).
function packIntegrations(d) {
  return (d.integrations || []).map((r) => {
    const exact = catalog.get(r.id, r.version), latest = catalog.latest(r.id), major = catalog.semver(r.version)[0];
    const alt = !exact ? catalog.versions(r.id).filter((v) => catalog.semver(v)[0] === major).pop() || null : null;
    const m = exact || (alt && catalog.get(r.id, alt)), config = exact ? r.config : alt ? migrate.carryConfig(r.config, m).config : r.config;
    const errors = m ? workerdef.configErrors(m, config) : [];
    const state = exact ? (errors.length ? "invalid" : "exact") : alt ? (errors.length ? "invalid" : "other-version") : latest ? "missing-version" : "unknown";
    return { id: r.id, version: r.version, label: m?.label || latest?.label || r.id, status: m?.status || "unknown", state, alternative: alt, use: state === "exact" ? r.version : state === "other-version" ? alt : null, config, errors: errors.slice(0, 3), available: catalog.versions(r.id) };
  });
}
// The schema-2 definition a package would install as here (what this console can resolve).
const packV2 = (pkg, o = {}) => { const ints = packIntegrations(pkg.definition), d = pkg.definition;
  return { ints, stored: { schema: workerdef.SCHEMA, name: o.name || d.name, specialization: d.specialization, mission: d.mission, outcomes: d.outcomes, workflow: d.workflow, knowledge: pkg.knowledge, limitations: d.limitations, onMissing: d.onMissing,
    integrations: ints.filter((x) => x.use).map((x) => ({ id: x.id, version: x.use, config: x.config })), core: d.core.filter((c) => catalog.isCore(c)), extraRequirements: d.extraRequirements.filter((r) => !!RESOURCES[r.resource]?.access[r.access]) } }; };
// Packages read and checked, waiting for the person to install them (30 minutes, at most 20).
const PENDING_PACKS = new Map();
function keepPack(pkg) {
  const now = Date.now();
  for (const [k, v] of PENDING_PACKS) if (now - v.at > 30 * 60e3) PENDING_PACKS.delete(k);
  while (PENDING_PACKS.size >= 20) PENDING_PACKS.delete(PENDING_PACKS.keys().next().value);
  const token = randomUUID(); PENDING_PACKS.set(token, { pkg, at: now }); return token;
}
const nameTaken = (name) => readWorkers().some((w) => w.name.toLowerCase() === String(name).trim().toLowerCase());
function freeName(base) { if (!nameTaken(base)) return base; for (let n = 2; ; n++) { const s = ` (${n})`, c = base.slice(0, 60 - s.length) + s; if (!nameTaken(c)) return c; } }
// Its Git workflow rules as this console would save them (null when it has none). Never people,
// overrides or a repository from the package; proposal branches start off.
function packGitflowConfig(pkg, workspace) {
  if (!pkg.gitflow) return null;
  return gitflow.normalizeConfig({ source: "workspace", workspace: workspace || "", teams: pkg.gitflow.teams, people: [], overrides: [], mappings: pkg.gitflow.mappings,
    exclude: pkg.gitflow.exclude, shared: pkg.gitflow.shared, forbidden: pkg.gitflow.forbidden, tickets: pkg.gitflow.tickets, proposals: false });
}
// What a package asks for, against this console now: its tools (known here, and usable in the chosen
// workspace and on this platform), its accounts and access (checked now, as at a run's start), the
// repositories it would need (registered here or not: granting is the person's choice), its Git
// workflow rules (valid here or not), and its name (taken here or not).
async function packPlan(pkg, o = {}) {
  if (pkg.definition.schema === workerdef.SCHEMA) return packPlanV2(pkg, o);
  const d = pkg.definition;
  let ws = null; try { ws = resolveWorkspace(o.workspace || "console"); } catch {}
  const profile = ws?.profile || "full", known = d.capabilities.filter((c) => CAPABILITIES[c]), rt = workerRuntime({ capabilities: known }, profile);
  const reqOk = (r) => !!RESOURCES[r.resource]?.access[r.access];
  const status = await requirementStatus({ requirements: d.requirements.filter(reqOk) }, { profile, root: ws?.root || null });
  const registered = readGithub().repos;
  let gitflowError = ""; try { packGitflowConfig(pkg, ""); } catch (e) { gitflowError = e.message; }
  const issues = [...d.capabilities.filter((c) => !CAPABILITIES[c]).map((c) => ({ kind: "capability", id: c, text: `“${c}” isn't a tool this console has.` })),
    ...d.requirements.filter((r) => !reqOk(r)).map((r) => ({ kind: "requirement", id: `${r.resource}:${r.access}`, text: `“${r.resource} ${r.access}” isn't something this console can check or provide.` })),
    ...(gitflowError ? [{ kind: "gitflow", id: "gitflow", text: `Its Git workflow rules aren't valid here: ${gitflowError}` }] : [])];
  return { workspace: ws ? { id: ws.id, name: ws.name, profile } : null, profile,
    capabilities: known.map((id) => ({ id, label: CAPABILITIES[id].label, tools: CAPABILITIES[id].tools,
      state: rt.usable.includes(id) ? "available" : rt.byPlatform.includes(id) ? "platform" : rt.byPolicy?.includes(id) ? "policy" : "workspace", note: offHere(id) ? HOSTED_OFF[id] : "" })),
    requirements: status, missingRequired: status.filter((r) => r.need === "required" && !r.ok).length,
    repositories: pkg.repositories.map((g) => { const here = registered.find((r) => r.fullName.toLowerCase() === g.fullName.toLowerCase()); return { ...g, registered: !!here, repo: here?.id || null, levels: REPO_LEVELS.slice(0, Math.max(1, REPO_LEVELS.indexOf(g.level) + 1)) }; }),
    gitflow: pkg.gitflow ? { teams: pkg.gitflow.teams, mappings: pkg.gitflow.mappings, exclude: pkg.gitflow.exclude, shared: pkg.gitflow.shared, forbidden: pkg.gitflow.forbidden, error: gitflowError } : null,
    name: d.name, nameTaken: nameTaken(d.name), suggestedName: freeName(d.name), issues };
}
// A format-2 package: its integrations as this console has them, the tools and requirements they
// resolve to here, its core capabilities, and its name.
async function packPlanV2(pkg, o = {}) {
  const d = pkg.definition, { ints, stored } = packV2(pkg);
  let ws = null; try { ws = resolveWorkspace(o.workspace || "console"); } catch {}
  const profile = ws?.profile || "full", resolved = workerdef.resolve({ ...stored, id: "preview" }), rt = workerRuntime(resolved, profile);
  const status = await requirementStatus(resolved, { profile, root: ws?.root || null });
  const registered = readGithub().repos;
  const issues = [...ints.filter((x) => x.state !== "exact").map((x) => ({ kind: "integration", id: x.id, text: x.state === "other-version" ? `${x.label} ${x.version} isn't here: it installs at ${x.alternative} (the same major version), with its settings carried over.` : x.state === "invalid" ? `${x.label}: its settings aren't valid for ${x.use || x.alternative || x.version} here (${x.errors.join("; ")}).` : x.state === "missing-version" ? `${x.label} ${x.version} isn't here (this console has ${x.available.join(", ")}).` : `“${x.id}” isn't an integration this console has.` })),
    ...d.core.filter((c) => !catalog.isCore(c)).map((c) => ({ kind: "capability", id: c, text: `“${c}” isn't a core capability this console has.` })),
    ...d.extraRequirements.filter((r) => !RESOURCES[r.resource]?.access[r.access]).map((r) => ({ kind: "requirement", id: `${r.resource}:${r.access}`, text: `“${r.resource} ${r.access}” isn't something this console can check or provide.` }))];
  let gitflowError = ""; try { packGitflowConfig(pkg, ""); } catch (e) { gitflowError = e.message; }
  if (gitflowError) issues.push({ kind: "gitflow", id: "gitflow", text: `Its Git workflow rules aren't valid here: ${gitflowError}` });
  return { schema: 2, workspace: ws ? { id: ws.id, name: ws.name, profile } : null, profile, integrations: ints.map(({ config, ...x }) => x),
    capabilities: resolved.capabilities.map((id) => ({ id, label: CAPABILITIES[id]?.label || id, tools: CAPABILITIES[id]?.tools || "", core: catalog.isCore(id),
      state: rt.usable.includes(id) ? "available" : rt.byPlatform.includes(id) ? "platform" : rt.byPolicy?.includes(id) ? "policy" : "workspace", note: offHere(id) ? HOSTED_OFF[id] : "" })),
    core: stored.core, requirements: status, missingRequired: status.filter((r) => r.need === "required" && !r.ok).length,
    repositories: pkg.repositories.map((g) => { const here = registered.find((r) => r.fullName.toLowerCase() === g.fullName.toLowerCase()); return { ...g, registered: !!here, repo: here?.id || null, levels: REPO_LEVELS.slice(0, Math.max(1, REPO_LEVELS.indexOf(g.level) + 1)) }; }),
    gitflow: pkg.gitflow ? { teams: pkg.gitflow.teams, mappings: pkg.gitflow.mappings, exclude: pkg.gitflow.exclude, shared: pkg.gitflow.shared, forbidden: pkg.gitflow.forbidden, error: gitflowError } : null,
    name: d.name, nameTaken: nameTaken(d.name), suggestedName: freeName(d.name), issues };
}
// Installing: always a new worker (a new id, version 1, no memory, no runs), never over another one.
// What isn't supported here is installed only after the person agrees to leave it out (dropUnknown).
function installPack(pkg, o = {}, origin = "package") {
  if (pkg.definition.schema === workerdef.SCHEMA) return installPackV2(pkg, o, origin);
  const d = pkg.definition, reqOk = (r) => !!RESOURCES[r.resource]?.access[r.access];
  const unknownCaps = d.capabilities.filter((c) => !CAPABILITIES[c]), unknownReqs = d.requirements.filter((r) => !reqOk(r));
  let flow = null, flowError = ""; try { flow = packGitflowConfig(pkg, ""); } catch (e) { flowError = e.message; }
  if ((unknownCaps.length || unknownReqs.length || flowError) && !o.dropUnknown) throw Object.assign(new Error("Some of what the package asks for isn't supported here. Confirm installing it without them."), { status: 400 });
  const name = String(o.name || "").trim() || d.name;
  if (nameTaken(name)) throw Object.assign(new Error(`A worker called “${name}” already exists here. Choose another name: an existing worker is never replaced.`), { status: 409 });
  // Repository access: only to a repository registered on this console, at most the level the package
  // asked for, and only what the person granted here. The package itself grants nothing.
  const registered = readGithub().repos, repos = [];
  for (const g of Array.isArray(o.repos) ? o.repos.slice(0, 20) : []) {
    const want = pkg.repositories.find((x) => x.fullName.toLowerCase() === String(g?.fullName || "").toLowerCase()), here = want && registered.find((r) => r.fullName.toLowerCase() === want.fullName.toLowerCase());
    if (!g?.level || g.level === "none") continue;
    if (!here) throw Object.assign(new Error(`“${g.fullName}” isn't a repository registered on this console.`), { status: 400 });
    if (REPO_LEVELS.indexOf(g.level) < 0 || REPO_LEVELS.indexOf(g.level) > REPO_LEVELS.indexOf(want.level)) throw Object.assign(new Error(`Access to ${want.fullName} can be at most “${want.level}”, as the package asks.`), { status: 400 });
    repos.push({ repo: here.id, level: g.level });
  }
  if (o.gitflowWorkspace) resolveWorkspace(o.gitflowWorkspace); // a workspace of this console, or an error
  const list = readWorkers();
  let w = normalizeWorker({ ...d, name, knowledge: pkg.knowledge, capabilities: d.capabilities.filter((c) => CAPABILITIES[c]), requirements: d.requirements.filter(reqOk), repos });
  while (list.some((x) => x.id === w.id)) w = { ...w, id: normalizeWorker({ name }).id };
  const r = d.request;
  if (r.description || r.starters.length) w.fromRequest = { description: r.description, integrations: r.integrations, answers: {}, others: [], workspace: r.workspaceKind, unsupported: r.unsupported, starters: r.starters, at: w.createdAt };
  w.origin = { kind: origin, packageId: pkg.manifest.packageId, from: d.name, at: w.createdAt, ...(origin === "clone" && o.sourceId ? { worker: o.sourceId } : {}) };
  seedLearnings(w.id, origin === "clone" ? o.sourceId : null, d.name);
  writeWorkers([...list, w], { kind: origin === "clone" ? "clone" : "import", reason: `From ${d.name}` });
  const gitflowSaved = !!(flow && w.capabilities.includes("gitflow.read"));
  if (gitflowSaved) { writeGitflowConfig(w.id, { ...flow, workspace: o.gitflowWorkspace || "" }); gitflowAudit(w.id, { action: "import", by: origin === "clone" ? "clone" : "package", packageId: pkg.manifest.packageId, from: d.name }); }
  return { worker: w, gitflow: gitflowSaved, gitflowWorkspace: gitflowSaved ? o.gitflowWorkspace || "" : null, left: { capabilities: unknownCaps, requirements: unknownReqs.map((x) => `${x.resource} ${x.access}`), gitflow: flowError } };
}
// ---- migrating workers made before integrations ----
const BACKUPS = join(DATA, "backups");
const listBackups = () => (existsSync(BACKUPS) ? readdirSync(BACKUPS).filter((f) => /^workers-[\w-]+\.json$/.test(f)).sort().reverse().slice(0, 20) : []);
// items: [{ id, choice?: index into the proposal's choices, acceptChanges?: true }]. All or nothing.
function applyMigration(b) {
  const items = Array.isArray(b.workers) ? b.workers.slice(0, 200) : [], list = readWorkers(), done = [];
  if (!items.length) throw Object.assign(new Error("Choose which workers to migrate."), { status: 400 });
  const next = list.map((w) => ({ ...w }));
  for (const it of items) {
    const k = next.findIndex((w) => w.id === it.id);
    if (k < 0) throw Object.assign(new Error(`No worker "${it.id}".`), { status: 404 });
    if (workerdef.isV2(next[k])) throw Object.assign(new Error(`${next[k].name} is already migrated.`), { status: 400 });
    const p = migrate.proposeMigration(next[k]);
    const picked = p.status === "ambiguous" ? (Number.isInteger(it.choice) && p.choices[it.choice] ? p.choices[it.choice].result : p.choices.length ? null : p) : p;
    if (!picked) throw Object.assign(new Error(`${p.name}: its mapping is ambiguous; choose one of its options.`), { status: 400 });
    const changes = [...picked.effective.added.map((c) => `+${c}`), ...picked.effective.removed.map((c) => `-${c}`)];
    if (changes.length && it.acceptChanges !== true) throw Object.assign(new Error(`${p.name}: this mapping changes its tools (${changes.join(", ")}). Accept that change to migrate it.`), { status: 400, changes });
    const v2 = normalizeWorker({ schema: workerdef.SCHEMA, name: next[k].name, specialization: next[k].specialization, mission: next[k].mission, integrations: picked.integrations.map(({ id, version, config }) => ({ id, version, config })), core: picked.core,
      workflow: picked.own.workflow, knowledge: picked.own.knowledge, limitations: picked.own.limitations, onMissing: next[k].onMissing, extraRequirements: picked.extraRequirements, repos: next[k].repos || [] }, { ...next[k], schema: workerdef.SCHEMA });
    v2.migratedFrom = { schema: 1, version: next[k].version, at: new Date().toISOString(), mapping: p.status === "ambiguous" ? "chosen" : p.status, changes };
    next[k] = workerdef.resolve(workerdef.toStored(v2)); done.push({ id: v2.id, name: v2.name, mapping: v2.migratedFrom.mapping, changes, capabilities: next[k].capabilities });
  }
  mkdirSync(BACKUPS, { recursive: true });
  const backup = `workers-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  copyFileSync(WORKERS, join(BACKUPS, backup));
  writeWorkers(next, { kind: "migration", reason: "Migrated to integrations" });
  return { migrated: done, backup };
}
function undoMigration(b) {
  const name = String(b.backup || listBackups()[0] || "");
  if (!listBackups().includes(name)) throw Object.assign(new Error("There's no such migration backup."), { status: 404 });
  const keep = `workers-before-undo-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  copyFileSync(WORKERS, join(BACKUPS, keep)); copyFileSync(join(BACKUPS, name), WORKERS);
  return { restored: name, kept: keep };
}
// A format-2 package: its integrations pinned at the versions this console has. Anything else — a
// version installed in place of the package's, an integration left out — only with the person's consent.
function installPackV2(pkg, o = {}, origin = "package") {
  const d = pkg.definition, { ints, stored } = packV2(pkg, { name: String(o.name || "").trim() || d.name });
  let flow = null, flowError = ""; try { flow = packGitflowConfig(pkg, ""); } catch (e) { flowError = e.message; }
  const changed = ints.filter((x) => x.state !== "exact"), unknownCore = d.core.filter((c) => !catalog.isCore(c)), unknownReqs = d.extraRequirements.filter((r) => !RESOURCES[r.resource]?.access[r.access]);
  if ((changed.length || unknownCore.length || unknownReqs.length || flowError) && !o.dropUnknown) throw Object.assign(new Error("Some of what the package asks for isn't here as it is. Confirm installing it with what this console has."), { status: 400 });
  stored.integrations = ints.filter((x) => x.use && !x.errors.length).map((x) => ({ id: x.id, version: x.use, config: x.config }));
  if (nameTaken(stored.name)) throw Object.assign(new Error(`A worker called “${stored.name}” already exists here. Choose another name: an existing worker is never replaced.`), { status: 409 });
  const registered = readGithub().repos, repos = [];
  for (const g of Array.isArray(o.repos) ? o.repos.slice(0, 20) : []) {
    const want = pkg.repositories.find((x) => x.fullName.toLowerCase() === String(g?.fullName || "").toLowerCase()), here = want && registered.find((r) => r.fullName.toLowerCase() === want.fullName.toLowerCase());
    if (!g?.level || g.level === "none") continue;
    if (!here) throw Object.assign(new Error(`“${g.fullName}” isn't a repository registered on this console.`), { status: 400 });
    if (REPO_LEVELS.indexOf(g.level) < 0 || REPO_LEVELS.indexOf(g.level) > REPO_LEVELS.indexOf(want.level)) throw Object.assign(new Error(`Access to ${want.fullName} can be at most “${want.level}”, as the package asks.`), { status: 400 });
    repos.push({ repo: here.id, level: g.level });
  }
  if (o.gitflowWorkspace) resolveWorkspace(o.gitflowWorkspace);
  const list = readWorkers();
  let w = normalizeWorker({ ...stored, repos });
  while (list.some((x) => x.id === w.id)) w = normalizeWorker({ ...stored, repos });
  const r = d.request;
  if (r.description || r.starters.length) w.fromRequest = { description: r.description, integrations: r.integrations, answers: {}, others: [], workspace: r.workspaceKind, unsupported: r.unsupported, starters: r.starters, at: w.createdAt };
  w.origin = { kind: origin, packageId: pkg.manifest.packageId, from: d.name, at: w.createdAt, format: pkg.manifest.formatVersion, ...(origin === "clone" && o.sourceId ? { worker: o.sourceId } : {}) };
  seedLearnings(w.id, origin === "clone" ? o.sourceId : null, d.name);
  writeWorkers([...list, w], { kind: origin === "clone" ? "clone" : "import", reason: `From ${d.name}` });
  w = readWorkers().find((x) => x.id === w.id);
  const gitflowSaved = !!(flow && w.capabilities.includes("gitflow.read"));
  if (gitflowSaved) { writeGitflowConfig(w.id, { ...flow, workspace: o.gitflowWorkspace || "" }); gitflowAudit(w.id, { action: "import", by: origin === "clone" ? "clone" : "package", packageId: pkg.manifest.packageId, from: d.name }); }
  return { worker: w, gitflow: gitflowSaved, gitflowWorkspace: gitflowSaved ? o.gitflowWorkspace || "" : null,
    left: { capabilities: unknownCore, requirements: unknownReqs.map((x) => `${x.resource} ${x.access}`), gitflow: flowError, integrations: ints.filter((x) => !x.use || x.errors.length).map((x) => `${x.label} ${x.version}`), versions: ints.filter((x) => x.state === "other-version" && !x.errors.length).map((x) => `${x.label} ${x.version} → ${x.alternative}`) } };
}
const packFile = (w) => `${w.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "worker"}.workerpack`;
// Learnings (stored as its memory file): what a worker chose to keep from its work (LEARNED: lines,
// REMEMBER: before), kept apart from its definition, shown to the person, given to its later runs as
// a labelled section, and copied to a clone (never into a package for another console).
const memPath = (id) => join(MEMORY, `${id}.memory.json`);
const readMemory = (id) => (/^[\w-]+$/.test(id) && existsSync(memPath(id)) ? JSON.parse(readFileSync(memPath(id), "utf8")) : []);
const writeMemory = (id, list) => { mkdirSync(MEMORY, { recursive: true }); writeAtomic(memPath(id), JSON.stringify(list, null, 1)); };
// A new worker's learnings: a clone starts with a copy of its source's (each marked where it came
// from; the source keeps its own), anything else with none.
function seedLearnings(id, sourceId, sourceName) {
  const copied = sourceId ? readMemory(sourceId).map((m) => ({ ...m, copiedFrom: m.copiedFrom || { worker: sourceId, name: sourceName, at: new Date().toISOString() } })) : [];
  if (copied.length || existsSync(memPath(id))) writeMemory(id, copied);
}
const SECRETISH = /(figd_|ghp_|github_pat_|sk-[a-z0-9]|xox[bp]-|AKIA[0-9A-Z]{8}|-----BEGIN|password\s*[:=]|api[_-]?key\s*[:=]|token\s*[:=])/i;

// ---- worker evolution: proposals (worker-ui/evolve.mjs, docs/worker-evolution.md) ----
// A worker proposes (mcp/evolve-server.mjs → /evolve/<run>/propose, with its run's token); the
// proposal is stored in workers/<id>/proposals/<pid>.json. The person reviews it, may try it in a
// trial run (and the worker as it is, in a baseline trial), has the console grade the trial against
// the proposal's checks, then approves it — a new recorded version of the worker — or rejects it.
// The approving, trying and grading endpoints are the person's: same-origin page requests, never the
// worker's token.
const proposalDir = (id) => join(MEMORY, id, "proposals");
const readProposal = (wid, pid) => { if (!/^[\w-]+$/.test(wid) || !/^p-[\w-]+$/.test(pid)) return null; const f = join(proposalDir(wid), `${pid}.json`); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null; };
const writeProposal = (p) => { mkdirSync(proposalDir(p.worker), { recursive: true }); writeAtomic(join(proposalDir(p.worker), `${p.id}.json`), JSON.stringify(p, null, 1)); };
const listProposals = (wid) => (/^[\w-]+$/.test(wid) && existsSync(proposalDir(wid)) ? readdirSync(proposalDir(wid)).filter((f) => /^p-[\w-]+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(proposalDir(wid), f), "utf8"))).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : []);
const storedOf = (id) => readWorkersRaw().find((w) => w.id === id) || null;
// What it relies on, checked now: the accounts each capability it uses needs (and Builder read access
// for the console itself when a check reads Builder). Missing ones make it "blocked", with the reason.
async function proposalDependencies(p, worker, ctx = { profile: "full", root: DATA }) {
  const out = [], bindings = worker.resolution?.bindings || {};
  for (const cap of p.uses) {
    let why = "";
    for (const a of bindings[cap] ?? catalog.capabilityAccounts(cap) ?? []) { const st = await checkAccount(a, ctx); if (!st.ok) { why = `${st.label}: ${st.state}`; break; } }
    out.push({ capability: cap, label: CAPABILITIES[cap]?.label || cap, ok: !why, why: why || "available" });
  }
  if (p.checks.some((c) => c.type === "builder_entry") && !out.some((d) => d.capability === "builder.read")) {
    const st = await checkAccount({ resource: "builder", access: "read" }, ctx);
    out.push({ capability: "builder.read", label: "Read Builder.io content (the console grades the checks with it)", ok: st.ok, why: st.ok ? "available" : `${st.label}: ${st.state}` });
  }
  return out;
}
// The proposal as the page and the worker see it: its stored record, its state worked out now
// (stale, verification), and the diff against the version it was made for.
function proposalView(p) {
  const cur = storedOf(p.worker), base = readVersion(p.worker, p.base)?.definition || cur || {};
  return { ...p, ...evolve.stateOf(p, cur), currentVersion: cur?.version ?? null, diff: evolve.diffStored(base, evolve.applyChanges(base, p.changes)), checkText: p.checks.map(evolve.describeCheck) };
}
async function submitProposal(b, w, createdBy, ctx) {
  const stored = storedOf(w.id);
  if (Number(b.baseVersion) !== stored.version) throw Object.assign(new Error(`The definition is at version ${stored.version} now, not ${b.baseVersion}. Read it again (evolve_read_self) and propose against version ${stored.version}.`), { status: 409 });
  if (listProposals(w.id).filter((p) => p.status === "proposed" && p.base === stored.version).length >= evolve.MAX_OPEN) throw Object.assign(new Error(`There are already ${evolve.MAX_OPEN} proposals waiting for review on this version. The person has to decide on those first.`), { status: 429 });
  const { proposal, errors } = evolve.normalizeProposal(b, w);
  if (errors.length) throw Object.assign(new Error("The proposal wasn't accepted. Fix these and propose again:"), { status: 400, errors });
  const p = { id: `p-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`, worker: w.id, workerName: w.name, base: stored.version, ...proposal, warnings: evolve.warnings(stored, proposal.changes),
    createdAt: new Date().toISOString(), createdBy, status: "proposed", trials: [] };
  p.dependencies = await proposalDependencies(p, w, ctx);
  writeProposal(p);
  return p;
}
// Where a worker's proposal came from: the run, what the person said in it, and what the run read from
// outside (a reviewer's cue for instructions planted in a page or file the worker read).
function proposalProvenance(run) {
  const ev = existsSync(run.file) ? readFileSync(run.file, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  return { kind: "worker", run: run.meta.id, version: run.meta.worker.version, asked: ev.filter((e) => e.type === "user").slice(-4).map((e) => clip(e.summary, 500)),
    externalReads: ev.filter((e) => e.type === "tool" && ["WebFetch", "WebSearch", "browser_navigate"].includes(e.tool)).slice(-10).map((e) => clip(e.summary, 200)) };
}
// What evolve_read_self returns: the worker's own text and what it can't change.
function selfView(w) {
  const s = storedOf(w.id);
  return { id: w.id, name: w.name, version: s.version, schema: s.schema || 1, mission: s.mission, specialization: s.specialization,
    own: Object.fromEntries(evolve.FIELDS.filter((f) => f !== "outcomes" || s.schema === 2).map((f) => [f, s[f] ?? (f === "knowledge" || f === "onMissing" ? "" : [])])),
    tools: w.capabilities.map((c) => ({ id: c, label: CAPABILITIES[c]?.label || c, tools: CAPABILITIES[c]?.tools || "" })),
    integrations: (w.integrationInstructions || []).map((x) => ({ id: x.id, version: x.version, label: x.label, steps: x.steps, limits: x.limits, setUp: x.know, notPossible: x.unsupported })),
    openProposals: listProposals(w.id).filter((p) => p.status === "proposed").map((p) => ({ id: p.id, title: p.title, base: p.base, stale: p.base !== s.version })),
    canChange: evolve.FIELDS.filter((f) => f !== "outcomes" || s.schema === 2), cannotChange: "tools, core capabilities, integrations and their settings, requirements, repository access, name, mission: only the person changes those, in the editor" };
}
// Builder, as the console reads it to grade a check: its own credentials, fresh reads.
const builderReader = {
  status: async () => { const st = await checkAccount({ resource: "builder", access: "read" }, { profile: "full", root: DATA }); return { ok: st.ok, why: `${st.label}: ${st.state}` }; },
  list: async (model) => { const out = []; for (let off = 0; off < 300; off += 100) { const page = await builderApi.listContent(model, { limit: 100, offset: off }); out.push(...page); if (page.length < 100) break; } return out; },
  get: (model, id) => builderApi.getContent(model, id, { includeData: true }),
};

// The worker's context for one run: the shared instructions, then this worker, then what was
// checked at start, then its memory. Written once per run and kept, so the run never changes
// under an edited definition.
function workerContext(def, rt, status, memory, profile, extra = {}) {
  const cap = (c) => `- ${CAPABILITIES[c].label} (${CAPABILITIES[c].tools})`;
  return [platformInstructions(), "",
    workspaceSection(extra.workspace), teamSection(extra.team),
    `# You are: ${def.name}`, def.mission && `Mission: ${def.mission}`, def.specialization && `Specialization: ${def.specialization}`, "",
    "## What you can use in this run", rt.usable.length ? rt.usable.filter((c) => !rt.waiting?.some(([w]) => w === c)).map(cap).join("\n") || "- Nothing yet beyond reading this context." : "- Nothing beyond reading this context.",
    rt.waiting?.length ? `Waiting for a connection: ${rt.waiting.map(([c, why]) => `${CAPABILITIES[c]?.label || c} (${why})`).join("; ")}. Their tools come on in this task as soon as it's connected; the console checks every few seconds and tells you with the person's next message. Then search for them with ToolSearch. If the task needs one now, write a NEEDS: line saying what to connect; never ask for a new task for it.` : "",
    rt.waiting?.length || rt.usable.some(liveCap) ? "If a connection drops during the task, its tools go off (a call is refused with the reason) and come back when it's connected again." : "",
    rt.blocked.length ? `Not available here (this workspace is ${profile === "inspect" ? "Inspect, read-only" : "Work"}): ${rt.blocked.map((c) => CAPABILITIES[c].label).join(", ")}.` : "",
    rt.byPlatform?.length ? `Not available in the hosted product: ${rt.byPlatform.map((c) => CAPABILITIES[c].label).join(", ")}. If the task needs one, write a NEEDS: line for it.` : "",
    rt.byPolicy?.length ? `Turned off by an enforced policy in this workspace: ${rt.byPolicy.map((c) => CAPABILITIES[c].label).join(", ")}.` : "",
    rt.byAccount?.length ? `Not loaded in this run, because what they need wasn't available when it started: ${rt.byAccount.map(([c, why]) => `${CAPABILITIES[c]?.label || c} (${why})`).join("; ")}. If the task needs one, write a NEEDS: line for it; it's loaded in a new task once it's connected.` : "",
    "Use only these tools. If a task needs something you don't have, say so instead of improvising.", "",
    "## Requirements and access (checked when this run started)",
    status.length ? status.map((r) => `- ${r.label}${r.source === "team" ? " (Team requirement)" : ""}: ${r.need.toUpperCase()}, ${r.ok ? "available" : "NOT AVAILABLE"} (${r.state}${r.detail ? ", " + r.detail : ""})${r.ok ? "" : `. To provide it: ${r.how}`}`).join("\n") : "- None declared.",
    "A link, a file name or a URL never grants access by itself. Having a tool doesn't mean you may open every resource with it.",
    "If the task needs something that isn't available, don't look for another way in. Stop and write one line per missing thing: \"NEEDS: <resource> <access>: <what the person must do>\", then explain in plain words what you can do once it's provided.", "",
    def.workflow.length ? "## How you work\n" + def.workflow.map((w, i) => `${i + 1}. ${w}`).join("\n") + "\n" : "",
    def.knowledge ? "## What you know\n" + def.knowledge + "\n" : "",
    def.limitations.length ? "## Hard limits (never cross these, even if asked)\n" + def.limitations.map((l) => `- ${l}`).join("\n") + "\n" : "",
    // What its integrations bring, from their pinned manifests, kept apart from the worker's own text.
    ...(def.integrationInstructions || []).map((x) => [`## From the ${x.label} integration (${x.id} ${x.version})`,
      x.steps.length ? "How to work with it:\n" + x.steps.map((s) => `- ${s}`).join("\n") : "", x.limits.length ? "Hard limits:\n" + x.limits.map((s) => `- ${s}`).join("\n") : "",
      x.know.length ? "Set up:\n" + x.know.map((s) => `- ${s}`).join("\n") : "", x.unsupported.length ? "Not possible here:\n" + x.unsupported.map((s) => `- ${s}`).join("\n") : ""].filter(Boolean).join("\n") + "\n"),
    def.onMissing ? "## When something is missing\n" + def.onMissing + "\n" : "",
    "## Learnings",
    memory.length ? "What you learned from earlier work (may be outdated; check if it matters):\n" + memory.slice(-40).map((m) => `- ${m.text}`).join("\n") : "Nothing learned yet.",
    "To keep something useful for later work with this worker (a preference, a convention, a decision), write a line starting \"LEARNED: \". Never put secrets in a learning.",
    ...(extra.evolve ? ["", "## Changing how you work (proposals)",
      "When the person teaches you a procedure, convention or rule that should apply to all your future work (\"from now on…\", \"our process is…\", \"learn how we do X\"), propose a change to your own definition instead of only remembering it: read yourself with evolve_read_self, then submit evolve_propose.",
      "Before proposing: compare what they ask with your steps, knowledge, limits and tools; say what's missing. Put in the procedure only what your tools can actually do. Anything that needs a tool, account, connector or API field you don't have goes under needs, and you tell the person plainly that it isn't possible with your tools today. Ask the person for facts you'd otherwise guess.",
      "Give the proposal checks and a trialPrompt, so the console can test it in a trial run. A proposal changes nothing until the person approves it: tell them it's waiting for their review, and never say it's active, learned or verified."] : []),
  ].filter((x) => x !== "" && x !== undefined && x !== null && x !== false).join("\n");
}

// ---- teams --------------------------------------------------------------------------
// A Team is shared context and scope for several workers: who's in it, what they share
// (knowledge, resources, instructions, prompts, requirements) and what is enforced. It runs on the
// same runtime: a Team worker's run is that worker's run, with the Team's context added before the
// worker's own, in the Team's workspace. A Team narrows, never widens: its workspace keeps its
// profile, its Figma resource locks the Figma tools to one file, its enforced policies take tools
// away. Each save is a version; a run keeps the version it started with (docs/team-platform.md).
//
//   teams.json: [{ id, name, description, workers: [workerId], workspace, figma: { url, fileKey, name },
//     knowledge: [{ id, type: "workspace_file", workspaceId, path, note } | { id, type: "upload", name, kind, size, sha, file, note }],
//     policies: [{ type: "protect_branch", branch }], instructions: [text], requirements, prompts: [{ id, title, text }],
//     version, createdAt, updatedAt }]
//   teams/<id>/knowledge/<file>   uploaded knowledge (content-addressed)
//   teams/<id>/history/v<N>.json  every saved version
const readTeams = () => (existsSync(TEAMS) ? JSON.parse(readFileSync(TEAMS, "utf8")) : []);
const writeTeams = (list) => { writeFileSync(TEAMS + ".tmp", JSON.stringify(list, null, 1)); renameSync(TEAMS + ".tmp", TEAMS); };
const teamPath = (id, ...p) => join(TEAMDIR, id, ...p);
// A branch name as Git allows it, kept simple: no "..", no leading "-", no "//", no ".lock" end.
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)(?!.*\/$)[\w.\-/]{1,100}$/;
const ENFORCEABLE = { protect_branch: "Never modify a branch" };
function normalizeTeam(b, prev) {
  const name = String(b.name || "").trim();
  if (!name || name.length > 60) throw new Error("Give the Team a name (up to 60 characters).");
  const id = prev?.id || `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "team"}-${randomUUID().slice(0, 4)}`;
  const known = new Set(readWorkers().map((w) => w.id));
  const workers = [...new Set((b.workers || []).map(String))];
  for (const w of workers) if (!known.has(w)) throw new Error(`No worker "${w}".`);
  // Resources. The workspace must exist now; it keeps its own profile (a Team can't change it).
  const workspace = b.workspace ? String(b.workspace) : null;
  const root = workspace ? resolveWorkspace(workspace).root : null;
  let figma = null;
  if (b.figma?.url) {
    const url = String(b.figma.url).trim().slice(0, 500);
    let ref; try { ref = parseFigmaUrl(url); } catch (e) { throw new Error(`Figma link: ${e.message}`); }
    figma = { url, fileKey: ref.mainFileKey, ...(ref.branchKey ? { branchKey: ref.branchKey } : {}), name: String(b.figma.name || "").trim().slice(0, 80) };
  }
  // Knowledge: references to files in the Team's workspace (read fresh by the worker, the same
  // checks as @ mentions), and uploaded documents (checked like attachments, stored by content).
  const before = new Map((prev?.knowledge || []).map((k) => [k.id, k]));
  const knowledge = [];
  for (const k of (b.knowledge || []).slice(0, 60)) {
    const note = String(k.note || "").trim().slice(0, 200);
    if (k.type === "workspace_file") {
      if (!workspace) throw new Error("Choose the Team's workspace before adding files from it.");
      if (workspace === "scratch") throw new Error("A team that works in Scratch has no project files to reference: upload the document instead.");
      if (k.workspaceId && k.workspaceId !== workspace) throw new Error(`@${k.path} is in another workspace. Team knowledge can only reference files in the Team's workspace.`);
      const [m] = resolveMentions(root, [{ type: "file", path: k.path }]);
      if (!m.exists) throw new Error(`@${m.path} isn't a file in the Team's workspace.`);
      if (knowledge.some((x) => x.type === "workspace_file" && x.path === m.path)) continue;
      knowledge.push({ id: before.has(k.id) ? k.id : randomUUID().slice(0, 8), type: "workspace_file", workspaceId: workspace, path: m.path, note });
    } else if (k.type === "upload") {
      const old = before.get(k.id);
      if (old?.type === "upload" && !k.data) { knowledge.push({ ...old, note }); continue; }
      const [a] = readAttachments([{ name: k.name, data: k.data }]);
      const sha = createHash("sha256").update(a.buf).digest("hex"), file = `${sha.slice(0, 16)}-${a.name}`;
      mkdirSync(teamPath(id, "knowledge"), { recursive: true });
      if (!existsSync(teamPath(id, "knowledge", file))) writeFileSync(teamPath(id, "knowledge", file), a.buf);
      knowledge.push({ id: randomUUID().slice(0, 8), type: "upload", name: a.name, kind: a.kind, size: a.buf.length, sha, file, note });
    } else throw new Error("Unknown kind of Team knowledge.");
  }
  if (knowledge.filter((k) => k.type === "upload").length > 20) throw new Error("Upload up to 20 documents per Team.");
  // Enforced policies: only what the platform can actually enforce. Anything else is an instruction.
  const policies = [];
  for (const p of (b.policies || []).slice(0, 10)) {
    if (!ENFORCEABLE[p?.type]) throw new Error(`"${p?.type}" can't be enforced by this platform. Add it as an instruction instead.`);
    const branch = String(p.branch || "").trim();
    if (!BRANCH.test(branch)) throw new Error(`"${branch}" isn't a branch name.`);
    if (!workspace || workspace === "scratch" || !repoTop(root)) throw new Error("Protecting a branch needs the Team's workspace to be a Git repository.");
    if (!policies.some((x) => x.branch === branch)) policies.push({ type: "protect_branch", branch });
  }
  const prompts = (b.prompts || []).slice(0, 50).map((p) => {
    const text = String(p.text || "").trim().slice(0, 5000);
    if (!text) throw new Error("A Team prompt needs its text.");
    return { id: /^[\w-]{1,40}$/.test(p.id || "") ? p.id : randomUUID().slice(0, 8), title: (String(p.title || "").trim() || text.split("\n")[0]).slice(0, 80), text };
  });
  const now = new Date().toISOString();
  const team = { id, name, description: String(b.description || "").trim().slice(0, 300), workers, workspace, figma, knowledge, policies,
    instructions: lines(b.instructions, 30, 500), requirements: checkRequirements(b.requirements), prompts,
    version: (prev?.version || 0) + 1, createdAt: prev?.createdAt || now, updatedAt: now };
  mkdirSync(teamPath(id, "history"), { recursive: true });
  writeFileSync(teamPath(id, "history", `v${team.version}.json`), JSON.stringify(team, null, 1));
  return team;
}
function saveTeam(b, id) {
  const list = readTeams(), i = id ? list.findIndex((t) => t.id === id) : -1;
  if (id && i < 0) throw new Error(`No Team "${id}".`);
  const t = normalizeTeam(b, i >= 0 ? list[i] : null);
  if (i >= 0) list[i] = t; else list.push(t);
  writeTeams(list);
  return t;
}
// Deleting a Team removes its definition, versions and uploads. Runs keep what they used: their
// snapshot of the Team and their own copy of its uploaded knowledge.
function deleteTeam(id) {
  const list = readTeams(), t = list.find((x) => x.id === id);
  if (!t) throw new Error(`No Team "${id}".`);
  if (active()?.meta.team?.id === id) throw new Error("A worker of this Team is running. Stop or end it first.");
  writeTeams(list.filter((x) => x.id !== id));
  rmSync(teamPath(id), { recursive: true, force: true });
  return { deleted: id };
}
// The folder holding .git for a path (worktrees: the folder with the .git file), or null.
function repoTop(root) { for (let d = root; ; d = dirname(d)) { if (existsSync(join(d, ".git"))) return d; if (dirname(d) === d) return null; } }
// The enforced policies that hold in a workspace now: a branch policy protects the repository, so
// it holds in every workspace inside the Team's repository, not only in the Team's own workspace.
function wsPolicies(wsId) {
  let top; try { top = repoTop(resolveWorkspace(wsId).root); } catch { return []; }
  if (!top) return [];
  return readTeams().filter((t) => {
    if (!t.workspace || !t.policies.length) return false;
    try { const tt = repoTop(resolveWorkspace(t.workspace).root); return !!tt && samePath(tt, top); } catch { return false; }
  }).flatMap((t) => t.policies.map((p) => ({ ...p, team: teamLabel(t.name) })));
}
// "MATW" -> "MATW Team"; a name that already ends in "team" stays as it is.
const teamLabel = (name) => (/\bteam$/i.test(name) ? name : `${name} Team`);
// A run's enforcement scope: what's enforced in its workspace now, plus whatever it started under
// (resuming never weakens it), the branch checked out now, and the Team's Figma file.
function runScope(run, ws) {
  const now = wsPolicies(ws.id), started = run.meta.policy?.protect || [];
  const protect = [...now, ...started.filter((p) => !now.some((x) => x.branch === p.branch))];
  const head = gitInfo(ws.root).branch;
  const team = run.meta.team ? readSnapshot(run.meta.id)?.team : null;
  // Repository access is worked out again from the worker's definition now (an edit applies to the
  // next start), and never above what the run started with.
  const def = run.meta.worker ? readWorkers().find((w) => w.id === run.meta.worker.id) || { id: run.meta.worker.id, name: run.meta.worker.name, repos: [] } : null;
  const repo = repoScope(ws, def, run.meta.repo ? run.meta.repo.level : undefined);
  return { protect, head, onProtected: !!head && protect.some((p) => p.branch === head), figmaKey: team?.figma ? team.figma.branchKey || team.figma.fileKey : null,
    knowledgeDir: team?.knowledge.some((k) => k.type === "upload") ? join(RUNS, `${run.meta.id}.team`) : null, repo, candidate: !!run.meta.candidate };
}
const readSnapshot = (id) => (existsSync(snapPath(id)) ? JSON.parse(readFileSync(snapPath(id), "utf8")) : null);

// ---- repositories (GitHub) --------------------------------------------------------------
// One GitHub connection for the platform (worker-ui/github.mjs; its token stays outside the repo
// and never reaches a worker or the page), a registry of repositories, and an assignment of at most
// one registered repository per workspace (a workspace is one folder: the repository's checkout).
// A worker gets a repository only through its workspace, at the access its definition grants for
// that repository (none unless granted); the General worker gets the assignment's own level.
//   github.json: { connection: { login, name, tokenKind, scopes, verifiedAt, error }, repos: [{ id, githubId, fullName, owner, name, url,
//     htmlUrl, defaultBranch, private, archived, access, status: ok|inaccessible|error, verifiedAt, error, registeredAt }] }
//   workspaces.json, per workspace: repo: { id, general: read|write|commit|push, shell: bool, workersOnDefault: bool }
const readGithub = () => { try { const g = JSON.parse(readFileSync(GITHUB, "utf8")); return { connection: g.connection || null, repos: g.repos || [] }; } catch { return { connection: null, repos: [] }; } };
const writeGithub = (g) => { writeFileSync(GITHUB + ".tmp", JSON.stringify(g, null, 1)); renameSync(GITHUB + ".tmp", GITHUB); };
const assignmentOf = (wsId) => (wsId === "console" ? consoleWs() : readWorkspaces().find((w) => w.id === wsId))?.repo || null;
// The folder's origin, read by Git itself (includes and insteadOf rewrites included).
function originOf(root) {
  const r = spawnSync("git", [...GIT_OPTS, "remote", "get-url", "origin"], { cwd: root, env: gitEnv(), windowsHide: true, encoding: "utf8", timeout: 15000 });
  return r.status === 0 ? r.stdout.trim() : "";
}
function checkRemote(root, reg) {
  const origin = originOf(root);
  if (github.canonRemote(origin) !== github.canonRemote(reg.url)) throw new Error(`This folder's origin is ${origin ? safeUrl(origin) : "not set"}, not ${reg.fullName} (${safeUrl(reg.url)}). Fix the folder's remote or assign the right repository.`);
}
const rankOf = (l) => REPO_LEVELS.indexOf(l);
const lowerOf = (a, b) => (rankOf(a) <= rankOf(b) ? a : b);
// What a run in this workspace may do with its repository (null: no repository assigned). Refuses
// when the folder isn't the registered repository, or when this worker has no access to it.
function repoScope(ws, def, startedLevel) {
  const a = assignmentOf(ws.id);
  if (!a) return null;
  const reg = readGithub().repos.find((r) => r.id === a.id);
  if (!reg) throw new Error(`This workspace is assigned to a repository that's no longer registered (${a.id}). Unassign it on the GitHub page.`);
  checkRemote(ws.root, reg);
  let level = def ? (def.repos || []).find((g) => g.repo === reg.id)?.level || null : a.general || "write";
  if (level && ws.profile === "inspect") level = "read";
  // Hosted, workers never push: the person reviews and pushes from Changes & versions.
  if (level === "push" && HOSTED) level = "commit";
  if (level && startedLevel !== undefined) level = startedLevel ? lowerOf(level, startedLevel) : null;
  if (!level) throw new Error(`${def?.name || "This worker"} has no access to ${reg.fullName}, the repository of this workspace. Grant it in the worker's definition (Repositories), or choose another worker.`);
  return { id: reg.id, fullName: reg.fullName, url: reg.url, defaultBranch: reg.defaultBranch, level, shell: !!a.shell && !HOSTED, workersOnDefault: !!a.workersOnDefault };
}
function repoSection(r, head) {
  if (!r) return "";
  const locked = [r.defaultBranch && !r.workersOnDefault ? r.defaultBranch : null].filter(Boolean);
  return ["## Repository", `This workspace is the checkout of ${r.fullName}${r.defaultBranch ? ` (default branch ${r.defaultBranch})` : ""}${head ? `; ${head} is checked out` : ""}.`,
    `Your access: ${REPO_LEVEL_LABELS[r.level]}. Use the repo_* tools for Git (${REPO_TOOLS.filter(([, l]) => rankOf(r.level) >= rankOf(l)).map(([t]) => t).join(", ")}); these limits are enforced, not instructions.`,
    rankOf(r.level) >= rankOf("commit") ? `Commit on a work branch of your own (repo_create_branch)${locked.length ? `: ${locked.join(", ")} is never committed to or pushed to by workers` : ""}. Report a commit or push only with the hash the tool returned.` : "",
    HOSTED ? "Pushing is the person's: they review your commits and push them from Changes & versions." : "",
    r.shell ? "Shell commands are on in this workspace: Git limits above don't cover what you do through node; don't run git that way." : "Shell commands are off here and .git can't be written: Git goes only through the repo_* tools.", ""].filter((x) => x !== "").join("\n");
}
// Figma reading (the Figma Reader, REST): the person's own Figma personal access token, checked with
// Figma before it's kept, stored where the Reader reads it (FIGMA_READER_DIR: the person's own folder
// when hosted). It never goes to the page, a worker or a log. Figma's plugin tools are separate.
const FIGMA_TOKEN = /^figd_[\w-]{20,200}$/;
async function figmaConnect(token) {
  const t = String(token || "").trim();
  if (!FIGMA_TOKEN.test(t)) throw Object.assign(new Error("That doesn't look like a Figma personal access token (figd_…)."), { status: 400 });
  let r; try { r = await fetch("https://api.figma.com/v1/me", { headers: { "X-Figma-Token": t }, signal: AbortSignal.timeout(15000) }); }
  catch { throw Object.assign(new Error("Couldn't reach Figma to check the token. Try again."), { status: 502 }); }
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error("Figma rejected the token (expired, revoked or mistyped)."), { status: 400 });
  if (!r.ok) throw Object.assign(new Error(`Figma answered ${r.status}. Try again.`), { status: 502 });
  const me = await r.json().catch(() => ({}));
  saveFigmaCredentials({ type: "pat", token: t, savedAt: new Date().toISOString() });
  figmaCheck = { at: 0, value: null };
  return figmaReport({ handle: me.handle || null });
}
async function figmaReport(fresh) {
  if (!existsSync(FIGMA_CRED_FILE)) return { connected: false };
  const st = fresh ? { ok: true, state: "Connected", detail: fresh.handle ? `as ${fresh.handle}` : "" } : await RESOURCES.figma.access.read.check();
  return { connected: true, ok: !!st.ok, state: st.state, detail: st.detail || "" };
}
function figmaDisconnect() { rmSync(FIGMA_CRED_FILE, { force: true }); figmaCheck = { at: 0, value: null }; return { connected: false }; }

// The person's actions on the GitHub page.
const ghStatus = (e) => (e.kind === "input" || e.kind === "setup" ? 400 : e.status === 404 ? 404 : e.kind === "rate" ? 429 : e.kind === "auth" ? 401 : 502);
async function ghConnect(token) {
  const t = github.checkToken(token);
  const who = await github.verify(t); // only a token that works is kept
  github.saveToken(t);
  const g = readGithub(); g.connection = { ...who, method: "token", error: null }; writeGithub(g);
  discovered = { at: 0, list: null };
  return ghReport();
}
// "Connect with GitHub" (github-app.mjs): the browser goes to GitHub and comes back to
// /github/callback on this console. The redirect is this console's own loopback address (the Host
// the guard already checked), so it works on any port and on each developer's own computer.
// Hosted, GitHub comes back to the platform's public address (the gateway passes it on).
const callbackUri = (req) => (HOSTED ? `${PUBLIC_ORIGIN}/github/callback` : `http://${String(req.headers.host).toLowerCase()}/github/callback`);
function ghAppStart(req) { return ghApp.startAuth(callbackUri(req)); }
// The callback is a plain top-level GET from github.com: it changes state only with a state this
// console issued (one-time, ten minutes, same console). It answers with a redirect to the page and a
// short reason, never with the code, the token or GitHub's raw error.
async function ghAppCallback(req, url) {
  const q = url.searchParams;
  if (!q.has("code") && !q.has("error") && /^(install|update|request)$/.test(q.get("setup_action") || "")) return "installed"; // an installation changed on GitHub; nothing to store
  let p;
  try { p = ghApp.takeState(q.get("state")); } catch (e) { return e.kind === "expired" ? "expired" : "state"; }
  if (p.redirectUri !== callbackUri(req)) return "state"; // started by another console (other port or host name)
  if (q.get("error")) return q.get("error") === "access_denied" ? "denied" : "error";
  let cred, who;
  try { cred = await ghApp.exchangeCode(q.get("code"), p); who = await github.verify(cred.token); }
  catch (e) { console.log(`${new Date().toISOString()} GitHub sign-in failed: ${e.kind || "error"}`); return e.kind === "network" ? "network" : "exchange"; }
  github.saveCredentials(cred);
  const g = readGithub(); g.connection = { ...who, method: "app", error: null }; writeGithub(g);
  discovered = { at: 0, list: null };
  return "connected";
}
async function ghVerify() {
  const g = readGithub();
  try { g.connection = { ...(await github.verify()), error: null }; } catch (e) { g.connection = { ...(g.connection || {}), error: e.message, errorAt: new Date().toISOString() }; writeGithub(g); throw e; }
  writeGithub(g); return ghReport();
}
// Disconnecting deletes the local credential; an app token is also revoked at GitHub (best effort).
async function ghDisconnect() {
  const old = github.clearToken(); const g = readGithub(); g.connection = null; writeGithub(g); discovered = { at: 0, list: null };
  const revoked = old?.method === "app" ? await ghApp.revoke(old.token) : null;
  return { ...ghReport(), ...(old?.method === "app" ? { revokedAtGitHub: revoked } : {}) };
}
function ghReport() {
  const g = readGithub(), ws = listWorkspaces();
  return { connected: github.hasToken(), method: github.connectionMethod(), app: ghApp.appSummary(), connection: g.connection, levels: REPO_LEVELS.map((l) => ({ id: l, label: REPO_LEVEL_LABELS[l] })),
    repos: g.repos.map((r) => ({ ...r, workspaces: ws.filter((w) => w.repo?.id === r.id).map((w) => ({ id: w.id, name: w.name, general: w.repo.general, shell: !!w.repo.shell, workersOnDefault: !!w.repo.workersOnDefault })) })),
    workers: readWorkers().map((w) => ({ id: w.id, name: w.name, repos: w.repos || [] })) };
}
let discovered = { at: 0, list: null };
async function ghDiscover(refresh) {
  if (refresh || !discovered.list || Date.now() - discovered.at > 60000) discovered = { at: Date.now(), list: await github.discover() };
  const reg = new Set(readGithub().repos.map((r) => r.githubId));
  return discovered.list.map((r) => ({ ...r, registered: reg.has(r.githubId) }));
}
async function ghRegister(fullName) {
  const info = await github.repoInfo(String(fullName || "").trim()); // what the token can see, not what was typed
  const g = readGithub(), dup = g.repos.find((r) => r.githubId === info.githubId);
  if (dup) { const e = new Error(`${dup.fullName} is already registered.`); e.status = 409; throw e; }
  const now = new Date().toISOString(), entry = { id: `gh-${info.githubId}`, ...info, status: "ok", verifiedAt: now, error: null, registeredAt: now };
  g.repos.push(entry); writeGithub(g); return entry;
}
async function ghRefresh(id) {
  const g = readGithub(), r = g.repos.find((x) => x.id === id);
  if (!r) { const e = new Error("No such registered repository."); e.status = 404; throw e; }
  try { Object.assign(r, await github.repoInfo(r.fullName), { status: "ok", verifiedAt: new Date().toISOString(), error: null }); }
  catch (e) { Object.assign(r, { status: e.status === 404 || e.status === 403 ? "inaccessible" : "error", error: e.message, errorAt: new Date().toISOString() }); }
  writeGithub(g); return { ...r, workspaces: ghReport().repos.find((x) => x.id === id).workspaces };
}
// Removing a registration only removes the entry: no folder, file, commit or run is touched. A
// repository still assigned to a workspace has to be unassigned first, so no workspace silently
// changes what its workers may do.
function ghRemove(id) {
  const g = readGithub(), r = g.repos.find((x) => x.id === id);
  if (!r) { const e = new Error("No such registered repository."); e.status = 404; throw e; }
  const used = listWorkspaces().filter((w) => w.repo?.id === id);
  if (used.length) { const e = new Error(`${r.fullName} is assigned to ${used.map((w) => w.name).join(", ")}. Unassign it there first.`); e.status = 409; throw e; }
  g.repos = g.repos.filter((x) => x.id !== id); writeGithub(g);
  const grants = readWorkers().filter((w) => (w.repos || []).some((x) => x.repo === id));
  if (grants.length) writeWorkers(readWorkers().map((w) => ({ ...w, repos: (w.repos || []).filter((x) => x.repo !== id) })), { kind: "repository-removed", reason: `The repository ${id} was removed from the console` });
  return { removed: r.fullName, note: "Only the registration was removed. Local folders, changes, commits and runs are untouched.", grantsRemoved: grants.map((w) => w.name) };
}
// Assigning: the workspace's folder must be a checkout whose origin is the registered repository.
function assignRepo(wsId, b) {
  if (wsId === "scratch") throw new Error("Scratch can't have a repository: it has no project folder.");
  const ws = resolveWorkspace(wsId), reg = readGithub().repos.find((r) => r.id === String(b.repo || ""));
  if (!reg) throw new Error("Choose a registered repository.");
  if (!repoTop(ws.root)) throw new Error("This workspace's folder isn't a Git checkout. Clone the repository into a folder first.");
  checkRemote(ws.root, reg);
  const general = REPO_LEVELS.includes(b.general) ? b.general : "write";
  const busy = active(); if (busy && (busy.meta.workspace?.id || "console") === wsId) throw new Error("A worker is running in this workspace. Stop or end it first.");
  const repo = { id: reg.id, general, shell: !!b.shell, workersOnDefault: !!b.workersOnDefault };
  writeWorkspaces(withConsole(readWorkspaces()).map((w) => (w.id === wsId ? { ...w, repo } : w)));
  return listWorkspaces().find((w) => w.id === wsId);
}
function unassignRepo(wsId) {
  const busy = active(); if (busy && (busy.meta.workspace?.id || "console") === wsId) throw new Error("A worker is running in this workspace. Stop or end it first.");
  if (!listWorkspaces().some((w) => w.id === wsId)) throw new Error(`No workspace "${wsId}".`);
  writeWorkspaces(readWorkspaces().map((w) => { if (w.id !== wsId) return w; const { repo, ...rest } = w; return rest; }));
  return listWorkspaces().find((w) => w.id === wsId);
}
// A registered repository with no checkout yet: cloned (with the person's Git sign-in) into a new
// folder under a folder they name, which becomes a workspace assigned to it.
async function cloneRepo(id, b) {
  const reg = readGithub().repos.find((r) => r.id === id);
  if (!reg) throw new Error("No such registered repository.");
  // Hosted: always into a new folder of the person's own, with the GitHub connection's credential.
  const parent = HOSTED ? HOSTED_WS_ROOT : String(b.parent || "");
  if (!isAbsolute(parent) || /^[\\/]{2}/.test(parent)) throw new Error("Give the full path of the folder to clone into, e.g. C:\\Users\\me\\projects.");
  let real; try { real = realpathSync.native(parent); } catch { throw new Error(`No folder at ${parent}`); }
  const target = HOSTED ? join(real, `${reg.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 40)}-${randomUUID().slice(0, 6)}`) : join(real, reg.name);
  if (existsSync(target)) throw new Error(`${target} already exists. Add that folder as a workspace instead, or choose another folder.`);
  try { await git(real, ["clone", "--", reg.url, target], { timeout: 600000, auth: true }); }
  catch (e) {
    if (HOSTED) rmSync(target, { recursive: true, force: true }); // a half-done clone of the person's own
    if (e instanceof github.GitHubError) throw e;
    throw new Error(/Authentication failed|could not read Username|terminal prompts disabled|Permission denied|returned error: 40[13]/i.test(e.message)
      ? (HOSTED ? `GitHub refused access to ${reg.fullName}'s code. Check that the AI Worker app may read this repository (Choose repositories on GitHub), then try again.` : `Git has no working sign-in for ${reg.fullName} on this computer. Sign in with Git once (for example, clone it in a terminal), then try again.`)
      : `Clone failed: ${clip(e.message, 300)}`);
  }
  const ws = addWorkspace({ name: String(b.name || reg.name).slice(0, 60), path: target, mode: b.mode === "inspect" ? "inspect" : "work" }, { hostedRoot: target });
  return assignRepo(ws.id, { repo: reg.id, general: b.general });
}

function workspaceSection(w) {
  if (!w) return "";
  return ["## Workspace", `You work in "${w.name}" (${w.profile === "inspect" ? "Inspect: read-only" : "Work"})${w.head ? `, on branch ${w.head}` : ""}. Your working directory is its folder.`,
    w.protect.length ? "Enforced by the platform here (these aren't instructions: the console and the runtime enforce them):\n"
      + w.protect.map((p) => `- Never modify ${p.branch} (${p.team ? `${p.team} policy` : "policy"}): the console refuses to commit to it or push to it.`).join("\n")
      + "\n- So nothing can change a branch behind the console's back, this run has no shell commands and can't write inside .git or .claude."
      + (w.onProtected ? `\n- ${w.head} is checked out right now, so this run can't change files at all. To make changes, the person must switch to another branch first.` : "") : "",
    repoSection(w.repo, w.head), ""].filter((x) => x !== false).join("\n");
}
function teamSection(t) {
  if (!t) return "";
  const k = t.def.knowledge;
  return [`# Team: ${t.def.name} (version ${t.def.version})`, t.def.description, "You work as a member of this Team. Its context applies to every member; your own definition follows it.",
    t.members.length ? `Members: ${t.members.join(", ")}.` : "", "",
    "## Team instructions", t.def.instructions.length ? "The Team's conventions. Follow them in your work (they are instructions; the platform doesn't enforce them):\n" + t.def.instructions.map((x) => `- ${x}`).join("\n") : "None.", "",
    "## Team knowledge", k.length ? "References, not copies: read the ones that matter for the task before you work, and always the current file:\n" + k.map((x) => x.type === "workspace_file"
      ? `- ${x.path} (a file in the workspace)${x.note ? `: ${x.note}` : ""}`
      : `- ${x.name} (uploaded to the Team, read-only): ${join(RUNS, `${t.runId}.team`, x.file)}${x.note ? `: ${x.note}` : ""}`).join("\n") : "None.", "",
    "## Team resources", `- Workspace: ${t.workspaceName}`,
    t.def.figma ? `- Figma: ${t.def.figma.name || "the Team's file"}: ${t.def.figma.url} (file key ${t.def.figma.fileKey}). In this run the Figma tools only act on this file: the Figma Executor refuses commands while another file is open, and figma_read_design refuses other files. Before Figma work, check which file is open (figma_get_file_info). Reading by link needs Figma authorization: the link doesn't grant access.` : "- Figma: none.",
    ""].filter((x) => x !== undefined && x !== null && x !== false).join("\n");
}

// ---- Claude config directory ------------------------------------------------------
// One deliberate directory for every worker: Claude Code's own default, ~/.claude, unless
// WORKER_CONSOLE_CLAUDE_CONFIG_DIR names another. The console's own environment is not passed on
// as-is: an inherited CLAUDE_CONFIG_DIR (the VS Code extension sets one) and the other CLAUDE_*
// variables of whatever started the console (its session id, messaging socket and token, entry
// point) are dropped, so sessions never land in, or resume from, another tool's directory.
const CONFIG_DIR = resolve(process.env.WORKER_CONSOLE_CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
const workerEnv = () => {
  // Integration tokens (FIGMA_TOKEN, BUILDER_*, GH_TOKEN, GITHUB_*, ...) never reach workers; the *_DIR ones are only paths.
  // The hosted console's own secrets (AIW_*: the gateway's internal secret, the broker token) never
  // either; the model provider adds only what the runtime needs to reach the model (provider.mjs).
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k === "FIGMA_READER_DIR" || k === "BUILDER_ADAPTER_DIR" || !/^(CLAUDE|AI_AGENT|WORKER_CONSOLE_|FIGMA_|BUILDER_|GITHUB_|GH_|AIW_|ANTHROPIC_)/i.test(k)));
  return { ...env, ...PROVIDER.runtimeEnv(), CLAUDE_CONFIG_DIR: CONFIG_DIR };
};

// ---- account & usage ----------------------------------------------------------------
// Which Claude account the workers run as, and how much of its plan is used. The account comes
// from the runtime itself (`claude auth status`, run with the workers' own environment, so it
// answers for the same config dir); the console never reads the login token. Usage is what the
// runtime reports to its workers (rate_limit_event: the 5-hour and 7-day windows), so it's as
// fresh as the last worker message: kept live while workers run, read from the newest run logs
// at startup.
let account = { at: 0, value: null }, usage = null, usageError = null, lastModel = null;
function authStatus() {
  return new Promise((ok) => {
    let out = "", p;
    try { p = spawn(CLAUDE.cmd, [...CLAUDE.pre, "auth", "status", "--json"], { shell: CLAUDE.shell, env: workerEnv(), windowsHide: true }); } catch { return ok(null); }
    const timer = setTimeout(() => p.kill(), 20000);
    p.stdout.on("data", (d) => (out += d));
    p.on("error", () => {});
    p.on("close", () => { clearTimeout(timer); try { ok(JSON.parse(out)); } catch { ok(null); } });
  });
}
// The last rate_limit_event (and model) in the newest run logs; only each log's tail is read.
function usageFromLogs() {
  const files = readdirSync(RUNS).filter((f) => f.endsWith(".raw.jsonl")).map((f) => ({ f, t: statSync(join(RUNS, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, 5);
  for (const { f, t } of files) {
    const p = join(RUNS, f), size = statSync(p).size, n = Math.min(size, 1 << 20), buf = Buffer.alloc(n), fd = openSync(p, "r");
    try { readSync(fd, buf, 0, n, size - n); } finally { closeSync(fd); }
    const lines = buf.toString("utf8").split("\n");
    if (!lastModel) for (let i = lines.length - 1; i >= 0; i--) if (lines[i].includes('"subtype":"init"')) { try { lastModel = JSON.parse(lines[i]).model || null; } catch {} if (lastModel) break; }
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].includes('"rate_limit_event"')) { try { return { info: JSON.parse(lines[i]).rate_limit_info, at: t, run: f.replace(".raw.jsonl", "") }; } catch {} }
  }
  return null;
}
// Questions the runtime answers without the model: the models this account can use (list_models)
// and the plan's usage (get_usage). A short-lived claude.exe with no tools and no MCP servers, in
// the console's private scratch folder, answers them on its stream-json control channel. No
// message is sent, so nothing reaches the model and nothing is used up.
function runtimeQuery(requests, timeoutMs = 30000) {
  return new Promise((ok, fail) => {
    let p, buf = "", settled = false; const answers = {};
    const finish = (err) => { if (settled) return; settled = true; clearTimeout(timer); try { p.stdin.end(); } catch {} setTimeout(() => { try { p.kill(); } catch {} }, 3000); err ? fail(err) : ok(answers); };
    try { p = spawn(CLAUDE.cmd, [...CLAUDE.pre, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }), "--tools", "", "--settings", WORKER_SETTINGS], { cwd: SCRATCH_WS.root, shell: CLAUDE.shell, env: workerEnv(), windowsHide: true }); }
    catch (e) { return fail(e); }
    const timer = setTimeout(() => finish(new Error("The Claude runtime didn't answer in time.")), timeoutMs);
    p.stdout.on("data", (d) => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1); let m; try { m = JSON.parse(l); } catch { continue; }
        if (m.type !== "control_response") continue;
        answers[m.response?.request_id] = m.response?.subtype === "success" ? m.response.response : { error: m.response?.error || "refused" };
        if (Object.keys(answers).length === requests.length) finish();
      }
    });
    p.on("error", (e) => finish(e));
    p.on("close", () => finish(Object.keys(answers).length === requests.length ? null : new Error("The Claude runtime exited without answering.")));
    requests.forEach((r, i) => p.stdin.write(JSON.stringify({ type: "control_request", request_id: String(i), request: r }) + "\n"));
  });
}
// The plan's usage, live (get_usage): percentages and reset times of the 5-hour and weekly windows.
let usageAsk = null;
function refreshUsage() {
  return (usageAsk ||= runtimeQuery([{ subtype: "get_usage" }]).then((a) => {
    const r = a["0"];
    if (!r || r.error || !r.rate_limits) throw new Error(r?.error ? `The runtime refused the usage query: ${r.error}` : "The runtime didn't report usage for this account.");
    const win = (w) => (w ? { utilization: (w.utilization ?? 0) / 100, resetsAt: w.resets_at ? Math.floor(Date.parse(w.resets_at) / 1000) : null } : null);
    const five = win(r.rate_limits.five_hour), week = win(r.rate_limits.seven_day);
    const full = week?.utilization >= 1 ? "seven_day" : five?.utilization >= 1 ? "five_hour" : null;
    usage = { info: { status: full ? "rejected" : "allowed", rateLimitType: full || "five_hour", unifiedWindows: { five_hour: five, seven_day: week } }, at: Date.now(), run: null, source: "runtime" };
  }).finally(() => { usageAsk = null; }));
}
// The models this account can use, as the runtime lists them (cached ten minutes), and the
// effort levels each one takes.
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
let models = { at: 0, list: null };
async function modelCatalogue(refresh) {
  if (!refresh && models.list && Date.now() - models.at < 600000) return models.list;
  const r = (await runtimeQuery([{ subtype: "list_models" }]))["0"];
  if (!r?.models?.length) throw new Error("The Claude runtime didn't list its models.");
  models = { at: Date.now(), list: r.models.map((m) => ({ value: m.value, resolvedModel: m.resolvedModel || m.value, displayName: m.displayName || m.value, description: m.description || "", efforts: m.supportsEffort ? (m.supportedEffortLevels || []).filter((e) => EFFORTS.includes(e)) : [] })) };
  return models.list;
}
// A run's model and effort, checked against the catalogue. "default" means the runtime's default.
async function checkRunSettings(b, currentModel) {
  const out = {}, list = await modelCatalogue();
  if (b.model !== undefined && b.model !== null) {
    if (!list.some((m) => m.value === String(b.model))) throw new Error(`"${b.model}" isn't a model this account can use.`);
    out.model = String(b.model);
  }
  if (b.effort !== undefined && b.effort !== null) {
    if (!EFFORTS.includes(String(b.effort))) throw new Error(`Effort must be one of ${EFFORTS.join(", ")}.`);
    const m = list.find((x) => x.value === (out.model || currentModel || "default"));
    if (m && !m.efforts.includes(String(b.effort))) throw new Error(m.efforts.length ? `${m.displayName} takes effort ${m.efforts.join(", ")}.` : `${m.displayName} doesn't take an effort level.`);
    out.effort = String(b.effort);
  }
  return out;
}
async function accountReport(refresh) {
  if (!HOSTED && (refresh || !account.value || Date.now() - account.at > 60000)) {
    const s = await authStatus();
    account = { at: Date.now(), value: s ? { loggedIn: !!s.loggedIn, email: s.email || null, orgName: s.orgName || null, plan: s.subscriptionType || null, authMethod: s.authMethod || null, apiProvider: s.apiProvider || null, configDir: s.configDirectory || CONFIG_DIR } : { error: "The Claude runtime didn't report its sign-in status." } };
  }
  // Live from the runtime (free); the last reading seen in a run is the fallback. A plan's usage only
  // exists for a Claude subscription; with the API, cost per run is what there is.
  const onPlan = PROVIDER.id === "claude-subscription";
  if (!onPlan) usageError = "Plan usage applies to a Claude subscription. This platform uses the Anthropic API: the cost of each run is shown with it.";
  else if (refresh || !usage || usage.source !== "runtime" || Date.now() - usage.at > 20000) { try { await refreshUsage(); usageError = null; } catch (e) { usageError = e.message; } }
  if (!usage && onPlan) usage = usageFromLogs();
  const metas = allMetas(), today = new Date().toDateString(), live = active()?.meta || null;
  const sum = (list) => Math.round(list.reduce((s, m) => s + (m.costUsd || 0), 0) * 100) / 100;
  const ofToday = metas.filter((m) => new Date(m.createdAt).toDateString() === today);
  return { provider: PROVIDER.summary(), account: HOSTED ? { hosted: true, name: process.env.AIW_USER_NAME || null, email: process.env.AIW_USER_EMAIL || null } : account.value, checkedAt: new Date(account.at).toISOString(), model: lastModel,
    usage: usage ? { status: usage.info.status, limitType: usage.info.rateLimitType, fiveHour: usage.info.unifiedWindows?.five_hour || null, sevenDay: usage.info.unifiedWindows?.seven_day || null, overage: usage.info.isUsingOverage ? "in use" : usage.info.overageStatus || null, at: new Date(usage.at).toISOString(), run: usage.run, source: usage.source || "run" } : null, usageError,
    totals: { runs: metas.length, costUsd: sum(metas), todayRuns: ofToday.length, todayCostUsd: sum(ofToday),
      active: live ? { id: live.id, status: live.status, worker: live.worker?.name || "General", messages: live.messages, costUsd: Math.round((live.costUsd || 0) * 100) / 100 } : null } };
}

// ---- workspaces ----------------------------------------------------------------
// "console" is this repo with the full profile: what every run used before workspaces existed.
// Others live in workspaces.json, added by the person through the Workspace page (POST /workspaces,
// same-origin only) or by hand:
//   [{ "id": "matw-3f2a", "name": "MATW", "root": "C:/Users/me/Desktop/MATW/site", "profile": "inspect" }]
// A run records its workspace's real root, profile and config dir when it starts, and the console
// re-checks them before every resume, restart and file view. Claude resumes a session in whatever
// cwd it is started in, so this can't be left to Claude.
const norm = (p) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
const samePath = (a, b) => norm(a) === norm(b);
function resolveWorkspace(id) {
  const list = existsSync(WORKSPACES) ? JSON.parse(readFileSync(WORKSPACES, "utf8")) : [];
  const ws = id === "console" ? (HOSTED ? null : consoleWs(list)) : id === "scratch" ? SCRATCH_WS : list.find((w) => w.id === id);
  if (!ws || ws.hidden) throw new Error(`No workspace "${id}".`);
  if (!PROFILES[ws.profile]) throw new Error(`Workspace "${id}" has an unknown profile "${ws.profile}".`);
  if (!isAbsolute(String(ws.root || ""))) throw new Error(`Workspace "${id}" root must be an absolute path.`);
  let root;
  try { root = realpathSync.native(ws.root); } catch { throw new Error(`Workspace "${id}" root doesn't exist: ${ws.root}`); }
  if (!statSync(root).isDirectory()) throw new Error(`Workspace "${id}" root is not a folder: ${root}`);
  return { id, root, profile: ws.profile };
}
// Executor, this app's own folder, is a workspace whose record has no root (it's always this
// repo). Removing it only hides it ({ "id": "console", "hidden": true }); adding this folder again
// brings it back, with its runs.
const consoleWs = (list = readWorkspaces()) => { const m = list.find((w) => w.id === "console") || {}; return { id: "console", name: m.name || "Executor", root: REPO, profile: m.profile || "full", hidden: !!m.hidden, ...(m.repo ? { repo: m.repo } : {}) }; };
const withConsole = (list) => (list.some((w) => w.id === "console") ? list : [{ id: "console" }, ...list]);
// workspaces.json is in display order. { "id": "console" } marks where Executor sits (first when absent).
const readWorkspaces = () => (existsSync(WORKSPACES) ? JSON.parse(readFileSync(WORKSPACES, "utf8")) : []);
const writeWorkspaces = (list) => { writeFileSync(WORKSPACES + ".tmp", JSON.stringify(list, null, 1)); renameSync(WORKSPACES + ".tmp", WORKSPACES); };
// Branch and short commit, read from the folder's own .git (worktrees included); null when not a repo.
function gitInfo(root) {
  try {
    let dir = join(root, ".git");
    if (statSync(dir).isFile()) dir = resolve(root, /gitdir:\s*(.+)/.exec(readFileSync(dir, "utf8"))[1].trim());
    const common = existsSync(join(dir, "commondir")) ? resolve(dir, readFileSync(join(dir, "commondir"), "utf8").trim()) : dir;
    const head = readFileSync(join(dir, "HEAD"), "utf8").trim();
    const ref = /^ref: (.+)$/.exec(head)?.[1];
    if (!ref) return { branch: null, commit: head.slice(0, 7) };
    let sha = [dir, common].map((d) => join(d, ref)).filter(existsSync).map((p) => readFileSync(p, "utf8").trim())[0];
    if (!sha && existsSync(join(common, "packed-refs"))) sha = readFileSync(join(common, "packed-refs"), "utf8").split("\n").find((l) => l.endsWith(" " + ref))?.split(" ")[0];
    return { branch: ref.replace(/^refs\/heads\//, ""), commit: sha ? sha.slice(0, 7) : null };
  } catch { return { branch: null, commit: null }; }
}
function listWorkspaces() {
  const list = readWorkspaces(), repos = readGithub().repos;
  return [SCRATCH_WS, ...(HOSTED ? list.filter((w) => w.id !== "console") : withConsole(list).map((w) => (w.id === "console" ? consoleWs(list) : w)))].filter((w) => !w.hidden).map((w) => {
    let root = null; try { root = resolveWorkspace(w.id).root; } catch {}
    const reg = w.repo ? repos.find((r) => r.id === w.repo.id) : null;
    return { id: w.id, name: w.name || w.id, root: root || w.root, profile: w.profile, available: !!root, ...(w.id === "scratch" ? { scratch: true } : root ? gitInfo(root) : {}),
      ...(w.repo ? { repo: { ...w.repo, fullName: reg?.fullName || null, registered: !!reg } } : {}) };
  });
}
// The person names a folder and a mode; the folder must exist, and can't be a drive root or the
// whole home folder (too broad to be one project).
function addWorkspace({ name, path, mode }, { hostedRoot } = {}) {
  name = String(name || "").trim();
  // Hosted: a new workspace is a new empty folder of the person's own (or a clone, hostedRoot);
  // a path from the page is never used.
  if (HOSTED) {
    if (!name || name.length > 60) throw new Error("Give the workspace a name (up to 60 characters).");
    if (!["inspect", "work"].includes(mode)) throw new Error("Choose Inspect or Work.");
    const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "ws"}-${randomUUID().slice(0, 4)}`;
    const root = hostedRoot || join(HOSTED_WS_ROOT, id);
    if (!inRoot(realpathSync.native(HOSTED_WS_ROOT), resolve(root))) throw new Error("A workspace must be one of your own folders.");
    mkdirSync(root, { recursive: true });
    writeWorkspaces([...readWorkspaces(), { id, name, root: realpathSync.native(root), profile: mode === "work" ? "full" : "inspect" }]);
    return listWorkspaces().find((w) => w.id === id);
  }
  if (!name || name.length > 60) throw new Error("Give the workspace a name (up to 60 characters).");
  if (!["inspect", "work"].includes(mode)) throw new Error("Choose Inspect or Work.");
  if (!isAbsolute(String(path || "")) || /^[\\/]{2}/.test(path)) throw new Error("Give the full path of a folder on this computer, e.g. C:\\Users\\me\\project.");
  let root;
  try { root = realpathSync.native(path); } catch { throw new Error(`No folder at ${path}`); }
  if (!statSync(root).isDirectory()) throw new Error(`${root} is not a folder.`);
  if (dirname(root) === root || samePath(root, realpathSync.native(homedir()))) throw new Error(`${root} is too broad for a workspace. Pick a project folder.`);
  const list = readWorkspaces();
  const taken = listWorkspaces().find((w) => samePath(w.root, root));
  if (taken) throw new Error(`${root} is already the workspace "${taken.name}".`);
  if (samePath(root, realpathSync.native(REPO))) { // Executor, removed earlier: bring it back where it was
    writeWorkspaces(withConsole(list).map((w) => (w.id === "console" ? { id: "console", name, profile: mode === "work" ? "full" : "inspect" } : w)));
    return listWorkspaces().find((w) => w.id === "console");
  }
  const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "ws"}-${randomUUID().slice(0, 4)}`;
  const ws = { id, name, root, profile: mode === "work" ? "full" : "inspect" };
  writeWorkspaces([...list, ws]);
  return listWorkspaces().find((w) => w.id === id);
}
// Removing a workspace only takes it off this list: its folder and files are not touched. Its runs
// stay in the history but can no longer be resumed or browsed (the binding check refuses them).
function removeWorkspace(id) {
  const list = readWorkspaces();
  if (id === "scratch") throw new Error("Scratch is built in and can't be removed.");
  if (!listWorkspaces().some((w) => w.id === id)) throw new Error(`No workspace "${id}".`);
  const busy = active();
  if (busy && (busy.meta.workspace?.id || "console") === id) throw new Error("A worker is running in this workspace. Stop or end it first.");
  writeWorkspaces(id === "console" ? withConsole(list).map((w) => (w.id === "console" ? { ...w, hidden: true } : w)) : list.filter((w) => w.id !== id));
  return listWorkspaces();
}
// New display order: the same workspaces, rearranged.
function reorderWorkspaces(ids) {
  ids = Array.isArray(ids) ? ids.filter((i) => i !== "scratch") : ids; // Scratch isn't one of the projects: it stays apart
  const now = listWorkspaces().map((w) => w.id).filter((i) => i !== "scratch");
  if (!Array.isArray(ids) || ids.length !== now.length || new Set(ids).size !== ids.length || !ids.every((i) => now.includes(i))) throw new Error("The workspace list changed. Reload and try again.");
  const list = readWorkspaces(), byId = new Map(list.map((w) => [w.id, w]));
  writeWorkspaces([...ids.map((i) => byId.get(i) || { id: i }), ...list.filter((w) => w.hidden)]);
  return listWorkspaces();
}
// Browse: the standard Windows "Select Folder" dialog, shown on this computer's desktop by the
// console (a web page can't learn a folder's real path). Only the chosen path comes back, and it
// goes through addWorkspace's checks like a typed one. Nothing is read from or copied out of it.
let picking = false;
function pickFolder() {
  if (HOSTED) throw new Error("There's no folder to browse in the hosted product: add a workspace by name, or clone a repository.");
  if (process.platform !== "win32") throw new Error("Browse is only available on Windows. Type the folder path instead.");
  if (picking) throw new Error("The folder picker is already open.");
  picking = true;
  return new Promise((ok, fail) => {
    const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", join(HERE, "pick-folder.ps1")], { windowsHide: true });
    let out = "", err = "";
    ps.stdout.on("data", (d) => (out += d));
    ps.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => ps.kill(), 15 * 60_000);
    const done = (fn) => { clearTimeout(timer); picking = false; fn(); };
    ps.on("error", (e) => done(() => fail(new Error(`Couldn't open the folder picker: ${e.message}`))));
    ps.on("exit", () => done(() => { try { ok(JSON.parse(out.trim().split(/\r?\n/).pop())); } catch { fail(new Error(`The folder picker failed${err ? `: ${clip(err, 160)}` : "."}`)); } }));
  });
}
// Every cwd recorded in the session's own transcript in this console's config dir (null: not there).
function sessionCwds(sessionId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId || "")) return null;
  const projects = join(CONFIG_DIR, "projects");
  const dir = existsSync(projects) && readdirSync(projects).find((d) => existsSync(join(projects, d, `${sessionId}.jsonl`)));
  if (!dir) return null;
  const cwds = new Set();
  for (const line of readFileSync(join(projects, dir, `${sessionId}.jsonl`), "utf8").split("\n")) {
    try { const c = JSON.parse(line).cwd; if (c) cwds.add(c); } catch {}
  }
  return [...cwds];
}
// A worker may move into a sub-folder of its own workspace (a `cd` in its shell persists between
// turns, and the runtime then reports that folder), so "in the workspace" means the bound real root
// or anywhere under it. Anything outside it is still refused.
function inWorkspace(root, p) {
  let r; try { r = realpathSync.native(p); } catch { r = p; }
  return samePath(r, root) || inRoot(root, r);
}
function checkBinding(run, { resume }) {
  // Runs from before workspaces were all created in this repo with the full profile.
  const bound = run.meta.workspace || { id: "console", root: realpathSync.native(REPO), profile: "full" };
  const now = resolveWorkspace(bound.id);
  // A scratch conversation is bound to its own folder (or, from before per-conversation folders, the shared one).
  if (bound.id === "scratch") {
    if (!samePath(now.root, bound.root) && !isScratchFolder(bound.root)) throw new Error(`This scratch conversation is bound to ${bound.root}, which isn't a scratch folder. Start a new task.`);
    if (!existsSync(bound.root)) throw new Error("This scratch conversation's folder was deleted, so it can't continue. Start a new task.");
  } else if (!samePath(now.root, bound.root)) throw new Error(`Workspace "${bound.id}" now resolves to ${now.root}, but this run is bound to ${bound.root}. Start a new run.`);
  if (now.profile !== bound.profile) throw new Error(`Workspace "${bound.id}" now has the ${now.profile} profile, but this run is bound to ${bound.profile}. Start a new run.`);
  if (resume) {
    if (run.meta.configDir && !samePath(run.meta.configDir, CONFIG_DIR)) throw new Error(`This run's session lives in Claude config dir ${run.meta.configDir}; this console uses ${CONFIG_DIR}.`);
    const cwds = sessionCwds(run.meta.sessionId);
    if (!cwds) throw new Error(`Session ${run.meta.sessionId} isn't in this console's Claude config dir (${CONFIG_DIR}), so it can't be resumed here.`);
    const elsewhere = cwds.find((c) => !inWorkspace(bound.root, c));
    if (elsewhere) throw new Error(`Session ${run.meta.sessionId} has worked in ${elsewhere}, outside this run's workspace ${bound.root}. It won't be resumed here.`);
  }
  if (!run.meta.workspace) { run.meta.workspace = bound; saveMeta(run); }
  return bound;
}

// LEARNED: adds to the worker's learnings; REMEMBER: (the earlier name) still does.
const TAGS = { "NEEDS:": "needs", "LEARNED:": "remember", "REMEMBER:": "remember", "PLAN:": "plan", "OBSERVATION:": "observation", "DECISION:": "decision", "FAILURE:": "failure", "RECOVERY:": "recovery", "VERIFICATION:": "verification", "ARTIFACT:": "artifact", "DONE:": "done" };

// Launch the real claude binary directly (no shell), so Stop kills the worker itself,
// not just a cmd.exe wrapper. Falls back to the `claude` shim through a shell.
function claudeCommand() {
  // CLAUDE_BIN_ARGS (tests): arguments put before the real ones, so CLAUDE_BIN=node can run a stand-in script.
  if (process.env.CLAUDE_BIN) return { cmd: process.env.CLAUDE_BIN, shell: false, pre: process.env.CLAUDE_BIN_ARGS ? JSON.parse(process.env.CLAUDE_BIN_ARGS) : [] };
  // The npm package's binary is claude.exe on every platform in current versions (claude before).
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    for (const name of process.platform === "win32" ? ["claude.exe"] : ["claude.exe", "claude"]) {
      const exe = join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", name);
      if (dir && existsSync(exe)) return { cmd: exe, shell: false };
    }
  }
  return { cmd: "claude", shell: true };
}
const CLAUDE = { pre: [], ...claudeCommand() };

const envOf = (tool) =>
  tool.startsWith("mcp__figma-executor") || tool.startsWith("mcp__figma-reader") ? "Figma"
  : tool.startsWith("mcp__browser-executor") ? "Browser"
  : tool.startsWith("mcp__builder") ? "Builder"
  : ["Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit"].includes(tool) ? "Files"
  : tool === "Bash" || tool === "PowerShell" ? "Shell"
  : tool === "WebFetch" || tool === "WebSearch" ? "Web"
  : "Internal";
const shortName = (tool) => tool.replace(/^mcp__[^_]+(?:-[^_]+)*__/, "");
const clip = (s, n = 160) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
function toolSummary(name, input = {}, root = REPO) {
  const key = input.url || input.selector || input.id || input.pageId || input.componentId || input.file_path || input.path || input.pattern || input.query || input.command || "";
  return `${shortName(name)} ${clip(relTo(root, key), 110)}`.trim();
}
function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === "text" ? c.text : c.type === "tool_reference" ? `loaded ${c.tool_name}` : `[${c.type}]`)).join(" ");
  return JSON.stringify(content);
}

// ---- runs ----------------------------------------------------------------
// Status: starting | running | waiting | finished | stopped | failed | interrupted
// While a run waits, meta.outcome says how its last turn ended, from the runtime's own result and
// the worker's tagged lines in that turn: "needs" (a NEEDS: line: it can't go on without the
// person), "error" (the runtime ended the turn with an error, or the worker reported a FAILURE it
// didn't recover from), "done" (a DONE: line), otherwise "replied". A compaction or handoff request
// isn't a turn of the task, so it keeps the outcome it had.
const runs = new Map(); // id -> { meta, child?, toolUses, file, raw }
const listeners = new Map(); // id -> Set(res)
const metaPath = (id) => join(RUNS, `${id}.meta.json`);
const saveMeta = (run) => { run.meta.updatedAt = new Date().toISOString(); writeAtomic(metaPath(run.meta.id), JSON.stringify(run.meta, null, 1)); };

function emit(run, ev) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...ev });
  appendFileSync(run.file, line + "\n");
  for (const res of listeners.get(run.meta.id) || []) res.write(`data: ${line}\n\n`);
}
function setStatus(run, status, why) {
  run.meta.status = status;
  saveMeta(run);
  emit(run, { type: "status", summary: status, detail: why, ...(status === "waiting" && run.meta.outcome ? { outcome: run.meta.outcome } : {}) });
}
function turnOutcome(run, msg) {
  const tags = run.turnTags || new Set();
  if (tags.has("needs")) return "needs";
  if (msg.is_error || (tags.has("failure") && !tags.has("recovery") && !tags.has("done"))) return "error";
  return tags.has("done") ? "done" : "replied";
}
// The busy-worker refusals name the run that's busy, so the page can lead to it.
function busyError(message) {
  const a = active(), e = new Error(message);
  if (a) e.activeRun = { id: a.meta.id, status: a.meta.status, workspace: a.meta.workspace?.id || "console", prompt: clip(String(a.meta.prompt || "").split(/\r?\n/)[0], 120) };
  return e;
}
const alive = (run) => run.child && run.child.exitCode === null && !run.child.killed;
const active = () => [...runs.values()].find(alive);

function translate(run, msg) {
  if (msg.session_id && run.meta.sessionId !== msg.session_id) { run.meta.sessionId = msg.session_id; saveMeta(run); }
  // The plan's usage as the runtime reports it (for the account panel); not a worker action.
  if (msg.type === "rate_limit_event") { if (msg.rate_limit_info) usage = { info: msg.rate_limit_info, at: Date.now(), run: run.meta.id }; return; }
  // The model the runtime reports at each turn: what a model switch actually did.
  if (msg.type === "system" && msg.subtype === "init" && msg.model) { lastModel = msg.model; if (run.meta.modelUsed !== msg.model) { run.meta.modelUsed = msg.model; saveMeta(run); } }
  if (msg.type === "control_response" && run.controlWaits?.has(msg.response?.request_id)) { run.controlWaits.get(msg.response.request_id)(msg.response); return; }
  if (msg.type === "control_response") { if (msg.response?.subtype !== "success") emit(run, { type: "failure", summary: `The runtime refused a model or effort change: ${msg.response?.error || "no reason given"}` }); return; }
  if (msg.type === "system" && msg.subtype === "compact_boundary") { run.manualCompact = false; observeCompaction(run, msg); saveMeta(run); return; }
  // The runtime compacting on its own (autoCompactWindow), between steps: shown and counted.
  if (msg.type === "system" && msg.subtype === "status" && msg.status === "compacting" && !run.manualCompact) {
    const t = telOf(run); pushMax(t.compactions, { at: new Date().toISOString(), trigger: "auto", pre: t.context.last || null, post: null }, 20); stateOf(run).compactions++;
    emit(run, { type: "compacted", summary: `Compacting automatically: the conversation reached ${kTok(t.context.last)} tokens (limit ${kTok(AUTOCOMPACT_WINDOW)})`, detail: JSON.stringify({ trigger: "auto", pre: t.context.last }) });
    run.meta.contextWarnLevel = 0; saveMeta(run); return;
  }
  if (msg.type === "system" && msg.subtype === "init") {
    // Check what the worker reports about itself, not only what it was told.
    const ws = run.meta.workspace;
    const extra = ws.profile === "inspect" ? (msg.tools || []).filter((t) => !t.startsWith("mcp__") && !INSPECT_BUILTINS.includes(t)) : [];
    const off = [...(run.enforced?.noShell ? ["Bash", "PowerShell"] : []), ...(run.enforced?.noWrite ? ["Write", "Edit", "NotebookEdit"] : [])];
    const kept = (msg.tools || []).filter((t) => off.includes(t));
    const why = !inWorkspace(ws.root, msg.cwd || "") ? `worker reports cwd ${msg.cwd}, outside the workspace ${ws.root}`
      : extra.length ? `inspect worker has tools outside its allow-list: ${extra.join(", ")}`
      : kept.length ? `an enforced policy turned off ${kept.join(", ")}, but the worker reports having them` : null;
    if (why) { run.bindingError = why; emit(run, { type: "failure", summary: `Stopped the worker: ${why}` }); run.child.kill(); return; }
    if (run.meta.status === "starting") setStatus(run, "running");
    if (!run.initSeen) {
      run.initSeen = true;
      const servers = (msg.mcp_servers || []).map((s) => `${s.name}: ${s.status}`).join(", ");
      emit(run, { type: "start", summary: "Worker process started", detail: servers ? `MCP ${servers}` : undefined });
    }
    return;
  }
  if (msg.type === "assistant") {
    observeRequest(run, msg);
    for (const b of msg.message?.content || []) {
      if (b.type === "tool_use") {
        const env = envOf(b.name);
        // A file the worker writes is a deliverable once the write succeeds (see the tool_result).
        run.toolUses.set(b.id, { name: b.name, env, at: Date.now(), input: b.input, writes: (b.name === "Write" || b.name === "Edit") && b.input?.file_path ? relTo(run.meta.workspace.root, b.input.file_path) : null });
        if (b.name === "ToolSearch") continue; // loading tool schemas, not work
        observeToolUse(run, b);
        run.meta.envs[env] = (run.meta.envs[env] || 0) + 1;
        emit(run, { type: "tool", ref: b.id, env, tool: shortName(b.name), summary: toolSummary(b.name, b.input, run.meta.workspace.root) });
      } else if (b.type === "text" && b.text.trim()) {
        emit(run, { type: "reply", summary: b.text.trim() });
        if (run.awaitingHandoff) run.handoffText += b.text + "\n";
        for (const raw of b.text.split(/\r?\n/)) {
          const line = raw.replace(/^[\s*>•-]+/, "").replace(/\*\*/g, "").trim();
          const tag = Object.keys(TAGS).find((t) => line.toUpperCase().startsWith(t));
          if (!tag) continue;
          const text = line.slice(tag.length).trim();
          (run.turnTags ||= new Set()).add(TAGS[tag]);
          if (TAGS[tag] === "artifact") addArtifact(run, relTo(run.meta.workspace.root, text.replace(/[`"]/g, "")), "Files", { declared: true });
          else if (TAGS[tag] === "remember") remember(run, text);
          else emit(run, { type: TAGS[tag], summary: text });
          if (TAGS[tag] === "needs") run.meta.needs = [...(run.meta.needs || []), text];
          if (["plan", "decision", "verification", "done"].includes(TAGS[tag])) pushMax(stateOf(run).milestones, { at: new Date().toISOString(), tag: TAGS[tag], text: clip(text, 300) }, 40);
          if (["failure", "needs"].includes(TAGS[tag])) pushMax(stateOf(run).errors, { at: new Date().toISOString(), tool: TAGS[tag], error: clip(text, 300) }, 15);
          if (TAGS[tag] === "done") { run.meta.done = text; }
          if (TAGS[tag] === "failure") run.meta.failures++;
        }
      }
    }
    saveMeta(run);
    return;
  }
  if (msg.type === "user") {
    for (const b of msg.message?.content || []) {
      if (b.type !== "tool_result") continue;
      const use = run.toolUses.get(b.tool_use_id) || { name: "?", env: "Internal" };
      if (use.name === "ToolSearch") continue;
      observeToolResult(run, use, b);
      if (b.is_error) run.meta.failures++;
      emit(run, { type: b.is_error ? "failure" : "result", ref: b.tool_use_id, env: use.env, tool: shortName(use.name), summary: clip(resultText(b.content), 220) });
      if (use.writes && !b.is_error) addArtifact(run, use.writes, use.env, { ref: b.tool_use_id });
    }
    return;
  }
  if (msg.type === "result") {
    // total_cost_usd is a running total for this worker process: add only what this turn added.
    // (Adding the running total each turn, as before 2026-10-15, over-counted: one 12-turn run
    // showed $126 for a $48.58 list-price estimate.)
    const procCost = msg.total_cost_usd || 0;
    run.meta.costUsd = (run.meta.costUsd || 0) + Math.max(0, procCost - (run.procCost || 0));
    run.procCost = procCost;
    emit(run, {
      type: "completed",
      summary: msg.is_error ? `Turn ended with an error (${msg.subtype})` : "Turn finished",
      detail: JSON.stringify({ turns: msg.num_turns, seconds: Math.round((msg.duration_ms || 0) / 1000), costUsd: msg.total_cost_usd }),
    });
    if (msg.is_error) run.meta.lastError = msg.subtype;
    if (!run.turnAs) run.meta.outcome = turnOutcome(run, msg);
    observeTurn(run, msg);
    setStatus(run, "waiting", "ready for a follow-up");
    if (run.awaitingHandoff && run.pendingContinue) finishContinue(run, run.handoffText.trim());
  }
}
// A path relative to the workspace root when it's inside it (the worker writes absolute paths).
const relTo = (root, p) => { const r = String(p || "").replace(/\\/g, "/"), base = root.replace(/\\/g, "/"); return r.toLowerCase().startsWith(base.toLowerCase() + "/") ? r.slice(base.length + 1) : r; };
function remember(run, text) {
  const w = run.meta.worker;
  if (!w) return emit(run, { type: "note", summary: "LEARNED ignored: the general worker keeps no learnings." });
  if (run.meta.candidate) return emit(run, { type: "note", summary: "LEARNED ignored: a trial run of a proposal doesn't change the worker's learnings." });
  if (!text || SECRETISH.test(text)) return emit(run, { type: "memory", summary: "Not kept: it looked like a secret.", ok: false });
  const list = readMemory(w.id);
  if (!list.some((m) => m.text === text)) { list.push({ text: text.slice(0, 500), at: new Date().toISOString(), run: run.meta.id }); writeMemory(w.id, list.slice(-200)); }
  emit(run, { type: "memory", summary: text });
}
// Two kinds of result file, kept apart: every file the worker wrote inside the workspace
// (meta.artifacts, found from its successful writes), and the ones it named as part of the result
// with an ARTIFACT: line (meta.declared). Files outside the workspace (absolute paths) are neither.
function addArtifact(run, path, env, { declared = false, ref } = {}) {
  if (!path || /^([a-z]:|\/|\\)/i.test(path)) return;
  const known = run.meta.artifacts.includes(path), wasDeclared = (run.meta.declared || []).includes(path);
  if (declared && !wasDeclared) run.meta.declared = [...(run.meta.declared || []), path];
  if (!known) run.meta.artifacts.push(path);
  if (!known || (declared && !wasDeclared)) emit(run, { type: "artifact", env, summary: path, ...(declared ? { declared: true } : {}), ...(ref ? { ref } : {}) });
}

const snapPath = (id) => join(RUNS, `${id}.worker.json`);
function spawnWorker(run, { resume }) {
  const ws = checkBinding(run, { resume });
  // A defined worker runs from the snapshot taken when its run started (definition, Team, context),
  // so editing the worker or its Team later never changes this conversation. What's enforced is
  // worked out again at every start (the policies now, plus the ones it started under), so a
  // resume can't run with less enforcement than the workspace has now.
  const snap = run.meta.worker ? readSnapshot(run.meta.id) : null;
  const scope = runScope(run, ws);
  let promptFile = platformInstructionsFile();
  // Every run, the General worker's too, runs on the computed tool set (launchPlan): the worker's
  // capabilities ∩ workspace mode ∩ Team scope ∩ policies ∩ platform, minus what its accounts didn't
  // allow when the run started (the gate). Its integration tools are checked again at each call.
  const def = snap ? snap.definition : generalDefinition();
  run.enforced = null;
  const plan = launchPlan(def, ws, scope, (snap ? snap.gate : run.meta.gate) || {}, run);
  if (resume) run.authz.ready = false; // what was connected when it last ran may have changed
  clearInterval(run.liveTimer); run.liveTimer = null;
  const rt = plan.rt, mcpFile = join(RUNS, `${run.meta.id}.mcp.json`), profileArgs = plan.args;
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: plan.servers }, null, 1));
  {
    if (scope.protect.length) {
      run.enforced = { noShell: true, noWrite: scope.onProtected };
      emit(run, { type: "policy", summary: `${scope.protect.map((p) => p.branch).join(", ")} protected`, detail: JSON.stringify({ policies: scope.protect, head: scope.head, onProtected: scope.onProtected, off: rt.byPolicy.map((c) => CAPABILITIES[c].label) }) });
    }
  }
  // The run's own context (its worker, Team, policies, or Scratch), when it has one.
  if (existsSync(join(RUNS, `${run.meta.id}.worker.md`))) promptFile = join(RUNS, `${run.meta.id}.worker.md`);
  const args = [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--mcp-config", mcpFile, "--strict-mcp-config",
    "--append-system-prompt-file", promptFile,
    ...profileArgs,
    // the model and effort chosen for this run (none: the runtime's defaults)
    ...(run.meta.model && run.meta.model !== "default" ? ["--model", run.meta.model] : []), ...(run.meta.effort ? ["--effort", run.meta.effort] : []),
    ...(resume ? ["--resume", run.meta.sessionId] : []),
  ];
  telOf(run).processes++; run.procUsage = null; run.procCost = 0; // the runtime's usage counters restart with each process
  const child = spawn(CLAUDE.cmd, CLAUDE.shell ? args.map((a) => (/[\s*()|&,]/.test(a) ? `"${a}"` : a)) : [...CLAUDE.pre, ...args], { cwd: ws.root, shell: CLAUDE.shell, env: workerEnv() });
  run.child = child;
  run.initSeen = false;
  if ([...run.authz.caps].some(liveCap)) run.liveTimer = setInterval(() => { if (alive(run)) refreshLive(run).catch(() => {}); }, LIVE_EVERY);
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      appendFileSync(run.raw, line + "\n");
      try { translate(run, JSON.parse(line)); } catch { emit(run, { type: "note", summary: `unparsed worker output: ${clip(line, 120)}` }); }
    }
  });
  child.stderr.on("data", (d) => emit(run, { type: "note", summary: `worker stderr: ${clip(d, 200)}` }));
  child.on("exit", (code) => {
    if (run.child === child) { clearInterval(run.liveTimer); run.liveTimer = null; }
    emit(run, { type: "note", summary: `worker process exited (code ${code})` });
    // A handoff that never finished (the process died first) still continues, from the task state.
    if (run.awaitingHandoff && run.pendingContinue) setImmediate(() => finishContinue(run, (run.handoffText || "").trim() || null));
    if (run.shutdown) return; // already recorded as interrupted by the shutdown
    if (run.bindingError) setStatus(run, "failed", run.bindingError);
    else if (run.stopRequested) setStatus(run, "stopped", "stopped by the user");
    else if (run.reloadRequested && code === 0) setStatus(run, "finished", "ended so its tools reload: reply to continue the same conversation with the tools connected now");
    else if (run.endRequested && code === 0) setStatus(run, "finished", "run ended by the user");
    else if (code === 0) setStatus(run, "finished");
    else setStatus(run, "failed", `process exited with code ${code}`);
    run.stopRequested = run.endRequested = run.reloadRequested = false;
  });
  child.on("error", (e) => { emit(run, { type: "failure", summary: `could not start worker: ${e.message}` }); setStatus(run, "failed", e.message); });
}

// ---- attachments ------------------------------------------------------------------
// Files attached to a message reach the worker inside the message itself (image, PDF or text
// content blocks), never through the workspace folder. A copy is kept with the run
// (runs/<id>.att/) only so the conversation can show it again. The type is decided from the
// bytes, not from the name the browser sent.
const ATT = { count: 10, image: 5e6, pdf: 10e6, text: 3e5, total: 25e6 };
const IMAGE_SIGS = [["image/png", "89504e47"], ["image/jpeg", "ffd8ff"], ["image/gif", "47494638"], ["image/webp", "52494646"]];
function sniff(buf) {
  const hex = buf.subarray(0, 4).toString("hex");
  const img = IMAGE_SIGS.find(([, sig]) => hex.startsWith(sig) && (sig !== "52494646" || buf.subarray(8, 12).toString() === "WEBP"));
  if (img) return { kind: "image", mime: img[0] };
  if (buf.subarray(0, 5).toString() === "%PDF-") return { kind: "pdf", mime: "application/pdf" };
  return { kind: buf.includes(0) ? "binary" : "text", mime: "text/plain; charset=utf-8" };
}
function readAttachments(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > ATT.count) throw new Error(`Attach up to ${ATT.count} files per message.`);
  let total = 0;
  return list.map((a) => {
    const name = basename(String(a?.name || "file")).replace(/[^\w.\- ()]+/g, "_").slice(0, 100) || "file";
    const buf = Buffer.from(String(a?.data || ""), "base64");
    if (!buf.length) throw new Error(`${name} is empty.`);
    if ((total += buf.length) > ATT.total) throw new Error("The attachments are too large together (25 MB at most).");
    const t = sniff(buf);
    if (t.kind === "binary") throw new Error(`${name} can't be attached: only images (PNG, JPG, GIF, WebP), PDFs and text files.`);
    if (buf.length > ATT[t.kind]) throw new Error(`${name} is too large (${t.kind === "image" ? "5 MB" : t.kind === "pdf" ? "10 MB" : "300 KB"} at most for this type).`);
    return { name, ...t, buf };
  });
}
const attBlock = (a) => (a.kind === "image" ? { type: "image", source: { type: "base64", media_type: a.mime, data: a.buf.toString("base64") } }
  : a.kind === "pdf" ? { type: "document", source: { type: "base64", media_type: a.mime, data: a.buf.toString("base64") }, title: a.name }
  : { type: "text", text: `<attached_file name="${a.name}">\n${a.buf.toString("utf8")}\n</attached_file>` });
const attDir = (run) => join(RUNS, `${run.meta.id}.att`);
function saveAttachments(run, atts) {
  if (!atts.length) return [];
  mkdirSync(attDir(run), { recursive: true });
  const n = readdirSync(attDir(run)).length;
  return atts.map((a, i) => { const file = `${n + i + 1}-${a.name}`; writeFileSync(join(attDir(run), file), a.buf); return { name: a.name, kind: a.kind, size: a.buf.length, file }; });
}

// ---- run telemetry & task state -----------------------------------------------------------
// What a run uses and where it stands, read from the worker's own stream (no extra model calls):
//  - telemetry (meta.telemetry): model requests and the context each one carried, and tokens per
//    turn (the runtime's own usage numbers); tool calls by kind and their durations, measured here;
//    document-state reads and their size in CHARACTERS (measured; not tokens); batches; visual
//    checks (exports); compactions; worker processes.
//  - task state (runs/<id>.state.json): a short ledger of where the work stands: objective, Figma
//    file, nodes made, batches, milestones, errors, visual checks, sessions. References to the
//    evidence, not a transcript; it's what a fresh session is handed (see "continue").
// Warning thresholds are configurable in <data>/console-settings.json.
const SETTINGS_FILE = join(DATA, "console-settings.json");
const DEFAULT_SETTINGS = { contextWarnTokens: 250000, contextWarnFraction: 0.4, docStateWarnChars: 150000, autoFreshSession: true };
const consoleSettings = () => { try { return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) }; } catch { return { ...DEFAULT_SETTINGS }; } };
const newTelemetry = () => ({ modelRequests: 0, context: { last: 0, max: 0, window: null }, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, turns: 0,
  tools: { total: 0, figma: 0, docStateReads: 0, docStateChars: 0, batches: 0, batchOps: 0, visualChecks: 0, slowest: null, byTool: {} }, compactions: [], processes: 0, warnings: [] });
const telOf = (run) => (run.meta.telemetry ||= newTelemetry());
const statePath = (id) => join(RUNS, `${id}.state.json`);
const readTaskState = (id) => (existsSync(statePath(id)) ? JSON.parse(readFileSync(statePath(id), "utf8")) : null);
const stateOf = (run) => (run.state ||= readTaskState(run.meta.id) || { runId: run.meta.id, objective: String(run.meta.prompt || "").slice(0, 4000), requests: [], figma: null, created: [], batches: [], milestones: [], errors: [], visualChecks: [], sessions: [], compactions: 0, ...(run.meta.continuedFrom ? { continuedFrom: run.meta.continuedFrom } : {}) });
const saveTaskState = (run) => { if (run.state) writeAtomic(statePath(run.meta.id), JSON.stringify(run.state, null, 1)); };
const pushMax = (list, item, max) => { list.push(item); if (list.length > max) list.splice(0, list.length - max); };
const kTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };
// The context of one model request, as the runtime reports it: new input + read from cache + written to cache.
function observeRequest(run, msg) {
  run.seenRequests ||= new Set();
  if (!msg.message?.id || run.seenRequests.has(msg.message.id)) return;
  run.seenRequests.add(msg.message.id);
  const u = msg.message.usage || {}, t = telOf(run), ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  // The runtime's own placeholder replies (a plan limit, an API error: model "<synthetic>", no usage)
  // weren't model requests: they mustn't make a long conversation look empty.
  if (!ctx || msg.message.model === "<synthetic>") return;
  t.modelRequests++; t.context.last = ctx; t.context.max = Math.max(t.context.max, ctx); if (!t.context.first && ctx) t.context.first = ctx;
  checkContext(run);
}
function checkContext(run) {
  const t = telOf(run), s = consoleSettings();
  const limit = Math.min(s.contextWarnTokens, t.context.window ? t.context.window * s.contextWarnFraction : Infinity);
  const level = limit > 0 ? Math.floor(t.context.last / limit) : 0;
  if (level >= 1 && level > (run.meta.contextWarnLevel || 0)) {
    run.meta.contextWarnLevel = level;
    const w = { at: new Date().toISOString(), tokens: t.context.last, limit: Math.round(limit), window: t.context.window };
    pushMax(t.warnings, w, 20);
    emit(run, { type: "context", summary: `Context is ${kTok(t.context.last)} tokens per request (warning at ${kTok(limit)})`, detail: JSON.stringify(w) });
  }
  if (t.tools.docStateChars >= s.docStateWarnChars && !run.meta.docStateWarned) {
    run.meta.docStateWarned = true;
    emit(run, { type: "context", summary: `Document reads have returned ${kTok(t.tools.docStateChars)} characters this run`, detail: JSON.stringify({ docStateChars: t.tools.docStateChars, limit: s.docStateWarnChars }) });
  }
}
function observeToolUse(run, b) {
  const t = telOf(run), name = b.name;
  t.tools.total++;
  if (name.startsWith("mcp__figma-executor__")) t.tools.figma++;
  if (name.endsWith("figma_get_document_state")) t.tools.docStateReads++;
  if (name.endsWith("figma_batch")) { t.tools.batches++; t.tools.batchOps += Array.isArray(b.input?.ops) ? b.input.ops.length : 0; }
}
function observeToolResult(run, use, b) {
  const t = telOf(run), st = stateOf(run), name = use.name, text = resultText(b.content), ms = use.at ? Date.now() - use.at : null, short = shortName(name);
  const bt = (t.tools.byTool[short] ||= { calls: 0, ms: 0 }); bt.calls++; if (ms != null) { bt.ms += ms; if (!t.tools.slowest || ms > t.tools.slowest.ms) t.tools.slowest = { tool: short, ms }; }
  if (name.endsWith("figma_get_document_state")) t.tools.docStateChars += text.length;
  if (b.is_error) { pushMax(st.errors, { at: new Date().toISOString(), tool: short, error: clip(text, 200) }, 15); return; }
  const r = parseJson(text);
  // A worker's own commit (repo tools) is linked to its run, like the person's commits are.
  if (name === "mcp__repo__repo_commit" && r?.committed && /^[0-9a-f]{40}$/.test(r.hash || "")) { run.meta.commits = [...new Set([...(run.meta.commits || []), r.hash])]; saveMeta(run); emit(run, { type: "commit", summary: `${r.short} ${r.subject}`, detail: JSON.stringify({ hash: r.hash, files: r.files }) }); }
  if (name.endsWith("figma_get_file_info") && r?.fileKey) st.figma = { file: r.fileName, fileKey: r.fileKey, page: r.currentPage };
  else if (name.endsWith("figma_switch_page") && r?.id) st.figma = { ...(st.figma || {}), page: { id: r.id, name: r.name } };
  else if (/figma_create_(frame|text|component|ellipse|vector|instance|page)$/.test(name) && r?.id) pushMax(st.created, { id: r.id, name: r.name || "" }, 200);
  else if (name.endsWith("figma_batch") && r?.results) {
    pushMax(st.batches, { at: new Date().toISOString(), ops: r.ops, ok: r.ok, failed: r.failed, skipped: r.skipped }, 20);
    for (const [ref, id] of Object.entries(r.created || {})) pushMax(st.created, { id, name: ref, ref }, 200);
    for (const x of r.results.filter((x) => x.status === "failed")) pushMax(st.errors, { at: new Date().toISOString(), tool: `batch op ${x.i} (${x.tool})`, error: clip(x.error, 200) }, 15);
  } else if (name.endsWith("figma_export_node")) { t.tools.visualChecks++; pushMax(st.visualChecks, { at: new Date().toISOString(), nodeId: use.input?.id || null, file: r?.path || r?.file || null }, 20); }
}
function observeTurn(run, msg) {
  const t = telOf(run), st = stateOf(run);
  // modelUsage is cumulative for one worker process: add what this turn added.
  const now = Object.values(msg.modelUsage || {}).reduce((a, m) => ({ input: a.input + (m.inputTokens || 0), output: a.output + (m.outputTokens || 0), cacheRead: a.cacheRead + (m.cacheReadInputTokens || 0), cacheWrite: a.cacheWrite + (m.cacheCreationInputTokens || 0), window: m.contextWindow || a.window }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, window: null });
  const prev = run.procUsage || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const k of ["input", "output", "cacheRead", "cacheWrite"]) t.tokens[k] += Math.max(0, now[k] - prev[k]);
  run.procUsage = now; t.turns++;
  if (now.window) t.context.window = now.window;
  if (run.meta.sessionId && !st.sessions.includes(run.meta.sessionId)) st.sessions.push(run.meta.sessionId);
  checkContext(run); saveTaskState(run);
  emit(run, { type: "telemetry", summary: `context ${kTok(t.context.last)} · ${t.modelRequests} requests · ${t.tools.total} tool calls`, detail: JSON.stringify({ ...t, limit: Math.round(contextLimit(run)), autoCompactAt: AUTOCOMPACT_WINDOW, autoFresh: consoleSettings().autoFreshSession !== false }) });
}
function observeCompaction(run, msg) {
  const t = telOf(run), m = msg.compact_metadata || {}, c = { at: new Date().toISOString(), trigger: m.trigger || null, pre: m.pre_tokens ?? null, post: m.post_tokens ?? null };
  pushMax(t.compactions, c, 20); stateOf(run).compactions++;
  if (c.post != null) { t.context.last = c.post; run.meta.contextWarnLevel = 0; }
  emit(run, { type: "compacted", summary: c.pre != null ? `Conversation compacted: ${kTok(c.pre)} → ${kTok(c.post)} tokens` : "Conversation compacted", detail: JSON.stringify(c) });
}

// ---- compaction and fresh-session continuation ------------------------------------------------
// Compact: Claude Code's own /compact (verified headless), with instructions to keep what this work
// depends on. Continue: a new run, in the same workspace with the same worker, Team, model and
// effort, whose first message is a handoff (the task state above plus, by default, the worker's
// own handoff summary). The old run and its full history stay for audit; the new session gets the
// handoff, not the transcript. Neither starts while the worker is in the middle of a step.
const COMPACT_KEEP = "Keep exactly: the original objective and every constraint the person gave; approved design decisions; conventions in use; the Figma file, page and frame/node ids in use and what each is; work done and work outstanding, in order; open errors and questions; how the result must be verified.";
const HANDOFF_PROMPT = "Stop here and write a handoff for a fresh session that will continue this work without this conversation's history. Don't call any tools. Use exactly these headings: Objective and constraints (verbatim where it matters); Approved decisions; Conventions in use; Done so far (with Figma node ids); Current Figma file, page and frame ids; Outstanding work, in order; Known errors and open questions; How to verify the result. Be concise and complete.";
const waitExit = (child, ms) => new Promise((ok) => { if (!child || child.exitCode !== null) return ok(); const t = setTimeout(ok, ms); child.once("exit", () => { clearTimeout(t); ok(); }); });
function handoffMessage(run, st, summary, instruction) {
  const list = (items, f) => (items.length ? items.map(f).join("\n") : "- none recorded");
  return clip0([
    `# Continuing earlier work (handoff from run ${run.meta.id})`,
    "This conversation continues work from an earlier session. Its full history stays in that run for audit; it isn't repeated here. Inspect the current state of anything you change before changing it.", "",
    "## Original objective (as the person wrote it)", st.objective, "",
    st.requests.length ? `## Later requests from the person\n${st.requests.map((r) => `- ${r.text}`).join("\n")}\n` : "",
    "## Figma", st.figma ? `File "${st.figma.file}" (key ${st.figma.fileKey})${st.figma.page ? `, page "${st.figma.page.name}" (${st.figma.page.id})` : ""}.` : "- not recorded", "",
    "## Nodes made so far (most recent last)", list(st.created.slice(-60), (c) => `- ${c.id} ${c.name}`), "",
    st.batches.length ? `## Recent batches\n${st.batches.slice(-8).map((b) => `- ${b.ops} ops: ${b.ok} ok, ${b.failed} failed, ${b.skipped} skipped`).join("\n")}\n` : "",
    "## Milestones and decisions", list(st.milestones.slice(-25), (m) => `- ${m.tag.toUpperCase()}: ${m.text}`), "",
    "## Visual checks done", list(st.visualChecks.slice(-10), (v) => `- export of ${v.nodeId || "?"} (${v.at})`), "",
    "## Open errors and questions", list(st.errors.slice(-10), (e) => `- ${e.tool}: ${e.error}`), "",
    summary ? `## The previous session's own handoff\n${summary}\n` : "",
    "## Next", instruction || "Carry on with the outstanding work above.",
  ].filter((x) => x !== "").join("\n"), 24000);
}
const clip0 = (s, n) => (s.length > n ? s.slice(0, n - 40) + "\n…(handoff cut to fit; see the earlier run)" : s);
// Automatic, for people and bots alike (no one has to watch): a message to a conversation that's
// already past the context limit isn't added to it. The worker writes its handoff, and a fresh
// session starts with that handoff plus the message (autoFreshSession in console-settings.json,
// on by default). A message to a run that was already continued goes to the newest run of its chain.
function latestInChain(run) { let r = run; for (let i = 0; i < 100 && r.meta.continuedIn; i++) { const n = loadRun(r.meta.continuedIn); if (!n) break; r = n; } return r; }
const contextLimit = (run) => { const s = consoleSettings(), t = telOf(run); return Math.min(s.contextWarnTokens, t.context.window ? t.context.window * s.contextWarnFraction : Infinity); };
function lastContext(run) {
  // A run whose recorded size came from before the placeholder fix (0) is read from its log again.
  const t = telOf(run); if (t.context.last) return t.context.last;
  // A run from before telemetry: its last request, from the end of the runtime's own log.
  try {
    const size = statSync(run.raw).size, n = Math.min(size, 4 << 20), buf = Buffer.alloc(n), fd = openSync(run.raw, "r");
    try { readSync(fd, buf, 0, n, size - n); } finally { closeSync(fd); }
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].includes('"type":"assistant"')) { try { const u = JSON.parse(lines[i]).message.usage, n = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0); if (n) return n; } catch {} }
  } catch {}
  return 0;
}
function sendMessage(run, text, atts, mentions) {
  const target = latestInChain(run), was = lastContext(target), limit = contextLimit(target);
  // Only a conversation that has grown: a fresh session's own starting size never triggers it (no loops).
  const grown = was - (telOf(target).context.first || 0) >= limit / 2;
  if (consoleSettings().autoFreshSession !== false && was >= limit && grown && !target.pendingContinue && !["starting", "running"].includes(target.meta.status)) {
    target.pendingContinue = { instruction: text, atts, mentions, auto: true, contextWas: was };
    emit(target, { type: "context", summary: `Starting a fresh session automatically: this conversation is ${kTok(was)} tokens per step (limit ${kTok(limit)}). Your message goes to the new session with a handoff.` });
    try { followUp(target, HANDOFF_PROMPT, [], [], { as: "handoff" }); } catch (e) { target.pendingContinue = null; throw e; }
    return { ...target.meta, autoFresh: { contextWas: was, limit }, ...(target !== run ? { redirectedFrom: run.meta.id } : {}) };
  }
  followUp(target, text, atts, mentions);
  return { ...target.meta, ...(target !== run ? { redirectedFrom: run.meta.id } : {}) };
}
async function finishContinue(run, summary) {
  const pc = run.pendingContinue; run.pendingContinue = null; run.awaitingHandoff = false;
  const st = stateOf(run);
  st.handoff = summary ? summary.slice(0, 12000) : null; saveTaskState(run);
  try {
    if (alive(run)) { run.endRequested = true; run.child.stdin.end(); await waitExit(run.child, 30000); }
    const text = handoffMessage(run, st, st.handoff, pc.instruction);
    const next = await newRun(text, run.meta.workspace.id, pc.atts || [], run.meta.worker?.id || null, pc.mentions || [], run.meta.team?.id || null, { model: run.meta.model, effort: run.meta.effort }, { continuedFrom: run.meta.id, handoff: true });
    writeFileSync(join(RUNS, `${next.meta.id}.handoff.json`), JSON.stringify({ from: run.meta.id, at: new Date().toISOString(), state: st, workerSummary: st.handoff, instruction: pc.instruction || null }, null, 1));
    run.meta.continuedIn = next.meta.id; saveMeta(run);
    emit(run, { type: "continued", summary: pc.auto ? `Continued automatically in a fresh session (this one was ${kTok(pc.contextWas)} tokens per step)` : "Continued in a fresh session", detail: JSON.stringify({ run: next.meta.id, auto: !!pc.auto }) });
  } catch (e) { emit(run, { type: "failure", summary: `Couldn't continue in a fresh session: ${e.message}` }); }
}

function sendToWorker(run, text, atts = [], mentions = [], opts = {}) {
  run.meta.messages++;
  const saved = saveAttachments(run, atts);
  // A compaction or handoff request is the console's, not the person's: logged as such, not as a chat message.
  if (opts.as) emit(run, { type: opts.as === "compact" ? "compacting" : "handoff", summary: opts.as === "compact" ? "Compacting the conversation" : "Asking the worker for a handoff summary" });
  else { emit(run, { type: "user", summary: text, ...(saved.length ? { attachments: saved } : {}), ...(mentions.length ? { mentions } : {}) }); if (run.meta.messages > 1) pushMax(stateOf(run).requests, { at: new Date().toISOString(), text: clip(text, 300) }, 10); }
  run.turnAs = opts.as || null; if (!opts.as) { run.turnTags = new Set(); run.meta.outcome = null; }
  if (opts.as === "handoff") { run.awaitingHandoff = true; run.handoffText = ""; }
  if (opts.as === "compact") run.manualCompact = true;
  setStatus(run, "running");
  const safe = (t) => defuseAtRefs(run.meta.workspace.root, t); // what the person sees stays as typed
  const note = !opts.as && run.pendingNote ? run.pendingNote + "\n\n" : ""; if (note) run.pendingNote = null;
  const full = note + safe(text) + mentionNote(mentions);
  const content = atts.length ? [...atts.map(attBlock).map((b) => (b.type === "text" ? { ...b, text: safe(b.text) } : b)), ...(full ? [{ type: "text", text: full }] : [])] : full;
  run.child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
}

// A Team run: one of the Team's workers, in the Team's workspace (a request for another workspace
// is refused), with the Team's context added before the worker's own.
const teamWorkspace = (t) => t.workspace || "scratch";
async function newRun(prompt, workspaceId = "console", atts = [], workerId = null, mentions = [], teamId = null, settings = {}, extra = {}) {
  if (active()) throw busyError("A worker is already running. Stop or end it first.");
  const team = teamId ? readTeams().find((t) => t.id === teamId) : null;
  if (teamId && !team) throw new Error(`No Team "${teamId}".`);
  if (team) {
    if (!workerId) throw new Error(`Choose which of the ${team.name} Team's workers should answer.`);
    if (!team.workers.includes(workerId)) throw new Error(`That worker isn't in the ${team.name} Team.`);
    if (workspaceId !== teamWorkspace(team)) throw new Error(`The ${team.name} Team works in its own workspace; it can't run in another one.`);
  }
  let workspace = resolveWorkspace(workspaceId);
  const stored = workerId ? readWorkers().find((w) => w.id === workerId) : null;
  if (workerId && !stored) throw new Error(`No worker "${workerId}".`);
  if (stored) { const why = integrityProblem(stored); if (why) throw Object.assign(new Error(why), { status: 409 }); }
  // A trial run of a proposal (extra.candidate): the worker as the proposal would make it — or, for a
  // baseline trial, as it is — run like any run, but marked, without the evolve tools, and without
  // writing to the worker's memory. It never changes the worker.
  const cand = extra.candidate || null;
  const def = cand ? cand.definition : stored;
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  // Scratch: this conversation's own folder; a continuation keeps working in its parent's.
  const parent = extra.continuedFrom ? loadRun(extra.continuedFrom) : null;
  const scratch = workspace.id === "scratch";
  if (scratch) {
    let root = parent?.meta.workspace?.id === "scratch" && existsSync(parent.meta.workspace.root) ? parent.meta.workspace.root : join(SCRATCH_RUNS, id);
    mkdirSync(root, { recursive: true }); root = realpathSync.native(root);
    workspace = { ...workspace, root };
  }
  const protect = wsPolicies(workspace.id), head = gitInfo(workspace.root).branch;
  // Refused here, before anything is written, when the folder isn't its registered repository or
  // this worker has no access to it.
  const repo = repoScope(workspace, def);
  const scope = { protect, head, onProtected: !!head && protect.some((p) => p.branch === head), figmaKey: team?.figma ? team.figma.branchKey || team.figma.fileKey : null,
    knowledgeDir: team?.knowledge.some((k) => k.type === "upload") ? join(RUNS, `${id}.team`) : null, repo, candidate: !!cand };
  const wsInfo = { name: listWorkspaces().find((w) => w.id === workspace.id)?.name || workspace.id, profile: workspace.profile, head, protect, onProtected: scope.onProtected, repo };
  let snap = null;
  // What its accounts allow, checked now (fail-closed): what isn't available isn't loaded in this run.
  const runDef = def || generalDefinition();
  const gate = await accountGate(runDef, { profile: workspace.profile, root: workspace.root, figmaKey: scope.figmaKey, start: true }, workerRuntime(runDef, workspace.profile, scope).usable);
  if (def) {
    const runtime = launchPlan(def, workspace, scope, gate).rt;
    const ctx = { profile: workspace.profile, root: workspace.root, figmaKey: scope.figmaKey, start: true };
    const own = await requirementStatus(def, ctx);
    const shared = team ? (await requirementStatus(team, ctx)).filter((r) => !own.some((x) => x.resource === r.resource && x.access === r.access)).map((r) => ({ ...r, source: "team" })) : [];
    const status = [...own, ...shared];
    snap = { definition: def, runtime, gate, status, memory: readMemory(def.id).slice(-40), scope, ...(team ? { team } : {}) };
    const workers = readWorkers();
    const teamCtx = team ? { def: team, members: team.workers.map((w) => workers.find((x) => x.id === w)?.name).filter(Boolean), workspaceName: wsInfo.name, runId: id } : null;
    snap.context = workerContext(def, runtime, status, snap.memory, workspace.profile, { workspace: protect.length || team || repo ? wsInfo : null, team: teamCtx, evolve: !!runtime.evolve }) + (scratch ? `\n\n${SCRATCH_NOTE}\n` : "");
    if (cand) snap.candidate = { proposal: cand.proposal, baseline: !!cand.baseline };
  }
  if (active()) throw busyError("A worker is already running. Stop or end it first.");
  const meta = { id, prompt: prompt || atts.map((a) => a.name).join(", "), workspace, ...(extra.continuedFrom ? { continuedFrom: extra.continuedFrom } : {}), ...(settings.model ? { model: settings.model } : {}), ...(settings.effort ? { effort: settings.effort } : {}), ...(def ? { worker: { id: def.id, name: def.name, version: def.version, ...(cand ? { candidate: cand.proposal, ...(cand.baseline ? { baseline: true } : {}) } : {}) } } : {}),
    ...(cand ? { candidate: { proposal: cand.proposal, baseline: !!cand.baseline } } : {}),
    ...(team ? { team: { id: team.id, name: team.name, version: team.version } } : {}), ...(protect.length ? { policy: { protect, head, onProtected: scope.onProtected } } : {}), ...(repo ? { repo: { id: repo.id, fullName: repo.fullName, level: repo.level } } : {}),
    configDir: CONFIG_DIR, createdAt: new Date().toISOString(), status: "starting", sessionId: null, messages: 0, envs: {}, artifacts: [], failures: 0, done: null, costUsd: 0, ...(!def && Object.keys(gate).length ? { gate } : {}) };
  const run = { meta, toolUses: new Map(), file: join(RUNS, `${id}.jsonl`), raw: join(RUNS, `${id}.raw.jsonl`) };
  writeFileSync(run.file, ""); writeFileSync(run.raw, "");
  runs.set(id, run);
  saveMeta(run);
  stateOf(run); saveTaskState(run); // the task state exists from the start (objective, continuedFrom)
  // The run's own copy of the Team's uploaded knowledge: it stays with the run if the Team changes.
  if (scope.knowledgeDir) {
    mkdirSync(scope.knowledgeDir, { recursive: true });
    for (const k of team.knowledge) if (k.type === "upload") copyFileSync(teamPath(team.id, "knowledge", k.file), join(scope.knowledgeDir, k.file));
  }
  // The general worker under an enforced policy gets a context that says why some tools are off.
  if (!def && (protect.length || repo)) writeFileSync(join(RUNS, `${id}.worker.md`), [platformInstructions(), "", workspaceSection(wsInfo)].join("\n"));
  else if (!def && scratch) writeFileSync(join(RUNS, `${id}.worker.md`), [platformInstructions(), "", SCRATCH_NOTE].join("\n"));
  if (snap) {
    writeFileSync(snapPath(id), JSON.stringify(snap, null, 1));
    writeFileSync(join(RUNS, `${id}.worker.md`), snap.context);
    if (team) emit(run, { type: "team", summary: `${team.name} (v${team.version})`, detail: JSON.stringify({ workspace: wsInfo.name, members: team.workers.length,
      files: team.knowledge.filter((k) => k.type === "workspace_file").length, uploads: team.knowledge.filter((k) => k.type === "upload").length,
      enforced: team.policies.map((p) => `Never modify ${p.branch}`), instructions: team.instructions.length, figma: team.figma ? team.figma.name || team.figma.url : null }) });
    emit(run, { type: "worker", summary: `${def.name} (v${def.version})`, detail: JSON.stringify({ capabilities: snap.runtime.usable.filter((c) => !snap.runtime.waiting.some(([w]) => w === c)).map((c) => CAPABILITIES[c].label), waiting: snap.runtime.waiting.map(([c]) => CAPABILITIES[c].label), blocked: snap.runtime.blocked.map((c) => CAPABILITIES[c].label), memory: snap.memory.length }) });
    emit(run, { type: "requirements", summary: snap.status.length ? `${snap.status.filter((r) => r.ok).length}/${snap.status.length} available` : "none declared", detail: JSON.stringify(snap.status.map(({ label, need, ok, state, detail, source }) => ({ label, need, ok, state, detail, source }))) });
  }
  const fixedGate = Object.fromEntries(Object.entries(gate).filter(([c]) => !liveCap(c))), waitGate = Object.fromEntries(Object.entries(gate).filter(([c]) => liveCap(c)));
  if (Object.keys(fixedGate).length) emit(run, { type: "note", summary: `Not loaded: ${Object.keys(fixedGate).map((c) => CAPABILITIES[c]?.label || c).join(", ")}`, detail: JSON.stringify(fixedGate) });
  if (Object.keys(waitGate).length) emit(run, { type: "capability", summary: `Waiting for: ${Object.entries(waitGate).map(([c, why]) => `${CAPABILITIES[c]?.label || c} (${why})`).join("; ")}. Its tools come on in this task when it's connected.`, detail: JSON.stringify({ waiting: true, gate: waitGate }) });
  emit(run, { type: "status", summary: "starting" });
  spawnWorker(run, { resume: false });
  sendToWorker(run, prompt, atts, mentions);
  return run;
}

// Follow-up: same process if it's waiting; otherwise resume the saved session in a new process.
function followUp(run, text, atts = [], mentions = [], opts = {}) {
  if (alive(run)) {
    if (run.meta.status !== "waiting") throw new Error("The worker is still working on the previous message. Wait for it, or stop it.");
    return sendToWorker(run, text, atts, mentions, opts);
  }
  if (active()) throw busyError("Another worker is running. Stop or end it first.");
  if (!run.meta.sessionId) throw new Error("This run has no saved session to resume.");
  checkBinding(run, { resume: true }); // before anything is logged, so a refused resume changes nothing
  emit(run, { type: "note", summary: "Resuming the saved session in a new worker process. Conversation context is kept; tool processes are new (browser pages and logins are gone, Figma and files are unaffected)." });
  setStatus(run, "starting", "resuming session");
  spawnWorker(run, { resume: true });
  sendToWorker(run, text, atts, mentions, opts);
}

function lastLoggedStatus(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].includes('"type":"status"')) { try { return JSON.parse(lines[i]).summary; } catch {} }
  return null;
}
// One unreadable run record mustn't take the whole list (and the page) down: it's left out and
// logged once; its other files are kept, so it can be recovered.
const badMeta = new Set();
function loadRun(id) {
  if (runs.has(id)) return runs.get(id);
  if (!/^[\w-]+$/.test(id) || !existsSync(metaPath(id))) return null;
  let meta;
  try { meta = JSON.parse(readFileSync(metaPath(id), "utf8")); }
  catch (e) { if (!badMeta.has(id)) { badMeta.add(id); console.log(`run ${id}: its record (runs/${id}.meta.json) can't be read (${e.message}); it's left out of the list`); } return null; }
  const run = { meta, toolUses: new Map(), file: join(RUNS, `${id}.jsonl`), raw: join(RUNS, `${id}.raw.jsonl`) };
  if (["starting", "running", "waiting"].includes(meta.status)) { meta.status = "interrupted"; saveMeta(run); } // server restarted under it
  // The log has to say so too: the page rebuilds a run's state by replaying it, and a log still
  // ending on "running" shows a busy worker with nothing to stop and no way to reply.
  if (meta.status === "interrupted" && existsSync(run.file) && lastLoggedStatus(run.file) !== "interrupted")
    emit(run, { type: "status", summary: "interrupted", detail: "the console restarted while the worker was running; send a message to continue" });
  runs.set(id, run);
  return run;
}
function allMetas() {
  return readdirSync(RUNS).filter((f) => f.endsWith(".meta.json")).map((f) => loadRun(f.replace(".meta.json", ""))?.meta).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ---- versions (git) ----------------------------------------------------------------
// A workspace's history is its own Git history: every commit is a version, plus the uncommitted
// changes ("WORKTREE"). The console reads it with plain git commands. It changes it only through two
// explicit actions the person takes in a Work workspace: commit (their message, their configured
// identity, nothing added to the message) and push (the branch's own remote, their existing
// credentials, never a prompt, never a force push). Nothing is ever checked out or reset.
// Workspaces inside a larger repo only see and commit their own folder (the pathspec "prefix").
// Hosted, a repository's hooks never run for the console's Git (they'd run with the person's GitHub
// credential in reach): core.hooksPath points at an empty folder.
const NO_HOOKS = join(DATA, ".no-hooks");
if (HOSTED) mkdirSync(NO_HOOKS, { recursive: true });
const GIT_OPTS = ["-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "-c", "color.ui=false", ...(HOSTED ? ["-c", `core.hooksPath=${NO_HOOKS}`] : [])];
const NO_PROGRAMS = ["--no-ext-diff", "--no-textconv"]; // never run repo-configured diff programs
function gitEnv() {
  // The console's own secrets (the gateway's internal secret, the model token) never reach git.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|COMMON_DIR|CEILING_DIRECTORIES)$/.test(k) && !/^(AIW_|ANTHROPIC_)/.test(k)));
  // No credential prompts of any kind: missing authentication is reported, not asked for.
  return { ...env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
}
// Hosted git network commands (clone, push, ls-remote) authenticate with the person's GitHub
// connection: only that git process gets the token, through git-credential.mjs, which answers only
// for GitHub's host. Nothing is written to the repository's config. Not connected: no credential
// (a public repository or a local remote still works; GitHub answers the rest).
const GH_HOST = (() => { try { return new URL(process.env.GITHUB_WEB_BASE || "https://github.com").host; } catch { return "github.com"; } })();
async function gitAuth() {
  const token = github.hasToken() ? await github.gitToken() : null;
  if (!token) return { args: [], env: {} };
  const q = (p) => `'${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
  return { args: ["-c", "credential.helper=", "-c", `credential.helper=!${q(process.execPath)} ${q(join(HERE, "git-credential.mjs"))}`, "-c", "credential.useHttpPath=false"], env: { AIW_GIT_TOKEN: token, AIW_GIT_HOST: GH_HOST } };
}
async function git(cwd, args, { timeout = 30000, input, auth = false } = {}) {
  const cred = auth && HOSTED ? await gitAuth() : { args: [], env: {} };
  return new Promise((ok, fail) => {
    const p = spawn("git", [...GIT_OPTS, ...cred.args, ...args], { cwd, env: { ...gitEnv(), ...cred.env }, windowsHide: true });
    const out = [], err = []; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill(); }, timeout);
    p.stdout.on("data", (d) => out.push(d)); p.stderr.on("data", (d) => err.push(d));
    p.on("error", (e) => { clearTimeout(timer); fail(new Error(`Couldn't run git: ${e.message}`)); });
    p.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf8"), stderr = Buffer.concat(err).toString("utf8").trim();
      if (code === 0) return ok(stdout);
      const e = new Error(timedOut ? "git timed out" : stderr || `git exited with code ${code}`); e.stderr = stderr; e.timedOut = timedOut; fail(e);
    });
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
  });
}
async function repoOf(wsId) {
  const ws = resolveWorkspace(wsId);
  let top;
  try { top = (await git(ws.root, ["rev-parse", "--show-toplevel"])).trim(); } catch { return { ws, repo: false }; }
  const prefix = (await git(ws.root, ["rev-parse", "--show-prefix"])).trim();
  const hasHead = await git(top, ["rev-parse", "--verify", "-q", "HEAD"]).then(() => true, () => false);
  return { ws, repo: true, top, prefix, spec: prefix || ".", hasHead, canWrite: ws.profile === "full" };
}
const REV = /^[0-9a-f]{7,40}$/;
const checkRev = (rev) => { if (rev !== "WORKTREE" && !REV.test(rev || "")) throw new Error("Unknown version."); return rev; };
const checkRel = (rel) => { rel = String(rel || "").replace(/\\/g, "/"); if (!rel || rel.includes("\0") || rel.startsWith("-") || rel.startsWith("/") || /^[a-z]:/i.test(rel) || /(^|\/)\.\.(\/|$)/.test(rel)) throw new Error("Bad path."); return rel; };
const stripPrefix = (r, p) => (p.startsWith(r.prefix) ? p.slice(r.prefix.length) : p);
// Remote URLs can carry credentials (https://user:token@host/...): never show those.
const safeUrl = (u) => String(u || "").replace(/^(\w+:\/\/)[^@/]+@/, "$1");
function parseStatus(r, text) {
  const out = [], parts = text.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]; if (!e) continue;
    const xy = e.slice(0, 2), path = stripPrefix(r, e.slice(3));
    if (xy[0] === "R" || xy[0] === "C") i++; // -z puts the old name after a rename
    out.push({ path, status: xy === "??" ? "A" : xy.includes("D") ? "D" : xy.includes("A") ? "A" : xy.includes("R") ? "R" : "M" });
  }
  return out;
}
function parseNumstat(r, text) {
  const m = new Map();
  for (const e of text.split("\0")) { const t = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(e); if (t) m.set(stripPrefix(r, t[3]), { add: t[1] === "-" ? null : +t[1], del: t[2] === "-" ? null : +t[2] }); }
  return m;
}
async function branchState(r) {
  const branch = (await git(r.top, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "HEAD")).trim();
  const remoteName = branch !== "HEAD" ? (await git(r.top, ["config", "--get", `branch.${branch}.remote`]).catch(() => "")).trim() : "";
  const mergeRef = branch !== "HEAD" ? (await git(r.top, ["config", "--get", `branch.${branch}.merge`]).catch(() => "")).trim() : "";
  const remotes = (await git(r.top, ["remote"]).catch(() => "")).split(/\r?\n/).filter(Boolean);
  const remote = remoteName && remotes.includes(remoteName) ? remoteName : remotes.includes("origin") ? "origin" : remotes[0] || null;
  const target = remoteName && mergeRef ? mergeRef.replace(/^refs\/heads\//, "") : branch;
  const url = remote ? safeUrl((await git(r.top, ["remote", "get-url", "--push", remote]).catch(() => "")).trim()) : null;
  // Commits on this branch that aren't on the remote yet.
  let ahead = 0, local = new Set();
  if (r.hasHead) {
    const tracking = remote ? `refs/remotes/${remote}/${target}` : null;
    const hasTracking = tracking && (await git(r.top, ["rev-parse", "--verify", "-q", tracking]).then(() => true, () => false));
    const list = await git(r.top, hasTracking ? ["rev-list", "-n", "500", "HEAD", `^${tracking}`] : ["rev-list", "-n", "500", "HEAD", "--not", "--remotes"]).catch(() => "");
    local = new Set(list.split(/\r?\n/).filter(Boolean)); ahead = local.size;
  }
  return { branch, detached: branch === "HEAD", remote, target, url, github: /github\.com[:/]/i.test(url || ""), ahead, local };
}
// Runs in this workspace, and which of them a commit came from.
const wsRuns = (wsId) => allMetas().filter((m) => (m.workspace?.id || "console") === wsId);
async function gitSummary(wsId) {
  const r = await repoOf(wsId);
  if (!r.repo) return { repo: false };
  const [status, log, b] = await Promise.all([
    git(r.top, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", r.spec]),
    r.hasHead ? git(r.top, ["log", "-n", "30", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1e", "--", r.spec]) : "",
    branchState(r),
  ]);
  const runs = wsRuns(wsId), byCommit = new Map();
  for (const m of runs) for (const h of m.commits || []) if (!byCommit.has(h)) byCommit.set(h, { id: m.id, prompt: m.prompt });
  const commits = log.split("\x1e").map((x) => x.trim()).filter(Boolean).map((x) => {
    const [hash, short, subject, author, date] = x.split("\x1f");
    return { hash, short, subject, author, date, pushed: !b.local.has(hash), run: byCommit.get(hash) || null };
  });
  const changes = parseStatus(r, status);
  // Runs that changed files since the newest version: their work is in the uncommitted changes.
  const since = commits[0] ? Date.parse(commits[0].date) : 0;
  const pendingRuns = runs.filter((m) => m.artifacts?.length && !(m.commits || []).length && Date.parse(m.updatedAt || m.createdAt) > since).map((m) => ({ id: m.id, prompt: m.prompt }));
  const { local, ...branch } = b;
  const protect = wsPolicies(wsId).map(({ branch: name, team }) => ({ branch: name, team }));
  return { repo: true, canWrite: r.canWrite, prefix: r.prefix, ...branch, protect, branchProtected: protect.some((p) => p.branch === branch.branch || p.branch === branch.target),
    changes: changes.slice(0, 300), changeCount: changes.length, commits, pendingRuns };
}
async function gitVersion(wsId, rev) {
  const r = await repoOf(wsId);
  if (!r.repo) throw new Error("This workspace isn't a Git repository.");
  checkRev(rev);
  if (rev === "WORKTREE") {
    const [status, num] = await Promise.all([
      git(r.top, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", r.spec]),
      r.hasHead ? git(r.top, ["diff", "HEAD", "--numstat", "-z", "--no-renames", ...NO_PROGRAMS, "--", r.spec]) : "",
    ]);
    const n = parseNumstat(r, num);
    return { rev, files: parseStatus(r, status).slice(0, 300).map((x) => ({ ...x, ...(n.get(x.path) || {}) })) };
  }
  const head = await git(r.top, ["show", "-s", "--format=%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%aI", rev]);
  const [hash, short, subject, body, author, date] = head.trim().split("\x1f");
  const [names, num] = await Promise.all([
    git(r.top, ["show", "--format=", "--name-status", "-z", "--no-renames", "--diff-merges=first-parent", rev, "--", r.spec]),
    git(r.top, ["show", "--format=", "--numstat", "-z", "--no-renames", "--diff-merges=first-parent", ...NO_PROGRAMS, rev, "--", r.spec]),
  ]);
  const n = parseNumstat(r, num), files = [], p = names.split("\0").filter(Boolean);
  for (let i = 0; i + 1 < p.length; i += 2) { const path = stripPrefix(r, p[i + 1]); files.push({ path, status: p[i][0], ...(n.get(path) || {}) }); }
  const run = wsRuns(wsId).find((m) => (m.commits || []).includes(hash));
  return { rev, hash, short, subject, body: body.trim(), author, date, files, run: run ? { id: run.id, prompt: run.prompt } : null };
}
// One file's change in a version, as a unified diff (a new, untracked file is shown as all-added).
async function gitDiff(wsId, rev, rel) {
  const r = await repoOf(wsId);
  if (!r.repo) throw new Error("This workspace isn't a Git repository.");
  checkRev(rev); rel = checkRel(rel);
  const p = r.prefix + rel;
  if (rev !== "WORKTREE") return git(r.top, ["show", "--format=", "--no-color", "--diff-merges=first-parent", ...NO_PROGRAMS, rev, "--", p]);
  const tracked = r.hasHead && (await git(r.top, ["cat-file", "-e", `HEAD:${p}`]).then(() => true, () => false));
  if (tracked) return git(r.top, ["diff", "HEAD", "--no-color", ...NO_PROGRAMS, "--", p]);
  const real = fileInside(r.ws.root, rel);
  if (!real) return "";
  const buf = readFileSync(real);
  if (buf.subarray(0, 8000).includes(0)) return `new file: ${rel}\nBinary file, not shown\n`;
  const lines = buf.toString("utf8").replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  return `new file: ${rel}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => "+" + l).join("\n")}\n`;
}
async function gitFileAt(wsId, rev, rel) {
  const r = await repoOf(wsId);
  if (!r.repo) throw new Error("This workspace isn't a Git repository.");
  if (!REV.test(rev || "")) throw new Error("Unknown version.");
  return git(r.top, ["show", `${rev}:${r.prefix + checkRel(rel)}`]);
}
const runIn = (wsId, id) => { const run = id && loadRun(String(id)); return run && (run.meta.workspace?.id || "console") === wsId ? run : null; };
async function gitCommit(wsId, message, runId) {
  const r = await repoOf(wsId);
  if (!r.repo) throw new Error("This workspace isn't a Git repository.");
  if (!r.canWrite) throw new Error("Commit and push are available in Work workspaces only.");
  const onBranch = (await git(r.top, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim();
  const guard = wsPolicies(wsId).find((p) => p.branch === onBranch);
  if (guard) throw new Error(`${onBranch} is protected by the ${guard.team}'s enforced policy: nothing is committed to it from here. Switch to another branch to commit.`);
  message = String(message || "").replace(/\r\n/g, "\n").trim();
  if (!message) throw new Error("Write a short description of this version first.");
  if (message.length > 5000) throw new Error("That message is too long.");
  const busy = active();
  if (busy && (busy.meta.workspace?.id || "console") === wsId && busy.meta.status !== "waiting") throw new Error("The worker is still working in this workspace. Let it finish (or stop it), then commit.");
  await git(r.top, ["add", "-A", "--", r.spec]);
  if (!(await git(r.top, ["diff", "--cached", "--name-only", "--", r.spec])).trim()) throw new Error("There are no changes to commit.");
  // The person's message as typed, read from stdin; git's configured identity; only this
  // workspace's folder (--only semantics of a pathspec). No trailer of any kind is added here.
  try { await git(r.top, ["commit", "-q", "-F", "-", "--", r.spec], { input: message + "\n", timeout: 120000 }); }
  catch (e) {
    if (/Author identity unknown|Please tell me who you are|user\.email|user\.name/i.test(e.message)) throw new Error("Git doesn't know who you are yet. Set your name and email for Git (git config user.name / user.email), then commit again.");
    throw new Error(`Commit failed: ${clip(e.message, 300)}`);
  }
  const [hash, short, subject] = (await git(r.top, ["log", "-1", "--format=%H%x1f%h%x1f%s"])).trim().split("\x1f");
  const finalMessage = await git(r.top, ["log", "-1", "--format=%B"]);
  const files = (await git(r.top, ["show", "--format=", "--name-only", hash])).split(/\r?\n/).filter(Boolean).length;
  // Link the runs whose work went into this version.
  const linked = new Set((await gitSummary(wsId).catch(() => ({ pendingRuns: [] }))).pendingRuns?.map((x) => x.id) || []);
  const run = runIn(wsId, runId); if (run) linked.add(run.meta.id);
  for (const id of linked) { const m = loadRun(id); if (m) { m.meta.commits = [...(m.meta.commits || []), hash]; saveMeta(m); } }
  // Repo hooks (not this console) can still edit messages; say so if one added a co-author.
  const hookTrailer = /^co-authored-by:/im.test(finalMessage) && !/^co-authored-by:/im.test(message);
  if (run) emit(run, { type: "commit", summary: `${short} ${subject}`, detail: JSON.stringify({ hash, files }) });
  return { hash, short, subject, files, runs: [...linked], hookTrailer };
}
async function gitPush(wsId, runId) {
  const r = await repoOf(wsId);
  if (!r.repo) throw new Error("This workspace isn't a Git repository.");
  if (!r.canWrite) throw new Error("Commit and push are available in Work workspaces only.");
  const b = await branchState(r);
  if (b.detached) throw new Error("This folder isn't on a branch (detached HEAD), so there's nothing to push.");
  if (!b.remote) throw new Error("This repository has no remote to push to.");
  // A workspace assigned to a registered repository only pushes to that repository.
  const a = assignmentOf(wsId);
  if (a) {
    const reg = readGithub().repos.find((x) => x.id === a.id);
    if (!reg) throw new Error("This workspace is assigned to a repository that's no longer registered. Unassign it on the GitHub page first.");
    if (github.canonRemote(b.url) !== github.canonRemote(reg.url)) throw new Error(`Refused: this branch pushes to ${b.url || b.remote}, not ${reg.fullName}, the repository assigned to this workspace.`);
  }
  const guard = wsPolicies(wsId).find((p) => p.branch === b.target || p.branch === b.branch);
  if (guard) throw new Error(`${guard.branch} is protected by the ${guard.team}'s enforced policy: nothing is pushed to it from here.`);
  if (!b.ahead) throw new Error(`Nothing to push: ${b.remote}/${b.target} already has these commits.`);
  const run = runIn(wsId, runId);
  const where = `${b.remote}/${b.target}`;
  try {
    // Explicit refspec, no --force, no -u: nothing in the repo's config is changed.
    const out = await git(r.top, ["push", "--porcelain", b.remote, `HEAD:refs/heads/${b.target}`], { timeout: 120000, auth: true });
    const line = out.split(/\r?\n/).find((l) => /^[ +*=]\t/.test(l)) || "";
    const res = { ok: true, remote: b.remote, branch: b.target, url: b.url, github: b.github, commits: b.ahead, summary: `Pushed ${b.ahead} commit${b.ahead === 1 ? "" : "s"} to ${where}`, detail: line.trim() };
    if (run) emit(run, { type: "push", summary: res.summary, detail: b.url || "" });
    return res;
  } catch (e) {
    const m = e.message;
    const why = e.timedOut ? "The push timed out." : /Authentication failed|could not read Username|could not read Password|terminal prompts disabled|Logon failed|Invalid username or password|Permission denied \(publickey|Host key verification failed|returned error: 40[13]|HTTP Basic: Access denied/i.test(m)
      ? (HOSTED ? `GitHub refused the push to ${b.url || b.remote}. The AI Worker app needs write access to this repository's contents (Choose repositories on GitHub), and you need push access yourself.` : `Git has no working login for ${b.url || b.remote}. Sign in once with Git outside the Workspace (for example, run "git push" in a terminal in this folder), then push again.`)
      : /rejected|non-fast-forward|fetch first|stale info/i.test(m) ? `${where} has commits this folder doesn't have yet. Bring them in first (pull, outside the Workspace), then push.`
      : /Could not resolve host|unable to access|Connection refused|timed out|Failed to connect/i.test(m) ? `Couldn't reach ${b.url || b.remote}: ${clip(m.split(/\r?\n/)[0], 200)}`
      : `Push failed: ${clip(m, 300)}`;
    if (run) emit(run, { type: "push", summary: "Push failed", detail: why, ok: false });
    const err = new Error(why); err.push = true; throw err;
  }
}

// ---- prompts ---------------------------------------------------------------
const readPrompts = () => JSON.parse(readFileSync(PROMPTS, "utf8"));
const writePrompts = (p) => writeAtomic(PROMPTS, JSON.stringify(p, null, 1) + "\n");

// ---- http --------------------------------------------------------------------
const TYPES = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".md": "text/plain; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".mjs": "text/plain; charset=utf-8", ".csv": "text/plain; charset=utf-8", ".css": "text/css" };
// Request bodies are JSON; attachments make them large, so they're capped (base64 of 25 MB fits).
const body = (req) => new Promise((ok, fail) => {
  let b = "", n = 0;
  req.on("data", (d) => { n += d.length; if (n <= 40e6) b += d; });
  req.on("end", () => { if (n > 40e6) return fail(new Error("The request is too large.")); try { ok(b ? JSON.parse(b) : {}); } catch { fail(new Error("Bad request body.")); } });
});
const json = (res, status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

// ---- file viewer containment -----------------------------------------------------
// The real path of the requested file must be inside the real path of the root. Real paths
// resolve symlinks, junctions, "..", 8.3 short names and trailing dots, so this compares where
// the file actually is with where the root actually is, not two strings as typed. Absolute,
// drive-relative, UNC and device paths are refused before touching the disk (a realpath of
// \\host\share would open an SMB connection).
// Not covered: a hardlink inside the root to a file elsewhere is a real file inside the root.
function fileInside(root, requested) {
  if (!requested || requested.includes("\0") || isAbsolute(requested) || /^[a-z]:/i.test(requested) || /^[\\/]{2}/.test(requested)) return null;
  let realRoot, real;
  try { realRoot = realpathSync.native(root); real = realpathSync.native(resolve(realRoot, requested)); } catch { return null; }
  const r = relative(realRoot, real);
  if (!r || isAbsolute(r) || r === ".." || r.startsWith(".." + sep)) return null;
  return statSync(real).isFile() ? real : null;
}

// One directory of a workspace, for the file explorer. The directory goes through the same real
// path containment as files; an entry whose real path leaves the root (a junction or symlink out)
// is left out rather than listed.
function dirInside(root, requested) {
  if (requested.includes("\0") || isAbsolute(requested) || /^[a-z]:/i.test(requested) || /^[\\/]{2}/.test(requested)) return null;
  let realRoot, real;
  try { realRoot = realpathSync.native(root); real = realpathSync.native(resolve(realRoot, requested || ".")); } catch { return null; }
  const r = relative(realRoot, real);
  if (isAbsolute(r) || r === ".." || r.startsWith(".." + sep) || !statSync(real).isDirectory()) return null;
  const entries = [];
  for (const e of readdirSync(real, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    let er; try { er = realpathSync.native(join(real, e.name)); } catch { continue; }
    const rr = relative(realRoot, er);
    if (!rr || isAbsolute(rr) || rr === ".." || rr.startsWith(".." + sep)) continue;
    const st = statSync(er);
    entries.push({ name: e.name, path: (r ? r + "/" : "").replace(/\\/g, "/") + e.name, dir: st.isDirectory(), size: st.isFile() ? st.size : undefined });
  }
  return entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

// ---- @ mentions -------------------------------------------------------------------
// Typing @ in the composer searches the files of the selected workspace only. The list comes from
// Git when the folder is a repository (tracked and untracked files first, then the files .gitignore
// hides), or else from a walk; dependency/build folders and .git are always left out; every entry passes the same real-path
// containment as the file viewer (a file or folder that links outside the workspace is left out).
// It's cached briefly, so typing doesn't rescan.
const INDEX_TTL = 15000, INDEX_MAX = 20000;
const WALK_SKIP = new Set([".git", "node_modules", ".next", ".nuxt", ".svelte-kit", ".output", ".vercel", ".netlify", "dist", "build", "out", "target", "coverage", ".cache", ".parcel-cache", ".turbo", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".gradle"]);
const indexes = new Map(); // real root -> { at, files: [{ path, mtime }], truncated }
const inRoot = (realRoot, p) => { const r = relative(realRoot, p); return !!r && !isAbsolute(r) && r !== ".." && !r.startsWith(".." + sep); };
async function fileIndex(root) {
  const realRoot = realpathSync.native(root);
  const hit = indexes.get(realRoot);
  if (hit && Date.now() - hit.at < INDEX_TTL) return hit;
  let rels = null;
  // (-x skips untracked dependency/build folders even when .gitignore forgets them; committed files stay)
  try { rels = (await git(realRoot, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", ...[...WALK_SKIP].flatMap((d) => ["-x", d + "/"])], { timeout: 15000 })).split("\0").filter(Boolean); } catch {}
  const walk = (dir, rel, out) => {
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length > INDEX_MAX) return;
      if (WALK_SKIP.has(e.name) || e.isSymbolicLink()) continue; // links (and junctions) aren't followed
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), r, out); else if (e.isFile()) out.push(r);
    }
  };
  // Not a repository, or nothing Git would show (a folder the enclosing repo ignores, like "No folder"): walk it.
  if (!rels?.length) { rels = []; walk(realRoot, "", rels); }
  else {
    // Files .gitignore hides are still the person's files (notes, docs kept out of the repo), so
    // they're listed too, after the rest. Only dependency/build folders stay out, and a hidden
    // folder is walked only if it's a real folder inside the workspace (not a link out).
    const hidden = [];
    try {
      const out = (await git(realRoot, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], { timeout: 15000 })).split("\0").filter(Boolean);
      for (const e of out) {
        const p = e.replace(/\/$/, "");
        if (p.split("/").some((seg) => WALK_SKIP.has(seg))) continue;
        if (!e.endsWith("/")) { hidden.push(p); continue; }
        const abs = join(realRoot, p);
        try { if (lstatSync(abs).isSymbolicLink() || !inRoot(realRoot, realpathSync.native(abs))) continue; } catch { continue; }
        walk(abs, p, hidden);
        if (hidden.length > INDEX_MAX) break;
      }
    } catch {}
    rels = [...rels, ...hidden];
  }
  const dirOk = new Map(), files = [];
  for (const rel of rels) {
    if (files.length >= INDEX_MAX) break;
    const d = dirname(rel);
    if (!dirOk.has(d)) { let ok = false; try { ok = d === "." || inRoot(realRoot, realpathSync.native(join(realRoot, d))); } catch {} dirOk.set(d, ok); }
    if (!dirOk.get(d)) continue;
    const abs = join(realRoot, rel);
    let st; try { st = lstatSync(abs); } catch { continue; } // listed by git but deleted
    if (st.isSymbolicLink()) { try { const real = realpathSync.native(abs); if (!inRoot(realRoot, real) || !statSync(real).isFile()) continue; st = statSync(real); } catch { continue; } }
    else if (!st.isFile()) continue;
    files.push({ path: rel.replace(/\\/g, "/"), mtime: st.mtimeMs });
  }
  const idx = { at: Date.now(), files, truncated: rels.length > INDEX_MAX };
  indexes.set(realRoot, idx);
  return idx;
}
// Empty query: the most recently changed files. "dir/": what's inside that folder. Otherwise
// paths containing the text, best matches on the file name first.
async function searchFiles(root, q) {
  const t0 = Date.now(), idx = await fileIndex(root);
  q = String(q || "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase().slice(0, 200);
  let hits;
  if (!q) hits = [...idx.files].sort((a, b) => b.mtime - a.mtime);
  else if (q.endsWith("/")) { // that folder from the root first, then a folder of that name anywhere
    const at = (f) => { const p = f.path.toLowerCase(); return p.startsWith(q) ? 0 : p.includes("/" + q) ? 1 : 9; };
    hits = idx.files.map((f) => [at(f), f]).filter(([k]) => k < 9).sort((a, b) => a[0] - b[0] || a[1].path.localeCompare(b[1].path)).map(([, f]) => f);
  }
  else {
    const score = (f) => { const p = f.path.toLowerCase(), n = p.slice(p.lastIndexOf("/") + 1); return n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : p.includes(q) ? 3 : 9; };
    hits = idx.files.map((f) => [score(f), f]).filter(([sc]) => sc < 9).sort((a, b) => a[0] - b[0] || a[1].path.length - b[1].path.length || a[1].path.localeCompare(b[1].path)).map(([, f]) => f);
  }
  return { files: hits.slice(0, 30).map((f) => f.path), total: hits.length, indexed: idx.files.length, truncated: idx.truncated, ms: Date.now() - t0 };
}
// A mention is a reference, not a copy: a workspace-relative path the worker reads with its own
// file tools. Each one is checked against the run's workspace before the worker sees it. Absolute,
// drive, UNC and ".." paths are refused; a path that resolves outside (a link out) is refused; a
// file that no longer exists is passed on as missing, so the worker can say so.
function resolveMentions(root, list) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > 20) throw new Error("Mention up to 20 files per message.");
  const out = [];
  for (const m of list) {
    const p = String(m?.path || "").replace(/\\/g, "/");
    if (m?.type !== "file" || !p || p.includes("\0") || p.startsWith("-") || isAbsolute(p) || /^[a-z]:/i.test(p) || p.startsWith("//") || /(^|\/)\.\.(\/|$)/.test(p)) throw new Error(`@${p} isn't a file in this workspace.`);
    if (out.some((x) => x.path === p)) continue;
    if (fileInside(root, p)) { out.push({ path: p, exists: true }); continue; }
    let real = null; try { real = realpathSync.native(resolve(realpathSync.native(root), p)); } catch {}
    if (real && !inRoot(realpathSync.native(root), real)) throw new Error(`@${p} resolves outside this workspace.`);
    if (real) throw new Error(`@${p} is a folder, not a file.`);
    out.push({ path: p, exists: false });
  }
  return out;
}
// The runtime turns an "@path" it finds in a message into that file's contents before the worker
// sees it, and in Work it does so for paths outside the workspace too (tested: an absolute path and
// a "../" path were both read in). Neither fits here: a mention is a reference the worker reads with
// its own tools, and nothing outside the workspace may arrive by "@". The runtime only treats an "@"
// at the start or after a space or punctuation as a file, so every "@token" it could read (a path
// that exists from the workspace, or any absolute, drive, UNC, home or ".." path) goes to the worker
// inside backticks. Other "@" text (emails, @media, a package name that isn't a file) is unchanged.
function defuseAtRefs(root, text) {
  return text.replace(/(^|[^A-Za-z0-9_`])@("[^"\n]*"|(?:\\ |[^\s`])+)/g, (all, pre, tok) => {
    const p = tok.replace(/^"|"$/g, "").replace(/\\ /g, " ").replace(/#L?\d+(-\d+)?$/i, "");
    const risky = [p, p.replace(/[.,;:!?)\]}'"]+$/, "")].some((c) => c && (isAbsolute(c) || /^[a-z]:/i.test(c) || /^[\\/]{2}/.test(c) || c.startsWith("~") || /(^|[\\/])\.\.([\\/]|$)/.test(c) || existsSync(resolve(root, c))));
    return risky ? `${pre}\`@${tok}\`` : all;
  });
}
const mentionNote = (mentions) => mentions.length ? `\n\n<file_references>\nThe person referenced these files with @. Paths are relative to the workspace folder (your working directory). Read them with your file tools before answering about them.\n${mentions.map((m) => `- ${m.path}${m.exists ? "" : " (did not exist when this message was sent)"}`).join("\n")}\n</file_references>` : "";

// ---- request guard ------------------------------------------------------------
// Local-only, same-origin-only. The server listens on 127.0.0.1 (not the LAN), every request
// must name this console as its Host (blocks DNS rebinding), and every state-changing request
// must come from the console's own page: exact Origin, same-origin fetch metadata, a custom
// header (a cross-site page can't send one without a CORS preflight, which is never approved)
// and a JSON content type. CORS headers are never sent.
// Hosted, the gateway is the only client: it signs the person in, checks the public Origin, then
// calls this console as http://127.0.0.1:<port> with the internal secret it started it with. A
// request without the secret (another process on the machine) is refused before anything else.
const HOSTS = new Set(HOSTED ? [`127.0.0.1:${PORT}`] : [`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const ORIGINS = new Set(HOSTED ? [`http://127.0.0.1:${PORT}`] : [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
const SECRET_BUF = Buffer.from(INTERNAL_SECRET);
const fromGateway = (req) => { const b = Buffer.from(String(req.headers["x-aiw-internal"] || "")); return b.length === SECRET_BUF.length && timingSafeEqual(b, SECRET_BUF); };
function rejectReason(req) {
  if (HOSTED && !fromGateway(req)) return "not from the gateway";
  if (!HOSTS.has(String(req.headers.host || "").toLowerCase())) return "Host header is not this console";
  if (req.method === "GET" || req.method === "HEAD") return null;
  if (req.method === "OPTIONS") return "CORS preflight is never approved";
  if (!ORIGINS.has(req.headers.origin)) return `Origin ${req.headers.origin ? `"${req.headers.origin}"` : "missing"} is not this console`;
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin") return `Sec-Fetch-Site is "${site}"`;
  if (req.headers["x-worker-console"] !== "1") return "missing X-Worker-Console header";
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) return "Content-Type is not application/json";
  return null;
}

http.createServer(async (req, res) => {
  // A run's tool servers asking whether a call is allowed (authorizeCall). Token-checked; it answers
  // only on this console's own address.
  if (req.method === "GET" && /^\/authz\/[\w-]+\/live$/.test(String(req.url).split("?")[0])) {
    if (!HOSTS.has(String(req.headers.host || "").toLowerCase())) { res.writeHead(403); return res.end(); }
    const u = new URL(req.url, `http://localhost:${PORT}`);
    const r = await liveFor(u.pathname.split("/")[2], req.headers["x-aiw-authz"] || "", u.searchParams.get("server") || "", u.searchParams.get("at") ?? "", u.searchParams.get("on")).catch(() => null);
    return json(res, r ? 200 : 403, r || { live: [] });
  }
  if (req.method === "GET" && /^\/authz\/[\w-]+$/.test(String(req.url).split("?")[0])) {
    if (!HOSTS.has(String(req.headers.host || "").toLowerCase())) { res.writeHead(403); return res.end(); }
    const u = new URL(req.url, `http://localhost:${PORT}`), runId = u.pathname.split("/")[2], cap = u.searchParams.get("cap") || "";
    const r = await authorizeCall(runId, req.headers["x-aiw-authz"] || "", cap).catch((e) => ({ ok: false, reason: e.message }));
    if (!r.ok) console.log(`${new Date().toISOString()} AUTHZ refused run=${runId} cap=${cap} tool=${u.searchParams.get("tool") || "-"}: ${r.reason}`);
    return json(res, r.ok ? 200 : 403, r);
  }
  // A run's evolve tool server (mcp/evolve-server.mjs): read the run's own worker, or submit a proposal
  // for it. Only with that run's token, while it runs, for its own worker, never in a trial run. These
  // two are all the token allows: approving, trying and grading are the person's (below the guard).
  const evolvePath = /^\/evolve\/([\w-]+)\/(self|propose)$/.exec(String(req.url).split("?")[0]);
  if (evolvePath) {
    if (!HOSTS.has(String(req.headers.host || "").toLowerCase())) { res.writeHead(403); return res.end(); }
    const run = runs.get(evolvePath[1]), a = run?.authz, t = Buffer.from(String(req.headers["x-aiw-evolve"] || "")), want = Buffer.from(a?.token || "");
    if (!a || !alive(run) || !want.length || t.length !== want.length || !timingSafeEqual(t, want)) return json(res, 403, { error: "Not this run's evolve tools." });
    if (!run.meta.worker || run.meta.candidate) return json(res, 403, { error: "This run can't propose changes (it has no worker definition, or it's a trial run)." });
    const w = readWorkers().find((x) => x.id === run.meta.worker.id);
    if (!w) return json(res, 404, { error: "This worker no longer exists." });
    const bad = integrityProblem(w); if (bad) return json(res, 409, { error: bad });
    if (evolvePath[2] === "self" && req.method === "GET") return json(res, 200, selfView(w));
    if (evolvePath[2] === "propose" && req.method === "POST") {
      try {
        const b = await body(req);
        if (JSON.stringify(b).length > 256 * 1024) return json(res, 413, { error: "The proposal is too large (at most 256 KB)." });
        const p = await submitProposal(b, w, proposalProvenance(run), a.ctx);
        const v = proposalView(p);
        emit(run, { type: "proposal", summary: `Proposed a change to ${w.name}: ${p.title}. It waits for the person's review.`, detail: JSON.stringify({ id: p.id, worker: w.id, verification: v.verification.status }) });
        return json(res, 200, { id: p.id, status: "proposed", base: p.base, verification: v.verification, dependencies: p.dependencies, warnings: p.warnings,
          note: "Nothing has changed yet. The person reviews the proposal, can try it in a trial run that the console grades against its checks, and approves or rejects it. Tell them it's waiting for their review." });
      } catch (e) { return json(res, e.status || 400, { error: e.message, ...(e.errors ? { errors: e.errors } : {}) }); }
    }
    return json(res, 405, { error: "Not allowed." });
  }
  const why = rejectReason(req);
  if (why) {
    console.log(`${new Date().toISOString()} REJECTED ${req.method} ${String(req.url).split("?")[0]} — ${why} (origin=${req.headers.origin || "-"}, host=${req.headers.host || "-"})`); // no query: a callback's code never reaches the log
    res.writeHead(403, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: `Rejected: ${why}` }));
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (url.pathname === "/") { res.writeHead(200, { "content-type": TYPES[".html"] }); return res.end(readFileSync(join(HERE, "workspace.html"))); }
    if (url.pathname === "/console" && !HOSTED) { res.writeHead(200, { "content-type": TYPES[".html"] }); return res.end(readFileSync(join(HERE, "index.html"))); }
    if (parts[0] === "assets" && /^[\w.-]+$/.test(parts[1] || "") && parts.length === 2 && existsSync(join(HERE, "assets", parts[1]))) {
      res.writeHead(200, { "content-type": TYPES[extname(parts[1]).toLowerCase()] || "application/octet-stream" }); return res.end(readFileSync(join(HERE, "assets", parts[1])));
    }

    // Graceful self-stop for the dashboard's Worker Server dev-control toggle (worker-ui/devctl.mjs).
    // Goes through the same guard as every other state-changing route above. Responds first so the
    // caller sees success, then exits once the response has flushed.
    // Liveness for the gateway (no state, no secrets).
    if (url.pathname === "/__health" && req.method === "GET") return json(res, 200, { ok: true, hosted: HOSTED, activeRun: active()?.meta.id || null });
    // What the page adapts to: hosted or local, who is signed in, the model provider, and what the
    // platform doesn't provide here.
    if (url.pathname === "/platform" && req.method === "GET") return json(res, 200, { hosted: HOSTED, provider: PROVIDER.summary(),
      user: HOSTED ? { name: process.env.AIW_USER_NAME || null, email: process.env.AIW_USER_EMAIL || null } : null,
      unavailable: HOSTED ? Object.entries(HOSTED_OFF).map(([capability, reason]) => ({ capability, label: CAPABILITIES[capability].label, reason })) : [] });
    if (url.pathname === "/__control/shutdown" && req.method === "POST" && !HOSTED) {
      json(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 150);
      return;
    }

    // workspaces
    if (url.pathname === "/workspaces" && req.method === "GET") return json(res, 200, listWorkspaces());
    if (url.pathname === "/workspaces" && req.method === "POST") return json(res, 200, addWorkspace(await body(req)));
    if (url.pathname === "/workspaces/order" && req.method === "POST") return json(res, 200, reorderWorkspaces((await body(req)).ids));
    if (parts[0] === "workspaces" && parts[1] && parts.length === 2 && req.method === "DELETE") return json(res, 200, removeWorkspace(decodeURIComponent(parts[1])));
    if (url.pathname === "/pick-folder" && req.method === "POST") return json(res, 200, await pickFolder());

    // the Claude account the workers use, and its usage (read-only)
    if (url.pathname === "/account" && req.method === "GET") return json(res, 200, await accountReport(url.searchParams.get("refresh") === "1"));
    // the models this account can use, with the effort levels each takes (read-only)
    if (url.pathname === "/models" && req.method === "GET") return json(res, 200, { models: await modelCatalogue(url.searchParams.get("refresh") === "1"), efforts: EFFORTS });

    // GitHub: the one connection (its token goes in, never out), the repository registry, and
    // which workspace each repository is assigned to (docs/github.md)
    if (url.pathname === "/figma" && req.method === "GET") return json(res, 200, await figmaReport());
    if (url.pathname === "/figma/connection" && req.method === "POST") return json(res, 200, await figmaConnect((await body(req)).token));
    if (url.pathname === "/figma/connection" && req.method === "DELETE") return json(res, 200, figmaDisconnect());
    if (url.pathname === "/github" && req.method === "GET") return json(res, 200, ghReport());
    if (url.pathname === "/github/connection" && req.method === "POST") return json(res, 200, await ghConnect((await body(req)).token));
    if (url.pathname === "/github/connection/verify" && req.method === "POST") return json(res, 200, await ghVerify());
    if (url.pathname === "/github/connection" && req.method === "DELETE") return json(res, 200, await ghDisconnect());
    if (url.pathname === "/github/app/start" && req.method === "POST") return json(res, 200, ghAppStart(req));
    if (url.pathname === "/github/callback" && req.method === "GET") {
      const outcome = await ghAppCallback(req, url);
      res.writeHead(303, { location: `/?github=${outcome}`, "cache-control": "no-store", "referrer-policy": "no-referrer" }); return res.end();
    }
    if (url.pathname === "/github/discover" && req.method === "GET") return json(res, 200, { repos: await ghDiscover(url.searchParams.get("refresh") === "1") });
    if (url.pathname === "/github/repos" && req.method === "POST") return json(res, 200, await ghRegister((await body(req)).fullName));
    if (parts[0] === "github" && parts[1] === "repos" && parts[2] && parts.length === 4 && parts[3] === "refresh" && req.method === "POST") return json(res, 200, await ghRefresh(decodeURIComponent(parts[2])));
    if (parts[0] === "github" && parts[1] === "repos" && parts[2] && parts.length === 4 && parts[3] === "clone" && req.method === "POST") return json(res, 200, await cloneRepo(decodeURIComponent(parts[2]), await body(req)));
    if (parts[0] === "github" && parts[1] === "repos" && parts[2] && parts.length === 3 && req.method === "DELETE") return json(res, 200, ghRemove(decodeURIComponent(parts[2])));
    if (parts[0] === "workspaces" && parts[1] && parts[2] === "repo" && parts.length === 3 && req.method === "PUT") return json(res, 200, assignRepo(decodeURIComponent(parts[1]), await body(req)));
    if (parts[0] === "workspaces" && parts[1] && parts[2] === "repo" && parts.length === 3 && req.method === "DELETE") return json(res, 200, unassignRepo(decodeURIComponent(parts[1])));

    // worker drafts: the integrations registry, a draft for a request, creating the worker
    if (url.pathname === "/integrations" && req.method === "GET") return json(res, 200, { integrations: drafts.publicRegistry() });
    // The integration warehouse as the page reads it: core capabilities, each integration's newest
    // version (and its versions), one exact version, and recommendations for a request.
    if (url.pathname === "/catalog" && req.method === "GET") return json(res, 200, { core: catalog.coreCatalog().capabilities.map((c) => ({ id: c.id, label: CAPABILITIES[c.id].label, tools: CAPABILITIES[c.id].tools, summary: c.summary, profiles: CAPABILITIES[c.id].profiles, unavailable: offHere(c.id) ? HOSTED_OFF[c.id] : null })), integrations: catalog.latestAll().map((m) => drafts.publicManifest(m, packCatalog())) });
    if (parts[0] === "catalog" && parts[1] && parts[2] && req.method === "GET") { const m = catalog.get(parts[1], parts[2]); return m ? json(res, 200, drafts.publicManifest(m, packCatalog())) : json(res, 404, { error: `No ${parts[1]} ${parts[2]} in this console's catalogue.` }); }
    if (url.pathname === "/integrations/recommend" && req.method === "POST") { const b = await body(req); return json(res, 200, { items: drafts.recommend(String(b.text || "").slice(0, 4000), Array.isArray(b.current) ? b.current.map(String).slice(0, 20) : []) }); }
    if (url.pathname === "/worker-drafts/preview" && req.method === "POST") return json(res, 200, await draftPreview(await body(req)));
    if (url.pathname === "/workers/from-request" && req.method === "POST") {
      const b = await body(req), w = workerFromRequest(b);
      writeWorkers([...readWorkers(), w], { kind: "create", reason: "Created from a request" });
      // A Git workflow worker starts with a configuration from its answers (editable on its page).
      const g = w.fromRequest.integrations.includes("gitsync") ? w.fromRequest.answers.gitsync || {} : null;
      if (g) writeGitflowConfig(w.id, gitflow.initialConfig({ team: g.team, others: g.others, mappings: g.mappings, proposals: g.writes === "propose", workspace: typeof b.workspace === "string" ? b.workspace : "" }));
      return json(res, 200, w);
    }

    // The Git workflow of a worker with gitflow.read: its configuration, the commits a destination is
    // missing (with evidence), one commit, a simulated plan, an approved plan's execution (a new
    // branch only), and the audit trail. Everything Git-related is decided by worker-ui/gitflow.mjs.
    if (parts[0] === "gitflow" && parts[1]) {
      const w = readWorkers().find((x) => x.id === parts[1]);
      if (!w || !w.capabilities.includes("gitflow.read")) return json(res, 404, { error: "No Git workflow worker with that id." });
      const cfg = readGitflowConfig(w.id);
      if (GITFLOW_ENV.readOnly && gitflowWrites(parts, req.method)) return json(res, 403, { readOnly: true, error: "This console is read-only for the Git workflow (GITFLOW_READ_ONLY=1): nothing is created, pushed, deleted or fetched." });
      if (parts[2] === "config" && req.method === "GET") return json(res, 200, { config: cfg, strategies: gitflow.STRATEGIES, worker: { id: w.id, name: w.name }, env: GITFLOW_ENV });
      if (parts[2] === "config" && req.method === "PUT") {
        const next = gitflow.normalizeConfig(await body(req), cfg || {});
        if (next.source === "workspace" && next.workspace) resolveWorkspace(next.workspace);
        // A URL: cloned once into this worker's data (a different URL starts a new clone).
        if (next.source === "remote") {
          const d = join(gitflowDir(w.id), "remote.git");
          if (cfg?.url && cfg.url !== next.url && existsSync(d)) rmSync(d, { recursive: true, force: true });
          const r = await gitflow.cloneRemote(next.url, d, next.forbidden);
          if (r.cloned) gitflowAudit(w.id, { action: "clone", url: next.url });
        }
        // What changed, from what to what, and who changed it (the rules included: auditable).
        const changes = gitflow.configChanges(cfg, next);
        writeGitflowConfig(w.id, next);
        gitflowAudit(w.id, { action: "config", by: gitflowActor((() => { try { return gitflowRoot(w.id, next); } catch { return null; } })()), mappings: next.mappings.length, people: next.people.length, proposals: next.proposals, exclude: next.exclude, changes });
        return json(res, 200, { config: next });
      }
      if (!cfg) return json(res, 400, { error: "Set up the Git workflow first." });
      if (parts[2] === "audit" && req.method === "GET") return json(res, 200, { audit: gitflowEngine(w.id, cfg, true).auditLog() });
      const gf = gitflowEngine(w.id, cfg);
      const mapping = (id) => { const m = cfg.mappings.find((x) => x.id === id); if (!m) throw new Error("Choose one of the configured branch relationships."); return m; };
      // The repository as Setup shows it: where, its remotes, last fetch, real branches, suggested
      // relationships; its actual commit authors; fetching origin when the person asks.
      if (parts[2] === "repo" && req.method === "GET") { const info = await gf.repoInfo(); return json(res, 200, { ...info, suggestions: gf.suggestMappings(info.branches) }); }
      if (parts[2] === "authors" && req.method === "GET") {
        const info = await gf.repoInfo(), names = new Set(info.branches.map((b) => b.name));
        const wanted = [...new Set([...cfg.mappings.flatMap((m) => [m.source, m.destination]), ...cfg.shared])].filter((b) => names.has(b));
        return json(res, 200, { branches: wanted.length ? wanted : info.branches.slice(0, 10).map((b) => b.name), authors: await gf.authors(wanted.length ? wanted : info.branches.slice(0, 10).map((b) => b.name)) });
      }
      // A created proposal branch → pushed under its own name, and a pull request into the
      // destination (GitHub connected) or GitHub's link to open it. The person's second approval.
      if (parts[2] === "pr" && req.method === "POST") {
        const b = await body(req);
        return json(res, 200, await gf.openPullRequest(String(b.branch || ""), { createPullRequest: github.hasToken() ? github.createPullRequest : null, approvedBy: gitflowActor(gf.root) }));
      }
      // Who is at this console, for "Mine": this clone's Git identity and the configured person it matches.
      if (parts[2] === "identity" && req.method === "GET") {
        const i = gitIdentity(gf.root), em = i?.email?.toLowerCase();
        const p = i && (cfg.people.find((x) => em && x.emails.includes(em)) || cfg.people.find((x) => i.name && x.name.toLowerCase() === i.name.toLowerCase()));
        return json(res, 200, { identity: i, person: p ? { id: p.id, name: p.name, team: p.team } : null });
      }
      if (parts[2] === "fetch" && req.method === "POST") { const r = await gf.fetchOrigin(); gitflowAudit(w.id, { action: "fetch", by: gitflowActor(gf.root) }); return json(res, 200, r); }
      if (parts[2] === "analysis" && req.method === "GET") return json(res, 200, await gf.analyse(mapping(url.searchParams.get("mapping")), { scope: url.searchParams.get("scope") === "recent" ? "recent" : "pending" }));
      if (parts[2] === "commit" && parts[3] && req.method === "GET") return json(res, 200, await gf.commit(parts[3]));
      if (parts[2] === "preview" && req.method === "POST") { const b = await body(req); return json(res, 200, await gf.preview(mapping(b.mapping), { strategy: b.strategy, select: Array.isArray(b.select) ? b.select.slice(0, 200).map(String) : [] })); }
      if (parts[2] === "execute" && req.method === "POST") {
        // acknowledge: the ids of the plan's points the person confirmed (execute() wants exactly the plan's list).
        const b = await body(req), i = gitIdentity(gf.root) || {};
        const opts = { approvedBy: gitflowActor(gf.root), acknowledge: Array.isArray(b.acknowledge) ? b.acknowledge.slice(0, 200).map(String) : [], identity: { name: i.name || "", email: i.email || "" } };
        if (!b.async) return json(res, 200, await gf.execute(String(b.plan || ""), opts));
        // As a job: its steps are reported as they happen, and it can be cancelled until the branch is created.
        const job = { id: gitflow.newId(), worker: w.id, plan: String(b.plan || ""), state: "running", cancel: false, result: null, error: null,
          steps: [["recompute", "Recompute the plan from the branches as fetched (simulated in a private copy)"], ["check", "Check it's the approved plan and its confirmations"], ["create", "Create the new branch"], ["verify", "Check that no existing branch or ref changed"]].map(([id, label]) => ({ id, label, state: "waiting", at: null })) };
        gitflowJobs.set(job.id, job);
        gf.execute(job.plan, { ...opts, onStep: (id, state) => { const s = job.steps.find((x) => x.id === id); if (s) { s.state = state; s.at = new Date().toISOString(); } }, isCancelled: () => job.cancel })
          .then((r) => { job.state = "done"; job.result = r; }, (e) => { job.state = e.cancelled ? "cancelled" : "failed"; job.error = e.message; for (const s of job.steps) if (s.state === "running") s.state = job.state === "cancelled" ? "waiting" : "failed"; })
          .finally(() => setTimeout(() => gitflowJobs.delete(job.id), 15 * 60e3).unref?.());
        return json(res, 200, { job: job.id, steps: job.steps });
      }
      if (parts[2] === "jobs" && parts[3]) {
        const job = gitflowJobs.get(parts[3]);
        if (!job || job.worker !== w.id) return json(res, 404, { error: "No such job (finished jobs are kept for 15 minutes)." });
        if (parts[4] === "cancel" && req.method === "POST") {
          // Honoured only before anything is written: once the branch is being created it runs to the end.
          const started = job.steps.some((s) => (s.id === "create" || s.id === "verify") && s.state !== "waiting");
          if (job.state !== "running" || started) return json(res, 409, { error: job.state !== "running" ? `The job has already ${job.state === "done" ? "finished" : job.state}.` : "Too late to cancel: the branch is being created. It finishes and is checked; you can delete it afterwards." });
          job.cancel = true; return json(res, 200, { cancelling: true });
        }
        const { cancel, ...out } = job; return json(res, 200, { ...out, cancelRequested: cancel });
      }
      // A plan's result as a patch file (read from the private copy; nothing is written).
      if (parts[2] === "patch" && req.method === "GET") {
        const p = await gf.exportPatch(String(url.searchParams.get("plan") || ""));
        res.writeHead(200, { "content-type": "text/x-patch; charset=utf-8", "content-disposition": `attachment; filename="${p.name.replace(/[^\w.-]/g, "_")}"`, "x-plan-base": `${p.base.branch} ${p.base.tip}` });
        return res.end(p.text);
      }
      // Deleting a proposal branch the worker created (from the repository only; refused if it moved).
      if (parts[2] === "branch" && parts[3] === "delete" && req.method === "POST") { const b = await body(req); return json(res, 200, await gf.deleteBranch(String(b.branch || ""), { approvedBy: gitflowActor(gf.root) })); }
      // CI on GitHub for a pushed proposal branch: only when GitHub is connected and origin is on GitHub.
      if (parts[2] === "ci" && req.method === "GET") {
        const branch = String(url.searchParams.get("branch") || "");
        if (!/^gitflow\//.test(branch)) return json(res, 400, { error: "Only a proposal branch's CI is shown here." });
        if (!github.hasToken()) return json(res, 200, { available: false, reason: "GitHub isn't connected: see the checks on the pull request on GitHub." });
        const remote = (spawnSync("git", ["config", "--get", "remote.origin.url"], { cwd: gf.root, encoding: "utf8", windowsHide: true }).stdout || "").trim();
        const full = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote)?.[1];
        if (!full) return json(res, 200, { available: false, reason: "origin isn't on GitHub, so there's no CI status to read." });
        const sha = (spawnSync("git", ["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`], { cwd: gf.root, encoding: "utf8", windowsHide: true }).stdout || "").trim();
        if (!sha) return json(res, 404, { error: `${branch} isn't in the repository.` });
        return json(res, 200, { available: true, sha, ...(await github.ciStatus(full, sha)) });
      }
    }

    // workers: definitions (with live requirement status for a workspace) and their memory
    if (url.pathname === "/workers" && req.method === "GET") {
      let profile = "full"; try { profile = resolveWorkspace(url.searchParams.get("workspace") || "console").profile; } catch {}
      const workers = await Promise.all(readWorkers().map(async (w) => ({ ...w, status: await requirementStatus(w, { profile }), memoryCount: readMemory(w.id).length, runtime: workerRuntime(w, profile) })));
      return json(res, 200, { workers, profile,
        capabilities: Object.entries(CAPABILITIES).map(([id, c]) => ({ id, label: c.label, tools: c.tools, profiles: c.profiles, ...(offHere(id) ? { unavailable: HOSTED_OFF[id] } : {}) })),
        resources: Object.entries(RESOURCES).flatMap(([id, r]) => Object.entries(r.access).map(([access, a]) => ({ resource: id, access, label: `${r.label}: ${a.label}`, how: a.how }))),
        repos: readGithub().repos.map((r) => ({ id: r.id, fullName: r.fullName, status: r.status })), repoLevels: REPO_LEVELS.map((l) => ({ id: l, label: REPO_LEVEL_LABELS[l] })) });
    }
    if (url.pathname === "/workers" && req.method === "POST") { const w = normalizeWorker(await body(req)); writeWorkers([...readWorkers(), w], { kind: "create" }); return json(res, 200, w); }
    // Migrating workers made before integrations (schema 1): proposals (nothing changes), applying
    // them (workers.json is backed up first; a tool is added or removed only when the person accepts
    // that change), and undoing the last migration from its backup.
    if (url.pathname === "/migration" && req.method === "GET") return json(res, 200, { workers: readWorkers().filter((w) => !workerdef.isV2(w)).map((w) => migrate.proposeMigration(w)), backups: listBackups() });
    if (url.pathname === "/migration/apply" && req.method === "POST") return json(res, 200, applyMigration(await body(req)));
    if (url.pathname === "/migration/undo" && req.method === "POST") return json(res, 200, undoMigration(await body(req)));
    // The General worker: the core capabilities granted to it (it has no definition and no integrations).
    if (url.pathname === "/general" && req.method === "GET") return json(res, 200, { ...readGeneral(), why: catalog.coreCatalog().general.why, catalogue: catalog.coreCatalog().capabilities.map((c) => ({ id: c.id, label: CAPABILITIES[c.id].label, tools: CAPABILITIES[c.id].tools, summary: c.summary, profiles: CAPABILITIES[c.id].profiles })) });
    if (url.pathname === "/general" && req.method === "PUT") {
      const core = [...new Set(((await body(req)).core || []).map(String))];
      for (const c of core) if (!catalog.isCore(c)) throw Object.assign(new Error(`“${c}” isn't a core capability: the General worker can't have an integration's tools.`), { status: 400 });
      writeAtomic(GENERAL_FILE, JSON.stringify({ core, updatedAt: new Date().toISOString() }, null, 1)); return json(res, 200, readGeneral());
    }
    // What a run of this worker (or General) would start with in this workspace, without starting one:
    // planned (its definition and the workspace's limits) and effective (minus what its accounts don't allow now).
    if (url.pathname === "/access/preview" && req.method === "GET") {
      const ws = resolveWorkspace(url.searchParams.get("workspace") || "console"), wid = url.searchParams.get("worker") || "general";
      const def = wid === "general" ? generalDefinition() : readWorkers().find((w) => w.id === wid);
      if (!def) return json(res, 404, { error: "no such worker" });
      const protect = wsPolicies(ws.id), head = gitInfo(ws.root).branch;
      let repo = null; try { repo = def.id ? repoScope(ws, def) : null; } catch {}
      const scope = { protect, head, onProtected: !!head && protect.some((p) => p.branch === head), figmaKey: null, knowledgeDir: null, repo };
      const gate = await accountGate(def, { profile: ws.profile, root: ws.root, figmaKey: null }, workerRuntime(def, ws.profile, scope).usable);
      const planned = launchPlan(def, ws, scope), effective = launchPlan(def, ws, scope, gate);
      return json(res, 200, { worker: wid, workspace: ws.id, gate, waiting: Object.fromEntries(effective.rt.waiting), planned: { args: planned.args, servers: planned.servers, usable: planned.rt.usable }, effective: { args: effective.args, servers: effective.servers, usable: effective.rt.usable }, issues: def.resolution?.issues || [] });
    }
    // Importing a worker package: the file (base64, in JSON like every request that changes something)
    // is read and checked, then waits under a token while the person reviews it and sets up what it
    // needs here; installing it is a separate request.
    if (url.pathname === "/workerpacks/preview" && req.method === "POST") {
      const b = await body(req), data = String(b.data || "");
      if (data.length > Math.ceil(workerpack.LIMITS.package / 3) * 4 + 4) return json(res, 413, { code: "too-large", error: `The package is larger than ${Math.round(workerpack.LIMITS.package / 1024)} KB.` });
      let pkg; try { pkg = workerpack.readPackage(Buffer.from(data, "base64")); } catch (e) { return json(res, 400, { code: e.code || "malformed", error: e.message }); }
      return json(res, 200, { token: keepPack(pkg), package: { manifest: pkg.manifest, definition: pkg.definition, knowledge: pkg.knowledge, repositories: pkg.repositories, warnings: pkg.warnings, files: pkg.files }, plan: await packPlan(pkg, { workspace: b.workspace }) });
    }
    if (parts[0] === "workerpacks" && parts[1]) {
      const p = PENDING_PACKS.get(parts[1]);
      if (!p) return json(res, 404, { code: "expired", error: "This package's check has expired (after 30 minutes) or was already installed. Choose the file again." });
      if (parts[2] === "plan" && req.method === "GET") return json(res, 200, await packPlan(p.pkg, { workspace: url.searchParams.get("workspace") }));
      if (parts[2] === "install" && req.method === "POST") { const out = installPack(p.pkg, await body(req)); PENDING_PACKS.delete(parts[1]); return json(res, 200, out); }
    }
    if (parts[0] === "workers" && parts[1]) {
      const list = readWorkers(), i = list.findIndex((w) => w.id === parts[1]);
      if (i < 0) return json(res, 404, { error: "no such worker" });
      if (parts[2] === "memory") {
        if (req.method === "GET") return json(res, 200, readMemory(parts[1]));
        if (req.method === "DELETE") { const m = readMemory(parts[1]); if (parts[3] !== undefined) m.splice(Number(parts[3]), 1); else m.length = 0; writeMemory(parts[1], m); return json(res, 200, m); }
      }
      // ---- versions: every recorded version, one in full, a diff, and restoring one (a new version) ----
      if (parts[2] === "versions" && req.method === "GET") {
        const id = list[i].id, cur = storedOf(id);
        if (!parts[3]) {
          const used = allMetas().filter((m) => m.worker?.id === id).map((m) => ({ run: m.id, version: m.worker.version, ...(m.candidate ? { trial: m.candidate.proposal, baseline: !!m.candidate.baseline } : {}), prompt: clip(m.prompt, 120), at: m.createdAt }));
          return json(res, 200, { current: cur.version, recorded: !!readVersion(id, cur.version), integrity: integrityProblem(list[i]),
            versions: historyVersions(id).reverse().map((n) => { const r = readVersion(id, n); return { version: r.version, parent: r.parent, savedAt: r.savedAt, source: r.source, reason: r.reason, runs: used.filter((u) => u.version === n && !u.trial).length }; }), runs: used });
        }
        const rec = readVersion(id, parts[3]);
        if (!rec) return json(res, 404, { error: `Version ${parts[3]} of ${list[i].name} isn't recorded.` });
        if (parts[4] === "diff") {
          const to = url.searchParams.get("to"), other = !to || to === "current" ? cur : readVersion(id, to)?.definition;
          if (!other) return json(res, 404, { error: `Version ${to} isn't recorded.` });
          return json(res, 200, { from: rec.version, to: other.version, diff: evolve.diffStored(rec.definition, other) });
        }
        return json(res, 200, rec);
      }
      if (parts[2] === "restore" && req.method === "POST") {
        const b = await body(req), rec = readVersion(list[i].id, b.version);
        if (!rec) return json(res, 404, { error: `Version ${b.version} isn't recorded.` });
        if (rec.version === list[i].version) return json(res, 400, { error: `Version ${rec.version} is already the current one.` });
        // Through the same checks as any save: its tools, integrations and repositories must still be valid here.
        list[i] = normalizeWorker({ ...rec.definition, schema: rec.definition.schema === workerdef.SCHEMA ? workerdef.SCHEMA : 1 }, list[i]);
        writeWorkers(list, { kind: "restore", restoredFrom: rec.version, reason: String(b.reason || "") || `Restored version ${rec.version}` });
        return json(res, 200, readWorkers().find((w) => w.id === list[i].id));
      }
      // ---- proposals: listing, one with its diff and state, and the person's decisions ----
      if (parts[2] === "proposals") {
        const id = list[i].id;
        if (!parts[3] && req.method === "GET") return json(res, 200, { proposals: listProposals(id).map(proposalView) });
        const p = parts[3] && readProposal(id, parts[3]);
        if (!p) return json(res, 404, { error: "No such proposal." });
        if (!parts[4] && req.method === "GET") return json(res, 200, proposalView(p));
        if (req.method === "POST" && ["trial", "grade", "approve", "reject", "recheck"].includes(parts[4])) {
          const b = await body(req), cur = storedOf(id);
          // Records are files: a proposal changed outside the console isn't tried, graded or approved,
          // and neither is one for a worker whose own definition was (approving it would record that
          // outside change as a legitimate version).
          if (["trial", "grade", "approve"].includes(parts[4])) {
            const bad = evolve.storedProblem(p, cur), why = bad ? `This proposal's record was changed outside the console (${bad}). It can't be used: reject it, and ask the worker to propose again.` : parts[4] !== "grade" && integrityProblem(list[i]);
            if (why) return json(res, 409, { code: "integrity", error: why });
          }
          if (parts[4] === "grade") {
            const t = (p.trials || []).find((x) => x.run === String(b.run || ""));
            if (!t) return json(res, 404, { error: "That run isn't a trial of this proposal." });
            const r = loadRun(t.run);
            if (!r) return json(res, 404, { error: "That trial run's record is gone." });
            if (["starting", "running"].includes(r.meta.status)) return json(res, 409, { error: "The trial run is still working: grade it when its turn has ended." });
            const events = readFileSync(r.file, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
            const results = await evolve.grade(p.checks, { events, since: Date.parse(t.startedAt), builder: builderReader });
            t.grade = { at: new Date().toISOString(), results, ok: results.length > 0 && results.every((x) => x.ran && x.ok) };
            p.dependencies = await proposalDependencies(p, list[i]);
            writeProposal(p); return json(res, 200, proposalView(p));
          }
          if (parts[4] === "recheck") { p.dependencies = await proposalDependencies(p, list[i]); writeProposal(p); return json(res, 200, proposalView(p)); }
          if (p.status !== "proposed") return json(res, 400, { error: `This proposal was already ${p.status}.` });
          if (parts[4] === "reject") { p.status = "rejected"; p.decision = { at: new Date().toISOString(), by: "person", reason: String(b.reason || "").slice(0, 500) }; writeProposal(p); return json(res, 200, proposalView(p)); }
          // Trying or approving it only makes sense against the version it was made for.
          if (cur.version !== p.base) return json(res, 409, { code: "stale", error: `This proposal was made for version ${p.base}; the worker is at version ${cur.version} now. It can't be applied over the newer version: ask the worker to propose again against it.` });
          if (parts[4] === "trial") {
            if ((p.trials || []).length >= evolve.MAX_TRIALS) return json(res, 400, { error: `At most ${evolve.MAX_TRIALS} trial runs per proposal.` });
            const prompt = String(b.prompt || p.trialPrompt || "").trim();
            if (!prompt) return json(res, 400, { error: "Give the task the trial run should do." });
            const baseline = b.baseline === true;
            const definition = baseline ? list[i] : workerdef.resolve(evolve.applyChanges(cur, p.changes));
            const run = await newRun(prompt, String(b.workspace || "scratch"), [], id, [], null, {}, { candidate: { proposal: p.id, baseline, definition } });
            (p.trials ||= []).push({ run: run.meta.id, baseline, prompt, startedAt: run.meta.createdAt }); writeProposal(p);
            return json(res, 200, { run: run.meta.id, baseline, proposal: proposalView(p) });
          }
          // approve: a new recorded version of the worker, made from the version it was proposed for.
          const view = proposalView(p), v = view.verification, why = [...(v.status === "passed" ? [] : [`it isn't verified (${v.status}: ${v.why})`]), ...p.warnings];
          if (why.length && b.acknowledge !== true) return json(res, 400, { code: "acknowledge", error: `Approving this needs your explicit acknowledgement: ${why.join("; ")}.`, reasons: why });
          list[i] = normalizeWorker({ ...evolve.applyChanges(cur, p.changes), schema: cur.schema === workerdef.SCHEMA ? workerdef.SCHEMA : 1 }, list[i]);
          writeWorkers(list, { kind: "proposal", proposal: p.id, reason: p.title, verification: { status: v.status, why: v.why, ...(v.run ? { run: v.run } : {}) } });
          const now = readWorkers().find((w) => w.id === id);
          p.status = "approved"; p.decision = { at: new Date().toISOString(), by: "person", version: now.version, acknowledged: why.length ? why : null, verification: v, reason: String(b.reason || "").slice(0, 500) };
          writeProposal(p); return json(res, 200, { worker: now, proposal: proposalView(p) });
        }
      }
      if (!parts[2] && req.method === "PUT") {
        const b = await body(req);
        // A worker made before integrations becomes schema 2 only through its migration.
        if (b.schema === workerdef.SCHEMA && !workerdef.isV2(list[i])) throw Object.assign(new Error("This worker was made before integrations: review its migration first."), { status: 400 });
        list[i] = normalizeWorker(b, list[i]); writeWorkers(list, { kind: "edit", reason: b.reason }); return json(res, 200, readWorkers().find((w) => w.id === list[i].id));
      }
      // Upgrading one of its integrations to a newer version: what changes, then (approved) the change.
      if (parts[2] === "upgrades" && req.method === "GET") {
        if (!workerdef.isV2(list[i])) return json(res, 200, { upgrades: [] });
        return json(res, 200, { upgrades: list[i].integrations.flatMap((r) => { const l = catalog.latest(r.id); if (!l || (catalog.get(r.id, r.version) && catalog.cmpVersion(l.version, r.version) <= 0)) return []; try { return [migrate.upgradeDiff(list[i], r.id, l.version)]; } catch (e) { return [{ integration: r.id, from: r.version, to: l.version, error: e.message }]; } }) });
      }
      if (parts[2] === "upgrade" && req.method === "POST") {
        const b = await body(req);
        if (!workerdef.isV2(list[i])) throw Object.assign(new Error("This worker was made before integrations: review its migration first."), { status: 400 });
        const { worker, diff } = migrate.applyUpgrade(list[i], String(b.integration || ""), String(b.to || ""), { approveExpansion: b.approveExpansion === true });
        list[i] = normalizeWorker({ ...worker, schema: workerdef.SCHEMA }, list[i]); writeWorkers(list, { kind: "upgrade", reason: `${diff.label} ${diff.from} → ${diff.to}` }); list[i] = readWorkers().find((w) => w.id === list[i].id);
        return json(res, 200, { worker: list[i], diff });
      }
      // Export: what the package would contain (and what it wouldn't), then the package itself.
      if (parts[2] === "export" && req.method === "GET") {
        const b = packWorker(list[i]);
        if (parts[3] === "preview") return json(res, 200, { name: list[i].name, file: packFile(list[i]), preview: b.preview, dependencies: b.dependencies, definition: b.definition, knowledgeChars: b.knowledge.length, gitflow: b.gitflow, memoryCount: readMemory(list[i].id).length });
        if (b.preview.secrets.length) return json(res, 400, { code: "secrets", error: `Not exported: ${b.preview.secrets.join(", ")} ${b.preview.secrets.length === 1 ? "contains" : "contain"} what looks like a password or token. Remove it from the worker first.` });
        const bytes = workerpack.packBytes(b);
        res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${packFile(list[i])}"`, "x-content-type-options": "nosniff", "cache-control": "no-store" });
        return res.end(bytes);
      }
      // Clone: the same package and checks as an export, installed here as a new, independent worker.
      if (parts[2] === "clone" && req.method === "POST") {
        const b = await body(req), pkg = workerpack.readPackage(workerpack.packBytes(packWorker(list[i], true)));
        return json(res, 200, installPack(pkg, { name: String(b.name || "").trim() || freeName(`${list[i].name.slice(0, 53)} (copy)`), gitflowWorkspace: b.gitflowWorkspace ?? readGitflowConfig(list[i].id)?.workspace ?? "", sourceId: list[i].id }, "clone"));
      }
      // Its runs keep their snapshots (definition and context), so they stay readable and resumable.
      if (!parts[2] && req.method === "DELETE") {
        const [gone] = list.splice(i, 1); writeWorkers(list, { kind: "delete" }); if (existsSync(memPath(gone.id))) writeFileSync(memPath(gone.id), "[]");
        for (const t of readTeams().filter((x) => x.workers.includes(gone.id))) saveTeam({ ...t, workers: t.workers.filter((w) => w !== gone.id) }, t.id);
        return json(res, 200, { deleted: gone.id });
      }
    }

    // teams: definitions with live requirement status, uploaded knowledge (read-only), versions
    if (url.pathname === "/teams" && req.method === "GET") {
      const teams = await Promise.all(readTeams().map(async (t) => {
        let ctx = { profile: "full", root: null }; try { const w = resolveWorkspace(teamWorkspace(t)); ctx = { profile: w.profile, root: w.root }; } catch {}
        return { ...t, status: await requirementStatus(t, ctx), profile: ctx.profile, workspaceOk: !!ctx.root };
      }));
      return json(res, 200, { teams, enforceable: Object.entries(ENFORCEABLE).map(([type, label]) => ({ type, label })) });
    }
    if (url.pathname === "/teams" && req.method === "POST") return json(res, 200, saveTeam(await body(req)));
    if (parts[0] === "teams" && parts[1]) {
      const t = readTeams().find((x) => x.id === parts[1]);
      if (!t) return json(res, 404, { error: "no such Team" });
      if (parts[2] === "knowledge" && parts[3] && req.method === "GET") {
        const k = t.knowledge.find((x) => x.id === parts[3] && x.type === "upload");
        const p = k && fileInside(teamPath(t.id, "knowledge"), k.file);
        if (!p) { res.writeHead(404); return res.end("not found"); }
        const buf = readFileSync(p);
        res.writeHead(200, { "content-type": sniff(buf).mime, "content-security-policy": "sandbox", "x-content-type-options": "nosniff" });
        return res.end(buf);
      }
      if (parts[2] === "versions" && req.method === "GET") {
        const dir = teamPath(t.id, "history");
        const versions = existsSync(dir) ? readdirSync(dir).filter((f) => /^v\d+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
          .map(({ version, updatedAt }) => ({ version, updatedAt })).sort((a, b) => b.version - a.version) : [];
        const used = allMetas().filter((m) => m.team?.id === t.id).map((m) => ({ id: m.id, version: m.team.version, worker: m.worker?.name, prompt: m.prompt, status: m.status }));
        return json(res, 200, { versions, runs: used });
      }
      if (!parts[2] && req.method === "PUT") return json(res, 200, saveTeam(await body(req), t.id));
      if (!parts[2] && req.method === "DELETE") return json(res, 200, deleteTeam(t.id));
    }

    // versions (git)
    const W = url.searchParams.get("workspace") || "";
    if (url.pathname === "/git" && req.method === "GET") return json(res, 200, await gitSummary(W));
    if (url.pathname === "/git/version" && req.method === "GET") return json(res, 200, await gitVersion(W, url.searchParams.get("rev")));
    if (url.pathname === "/git/diff" && req.method === "GET") return json(res, 200, { diff: await gitDiff(W, url.searchParams.get("rev"), url.searchParams.get("path")) });
    if (url.pathname === "/git/file" && req.method === "GET") {
      const text = await gitFileAt(W, url.searchParams.get("rev"), url.searchParams.get("path"));
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-security-policy": "sandbox", "x-content-type-options": "nosniff" }); return res.end(text);
    }
    if (url.pathname === "/git/commit" && req.method === "POST") { const b = await body(req); return json(res, 200, await gitCommit(String(b.workspace || ""), b.message, b.run)); }
    if (url.pathname === "/git/push" && req.method === "POST") { const b = await body(req); return json(res, 200, await gitPush(String(b.workspace || ""), b.run)); }
    // Files of a workspace, or of one run (a scratch conversation's own folder). Scratch itself has
    // no files to list: each conversation's are its own.
    const filesRoot = () => {
      if (url.searchParams.has("run")) { const run = loadRun(url.searchParams.get("run")); if (!run) throw Object.assign(new Error("No such run."), { status: 404 }); return checkBinding(run, { resume: false }).root; }
      const id = url.searchParams.get("workspace") || "";
      return id === "scratch" ? null : resolveWorkspace(id).root;
    };
    if (url.pathname === "/mentions" && req.method === "GET") { const root = filesRoot(); return json(res, 200, { workspace: W, ...(root ? await searchFiles(root, url.searchParams.get("q")) : { files: [], note: "A new scratch conversation starts with an empty folder: there are no files to reference yet." }) }); }
    if (url.pathname === "/tree") {
      const root = filesRoot();
      if (!root) return json(res, 200, []);
      const entries = dirInside(root, url.searchParams.get("path") || "");
      return entries ? json(res, 200, entries) : json(res, 404, { error: "not found" });
    }

    // runs
    if (url.pathname === "/runs" && req.method === "GET") return json(res, 200, { runs: allMetas(), active: active()?.meta.id || null });
    if (url.pathname === "/runs" && req.method === "POST") {
      const b = await body(req);
      const { prompt, workspace, attachments } = b;
      const atts = readAttachments(attachments);
      if (!prompt?.trim() && !atts.length) throw new Error("Empty message");
      // A Team run happens in the Team's workspace; naming another one is refused (in newRun).
      const team = b.team ? readTeams().find((t) => t.id === String(b.team)) : null;
      if (b.team && !team) throw new Error(`No Team "${b.team}".`);
      const wsIdArg = workspace === undefined ? (team ? teamWorkspace(team) : HOSTED ? "scratch" : "console") : String(workspace);
      const mentions = wsIdArg === "scratch" ? (b.mentions || []).slice(0, 20).map((m) => ({ path: String(m.path || ""), exists: false })) : resolveMentions(resolveWorkspace(wsIdArg).root, b.mentions); // a new scratch folder is empty
      const settings = b.model != null || b.effort != null ? await checkRunSettings({ model: b.model, effort: b.effort }) : {};
      return json(res, 200, (await newRun(String(prompt || "").trim(), wsIdArg, atts, b.worker ? String(b.worker) : null, mentions, team?.id || null, settings)).meta);
    }
    if (parts[0] === "runs" && parts[1]) {
      const run = loadRun(parts[1]);
      if (!run) return json(res, 404, { error: "no such run" });
      const action = parts[2];
      if (!action && req.method === "GET") return json(res, 200, run.meta);
      if (action === "state" && req.method === "GET") return json(res, 200, run.state || readTaskState(run.meta.id) || null);
      // An attachment of this run, shown back in the conversation: read-only, never run.
      if (action === "att" && req.method === "GET") {
        const name = decodeURIComponent(parts[3] || "");
        const p = /^[\w.\- ()]+$/.test(name) && fileInside(attDir(run), name);
        if (!p) { res.writeHead(404); return res.end("not found"); }
        const buf = readFileSync(p);
        res.writeHead(200, { "content-type": sniff(buf).mime, "content-security-policy": "sandbox", "x-content-type-options": "nosniff" });
        return res.end(buf);
      }
      // Actions change state, so they're POST-only (a GET would skip the request guard).
      if (action && req.method !== "POST") return json(res, 405, { error: "Use POST" });
      // Switch the model or effort of this run. A live worker switches at once (the runtime's own
      // set_model / effort setting); either way the run keeps the choice, so a resume starts with it.
      if (action === "settings") {
        const b = await body(req);
        const s = await checkRunSettings({ model: b.model, effort: b.effort }, run.meta.model);
        if (!Object.keys(s).length) throw new Error("Choose a model or an effort level.");
        const live = alive(run);
        if (live && s.model) run.child.stdin.write(JSON.stringify({ type: "control_request", request_id: `model-${Date.now()}`, request: { subtype: "set_model", model: s.model } }) + "\n");
        if (live && s.effort) run.child.stdin.write(JSON.stringify({ type: "control_request", request_id: `effort-${Date.now()}`, request: { subtype: "apply_flag_settings", settings: { effortLevel: s.effort } } }) + "\n");
        Object.assign(run.meta, s);
        // a model that doesn't take the run's effort level (Haiku takes none) drops it
        const now = (models.list || []).find((m) => m.value === (run.meta.model || "default"));
        if (now && run.meta.effort && !now.efforts.includes(run.meta.effort)) delete run.meta.effort;
        saveMeta(run);
        const name = now?.displayName || run.meta.model || "Default";
        emit(run, { type: "settings", summary: `${name}${run.meta.effort ? ` · effort ${run.meta.effort}` : ""}`, detail: JSON.stringify({ ...s, live }) });
        return json(res, 200, run.meta);
      }
      // Compact this conversation (Claude Code's /compact) or continue the work in a fresh session.
      if (action === "compact" || action === "continue") {
        if (["starting", "running"].includes(run.meta.status)) throw new Error("The worker is in the middle of a step. Wait until it's waiting for you, or stop it first.");
        if (run.pendingContinue) throw new Error("A continuation is already being prepared.");
        if (run.meta.continuedIn) throw new Error(`This work already continues in run ${run.meta.continuedIn}.`);
        const b = await body(req);
        if (action === "compact") { followUp(run, `/compact ${COMPACT_KEEP}${b.instructions ? " Also: " + clip(String(b.instructions), 500) : ""}`, [], [], { as: "compact" }); return json(res, 200, run.meta); }
        run.pendingContinue = { instruction: b.instruction ? String(b.instruction).slice(0, 4000) : "" };
        if (b.summary === false) { await finishContinue(run, null); return json(res, 200, run.meta); }
        try { followUp(run, HANDOFF_PROMPT, [], [], { as: "handoff" }); } catch (e) { run.pendingContinue = null; throw e; }
        return json(res, 200, run.meta);
      }
      if (action === "message") {
        const { text, attachments, mentions: ms } = await body(req);
        const atts = readAttachments(attachments);
        if (!text?.trim() && !atts.length) throw new Error("Empty message");
        const target = latestInChain(run);
        const mentions = resolveMentions(checkBinding(target, { resume: false }).root, ms); // the run's own workspace
        return json(res, 200, sendMessage(run, String(text || "").trim(), atts, mentions));
      }
      if (action === "stop") {
        if (alive(run)) { run.stopRequested = true; run.child.kill(); return json(res, 200, run.meta); }
        // Nothing to kill: say so, and make sure the run no longer claims to be working.
        if (["starting", "running", "waiting"].includes(run.meta.status)) setStatus(run, "interrupted", "the worker process was already gone");
        return json(res, 409, { error: "Nothing is running: the worker had already stopped. Reply to continue the conversation.", status: run.meta.status });
      }
      // Check connections now (the person's button): what came up is turned on at once.
      if (action === "recheck") {
        if (!alive(run) || !run.authz) return json(res, 409, { error: "The worker isn't running. Its connections are checked when the conversation continues." });
        await refreshLive(run, { force: true });
        const a = run.authz, label = (c) => CAPABILITIES[c]?.label || c;
        return json(res, 200, { connected: [...a.live].filter(liveCap).map(label), waiting: [...a.caps].filter((c) => liveCap(c) && !a.live.has(c)).map((c) => ({ label: label(c), why: a.why[c] || "checking" })) });
      }
      // Reload tools: for a runtime that didn't pick up a change. Ends the process between turns; the
      // next message resumes the same conversation in a new one, with what's connected then.
      if (action === "reload-tools") {
        if (!alive(run)) return json(res, 409, { error: "The worker isn't running. Its tools are loaded again when you reply." });
        if (run.meta.status !== "waiting") throw new Error("The worker is in the middle of a step. Wait until it's waiting for you.");
        run.reloadRequested = true; run.child.stdin.end();
        return json(res, 200, run.meta);
      }
      if (action === "end") { if (alive(run)) { run.endRequested = true; run.child.stdin.end(); } return json(res, 200, run.meta); }
      if (action === "restart") return json(res, 200, (await newRun(run.meta.prompt, checkBinding(run, { resume: false }).id, [], run.meta.worker?.id || null, [], run.meta.team?.id || null, { model: run.meta.model, effort: run.meta.effort })).meta);
    }
    if (url.pathname === "/events") {
      const run = loadRun(url.searchParams.get("run") || "");
      if (!run) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      for (const line of readFileSync(run.file, "utf8").split("\n")) if (line) res.write(`data: ${line}\n\n`);
      const id = run.meta.id;
      if (!listeners.has(id)) listeners.set(id, new Set());
      listeners.get(id).add(res);
      req.on("close", () => listeners.get(id).delete(res));
      return;
    }

    // prompt library
    if (url.pathname === "/prompts" && req.method === "GET") return json(res, 200, readPrompts());
    if (url.pathname === "/prompts" && req.method === "POST") {
      const { title, text, favourite } = await body(req);
      if (!text?.trim()) throw new Error("Empty prompt");
      const p = { id: randomUUID(), title: (title || text).trim().slice(0, 80), text: text.trim(), favourite: !!favourite, createdAt: new Date().toISOString() };
      writePrompts([...readPrompts(), p]);
      return json(res, 200, p);
    }
    if (parts[0] === "prompts" && parts[1]) {
      const all = readPrompts();
      const i = all.findIndex((p) => p.id === parts[1]);
      if (i < 0) return json(res, 404, { error: "no such prompt" });
      if (req.method === "PUT") { const b = await body(req); all[i] = { ...all[i], ...("title" in b ? { title: b.title } : {}), ...("text" in b ? { text: b.text } : {}), ...("favourite" in b ? { favourite: !!b.favourite } : {}), updatedAt: new Date().toISOString() }; writePrompts(all); return json(res, 200, all[i]); }
      if (req.method === "DELETE") { all.splice(i, 1); writePrompts(all); return json(res, 200, { deleted: parts[1] }); }
    }

    // file viewer: a file inside this repo, a run's workspace (?run=<id>) or a workspace (?workspace=<id>)
    if (url.pathname === "/file") {
      const run = url.searchParams.has("run") ? loadRun(url.searchParams.get("run")) : null;
      if (url.searchParams.has("run") && !run) { res.writeHead(404); return res.end("not found"); }
      if (!run && url.searchParams.get("workspace") === "scratch") { res.writeHead(404); return res.end("not found"); } // scratch files belong to their conversation: ?run=
      if (!run && !url.searchParams.has("workspace") && HOSTED) { res.writeHead(404); return res.end("not found"); } // the platform's own files aren't anyone's workspace
      const root = run ? checkBinding(run, { resume: false }).root : url.searchParams.has("workspace") ? resolveWorkspace(url.searchParams.get("workspace")).root : REPO;
      const p = fileInside(root, url.searchParams.get("path") || "");
      if (!p) { res.writeHead(404); return res.end("not found"); }
      // Files are shown, never run: an HTML or SVG file opened directly gets an opaque origin with
      // scripts disabled, so it can't act as this console (its requests would carry Origin: null).
      res.writeHead(200, { "content-type": TYPES[extname(p).toLowerCase()] || "text/plain; charset=utf-8", "content-security-policy": "sandbox", "x-content-type-options": "nosniff" });
      return res.end(readFileSync(p));
    }
    res.writeHead(404); res.end("not found");
  } catch (e) {
    json(res, e instanceof github.GitHubError ? ghStatus(e) : e.status >= 400 && e.status < 600 ? e.status : 400, { error: e.message, ...(e.errors ? { errors: e.errors } : {}), ...(e.activeRun ? { activeRun: e.activeRun } : {}) });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Worker Console on http://localhost:${PORT} (worker binary: ${CLAUDE.cmd}${CLAUDE.shell ? " via shell" : ""}; Claude config dir: ${CONFIG_DIR}; model provider: ${PROVIDER.id}${HOSTED ? "; hosted" : ""})`));

// Hosted, commits made here (the person's, and a worker's through the repo tools) carry the signed-in
// person's name and email: their own Git identity in their own home folder.
if (HOSTED && process.env.AIW_USER_EMAIL) {
  for (const [k, v] of [["user.name", process.env.AIW_USER_NAME || process.env.AIW_USER_EMAIL], ["user.email", process.env.AIW_USER_EMAIL]]) spawnSync("git", ["config", "--global", k, v], { env: gitEnv(), windowsHide: true });
}
// Shutting down (the gateway stopping, a deploy): a live run's worker process is stopped and the run
// says it was interrupted, so its history is complete and a message continues it after the restart.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return; shuttingDown = true;
  const live = [...runs.values()].filter(alive);
  for (const run of live) { run.bindingError = null; run.stopRequested = false; run.shutdown = true; setStatus(run, "interrupted", `the console was shut down (${signal}); send a message to continue`); run.child.kill(); }
  setTimeout(() => process.exit(0), live.length ? 1500 : 0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
