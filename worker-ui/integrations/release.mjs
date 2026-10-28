// Releasing a manifest version: records its sha256 in releases.lock.json, after which it's immutable
// (the console refuses to start if it changes). Run it only after the review REVIEW.md asks for.
//   node worker-ui/integrations/release.mjs <id>@<version> [...]      release these
//   node worker-ui/integrations/release.mjs --check                   list unreleased and changed versions
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifestHash } from "../catalog.mjs";

const DIR = process.env.AIW_INTEGRATIONS_DIR || dirname(fileURLToPath(import.meta.url)), LOCK = join(DIR, "releases.lock.json");
const lock = existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, "utf8")) : { format: 1, note: "Released integration manifests: id@version → sha256 of the parsed JSON. Never edit by hand; never remove an entry.", released: {} };
const all = readdirSync(DIR).filter((d) => statSync(join(DIR, d)).isDirectory()).flatMap((id) => readdirSync(join(DIR, id)).filter((f) => f.endsWith(".json")).map((f) => `${id}@${f.slice(0, -5)}`));
const hashOf = (key) => { const [id, v] = key.split("@"); return manifestHash(JSON.parse(readFileSync(join(DIR, id, `${v}.json`), "utf8"))); };
const args = process.argv.slice(2);
if (args[0] === "--check") {
  for (const k of all) console.log(`${k}: ${!lock.released[k] ? "unreleased" : lock.released[k] === hashOf(k) ? "released" : "CHANGED AFTER RELEASE"}`);
  process.exit(0);
}
for (const key of args) {
  if (!all.includes(key)) throw new Error(`no manifest ${key}`);
  if (lock.released[key] && lock.released[key] !== hashOf(key)) throw new Error(`${key} was released and has changed since: publish a new version instead`);
  lock.released[key] = hashOf(key);
}
lock.released = Object.fromEntries(Object.entries(lock.released).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(LOCK, JSON.stringify(lock, null, 1) + "\n");
console.log(`released: ${args.join(", ") || "nothing"}`);
