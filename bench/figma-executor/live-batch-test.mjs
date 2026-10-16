// figma_batch and compact inspection against the REAL Figma plugin (through the real bridge), with
// no model involved. Everything happens on a temporary page this test creates and deletes; the
// page the person is looking at is never switched or touched.
//   node bench/figma-executor/live-batch-test.mjs        (bridge on 8787, plugin running in Figma)
import { Client } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { writeFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", "..");
const must = (c, m) => { if (!c) throw new Error(m); };
const mcp = new Client({ name: "live-batch-test", version: "1" });
await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [join(REPO, "mcp", "server.mjs")], env: { ...process.env } }));
const call = async (name, args = {}) => { const r = await mcp.callTool({ name, arguments: args }); const text = r.content?.[0]?.text || ""; let json = null; try { json = JSON.parse(text); } catch {} return { isError: !!r.isError, text, json }; };
const results = [];
const step = async (name, fn) => { try { const d = await fn(); results.push({ step: name, ok: true, detail: d }); console.log("PASS", name, JSON.stringify(d).slice(0, 240)); } catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 300)); } };

const before = (await call("figma_get_file_info")).json;
let pageId, created = {};
try {
  await step("a temporary page is created (the current page stays as it was)", async () => {
    const p = (await call("figma_create_page", { name: "zz-executor-batch-test (temporary)" })).json;
    pageId = p.id;
    must(pageId, JSON.stringify(p));
    return { page: pageId, filePage: before.currentPage.name };
  });
  await step("one batch builds a real section: an auto-layout frame, a card inside it, texts in both", async () => {
    const t0 = Date.now();
    const r = await call("figma_batch", { ops: [
      { tool: "create_frame", ref: "section", args: { parentId: pageId, name: "Batch section", x: 0, y: 0, width: 640, height: 360, fill: { r: 0.97, g: 0.97, b: 0.98 } } },
      { tool: "set_auto_layout", args: { id: "$section", direction: "VERTICAL", gap: 16, padding: { top: 32, right: 32, bottom: 32, left: 32 } } },
      { tool: "create_text", ref: "title", args: { parentId: "$section", characters: "Plans built in one call", fontSize: 28 } },
      { tool: "create_frame", ref: "card", args: { parentId: "$section", name: "Card", width: 280, height: 160, fill: { r: 1, g: 1, b: 1 }, cornerRadius: 12 } },
      { tool: "set_auto_layout", args: { id: "$card", direction: "VERTICAL", gap: 8, padding: { top: 20, right: 20, bottom: 20, left: 20 } } },
      { tool: "create_text", ref: "price", args: { parentId: "$card", characters: "$9 / month", fontSize: 22 } },
      { tool: "create_text", args: { parentId: "$card", characters: "Everything in Starter", fontSize: 14 } },
      { tool: "modify_node", args: { id: "$card", props: { name: "Card — Starter" } } },
    ] });
    must(!r.isError && r.json.ok === 8 && r.json.failed === 0, r.text);
    created = r.json.created;
    return { ops: r.json.ops, ok: r.json.ok, created, ms: Date.now() - t0, modelCalls: 1 };
  });
  await step("the result is in Figma: a compact read of the section shows the structure the batch made", async () => {
    const s = (await call("figma_get_document_state", { id: created.section, fresh: true })).json;
    const card = s.node.children.find((c) => c.id === created.card);
    must(s.detail === "compact" && s.node.layoutMode === "VERTICAL" && s.node.children.length === 2 && card?.name === "Card — Starter" && card.children.length === 2 && card.children[0].characters === "$9 / month", JSON.stringify(s).slice(0, 500));
    const full = (await call("figma_get_document_state", { id: created.section, detail: "full", fresh: true })).text.length;
    return { compactChars: JSON.stringify(s).length, fullChars: full, children: s.node.children.map((c) => c.name) };
  });
  await step("a partial failure in a real batch: the bad op is reported, the good ones run", async () => {
    const r = await call("figma_batch", { ops: [
      { tool: "modify_node", args: { id: "999999:999999", props: { name: "nope" } } },
      { tool: "create_text", args: { parentId: created.section, characters: "Added after a failure", fontSize: 14 } },
    ] });
    must(r.json.results[0].status === "failed" && r.json.results[1].status === "ok", r.text);
    return { failed: r.json.results[0].error.slice(0, 120), thenOk: r.json.results[1].status };
  });
  const kids = async () => (await call("figma_get_document_state", { id: created.section, fresh: true })).json.node.children.map((c) => c.name);
  let retryBase;
  await step("dependency skipping in a real batch: a failed create skips only the ops that use its ref", async () => {
    retryBase = await kids();
    const r = await call("figma_batch", { ops: [
      { tool: "create_frame", ref: "box", args: { parentId: "999999:1", name: "Retry box", width: 200, height: 80 } },
      { tool: "set_auto_layout", args: { id: "$box", direction: "HORIZONTAL", gap: 8 } },
      { tool: "create_text", args: { parentId: "$box", characters: "Inside the box", fontSize: 14 } },
      { tool: "create_text", args: { parentId: created.section, characters: "Independent of the box", fontSize: 14 } },
    ] });
    const st = r.json.results.map((x) => x.status), after = await kids();
    must(st.join() === "failed,skipped,skipped,ok" && after.length === retryBase.length + 1 && !after.includes("Retry box"), JSON.stringify({ st, after }));
    return { statuses: st, skippedReason: r.json.results[1].reason, sectionChildren: after.length };
  });
  await step("retry: re-sending only the failed part (corrected) completes it, with nothing duplicated", async () => {
    const r = await call("figma_batch", { ops: [
      { tool: "create_frame", ref: "box", args: { parentId: created.section, name: "Retry box", width: 200, height: 80 } },
      { tool: "set_auto_layout", args: { id: "$box", direction: "HORIZONTAL", gap: 8 } },
      { tool: "create_text", args: { parentId: "$box", characters: "Inside the box", fontSize: 14 } },
    ] });
    const after = await kids();
    must(r.json.ok === 3 && after.length === retryBase.length + 2 && after.filter((n) => n === "Retry box").length === 1 && after.filter((n) => /Independent/.test(n)).length === 1, JSON.stringify({ r: r.json.results, after }));
    return { ok: r.json.ok, sectionChildren: after };
  });
  await step("stopOnError in a real batch: nothing after the failure runs", async () => {
    const n0 = (await kids()).length;
    const r = await call("figma_batch", { stopOnError: true, ops: [
      { tool: "modify_node", args: { id: "999999:2", props: { name: "nope" } } },
      { tool: "create_text", args: { parentId: created.section, characters: "Must not exist", fontSize: 14 } },
    ] });
    const after = await kids();
    must(r.json.results.map((x) => x.status).join() === "failed,skipped" && after.length === n0, JSON.stringify({ r: r.json.results, after }));
    return { statuses: r.json.results.map((x) => x.status), sectionChildren: after.length };
  });
  await step("document-state cache: an identical read says unchanged; an edit through the tools resets it", async () => {
    const a = (await call("figma_get_document_state", { id: created.card })).json;
    const b = (await call("figma_get_document_state", { id: created.card })).json;
    must(a.node && b.unchanged === true, JSON.stringify({ a: !!a.node, b }));
    await call("figma_batch", { ops: [{ tool: "modify_node", args: { id: created.card, props: { name: "Card — edited by batch" } } }] });
    const c = (await call("figma_get_document_state", { id: created.card })).json;
    must(!c.unchanged && c.node?.name === "Card — edited by batch", JSON.stringify(c).slice(0, 300));
    return { first: "full", second: "unchanged", afterEdit: c.node.name };
  });
  await step("external edit: a change made outside this run (another process, straight to the bridge) is seen, not answered as unchanged", async () => {
    const a = (await call("figma_get_document_state", { id: created.card, fresh: true })).json;
    const b = (await call("figma_get_document_state", { id: created.card })).json;
    must(a.node && b.unchanged === true, "precondition: a repeat read is unchanged");
    // Another program edits the node directly through the bridge, the same path a person's edit
    // reaches the document by: this MCP server never sees the command.
    const res = await (await fetch("http://localhost:8787/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "MODIFY_NODE", params: { id: created.card, props: { name: "Card — edited outside" } } }) })).json();
    must(res.ok, JSON.stringify(res));
    const c = (await call("figma_get_document_state", { id: created.card })).json;
    must(!c.unchanged && c.node?.name === "Card — edited outside", JSON.stringify(c).slice(0, 300));
    return { before: a.node.name, repeat: "unchanged", afterExternalEdit: c.node.name };
  });
  await step("visual verification is a separate, explicit step: the section exports to an image", async () => {
    const r = await call("figma_export_node", { id: created.section, format: "PNG", scale: 1 });
    const path = r.json?.path || r.json?.file || r.json?.filePath;
    must(!r.isError && path && existsSync(path) && statSync(path).size > 1000, r.text.slice(0, 300));
    return { export: path, bytes: statSync(path).size };
  });
} finally {
  await step("cleanup: the temporary page is deleted; the person's current page never changed", async () => {
    if (pageId) await call("figma_delete_node", { id: pageId });
    const pages = (await call("figma_list_pages")).json, after = (await call("figma_get_file_info")).json;
    const list = Array.isArray(pages) ? pages : pages?.pages || [];
    must(!list.some((p) => p.id === pageId) && after.currentPage.id === before.currentPage.id, JSON.stringify({ list: list.length, after: after.currentPage }));
    return { pageRemoved: true, currentPage: after.currentPage.name };
  });
  await mcp.close();
}
writeFileSync(join(HERE, "live-batch-results.json"), JSON.stringify({ when: new Date().toISOString(), file: before.fileName, results }, null, 1));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
