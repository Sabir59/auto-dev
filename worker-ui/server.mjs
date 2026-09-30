#!/usr/bin/env node
// Minimal local Worker UI server. It does NOT reason or run tools: it starts
// the existing worker (a headless Claude Code session in this repo, with this
// repo's MCP servers), translates the worker's own stream-json output into a
// small event contract, stores it, and streams it to the page over SSE.
//
//   node worker-ui/server.mjs      -> http://localhost:8799
//
// Event contract (one JSON object per line in runs/<id>.jsonl):
//   { ts, type, env?, tool?, summary, detail? }
//   type: goal | start | tool | result | failure | artifact | completed
//         | plan | observation | decision | recovery | verification | done | note
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const RUNS = join(HERE, "runs");
const PORT = 8799;
mkdirSync(RUNS, { recursive: true });

// Tools the worker may use. Scoped: MCP environments, files, node/curl in the shell, web.
const ALLOWED = [
  "mcp__figma-executor", "mcp__browser-executor",
  "Read", "Write", "Edit", "Glob", "Grep", "Bash(node:*)", "Bash(curl:*)", "WebFetch", "WebSearch", "ToolSearch",
];
const TAGS = { "PLAN:": "plan", "OBSERVATION:": "observation", "DECISION:": "decision", "FAILURE:": "failure", "RECOVERY:": "recovery", "VERIFICATION:": "verification", "ARTIFACT:": "artifact", "DONE:": "done" };

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

// ---- runs --------------------------------------------------------------
let current = null; // { id, child, file, toolUses: Map }
const listeners = new Map(); // runId -> Set(res)

function emit(run, ev) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...ev });
  appendFileSync(run.file, line + "\n");
  for (const res of listeners.get(run.id) || []) res.write(`data: ${line}\n\n`);
}

function translate(run, msg) {
  if (msg.type === "system" && msg.subtype === "init") {
    const servers = (msg.mcp_servers || []).map((s) => `${s.name}: ${s.status}`).join(", ");
    return emit(run, { type: "start", summary: "Worker started", detail: servers ? `MCP ${servers}` : undefined });
  }
  if (msg.type === "assistant") {
    for (const b of msg.message?.content || []) {
      if (b.type === "tool_use") {
        const env = envOf(b.name);
        run.toolUses.set(b.id, { name: b.name, env, input: b.input });
        if (b.name === "ToolSearch") continue; // loading tool schemas, not work
        emit(run, { type: "tool", env, tool: shortName(b.name), summary: toolSummary(b.name, b.input) });
        if ((b.name === "Write" || b.name === "Edit") && b.input?.file_path) emit(run, { type: "artifact", env, summary: rel(b.input.file_path), detail: b.name === "Write" ? "written" : "edited" });
      } else if (b.type === "text" && b.text.trim()) {
        for (const raw of b.text.split(/\r?\n/)) {
          const line = raw.replace(/^[\s*>•-]+/, "").replace(/\*\*/g, "").trim();
          if (!line) continue;
          const tag = Object.keys(TAGS).find((t) => line.toUpperCase().startsWith(t));
          emit(run, tag ? { type: TAGS[tag], summary: line.slice(tag.length).trim() } : { type: "note", summary: clip(line, 400) });
        }
      }
    }
    return;
  }
  if (msg.type === "user") {
    for (const b of msg.message?.content || []) {
      if (b.type !== "tool_result") continue;
      const use = run.toolUses.get(b.tool_use_id) || { name: "?", env: "Internal" };
      if (use.name === "ToolSearch") continue;
      const text = resultText(b.content);
      emit(run, { type: b.is_error ? "failure" : "result", env: use.env, tool: shortName(use.name), summary: clip(text, 220) });
    }
    return;
  }
  if (msg.type === "result") {
    emit(run, {
      type: "completed",
      summary: msg.is_error ? `Worker stopped with an error (${msg.subtype})` : "Worker finished",
      detail: JSON.stringify({ turns: msg.num_turns, seconds: Math.round((msg.duration_ms || 0) / 1000), costUsd: msg.total_cost_usd, final: clip(msg.result, 600) }),
    });
  }
}

