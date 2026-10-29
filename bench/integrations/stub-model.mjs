// A scripted stand-in for the model API, for tests of what the real Claude Code runtime enforces
// below the model. The runtime is pointed at it (ANTHROPIC_BASE_URL; see stub-claude.mjs) and asks
// it for each next step as it would ask a model. A run's prompt carries its plan, a line
//   STUB-PLAN <base64 of JSON { n: <unique>, calls: [{ name: "Read", input: { file_path: "..." } }, ...] }>
// and the stand-in answers with those tool calls, one per turn, then "STUB-DONE". What the runtime
// sent back for each call (its tool_result: content and is_error) is recorded, so a test sees exactly
// what a model would have seen. Requests without a plan (the runtime's own side requests) get "ok".
//   const stub = await startStubModel(); const line = planLine(calls); ...; stub.results(line); stub.close();
// Each planLine is unique, so two runs with the same calls never share results.
import http from "node:http";
import { randomUUID } from "node:crypto";

export const planLine = (calls) => `STUB-PLAN ${Buffer.from(JSON.stringify({ n: randomUUID(), calls })).toString("base64")}`;

const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b.type === "text" ? b.text : b.type ? `[${b.type}]` : "")).join("\n") : "");
const blocks = (m) => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content || []);

export async function startStubModel() {
  const log = new Map(); // planId -> [{ step, tool, input, isError, text }]
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const path = req.url.split("?")[0];
      if (req.method === "POST" && path.endsWith("/messages/count_tokens")) return send(res, 200, { input_tokens: 100 });
      if (!(req.method === "POST" && path.endsWith("/messages"))) return send(res, 404, { type: "error", error: { type: "not_found_error", message: "stub" } });
      let body; try { body = JSON.parse(raw); } catch { return send(res, 400, { type: "error", error: { type: "invalid_request_error", message: "bad json" } }); }
      requests.push({ at: Date.now(), model: body.model, tools: (body.tools || []).map((t) => t.name) });
      const msgs = body.messages || [];
      // the newest user message that carries a plan, and the tool results that came after it
      let at = -1, plan = null, planId = null;
      for (let i = msgs.length - 1; i >= 0 && at < 0; i--) {
        if (msgs[i].role !== "user") continue;
        for (const b of blocks(msgs[i])) {
          const m = b.type === "text" && /STUB-PLAN (\S+)/.exec(b.text);
          if (m) { at = i; planId = m[1]; try { plan = JSON.parse(Buffer.from(m[1], "base64").toString("utf8")).calls || []; } catch { plan = []; } break; }
        }
      }
      if (!plan) return reply(res, body, { text: "ok" });
      const calls = [], results = [];
      for (const m of msgs.slice(at)) for (const b of blocks(m)) {
        if (m.role === "assistant" && b.type === "tool_use") calls.push(b);
        if (m.role === "user" && b.type === "tool_result") results.push(b);
      }
      const rec = log.get(planId) || []; log.set(planId, rec);
      results.forEach((r, k) => { if (!rec[k]) { const c = calls.find((x) => x.id === r.tool_use_id); rec[k] = { step: k, tool: c?.name, input: c?.input, isError: !!r.is_error, text: textOf(r.content) }; } });
      const k = results.length;
      // "$PERSISTED" in a step's input: the file the runtime saved the previous step's large output to
      const saved = k ? /([A-Za-z]:[\\/][^\s"'<>]*?tool-results[\\/][^\s"'<>]+|\/[^\s"'<>]*?tool-results\/[^\s"'<>]+)/.exec(rec[k - 1]?.text || "")?.[1] : null;
      const fill = (v) => (typeof v === "string" ? v.replace("$PERSISTED", saved || "(nothing was saved)") : Array.isArray(v) ? v.map(fill) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([a, b]) => [a, fill(b)])) : v);
      if (k < plan.length) return reply(res, body, { tool: { id: `toolu_stub_${k}_${Math.random().toString(36).slice(2, 10)}`, name: plan[k].name, input: fill(plan[k].input) } });
      return reply(res, body, { text: "STUB-DONE" });
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    results: (line) => log.get(String(line).slice("STUB-PLAN ".length)) || [],
    requests,
    close: () => new Promise((ok) => server.close(ok)),
  };
}

function send(res, status, obj) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); }
function reply(res, body, { text, tool }) {
  const id = `msg_stub_${Math.random().toString(36).slice(2, 12)}`, usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const block = tool ? { type: "tool_use", id: tool.id, name: tool.name, input: tool.input } : { type: "text", text };
  const stop = tool ? "tool_use" : "end_turn";
  if (!body.stream) return send(res, 200, { id, type: "message", role: "assistant", model: body.model, content: [block], stop_reason: stop, stop_sequence: null, usage });
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev("message_start", { message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } });
  if (tool) {
    ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} } });
    ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } });
  } else {
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
  }
  ev("content_block_stop", { index: 0 });
  ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
  ev("message_stop", {});
  res.end();
}
