// Upgrading a pinned integration, and migrating workers made before integrations (schema 1).
//
// Upgrades: a worker moves to a newer version of one integration only when the person asks, after
// seeing what changes (upgradeDiff): what it provides, the core tools it needs, the accounts it asks
// for, its instructions, and how the worker's settings carry over. More access needs explicit approval.
//
// Migration: a schema-1 worker has a flat list of tools and text copied from integrations. Its
// proposal (proposeMigration) maps it to pinned integrations and explicit core capabilities, and
// separates the integrations' text from its own. Whether a mapping is safe:
//   exact      — from the request it was made from (its integrations and answers), same tools;
//   likely     — inferred from the tools it has, one setting that gives exactly those tools;
//   ambiguous  — no setting gives exactly its tools (or several do), or a tool maps to nothing:
//                the person chooses, and sees what the choice adds or removes.
// A migration never adds or removes a tool unless the person accepts that change.
import * as catalog from "./catalog.mjs";
import { evaluate, configErrors, resolve, SCHEMA } from "./workerdef.mjs";

const same = (a, b) => a.length === b.length && [...a].every((x) => b.includes(x));
const diffList = (a, b) => ({ added: b.filter((x) => !a.includes(x)), removed: a.filter((x) => !b.includes(x)) });
const reqKey = (r) => `${r.resource}:${r.access}`;
const shown = (q, config) => !q.when || [].concat(config[q.when.q] ?? []).some((v) => q.when.is.includes(v));

// A worker's settings for one integration, carried to another version of it: an answer is kept when
// the new version still has the question and accepts the answer; otherwise the new default is used.
export function carryConfig(config = {}, m) {
  const out = {}, kept = [], dropped = [], defaulted = [];
  for (const q of m.questions) {
    if (q.type === "info" || !shown(q, out)) continue;
    const v = config[q.id], ok = q.type === "text" ? typeof v === "string" : q.type === "multi" ? Array.isArray(v) && v.every((x) => q.choices.some((c) => c.id === x)) : v === null || q.choices.some((c) => c.id === v);
    if (q.id in config && ok) { out[q.id] = v; kept.push(q.id); } else { out[q.id] = q.type === "text" ? "" : q.type === "multi" ? [].concat(q.default ?? []) : q.default ?? null; defaulted.push(q.id); }
  }
  for (const k of Object.keys(config)) if (!(k in out)) dropped.push(k);
  return { config: out, kept, dropped, defaulted };
}

// What moving one integration of a worker to another version changes.
export function upgradeDiff(worker, integrationId, toVersion) {
  const ref = (worker.integrations || []).find((r) => r.id === integrationId);
  if (!ref) throw Object.assign(new Error(`This worker doesn't have ${integrationId}.`), { status: 400 });
  const from = catalog.get(ref.id, ref.version), to = catalog.get(ref.id, toVersion);
  if (!to) throw Object.assign(new Error(`${integrationId} ${toVersion} isn't in this console's catalogue.`), { status: 400 });
  if (from && catalog.cmpVersion(toVersion, ref.version) <= 0) throw Object.assign(new Error(`${toVersion} isn't newer than ${ref.version}.`), { status: 400 });
  const carried = carryConfig(ref.config, to), errs = configErrors(to, carried.config);
  const a = from ? evaluate(from, ref.config || {}) : { enables: [], core: [], requires: [], steps: [], limits: [] }, b = evaluate(to, carried.config);
  const granted = new Set(worker.core || []);
  const caps = diffList(a.enables, b.enables), core = diffList(a.core, b.core), acc = diffList(a.requires.map(reqKey), b.requires.map(reqKey));
  const coreToGrant = b.core.filter((c) => !granted.has(c));
  return { integration: ref.id, label: to.label, from: ref.version, to: toVersion, major: catalog.semver(toVersion)[0] !== catalog.semver(ref.version)[0],
    capabilities: caps, core: { ...core, toGrant: coreToGrant }, accounts: acc, steps: diffList(a.steps, b.steps), limits: diffList(a.limits, b.limits),
    config: { kept: carried.kept, dropped: carried.dropped, defaulted: carried.defaulted, errors: errs, next: carried.config },
    compatible: !errs.length, expands: caps.added.length > 0 || coreToGrant.length > 0, notes: to.changes || {} };
}
// The worker with that integration moved (the caller saves it as a new version of the worker).
export function applyUpgrade(worker, integrationId, toVersion, { approveExpansion = false } = {}) {
  const d = upgradeDiff(worker, integrationId, toVersion);
  if (!d.compatible) throw Object.assign(new Error(`Its settings aren't valid for ${toVersion}: ${d.config.errors.slice(0, 3).join("; ")}`), { status: 400 });
  if (d.expands && !approveExpansion) throw Object.assign(new Error(`Upgrading ${d.label} to ${toVersion} gives this worker more access (${[...d.capabilities.added, ...d.core.toGrant].join(", ")}). Approve that to upgrade.`), { status: 400, needsApproval: true });
  return { diff: d, worker: { ...worker, integrations: worker.integrations.map((r) => (r.id === integrationId ? { id: r.id, version: toVersion, config: d.config.next } : r)), core: [...new Set([...(worker.core || []), ...d.core.toGrant])] } };
}

