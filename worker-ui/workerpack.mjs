// Worker packages (.workerpack): a worker's portable definition in one file, for cloning it here or
// giving it to someone else. Cloning and importing use the same format and the same checks.
//
// The package is a ZIP archive with exactly these files (an allowlist: anything else is refused):
//   manifest.json            format, version, package id, and a sha256 + size for every other file
//   worker.json              the portable definition. Format 2 (schema 2): identity, its integrations
//                            pinned (id, exact version, settings), its core capabilities, its own
//                            steps, limits and how it asks, its starter tasks. Format 1 (schema 1, a
//                            worker made before integrations): its flat tools and requirements.
//   dependencies.json        what it needs where it's installed: tools, accounts, repositories, workflows
//   knowledge/knowledge.md   what it knows (its knowledge text)
//   workflows/gitflow.json   (optional) its Git workflow rules: teams, branch patterns, relationships,
//                            exclusion and branch rules. Never people, overrides, a repository, audit or plans.
//
// Never in a package: credentials of any kind, memory, runs, logs, checkpoints, Team membership, the
// worker's id, version or dates, repository grants (only what repositories it would need), the
// machine's paths. Text that looks like a credential stops the export; paths on this computer are
// replaced, and the preview says so.
//
// Reading a package treats everything in it as untrusted: sizes, names, entries and checksums are
// checked before anything is parsed, nothing in it is run, and what it asks for is decided again by
// the console that installs it (its catalogues, its workspaces, its accounts, its policies).
import zlib from "node:zlib";
import { createHash, randomUUID } from "node:crypto";

// Format 2: workers with pinned integrations (schema 2). Format 1 (schema 1) is still read and written for workers made before integrations.
export const FORMAT = "ai-workforce.workerpack", FORMAT_VERSION = 2, SCHEMA = 2;
export const LIMITS = { package: 2 * 1024 * 1024, file: 512 * 1024, total: 2 * 1024 * 1024, entries: 16, ratio: 200 };
const FILES = ["manifest.json", "worker.json", "dependencies.json", "knowledge/knowledge.md", "workflows/gitflow.json"];
const REQUIRED = ["manifest.json", "worker.json", "dependencies.json", "knowledge/knowledge.md"];

