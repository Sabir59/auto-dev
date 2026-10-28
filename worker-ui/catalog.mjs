// The integration warehouse: versioned JSON manifests (worker-ui/integrations/<id>/<semver>.json)
// and the core capability catalogue (integrations/core.json). The only source of integration
// metadata for creating, editing, running, exporting and importing workers.
//
// Loaded once and checked before the console serves anything (load() throws, the console refuses
// to start):
//  - every manifest against manifest.schema.json, its id and version against its path;
//  - released versions against releases.lock.json: a released manifest is immutable (its sha256 is
//    recorded at release); a version not in the lock is unreleased, and refused unless
//    AIW_INTEGRATIONS_DEV=1 (development and tests only);
//  - every id against the console's code catalogues (capabilities and requirements), every
//    capability classified exactly once (core, or provided by integrations), relations and added
//    integrations pointing at real ones, the tests a manifest names existing, its patterns compiling.
// Executable logic (what a capability's tools are, how an account is checked) stays in code.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { validate } from "./jsonschema.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, "..");
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const semver = (v) => SEMVER.exec(v)?.slice(1).map(Number) || null;
export const cmpVersion = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
// The hash of a manifest's content: its parsed JSON, so line endings and indentation don't matter
// (Git may change them) but any change to a value or a key does.
export const manifestHash = (obj) => createHash("sha256").update(JSON.stringify(obj)).digest("hex");

let STATE = null;
export function load({ dir = process.env.AIW_INTEGRATIONS_DIR || join(HERE, "integrations"), dev = process.env.AIW_INTEGRATIONS_DEV === "1" } = {}) {
  const read = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch (e) { throw new Error(`integrations: ${f} isn't valid JSON (${e.message})`); } };
  const mSchema = read(join(HERE, "integrations", "manifest.schema.json")), cSchema = read(join(HERE, "integrations", "core.schema.json"));
  const core = read(join(dir, "core.json")), cErr = validate(cSchema, core);
  if (cErr.length) throw new Error(`integrations: core.json: ${cErr.slice(0, 5).join("; ")}`);
  const lock = existsSync(join(dir, "releases.lock.json")) ? read(join(dir, "releases.lock.json")).released || {} : {};
  const byId = new Map(), problems = [];
  for (const id of readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory()).sort()) {
    for (const f of readdirSync(join(dir, id)).filter((f) => f.endsWith(".json"))) {
      const m = read(join(dir, id, f)), version = f.replace(/\.json$/, ""), key = `${id}@${version}`;
      const errs = validate(mSchema, m);
      if (errs.length) { problems.push(`${key}: ${errs.slice(0, 4).join("; ")}`); continue; }
      if (m.id !== id || m.version !== version) { problems.push(`${key}: its id and version (${m.id}@${m.version}) must match its path`); continue; }
      try { validate(m.config.schema, {}); } catch (e) { problems.push(`${key}: config schema: ${e.message}`); continue; }
      const released = !!lock[key];
      if (released && lock[key] !== manifestHash(m)) { problems.push(`${key} changed after it was released. Released versions are immutable: publish a new version instead (integrations/REVIEW.md).`); continue; }
      if (!released && !dev) { problems.push(`${key} isn't released (not in releases.lock.json). Release it after review, or set AIW_INTEGRATIONS_DEV=1 to try it in development.`); continue; }
      if (!byId.has(id)) byId.set(id, new Map());
      byId.get(id).set(version, Object.freeze({ ...m, released }));
    }
  }
  if (problems.length) throw new Error(`integrations: ${problems.join("\n  ")}`);
  for (const key of Object.keys(lock)) { const [id, v] = key.split("@"); if (!byId.get(id)?.get(v)) throw new Error(`integrations: ${key} is released but its manifest is missing. Released versions are kept for the workers that pin them.`); }
  STATE = { dir, core, byId, lock, dev };
  return STATE;
}
const S = () => STATE || load();

// ---- reading ----
export const dir = () => S().dir; // where the manifests are (never writable by a worker: server.mjs platformDeny)
export const coreCatalog = () => S().core;
export const coreIds = () => new Set(S().core.capabilities.map((c) => c.id));
export const isCore = (id) => coreIds().has(id);
export const generalDefault = () => [...S().core.general.default];
export const ids = () => [...S().byId.keys()];
export const versions = (id) => [...(S().byId.get(id)?.keys() || [])].sort(cmpVersion);
export const get = (id, version) => S().byId.get(id)?.get(version) || null;
export const latest = (id) => { const v = versions(id); return v.length ? get(id, v[v.length - 1]) : null; };
export const latestAll = () => ids().map(latest);
export const releasedKey = (id, version) => !!S().lock[`${id}@${version}`];
// The accounts a capability needs connected before it's loaded: from the given manifest (the
// worker's pinned version), else from the core catalogue, else from the newest manifest providing it.
export function capabilityAccounts(cap, manifest = null) {
  const own = manifest?.capabilities.find((c) => c.id === cap); if (own) return own.accounts;
  const core = S().core.capabilities.find((c) => c.id === cap); if (core) return core.accounts;
  for (const m of latestAll()) { const c = m.capabilities.find((x) => x.id === cap); if (c) return c.accounts; }
  return null; // unknown: callers treat it as not grantable
}
// Names from templates: "{team} branch sync worker" (fallback when a field is empty), "{stack|Software} …".
export function render(tpl, answers = {}, fallback = "") {
  let missing = false;
  const s = String(tpl || "").replace(/\{(\w+)(?:\|([^}]*))?\}/g, (_, k, d) => { const v = String(answers[k] ?? "").trim(); if (v) return v; if (d != null) return d; missing = true; return ""; });
  return missing ? fallback || s.trim() : s;
}