// ---- migration ----
// Every setting of an integration whose choices could turn on tools: the configurations that give
// exactly `wanted` of its tools (searching its choice questions; text answers don't change tools).
function configsGiving(m, wanted) {
  const qs = m.questions.filter((q) => q.type === "choice" || q.type === "multi"), found = [];
  const opts = (q) => (q.type === "multi" ? subsets(q.choices.map((c) => c.id)) : [null, ...q.choices.map((c) => c.id)]);
  const walk = (i, cfg) => {
    if (found.length > 20) return;
    if (i === qs.length) { const e = evaluate(m, cfg); if (same(e.enables, wanted)) found.push(structuredClone(cfg)); return; }
    const q = qs[i]; if (!shown(q, cfg)) return walk(i + 1, cfg);
    for (const o of opts(q)) { cfg[q.id] = o; walk(i + 1, cfg); delete cfg[q.id]; }
  };
  walk(0, {});
  return found;
}
const subsets = (xs) => xs.reduce((acc, x) => [...acc, ...acc.map((s) => [...s, x])], [[]]).slice(0, 64);
// A full configuration from partial answers: text questions empty, others as given (or their default).
const complete = (m, partial) => { const cfg = {}; for (const q of m.questions) { if (q.type === "info" || !shown(q, cfg)) continue; cfg[q.id] = q.id in partial ? partial[q.id] : q.type === "text" ? "" : q.type === "multi" ? [] : q.default ?? null; } return cfg; };

