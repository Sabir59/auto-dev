// What a worker can be connected to, and what it takes to configure one for a person's request.
//
// A person describes the work in their own words ("manage products in my Shopify store", "build
// features in my Next.js repository"). The console recognises the tools and systems that involves,
// asks only those integrations' questions, and composes an ordinary worker definition from the
// answers (worker-platform.md §13). This file is the registry: each integration says what really
// exists for it today, its questions, and what each answer turns on. It describes integrations, not
// job titles: any combination can be requested, and anything the registry doesn't know is named
// and reported as not connected.
//
// What an answer can do: add capabilities and requirements from the console's fixed catalogues,
// steps, knowledge and limits (instructions to the worker), an approval note, or bring in another
// integration (a Shopify products CSV is the "files" integration). What it can't do: grant access.
// The definition still runs through workerRuntime (capabilities ∩ workspace mode ∩ Team scope ∩
// platform), requirements are only checked, and the adapters enforce their own limits.
//
// connector: true  — a real, tested implementation exists (an adapter or built-in tools).
// connector: false — recognised, but there's no connector: the request is answered honestly, with
//                    what can be done today instead (often another integration).
//
// Question types: choice (one), multi (several), text (context for the worker, never access), info.
// `when: { q, is: [...] }` shows a question only for those answers. `required` with no default: the
// person has to answer before the worker can be created (a follow-up, not a guess).

// The registry is the integration warehouse (worker-ui/catalog.mjs: versioned JSON manifests in
// worker-ui/integrations/). Composing a new worker uses each integration's newest released version;
// a worker pins the versions it was made with. Here the manifests take the shape the composer reads.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as catalog from "./catalog.mjs";

const ORDER = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "integrations", "order.json"), "utf8")).order;
const reqTuples = (rs = []) => rs.map((r) => [r.resource, r.access, r.need]);
export const entryOf = (m) => ({
  id: m.id, version: m.version, label: m.label, ...(m.short ? { short: m.short } : {}), summary: m.summary || "", connector: m.status !== "recognised", status: m.status, workspace: m.workspace,
  ...(m.why ? { why: m.why } : {}), detect: m.detect, ...(m.absorbs ? { absorbs: m.absorbs } : {}),
  caps: [...m.base.enables, ...m.base.core], reqs: reqTuples(m.base.requires),
  name: (a) => (m.naming ? catalog.render(m.naming.name, a, m.naming.fallback) : `${m.label} worker`), specialization: (a) => (m.naming ? catalog.render(m.naming.specialization, a) : m.label),
  steps: m.instructions.steps, limits: m.instructions.limits, starters: m.instructions.starters,
  questions: m.questions.map((q) => ({ ...q, ...(q.prefill ? { prefill: q.prefill.map((p) => [p.pattern, p.value]) } : {}),
    ...(q.choices ? { choices: q.choices.map(({ enables, core, requires, adds, ...c }) => ({ ...c, caps: [...(enables || []), ...(core || [])], ...(requires ? { reqs: reqTuples(requires) } : {}), ...(adds ? { adds: [adds.integration, adds.preset] } : {}) })) } : {}) })),
});
const ordered = () => { const all = catalog.latestAll(), rank = (id) => (ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length); return all.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id)); };
export const INTEGRATIONS = ordered().map(entryOf);

const BY_ID = new Map(INTEGRATIONS.map((i) => [i.id, i]));
const rx = (src) => new RegExp(`(^|[^a-z0-9])(${src})(?=$|[^a-z0-9])`, "i");

