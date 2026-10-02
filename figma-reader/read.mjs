#!/usr/bin/env node
// Reads a Figma design from its URL and writes what an AI worker needs to work from it:
//   design.md   file summary (pages, frames, components, styles) and the node outline
//   render.png  the node (or first frame) rendered by Figma
//   raw.json    the API responses, for anything the outline leaves out
//
//   node figma-reader/read.mjs "<figma url>" [--out dir] [--depth n] [--scale 1]
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseFigmaUrl, readFile, readNodes, renderNodes, download, outline, stats } from "./reader.mjs";

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith("--"));
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
if (!url) { console.error('Usage: node figma-reader/read.mjs "<figma url>" [--out dir] [--depth n] [--scale 1]'); process.exit(2); }
const out = resolve(opt("out", "figma-read")); mkdirSync(out, { recursive: true });
const t0 = Date.now();

const ref = parseFigmaUrl(url);
// Tier 1 calls are scarce, so: a link that names a node reads just that node (its response also
// carries the file's name, version, and the components and styles it uses); a link to the whole
// file reads the page and frame list first (depth 2) to pick its first frame. --pages adds the list.
let file = null, pages = [];
if (!ref.nodeId || args.includes("--pages")) {
  file = await readFile(ref.fileKey, { depth: 2 });
  pages = file.document.children.map((p) => ({ id: p.id, name: p.name, frames: (p.children || []).map((f) => ({ id: f.id, name: f.name, type: f.type, w: Math.round(f.absoluteBoundingBox?.width || 0), h: Math.round(f.absoluteBoundingBox?.height || 0) })) }));
}
const target = ref.nodeId || pages.find((p) => p.frames.length)?.frames[0]?.id;
const nodes = target ? await readNodes(ref.fileKey, [target]) : null;
const doc = nodes?.nodes?.[target];
if (target && !doc) throw new Error(`Node ${target} isn't in this file (or isn't visible to this account).`);
file = file || { name: nodes.name, lastModified: nodes.lastModified, version: nodes.version, components: {}, styles: {}, document: { children: [] } };
const ctx = { components: { ...file.components, ...doc?.components }, styles: { ...file.styles, ...doc?.styles } };
const o = doc ? outline(doc.document, ctx) : { text: "", nodes: 0 };
// 3. A render of that node, made by Figma itself.
let render = null;
if (target) {
  const img = await renderNodes(ref.fileKey, [target], { format: "png", scale: Number(opt("scale", 1)) });
  if (img.images?.[target]) render = await download(img.images[target], join(out, "render.png"));
}

const md = [
  `# ${file.name}`,
  ``,
  `Source: ${url}`,
  `File key: ${ref.fileKey}${ref.branchKey ? ` (branch of ${ref.mainFileKey})` : ""} · last modified ${file.lastModified} · version ${file.version}`,
  ``,
  `## Pages${pages.length ? "" : " (not read: the link names a node; add --pages to list them)"}`,
  ...pages.map((p) => `- **${p.name}** (${p.id}): ${p.frames.length ? p.frames.map((f) => `${f.name} [${f.type} ${f.w}x${f.h}, ${f.id}]`).join("; ") : "empty"}`),
  ``,
  `## Components (${Object.keys(ctx.components || {}).length})`,
  ...Object.entries(ctx.components || {}).slice(0, 80).map(([id, c]) => `- ${c.name} (${id})${c.description ? `: ${c.description.slice(0, 100)}` : ""}`),
  ``,
  `## Styles (${Object.keys(ctx.styles || {}).length})`,
  ...Object.entries(ctx.styles || {}).slice(0, 80).map(([id, s]) => `- ${s.styleType} ${s.name} (${id})`),
  ``,
  `## Node ${target || "-"}: ${doc?.document?.name || "-"} (${o.nodes} nodes${o.truncated ? ", truncated" : ""})`,
  `Format: TYPE "name" x,y WxH, then only what's set: text="…" font weight size/lineHeight ls, fill:#rrggbb[@alpha], stroke:paint/weight, rN radius, row|col gapN pTop/Right/Bottom/Left, size:hug|fill|fixed, opN, fx:shadow(x,y,blur,spread,color), instance-of:"component", props:, styles:, vars:.`,
  "```",
  o.text,
  "```",
  render ? `\nRender: render.png` : "",
].join("\n");
writeFileSync(join(out, "design.md"), md);
writeFileSync(join(out, "raw.json"), JSON.stringify({ ref, file: { ...file, document: { ...file.document } }, nodes }, null, 1));
console.log(JSON.stringify({ ok: true, file: file.name, fileKey: ref.fileKey, node: target, pages: pages.length, outlineNodes: o.nodes, render: !!render, out, requests: stats.requests, retries: stats.retries, seconds: Math.round((Date.now() - t0) / 100) / 10 }, null, 1));
