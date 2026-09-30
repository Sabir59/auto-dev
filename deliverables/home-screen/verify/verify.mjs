#!/usr/bin/env node
// Independent check of the Home Screen package. Needs the Figma bridge
// (localhost:8787, plugin connected) and network access for Google Fonts.
//  1. Every colour claim in spec.json against the file's REAL variables,
//     re-read from Figma now: `token` = that variable has exactly this value;
//     `ambiguous` = each listed token has it; `raw` = no variable has it.
//  2. Shadow claims against the file's real effect styles.
//  3. Font claims against Google Fonts (a family on it returns 200; Georgia must not).
//  4. Internal references: colours/text styles/icons used by the screen exist.
//  5. The reference build consumes the spec: every --var in build/home.src.html
//     equals spec.colors[var].value.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(readFileSync(join(pkg, "spec.json"), "utf8"));
const checks = [];
const check = (name, ok, detail = "") => checks.push({ name, ok, detail });
const bridge = async (type) => {
  const r = await fetch("http://localhost:8787/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type, params: {} }) });
  const j = await r.json();
  if (!j.ok) throw new Error(`${type}: ${j.error}`);
  return j.result;
};

// 1. colours vs real variables
const { collections } = await bridge("GET_VARIABLES");
const valueOf = {};
for (const c of collections) for (const v of c.variables) if (v.type === "color") valueOf[v.name] = Object.values(v.valuesByMode)[0].value.toLowerCase();
const namesWith = (hex) => Object.keys(valueOf).filter((n) => valueOf[n] === hex.toLowerCase());
for (const [key, c] of Object.entries(spec.colors)) {
  const have = namesWith(c.value);
  if (c.token) check(`color ${key}: ${c.value} = ${c.token}`, valueOf[c.token] === c.value.toLowerCase(), `variable ${c.token} is ${valueOf[c.token] ?? "missing"}`);
  else if (c.ambiguous) check(`color ${key}: ${c.value} ambiguous`, c.ambiguous.every((n) => valueOf[n] === c.value.toLowerCase()) && have.length >= 2, `variables with this value: ${have.join(", ")}`);
  else if (c.raw) check(`color ${key}: ${c.value} is off-palette`, have.length === 0, have.length ? `but matches: ${have.join(", ")}` : "no variable has it");
  else check(`color ${key}: has a classification`, false);
}

// 2. shadows vs real effect styles
const { effectStyles } = await bridge("GET_STYLES");
for (const [key, s] of Object.entries(spec.shadows)) {
  if (!s.token) continue;
  const style = effectStyles.find((e) => e.name === s.token);
  const e = style?.effects?.[0];
  const css = e ? `${e.x} ${e.y}px ${e.blur}px ${e.spread} rgb(${parseInt(e.color.slice(1, 3), 16)} ${parseInt(e.color.slice(3, 5), 16)} ${parseInt(e.color.slice(5, 7), 16)} / ${+(parseInt(e.color.slice(7, 9), 16) / 255).toFixed(2)})` : null;
  check(`shadow ${key} = ${s.token}`, css === s.css, `style gives "${css}", spec says "${s.css}"`);
}

// 3. fonts vs Google Fonts
for (const [family, f] of Object.entries(spec.fonts)) {
  const r = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}`);
  const onGoogle = r.status === 200;
  check(`font ${family}: ${f.source}`, onGoogle === f.source.startsWith("Google Fonts"), `Google Fonts HTTP ${r.status}`);
}

// 4. internal references
const used = { colors: new Set(), text: new Set(), icons: new Set() };
(function walk(n) {
  if (Array.isArray(n)) return n.forEach(walk);
  if (!n || typeof n !== "object") return;
  for (const [k, v] of Object.entries(n)) {
    if ((k === "fill" || k === "color") && typeof v === "string") used.colors.add(v);
    if (k === "style" && typeof v === "string") used.text.add(v);
    if (k === "name" && n.color !== undefined) used.icons.add(v);
    if (typeof v === "object") walk(v);
  }
})(spec.screen);
for (const t of Object.values(spec.text)) if (t.color) used.colors.add(t.color);
for (const c of used.colors) check(`colour "${c}" is defined`, c in spec.colors);
for (const t of used.text) check(`text style "${t}" is defined`, t in spec.text);
for (const i of used.icons) check(`icon "${i}" is defined and its file exists`, i in spec.icons && existsSync(join(pkg, spec.icons[i].file)));

// 5. the build uses the spec's values
const src = readFileSync(join(pkg, "build", "home.src.html"), "utf8");
for (const [, name, hex] of src.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/gi)) {
  check(`build --${name} = spec`, spec.colors[name]?.value.toLowerCase() === hex.toLowerCase(), `build ${hex}, spec ${spec.colors[name]?.value}`);
}

const ok = checks.every((c) => c.ok);
console.log(JSON.stringify({ ok, passed: checks.filter((c) => c.ok).length, failed: checks.filter((c) => !c.ok), total: checks.length }, null, 1));
process.exit(ok ? 0 : 1);
