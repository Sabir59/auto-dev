// Tests the draft file panel's containment check exactly as written in server.workspace-draft.mjs.
import { readFileSync, existsSync, statSync, realpathSync } from "node:fs";
import { resolve, sep, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const draft = readFileSync(join(HERE, "..", "server.workspace-draft.mjs"), "utf8");
const insideSrc = /const inside = (\(base, p\) => \{.*?\};)/.exec(draft)[1];
const inside = eval(insideSrc); // the draft's function, verbatim
console.log("draft inside():", insideSrc.slice(0, 110), "…\n");

const WS = join(HERE, "ws");
const attempts = ["README.md", "../outside/secret.txt", "jdir/secret.txt", "jdir/.env", join(HERE, "outside", "secret.txt"), "notes-link.txt", ".env", "..\\outside\\secret.txt", "jdir\\..\\..\\outside\\secret.txt"];
for (const q of attempts) {
  const p = resolve(WS, q);                      // what the draft's /tree and /file endpoints do
  const allowed = inside(WS, p) && existsSync(p) && statSync(p).isFile();
  let real = null; try { real = realpathSync(p); } catch {}
  const escapes = real && !inside(realpathSync(WS), real);
  const content = allowed ? readFileSync(p, "utf8").trim().slice(0, 40) : "";
  console.log(`${allowed ? "SERVED " : "refused"}  ${q.padEnd(40)} ${allowed && escapes ? "⚠ ESCAPES WORKSPACE via link → " + real.replace(HERE, "…") : ""} ${content ? "| " + content : ""}`);
}
