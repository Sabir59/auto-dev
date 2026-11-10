// One way to change a worker's definition in steps the person can follow, used by the worker's
// assistant and by the person's own edits on the worker's page. A change is a set of operations; the
// result is a candidate stored definition plus, for each part, whether it may be applied at once or
// waits for the person's approval.
//
//   identity:     { name?, specialization?, mission?, outcomes? }              low risk
//   instructions: { workflow?, onMissing?, knowledge? }                       low risk; removing more
//                                                                              than half of the steps or
//                                                                              the knowledge needs approval
//   limits:       { add?: [text], remove?: [text] }                          add: low; remove: approval
//   knowledge:    { add?: [{title,text}], update?: [{id,…}], remove?: [id] }  add/update: low; remove: approval
//   skills:       { add?: [{name,description,instructions}], update?, remove? }   the same
//   references:   { add?: [{kind,title,value,branch?,note?}], update?, remove? }  the same
//   access:       { core?: [ids], repos?: [{repo,level}], integrations?: [{id,version,config}] }
//                                                                              always needs approval
//
// The candidate is checked by the console exactly as an edit in the worker's editor is
// (normalizeWorker): a change can't give the worker anything the editor wouldn't accept. Credentials
// are never part of a definition: text that looks like one is refused here and again in the context.
import { SECRET } from "./workerpack.mjs";
import * as wctx from "./worker-context.mjs";

const AREAS = ["identity", "instructions", "limits", "knowledge", "skills", "references", "access"];
const clip = (v, n) => String(v ?? "").trim().slice(0, n);
const listOf = (v) => (Array.isArray(v) ? v : String(v ?? "").split(/\r?\n/)).map((x) => String(x ?? "").trim()).filter(Boolean);
const fail = (m) => { throw Object.assign(new Error(m), { status: 400 }); };