// Checked once against the console's catalogues: a registry entry naming an unknown capability or
// requirement is a bug, and the console refuses to start rather than offer it.
export function checkRegistry(CAPABILITIES, RESOURCES) {
  catalog.check(CAPABILITIES, RESOURCES);
  for (const i of INTEGRATIONS) {
    const choices = (i.questions || []).flatMap((q) => q.choices || []);
    for (const c of [...(i.caps || []), ...choices.flatMap((ch) => ch.caps || [])]) if (!CAPABILITIES[c]) throw new Error(`integration ${i.id}: unknown capability ${c}`);
    for (const [r, a] of [...(i.reqs || []), ...choices.flatMap((ch) => ch.reqs || [])]) if (!RESOURCES[r]?.access[a]) throw new Error(`integration ${i.id}: unknown requirement ${r} ${a}`);
    for (const ch of choices) if (ch.adds && !BY_ID.get(ch.adds[0])?.connector) throw new Error(`integration ${i.id}: ${ch.id} adds ${ch.adds[0]}, which has no connector`);
  }
}

// What the page needs to show the registry: never functions or detection patterns.
export const publicRegistry = () => INTEGRATIONS.map((i) => ({ id: i.id, version: i.version, status: i.status, label: i.label, connector: i.connector, summary: i.summary || "", why: i.why || "",
  questions: (i.questions || []).map(({ prefill, ...q }) => ({ ...q, choices: q.choices?.map(({ id, label, help, unsupported, adds }) => ({ id, label, ...(help ? { help } : {}), ...(unsupported ? { unsupported } : {}), ...(adds ? { via: BY_ID.get(adds[0]).label } : {}) })) })) }));

// The integrations a description names, in registry order. A more specific one can absorb a generic
// match it already covers (WordPress asks itself whether to read the site in a browser).
export const detect = (text) => {
  const hit = INTEGRATIONS.filter((i) => i.detect.some((d) => rx(d).test(String(text || ""))));
  const absorbed = new Set(hit.flatMap((i) => i.absorbs || []));
  return hit.filter((i) => !absorbed.has(i.id)).map((i) => i.id);
};

class DraftError extends Error { constructor(m) { super(m); this.status = 400; } }
const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const shown = (q, a) => !q.when || [].concat(a[q.when.q] ?? []).some((v) => q.when.is.includes(v));

