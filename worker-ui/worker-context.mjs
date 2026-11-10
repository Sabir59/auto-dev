// A worker's own context (schema 2, field `context`): what it knows, the procedures it follows, and
// what it refers to — each item with an identity, a source and when it last changed, so the person can
// see where every piece of what the worker is told comes from, change it, and take it with the worker.
//
//   context: {
//     knowledge:  [{ id, title, text, source, updatedAt }]                 entries, given to every run
//     skills:     [{ id, name, description, instructions, source, updatedAt }]  named procedures
//     references: [{ id, kind, title, value, note, doc?, source, updatedAt }]
//        kind: link        a URL (the worker opens it only with a tool it has)
//              repository  a repository and branch it works on (a reference, not access: access is
//                          the worker's repository grants and the workspace it runs in)
//              document    a file stored with the worker (doc: { file, name, mime, size, sha }),
//                          copied read-only into each run
//              note        a short pointer (a Figma link, a path, a ticket…)
//   }
// source: { kind: "owner" | "assistant" | "package" | "migration", run?, from? }
//
// The worker's general knowledge text (`knowledge`), its steps (`workflow`), hard limits and the rest
// stay where they are: this adds to them, it doesn't move them.
import { createHash, randomUUID } from "node:crypto";
import { SECRET } from "./workerpack.mjs";

export const LIMITS = { knowledge: 40, knowledgeText: 8000, skills: 20, skillText: 6000, references: 40, documents: 10, documentBytes: 512 * 1024 };
export const KINDS = ["link", "repository", "document", "note"];
const clip = (v, n) => String(v ?? "").trim().slice(0, n);
const ID = /^[a-z0-9][a-z0-9-]{1,40}$/;
const newId = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`;
export const empty = () => ({ knowledge: [], skills: [], references: [] });
export const isEmpty = (c) => !c || (!c.knowledge?.length && !c.skills?.length && !c.references?.length);
const fail = (m) => { throw Object.assign(new Error(m), { status: 400 }); };
const source = (s, fallback) => {
  const kind = ["owner", "assistant", "package", "migration", "clone"].includes(s?.kind) ? s.kind : fallback.kind;
  return { kind, ...(s?.run && /^[\w-]+$/.test(s.run) ? { run: String(s.run) } : {}), ...(s?.from ? { from: clip(s.from, 120) } : {}) };
};
// A document's stored name: content-addressed, so the same bytes are stored once and history can
// point at them forever.
export const docFile = (sha, name) => `${sha.slice(0, 16)}-${String(name).replace(/[^\w.-]+/g, "_").slice(0, 80) || "document"}`; // also a safe package entry name
export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// The stored form from what the page, the assistant or a package sends. docExists(file): whether a
// document is stored for this worker (a reference to one that isn't is refused). Text that looks like
// a credential is refused: context travels with the worker.
export function normalize(input, { docExists = () => true, defaultSource = { kind: "owner" } } = {}) {
  const c = input && typeof input === "object" ? input : {};
  const now = new Date().toISOString(), seen = new Set();
  const uid = (v, p) => { let id = ID.test(String(v || "")) ? String(v) : newId(p); while (seen.has(id)) id = newId(p); seen.add(id); return id; };
  const knowledge = (Array.isArray(c.knowledge) ? c.knowledge : []).map((k) => {
    const title = clip(k?.title, 120), text = clip(k?.text, LIMITS.knowledgeText);
    if (!title) fail("Every knowledge entry needs a title.");
    if (!text) fail(`The knowledge entry “${title}” is empty.`);
    return { id: uid(k.id, "k"), title, text, source: source(k.source, defaultSource), updatedAt: clip(k.updatedAt, 40) || now };
  });
  if (knowledge.length > LIMITS.knowledge) fail(`At most ${LIMITS.knowledge} knowledge entries.`);
  const skills = (Array.isArray(c.skills) ? c.skills : []).map((s) => {
    const name = clip(s?.name, 80), instructions = clip(s?.instructions, LIMITS.skillText);
    if (!name) fail("Every skill needs a name.");
    if (!instructions) fail(`The skill “${name}” has no instructions.`);
    return { id: uid(s.id, "s"), name, description: clip(s?.description, 300), instructions, source: source(s.source, defaultSource), updatedAt: clip(s.updatedAt, 40) || now };
  });
  if (skills.length > LIMITS.skills) fail(`At most ${LIMITS.skills} skills.`);
  if (new Set(skills.map((s) => s.name.toLowerCase())).size !== skills.length) fail("Two skills have the same name.");
  const references = (Array.isArray(c.references) ? c.references : []).map((r) => {
    const kind = KINDS.includes(r?.kind) ? r.kind : fail(`A reference's kind must be one of: ${KINDS.join(", ")}.`);
    const title = clip(r?.title, 120) || clip(r?.value, 120) || clip(r?.doc?.name, 120);
    const out = { id: uid(r.id, "r"), kind, title, value: clip(r?.value, 600), note: clip(r?.note, 600), source: source(r.source, defaultSource), updatedAt: clip(r.updatedAt, 40) || now };
    if (kind === "link" && !/^https?:\/\/[^\s]+$/i.test(out.value)) fail(`The link “${title}” isn't an http(s) address.`);
    if (kind === "repository" && !/^[\w.-]+\/[\w.-]+$/.test(out.value) && !/^https?:\/\/[^\s]+$/i.test(out.value)) fail(`The repository reference “${title}” must be owner/name or a URL.`);
    if (kind === "repository") out.branch = clip(r?.branch, 120);
    if (kind === "document") {
      const d = r?.doc || {};
      if (!/^[a-f0-9]{16}-[\w.\- ]{1,80}$/.test(String(d.file || "")) || !docExists(d.file)) fail(`The document “${title}” isn't stored with this worker.`);
      out.doc = { file: String(d.file), name: clip(d.name, 120) || String(d.file).slice(17), mime: clip(d.mime, 80), size: Number(d.size) || 0, sha: /^[a-f0-9]{64}$/.test(String(d.sha || "")) ? d.sha : "" };
    } else if (!out.value) fail(`The reference “${title}” has no ${kind === "note" ? "text" : "address"}.`);
    return out;
  });
  if (references.length > LIMITS.references) fail(`At most ${LIMITS.references} references.`);
  if (references.filter((r) => r.kind === "document").length > LIMITS.documents) fail(`At most ${LIMITS.documents} documents per worker.`);
  const out = { knowledge, skills, references };
  if (SECRET.test(JSON.stringify(out))) fail("Some of this text looks like a password, key or token. Credentials never go into a worker: connect the account on its page instead.");
  return out;
}