export function proposeMigration(w) {
  const coreIds = catalog.coreIds(), caps = [...(w.capabilities || [])], notes = [];
  const core = caps.filter((c) => coreIds.has(c)), integrationCaps = caps.filter((c) => !coreIds.has(c));
  let integrations = [], status = "likely", candidates = null;
  // 1. From the request it was made from.
  const fr = w.fromRequest;
  if (fr?.integrations?.length) {
    integrations = fr.integrations.filter((id) => catalog.get(id, "1.0.0")).map((id) => ({ id, version: "1.0.0", config: complete(catalog.get(id, "1.0.0"), fr.answers?.[id] || {}), confidence: "exact", why: "From the request it was created from (its integrations and answers)." }));
    status = "exact";
  }
  // 2. Integration tools not covered: inferred from which integration provides them.
  const covered = new Set(integrations.flatMap((r) => evaluate(catalog.get(r.id, r.version), r.config).enables));
  const missing = integrationCaps.filter((c) => !covered.has(c)), unmapped = [];
  const byIntegration = new Map();
  for (const c of missing) { const m = catalog.latestAll().find((x) => x.capabilities.some((y) => y.id === c)); if (!m) { unmapped.push(c); continue; } if (!byIntegration.has(m.id)) byIntegration.set(m.id, []); byIntegration.get(m.id).push(c); }
  for (const [id, want] of byIntegration) {
    const m = catalog.get(id, "1.0.0") || catalog.latest(id), configs = configsGiving(m, want).map((cfg) => complete(m, cfg));
    if (integrations.some((r) => r.id === id)) { status = "ambiguous"; notes.push(`${m.label}: the request it was made from doesn't account for ${want.join(", ")}.`); continue; }
    if (configs.length === 1) { integrations.push({ id, version: m.version, config: configs[0], confidence: "likely", why: `It has ${want.join(", ")}, which ${m.label} provides with these settings.` }); if (status === "exact") status = "likely"; }
    else {
      status = "ambiguous";
      // The choices the person can make: each setting that gives a subset of its tools, with what it gives up.
      const options = [];
      for (const cfg of allConfigs(m)) { const e = evaluate(m, complete(m, cfg)); if (e.enables.length && e.enables.every((x) => want.includes(x))) options.push({ config: complete(m, cfg), gives: e.enables, loses: want.filter((x) => !e.enables.includes(x)) }); }
      options.sort((a, b) => a.loses.length - b.loses.length);
      candidates = { ...(candidates || {}), [id]: dedupe(options).slice(0, 6) };
      notes.push(configs.length ? `${m.label}: several settings give ${want.join(", ")}.` : `${m.label}: no single setting gives ${want.join(", ")} together (they contradict each other); choose which it keeps.`);
    }
  }
  if (unmapped.length) { status = "ambiguous"; notes.push(`Not provided by any integration here: ${unmapped.join(", ")}.`); }
  // 3. Its own text: what its integrations say is theirs (read from their manifests), the rest is its own.
  const ownOf = (refs) => {
    const ev = refs.map((r) => ({ m: catalog.get(r.id, r.version), e: evaluate(catalog.get(r.id, r.version), r.config) }));
    const steps = new Set(ev.flatMap((x) => x.e.steps)), limits = new Set(ev.flatMap((x) => x.e.limits)), know = new Set(ev.flatMap((x) => [...x.e.know, ...x.e.unsupported.map((u) => `Not possible here: ${u}`)]));
    const knowLines = String(w.knowledge || "").split("\n");
    return { workflow: (w.workflow || []).filter((s) => !steps.has(s)), limitations: (w.limitations || []).filter((s) => !limits.has(s)), knowledge: knowLines.filter((l) => !know.has(l)).join("\n").trim(),
      moved: { steps: (w.workflow || []).filter((s) => steps.has(s)), limits: (w.limitations || []).filter((s) => limits.has(s)), knowledge: knowLines.filter((l) => know.has(l)) } };
  };
  const build = (refs) => {
    const own = ownOf(refs), stored = { schema: SCHEMA, ...w, integrations: refs.map(({ id, version, config }) => ({ id, version, config })), core, workflow: own.workflow, limitations: own.limitations, knowledge: own.knowledge };
    const resolved = resolve(stored), before = caps, after = resolved.capabilities;
    const extraRequirements = (w.requirements || []).filter((r) => !resolved.requirements.some((x) => reqKey(x) === reqKey(r)));
    const reqAfter = resolve({ ...stored, extraRequirements }).requirements;
    return { integrations: refs, core, own, extraRequirements, effective: { before, after, ...diffList(before, after) }, requirements: { before: (w.requirements || []).map(reqKey), after: reqAfter.map(reqKey), ...diffList((w.requirements || []).map(reqKey), reqAfter.map(reqKey)) } };
  };
  const proposal = build(integrations);
  const equal = !proposal.effective.added.length && !proposal.effective.removed.length;
  if (!equal && status !== "ambiguous") { status = "ambiguous"; notes.push(`Mapped this way it would ${[proposal.effective.added.length ? `gain ${proposal.effective.added.join(", ")}` : "", proposal.effective.removed.length ? `lose ${proposal.effective.removed.join(", ")}` : ""].filter(Boolean).join(" and ")}.`); }
  // For an ambiguous one: each choice, built in full, so the person sees exactly what it changes.
  const choices = candidates ? Object.entries(candidates).flatMap(([id, opts]) => opts.map((o) => { const m = catalog.get(id, "1.0.0") || catalog.latest(id); return { integration: id, label: m.label, config: o.config, gives: o.gives, loses: o.loses, result: build([...integrations, { id, version: m.version, config: o.config, confidence: "chosen" }]) }; })) : [];
  return { worker: w.id, name: w.name, version: w.version, status, notes, unmapped, ...proposal, equal, choices };
}
function allConfigs(m) { const out = []; const qs = m.questions.filter((q) => q.type === "choice" || q.type === "multi"); const walk = (i, cfg) => { if (out.length > 60) return; if (i === qs.length) { out.push(structuredClone(cfg)); return; } const q = qs[i]; if (!shown(q, cfg)) return walk(i + 1, cfg); for (const o of q.type === "multi" ? subsets(q.choices.map((c) => c.id)) : [null, ...q.choices.map((c) => c.id)]) { cfg[q.id] = o; walk(i + 1, cfg); delete cfg[q.id]; } }; walk(0, {}); return out; }
const dedupe = (opts) => { const seen = new Set(); return opts.filter((o) => { const k = JSON.stringify(o.gives.slice().sort()); if (seen.has(k)) return false; seen.add(k); return true; }); };
