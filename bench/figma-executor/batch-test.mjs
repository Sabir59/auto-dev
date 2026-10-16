// figma_batch and the compact/bounded figma_get_document_state, against a FAKE Figma bridge (an
// in-memory model of the plugin's commands), so nothing touches a real Figma file. The MCP server
// (mcp/server.mjs) runs for real, over stdio, exactly as a worker would use it.
//   node bench/figma-executor/batch-test.mjs
import { Client } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import http from "node:http";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", "..");
const must = (c, m) => { if (!c) throw new Error(m); };
// ---- the fake plugin: nodes with parents; creates need an existing parent, edits an existing node
let seq = 100;
const nodes = new Map([["0:1", { id: "0:1", name: "Page", type: "PAGE", children: [] }]]);
const sent = [];
function deep(n, d) {
  const out = { id: n.id, name: n.name, type: n.type, x: 0, y: 0, width: n.width || 100, height: n.height || 40, absX: 10, absY: 20, visible: true, opacity: 1,
    layoutMode: n.layoutMode || "NONE", itemSpacing: n.itemSpacing || 0, padding: { top: 0, right: 0, bottom: 0, left: 0 },
    fills: [{ type: "SOLID", hex: n.fill || "#ffffff", r: 255, g: 255, b: 255, a: 1, boundVariable: null }], strokes: [{ type: "SOLID", hex: "#000000" }], strokeWeight: 1, cornerRadius: 8,
    effects: [{ type: "DROP_SHADOW", radius: 4 }], ...(n.type === "TEXT" ? { characters: n.characters || "", fontName: { family: "Inter", style: "Regular" }, fontSize: 16, lineHeight: { unit: "AUTO" } } : {}) };
  if (d > 0 && n.children?.length) out.children = n.children.map((id) => deep(nodes.get(id), d - 1));
  return out;
}
const handlers = {
  GET_FILE_INFO: () => ({ fileName: "Fake", fileKey: "FAKEKEY000001", currentPage: { id: "0:1", name: "Page" } }),
  CREATE_FRAME: (p) => create("FRAME", p), CREATE_TEXT: (p) => create("TEXT", p),
  MODIFY_NODE: (p) => { const n = nodes.get(p.id); if (!n) throw new Error(`Node not found: ${p.id}`); Object.assign(n, p.props || {}); return { id: n.id, summary: `SUCCESS: modified ${n.name}` }; },
  SET_AUTO_LAYOUT: (p) => { const n = nodes.get(p.id); if (!n) throw new Error(`Node not found: ${p.id}`); n.layoutMode = p.direction || "VERTICAL"; n.itemSpacing = p.gap || 0; return { id: n.id, summary: "SUCCESS: auto layout" }; },
  DELETE_NODE: (p) => { if (!nodes.delete(p.id)) throw new Error(`Node not found: ${p.id}`); return { summary: "SUCCESS: deleted" }; },
  GET_DOCUMENT_STATE: (p) => { if (p.id) { const n = nodes.get(p.id); if (!n) throw new Error(`Node not found: ${p.id}`); return { node: deep(n, p.depth || 4) }; } const page = nodes.get("0:1"); return { page: "Page", count: page.children.length, nodes: page.children.map((id) => ({ id, name: nodes.get(id).name, type: nodes.get(id).type })) }; },
};
function create(type, p) {
  const parent = nodes.get(p.parentId || "0:1");
  if (!parent) throw new Error(`Parent not found: ${p.parentId}`);
  const n = { id: `1:${seq++}`, name: p.name || type.toLowerCase(), type, width: p.width, height: p.height, characters: p.characters, children: [] };
  nodes.set(n.id, n); parent.children.push(n.id);
  return { id: n.id, name: n.name, summary: `SUCCESS: Created ${type.toLowerCase()} "${n.name}"` };
}
const bridge = http.createServer(async (req, res) => {
  let b = ""; for await (const c of req) b += c;
  const { type, params } = JSON.parse(b); sent.push({ type, params });
  try { res.end(JSON.stringify({ ok: true, result: handlers[type] ? handlers[type](params || {}) : (() => { throw new Error(`Unknown command type: ${type}`); })() })); }
  catch (e) { res.end(JSON.stringify({ ok: false, error: e.message })); }
}).listen(0);
await new Promise((ok) => bridge.once("listening", ok));
const URL_ = `http://127.0.0.1:${bridge.address().port}/command`;
const connect = async (env = {}) => { const c = new Client({ name: "batch-test", version: "1" }); await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(REPO, "mcp", "server.mjs")], env: { ...process.env, FIGMA_BRIDGE_URL: URL_, ...env } })); return c; };
const mcp = await connect();
const call = async (name, args) => { const r = await mcp.callTool({ name, arguments: args }); const text = r.content?.[0]?.text || ""; let json = null; try { json = JSON.parse(text); } catch {} return { isError: !!r.isError, text, json }; };
const results = [];
const step = async (name, fn) => { try { const d = await fn(); results.push({ step: name, ok: true, detail: d }); console.log("PASS", name, JSON.stringify(d).slice(0, 220)); } catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 300)); } };

