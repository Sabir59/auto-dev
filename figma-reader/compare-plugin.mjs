#!/usr/bin/env node
// Does the REST API give the same design facts as our plugin? Compares, node by node, a REST
// /nodes response with the plugin's GET_DOCUMENT_STATE dump of the same node (both full depth).
//   node figma-reader/compare-plugin.mjs <rest raw.json> <plugin dump.json> <nodeId>
import { readFileSync } from "node:fs";

const [restPath, pluginPath, nodeId] = process.argv.slice(2);
const rest = JSON.parse(readFileSync(restPath, "utf8")).nodes.nodes[nodeId].document;
const plug = JSON.parse(readFileSync(pluginPath, "utf8")).result.node;

const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
const restFills = (n) => (n.fills || []).filter((p) => p.visible !== false && p.type === "SOLID").map((p) => hex(p.color));
const plugFills = (n) => (n.fills || []).filter((p) => p.type === "SOLID").map((p) => p.hex.toLowerCase());
const index = (root, kids = "children") => { const m = new Map(); (function w(n) { m.set(n.id, n); (n[kids] || []).forEach(w); })(root); return m; };
const R = index(rest), P = index(plug);

// The plugin dump gives x/y relative to the parent; REST gives absolute boxes. Compare sizes
// directly, and positions relative to the root on both sides.
const rootR = rest.absoluteBoundingBox;
const absP = new Map(); (function w(n, ax, ay) { const x = ax + n.x, y = ay + n.y; absP.set(n.id, { x, y }); (n.children || []).forEach((c) => w(c, x, y)); })(plug, -plug.x, -plug.y);
const checks = { nodes: 0, type: 0, size: 0, position: 0, fills: 0, text: 0, font: 0, fontSize: 0, layout: 0, radius: 0 };
const mismatches = [];
const same = (a, b, tol = 1) => Math.abs(a - b) <= tol;
for (const [id, p] of P) {
  const r = R.get(id);
  if (!r) { mismatches.push(`${id} "${p.name}": missing in REST`); continue; }
  checks.nodes++;
  const miss = (k, a, b) => mismatches.push(`${id} "${p.name}" ${k}: plugin=${JSON.stringify(a)} rest=${JSON.stringify(b)}`);
  if (r.type === p.type) checks.type++; else miss("type", p.type, r.type);
  const rb = r.absoluteBoundingBox;
  if (rb && same(rb.width, p.width) && same(rb.height, p.height)) checks.size++; else miss("size", [p.width, p.height], rb && [rb.width, rb.height]);
  const a = absP.get(id);
  if (rb && same(rb.x - rootR.x, a.x) && same(rb.y - rootR.y, a.y)) checks.position++; else miss("position", [a.x, a.y], rb && [rb.x - rootR.x, rb.y - rootR.y]);
  if (JSON.stringify(restFills(r)) === JSON.stringify(plugFills(p))) checks.fills++; else miss("fills", plugFills(p), restFills(r));
  if (p.type === "TEXT") {
    if (r.characters === p.characters) checks.text++; else miss("text", p.characters, r.characters);
    if (r.style?.fontFamily === p.fontName?.family) checks.font++; else miss("font", p.fontName?.family, r.style?.fontFamily);
    if (r.style?.fontSize === p.fontSize) checks.fontSize++; else miss("fontSize", p.fontSize, r.style?.fontSize);
  }
  if (p.layoutMode) {
    const ok = (r.layoutMode || "NONE") === p.layoutMode && (p.layoutMode === "NONE" || (same(r.itemSpacing || 0, p.itemSpacing || 0, 0.01) && same(r.paddingTop || 0, p.padding?.top || 0, 0.01) && same(r.paddingLeft || 0, p.padding?.left || 0, 0.01)));
    if (ok) checks.layout++; else miss("layout", [p.layoutMode, p.itemSpacing, p.padding], [r.layoutMode, r.itemSpacing, r.paddingTop, r.paddingRight, r.paddingBottom, r.paddingLeft]);
  }
  if (p.cornerRadius) { if (same(r.cornerRadius || 0, p.cornerRadius, 0.01)) checks.radius++; else miss("radius", p.cornerRadius, r.cornerRadius); }
}
const texts = [...P.values()].filter((n) => n.type === "TEXT").length;
const layouts = [...P.values()].filter((n) => n.layoutMode).length;
const radii = [...P.values()].filter((n) => n.cornerRadius).length;
console.log(JSON.stringify({ pluginNodes: P.size, restNodes: R.size, matched: checks, of: { nodes: P.size, text: texts, layout: layouts, radius: radii }, mismatches: mismatches.slice(0, 40), mismatchCount: mismatches.length }, null, 1));
