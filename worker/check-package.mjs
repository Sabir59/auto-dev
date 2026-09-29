#!/usr/bin/env node
// Usage: node worker/check-package.mjs <package-dir>
//
// Internal-consistency check for an implementation package (tokens.json,
// components.json, screens.json, prototype.json, icons/, reference/):
// every token, component/variant, icon and file the package refers to must
// exist inside the package itself. Exits 1 and lists each problem otherwise.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: check-package.mjs <package-dir>");
  process.exit(2);
}
const load = (f) => JSON.parse(readFileSync(join(dir, f), "utf8"));
const tokens = load("tokens.json");
const { components } = load("components.json");
const { screens } = load("screens.json");
load("prototype.json"); // must at least parse

const tokenNames = new Set(["color", "space", "radius", "font", "text"].flatMap((g) => Object.keys(tokens[g] || {})));
const LITERALS = new Set(["MIN", "MAX", "CENTER", "SPACE_BETWEEN", "FILL/HUG", "FILL/FIXED", "HUG/FIXED", "HUG/HUG", "FIXED/FIXED"]);
const TOKEN_KEYS = new Set(["fill", "color", "gap", "radius", "style"]);
const problems = [];
const stats = { tokenRefs: 0, compRefs: 0, iconRefs: 0, texts: 0 };

function checkToken(value, where) {
  if (value == null || typeof value === "number") return;
  if (typeof value === "object" && "token" in value) return checkToken(value.token, where);
  if (typeof value !== "string" || LITERALS.has(value) || /^#[0-9a-f]{6}$/i.test(value)) return;
  stats.tokenRefs++;
  if (!tokenNames.has(value)) problems.push(`${where}: token "${value}" is not defined in tokens.json`);
}

function checkIcon(name, where) {
  stats.iconRefs++;
  const file = join(dir, "icons", `${name}.svg`);
  if (!existsSync(file)) return problems.push(`${where}: icon "${name}" has no icons/${name}.svg`);
  if (!readFileSync(file, "utf8").includes("currentColor")) problems.push(`icons/${name}.svg does not use currentColor`);
}

function checkComp(ref, where) {
  stats.compRefs++;
  const m = /^([^{]+?)\s*(?:\{(.+)\})?$/.exec(ref);
  const name = m[1].trim();
  const comp = components[name];
  if (!comp) return problems.push(`${where}: component "${name}" is not in components.json`);
  if (m[2] && !m[2].includes("<") && !(comp.variants && m[2] in comp.variants)) {
    problems.push(`${where}: ${name} has no variant "${m[2]}" (has: ${Object.keys(comp.variants || {}).join(" | ")})`);
  }
}

function walk(node, where) {
  if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${where}[${i}]`));
  if (!node || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    const at = `${where}.${k}`;
    if (TOKEN_KEYS.has(k)) checkToken(v, at);
    else if (k === "pad" && Array.isArray(v)) v.forEach((p, i) => checkToken(p, `${at}[${i}]`));
    else if (k === "stroke" && v && typeof v === "object") checkToken(v.color, `${at}.color`);
    else if (k === "comp") checkComp(v, at);
    else if (k === "text" && typeof v === "string") stats.texts++;
    if ((k === "icon" || k === "leadingIcon") && typeof v === "string") checkIcon(v, at);
    if (k === "icon" && v && typeof v === "object" && v.name) checkIcon(v.name, at);
    if (k === "props" && v && typeof v === "object") {
      if (typeof v.title === "string") stats.texts++;
      if (typeof v.label === "string") stats.texts++;
    }
    if (typeof v === "object") walk(v, at);
  }
}

for (const [name, s] of Object.entries(screens)) {
  if (!s.reference || !existsSync(join(dir, s.reference))) problems.push(`screens.${name}: reference render "${s.reference}" missing`);
  walk(s, `screens.${name}`);
}
walk(components, "components");
for (const [name, t] of Object.entries(tokens.text || {})) {
  if (!tokenNames.has(t.font)) problems.push(`tokens.text.${name}: font "${t.font}" is not defined`);
}

console.log(JSON.stringify({ ok: problems.length === 0, stats, problems }, null, 1));
process.exit(problems.length ? 1 : 0);
