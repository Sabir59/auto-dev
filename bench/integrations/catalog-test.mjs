// The integration warehouse (worker-ui/catalog.mjs): the real catalogue loads and is consistent;
// released manifests are immutable; unreleased ones load only in development; bad manifests stop the
// console from starting. Works on copies of the catalogue in a temporary folder; the real one isn't changed.
//   node bench/integrations/catalog-test.mjs
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as catalog from "../../worker-ui/catalog.mjs";
import { INTEGRATIONS } from "../../worker-ui/integrations.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..", ".."), REAL = join(REPO, "worker-ui", "integrations");
const ROOT = join(tmpdir(), `cat-${Date.now()}`); mkdirSync(ROOT, { recursive: true });
const results = [];
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail).slice(0, 220)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 600)); }
};
const assert = (c, m) => { if (!c) throw new Error(typeof m === "string" ? m : JSON.stringify(m)); };
let n = 0;
const copy = () => { const d = join(ROOT, `c${n++}`); cpSync(REAL, d, { recursive: true }); return d; };
const edit = (dir, rel, fn) => { const f = join(dir, rel), j = JSON.parse(readFileSync(f, "utf8")); fn(j); writeFileSync(f, JSON.stringify(j, null, 2)); };
const next = (dir, fn) => { const m = JSON.parse(readFileSync(join(dir, "web", "1.0.0.json"), "utf8")); m.version = "1.1.0"; fn(m); writeFileSync(join(dir, "web", "1.1.0.json"), JSON.stringify(m, null, 2)); };
const loads = (dir, dev = false) => { try { catalog.load({ dir, dev }); return true; } catch (e) { return e.message; } };
// Whether the console starts with this catalogue (it checks the manifests against its code catalogues).
async function consoleStarts(dir, dev = false) {
  const port = String(8770 + (n % 9)), D = join(ROOT, `data${n++}`);
  const p = spawn(process.execPath, [join(REPO, "worker-ui", "server.mjs")], { env: { ...process.env, WORKER_CONSOLE_PORT: port, WORKER_CONSOLE_DATA: D, AIW_INTEGRATIONS_DIR: dir, ...(dev ? { AIW_INTEGRATIONS_DEV: "1" } : {}), FIGMA_BRIDGE_PORT: "8779" }, stdio: ["ignore", "ignore", "pipe"] });
  let err = ""; p.stderr.on("data", (d) => (err += d));
  for (let i = 0; i < 60; i++) {
    if (p.exitCode != null) return err.replace(/\r/g, "").match(/Error: (integrations: [\s\S]*?)\n\s+at /)?.[1] || err.slice(-400) || `exited ${p.exitCode}`;
    try { await fetch(`http://127.0.0.1:${port}/`); p.kill(); return true; } catch {}
    await new Promise((ok) => setTimeout(ok, 250));
  }
  p.kill(); return "timed out";
}

await step("the real catalogue: every manifest valid, released and owned, with its tests present; the console starts with it; the registry the creation flow reads comes from it, in its order", async () => {
  catalog.load({ dir: REAL, dev: false });
  const ms = catalog.latestAll(), unreleased = ms.filter((m) => !m.released);
  assert(ms.length >= 20 && !unreleased.length && ms.every((m) => m.owner.accountable && m.tests.every((t) => existsSync(join(REPO, t)))), { count: ms.length, unreleased: unreleased.map((m) => m.id) });
  assert(INTEGRATIONS[0].id === "gitsync" && INTEGRATIONS.find((i) => i.id === "builder").version === "1.0.0" && INTEGRATIONS.every((i) => catalog.get(i.id, i.version)), INTEGRATIONS.map((i) => i.id));
  const started = await consoleStarts(REAL); assert(started === true, started);
  return { manifests: ms.length, core: [...catalog.coreIds()], connectors: ms.filter((m) => m.status === "tested").map((m) => m.id) };
});

