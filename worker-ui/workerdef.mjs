// Worker definitions, schema 2: a worker is its role, a list of integrations pinned to exact
// versions with a validated configuration each, the core capabilities granted to it explicitly, and
// its own instructions. Nothing about an integration is copied into the worker: what it provides
// (tools, accounts, steps, limits, knowledge) is read from the pinned manifest when it's needed.
//
// Stored (workers.json):
//   { schema: 2, id, name, specialization, mission, outcomes[],
//     integrations: [{ id, version, config }], core: [capability ids],
//     workflow[], knowledge, limitations[], onMissing, extraRequirements[],     ← written by the person
//     repos[], version, createdAt, updatedAt, fromRequest?, origin?, migratedFrom? }
// Resolved (what the rest of the console reads): the stored fields, plus capabilities and
// requirements worked out from the manifests, the integrations' instructions (kept apart from the
// worker's own), and a resolution report. Resolution fails closed: an integration whose pinned
// version is missing, or whose configuration is invalid, contributes nothing.
//
// Schema 1 (the earlier flat form: capabilities[] and copied text) is read as it is until it's
// migrated (migrate.mjs); its behaviour doesn't change.
import * as catalog from "./catalog.mjs";
import { validate } from "./jsonschema.mjs";

export const SCHEMA = 2;
export const isV2 = (w) => w?.schema === SCHEMA;
const STORED = ["schema", "id", "name", "specialization", "mission", "outcomes", "integrations", "core", "workflow", "knowledge", "limitations", "onMissing", "extraRequirements", "repos", "version", "createdAt", "updatedAt", "fromRequest", "origin", "migratedFrom"];
export const toStored = (w) => (isV2(w) ? Object.fromEntries(STORED.filter((k) => w[k] !== undefined).map((k) => [k, w[k]])) : (({ status, memoryCount, runtime, ...rest }) => rest)(w));
const shown = (q, config) => !q.when || [].concat(config[q.when.q] ?? []).some((v) => q.when.is.includes(v));

// What one integration, at one version and configuration, provides.
export function evaluate(m, config = {}) {
  const out = { enables: [...m.base.enables], core: [...m.base.core], requires: m.base.requires.map((r) => ({ ...r })), steps: [...m.instructions.steps], limits: [...m.instructions.limits], know: [], unsupported: [], approvals: [], starters: [...m.instructions.starters] };
  if (m.status === "recognised") out.unsupported.push(`${m.label}. ${m.why || "There's no connector for it."}`);
  for (const q of m.questions) {
    if (q.type === "info" || !shown(q, config)) continue;
    const v = config[q.id];
    if (q.type === "text") { if (v && q.knowledge) out.know.push(`${q.knowledge}: ${v}`); continue; }
    const picked = q.type === "multi" ? (Array.isArray(v) ? v : []) : v == null ? [] : [v];
    for (const c of (q.choices || []).filter((c) => picked.includes(c.id))) {
      out.enables.push(...(c.enables || [])); out.core.push(...(c.core || [])); out.requires.push(...(c.requires || []).map((r) => ({ ...r })));
      out.limits.push(...(c.limits || [])); if (c.know) out.know.push(c.know); if (c.approval) out.approvals.push(`${m.label}: ${c.approval}`);
      if (c.unsupported) out.unsupported.push(`${m.label}: ${c.label}. ${c.unsupported}`);
    }
  }
  out.enables = [...new Set(out.enables)]; out.core = [...new Set(out.core)];
  return out;
}
export const configErrors = (m, config) => validate(m.config.schema, config ?? {}, m.config.schema);
const mergeReqs = (list) => {
  const out = [];
  for (const r of list) { const k = out.find((x) => x.resource === r.resource && x.access === r.access); if (!k) out.push({ resource: r.resource, access: r.access, need: r.need === "optional" ? "optional" : "required" }); else if (r.need === "required") k.need = "required"; }
  return out;
};

