// Word-level text styling (ranges), mixed fonts, instance text overrides, create_instance
// insertIndex and an image import followed by text edits, against the REAL Figma plugin through the
// real bridge and MCP server. Everything happens on a temporary page this test creates and deletes;
// the person's page and nodes are never touched (an existing colour variable is only read, to bind).
//   node bench/figma-executor/text-ranges-live-test.mjs   (bridge on 8787, the RELOADED plugin running)
import { Client } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", "..");
const must = (c, m) => { if (!c) throw new Error(m); };
const mcp = new Client({ name: "text-ranges-test", version: "1" });
await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [join(REPO, "mcp", "server.mjs")], env: { ...process.env } }));
const call = async (name, args = {}) => { const r = await mcp.callTool({ name, arguments: args }); const text = r.content?.[0]?.text || ""; let json = null; try { json = JSON.parse(text); } catch {} return { isError: !!r.isError, text, json }; };
const results = [];
const step = async (name, fn) => { try { const d = await fn(); results.push({ step: name, ok: true, detail: d }); console.log("PASS", name, JSON.stringify(d).slice(0, 260)); } catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 400)); } };
const ORANGE = { r: 0.969, g: 0.576, b: 0.118 }, ORANGE_HEX = "#F7931E";
const seg = (segs, text) => (segs || []).find((s) => s.text === text);