// stored: the worker's stored definition (schema 2). by: "assistant" | "owner"; run: the run it came from.
// Returns { next, low: [what], approval: [what and why], summary: [line] }.
export function plan(stored, change, { by = "owner", run = null } = {}) {
  if (!change || typeof change !== "object" || Array.isArray(change)) fail("A change is an object of areas: " + AREAS.join(", ") + ".");
  const unknown = Object.keys(change).filter((k) => !AREAS.includes(k));
  if (unknown.length) fail(`Unknown part of a change: ${unknown.join(", ")}. A change can have: ${AREAS.join(", ")}. Credentials and connections are never changed here: the person connects accounts on their page.`);
  if (SECRET.test(JSON.stringify(change))) fail("Part of this change looks like a password, key or token. Credentials never go into a worker's definition: the person connects the account on its page instead.");
  const next = structuredClone(stored), low = [], approval = [], src = { kind: by, ...(run ? { run } : {}) }, now = new Date().toISOString();
  next.context = structuredClone(stored.context || wctx.empty());
  const ctxBefore = structuredClone(next.context);

  const id = change.identity;
  if (id) {
    for (const [k, n] of [["name", 60], ["specialization", 200], ["mission", 600]]) if (id[k] !== undefined) { const v = clip(id[k], n); if (k === "name" && !v) fail("A worker needs a name."); if (v !== (stored[k] || "")) { next[k] = v; low.push(`${k === "name" ? "Name" : k === "mission" ? "Purpose (mission)" : "Specialization"} changed`); } }
    if (id.outcomes !== undefined) { next.outcomes = listOf(id.outcomes).slice(0, 10).map((x) => x.slice(0, 200)); low.push("Objectives changed"); }
  }
  const ins = change.instructions;
  if (ins) {
    if (ins.workflow !== undefined) {
      const steps = listOf(ins.workflow).slice(0, 30).map((x) => x.slice(0, 600)), had = stored.workflow || [];
      next.workflow = steps;
      (had.length && steps.length < had.length / 2 ? approval : low).push(had.length && steps.length < had.length / 2 ? `Working steps: removes more than half of them (${had.length} → ${steps.length})` : "Working steps changed");
    }
    if (ins.onMissing !== undefined) { next.onMissing = clip(ins.onMissing, 1000); low.push("“When something is missing” changed"); }
    if (ins.knowledge !== undefined) {
      const t = clip(ins.knowledge, 20000), had = stored.knowledge || "";
      next.knowledge = t;
      (had.length > 200 && t.length < had.length / 2 ? approval : low).push(had.length > 200 && t.length < had.length / 2 ? "General knowledge: removes more than half of it" : "General knowledge changed");
    }
  }
  const lim = change.limits;
  if (lim) {
    const cur = [...(stored.limitations || [])];
    for (const t of listOf(lim.remove)) { const i = cur.indexOf(t); if (i < 0) fail(`There's no hard limit “${t.slice(0, 80)}”. Use the exact text from the current configuration.`); cur.splice(i, 1); approval.push(`Removes a hard limit: “${t.slice(0, 160)}”`); }
    for (const t of listOf(lim.add).map((x) => x.slice(0, 300))) if (!cur.includes(t)) { cur.push(t); low.push(`Adds a hard limit: “${t.slice(0, 160)}”`); }
    if (cur.length > 30) fail("At most 30 hard limits.");
    next.limitations = cur;
  }
  const ops = (key, label, nameOf, fields) => {
    const o = change[key]; if (!o) return;
    const list = next.context[key];
    for (const rid of listOf(o.remove)) { const i = list.findIndex((x) => x.id === rid); if (i < 0) fail(`There's no ${label} with id “${rid}”.`); approval.push(`Removes ${label} “${nameOf(list[i])}”`); list.splice(i, 1); }
    for (const u of Array.isArray(o.update) ? o.update : []) {
      const x = list.find((y) => y.id === u?.id); if (!x) fail(`There's no ${label} with id “${u?.id}”.`);
      for (const f of fields) if (u[f] !== undefined) x[f] = u[f];
      x.updatedAt = now; x.source = { ...src }; low.push(`Changes ${label} “${nameOf(x)}”`);
    }
    for (const a of Array.isArray(o.add) ? o.add : []) {
      if (key === "references" && a?.kind === "document") fail("A document is added from a file (worker_add_document), not as text.");
      const item = { ...Object.fromEntries(fields.map((f) => [f, a?.[f]])), ...(key === "references" ? { kind: a?.kind } : {}), source: { ...src }, updatedAt: now };
      list.push(item); low.push(`Adds ${label} “${nameOf(item) || "(untitled)"}”`);
    }
  };
  ops("knowledge", "knowledge entry", (x) => x.title, ["title", "text"]);
  ops("skills", "skill", (x) => x.name, ["name", "description", "instructions"]);
  ops("references", "reference", (x) => x.title || x.value, ["title", "value", "branch", "note"]);
  const acc = change.access;
  if (acc) {
    if (acc.core !== undefined) { next.core = listOf(acc.core); approval.push(`Core tools: ${next.core.join(", ") || "none"} (was ${(stored.core || []).join(", ") || "none"})`); }
    if (acc.repos !== undefined) { next.repos = (Array.isArray(acc.repos) ? acc.repos : []).map((g) => ({ repo: String(g?.repo || ""), level: String(g?.level || "") })); approval.push(`Repository access: ${next.repos.map((g) => `${g.repo} ${g.level}`).join(", ") || "none"}`); }
    if (acc.integrations !== undefined) { next.integrations = (Array.isArray(acc.integrations) ? acc.integrations : []).map((r) => ({ id: String(r?.id || ""), version: String(r?.version || ""), config: r?.config && typeof r.config === "object" ? r.config : {} })); approval.push(`Integrations: ${next.integrations.map((r) => `${r.id} ${r.version}`).join(", ") || "none"}`); }
  }
  next.context = wctx.normalize(next.context, { defaultSource: src });
  if (wctx.isEmpty(next.context) && wctx.isEmpty(stored.context)) delete next.context;
  if (!low.length && !approval.length) fail("Nothing changes: say what to change.");
  return { next, low, approval, summary: [...low, ...approval], contextChanges: wctx.describeChange(ctxBefore, next.context || wctx.empty()) };
}
