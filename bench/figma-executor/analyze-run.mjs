// Where did a run's tokens go? Reads a run's raw stream (runs/<id>.raw.jsonl: the runtime's own
// output) and prints, without any model call:
//  - model requests and the context each one carried (input + cache read + cache write: the
//    runtime's per-request usage numbers);
//  - per-turn token totals (the runtime's result messages: cumulative per worker process);
//  - tool calls by tool, with their result sizes in CHARACTERS (measured, not tokens).
//   node bench/figma-executor/analyze-run.mjs <path to runs/<id>.raw.jsonl>
import { readFileSync } from "node:fs";

const f = process.argv[2];
if (!f) { console.error("usage: analyze-run.mjs <runs/<id>.raw.jsonl>"); process.exit(2); }
const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
const seen = new Set(), ctx = [], tools = {}, uses = new Map();
let turns = 0, processes = 0, compactions = 0, lastProc = null; const tok = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }; let cost = 0;
for (const l of lines) {
  let m; try { m = JSON.parse(l); } catch { continue; }
  if (m.type === "system" && m.subtype === "compact_boundary") compactions++;
  if (m.type === "assistant") {
    if (!seen.has(m.message.id)) { seen.add(m.message.id); const u = m.message.usage || {}; ctx.push((u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)); }
    for (const b of m.message.content || []) if (b.type === "tool_use") { uses.set(b.id, b.name); (tools[b.name] ||= { calls: 0, chars: 0, images: 0 }).calls++; }
  }
  if (m.type === "user") for (const b of m.message.content || []) if (b.type === "tool_result") {
    const t = tools[uses.get(b.tool_use_id)]; if (!t) continue;
    const c = b.content; if (typeof c === "string") t.chars += c.length; else if (Array.isArray(c)) for (const x of c) { if (x.type === "text") t.chars += x.text.length; if (x.type === "image") t.images++; }
  }
  if (m.type === "result") {
    turns++;
    const now = Object.values(m.modelUsage || {}).reduce((a, u) => ({ input: a.input + (u.inputTokens || 0), output: a.output + (u.outputTokens || 0), cacheRead: a.cacheRead + (u.cacheReadInputTokens || 0), cacheWrite: a.cacheWrite + (u.cacheCreationInputTokens || 0), cost: (m.total_cost_usd || 0) }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    // cumulative per process: a drop means a new worker process (a resume)
    if (!lastProc || now.cacheRead < lastProc.cacheRead) { processes++; lastProc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }; }
    for (const k of Object.keys(tok)) tok[k] += now[k] - lastProc[k];
    cost += now.cost - lastProc.cost; lastProc = now;
  }
}
const sorted = [...ctx].sort((a, b) => a - b), k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
console.log(`turns ${turns} · worker processes ${processes} · compactions ${compactions}`);
console.log(`model requests ${ctx.length} · context per request: first ${k(ctx[0] || 0)}, median ${k(sorted[Math.floor(sorted.length / 2)] || 0)}, max ${k(sorted.at(-1) || 0)}, last ${k(ctx.at(-1) || 0)}   [runtime]`);
console.log(`tokens: ${k(tok.cacheRead)} read from cache, ${k(tok.cacheWrite)} written to cache, ${k(tok.input)} new input, ${k(tok.output)} output · list-price estimate $${cost.toFixed(2)}   [runtime]`);
console.log(`\n${"tool".padEnd(40)} ${"calls".padStart(5)} ${"result chars".padStart(13)} images   [measured]`);
for (const [n, t] of Object.entries(tools).sort((a, b) => b[1].calls - a[1].calls).slice(0, 25)) console.log(`${n.replace("mcp__figma-executor__", "figma:").padEnd(40)} ${String(t.calls).padStart(5)} ${String(t.chars).padStart(13)} ${String(t.images).padStart(6)}`);