await step("1. one batch creates dependent elements: a frame, then children that use its ref", async () => {
  const before = sent.length;
  const r = await call("figma_batch", { ops: [
    { tool: "create_frame", ref: "section", args: { name: "Pricing", width: 1200, height: 600 } },
    { tool: "create_text", args: { parentId: "$section", characters: "Plans" } },
    { tool: "create_frame", ref: "card", args: { parentId: "$section", name: "Card" } },
    { tool: "figma_create_text", ref: "price", args: { parentId: "$card", characters: "$9" } },
    { tool: "set_auto_layout", args: { id: "$card", direction: "VERTICAL", gap: 12 } },
  ] });
  const j = r.json, ids = j.created;
  must(!r.isError && j.ok === 5 && ids.section && ids.card && ids.price, r.text);
  const cmds = sent.slice(before);
  must(cmds[1].params.parentId === ids.section && cmds[3].params.parentId === ids.card && cmds[4].params.id === ids.card, JSON.stringify(cmds));
  must(nodes.get(ids.card).layoutMode === "VERTICAL" && nodes.get(ids.section).children.includes(ids.card), "the fake document doesn't hold the result");
  return { created: ids, bridgeCalls: cmds.length, modelCalls: 1 };
});
await step("2. operation order is preserved exactly", async () => {
  const before = sent.length;
  const r = await call("figma_batch", { ops: Array.from({ length: 12 }, (_, i) => ({ tool: "create_frame", args: { name: `F${i}` } })) });
  const names = sent.slice(before).map((c) => c.params.name);
  must(r.json.ok === 12 && JSON.stringify(names) === JSON.stringify(Array.from({ length: 12 }, (_, i) => `F${i}`)), JSON.stringify(names));
  return { order: names.join(",") };
});
await step("3. partial failure: the failed op says why, its dependants are skipped, the rest still run; stopOnError stops", async () => {
  const r = await call("figma_batch", { ops: [
    { tool: "create_frame", ref: "ok1", args: { name: "OK" } },
    { tool: "modify_node", args: { id: "9:999", props: { name: "x" } } },
    { tool: "create_frame", ref: "bad", args: { parentId: "9:404", name: "Orphan" } },
    { tool: "create_text", args: { parentId: "$bad", characters: "child of a failed frame" } },
    { tool: "create_text", args: { parentId: "$ok1", characters: "independent" } },
  ] });
  const s = r.json.results.map((x) => x.status);
  must(JSON.stringify(s) === '["ok","failed","failed","skipped","ok"]' && /Node not found: 9:999/.test(r.json.results[1].error) && /depends on \$bad/.test(r.json.results[3].reason) && r.json.created.ok1 && !r.json.created.bad, r.text);
  const stop = await call("figma_batch", { stopOnError: true, ops: [{ tool: "modify_node", args: { id: "9:999", props: {} } }, { tool: "create_frame", args: { name: "after" } }] });
  must(stop.json.results[1].status === "skipped" && /stopped after op 0/.test(stop.json.results[1].reason), stop.text);
  return { statuses: s, failedError: r.json.results[1].error, skipped: r.json.results[3].reason, stopOnError: stop.json.results[1].reason };
});
await step("4. invalid batches are refused before anything runs: unknown/forbidden tools, bad args, refs used early or twice", async () => {
  const before = sent.length, out = {};
  for (const [k, ops] of Object.entries({
    unknownTool: [{ tool: "eval", args: { code: "figma.root.remove()" } }],
    readTool: [{ tool: "get_document_state", args: {} }],
    exportTool: [{ tool: "export_node", args: { id: "1:1" } }],
    badArgs: [{ tool: "create_frame", args: { width: "huge" } }],
    refBeforeDefined: [{ tool: "create_text", args: { parentId: "$later" } }, { tool: "create_frame", ref: "later", args: {} }],
    duplicateRef: [{ tool: "create_frame", ref: "a", args: {} }, { tool: "create_frame", ref: "a", args: {} }],
    mixedValidAndInvalid: [{ tool: "create_frame", args: { name: "would run" } }, { tool: "create_frame", args: { height: "tall" } }],
  })) { const r = await call("figma_batch", { ops }); out[k] = r.isError ? (r.json?.problems?.[0]?.error || r.text).slice(0, 90) : "NOT REFUSED"; must(r.isError, `${k}: ${r.text}`); }
  must(sent.length === before, `${sent.length - before} commands reached Figma`);
  return out;
});
await step("5. batches are bounded: more than 100 ops, or an oversized payload, are refused", async () => {
  const before = sent.length;
  const many = await call("figma_batch", { ops: Array.from({ length: 101 }, () => ({ tool: "create_frame", args: {} })) });
  const big = await call("figma_batch", { ops: [{ tool: "create_text", args: { characters: "x".repeat(250000) } }] });
  must(many.isError && big.isError && /larger than/.test(big.text) && sent.length === before, JSON.stringify({ many: many.text.slice(0, 120), big: big.text.slice(0, 120) }));
  return { over100: many.text.slice(0, 100), oversized: big.text.slice(0, 100) };
});
let sectionId;
await step("6. a node read is compact by default; fields ask for exactly the groups wanted; omissions are listed", async () => {
  sectionId = [...nodes.values()].find((n) => n.name === "Pricing").id;
  const compact = (await call("figma_get_document_state", { id: sectionId, fresh: true })).json;
  const keys = Object.keys(compact.node);
  must(compact.detail === "compact" && !keys.includes("effects") && !keys.includes("strokes") && keys.includes("layoutMode") && compact.node.fill === "#ffffff" && compact.omitted.includes("effects"), JSON.stringify(compact).slice(0, 400));
  const style = (await call("figma_get_document_state", { id: sectionId, fields: ["style"], fresh: true })).json;
  must(style.node.effects && style.node.strokes && !("layoutMode" in style.node), JSON.stringify(style.node).slice(0, 300));
  const full = JSON.stringify((await call("figma_get_document_state", { id: sectionId, detail: "full", fresh: true })).json).length;
  return { compactKeys: keys, omitted: compact.omitted, compactChars: JSON.stringify(compact).length, fullChars: full };
});
await step("7. full detail stays available, and big answers are bounded with the cut stated", async () => {
  const full = (await call("figma_get_document_state", { id: sectionId, detail: "full", fresh: true })).json;
  must(full.node.effects && full.node.children?.[0]?.strokes, JSON.stringify(full).slice(0, 200));
  for (let i = 0; i < 40; i++) handlers.CREATE_TEXT({ parentId: sectionId, characters: `Row ${i} `.repeat(30) });
  const b = (await call("figma_get_document_state", { id: sectionId, maxChars: 3000, fresh: true }));
  must(b.text.length < 6000 && b.json.truncated && /childCount/.test(b.json.truncated.note) && b.json.node.childCount >= 40, b.text.slice(0, 300));
  return { truncated: b.json.truncated, childCount: b.json.node.childCount, chars: b.text.length };
});
await step("8. a repeated read says 'unchanged'; after an edit (or a change made in Figma) it returns the new state", async () => {
  const a = (await call("figma_get_document_state", { id: sectionId, maxChars: 3000 })).json;
  const again = (await call("figma_get_document_state", { id: sectionId, maxChars: 3000 })).json;
  await call("figma_batch", { ops: [{ tool: "modify_node", args: { id: sectionId, props: { name: "Pricing v2" } } }] });
  const afterEdit = (await call("figma_get_document_state", { id: sectionId, maxChars: 3000 })).json;
  const quiet = (await call("figma_get_document_state", { id: sectionId, maxChars: 3000 })).json;
  nodes.get(sectionId).name = "Renamed in Figma by a person"; // a change outside these tools
  const external = (await call("figma_get_document_state", { id: sectionId, maxChars: 3000 })).json;
  const forced = (await call("figma_get_document_state", { id: sectionId, maxChars: 3000, fresh: true })).json;
  must(again.unchanged === true && !afterEdit.unchanged && afterEdit.node.name === "Pricing v2" && quiet.unchanged && !external.unchanged && external.node.name === "Renamed in Figma by a person" && forced.node, JSON.stringify({ again, afterEdit: afterEdit.node?.name, external: external.node?.name }));
  return { repeated: again, afterEdit: afterEdit.node.name, afterExternalChange: external.node.name, freshForced: !!forced.node };
});
await step("9. a batch report is a confirmation, not visual verification (it says so)", async () => {
  const r = await call("figma_batch", { ops: [{ tool: "create_frame", args: { name: "V" } }] });
  must(/Not visually verified/.test(r.json.verification) && /export/i.test(r.json.verification), r.text);
  return { verification: r.json.verification };
});
await step("LEGACY=1 restores the old behaviour (no batch tool, full dumps), for comparison runs", async () => {
  const legacy = await connect({ FIGMA_EXECUTOR_LEGACY: "1" });
  const tools = (await legacy.listTools()).tools.map((t) => t.name);
  const r = await legacy.callTool({ name: "figma_get_document_state", arguments: { id: sectionId } });
  await legacy.close();
  const node = JSON.parse(r.content[0].text).node;
  const now = (await mcp.listTools()).tools.map((t) => t.name);
  must(!tools.includes("figma_batch") && now.includes("figma_batch") && node.effects && node.strokes, JSON.stringify({ tools: tools.length }));
  return { legacyHasBatch: tools.includes("figma_batch"), legacyFullDump: !!node.effects };
});
await mcp.close(); bridge.close();
writeFileSync(join(HERE, "batch-results.json"), JSON.stringify({ when: new Date().toISOString(), results }, null, 1));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