// ---- text that must not leave this computer ----
// Credentials: a match stops the export (it can't be cut out reliably, and it's the person's to remove).
export const SECRET = /(figd_[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(ant-)?[A-Za-z0-9_-]{16,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|\b(password|passwd|api[_-]?key|secret|access[_-]?token|auth[_-]?token|bearer)\b\s*[:=]\s*\S{6,})/i;
// Paths on this computer (a user's folders, absolute drive paths, UNC shares): replaced with a marker.
const PATHS = /([A-Za-z]:\\[^\s"'`<>|]*|\\\\[^\s"'`<>|]+|\/(?:Users|home|root|var|opt|private|mnt)\/[^\s"'`<>|]*)/g;
export const PATH_MARK = "<path on the source computer>";
const redact = (s, found) => String(s).replace(PATHS, (m) => { found.push(m); return PATH_MARK; });
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const clip = (v, n) => String(v ?? "").slice(0, n);
const strs = (v, max, len) => (Array.isArray(v) ? v : []).map((x) => clip(x, len).trim()).filter(Boolean).slice(0, max);

// ---- ZIP (stored or deflated; no ZIP64, no encryption, one disk) ----
const DOS = (() => { const d = new Date(); return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() }; })();
export function zip(files) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"), packed = zlib.deflateRawSync(data), n = Buffer.from(name, "utf8"), crc = zlib.crc32(data);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8); h.writeUInt16LE(DOS.time, 10); h.writeUInt16LE(DOS.date, 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(packed.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26); h.writeUInt16LE(0, 28);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10); c.writeUInt16LE(DOS.time, 12); c.writeUInt16LE(DOS.date, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(packed.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    locals.push(h, n, packed); centrals.push(c, n); offset += 30 + n.length + packed.length;
  }
  const cd = Buffer.concat(centrals), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, e]);
}
// A name inside a package: a relative path of plain parts. Anything else (absolute, a drive, a
// backslash, "..", "." or empty parts, control or odd characters) is refused before it's used.
export function safeName(name) {
  if (typeof name !== "string" || !name || name.length > 200) return false;
  if (/^[\\/]|^[A-Za-z]:|\\|\0/.test(name)) return false;
  const parts = name.split("/");
  return parts.length <= 4 && parts.every((p) => p && p !== "." && p !== ".." && /^[A-Za-z0-9._-]+$/.test(p));
}
const bad = (code, message) => Object.assign(new Error(message), { code });
export function unzip(buf, limits = LIMITS) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw bad("malformed", "This isn't a worker package (not a ZIP archive).");
  if (buf.length > limits.package) throw bad("too-large", `The package is larger than ${Math.round(limits.package / 1024)} KB.`);
  let e = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw bad("malformed", "This isn't a worker package (no ZIP directory found).");
  const count = buf.readUInt16LE(e + 10), cdSize = buf.readUInt32LE(e + 12), cdOff = buf.readUInt32LE(e + 16);
  if (buf.readUInt16LE(e + 4) || buf.readUInt16LE(e + 6) || count !== buf.readUInt16LE(e + 8)) throw bad("malformed", "Multi-part archives aren't supported.");
  if (count === 0xffff || cdOff === 0xffffffff) throw bad("unsupported", "ZIP64 archives aren't supported.");
  if (count > limits.entries) throw bad("too-many", `The package has ${count} entries; at most ${limits.entries} are allowed.`);
  if (cdOff + cdSize > e) throw bad("malformed", "The package's directory is damaged.");
  const out = new Map(); let total = 0, p = cdOff;
  for (let k = 0; k < count; k++) {
    if (p + 46 > e || buf.readUInt32LE(p) !== 0x02014b50) throw bad("malformed", "The package's directory is damaged.");
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), attrs = buf.readUInt32LE(p + 38), lho = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nl); p += 46 + nl + xl + cl;
    if (!safeName(name)) throw bad("unsafe-path", `Refused an unsafe file name in the package: "${name.slice(0, 80)}".`);
    if (flags & 1) throw bad("unsupported", "Encrypted packages aren't supported.");
    if (method !== 0 && method !== 8) throw bad("unsupported", `"${name}" uses a compression method that isn't supported.`);
    const type = (attrs >>> 16) & 0o170000; if (type === 0o120000) throw bad("unsafe-path", `"${name}" is a link; links aren't allowed in a package.`);
    if (out.has(name) || [...out.keys()].some((x) => x.toLowerCase() === name.toLowerCase())) throw bad("malformed", `"${name}" appears twice in the package.`);
    if (usize > limits.file) throw bad("too-large", `"${name}" is larger than ${Math.round(limits.file / 1024)} KB.`);
    if ((total += usize) > limits.total) throw bad("too-large", `The package unpacks to more than ${Math.round(limits.total / 1024)} KB.`);
    if (csize && usize / csize > limits.ratio) throw bad("too-large", `"${name}" is compressed too much to be safe to unpack.`);
    if (lho + 30 > cdOff || buf.readUInt32LE(lho) !== 0x04034b50) throw bad("malformed", `"${name}" is damaged.`);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    if (start + csize > cdOff) throw bad("malformed", `"${name}" is damaged.`);
    const raw = buf.subarray(start, start + csize);
    let data; try { data = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw, { maxOutputLength: usize + 1 }); } catch { throw bad("malformed", `"${name}" can't be unpacked (it's damaged or larger than it says).`); }
    if (data.length !== usize) throw bad("malformed", `"${name}" isn't the size it says.`);
    if (zlib.crc32(data) !== crc) throw bad("checksum", `"${name}" is damaged (its CRC doesn't match).`);
    out.set(name, data);
  }
  return out;
}

// ---- building a package from a worker on this console ----
// worker: a definition from workers.json (resolved); gitflow: its Git workflow settings (or null);
// repoName(id): the full name of a registered repository; catalog: { capabilities, resources } labels;
// secretFields(id, version): an integration's settings never exported; integrationInfo(id, version):
// its label and status. Returns the files and a preview of what's in it, what isn't, and what was
// changed or stops it.
// Format 2 (a worker with pinned integrations, schema 2): its integration references (id, exact
// version, settings), explicit core capabilities and its own text. Format 1: a worker made before
// integrations, as it is (its flat tools and text).
export function buildPackage({ worker: w, local = false, gitflow = null, repoName = () => null, catalog = {}, generator = {}, secretFields = () => [], integrationInfo = () => null }) {
  const paths = [], secrets = [], withheld = [], v2 = w.schema === 2;
  const text = (field, v, n) => { const s = clip(v, n); if (SECRET.test(s)) secrets.push(field); return local ? s : redact(s, paths); };
  const list = (field, v, max, len) => strs(v, max, len).map((x) => text(field, x, len));
  const req = (r) => ({ resource: clip(r.resource, 40), access: clip(r.access, 40), need: r.need === "optional" ? "optional" : "required" });
  const fr = w.fromRequest || {};
  const request = { description: text("description", fr.description, 2000), integrations: strs(fr.integrations, 20, 40), workspaceKind: /^(project|scratch|any)$/.test(fr.workspace || "") ? fr.workspace : "",
    starters: list("starter tasks", fr.starters, 6, 400), unsupported: strs(fr.unsupported, 20, 120) };
  const settings = (r) => {
    const secret = new Set(secretFields(r.id, r.version) || []), out = {};
    for (const [k, v] of Object.entries(r.config || {})) {
      if (secret.has(k)) { withheld.push(`${r.id}: ${k}`); continue; }
      out[k] = typeof v === "string" ? text(`${r.id} settings`, v, 300) : Array.isArray(v) ? v.slice(0, 20).map((x) => clip(x, 60)) : v === null || typeof v === "boolean" || typeof v === "number" ? v : null;
    }
    return out;
  };
  const common = { name: text("name", w.name, 60), specialization: text("specialization", w.specialization, 200), mission: text("mission", w.mission, 600),
    workflow: list("workflow", w.workflow, 30, 600), limitations: list("limits", w.limitations, 30, 300), onMissing: text("when something is missing", w.onMissing, 1000), request };
  const def = v2
    ? { schema: 2, ...common, outcomes: list("outcomes", w.outcomes, 10, 200), integrations: (w.integrations || []).slice(0, 20).map((r) => ({ id: clip(r.id, 40), version: clip(r.version, 20), config: settings(r) })),
        core: strs(w.core, 10, 60), extraRequirements: (w.extraRequirements || []).slice(0, 20).map(req) }
    : { schema: 1, ...common, capabilities: strs(w.capabilities, 40, 60), requirements: (w.requirements || []).slice(0, 40).map(req) };
  const knowledge = text("knowledge", w.knowledge, 20000);
  const repos = (w.repos || []).map((g) => ({ fullName: repoName(g.repo), level: g.level })).filter((g) => g.fullName);
  let flow = null;
  if (gitflow && (w.capabilities || []).includes("gitflow.read")) {
    flow = { schema: 1, teams: (gitflow.teams || []).map((t) => ({ name: clip(t.name, 60), ours: !!t.ours, branchPatterns: strs(t.branchPatterns, 20, 80) })),
      mappings: (gitflow.mappings || []).map((m) => ({ source: m.source, destination: m.destination, kind: m.kind, strategy: m.strategy })),
      exclude: { ...gitflow.exclude }, shared: strs(gitflow.shared, 30, 120), forbidden: strs(gitflow.forbidden, 20, 120), tickets: strs(gitflow.tickets, 5, 60) };
    if (SECRET.test(JSON.stringify(flow))) secrets.push("Git workflow rules");
  }
  const capLabel = (id) => ({ id, label: catalog.capabilities?.[id] || id });
  const reqLabel = (r) => ({ ...req(r), label: catalog.resources?.[`${r.resource}:${r.access}`] || `${r.resource} ${r.access}` });
  // What it needs where it's installed. For format 2 its tools and requirements are what its
  // integrations give here; they're listed for the person reviewing it, and worked out again there.
  const deps = v2
    ? { integrations: def.integrations.map((r) => ({ id: r.id, version: r.version, ...(integrationInfo(r.id, r.version) || {}) })), core: def.core.map(capLabel), capabilities: strs(w.capabilities, 40, 60).map(capLabel),
        requirements: (w.requirements || []).map(reqLabel), repositories: repos, workflows: flow ? ["gitflow"] : [] }
    : { capabilities: def.capabilities.map(capLabel), requirements: def.requirements.map(reqLabel), repositories: repos, workflows: flow ? ["gitflow"] : [], integrations: request.integrations };
  const files = [["worker.json", JSON.stringify(def, null, 1)], ["dependencies.json", JSON.stringify(deps, null, 1)], ["knowledge/knowledge.md", knowledge]];
  if (flow) files.push(["workflows/gitflow.json", JSON.stringify(flow, null, 1)]);
  const formatVersion = v2 ? 2 : 1;
  const manifest = { format: FORMAT, formatVersion, packageId: randomUUID(), createdAt: new Date().toISOString(),
    generator: { name: clip(generator.name || "ai-workforce-console", 60), version: clip(generator.version || "", 40) }, worker: { name: def.name, schema: def.schema },
    files: Object.fromEntries(files.map(([n, c]) => { const b = Buffer.from(c, "utf8"); return [n, { sha256: sha256(b), size: b.length }]; })) };
  const excluded = ["credentials, tokens and connected accounts (yours stay here)", "its memory, conversations, run history and logs", "its id, version history and dates (the copy starts at version 1)",
    "Team membership", ...(w.repos?.length ? ["repository access grants (only which repositories it needs is included)"] : []), ...(withheld.length ? [`settings marked secret: ${withheld.join(", ")}`] : []),
    ...(gitflow ? ["Git workflow people, emails and ownership overrides, the repository location, audit trail, plans and notes", "proposal branches stay off until the person installing it turns them on"] : [])];
  return { files: [["manifest.json", JSON.stringify(manifest, null, 1)], ...files], manifest, definition: def, knowledge, dependencies: deps, gitflow: flow,
    preview: { format: formatVersion, included: files.map(([n]) => n), excluded, pathsRemoved: [...new Set(paths)], secrets: [...new Set(secrets)] } };
}
export const packBytes = (built) => zip(built.files);

// ---- reading a package (untrusted) ----
// Returns the package or throws an error with a code: malformed, unsupported, too-large, too-many,
// unsafe-path, checksum, incompatible. Formats 1 and 2 are both read as they are (a format-1 worker
// installs in the earlier form, and can be migrated there). MIGRATIONS converts older formats when
// one can't be read as it is: none yet.
const parseJson = (files, n) => { try { const v = JSON.parse(files.get(n).toString("utf8")); if (!v || typeof v !== "object" || Array.isArray(v)) throw 0; return v; } catch { throw bad("malformed", `${n} isn't valid JSON.`); } };
const MIGRATIONS = {};
const MIN_FORMAT = 1;
const IDV = /^[a-z][a-z0-9-]{1,39}$/, VER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, KEY = /^[a-zA-Z][a-zA-Z0-9]{0,39}$/;
const readReq = (x) => ({ resource: clip(x?.resource, 40), access: clip(x?.access, 40), need: x?.need === "optional" ? "optional" : "required" });
// An integration's settings from a package: plain values only (text, a choice, a list of choices).
const readSettings = (c) => (c && typeof c === "object" && !Array.isArray(c) ? Object.fromEntries(Object.entries(c).filter(([k]) => KEY.test(k)).slice(0, 30).map(([k, v]) => [k,
  typeof v === "string" ? v.slice(0, 300) : Array.isArray(v) ? v.slice(0, 20).map((x) => clip(x, 60)) : v === null || typeof v === "boolean" ? v : null])) : {});
export function readPackage(buf, limits = LIMITS) {
  const files = unzip(buf, limits);
  for (const n of files.keys()) if (!FILES.includes(n)) throw bad("unsupported", `The package contains "${n}", which isn't part of a worker package. Nothing was installed.`);
  for (const n of REQUIRED) if (!files.has(n)) throw bad("malformed", `The package is missing ${n}.`);
  const manifest = parseJson(files, "manifest.json");
  if (manifest.format !== FORMAT) throw bad("unsupported", "This isn't a worker package (unknown format).");
  let v = manifest.formatVersion;
  if (!Number.isInteger(v)) throw bad("malformed", "The package's format version is missing.");
  if (v > FORMAT_VERSION) throw bad("incompatible", `The package was made by a newer console (format ${v}; this console reads up to ${FORMAT_VERSION}). Update this console to install it.`);
  if (v < MIN_FORMAT) { const m = MIGRATIONS[v]; if (!m) throw bad("incompatible", `The package's format (${v}) is too old for this console and can't be converted.`); m(files, manifest); v = MIN_FORMAT; }
  // Every file the manifest lists, with its checksum; nothing it doesn't list.
  const listed = manifest.files && typeof manifest.files === "object" ? manifest.files : null;
  if (!listed) throw bad("malformed", "The package's manifest has no file list.");
  for (const n of files.keys()) if (n !== "manifest.json" && !listed[n]) throw bad("malformed", `${n} isn't listed in the manifest.`);
  for (const [n, f] of Object.entries(listed)) {
    if (!files.has(n)) throw bad("malformed", `The manifest lists ${n}, which isn't in the package.`);
    if (files.get(n).length !== f?.size || sha256(files.get(n)) !== f?.sha256) throw bad("checksum", `${n} doesn't match its checksum: the package was changed or damaged. Nothing was installed.`);
  }
  const w = parseJson(files, "worker.json"), deps = parseJson(files, "dependencies.json");
  const schema = v === 1 ? 1 : 2;
  if (w.schema !== schema) throw bad("incompatible", `The worker definition uses schema ${w.schema}; a format-${v} package has schema ${schema}.`);
  if (typeof w.name !== "string" || !w.name.trim()) throw bad("malformed", "The worker in the package has no name.");
  const r = w.request && typeof w.request === "object" ? w.request : {};
  const common = { name: clip(w.name, 60).trim(), specialization: clip(w.specialization, 200), mission: clip(w.mission, 600), workflow: strs(w.workflow, 30, 600), limitations: strs(w.limitations, 30, 300), onMissing: clip(w.onMissing, 1000),
    request: { description: clip(r.description, 2000), integrations: strs(r.integrations, 20, 40), workspaceKind: /^(project|scratch|any)$/.test(r.workspaceKind || "") ? r.workspaceKind : "", starters: strs(r.starters, 6, 400), unsupported: strs(r.unsupported, 20, 120) } };
  let definition;
  if (schema === 1) {
    definition = { schema: 1, ...common, capabilities: strs(w.capabilities, 40, 60), requirements: (Array.isArray(w.requirements) ? w.requirements : []).slice(0, 40).map(readReq) };
    const declared = (Array.isArray(deps.capabilities) ? deps.capabilities : []).map((c) => String(c?.id || c));
    if (declared.slice().sort().join() !== definition.capabilities.slice().sort().join()) throw bad("malformed", "dependencies.json doesn't match the worker's tools.");
  } else {
    const refs = Array.isArray(w.integrations) ? w.integrations : [];
    if (refs.length > 20) throw bad("malformed", "The worker lists more than 20 integrations.");
    const integrations = refs.map((x) => ({ id: String(x?.id || ""), version: String(x?.version || ""), config: readSettings(x?.config) }));
    for (const x of integrations) if (!IDV.test(x.id) || !VER.test(x.version)) throw bad("malformed", `An integration reference isn't valid (“${clip(x.id, 40)}” “${clip(x.version, 20)}”).`);
    if (new Set(integrations.map((x) => x.id)).size !== integrations.length) throw bad("malformed", "An integration is listed twice.");
    definition = { schema: 2, ...common, outcomes: strs(w.outcomes, 10, 200), integrations, core: strs(w.core, 10, 60), extraRequirements: (Array.isArray(w.extraRequirements) ? w.extraRequirements : []).slice(0, 20).map(readReq) };
    const declared = (Array.isArray(deps.integrations) ? deps.integrations : []).map((x) => `${x?.id}@${x?.version}`).sort().join();
    if (declared !== integrations.map((x) => `${x.id}@${x.version}`).sort().join()) throw bad("malformed", "dependencies.json doesn't match the worker's integrations.");
  }
  const knowledge = files.get("knowledge/knowledge.md").toString("utf8").slice(0, 20000);
  const repositories = (Array.isArray(deps.repositories) ? deps.repositories : []).slice(0, 20).map((g) => ({ fullName: clip(g?.fullName, 140), level: clip(g?.level, 20) })).filter((g) => /^[\w.-]+\/[\w.-]+$/.test(g.fullName));
  let gitflow = null;
  if (files.has("workflows/gitflow.json")) {
    const g = parseJson(files, "workflows/gitflow.json");
    if (g.schema !== 1) throw bad("incompatible", "The Git workflow rules use a schema this console doesn't read.");
    gitflow = { teams: (Array.isArray(g.teams) ? g.teams : []).slice(0, 10).map((t) => ({ name: clip(t?.name, 60), ours: !!t?.ours, branchPatterns: strs(t?.branchPatterns, 20, 80) })).filter((t) => t.name),
      mappings: (Array.isArray(g.mappings) ? g.mappings : []).slice(0, 20).map((m) => ({ source: clip(m?.source, 120), destination: clip(m?.destination, 120), kind: clip(m?.kind, 20), strategy: clip(m?.strategy, 20) })),
      exclude: g.exclude && typeof g.exclude === "object" ? Object.fromEntries(Object.entries(g.exclude).filter(([k]) => ["otherTeams", "uncertain", "unknown", "reverted", "merges"].includes(k)).map(([k, x]) => [k, !!x])) : {},
      shared: strs(g.shared, 30, 120), forbidden: strs(g.forbidden, 20, 120), tickets: strs(g.tickets, 5, 60) };
  }
  // Untrusted text: what looks like a credential or a path from another computer is pointed out.
  const all = JSON.stringify([definition, knowledge, gitflow]), warnings = [];
  if (SECRET.test(all)) warnings.push("Some of its text looks like a password or token. Check it before you install; this console never uses one from a package.");
  if (new RegExp(PATHS.source).test(all)) warnings.push("Some of its text mentions folders on another computer; they don't exist here.");
  if (schema === 1) warnings.push("It was made before integrations: it installs in that form (its tools as a flat list). Review its migration after installing to give it pinned integrations.");
  return { manifest: { packageId: clip(manifest.packageId, 60), createdAt: clip(manifest.createdAt, 40), generator: { name: clip(manifest.generator?.name, 60), version: clip(manifest.generator?.version, 40) }, formatVersion: v },
    definition, knowledge, repositories, gitflow, warnings, files: [...files.keys()] };
}