// ---- consistency with the console's code catalogues ----
// capabilities: { id: {...} } (code); resources: { id: { access: {...} } }. Throws listing every problem.
export function check(capabilities, resources) {
  const st = S(), problems = [], core = coreIds();
  const acct = (a, where) => { if (!resources[a.resource]?.access[a.access]) problems.push(`${where}: unknown account ${a.resource} ${a.access}`); };
  for (const c of core) if (!capabilities[c]) problems.push(`core.json: unknown capability ${c}`);
  for (const c of st.core.capabilities) c.accounts.forEach((a) => acct(a, `core ${c.id}`));
  for (const g of st.core.general.default) if (!core.has(g)) problems.push(`core.json: the General default ${g} isn't a core capability`);
  const provided = new Map();
  for (const [id, vs] of st.byId) for (const [v, m] of vs) {
    const key = `${id}@${v}`, offered = new Set(m.capabilities.map((c) => c.id));
    for (const c of m.capabilities) { if (!capabilities[c.id]) problems.push(`${key}: unknown capability ${c.id}`); if (core.has(c.id)) problems.push(`${key}: ${c.id} is a core capability; list it under core, not capabilities`); c.accounts.forEach((a) => acct(a, `${key} ${c.id}`)); provided.set(c.id, (provided.get(c.id) || 0) + 1); }
    const grant = (g, where) => {
      for (const e of g.enables || []) if (!offered.has(e)) problems.push(`${key} ${where}: enables ${e}, which it doesn't list under capabilities`);
      for (const e of g.core || []) { if (!core.has(e)) problems.push(`${key} ${where}: ${e} isn't a core capability`); else if (!m.coreWhy?.[e]) problems.push(`${key} ${where}: uses core ${e} without saying why (coreWhy)`); }
      (g.requires || []).forEach((r) => acct(r, `${key} ${where}`));
    };
    grant(m.base, "base");
    const qids = new Set(m.questions.map((q) => q.id));
    for (const q of m.questions) {
      if (q.when && !qids.has(q.when.q)) problems.push(`${key} ${q.id}: depends on unknown question ${q.when.q}`);
      for (const p of q.prefill || []) { try { new RegExp(p.pattern, "i"); } catch { problems.push(`${key} ${q.id}: bad prefill pattern ${p.pattern}`); } }
      for (const ch of q.choices || []) {
        grant(ch, `${q.id}=${ch.id}`);
        if (ch.adds) { const t = latest(ch.adds.integration); if (!t) problems.push(`${key} ${q.id}=${ch.id}: adds unknown integration ${ch.adds.integration}`); else if (t.status === "recognised") problems.push(`${key} ${q.id}=${ch.id}: adds ${t.id}, which has no connector`); }
      }
      if (q.type !== "info" && !m.config.schema.properties[q.id]) problems.push(`${key}: question ${q.id} has no field in the config schema`);
    }
    for (const d of m.detect) { try { new RegExp(d, "i"); } catch { problems.push(`${key}: bad detection pattern ${d}`); } }
    for (const r of m.relations) { if (!st.byId.has(r.to)) problems.push(`${key}: relation to unknown integration ${r.to}`); for (const w of r.when || []) { try { new RegExp(w, "i"); } catch { problems.push(`${key}: bad relation pattern ${w}`); } } }
    for (const a of m.absorbs || []) if (!st.byId.has(a)) problems.push(`${key}: absorbs unknown integration ${a}`);
    for (const t of m.tests) if (!existsSync(join(REPO, t))) problems.push(`${key}: its test ${t} doesn't exist`);
    if (m.status !== "recognised" && !m.capabilities.length && !m.base.core.length && !m.questions.some((q) => q.choices?.some((c) => c.core?.length || c.enables?.length))) problems.push(`${key}: a connector that turns nothing on`);
  }
  for (const id of Object.keys(capabilities)) if (!core.has(id) && !provided.has(id)) problems.push(`capability ${id} is neither core nor provided by any integration`);
  if (problems.length) throw new Error(`integrations: ${problems.join("\n  ")}`);
  return true;
}