function startRun(goal) {
  if (current?.child && current.child.exitCode === null) throw new Error("A run is already in progress");
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const run = { id, file: join(RUNS, `${id}.jsonl`), raw: join(RUNS, `${id}.raw.jsonl`), toolUses: new Map() };
  writeFileSync(run.file, "");
  writeFileSync(run.raw, "");
  current = run;
  emit(run, { type: "goal", summary: goal });

  const args = [
    "-p", "--output-format", "stream-json", "--verbose",
    "--mcp-config", ".mcp.json", "--strict-mcp-config",
    "--append-system-prompt-file", join(HERE, "worker-instructions.md"),
    "--allowedTools", ...ALLOWED,
  ];
  // shell: true so Windows resolves the `claude` shim; the goal goes in on stdin (no quoting issues).
  const child = spawn("claude", args.map((a) => (/[\s*()|&]/.test(a) ? `"${a}"` : a)), { cwd: REPO, shell: true });
  run.child = child;
  child.stdin.end(goal);
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      appendFileSync(run.raw, line + "\n");
      try { translate(run, JSON.parse(line)); } catch (e) { emit(run, { type: "note", summary: `unparsed worker output: ${clip(line, 120)}` }); }
    }
  });
  child.stderr.on("data", (d) => emit(run, { type: "note", summary: `worker stderr: ${clip(d, 200)}` }));
  child.on("exit", (code) => emit(run, { type: "note", summary: `worker process exited (code ${code})` }));
  return id;
}

// ---- http --------------------------------------------------------------
const TYPES = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".md": "text/plain; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".mjs": "text/plain; charset=utf-8", ".csv": "text/plain; charset=utf-8" };
const body = (req) => new Promise((ok) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => ok(b)); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === "/") { res.writeHead(200, { "content-type": TYPES[".html"] }); return res.end(readFileSync(join(HERE, "index.html"))); }
    if (url.pathname === "/run" && req.method === "POST") {
      const { goal } = JSON.parse(await body(req));
      if (!goal?.trim()) throw new Error("Empty goal");
      const id = startRun(goal.trim());
      res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ id }));
    }
    if (url.pathname === "/stop" && req.method === "POST") {
      if (current?.child && current.child.exitCode === null) { current.child.kill(); emit(current, { type: "note", summary: "Stopped by the user" }); }
      res.writeHead(204); return res.end();
    }
    if (url.pathname === "/runs") {
      const runs = readdirSync(RUNS).filter((f) => f.endsWith(".jsonl") && !f.endsWith(".raw.jsonl")).sort().reverse()
        .map((f) => ({ id: f.replace(".jsonl", ""), goal: (JSON.parse(readFileSync(join(RUNS, f), "utf8").split("\n")[0] || "{}").summary || "") }));
      res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ runs, active: current?.child?.exitCode === null ? current.id : null }));
    }
    if (url.pathname === "/events") {
      const id = url.searchParams.get("run");
      const file = join(RUNS, `${id}.jsonl`);
      if (!/^[\w-]+$/.test(id || "") || !existsSync(file)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      for (const line of readFileSync(file, "utf8").split("\n")) if (line) res.write(`data: ${line}\n\n`);
      if (!listeners.has(id)) listeners.set(id, new Set());
      listeners.get(id).add(res);
      req.on("close", () => listeners.get(id).delete(res));
      return;
    }
    if (url.pathname === "/file") {
      const p = resolve(REPO, url.searchParams.get("path") || "");
      if (!p.toLowerCase().startsWith(REPO.toLowerCase()) || !existsSync(p) || !statSync(p).isFile()) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "content-type": TYPES[extname(p).toLowerCase()] || "text/plain; charset=utf-8" }); return res.end(readFileSync(p));
    }
    res.writeHead(404); res.end("not found");
  } catch (e) {
    res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: e.message }));
  }
}).listen(PORT, () => console.log(`Worker UI on http://localhost:${PORT}`));
