// A stand-in for the Claude Code binary, for tests: the console starts it exactly as it starts the
// real one (CLAUDE_BIN=<node>, CLAUDE_BIN_ARGS=["<this file>"]). It records what it was given — its
// arguments, the MCP servers in its --mcp-config with their environment, its --settings — to
// $FAKE_CLAUDE_OUT/<n>.json, says it has started, and waits until it's stopped. Nothing reaches a model.
// With FAKE_CLAUDE_MCP=1 it also starts and connects its MCP servers, as the runtime does, and answers
// mcp_status with the tools each one lists now (each answer is logged to <n>.status.jsonl);
// FAKE_CLAUDE_STALE=1 (or the file FAKE_CLAUDE_STALE_FILE existing) answers with the tools listed when it
// connected, as a runtime that ignores tools/list_changed would. The tools listed at connection are
// logged first ({ initial: true }).
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const argv = process.argv.slice(2), out = process.env.FAKE_CLAUDE_OUT;
const val = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const list = (flag) => { const i = argv.indexOf(flag); if (i < 0) return null; const r = []; for (let k = i + 1; k < argv.length && !argv[k].startsWith("--"); k++) r.push(argv[k]); return r; };
if (argv[0] === "auth") { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "test" })); process.exit(0); }
let mcp = null; const m = val("--mcp-config");
try { mcp = m ? JSON.parse(existsSync(m) ? readFileSync(m, "utf8") : m) : null; } catch { mcp = { unreadable: m }; }
let settings = null; try { settings = JSON.parse(val("--settings") || "null"); } catch {}
const record = { argv, tools: val("--tools") ?? null, allowedTools: list("--allowedTools"), restricted: argv.includes("--restricted"), settingSources: val("--setting-sources") ?? null,
  permissionPrompts: val("--permission-prompts") ?? null, deny: settings?.permissions?.deny || [], resume: argv.includes("--resume"),
  servers: mcp?.mcpServers ? Object.fromEntries(Object.entries(mcp.mcpServers).map(([n, s]) => [n, { args: s.args, env: s.env || {} }])) : null, cwd: process.cwd(), at: new Date().toISOString() };
const stamp = `${Date.now()}-${process.pid}`;
if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, `${stamp}.json`), JSON.stringify(record, null, 1)); }
// FAKE_CLAUDE_SESSIONS=1: a real-looking session (a UUID, kept on --resume, with a transcript in
// $CLAUDE_CONFIG_DIR/projects/fake/), so the console can resume it. Only for a test that set
// WORKER_CONSOLE_CLAUDE_CONFIG_DIR to a folder of its own.
const SID = process.env.FAKE_CLAUDE_SESSIONS === "1" && process.env.CLAUDE_CONFIG_DIR ? (val("--resume") || randomUUID()) : `fake-${process.pid}`;
if (SID !== `fake-${process.pid}`) { const d = join(process.env.CLAUDE_CONFIG_DIR, "projects", "fake"); mkdirSync(d, { recursive: true }); appendFileSync(join(d, `${SID}.jsonl`), JSON.stringify({ cwd: process.cwd(), sessionId: SID }) + String.fromCharCode(10)); }
const say = (o) => process.stdout.write(JSON.stringify(o) + "\n");

const clients = new Map(), first = new Map();
if (process.env.FAKE_CLAUDE_MCP === "1" && mcp?.mcpServers) {
  const sdk = new URL("../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/", import.meta.url);
  const { Client } = await import(new URL("client/index.js", sdk)), { StdioClientTransport } = await import(new URL("client/stdio.js", sdk));
  await Promise.all(Object.entries(mcp.mcpServers).map(async ([n, s]) => {
    try {
      const c = new Client({ name: "fake-claude", version: "1" });
      await c.connect(new StdioClientTransport({ command: s.command, args: s.args, env: { ...process.env, ...(s.env || {}) }, stderr: "ignore" }));
      clients.set(n, c); first.set(n, (await c.listTools()).tools.map((t) => t.name));
      if (out) appendFileSync(join(out, `${stamp}.status.jsonl`), JSON.stringify({ at: Date.now(), initial: true, servers: [{ name: n, tools: first.get(n) }] }) + "\n");
    } catch { clients.set(n, null); }
  }));
}
async function mcpStatus() {
  const rows = await Promise.all([...clients].map(async ([name, c]) => {
    if (!c) return { name, status: "failed", tools: [] };
    const stale = process.env.FAKE_CLAUDE_STALE === "1" || (!!process.env.FAKE_CLAUDE_STALE_FILE && existsSync(process.env.FAKE_CLAUDE_STALE_FILE));
    const tools = stale ? first.get(name) : (await c.listTools()).tools.map((t) => t.name);
    return { name, status: "connected", tools: tools.map((t) => ({ name: t })) };
  }));
  if (out) appendFileSync(join(out, `${stamp}.status.jsonl`), JSON.stringify({ at: Date.now(), servers: rows.map((r) => ({ name: r.name, tools: r.tools.map((t) => t.name) })) }) + "\n");
  return rows;
}

say({ type: "system", subtype: "init", session_id: SID, cwd: process.cwd(), tools: [], mcp_servers: [] });
process.stdin.on("data", (d) => {
  for (const line of String(d).split("\n").filter(Boolean)) {
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type === "control_request" && msg.request?.subtype === "mcp_status" && clients.size) {
      mcpStatus().then((mcpServers) => say({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { mcpServers } } }));
      continue;
    }
    if (msg.type === "control_request") say({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: {} } });
    // A user message isn't answered: the run stays "working" until the test stops it. With
    // FAKE_CLAUDE_REPLY=1 it's logged (<n>.messages.jsonl) and answered "ok", and the run waits.
    if (msg.type === "user" && process.env.FAKE_CLAUDE_REPLY === "1") {
      const c = msg.message?.content, text = typeof c === "string" ? c : (c || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (out) appendFileSync(join(out, `${stamp}.messages.jsonl`), JSON.stringify({ at: Date.now(), text }) + "\n");
      if (process.env.FAKE_CLAUDE_REPLY === "1") {
        // A line "SAY: <text>" in the message is answered with <text> (to script a worker's tagged lines).
        const reply = /^SAY: (.+)$/m.exec(text)?.[1] || "ok";
        say({ type: "assistant", session_id: SID, message: { role: "assistant", content: [{ type: "text", text: reply }], usage: { input_tokens: 1, output_tokens: 1 } } });
        say({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: SID, duration_ms: 1, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
      }
    }
  }
});
process.stdin.on("end", async () => { for (const c of clients.values()) await c?.close().catch(() => {}); process.exit(0); });
