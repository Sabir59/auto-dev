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
// Event contract, one JSON object per line in runs/<id>.jsonl:
//   { ts, type, env?, tool?, summary, detail? }
//   type: user | reply | status | start | tool | result | failure | artifact | completed
//         | plan | observation | decision | recovery | verification | done | note
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, extname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const RUNS = join(HERE, "runs");
const PROMPTS = join(HERE, "prompts.json");
const PORT = 8799;
mkdirSync(RUNS, { recursive: true });
if (!existsSync(PROMPTS)) writeFileSync(PROMPTS, "[]\n");

// Tools the worker may use: MCP environments, files, node/curl in the shell, web.
const ALLOWED = [
  "mcp__figma-executor", "mcp__browser-executor",
  "Read", "Write", "Edit", "Glob", "Grep", "Bash(node:*)", "Bash(curl:*)", "WebFetch", "WebSearch", "ToolSearch",
];
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
const rel = (p) => { const r = String(p || "").replace(/\\/g, "/"); const base = REPO.replace(/\\/g, "/"); return r.toLowerCase().startsWith(base.toLowerCase() + "/") ? r.slice(base.length + 1) : r; };
function toolSummary(name, input = {}) {
  const key = input.url || input.selector || input.id || input.pageId || input.componentId || input.file_path || input.path || input.pattern || input.query || input.command || "";
  return `${shortName(name)} ${clip(rel(key), 110)}`.trim();
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
        emit(run, { type: "tool", env, tool: shortName(b.name), summary: toolSummary(b.name, b.input) });
        if ((b.name === "Write" || b.name === "Edit") && b.input?.file_path) addArtifact(run, rel(b.input.file_path), env);
      } else if (b.type === "text" && b.text.trim()) {
        emit(run, { type: "reply", summary: b.text.trim() });
        for (const raw of b.text.split(/\r?\n/)) {
          const line = raw.replace(/^[\s*>•-]+/, "").replace(/\*\*/g, "").trim();
          const tag = Object.keys(TAGS).find((t) => line.toUpperCase().startsWith(t));
          if (!tag) continue;
          const text = line.slice(tag.length).trim();
          if (TAGS[tag] === "artifact") addArtifact(run, text.replace(/[`"]/g, ""), "Files");
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
      emit(run, { type: b.is_error ? "failure" : "result", env: use.env, tool: shortName(use.name), summary: clip(resultText(b.content), 220) });
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
function addArtifact(run, path, env) {
  // Only files inside the repo are deliverables; worker scratch files elsewhere (absolute paths) are not.
  if (!path || /^([a-z]:|\/|\\)/i.test(path) || run.meta.artifacts.includes(path)) return;
  run.meta.artifacts.push(path);
  emit(run, { type: "artifact", env, summary: path });
}

function spawnWorker(run, { resume }) {
  const args = [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--mcp-config", ".mcp.json", "--strict-mcp-config",
    "--append-system-prompt-file", join(HERE, "worker-instructions.md"),
    "--allowedTools", ...ALLOWED,
    ...(resume ? ["--resume", run.meta.sessionId] : []),
  ];
  const child = spawn(CLAUDE.cmd, CLAUDE.shell ? args.map((a) => (/[\s*()|&]/.test(a) ? `"${a}"` : a)) : args, { cwd: REPO, shell: CLAUDE.shell });
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
    if (run.stopRequested) setStatus(run, "stopped", "stopped by the user");
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

function newRun(prompt) {
  if (active()) throw new Error("A worker is already running. Stop or end it first.");
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const meta = { id, prompt, createdAt: new Date().toISOString(), status: "starting", sessionId: null, messages: 0, envs: {}, artifacts: [], failures: 0, done: null, costUsd: 0 };
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

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (url.pathname === "/") { res.writeHead(200, { "content-type": TYPES[".html"] }); return res.end(readFileSync(join(HERE, "index.html"))); }

    // runs
    if (url.pathname === "/runs" && req.method === "GET") return json(res, 200, { runs: allMetas(), active: active()?.meta.id || null });
    if (url.pathname === "/runs" && req.method === "POST") {
      const { prompt } = await body(req);
      if (!prompt?.trim()) throw new Error("Empty message");
      return json(res, 200, newRun(prompt.trim()).meta);
    }
    if (parts[0] === "runs" && parts[1]) {
      const run = loadRun(parts[1]);
      if (!run) return json(res, 404, { error: "no such run" });
      const action = parts[2];
      if (!action && req.method === "GET") return json(res, 200, run.meta);
      if (action === "message") { const { text } = await body(req); if (!text?.trim()) throw new Error("Empty message"); followUp(run, text.trim()); return json(res, 200, run.meta); }
      if (action === "stop") { if (alive(run)) { run.stopRequested = true; run.child.kill(); } return json(res, 200, run.meta); }
      if (action === "end") { if (alive(run)) { run.endRequested = true; run.child.stdin.end(); } return json(res, 200, run.meta); }
      if (action === "restart") return json(res, 200, newRun(run.meta.prompt).meta);
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

    // artifacts (read-only, inside the repo)
    if (url.pathname === "/file") {
      const p = resolve(REPO, url.searchParams.get("path") || "");
      if (!p.toLowerCase().startsWith(REPO.toLowerCase()) || !existsSync(p) || !statSync(p).isFile()) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "content-type": TYPES[extname(p).toLowerCase()] || "text/plain; charset=utf-8" });
      return res.end(readFileSync(p));
    }
    res.writeHead(404); res.end("not found");
  } catch (e) {
    json(res, 400, { error: e.message });
  }
}).listen(PORT, () => console.log(`Worker Console on http://localhost:${PORT} (worker binary: ${CLAUDE.cmd}${CLAUDE.shell ? " via shell" : ""})`));
