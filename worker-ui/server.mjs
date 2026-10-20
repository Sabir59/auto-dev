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
  ...["ping", "get_file_info", "list_pages", "get_selection", "search_nodes", "get_document_state", "get_variables", "get_styles", "get_icon_components", "get_component_tree", "get_screen_tree", "get_prototype"].map((t) => `mcp__figma-executor__figma_${t}`),
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
// MCP config per profile, with absolute paths (the worker's cwd is its workspace, not this repo).
const mcpConfig = (profile) => {
  const file = join(DATA, `mcp.${profile}.json`);
  writeFileSync(file, JSON.stringify({ mcpServers: {
    "figma-executor": { command: process.execPath, args: [join(REPO, "mcp", "server.mjs")], ...(FIGMA_LEGACY ? { env: { FIGMA_EXECUTOR_LEGACY: "1" } } : {}) },
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
};
// A Team's Figma resource locks the Figma tools of its runs to that one file: the Executor refuses
// commands while another file is open, and the Reader refuses links to other files.
const MCP_SERVERS = {
  "figma-executor": (profile, scope = {}) => ({ command: process.execPath, args: [join(REPO, "mcp", "server.mjs")], ...(scope.figmaKey || FIGMA_LEGACY ? { env: { ...(scope.figmaKey ? { FIGMA_EXPECTED_FILE_KEY: scope.figmaKey } : {}), ...(FIGMA_LEGACY ? { FIGMA_EXECUTOR_LEGACY: "1" } : {}) } } : {}) }),
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
  const deny = [...(lockGit ? PROTECT_DENY : []), ...readOnly.map((d) => `Edit(${denyPath(d)}/**)`), ...(HOSTED ? hostedDeny() : [])];
  const settings = deny.length ? JSON.stringify({ ...JSON.parse(WORKER_SETTINGS), permissions: { deny: [...LOOPBACK_FETCH_DENY, ...deny] } }) : WORKER_SETTINGS;
  const dirs = [...exportsDirs, ...readOnly];
  return { usable, blocked: def.capabilities.filter((c) => !allowed.includes(c) && !offHere(c)), byPlatform: def.capabilities.filter(offHere), byPolicy: allowed.filter((c) => policyOff.has(c)), servers, exportsDirs, repoTools,
    args: ["--settings", settings, ...base, "--tools", builtins.join(","), "--allowedTools", ...allow, ...(dirs.length ? ["--add-dir", ...dirs] : []), "--permission-prompts", "none"] };
}
// Hosted, a worker never reads or writes the person's integration credentials (GitHub, Figma,
// Builder) or the runtime's session transcripts, and never edits the console's own records (worker
// and Team definitions, workspaces, run logs): its capabilities can't be changed from inside a run.
// Enforced by the runtime's permission rules; the OS boundary (the person's own uid) is beneath it.
function hostedDeny() {
  const secret = [github.CRED_DIR, FIGMA_CRED_DIR, builderApi.CRED_DIR, CONFIG_DIR].map((d) => denyPath(d));
  return [...secret.flatMap((d) => [`Read(${d}/**)`, `Edit(${d}/**)`]),
    ...["*.json", "*.md", "runs/**", "workers/**", "teams/**"].map((p) => `Edit(${denyPath(DATA)}/${p})`)];
}
// The general worker, as a definition: what it gets when a policy means it can't run on the plain
// profile flags (every capability the profile allows, except the ones the policy turns off).
const GENERAL = { id: null, name: "General", capabilities: ["files.read", "files.write", "web", "browser", "figma.plugin.read", "figma.plugin.edit"], workflow: [], limitations: [], requirements: [] };

// Requirements are generic {resource, access, need}; this registry knows how to check each one
// now, without showing any secret. A missing requirement doesn't block the run: the worker is
// told, and the tools themselves refuse without access.
let figmaCheck = { at: 0, value: null }, builderCheck = { at: 0, value: null };
const RESOURCES = {
  figma: { label: "Figma", access: {
    read: { label: "read designs", how: HOSTED ? "Connect Figma on the Figma page (a Figma personal access token with file_content:read). The connected account must be able to open the file." : "Connect Figma on this computer once: a Figma personal access token with file_content:read, or the OAuth flow (figma-reader/README.md). The connected account must be able to open the file.",
      async check() {
        if (!existsSync(FIGMA_CRED_FILE)) return { ok: false, state: "Not connected" };
        if (Date.now() - figmaCheck.at < 300000 && figmaCheck.value) return figmaCheck.value;
        let v; try { const me = await figmaApi("/v1/me"); v = { ok: true, state: "Connected", detail: me.handle ? `as ${me.handle}` : "" }; }
        catch (e) { v = { ok: false, state: e.status === 401 || e.status === 403 ? "Authorization rejected" : "Can't verify", detail: clip(e.message, 120) }; }
        figmaCheck = { at: Date.now(), value: v }; return v;
      } },
    edit: { label: "change the open file", how: HOSTED ? HOSTED_OFF["figma.plugin.edit"] : "Open the Figma file and run the AI Executor plugin, so it connects to the bridge.",
      async check() {
        if (HOSTED) return { ok: false, state: "Not available in the hosted product" };
        try { const r = await fetch("http://127.0.0.1:8787/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "PING", params: {} }), signal: AbortSignal.timeout(2500) }); const j = await r.json(); return j.ok ? { ok: true, state: "Connected" } : { ok: false, state: "Plugin not running" }; }
        catch { return { ok: false, state: "Bridge not running" }; }
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
        if (Date.now() - builderCheck.at < 300000 && builderCheck.value) return builderCheck.value;
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

const readWorkers = () => (existsSync(WORKERS) ? JSON.parse(readFileSync(WORKERS, "utf8")) : []);
const writeWorkers = (list) => { writeFileSync(WORKERS + ".tmp", JSON.stringify(list, null, 1)); renameSync(WORKERS + ".tmp", WORKERS); };
const lines = (v, max, len) => (Array.isArray(v) ? v : String(v || "").split(/\r?\n/)).map((x) => String(x).trim()).filter(Boolean).slice(0, max).map((x) => x.slice(0, len));
// Everything the person can set, checked: unknown capabilities or requirements are refused.
function normalizeWorker(b, prev) {
  const name = String(b.name || "").trim();
  if (!name || name.length > 60) throw new Error("Give the worker a name (up to 60 characters).");
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
    version: (prev?.version || 0) + 1, createdAt: prev?.createdAt || now, updatedAt: now };
}
// Memory: what a worker chose to remember from its work (REMEMBER: lines), kept apart from its
// definition, shown to the person, and given to its later runs as a labelled section.
const memPath = (id) => join(MEMORY, `${id}.memory.json`);
const readMemory = (id) => (/^[\w-]+$/.test(id) && existsSync(memPath(id)) ? JSON.parse(readFileSync(memPath(id), "utf8")) : []);
const writeMemory = (id, list) => { mkdirSync(MEMORY, { recursive: true }); writeFileSync(memPath(id), JSON.stringify(list, null, 1)); };
const SECRETISH = /(figd_|ghp_|github_pat_|sk-[a-z0-9]|xox[bp]-|AKIA[0-9A-Z]{8}|-----BEGIN|password\s*[:=]|api[_-]?key\s*[:=]|token\s*[:=])/i;

// The worker's context for one run: the shared instructions, then this worker, then what was
// checked at start, then its memory. Written once per run and kept, so the run never changes
// under an edited definition.
function workerContext(def, rt, status, memory, profile, extra = {}) {
  const cap = (c) => `- ${CAPABILITIES[c].label} (${CAPABILITIES[c].tools})`;
  return [platformInstructions(), "",
    workspaceSection(extra.workspace), teamSection(extra.team),
    `# You are: ${def.name}`, def.mission && `Mission: ${def.mission}`, def.specialization && `Specialization: ${def.specialization}`, "",
    "## What you can use in this run", rt.usable.length ? rt.usable.map(cap).join("\n") : "- Nothing beyond reading this context.",
    rt.blocked.length ? `Not available here (this workspace is ${profile === "inspect" ? "Inspect, read-only" : "Work"}): ${rt.blocked.map((c) => CAPABILITIES[c].label).join(", ")}.` : "",
    rt.byPlatform?.length ? `Not available in the hosted product: ${rt.byPlatform.map((c) => CAPABILITIES[c].label).join(", ")}. If the task needs one, write a NEEDS: line for it.` : "",
    rt.byPolicy?.length ? `Turned off by an enforced policy in this workspace: ${rt.byPolicy.map((c) => CAPABILITIES[c].label).join(", ")}.` : "",
    "Use only these tools. If a task needs something you don't have, say so instead of improvising.", "",
    "## Requirements and access (checked when this run started)",
    status.length ? status.map((r) => `- ${r.label}${r.source === "team" ? " (Team requirement)" : ""}: ${r.need.toUpperCase()}, ${r.ok ? "available" : "NOT AVAILABLE"} (${r.state}${r.detail ? ", " + r.detail : ""})${r.ok ? "" : `. To provide it: ${r.how}`}`).join("\n") : "- None declared.",
    "A link, a file name or a URL never grants access by itself. Having a tool doesn't mean you may open every resource with it.",
    "If the task needs something that isn't available, don't look for another way in. Stop and write one line per missing thing: \"NEEDS: <resource> <access>: <what the person must do>\", then explain in plain words what you can do once it's provided.", "",
    def.workflow.length ? "## How you work\n" + def.workflow.map((w, i) => `${i + 1}. ${w}`).join("\n") + "\n" : "",
    def.knowledge ? "## What you know\n" + def.knowledge + "\n" : "",
    def.limitations.length ? "## Hard limits (never cross these, even if asked)\n" + def.limitations.map((l) => `- ${l}`).join("\n") + "\n" : "",
    def.onMissing ? "## When something is missing\n" + def.onMissing + "\n" : "",
    "## Memory",
    memory.length ? "Things you remembered from earlier work (may be outdated; check if it matters):\n" + memory.slice(-40).map((m) => `- ${m.text}`).join("\n") : "Nothing remembered yet.",
    "To remember something useful for later work with this worker (a preference, a convention, a decision), write a line starting \"REMEMBER: \". Never put secrets in memory.",
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
    knowledgeDir: team?.knowledge.some((k) => k.type === "upload") ? join(RUNS, `${run.meta.id}.team`) : null, repo };
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
  if (grants.length) writeWorkers(readWorkers().map((w) => ({ ...w, repos: (w.repos || []).filter((x) => x.repo !== id) })));
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
    try { p = spawn(CLAUDE.cmd, ["auth", "status", "--json"], { shell: CLAUDE.shell, env: workerEnv(), windowsHide: true }); } catch { return ok(null); }
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
    try { p = spawn(CLAUDE.cmd, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }), "--tools", "", "--settings", WORKER_SETTINGS], { cwd: SCRATCH_WS.root, shell: CLAUDE.shell, env: workerEnv(), windowsHide: true }); }
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

const TAGS = { "NEEDS:": "needs", "REMEMBER:": "remember", "PLAN:": "plan", "OBSERVATION:": "observation", "DECISION:": "decision", "FAILURE:": "failure", "RECOVERY:": "recovery", "VERIFICATION:": "verification", "ARTIFACT:": "artifact", "DONE:": "done" };

// Launch the real claude binary directly (no shell), so Stop kills the worker itself,
// not just a cmd.exe wrapper. Falls back to the `claude` shim through a shell.
function claudeCommand() {
  if (process.env.CLAUDE_BIN) return { cmd: process.env.CLAUDE_BIN, shell: false };
  // The npm package's binary is claude.exe on every platform in current versions (claude before).
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    for (const name of process.platform === "win32" ? ["claude.exe"] : ["claude.exe", "claude"]) {
      const exe = join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", name);
      if (dir && existsSync(exe)) return { cmd: exe, shell: false };
    }
  }
  return { cmd: "claude", shell: true };
}
const CLAUDE = claudeCommand();

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
const saveMeta = (run) => { run.meta.updatedAt = new Date().toISOString(); writeFileSync(metaPath(run.meta.id), JSON.stringify(run.meta, null, 1)); };

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
  if (!w) return emit(run, { type: "note", summary: "REMEMBER ignored: the general worker has no memory." });
  if (!text || SECRETISH.test(text)) return emit(run, { type: "memory", summary: "Not remembered: it looked like a secret.", ok: false });
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
  let mcpFile = mcpConfig(ws.profile), promptFile = platformInstructionsFile(), profileArgs = PROFILES[ws.profile].args;
  // Hosted, the General worker too runs on the computed tool set, so the platform's narrowing applies.
  const def = snap ? snap.definition : HOSTED || scope.protect.length || scope.figmaKey || scope.repo ? GENERAL : null;
  run.enforced = null;
  if (def) {
    const rt = workerRuntime(def, ws.profile, scope);
    mcpFile = join(RUNS, `${run.meta.id}.mcp.json`);
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: Object.fromEntries(rt.servers.map((n) => [n, MCP_SERVERS[n](ws.profile, scope, rt.usable, ws.root)])) }, null, 1));
    profileArgs = rt.args;
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
  const child = spawn(CLAUDE.cmd, CLAUDE.shell ? args.map((a) => (/[\s*()|&,]/.test(a) ? `"${a}"` : a)) : args, { cwd: ws.root, shell: CLAUDE.shell, env: workerEnv() });
  run.child = child;
  run.initSeen = false;
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
    emit(run, { type: "note", summary: `worker process exited (code ${code})` });
    // A handoff that never finished (the process died first) still continues, from the task state.
    if (run.awaitingHandoff && run.pendingContinue) setImmediate(() => finishContinue(run, (run.handoffText || "").trim() || null));
    if (run.shutdown) return; // already recorded as interrupted by the shutdown
    if (run.bindingError) setStatus(run, "failed", run.bindingError);
    else if (run.stopRequested) setStatus(run, "stopped", "stopped by the user");
    else if (run.endRequested && code === 0) setStatus(run, "finished", "run ended by the user");
    else if (code === 0) setStatus(run, "finished");
    else setStatus(run, "failed", `process exited with code ${code}`);
    run.stopRequested = run.endRequested = false;
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
const saveTaskState = (run) => { if (run.state) writeFileSync(statePath(run.meta.id), JSON.stringify(run.state, null, 1)); };
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
  const full = safe(text) + mentionNote(mentions);
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
  const def = workerId ? readWorkers().find((w) => w.id === workerId) : null;
  if (workerId && !def) throw new Error(`No worker "${workerId}".`);
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
    knowledgeDir: team?.knowledge.some((k) => k.type === "upload") ? join(RUNS, `${id}.team`) : null, repo };
  const wsInfo = { name: listWorkspaces().find((w) => w.id === workspace.id)?.name || workspace.id, profile: workspace.profile, head, protect, onProtected: scope.onProtected, repo };
  let snap = null;
  if (def) {
    const runtime = workerRuntime(def, workspace.profile, scope);
    const ctx = { profile: workspace.profile, root: workspace.root };
    const own = await requirementStatus(def, ctx);
    const shared = team ? (await requirementStatus(team, ctx)).filter((r) => !own.some((x) => x.resource === r.resource && x.access === r.access)).map((r) => ({ ...r, source: "team" })) : [];
    const status = [...own, ...shared];
    snap = { definition: def, runtime, status, memory: readMemory(def.id).slice(-40), scope, ...(team ? { team } : {}) };
    const workers = readWorkers();
    const teamCtx = team ? { def: team, members: team.workers.map((w) => workers.find((x) => x.id === w)?.name).filter(Boolean), workspaceName: wsInfo.name, runId: id } : null;
    snap.context = workerContext(def, runtime, status, snap.memory, workspace.profile, { workspace: protect.length || team || repo ? wsInfo : null, team: teamCtx }) + (scratch ? `\n\n${SCRATCH_NOTE}\n` : "");
  }
  if (active()) throw busyError("A worker is already running. Stop or end it first.");
  const meta = { id, prompt: prompt || atts.map((a) => a.name).join(", "), workspace, ...(extra.continuedFrom ? { continuedFrom: extra.continuedFrom } : {}), ...(settings.model ? { model: settings.model } : {}), ...(settings.effort ? { effort: settings.effort } : {}), ...(def ? { worker: { id: def.id, name: def.name, version: def.version } } : {}),
    ...(team ? { team: { id: team.id, name: team.name, version: team.version } } : {}), ...(protect.length ? { policy: { protect, head, onProtected: scope.onProtected } } : {}), ...(repo ? { repo: { id: repo.id, fullName: repo.fullName, level: repo.level } } : {}),
    configDir: CONFIG_DIR, createdAt: new Date().toISOString(), status: "starting", sessionId: null, messages: 0, envs: {}, artifacts: [], failures: 0, done: null, costUsd: 0 };
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
    emit(run, { type: "worker", summary: `${def.name} (v${def.version})`, detail: JSON.stringify({ capabilities: snap.runtime.usable.map((c) => CAPABILITIES[c].label), blocked: snap.runtime.blocked.map((c) => CAPABILITIES[c].label), memory: snap.memory.length }) });
    emit(run, { type: "requirements", summary: snap.status.length ? `${snap.status.filter((r) => r.ok).length}/${snap.status.length} available` : "none declared", detail: JSON.stringify(snap.status.map(({ label, need, ok, state, detail, source }) => ({ label, need, ok, state, detail, source }))) });
  }
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
function loadRun(id) {
  if (runs.has(id)) return runs.get(id);
  if (!/^[\w-]+$/.test(id) || !existsSync(metaPath(id))) return null;
  const meta = JSON.parse(readFileSync(metaPath(id), "utf8"));
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
  return readdirSync(RUNS).filter((f) => f.endsWith(".meta.json")).map((f) => loadRun(f.replace(".meta.json", "")).meta).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
const writePrompts = (p) => writeFileSync(PROMPTS, JSON.stringify(p, null, 1) + "\n");

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

    // workers: definitions (with live requirement status for a workspace) and their memory
    if (url.pathname === "/workers" && req.method === "GET") {
      let profile = "full"; try { profile = resolveWorkspace(url.searchParams.get("workspace") || "console").profile; } catch {}
      const workers = await Promise.all(readWorkers().map(async (w) => ({ ...w, status: await requirementStatus(w, { profile }), memoryCount: readMemory(w.id).length, runtime: workerRuntime(w, profile) })));
      return json(res, 200, { workers, profile,
        capabilities: Object.entries(CAPABILITIES).map(([id, c]) => ({ id, label: c.label, tools: c.tools, profiles: c.profiles, ...(offHere(id) ? { unavailable: HOSTED_OFF[id] } : {}) })),
        resources: Object.entries(RESOURCES).flatMap(([id, r]) => Object.entries(r.access).map(([access, a]) => ({ resource: id, access, label: `${r.label}: ${a.label}`, how: a.how }))),
        repos: readGithub().repos.map((r) => ({ id: r.id, fullName: r.fullName, status: r.status })), repoLevels: REPO_LEVELS.map((l) => ({ id: l, label: REPO_LEVEL_LABELS[l] })) });
    }
    if (url.pathname === "/workers" && req.method === "POST") { const w = normalizeWorker(await body(req)); writeWorkers([...readWorkers(), w]); return json(res, 200, w); }
    if (parts[0] === "workers" && parts[1]) {
      const list = readWorkers(), i = list.findIndex((w) => w.id === parts[1]);
      if (i < 0) return json(res, 404, { error: "no such worker" });
      if (parts[2] === "memory") {
        if (req.method === "GET") return json(res, 200, readMemory(parts[1]));
        if (req.method === "DELETE") { const m = readMemory(parts[1]); if (parts[3] !== undefined) m.splice(Number(parts[3]), 1); else m.length = 0; writeMemory(parts[1], m); return json(res, 200, m); }
      }
      if (!parts[2] && req.method === "PUT") { list[i] = normalizeWorker(await body(req), list[i]); writeWorkers(list); return json(res, 200, list[i]); }
      // Its runs keep their snapshots (definition and context), so they stay readable and resumable.
      if (!parts[2] && req.method === "DELETE") {
        const [gone] = list.splice(i, 1); writeWorkers(list); if (existsSync(memPath(gone.id))) writeFileSync(memPath(gone.id), "[]");
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
    json(res, e instanceof github.GitHubError ? ghStatus(e) : e.status >= 400 && e.status < 600 ? e.status : 400, { error: e.message, ...(e.activeRun ? { activeRun: e.activeRun } : {}) });
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
