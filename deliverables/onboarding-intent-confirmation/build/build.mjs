#!/usr/bin/env node
// Builds the reference HTML implementation FROM THE PACKAGE ONLY:
//   tokens.json      -> tokens.css (CSS variables + one class per text style)
//   <screen>.src.html -> <screen>.html, with {{icon:name}} replaced by icons/name.svg
// Run: node build/build.mjs   (from the package root or anywhere)
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const tokens = JSON.parse(readFileSync(join(pkg, "tokens.json"), "utf8"));
const v = (name) => name.replace(/\//g, "-");

const css = [":root {"];
for (const [n, t] of Object.entries(tokens.color)) css.push(`  --color-${v(n)}: ${t.value};`);
for (const [n, px] of Object.entries(tokens.space)) css.push(`  --${v(n)}: ${px}px;`);
for (const [n, px] of Object.entries(tokens.radius)) css.push(`  --${v(n)}: ${px}px;`);
css.push("}");
for (const [n, t] of Object.entries(tokens.text)) {
  const font = tokens.font[t.font];
  const variation = font.variation ? Object.entries(font.variation).map(([k, x]) => `"${k}" ${x}`).join(", ") : "normal";
  css.push(
    `.t-${v(n)} { font-family: "${font.family}"; font-weight: ${t.weight}; font-size: ${t.size}px; line-height: ${t.lineHeight}px; ` +
      `letter-spacing: ${parseFloat(t.letterSpacing) / 100}em; font-variation-settings: ${variation};` +
      (t.textCase === "UPPER" ? " text-transform: uppercase;" : "") +
      " }"
  );
}
writeFileSync(join(here, "tokens.css"), css.join("\n") + "\n");

for (const f of readdirSync(here).filter((f) => f.endsWith(".src.html"))) {
  const html = readFileSync(join(here, f), "utf8").replace(/\{\{icon:([a-z-]+)\}\}/g, (_, name) =>
    readFileSync(join(pkg, "icons", `${name}.svg`), "utf8").replace(/ width="24" height="24"/, "").trim()
  );
  writeFileSync(join(here, f.replace(".src.html", ".html")), html);
}
console.log("built tokens.css +", readdirSync(here).filter((f) => f.endsWith(".src.html")).length, "screens");