// A draft from a request: { description, integrations?, answers?, others? }. Integrations default to
// what the description names. Everything is validated; capability lists sent by the page are never
// read. Returns the composed definition parts and what the page shows around them.
export function compose(req = {}) {
  const description = clip(req.description, 2000);
  if (!description) throw new DraftError("Describe what the worker should do.");
  const asked = req.integrations == null ? detect(description) : req.integrations;
  if (!Array.isArray(asked) || asked.length > 12) throw new DraftError("Integrations must be a list.");
  for (const id of asked) if (!BY_ID.has(id)) throw new DraftError(`"${id}" isn't an integration this platform knows. Name it under "Something else".`);
  const answersIn = req.answers && typeof req.answers === "object" && !Array.isArray(req.answers) ? req.answers : {};
  for (const [iid, a] of Object.entries(answersIn)) {
    const i = BY_ID.get(iid); if (!i) throw new DraftError(`"${iid}" isn't an integration this platform knows.`);
    if (!a || typeof a !== "object" || Array.isArray(a)) throw new DraftError(`Answers for ${i.label} must be an object.`);
    for (const qid of Object.keys(a)) if (!i.questions.some((q) => q.id === qid && q.type !== "info")) throw new DraftError(`"${qid}" isn't a question for ${i.label}.`);
  }
  const others = (Array.isArray(req.others) ? req.others : []).map((s) => clip(s, 60)).filter(Boolean).slice(0, 5);

  const order = [...new Set(asked)], addedBy = {}, presets = {};
  const out = { caps: new Set(), reqs: [], steps: [], know: [], limits: [], approvals: [], unsupported: [], pending: [], starters: [] };
  const answers = {};
  const addReq = ([resource, access, need]) => { const k = out.reqs.find((r) => r.resource === resource && r.access === access); if (!k) out.reqs.push({ resource, access, need }); else if (need === "required") k.need = "required"; };
  for (let n = 0; n < order.length; n++) {
    const i = BY_ID.get(order[n]), given = answersIn[i.id] || {}, a = (answers[i.id] = {});
    if (!i.connector) out.unsupported.push({ id: i.id, label: i.label, why: i.why });
    (i.caps || []).forEach((c) => out.caps.add(c)); (i.reqs || []).forEach(addReq);
    out.steps.push(...(i.steps || [])); out.limits.push(...(i.limits || [])); out.starters.push(...(i.starters || []));
    for (const q of i.questions) {
      if (q.type === "info") continue;
      // A preset from the integration that brought this one in (a Shopify products CSV is editable).
      const fallback = presets[i.id]?.[q.id] ?? (q.type === "text" ? (q.prefill || []).find(([re]) => rx(re).test(description))?.[1] ?? "" : q.default);
      const v = given[q.id] !== undefined ? given[q.id] : fallback;
      if (!shown(q, a)) continue;
      if (q.type === "text") { a[q.id] = clip(v, 300); if (a[q.id] && q.knowledge) out.know.push(`${q.knowledge}: ${a[q.id]}`); continue; }
      const ids = q.type === "multi" ? (v == null ? [] : v) : v == null ? [] : [v];
      if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) throw new DraftError(`Answer "${q.label}" with ${q.type === "multi" ? "a list of choices" : "one choice"}.`);
      if (q.type === "choice" && ids.length > 1) throw new DraftError(`Choose one answer for "${q.label}".`);
      for (const x of ids) if (!q.choices.some((c) => c.id === x)) throw new DraftError(`"${x}" isn't a choice for "${q.label}".`);
      a[q.id] = q.type === "multi" ? [...new Set(ids)] : ids[0] ?? null;
      if (!ids.length) { if (q.required) out.pending.push({ integration: i.id, question: q.id, label: `${i.label}: ${q.label}` }); continue; }
      for (const c of q.choices.filter((c) => ids.includes(c.id))) {
        (c.caps || []).forEach((x) => out.caps.add(x)); (c.reqs || []).forEach(addReq);
        out.limits.push(...(c.limits || [])); if (c.approval) out.approvals.push(`${i.label}: ${c.approval}`);
        if (c.know) out.know.push(c.know);
        if (c.unsupported) out.unsupported.push({ id: `${i.id}.${c.id}`, label: `${i.label}: ${c.label}`, why: c.unsupported });
        if (c.adds) { const [to, preset] = c.adds; presets[to] = { ...preset, ...presets[to] }; if (!order.includes(to)) { order.push(to); addedBy[to] = i.label; } }
      }
    }
  }
  for (const o of others) out.unsupported.push({ id: `other:${o}`, label: o, why: `There's no ${o} connector: a worker can't sign in to it or use it.` });
  const supported = order.filter((id) => BY_ID.get(id).connector);
  const first = BY_ID.get(supported[0]), asked0 = BY_ID.get(order[0]);
  // Named after what was asked for: a Shopify request is a "Shopify worker", even though today it
  // works through files and code.
  const name = !first ? "" : !asked0.connector ? `${asked0.label} worker` : supported.length === 1 ? first.name(answers[first.id] || {}) : `${first.short} and ${BY_ID.get(supported[1]).short} worker`;
  const via = order.filter((id) => !BY_ID.get(id).connector && !id.includes(".")).map((id) => BY_ID.get(id).label);
  const workspace = supported.some((id) => BY_ID.get(id).workspace === "project") ? "project" : "any";
  return {
    description, integrations: order, addedBy, answers, others, supported, workspace,
    pending: out.pending, unsupported: out.unsupported, approvals: out.approvals,
    nothingSupported: !supported.length,
    definition: {
      name,
      specialization: `${via.length ? `${via.join(", ")}, through: ` : ""}${supported.map((id) => BY_ID.get(id).specialization(answers[id] || {})).join("; ")}`,
      mission: description,
      capabilities: [...out.caps], requirements: out.reqs,
      workflow: ["Understand the request and what done means; ask one precise question if something essential is missing",
        "Check access to what the task needs; if something is missing, write NEEDS and stop", ...out.steps,
        "Check the result with the tools available", "Report what changed, what was checked, and what is left for the person"],
      knowledge: [`Set up from this request: "${description}"`, ...out.know, ...out.unsupported.map((u) => `Not possible here: ${u.label}. ${u.why}`)].join("\n"),
      limitations: [...new Set([...out.limits, "Never put secrets or credentials into files, logs or memory.", "Never say something was done or checked unless a tool result shows it."])],
      onMissing: "Say what is missing and exactly what the person has to do, in one or two plain sentences, then write NEEDS and stop.",
    },
    starters: [description, ...new Set(out.starters)].slice(0, 4),
  };
}