await step("core and integration capabilities are separate: no core tool is provided by an integration, every integration capability names the accounts it needs, every core tool an integration uses says why", async () => {
  const core = catalog.coreIds(), ms = catalog.latestAll();
  const clash = ms.flatMap((m) => m.capabilities.filter((c) => core.has(c.id)).map((c) => `${m.id}:${c.id}`));
  const noWhy = ms.flatMap((m) => [...m.base.core, ...m.questions.flatMap((q) => (q.choices || []).flatMap((c) => c.core || []))].filter((c) => !m.coreWhy?.[c]).map((c) => `${m.id}:${c}`));
  assert(!clash.length && !noWhy.length && ms.every((m) => m.capabilities.every((c) => Array.isArray(c.accounts))), { clash, noWhy });
  return { core: [...core], provided: Object.fromEntries(ms.filter((m) => m.capabilities.length).map((m) => [m.id, m.capabilities.map((c) => c.id)])) };
});

await step("released manifests are immutable: a changed value is refused (the console won't start); reformatting (indentation, line endings) isn't a change", async () => {
  const changed = copy(); edit(changed, "builder/1.0.0.json", (m) => { m.instructions.steps.push("Publish everything"); });
  const reformatted = copy(), f = join(reformatted, "figma", "1.0.0.json"); writeFileSync(f, JSON.stringify(JSON.parse(readFileSync(f, "utf8")), null, 4).replace(/\n/g, "\r\n"));
  const a = loads(changed), b = loads(reformatted), c = await consoleStarts(changed);
  assert(/builder@1\.0\.0 changed after it was released/.test(a) && b === true && /changed after it was released/.test(c), { a, b, c });
  return { refused: a.split("\n")[0].slice(0, 120) };
});

await step("a new version stays unreleased until it's released: refused normally, loaded in development; releasing it records its hash; a released version that disappears is refused", async () => {
  const d = copy(); const m = JSON.parse(readFileSync(join(d, "builder", "1.0.0.json"), "utf8")); m.version = "1.1.0"; m.changes = { "1.1.0": "test" };
  writeFileSync(join(d, "builder", "1.1.0.json"), JSON.stringify(m, null, 2));
  const prod = loads(d), dev = loads(d, true);
  const r = await new Promise((ok) => { const p = spawn(process.execPath, [join(REPO, "worker-ui", "integrations", "release.mjs"), "builder@1.1.0"], { env: { ...process.env, AIW_INTEGRATIONS_DIR: d } }); p.on("exit", ok); });
  const after = loads(d);
  const gone = copy(); rmSync(join(gone, "web", "1.0.0.json")); const missing = loads(gone);
  assert(/builder@1\.1\.0 isn't released/.test(prod) && dev === true && r === 0 && after === true && catalog.versions("builder").join() === "1.0.0,1.1.0" && /web@1\.0\.0 is released but its manifest is missing/.test(missing), { prod, dev, r, after, missing });
  return { versions: catalog.versions("builder") };
});

await step("bad manifests stop the console: an unknown field, a bad version, a path that doesn't match, a capability the console doesn't have, a core tool used without a reason, a relation to nothing", async () => {
  const cases = {
    unknownField: (d) => edit(d, "web/1.0.0.json", (m) => { m.grantsEverything = true; }),
    badVersion: (d) => { const f = join(d, "web", "1.0.0.json"), m = JSON.parse(readFileSync(f, "utf8")); m.version = "1.0"; writeFileSync(join(d, "web", "1.0.json"), JSON.stringify(m)); },
    pathMismatch: (d) => edit(d, "web/1.0.0.json", (m) => { m.id = "webx"; }),
    // (in a new, unreleased version: a released one can't change at all)
    unknownCapability: (d) => next(d, (m) => { m.capabilities.push({ id: "teleport.anywhere", accounts: [] }); m.base.enables.push("teleport.anywhere"); }),
    coreWithoutWhy: (d) => next(d, (m) => { m.base.core.push("shell"); }),
    relationToNothing: (d) => next(d, (m) => { m.relations.push({ to: "nowhere", kind: "optional", why: "x" }); }),
  };
  const out = {};
  for (const [k, fn] of Object.entries(cases)) { const d = copy(); fn(d); out[k] = await consoleStarts(d, true); }
  assert(Object.values(out).every((v) => v !== true), out);
  assert(/isn't allowed/.test(out.unknownField) && /doesn't match|must match/.test(out.badVersion + out.pathMismatch) && /unknown capability teleport/.test(out.unknownCapability) && /without saying why/.test(out.coreWithoutWhy) && /unknown integration nowhere/.test(out.relationToNothing), out);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, String(v).split("\n").slice(-1)[0].slice(0, 90)]));
});

catalog.load({ dir: REAL });
writeFileSync(join(HERE, "catalog-results.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