// What a run is told, after the worker's own text. docsDir: where this run's copies of its documents
// are (read-only); canRead: whether it has a file tool to read them.
export function contextSections(c, { docsDir = null, canRead = false } = {}) {
  if (isEmpty(c)) return [];
  const out = [];
  if (c.knowledge.length) out.push("## Knowledge entries (from your owner's context)\n" + c.knowledge.map((k) => `### ${k.title}\n${k.text}`).join("\n\n") + "\n");
  if (c.skills.length) out.push("## Skills\nNamed procedures. When a task matches a skill's description, follow that skill's instructions, and say which skill you used.\n\n"
    + c.skills.map((s) => `### Skill: ${s.name}\n${s.description ? `When to use: ${s.description}\n` : ""}${s.instructions}`).join("\n\n") + "\n");
  const refs = c.references.filter((r) => r.kind !== "document"), docs = c.references.filter((r) => r.kind === "document");
  if (refs.length) out.push("## References\nWhat you work on and refer to. A reference is not access: you reach a link or repository only with a tool you have, and only as far as your access allows.\n"
    + refs.map((r) => `- ${r.kind === "repository" ? "Repository" : r.kind === "link" ? "Link" : "Note"}: ${r.title}${r.value && r.value !== r.title ? ` — ${r.value}` : ""}${r.branch ? ` (branch ${r.branch})` : ""}${r.note ? `. ${r.note}` : ""}`).join("\n") + "\n");
  if (docs.length) out.push("## Reference documents\n" + (docsDir && canRead
    ? `Read-only copies for this task, in ${docsDir}. Read the one a task needs; don't copy them into the workspace unless asked.\n` + docs.map((r) => `- ${r.title}: ${docsDir.replace(/\\/g, "/")}/${r.doc.file}${r.note ? ` (${r.note})` : ""}`).join("\n")
    : "Your owner gave you these documents, but you have no file-reading tool in this run, so you can't open them. If a task needs one, say so with a NEEDS: line.\n" + docs.map((r) => `- ${r.title}`).join("\n")) + "\n");
  return out;
}

// A short, human description of how one context differs from another (for version notes).
export function describeChange(a = empty(), b = empty()) {
  const parts = [];
  for (const [key, label, name] of [["knowledge", "knowledge entry", (x) => x.title], ["skills", "skill", (x) => x.name], ["references", "reference", (x) => x.title]]) {
    const before = new Map((a[key] || []).map((x) => [x.id, x])), after = new Map((b[key] || []).map((x) => [x.id, x]));
    for (const [id, x] of after) if (!before.has(id)) parts.push(`added ${label} “${name(x)}”`); else if (JSON.stringify({ ...before.get(id), updatedAt: 0, source: 0 }) !== JSON.stringify({ ...x, updatedAt: 0, source: 0 })) parts.push(`changed ${label} “${name(x)}”`);
    for (const [id, x] of before) if (!after.has(id)) parts.push(`removed ${label} “${name(x)}”`);
  }
  return parts;
}