// ---- recommendations (deterministic) ----
// For a request (and the integrations a worker already has): the integrations it names are required;
// an integration's declared relations add others only when their patterns appear in the request
// (Builder.io for a Shopify worker only when it mentions a headless storefront, content pages…), each
// with its reasons. Nothing is added by itself: the person adds what they choose, and adding an
// integration never connects an account or grants access.
const RANK = { required: 0, suggested: 1, optional: 2 };
export function recommend(text, current = []) {
  const t = String(text || ""), have = new Set(current), out = new Map();
  const add = (id, kind, reason) => {
    const m = catalog.latest(id); if (!m) return;
    const r = out.get(id);
    if (!r) out.set(id, { id, version: m.version, label: m.label, status: m.status, connector: m.status !== "recognised", kind, added: have.has(id), reasons: [reason], summary: m.summary || "", ...(m.why ? { why: m.why } : {}) });
    else { if (RANK[kind] < RANK[r.kind]) r.kind = kind; if (!r.reasons.some((x) => x.text === reason.text)) r.reasons.push(reason); }
  };
  for (const id of detect(t)) { const i = BY_ID.get(id), hit = i.detect.map((d) => rx(d).exec(t)).find(Boolean); add(id, "required", { source: "request", text: `Your description mentions “${hit?.[2] || i.label}”.` }); }
  for (const id of [...new Set([...have, ...out.keys()])]) {
    const m = catalog.latest(id); if (!m) continue;
    for (const r of m.relations) {
      const hit = r.when?.length ? r.when.map((p) => rx(p).exec(t)).find(Boolean) : null;
      if (r.when?.length && !hit) continue;
      add(r.to, r.kind === "requires" ? "required" : r.kind, { source: "relation", from: id, text: `${m.label}: ${r.why}${hit ? ` (you mention “${hit[2]}”)` : ""}` });
    }
  }
  return [...out.values()].sort((a, b) => RANK[a.kind] - RANK[b.kind] || Number(b.connector) - Number(a.connector) || a.label.localeCompare(b.label));
}
// A manifest as the page shows it (never detection or prefill patterns).
export const publicManifest = (m, labels = {}) => ({ id: m.id, version: m.version, versions: catalog.versions(m.id), label: m.label, short: m.short || m.label, summary: m.summary || "", status: m.status, connector: m.status !== "recognised",
  why: m.why || "", workspace: m.workspace, owner: m.owner, review: m.review, tests: m.tests, coreWhy: m.coreWhy || {}, relations: m.relations.map(({ to, kind, why }) => ({ to, kind, why })), changes: m.changes || {},
  capabilities: m.capabilities.map((c) => ({ id: c.id, label: labels.capabilities?.[c.id] || c.id, accounts: c.accounts.map((a) => ({ ...a, label: labels.resources?.[`${a.resource}:${a.access}`] || `${a.resource} ${a.access}` })) })),
  base: m.base, instructions: m.instructions, questions: m.questions.map(({ prefill, ...q }) => ({ ...q, choices: q.choices?.map((c) => ({ ...c, ...(c.adds ? { via: catalog.latest(c.adds.integration)?.label || c.adds.integration } : {}) })) })) });
