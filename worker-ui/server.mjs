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
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync, realpathSync, renameSync } from "node:fs";
import { join, dirname, resolve, extname, delimiter, relative, isAbsolute, sep, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
// WORKER_CONSOLE_PORT / WORKER_CONSOLE_DATA exist so tests can run a second console with its own
// runs, prompts and workspaces without touching this one's.
const DATA = resolve(process.env.WORKER_CONSOLE_DATA || HERE);
const RUNS = join(DATA, "runs");
const PROMPTS = join(DATA, "prompts.json");
const WORKSPACES = join(DATA, "workspaces.json");
const PORT = Number(process.env.WORKER_CONSOLE_PORT) || 8799;
mkdirSync(RUNS, { recursive: true });
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
const PROFILES = {
  full: { browser: "full", args: ["--setting-sources", "project,local", "--allowedTools", ...ALLOWED] },
  inspect: { browser: "inspect", args: ["--restricted", "--tools", INSPECT_BUILTINS.join(","), "--allowedTools", ...INSPECT_BUILTINS, ...INSPECT_MCP, "--permission-prompts", "none"] },
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

// ---- Claude config directory ------------------------------------------------------
// One deliberate directory for every worker: Claude Code's own default, ~/.claude, unless
// WORKER_CONSOLE_CLAUDE_CONFIG_DIR names another. The console's own environment is not passed on
// as-is: an inherited CLAUDE_CONFIG_DIR (the VS Code extension sets one) and the other CLAUDE_*
// variables of whatever started the console (its session id, messaging socket and token, entry
// point) are dropped, so sessions never land in, or resume from, another tool's directory.
const CONFIG_DIR = resolve(process.env.WORKER_CONSOLE_CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
const workerEnv = () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|AI_AGENT|WORKER_CONSOLE_)/i.test(k)));
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
  const ws = id === "console" ? CONSOLE_WS : list.find((w) => w.id === id);
  if (!ws) throw new Error(`No workspace "${id}".`);
  if (!PROFILES[ws.profile]) throw new Error(`Workspace "${id}" has an unknown profile "${ws.profile}".`);
  if (!isAbsolute(String(ws.root || ""))) throw new Error(`Workspace "${id}" root must be an absolute path.`);
  let root;
  try { root = realpathSync.native(ws.root); } catch { throw new Error(`Workspace "${id}" root doesn't exist: ${ws.root}`); }
  if (!statSync(root).isDirectory()) throw new Error(`Workspace "${id}" root is not a folder: ${root}`);
  return { id, root, profile: ws.profile };
}
const CONSOLE_WS = { id: "console", name: "Executor", root: REPO, profile: "full" };
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
  return (list.some((w) => w.id === "console") ? list : [CONSOLE_WS, ...list]).map((w) => (w.id === "console" ? CONSOLE_WS : w)).map((w) => {
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
  const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "ws"}-${randomUUID().slice(0, 4)}`;
  const ws = { id, name, root, profile: mode === "work" ? "full" : "inspect" };
  writeWorkspaces([...list, ws]);
  return listWorkspaces().find((w) => w.id === id);
}
// Removing a workspace only takes it off this list: its folder and files are not touched. Its runs
// stay in the history but can no longer be resumed or browsed (the binding check refuses them).
function removeWorkspace(id) {
  if (id === "console") throw new Error("Executor is this app's own folder and can't be removed.");
  const list = readWorkspaces();
  if (!list.some((w) => w.id === id)) throw new Error(`No workspace "${id}".`);
  const busy = active();
  if (busy && busy.meta.workspace?.id === id) throw new Error("A worker is running in this workspace. Stop or end it first.");
  writeWorkspaces(list.filter((w) => w.id !== id));
  return listWorkspaces();
}
// New display order: the same workspaces, rearranged.
function reorderWorkspaces(ids) {
  const now = listWorkspaces().map((w) => w.id);
  if (!Array.isArray(ids) || ids.length !== now.length || new Set(ids).size !== ids.length || !ids.every((i) => now.includes(i))) throw new Error("The workspace list changed. Reload and try again.");
  const byId = new Map(readWorkspaces().filter((w) => w.id !== "console").map((w) => [w.id, w]));
  writeWorkspaces(ids.map((i) => (i === "console" ? { id: "console" } : byId.get(i))));
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

const TAGS = { "PLAN:": "plan", "OBSERVATION:": "observation", "DECISION:": "decision", "FAILURE:": "failure", "RECOVERY:": "recovery", "VERIFICATION:": "verification", "ARTIFACT:": "artifact", "DONE:": "done" };

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
  tool.startsWith("mcp__figma-executor") ? "Figma"
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
    const why = !samePath(msg.cwd || "", ws.root) ? `worker reports cwd ${msg.cwd}, not the workspace ${ws.root}`
      : extra.length ? `inspect worker has tools outside its allow-list: ${extra.join(", ")}` : null;
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
        run.toolUses.set(b.id, { name: b.name, env });
        if (b.name === "ToolSearch") continue; // loading tool schemas, not work
        run.meta.envs[env] = (run.meta.envs[env] || 0) + 1;
        emit(run, { type: "tool", ref: b.id, env, tool: shortName(b.name), summary: toolSummary(b.name, b.input, run.meta.workspace.root) });
        if ((b.name === "Write" || b.name === "Edit") && b.input?.file_path) addArtifact(run, relTo(run.meta.workspace.root, b.input.file_path), env);
      } else if (b.type === "text" && b.text.trim()) {
        emit(run, { type: "reply", summary: b.text.trim() });
        for (const raw of b.text.split(/\r?\n/)) {
          const line = raw.replace(/^[\s*>•-]+/, "").replace(/\*\*/g, "").trim();
          const tag = Object.keys(TAGS).find((t) => line.toUpperCase().startsWith(t));
          if (!tag) continue;
          const text = line.slice(tag.length).trim();
          if (TAGS[tag] === "artifact") addArtifact(run, relTo(run.meta.workspace.root, text.replace(/[`"]/g, "")), "Files");
          else emit(run, { type: TAGS[tag], summary: text });
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
function addArtifact(run, path, env) {
  // Only files inside the workspace are deliverables; worker scratch files elsewhere (absolute paths) are not.
  if (!path || /^([a-z]:|\/|\\)/i.test(path) || run.meta.artifacts.includes(path)) return;
  run.meta.artifacts.push(path);
  emit(run, { type: "artifact", env, summary: path });
}

function spawnWorker(run, { resume }) {
  const ws = checkBinding(run, { resume });
  const args = [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--mcp-config", mcpConfig(ws.profile), "--strict-mcp-config",
    "--append-system-prompt-file", join(HERE, "worker-instructions.md"),
    ...PROFILES[ws.profile].args,
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

function sendToWorker(run, text) {
  run.meta.messages++;
  emit(run, { type: "user", summary: text });
  setStatus(run, "running");
  run.child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
}

function newRun(prompt, workspaceId = "console") {
  if (active()) throw new Error("A worker is already running. Stop or end it first.");
  const workspace = resolveWorkspace(workspaceId);
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const meta = { id, prompt, workspace, configDir: CONFIG_DIR, createdAt: new Date().toISOString(), status: "starting", sessionId: null, messages: 0, envs: {}, artifacts: [], failures: 0, done: null, costUsd: 0 };
  const run = { meta, toolUses: new Map(), file: join(RUNS, `${id}.jsonl`), raw: join(RUNS, `${id}.raw.jsonl`) };
  writeFileSync(run.file, ""); writeFileSync(run.raw, "");
  runs.set(id, run);
  saveMeta(run);
  emit(run, { type: "status", summary: "starting" });
  spawnWorker(run, { resume: false });
  sendToWorker(run, prompt);
  return run;
}

// Follow-up: same process if it's waiting; otherwise resume the saved session in a new process.
function followUp(run, text) {
  if (alive(run)) {
    if (run.meta.status !== "waiting") throw new Error("The worker is still working on the previous message. Wait for it, or stop it.");
    return sendToWorker(run, text);
  }
  if (active()) throw new Error("Another worker is running. Stop or end it first.");
  if (!run.meta.sessionId) throw new Error("This run has no saved session to resume.");
  checkBinding(run, { resume: true }); // before anything is logged, so a refused resume changes nothing
  emit(run, { type: "note", summary: "Resuming the saved session in a new worker process. Conversation context is kept; tool processes are new (browser pages and logins are gone, Figma and files are unaffected)." });
  setStatus(run, "starting", "resuming session");
  spawnWorker(run, { resume: true });
  sendToWorker(run, text);
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

// ---- prompts ---------------------------------------------------------------
const readPrompts = () => JSON.parse(readFileSync(PROMPTS, "utf8"));
const writePrompts = (p) => writeFileSync(PROMPTS, JSON.stringify(p, null, 1) + "\n");

// ---- http --------------------------------------------------------------------
const TYPES = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".md": "text/plain; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".mjs": "text/plain; charset=utf-8", ".csv": "text/plain; charset=utf-8", ".css": "text/css" };
const body = (req) => new Promise((ok) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => ok(b ? JSON.parse(b) : {})); });
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
    if (url.pathname === "/tree") {
      const entries = dirInside(resolveWorkspace(url.searchParams.get("workspace") || "").root, url.searchParams.get("path") || "");
      return entries ? json(res, 200, entries) : json(res, 404, { error: "not found" });
    }

    // runs
    if (url.pathname === "/runs" && req.method === "GET") return json(res, 200, { runs: allMetas(), active: active()?.meta.id || null });
    if (url.pathname === "/runs" && req.method === "POST") {
      const { prompt, workspace } = await body(req);
      if (!prompt?.trim()) throw new Error("Empty message");
      return json(res, 200, newRun(prompt.trim(), workspace === undefined ? "console" : String(workspace)).meta);
    }
    if (parts[0] === "runs" && parts[1]) {
      const run = loadRun(parts[1]);
      if (!run) return json(res, 404, { error: "no such run" });
      const action = parts[2];
      if (!action && req.method === "GET") return json(res, 200, run.meta);
      // Actions change state, so they're POST-only (a GET would skip the request guard).
      if (action && req.method !== "POST") return json(res, 405, { error: "Use POST" });
      if (action === "message") { const { text } = await body(req); if (!text?.trim()) throw new Error("Empty message"); followUp(run, text.trim()); return json(res, 200, run.meta); }
      if (action === "stop") { if (alive(run)) { run.stopRequested = true; run.child.kill(); } return json(res, 200, run.meta); }
      if (action === "end") { if (alive(run)) { run.endRequested = true; run.child.stdin.end(); } return json(res, 200, run.meta); }
      if (action === "restart") return json(res, 200, newRun(run.meta.prompt, checkBinding(run, { resume: false }).id).meta);
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