const before = (await call("figma_get_file_info")).json;
let page, frame, t1;
try {
  await step("setup: a temporary page and frame (the current page stays as it was)", async () => {
    page = (await call("figma_create_page", { name: "zz-text-ranges-test (temporary)" })).json.id;
    frame = (await call("figma_create_frame", { parentId: page, name: "Ranges", width: 600, height: 400 })).json.id;
    must(page && frame, "setup failed");
    return { page, frame };
  });
  await step("create_text with a match range: only those words turn orange; the result lists the segments", async () => {
    const r = await call("figma_create_text", { parentId: frame, content: "Shaving has more reward. This is for MEN ONLY. Women cut a fingertip's length.", font: { family: "Inter", style: "Regular" }, fontSize: 16, fill: { r: 0, g: 0, b: 0 },
      ranges: [{ match: "MEN ONLY", fill: ORANGE }] });
    t1 = r.json?.id;
    const s = r.json?.segments, men = seg(s, "MEN ONLY");
    must(!r.isError && men && men.fill === ORANGE_HEX && s.length === 3 && s[0].fill === "#000000", r.text.slice(0, 500));
    return { segments: s.map((x) => `${x.text.slice(0, 20)}=${x.fill}`) };
  });
  await step("modify_node with start/end: a bold, underlined run; whole-node styles stay elsewhere", async () => {
    const r = await call("figma_modify_node", { id: t1, props: { ranges: [{ start: 0, end: 7, font: { family: "Inter", style: "Bold" }, textDecoration: "UNDERLINE" }] } });
    const s = r.json?.segments, first = s?.[0];
    must(!r.isError && first?.text === "Shaving" && first.font === "Inter Bold" && first.textDecoration === "UNDERLINE" && seg(s, "MEN ONLY")?.fill === ORANGE_HEX, r.text.slice(0, 500));
    return { first, orangeKept: true };
  });
  await step("changing the characters of a text with mixed fonts works (it used to fail on figma.mixed)", async () => {
    const r = await call("figma_modify_node", { id: t1, props: { characters: "Proceed to shaving. This is for MEN ONLY.", ranges: [{ match: "MEN ONLY", fill: ORANGE }] } });
    must(!r.isError && seg(r.json?.segments, "MEN ONLY")?.fill === ORANGE_HEX, r.text.slice(0, 400));
    const f = await call("figma_modify_node", { id: t1, props: { fontSize: 18, font: { family: "Inter", style: "Medium" } } });
    must(!f.isError, f.text.slice(0, 300));
    return { characters: "changed on mixed fonts", wholeNodeFontAfter: "Inter Medium" };
  });
  await step("a glyph the main font lacks: match \"ﷺ\" and give just that character another font", async () => {
    const r = await call("figma_create_text", { parentId: frame, content: "Muhammad ﷺ said", font: { family: "Inter", style: "Regular" }, ranges: [{ match: "ﷺ", font: { family: "Amiri", style: "Regular" } }] });
    const g = seg(r.json?.segments, "ﷺ");
    must(!r.isError && g && g.font === "Amiri Regular" && g.end - g.start === "ﷺ".length, r.text.slice(0, 400));
    return { glyph: g };
  });
  await step("match that isn't there fails, quoting the node's text; occurrence picks one of several", async () => {
    const miss = await call("figma_modify_node", { id: t1, props: { ranges: [{ match: "WOMEN ONLY", fill: ORANGE }] } });
    const t = (await call("figma_create_text", { parentId: frame, content: "God is Great. God is One.", font: { family: "Inter", style: "Regular" }, ranges: [{ match: "God", occurrence: 2, fill: ORANGE }] })).json;
    const gods = t.segments.filter((x) => x.text.includes("God"));
    must(miss.isError && /not in this text node/.test(miss.text) && /Proceed to shaving/.test(miss.text) && t.segments.find((x) => x.text === "God" && x.fill === ORANGE_HEX)?.start === 14, JSON.stringify({ miss: miss.text.slice(0, 200), segs: t.segments }));
    return { notFound: miss.text.slice(0, 120), secondOnly: gods.map((x) => `${x.start}:${x.fill}`) };
  });
  await step("instance text: a range on an instance's text child (I…;… id) is an override; the main component is unchanged", async () => {
    const comp = (await call("figma_create_component", { parentId: frame, name: "BulletTest", width: 300, height: 40 })).json.id;
    const body = (await call("figma_create_text", { parentId: comp, name: "body", content: "Say Allāhu Akbar three times.", font: { family: "Inter", style: "Regular" } })).json.id;
    const inst = (await call("figma_create_instance", { componentId: comp, parentId: frame, insertIndex: 0, name: "BulletTest instance" })).json;
    const sub = inst.children.find((c) => c.name === "body")?.id;
    const r = await call("figma_modify_node", { id: sub, props: { ranges: [{ match: "Allāhu Akbar", fill: ORANGE }] } });
    const main = (await call("figma_get_document_state", { id: body, fresh: true })).json.node;
    const kids = (await call("figma_get_document_state", { id: frame, fresh: true })).json.node.children;
    must(/^I.+;/.test(sub) && !r.isError && seg(r.json?.segments, "Allāhu Akbar")?.fill === ORANGE_HEX && !main.segments && kids[0].id === inst.id, JSON.stringify({ sub, r: r.text.slice(0, 300), main, first: kids[0] }));
    return { instanceTextId: sub, override: "orange", mainComponentText: "unchanged", createInstanceInsertIndex0: "first child" };
  });
  await step("a range can bind its colour to an existing variable (a token) instead of a literal", async () => {
    const v = (await call("figma_get_variables")).json;
    const color = (v.collections || v.variableCollections || []).flatMap((c) => c.variables || []).find((x) => x.resolvedType === "COLOR" || x.type === "COLOR");
    must(color?.id, "no COLOR variable in this file to bind to");
    const r = await call("figma_modify_node", { id: t1, props: { ranges: [{ match: "MEN ONLY", fillVariableId: color.id }] } });
    must(!r.isError && seg(r.json?.segments, "MEN ONLY")?.fillVariable === color.id, r.text.slice(0, 400));
    return { boundTo: color.name || color.id };
  });
  await step("reads show word-level styling: the compact read of a mixed text node includes its segments", async () => {
    const n = (await call("figma_get_document_state", { id: t1, fresh: true })).json.node;
    must(Array.isArray(n.segments) && n.segments.length >= 2 && n.segments.some((s) => s.text === "MEN ONLY"), JSON.stringify(n).slice(0, 400));
    return { segments: n.segments.length };
  });
  await step("in figma_batch: create a text and style it via $ref; an image import first doesn't break later text edits", async () => {
    const r = await call("figma_batch", { ops: [
      { tool: "create_frame", ref: "img", args: { parentId: frame, name: "Photo", width: 120, height: 120 } },
      { tool: "import_image", args: { url: "https://images.unsplash.com/photo-1582918464468-72541bf1da6e?w=600&q=80", targetId: "$img" } },
      { tool: "create_text", ref: "t", args: { parentId: frame, content: "Blue keywords in cream note text", font: { family: "Inter", style: "Regular" }, fill: { r: 0.98, g: 0.95, b: 0.85 } } },
      { tool: "modify_node", args: { id: "$t", props: { ranges: [{ match: "Blue keywords", fill: { r: 0.1, g: 0.3, b: 0.8 } }] } } },
      { tool: "modify_node", args: { id: "$t", props: { characters: "Blue keywords in cream note text, edited", ranges: [{ match: "Blue keywords", fill: { r: 0.1, g: 0.3, b: 0.8 } }] } } },
      { tool: "modify_node", args: { id: "$t", props: { ranges: [{ match: "edited", textDecoration: "UNDERLINE" }] } } },
    ] });
    must(!r.isError && r.json.ok === 6 && r.json.results[3].segments?.some((s) => s.text === "Blue keywords" && s.fill === "#1A4DCC"), r.text.slice(0, 600));
    return { ok: r.json.ok, ms: r.json.ms, imageThenText: "no timeouts", batchSegments: r.json.results[5].segments?.length };
  });
} finally {
  await step("cleanup: the temporary page is deleted; the person's current page never changed", async () => {
    if (page) await call("figma_delete_node", { id: page });
    const after = (await call("figma_get_file_info")).json, pages = (await call("figma_list_pages")).json;
    must(!(pages.pages || pages).some((p) => p.id === page) && after.currentPage.id === before.currentPage.id, "cleanup check failed");
    return { pageRemoved: true, currentPage: after.currentPage.name };
  });
  await mcp.close();
}
writeFileSync(join(HERE, "text-ranges-results.json"), JSON.stringify({ when: new Date().toISOString(), file: before.fileName, results }, null, 1));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
