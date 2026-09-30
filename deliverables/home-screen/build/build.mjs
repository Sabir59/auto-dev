#!/usr/bin/env node
// home.src.html -> home.html, inlining each <img ... src="../icons/NAME.svg">
// as inline SVG, because currentColor only reaches inline SVG, not <img>.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "home.src.html"), "utf8").replace(
  /<img class="(icon\d+)" alt="" src="\.\.\/icons\/([a-z-]+)\.svg">/g,
  (_, cls, name) => readFileSync(join(here, "..", "icons", `${name}.svg`), "utf8").trim().replace("<svg ", `<svg class="${cls}" aria-hidden="true" `)
);
writeFileSync(join(here, "home.html"), html);
console.log("built home.html,", (html.match(/<svg /g) || []).length, "inline icons");
