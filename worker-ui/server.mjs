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
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync, lstatSync, realpathSync, renameSync, rmSync, copyFileSync } from "node:fs";
import { join, dirname, resolve, extname, delimiter, relative, isAbsolute, sep, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { api as figmaApi, CRED_FILE as FIGMA_CRED_FILE, parseFigmaUrl } from "../figma-reader/reader.mjs";

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
const PORT = Number(process.env.WORKER_CONSOLE_PORT) || 8799;
mkdirSync(RUNS, { recursive: true });
// "No folder": work that has no project folder (a Figma design, a conversation) runs in this
// private, console-owned scratch folder, with the Work profile; the worker's own capabilities
// still decide its tools. It's always in the list and can't be removed.
const SCRATCH_WS = { id: "scratch", name: "No folder", root: join(DATA, "scratch"), profile: "full" };
mkdirSync(SCRATCH_WS.root, { recursive: true });
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
const WORKER_SETTINGS = JSON.stringify({ includeCoAuthoredBy: false, attribution: { commit: "", pr: "" } });
const PROFILES = {
  full: { browser: "full", args: ["--settings", WORKER_SETTINGS, "--setting-sources", "project,local", "--allowedTools", ...ALLOWED] },
  inspect: { browser: "inspect", args: ["--settings", WORKER_SETTINGS, "--restricted", "--tools", INSPECT_BUILTINS.join(","), "--allowedTools", ...INSPECT_BUILTINS, ...INSPECT_MCP, "--permission-prompts", "none"] },
};
// MCP config per profile, with absolute paths (the worker's cwd is its workspace, not this repo).
const mcpConfig = (profile) => {
  const file = join(DATA, `mcp.${profile}.json`);
  writeFileSync(file, JSON.stringify({ mcpServers: {
    "figma-executor": { command: process.execPath, args: [join(REPO, "mcp", "server.mjs")] },
    "browser-executor": { command: process.execPath, args: [join(REPO, "browser-adapter", "server.mjs")], env: { BROWSER_EXECUTOR_PROFILE: PROFILES[profile].browser } },
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
const CAPABILITIES = {
  "files.read": { label: "Read files in the workspace", tools: "Read, Glob, Grep", builtins: ["Read", "Glob", "Grep"], allow: ["Read", "Glob", "Grep"], profiles: ["full", "inspect"] },
  "files.write": { label: "Edit files in the workspace", tools: "Write, Edit", builtins: ["Write", "Edit"], allow: ["Write", "Edit"], profiles: ["full"] },
  shell: { label: "Run node and curl", tools: "Bash(node:*), Bash(curl:*)", builtins: ["Bash"], allow: ["Bash(node:*)", "Bash(curl:*)"], profiles: ["full"] },
  web: { label: "Search and fetch the web", tools: "WebSearch, WebFetch", builtins: ["WebSearch", "WebFetch"], allow: ["WebSearch", "WebFetch"], profiles: ["full"] },
  browser: { label: "Use a browser", tools: "browser-executor (in Inspect: open and read pages only)", mcp: "browser-executor", allow: { full: ["mcp__browser-executor"], inspect: ["mcp__browser-executor__browser_navigate", "mcp__browser-executor__browser_get_dom_state"] }, profiles: ["full", "inspect"] },
  "figma.read": { label: "Read Figma designs from a link", tools: "figma-reader: figma_read_design, figma_access_status (REST API)", mcp: "figma-reader", allow: ["mcp__figma-reader"], profiles: ["full", "inspect"] },
  "figma.plugin.read": { label: "Read the open Figma file (plugin)", tools: "figma-executor read tools; the plugin must be running", mcp: "figma-executor", allow: FIGMA_READ_TOOLS, profiles: ["full", "inspect"] },
  "figma.plugin.edit": { label: "Change the open Figma file (plugin)", tools: "figma-executor, all tools; the plugin must be running", mcp: "figma-executor", allow: ["mcp__figma-executor"], profiles: ["full"] },
};
// A Team's Figma resource locks the Figma tools of its runs to that one file: the Executor refuses
// commands while another file is open, and the Reader refuses links to other files.
const MCP_SERVERS = {
  "figma-executor": (profile, scope = {}) => ({ command: process.execPath, args: [join(REPO, "mcp", "server.mjs")], ...(scope.figmaKey ? { env: { FIGMA_EXPECTED_FILE_KEY: scope.figmaKey } } : {}) }),
  "figma-reader": (profile, scope = {}) => ({ command: process.execPath, args: [join(REPO, "mcp", "reader-server.mjs")],
    ...(scope.figmaKey ? { env: { FIGMA_READER_ALLOWED_KEYS: scope.figmaKey, ...(process.env.FIGMA_READER_DIR ? { FIGMA_READER_DIR: process.env.FIGMA_READER_DIR } : {}) } } : {}) }),
  "browser-executor": (profile) => ({ command: process.execPath, args: [join(REPO, "browser-adapter", "server.mjs")], env: { BROWSER_EXECUTOR_PROFILE: PROFILES[profile].browser } }),
};
// Deny rules are applied by the runtime itself, below the model. Absolute paths are written the
// runtime's way (//c/Users/...); tested: a Write into such a folder is refused.
const denyPath = (p) => "//" + resolve(p).replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase());
const PROTECT_DENY = ["Edit(.git/**)", "Edit(**/.git/**)", "Edit(.claude/**)", "Edit(**/.claude/**)"];
// What a defined worker gets in a given profile: the context, the tools and the MCP servers.
// scope narrows it further, never widens it:
//  - protect: branches an enforced policy protects in this workspace. Shell commands are turned
//    off (node or curl can run git, or write .git, behind the console's back), .git and .claude
//    can't be written, and project settings are ignored (--restricted: a repo's hooks don't run).
//  - onProtected: a protected branch is checked out, so file edits are off too.
//  - knowledgeDir: the run's copy of uploaded Team knowledge, readable and not writable.
//  - figmaKey: the Team's Figma file (see MCP_SERVERS).
function workerRuntime(def, profile, scope = {}) {
  const protect = !!scope.protect?.length;
  const policyOff = new Set([...(protect ? ["shell"] : []), ...(scope.onProtected ? ["files.write"] : [])]);
  const allowed = def.capabilities.filter((c) => CAPABILITIES[c]?.profiles.includes(profile));
  const usable = allowed.filter((c) => !policyOff.has(c));
  const builtins = ["ToolSearch", ...new Set(usable.flatMap((c) => CAPABILITIES[c].builtins || []))];
  const allow = ["ToolSearch", ...usable.flatMap((c) => { const a = CAPABILITIES[c].allow; return Array.isArray(a) ? a : a[profile] || []; })];
  const servers = [...new Set(usable.map((c) => CAPABILITIES[c].mcp).filter(Boolean))];
  const base = profile === "inspect" || protect ? ["--restricted"] : ["--setting-sources", "project,local"];
  // Renders the worker makes (figma_export_node, browser_screenshot) land in the adapters' own
  // exports folders; it may read those, and only those, outside its workspace, to look at its work.
  const exportsDirs = [...new Set(usable.flatMap((c) => (c.startsWith("figma.plugin") ? [join(REPO, "exports")] : c === "browser" ? [join(REPO, "browser-adapter", "exports")] : [])))];
  const readOnly = scope.knowledgeDir ? [scope.knowledgeDir] : [];
  const deny = [...(protect ? PROTECT_DENY : []), ...readOnly.map((d) => `Edit(${denyPath(d)}/**)`)];
  const settings = deny.length ? JSON.stringify({ ...JSON.parse(WORKER_SETTINGS), permissions: { deny } }) : WORKER_SETTINGS;
  const dirs = [...exportsDirs, ...readOnly];
  return { usable, blocked: def.capabilities.filter((c) => !allowed.includes(c)), byPolicy: allowed.filter((c) => policyOff.has(c)), servers, exportsDirs,
    args: ["--settings", settings, ...base, "--tools", builtins.join(","), "--allowedTools", ...allow, ...(dirs.length ? ["--add-dir", ...dirs] : []), "--permission-prompts", "none"] };
}
// The general worker, as a definition: what it gets when a policy means it can't run on the plain
// profile flags (every capability the profile allows, except the ones the policy turns off).
const GENERAL = { id: null, name: "General", capabilities: ["files.read", "files.write", "web", "browser", "figma.plugin.read", "figma.plugin.edit"], workflow: [], limitations: [], requirements: [] };

// Requirements are generic {resource, access, need}; this registry knows how to check each one
// now, without showing any secret. A missing requirement doesn't block the run: the worker is
// told, and the tools themselves refuse without access.
let figmaCheck = { at: 0, value: null };
const RESOURCES = {
  figma: { label: "Figma", access: {
    read: { label: "read designs", how: "Connect Figma on this computer once: a Figma personal access token with file_content:read, or the OAuth flow (figma-reader/README.md). The connected account must be able to open the file.",
      async check() {
        if (!existsSync(FIGMA_CRED_FILE)) return { ok: false, state: "Not connected" };
        if (Date.now() - figmaCheck.at < 300000 && figmaCheck.value) return figmaCheck.value;
        let v; try { const me = await figmaApi("/v1/me"); v = { ok: true, state: "Connected", detail: me.handle ? `as ${me.handle}` : "" }; }
        catch (e) { v = { ok: false, state: e.status === 401 || e.status === 403 ? "Authorization rejected" : "Can't verify", detail: clip(e.message, 120) }; }
        figmaCheck = { at: Date.now(), value: v }; return v;
      } },
    edit: { label: "change the open file", how: "Open the Figma file and run the AI Executor plugin, so it connects to the bridge.",
      async check() {
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
  // Whether Git on this computer can reach the workspace's GitHub remote with the person's own
  // login (git ls-remote: reads refs, changes nothing, never prompts). It can't tell whether a
  // push would be allowed; GitHub decides that at push time.
  github: { label: "GitHub", access: {
    read: { label: "reach the repository", how: "Sign in to GitHub with Git on this computer once (for example, run \"git fetch\" in a terminal in this folder).",
      async check(ctx) {
        if (!ctx.root) return { ok: false, state: "No workspace" };
        const url = safeUrl((await git(ctx.root, ["remote", "get-url", "origin"]).catch(() => "")).trim());
        if (!/github\.com[:/]/i.test(url)) return { ok: false, state: url ? "Not a GitHub remote" : "No remote" };
        const hit = githubChecks.get(url);
        if (hit && Date.now() - hit.at < 300000) return hit.value;
        let v; try { await git(ctx.root, ["ls-remote", "--heads", "origin"], { timeout: 20000 }); v = { ok: true, state: "Reachable", detail: url }; }
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
  const now = new Date().toISOString();
  return { id: prev?.id || `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "worker"}-${randomUUID().slice(0, 4)}`, name,
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
  return [readFileSync(join(HERE, "worker-instructions.md"), "utf8").trim(), "",
    workspaceSection(extra.workspace), teamSection(extra.team),
    `# You are: ${def.name}`, def.mission && `Mission: ${def.mission}`, def.specialization && `Specialization: ${def.specialization}`, "",
    "## What you can use in this run", rt.usable.length ? rt.usable.map(cap).join("\n") : "- Nothing beyond reading this context.",
    rt.blocked.length ? `Not available here (this workspace is ${profile === "inspect" ? "Inspect, read-only" : "Work"}): ${rt.blocked.map((c) => CAPABILITIES[c].label).join(", ")}.` : "",
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
  return { protect, head, onProtected: !!head && protect.some((p) => p.branch === head), figmaKey: team?.figma ? team.figma.branchKey || team.figma.fileKey : null,
    knowledgeDir: team?.knowledge.some((k) => k.type === "upload") ? join(RUNS, `${run.meta.id}.team`) : null };
}
const readSnapshot = (id) => (existsSync(snapPath(id)) ? JSON.parse(readFileSync(snapPath(id), "utf8")) : null);

function workspaceSection(w) {
  if (!w) return "";
  return ["## Workspace", `You work in "${w.name}" (${w.profile === "inspect" ? "Inspect: read-only" : "Work"})${w.head ? `, on branch ${w.head}` : ""}. Your working directory is its folder.`,
    w.protect.length ? "Enforced by the platform here (these aren't instructions: the console and the runtime enforce them):\n"
      + w.protect.map((p) => `- Never modify ${p.branch} (${p.team ? `${p.team} policy` : "policy"}): the console refuses to commit to it or push to it.`).join("\n")
      + "\n- So nothing can change a branch behind the console's back, this run has no shell commands and can't write inside .git or .claude."
      + (w.onProtected ? `\n- ${w.head} is checked out right now, so this run can't change files at all. To make changes, the person must switch to another branch first.` : "") : "",
    ""].filter((x) => x !== false).join("\n");
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
  // Integration tokens (FIGMA_TOKEN, ...) never reach workers; FIGMA_READER_DIR is only a path.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k === "FIGMA_READER_DIR" || !/^(CLAUDE|AI_AGENT|WORKER_CONSOLE_|FIGMA_)/i.test(k)));
  return { ...env, CLAUDE_CONFIG_DIR: CONFIG_DIR };
};

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
  const ws = id === "console" ? consoleWs(list) : id === "scratch" ? SCRATCH_WS : list.find((w) => w.id === id);
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
const consoleWs = (list = readWorkspaces()) => { const m = list.find((w) => w.id === "console") || {}; return { id: "console", name: m.name || "Executor", root: REPO, profile: m.profile || "full", hidden: !!m.hidden }; };
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
  const list = readWorkspaces();
  return [SCRATCH_WS, ...withConsole(list).map((w) => (w.id === "console" ? consoleWs(list) : w))].filter((w) => !w.hidden).map((w) => {
    let root = null; try { root = resolveWorkspace(w.id).root; } catch {}
    return { id: w.id, name: w.name || w.id, root: root || w.root, profile: w.profile, available: !!root, ...(root ? gitInfo(root) : {}) };
  });
}
// The person names a folder and a mode; the folder must exist, and can't be a drive root or the
// whole home folder (too broad to be one project).
function addWorkspace({ name, path, mode }) {
  name = String(name || "").trim();
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
  if (id === "scratch") throw new Error("\"No folder\" is built in and can't be removed.");
  if (!listWorkspaces().some((w) => w.id === id)) throw new Error(`No workspace "${id}".`);
  const busy = active();
  if (busy && (busy.meta.workspace?.id || "console") === id) throw new Error("A worker is running in this workspace. Stop or end it first.");
  writeWorkspaces(id === "console" ? withConsole(list).map((w) => (w.id === "console" ? { ...w, hidden: true } : w)) : list.filter((w) => w.id !== id));
  return listWorkspaces();
}
// New display order: the same workspaces, rearranged.
function reorderWorkspaces(ids) {
  ids = Array.isArray(ids) ? ids.filter((i) => i !== "scratch") : ids; // "No folder" stays first
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
function checkBinding(run, { resume }) {
  // Runs from before workspaces were all created in this repo with the full profile.
  const bound = run.meta.workspace || { id: "console", root: realpathSync.native(REPO), profile: "full" };
  const now = resolveWorkspace(bound.id);
  if (!samePath(now.root, bound.root)) throw new Error(`Workspace "${bound.id}" now resolves to ${now.root}, but this run is bound to ${bound.root}. Start a new run.`);
  if (now.profile !== bound.profile) throw new Error(`Workspace "${bound.id}" now has the ${now.profile} profile, but this run is bound to ${bound.profile}. Start a new run.`);
  if (resume) {
    if (run.meta.configDir && !samePath(run.meta.configDir, CONFIG_DIR)) throw new Error(`This run's session lives in Claude config dir ${run.meta.configDir}; this console uses ${CONFIG_DIR}.`);
    const cwds = sessionCwds(run.meta.sessionId);
    if (!cwds) throw new Error(`Session ${run.meta.sessionId} isn't in this console's Claude config dir (${CONFIG_DIR}), so it can't be resumed here.`);
    const real = (p) => { try { return realpathSync.native(p); } catch { return p; } };
    const elsewhere = cwds.find((c) => !samePath(real(c), bound.root));
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
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    const exe = join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", process.platform === "win32" ? "claude.exe" : "claude");
    if (dir && existsSync(exe)) return { cmd: exe, shell: false };
  }
  return { cmd: "claude", shell: true };
}
const CLAUDE = claudeCommand();

const envOf = (tool) =>
  tool.startsWith("mcp__figma-executor") || tool.startsWith("mcp__figma-reader") ? "Figma"
  : tool.startsWith("mcp__browser-executor") ? "Browser"
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
  emit(run, { type: "status", summary: status, detail: why });
}
const alive = (run) => run.child && run.child.exitCode === null && !run.child.killed;
const active = () => [...runs.values()].find(alive);

function translate(run, msg) {
  if (msg.session_id && run.meta.sessionId !== msg.session_id) { run.meta.sessionId = msg.session_id; saveMeta(run); }
  if (msg.type === "system" && msg.subtype === "init") {
    // Check what the worker reports about itself, not only what it was told.
    const ws = run.meta.workspace;
    const extra = ws.profile === "inspect" ? (msg.tools || []).filter((t) => !t.startsWith("mcp__") && !INSPECT_BUILTINS.includes(t)) : [];
    const off = [...(run.enforced?.noShell ? ["Bash", "PowerShell"] : []), ...(run.enforced?.noWrite ? ["Write", "Edit", "NotebookEdit"] : [])];
    const kept = (msg.tools || []).filter((t) => off.includes(t));
    const why = !samePath(msg.cwd || "", ws.root) ? `worker reports cwd ${msg.cwd}, not the workspace ${ws.root}`
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
    for (const b of msg.message?.content || []) {
      if (b.type === "tool_use") {
        const env = envOf(b.name);
        // A file the worker writes is a deliverable once the write succeeds (see the tool_result).
        run.toolUses.set(b.id, { name: b.name, env, writes: (b.name === "Write" || b.name === "Edit") && b.input?.file_path ? relTo(run.meta.workspace.root, b.input.file_path) : null });
        if (b.name === "ToolSearch") continue; // loading tool schemas, not work
        run.meta.envs[env] = (run.meta.envs[env] || 0) + 1;
        emit(run, { type: "tool", ref: b.id, env, tool: shortName(b.name), summary: toolSummary(b.name, b.input, run.meta.workspace.root) });
      } else if (b.type === "text" && b.text.trim()) {
        emit(run, { type: "reply", summary: b.text.trim() });
        for (const raw of b.text.split(/\r?\n/)) {
          const line = raw.replace(/^[\s*>•-]+/, "").replace(/\*\*/g, "").trim();
          const tag = Object.keys(TAGS).find((t) => line.toUpperCase().startsWith(t));
          if (!tag) continue;
          const text = line.slice(tag.length).trim();
          if (TAGS[tag] === "artifact") addArtifact(run, relTo(run.meta.workspace.root, text.replace(/[`"]/g, "")), "Files");
          else if (TAGS[tag] === "remember") remember(run, text);
          else emit(run, { type: TAGS[tag], summary: text });
          if (TAGS[tag] === "needs") run.meta.needs = [...(run.meta.needs || []), text];
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
      if (b.is_error) run.meta.failures++;
      emit(run, { type: b.is_error ? "failure" : "result", ref: b.tool_use_id, env: use.env, tool: shortName(use.name), summary: clip(resultText(b.content), 220) });
      if (use.writes && !b.is_error) addArtifact(run, use.writes, use.env);
    }
    return;
  }
  if (msg.type === "result") {
    run.meta.costUsd = (run.meta.costUsd || 0) + (msg.total_cost_usd || 0);
    emit(run, {
      type: "completed",
      summary: msg.is_error ? `Turn ended with an error (${msg.subtype})` : "Turn finished",
      detail: JSON.stringify({ turns: msg.num_turns, seconds: Math.round((msg.duration_ms || 0) / 1000), costUsd: msg.total_cost_usd }),
    });
    if (msg.is_error) run.meta.lastError = msg.subtype;
    setStatus(run, "waiting", "ready for a follow-up");
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
function addArtifact(run, path, env) {
  // Only files inside the workspace are deliverables; worker scratch files elsewhere (absolute paths) are not.
  if (!path || /^([a-z]:|\/|\\)/i.test(path) || run.meta.artifacts.includes(path)) return;
  run.meta.artifacts.push(path);
  emit(run, { type: "artifact", env, summary: path });
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
  let mcpFile = mcpConfig(ws.profile), promptFile = join(HERE, "worker-instructions.md"), profileArgs = PROFILES[ws.profile].args;
  const def = snap ? snap.definition : scope.protect.length || scope.figmaKey ? GENERAL : null;
  run.enforced = null;
  if (def) {
    const rt = workerRuntime(def, ws.profile, scope);
    mcpFile = join(RUNS, `${run.meta.id}.mcp.json`);
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: Object.fromEntries(rt.servers.map((n) => [n, MCP_SERVERS[n](ws.profile, scope)])) }, null, 1));
    if (existsSync(join(RUNS, `${run.meta.id}.worker.md`))) promptFile = join(RUNS, `${run.meta.id}.worker.md`);
    profileArgs = rt.args;
    if (scope.protect.length) {
      run.enforced = { noShell: true, noWrite: scope.onProtected };
      emit(run, { type: "policy", summary: `${scope.protect.map((p) => p.branch).join(", ")} protected`, detail: JSON.stringify({ policies: scope.protect, head: scope.head, onProtected: scope.onProtected, off: rt.byPolicy.map((c) => CAPABILITIES[c].label) }) });
    }
  }
  const args = [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--mcp-config", mcpFile, "--strict-mcp-config",
    "--append-system-prompt-file", promptFile,
    ...profileArgs,
    ...(resume ? ["--resume", run.meta.sessionId] : []),
  ];
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

function sendToWorker(run, text, atts = [], mentions = []) {
  run.meta.messages++;
  const saved = saveAttachments(run, atts);
  emit(run, { type: "user", summary: text, ...(saved.length ? { attachments: saved } : {}), ...(mentions.length ? { mentions } : {}) });
  setStatus(run, "running");
  const safe = (t) => defuseAtRefs(run.meta.workspace.root, t); // what the person sees stays as typed
  const full = safe(text) + mentionNote(mentions);
  const content = atts.length ? [...atts.map(attBlock).map((b) => (b.type === "text" ? { ...b, text: safe(b.text) } : b)), ...(full ? [{ type: "text", text: full }] : [])] : full;
  run.child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
}

// A Team run: one of the Team's workers, in the Team's workspace (a request for another workspace
// is refused), with the Team's context added before the worker's own.
const teamWorkspace = (t) => t.workspace || "scratch";
async function newRun(prompt, workspaceId = "console", atts = [], workerId = null, mentions = [], teamId = null) {
  if (active()) throw new Error("A worker is already running. Stop or end it first.");
  const team = teamId ? readTeams().find((t) => t.id === teamId) : null;
  if (teamId && !team) throw new Error(`No Team "${teamId}".`);
  if (team) {
    if (!workerId) throw new Error(`Choose which of the ${team.name} Team's workers should answer.`);
    if (!team.workers.includes(workerId)) throw new Error(`That worker isn't in the ${team.name} Team.`);
    if (workspaceId !== teamWorkspace(team)) throw new Error(`The ${team.name} Team works in its own workspace; it can't run in another one.`);
  }
  const workspace = resolveWorkspace(workspaceId);
  const def = workerId ? readWorkers().find((w) => w.id === workerId) : null;
  if (workerId && !def) throw new Error(`No worker "${workerId}".`);
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const protect = wsPolicies(workspace.id), head = gitInfo(workspace.root).branch;
  const scope = { protect, head, onProtected: !!head && protect.some((p) => p.branch === head), figmaKey: team?.figma ? team.figma.branchKey || team.figma.fileKey : null,
    knowledgeDir: team?.knowledge.some((k) => k.type === "upload") ? join(RUNS, `${id}.team`) : null };
  const wsInfo = { name: listWorkspaces().find((w) => w.id === workspace.id)?.name || workspace.id, profile: workspace.profile, head, protect, onProtected: scope.onProtected };
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
    snap.context = workerContext(def, runtime, status, snap.memory, workspace.profile, { workspace: protect.length || team ? wsInfo : null, team: teamCtx });
  }
  if (active()) throw new Error("A worker is already running. Stop or end it first.");
  const meta = { id, prompt: prompt || atts.map((a) => a.name).join(", "), workspace, ...(def ? { worker: { id: def.id, name: def.name, version: def.version } } : {}),
    ...(team ? { team: { id: team.id, name: team.name, version: team.version } } : {}), ...(protect.length ? { policy: { protect, head, onProtected: scope.onProtected } } : {}),
    configDir: CONFIG_DIR, createdAt: new Date().toISOString(), status: "starting", sessionId: null, messages: 0, envs: {}, artifacts: [], failures: 0, done: null, costUsd: 0 };
  const run = { meta, toolUses: new Map(), file: join(RUNS, `${id}.jsonl`), raw: join(RUNS, `${id}.raw.jsonl`) };
  writeFileSync(run.file, ""); writeFileSync(run.raw, "");
  runs.set(id, run);
  saveMeta(run);
  // The run's own copy of the Team's uploaded knowledge: it stays with the run if the Team changes.
  if (scope.knowledgeDir) {
    mkdirSync(scope.knowledgeDir, { recursive: true });
    for (const k of team.knowledge) if (k.type === "upload") copyFileSync(teamPath(team.id, "knowledge", k.file), join(scope.knowledgeDir, k.file));
  }
  // The general worker under an enforced policy gets a context that says why some tools are off.
  if (!def && protect.length) writeFileSync(join(RUNS, `${id}.worker.md`), [readFileSync(join(HERE, "worker-instructions.md"), "utf8").trim(), "", workspaceSection(wsInfo)].join("\n"));
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
function followUp(run, text, atts = [], mentions = []) {
  if (alive(run)) {
    if (run.meta.status !== "waiting") throw new Error("The worker is still working on the previous message. Wait for it, or stop it.");
    return sendToWorker(run, text, atts, mentions);
  }
  if (active()) throw new Error("Another worker is running. Stop or end it first.");
  if (!run.meta.sessionId) throw new Error("This run has no saved session to resume.");
  checkBinding(run, { resume: true }); // before anything is logged, so a refused resume changes nothing
  emit(run, { type: "note", summary: "Resuming the saved session in a new worker process. Conversation context is kept; tool processes are new (browser pages and logins are gone, Figma and files are unaffected)." });
  setStatus(run, "starting", "resuming session");
  spawnWorker(run, { resume: true });
  sendToWorker(run, text, atts, mentions);
}

function loadRun(id) {
  if (runs.has(id)) return runs.get(id);
  if (!/^[\w-]+$/.test(id) || !existsSync(metaPath(id))) return null;
  const meta = JSON.parse(readFileSync(metaPath(id), "utf8"));
  const run = { meta, toolUses: new Map(), file: join(RUNS, `${id}.jsonl`), raw: join(RUNS, `${id}.raw.jsonl`) };
  if (["starting", "running", "waiting"].includes(meta.status)) { meta.status = "interrupted"; saveMeta(run); } // server restarted under it
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
const GIT_OPTS = ["-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "-c", "color.ui=false"];
const NO_PROGRAMS = ["--no-ext-diff", "--no-textconv"]; // never run repo-configured diff programs
function gitEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|COMMON_DIR|CEILING_DIRECTORIES)$/.test(k)));
  // No credential prompts of any kind: missing authentication is reported, not asked for.
  return { ...env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
}
function git(cwd, args, { timeout = 30000, input } = {}) {
  return new Promise((ok, fail) => {
    const p = spawn("git", [...GIT_OPTS, ...args], { cwd, env: gitEnv(), windowsHide: true });
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
  const guard = wsPolicies(wsId).find((p) => p.branch === b.target || p.branch === b.branch);
  if (guard) throw new Error(`${guard.branch} is protected by the ${guard.team}'s enforced policy: nothing is pushed to it from here.`);
  if (!b.ahead) throw new Error(`Nothing to push: ${b.remote}/${b.target} already has these commits.`);
  const run = runIn(wsId, runId);
  const where = `${b.remote}/${b.target}`;
  try {
    // Explicit refspec, no --force, no -u: nothing in the repo's config is changed.
    const out = await git(r.top, ["push", "--porcelain", b.remote, `HEAD:refs/heads/${b.target}`], { timeout: 120000 });
    const line = out.split(/\r?\n/).find((l) => /^[ +*=]\t/.test(l)) || "";
    const res = { ok: true, remote: b.remote, branch: b.target, url: b.url, github: b.github, commits: b.ahead, summary: `Pushed ${b.ahead} commit${b.ahead === 1 ? "" : "s"} to ${where}`, detail: line.trim() };
    if (run) emit(run, { type: "push", summary: res.summary, detail: b.url || "" });
    return res;
  } catch (e) {
    const m = e.message;
    const why = e.timedOut ? "The push timed out." : /Authentication failed|could not read Username|could not read Password|terminal prompts disabled|Logon failed|Invalid username or password|Permission denied \(publickey|Host key verification failed|returned error: 40[13]|HTTP Basic: Access denied/i.test(m)
      ? `Git has no working login for ${b.url || b.remote}. Sign in once with Git outside the Workspace (for example, run "git push" in a terminal in this folder), then push again.`
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
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
function rejectReason(req) {
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
    console.log(`${new Date().toISOString()} REJECTED ${req.method} ${req.url} — ${why} (origin=${req.headers.origin || "-"}, host=${req.headers.host || "-"})`);
    res.writeHead(403, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: `Rejected: ${why}` }));
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (url.pathname === "/") { res.writeHead(200, { "content-type": TYPES[".html"] }); return res.end(readFileSync(join(HERE, "workspace.html"))); }
    if (url.pathname === "/console") { res.writeHead(200, { "content-type": TYPES[".html"] }); return res.end(readFileSync(join(HERE, "index.html"))); }
    if (parts[0] === "assets" && /^[\w.-]+$/.test(parts[1] || "") && parts.length === 2 && existsSync(join(HERE, "assets", parts[1]))) {
      res.writeHead(200, { "content-type": TYPES[extname(parts[1]).toLowerCase()] || "application/octet-stream" }); return res.end(readFileSync(join(HERE, "assets", parts[1])));
    }

    // workspaces
    if (url.pathname === "/workspaces" && req.method === "GET") return json(res, 200, listWorkspaces());
    if (url.pathname === "/workspaces" && req.method === "POST") return json(res, 200, addWorkspace(await body(req)));
    if (url.pathname === "/workspaces/order" && req.method === "POST") return json(res, 200, reorderWorkspaces((await body(req)).ids));
    if (parts[0] === "workspaces" && parts[1] && parts.length === 2 && req.method === "DELETE") return json(res, 200, removeWorkspace(decodeURIComponent(parts[1])));
    if (url.pathname === "/pick-folder" && req.method === "POST") return json(res, 200, await pickFolder());

    // workers: definitions (with live requirement status for a workspace) and their memory
    if (url.pathname === "/workers" && req.method === "GET") {
      let profile = "full"; try { profile = resolveWorkspace(url.searchParams.get("workspace") || "console").profile; } catch {}
      const workers = await Promise.all(readWorkers().map(async (w) => ({ ...w, status: await requirementStatus(w, { profile }), memoryCount: readMemory(w.id).length, runtime: workerRuntime(w, profile) })));
      return json(res, 200, { workers, profile,
        capabilities: Object.entries(CAPABILITIES).map(([id, c]) => ({ id, label: c.label, tools: c.tools, profiles: c.profiles })),
        resources: Object.entries(RESOURCES).flatMap(([id, r]) => Object.entries(r.access).map(([access, a]) => ({ resource: id, access, label: `${r.label}: ${a.label}`, how: a.how }))) });
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
    if (url.pathname === "/mentions" && req.method === "GET") return json(res, 200, { workspace: W, ...(await searchFiles(resolveWorkspace(W).root, url.searchParams.get("q"))) });
    if (url.pathname === "/tree") {
      const entries = dirInside(resolveWorkspace(url.searchParams.get("workspace") || "").root, url.searchParams.get("path") || "");
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
      const wsIdArg = workspace === undefined ? (team ? teamWorkspace(team) : "console") : String(workspace);
      const mentions = resolveMentions(resolveWorkspace(wsIdArg).root, b.mentions);
      return json(res, 200, (await newRun(String(prompt || "").trim(), wsIdArg, atts, b.worker ? String(b.worker) : null, mentions, team?.id || null)).meta);
    }
    if (parts[0] === "runs" && parts[1]) {
      const run = loadRun(parts[1]);
      if (!run) return json(res, 404, { error: "no such run" });
      const action = parts[2];
      if (!action && req.method === "GET") return json(res, 200, run.meta);
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
      if (action === "message") {
        const { text, attachments, mentions: ms } = await body(req);
        const atts = readAttachments(attachments);
        if (!text?.trim() && !atts.length) throw new Error("Empty message");
        const mentions = resolveMentions(checkBinding(run, { resume: false }).root, ms); // the run's own workspace
        followUp(run, String(text || "").trim(), atts, mentions); return json(res, 200, run.meta);
      }
      if (action === "stop") { if (alive(run)) { run.stopRequested = true; run.child.kill(); } return json(res, 200, run.meta); }
      if (action === "end") { if (alive(run)) { run.endRequested = true; run.child.stdin.end(); } return json(res, 200, run.meta); }
      if (action === "restart") return json(res, 200, (await newRun(run.meta.prompt, checkBinding(run, { resume: false }).id, [], run.meta.worker?.id || null, [], run.meta.team?.id || null)).meta);
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
    json(res, 400, { error: e.message });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Worker Console on http://localhost:${PORT} (worker binary: ${CLAUDE.cmd}${CLAUDE.shell ? " via shell" : ""}; Claude config dir: ${CONFIG_DIR})`));