// The resolved form of a stored worker (schema 2), or the worker as it is (schema 1).
export function resolve(w) {
  if (!isV2(w)) return w;
  const report = [], issues = [], instructions = [], bindings = {};
  let enables = [], reqs = [];
  const core = new Set(w.core || []);
  for (const ref of w.integrations || []) {
    const m = catalog.get(ref.id, ref.version), latest = catalog.latest(ref.id);
    const r = { id: ref.id, version: ref.version, label: m?.label || latest?.label || ref.id, status: m?.status || "missing", latest: latest?.version || null, ok: false, issues: [] };
    if (!m) { r.issues.push(latest ? `Version ${ref.version} isn't in this console's catalogue (it has ${catalog.versions(ref.id).join(", ")}).` : `“${ref.id}” isn't an integration this console has.`); report.push(r); issues.push(...r.issues.map((t) => `${r.label}: ${t}`)); continue; }
    const errs = configErrors(m, ref.config);
    if (errs.length) { r.issues.push(`Its settings aren't valid: ${errs.slice(0, 3).join("; ")}`); report.push(r); issues.push(...r.issues.map((t) => `${r.label}: ${t}`)); continue; }
    const e = evaluate(m, ref.config || {});
    for (const c of e.core) if (!core.has(c)) r.issues.push(`It uses ${c} (${m.coreWhy?.[c] || "a core tool"}), which isn't granted to this worker.`);
    for (const c of e.enables) bindings[c] = m.capabilities.find((x) => x.id === c)?.accounts || [];
    enables.push(...e.enables); reqs.push(...e.requires);
    instructions.push({ id: m.id, version: m.version, label: m.label, steps: e.steps, limits: e.limits, know: e.know, unsupported: e.unsupported, approvals: e.approvals });
    Object.assign(r, { ok: true, enables: e.enables, core: e.core, requires: e.requires, upgrade: latest && catalog.cmpVersion(latest.version, m.version) > 0 ? latest.version : null });
    report.push(r); issues.push(...r.issues.map((t) => `${r.label}: ${t}`));
  }
  for (const c of core) bindings[c] = catalog.capabilityAccounts(c) || [];
  // In a stable order: core capabilities as the core catalogue lists them, then the integrations' in theirs.
  const capabilities = [...new Set([...[...catalog.coreIds()].filter((c) => core.has(c)), ...enables])];
  return { ...w, capabilities, requirements: mergeReqs([...reqs, ...(w.extraRequirements || [])]), integrationInstructions: instructions, resolution: { integrations: report, issues, bindings } };
}

// A stored schema-2 definition from what the page or an import sends, checked: every integration at
// a version this console has, its configuration valid, core capabilities from the core catalogue,
// requirements the console can check. Throws (status 400) with what's wrong.
export function check(b, { resources }) {
  const fail = (m) => { throw Object.assign(new Error(m), { status: 400 }); };
  const refs = Array.isArray(b.integrations) ? b.integrations : [];
  if (refs.length > 20) fail("A worker can have at most 20 integrations.");
  const seen = new Set(), integrations = [];
  for (const ref of refs) {
    const id = String(ref?.id || ""), version = String(ref?.version || "");
    if (seen.has(id)) fail(`“${id}” is listed twice.`); seen.add(id);
    const m = catalog.get(id, version);
    if (!m) fail(catalog.latest(id) ? `${id} ${version} isn't a version this console has (it has ${catalog.versions(id).join(", ")}).` : `“${id}” isn't an integration this console has.`);
    const config = ref.config && typeof ref.config === "object" && !Array.isArray(ref.config) ? ref.config : {};
    const errs = configErrors(m, config); if (errs.length) fail(`${m.label}: ${errs.slice(0, 3).join("; ")}`);
    integrations.push({ id, version, config });
  }
  const coreIds = catalog.coreIds(), core = [...new Set((Array.isArray(b.core) ? b.core : []).map(String))];
  for (const c of core) if (!coreIds.has(c)) fail(`“${c}” isn't a core capability${catalog.latestAll().some((m) => m.capabilities.some((x) => x.id === c)) ? ": it comes from an integration" : ""}.`);
  const extra = (Array.isArray(b.extraRequirements) ? b.extraRequirements : []).slice(0, 20).map((r) => ({ resource: String(r?.resource || ""), access: String(r?.access || ""), need: r?.need === "optional" ? "optional" : "required" }));
  for (const r of extra) if (!resources[r.resource]?.access[r.access]) fail(`Unknown requirement "${r.resource} ${r.access}".`);
  return { integrations, core, extraRequirements: mergeReqs(extra) };
}

// A schema-2 definition from a composed draft (integrations.mjs compose): each integration it
// involves pinned at the version it was composed with, its answers as its configuration, the core
// tools the draft gives as explicit grants, and only the generic text as the worker's own.
export function fromDraft(d) {
  const core = d.definition.capabilities.filter((c) => catalog.isCore(c));
  const integrations = d.integrations.map((id) => ({ id, version: catalog.latest(id).version, config: d.answers[id] || {} }));
  const generic = d.definition.workflow.filter((s) => !d.integrations.some((id) => catalog.latest(id).instructions.steps.includes(s)));
  const ownLimits = d.definition.limitations.filter((l) => !d.integrations.some((id) => { const e = evaluate(catalog.latest(id), d.answers[id] || {}); return e.limits.includes(l); }));
  return { schema: SCHEMA, integrations, core, workflow: generic, knowledge: `Set up from this request: "${d.description}"`, limitations: ownLimits, onMissing: d.definition.onMissing, extraRequirements: [] };
}
