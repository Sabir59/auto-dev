// FAKE MODEL PROVIDER, FOR TESTS ONLY. A scripted stand-in for the Anthropic Messages API
// (/v1/messages, streaming), so the hosted path can be tested end to end with the real Claude Code
// CLI, the real gateway and real tools, without a provider key. It proves the platform's side: what
// the runtime sends, what the gateway forwards, and what the tools are allowed to do. It proves
// nothing about a real model; live execution is verified only with a real key (CLOUD_DEPLOYMENT.md).
//
// A test registers a script (POST /__script { name, steps }) and puts "FAKE-SCRIPT:<name>" in the
// prompt. Each model request answers the next step: the number of assistant turns after the latest
// user message carrying the marker picks it. A step is one of
//   { tool: { name, input } } | { tools: [{ name, input }, …] } | { text }
//   { delayMs, then: step }    (keeps the stream open with pings first: cancellation tests)
//   { error: { status, type, message, headers } }
// After the last step the answer is "DONE: script <name> finished". Requests without tools (the
// runtime's own side requests, e.g. titles) get a short text.
// GET /__log: every request, with header facts (never values except a sha of the key), the model,
// the tool names offered, the system prompt and the tool results seen.
import http from "node:http";
import { createHash } from "node:crypto";

export function startFakeAnthropic(port, { apiKey }) {
  const scripts = new Map(), log = [];
  let n = 0;
  const sha = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 16);
  const text = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? text(b.content) : "")).join("\n") : "");
  function pick(body) {
    const msgs = body.messages || [];
    let at = -1, name = null;
    for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].role !== "user") continue; const m = /FAKE-SCRIPT:([\w-]+)/.exec(text(msgs[i].content)); if (m) { at = i; name = m[1]; break; } }
    if (!name) return { step: { text: "No script in this conversation." }, name: null, index: 0 };
    const index = msgs.slice(at + 1).filter((m) => m.role === "assistant").length;
    const steps = scripts.get(name) || [];
    return { step: steps[index] || { text: `DONE: script ${name} finished` }, name, index };
  }
  function sse(res, model, step) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "request-id": `req_fake_${++n}` });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev("message_start", { message: { id: `msg_fake_${n}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
    const tools = step.tools || (step.tool ? [step.tool] : []);
    let i = 0;
    if (step.text || !tools.length) {
      ev("content_block_start", { index: i, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { index: i, delta: { type: "text_delta", text: step.text || "OK" } });
      ev("content_block_stop", { index: i }); i++;
    }
    for (const t of tools) {
      ev("content_block_start", { index: i, content_block: { type: "tool_use", id: `toolu_fake_${n}_${i}`, name: t.name, input: {} } });
      ev("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(t.input || {}) } });
      ev("content_block_stop", { index: i }); i++;
    }
    ev("message_delta", { delta: { stop_reason: tools.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
    ev("message_stop", {});
    res.end();
  }
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    let raw = ""; for await (const c of req) raw += c;
    if (u.pathname === "/__script" && req.method === "POST") { const j = JSON.parse(raw); scripts.set(j.name, j.steps); res.writeHead(200); return res.end("{}"); }
    if (u.pathname === "/__log") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(log)); }
    if (u.pathname === "/api/hello") { res.writeHead(200); return res.end(); }
    const keyOk = req.headers["x-api-key"] === apiKey;
    const entry = { at: Date.now(), method: req.method, path: u.pathname, search: u.search, keyOk, keySha: req.headers["x-api-key"] ? sha(req.headers["x-api-key"]) : null, authorization: !!req.headers.authorization,
      anthropicVersion: req.headers["anthropic-version"] || null, anthropicBeta: !!req.headers["anthropic-beta"], headerNames: Object.keys(req.headers) };
    log.push(entry);
    if (!keyOk) { res.writeHead(401, { "content-type": "application/json" }); return res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })); }
    if (u.pathname === "/v1/messages/count_tokens") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ input_tokens: 1000 })); }
    if (u.pathname === "/v1/models") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [] })); }
    if (u.pathname !== "/v1/messages") { res.writeHead(404); return res.end(); }
    const body = JSON.parse(raw || "{}");
    entry.model = body.model; entry.stream = !!body.stream; entry.tools = (body.tools || []).map((t) => t.name);
    entry.system = (Array.isArray(body.system) ? body.system.map((b) => b.text).join("\n") : String(body.system || "")).slice(0, 200000);
    const last = (body.messages || []).at(-1);
    entry.toolResults = Array.isArray(last?.content) ? last.content.filter((b) => b.type === "tool_result").map((b) => ({ id: b.tool_use_id, isError: !!b.is_error, text: text(b.content).slice(0, 2000) })) : [];
    if (!entry.tools.length) { const step = { text: "Fake title" }; return body.stream ? sse(res, body.model, step) : (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify({ id: `msg_fake_${++n}`, type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: step.text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2 } }))); }
    let { step, name, index } = pick(body);
    entry.script = name; entry.step = index;
    if (step.error) { res.writeHead(step.error.status || 500, { "content-type": "application/json", ...(step.error.headers || {}) }); return res.end(JSON.stringify({ type: "error", error: { type: step.error.type || "api_error", message: step.error.message || "fake failure" } })); }
    if (step.delayMs) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ping = setInterval(() => res.write("event: ping\ndata: {\"type\":\"ping\"}\n\n"), 1000);
      let closed = false; res.on("close", () => { closed = true; clearInterval(ping); entry.clientClosed = true; });
      await new Promise((r) => setTimeout(r, step.delayMs)); clearInterval(ping);
      if (closed) return;
      res.writeHead = () => res; // headers already sent
      step = step.then || { text: "Waited." };
    }
    return sse(res, body.model, step);
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok({ server, scripts, log, close: () => new Promise((r) => server.close(r)) })));
}
