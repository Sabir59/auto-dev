// Builder.io adapter: reads and writes Builder content through Builder's own documented HTTP APIs.
// No Builder MCP server, no SDK, no model calls: deterministic requests, plain results. The worker
// decides what to do; this only does it, and refuses what the credential's Space doesn't allow.
//
//   Admin API (GraphQL, private key)    https://cdn.builder.io/api/v2/admin       models
//   Content API (REST, public key)      https://cdn.builder.io/api/v3/content/M   read, drafts with includeUnpublished
//   Write API (REST, private key)       https://builder.io/api/v1/write/M[/ID]    POST create, PATCH update
//
// Credentials live outside the repo, in ~/.builder-adapter/credentials.json (BUILDER_ADAPTER_DIR
// moves the folder; it holds a path, not a secret):
//   { "label": "MATW test space", "environment": "test", "publicKey": "...", "privateKey": "bpk-..." }
// "environment" is the person's statement about the Space. Only "test" allows any write: this
// version never creates, changes or publishes content in a Space marked (or defaulting to)
// production. Keys never appear in tool results or errors.
import { readFileSync, existsSync, statSync, realpathSync } from "node:fs";
import { join, resolve, relative, isAbsolute, extname, basename } from "node:path";
import { homedir } from "node:os";

export const CRED_DIR = process.env.BUILDER_ADAPTER_DIR || join(homedir(), ".builder-adapter");
export const CRED_FILE = join(CRED_DIR, "credentials.json");

// Overridable only to a loopback http address, for the mocked tests: a redirected base URL would
// otherwise carry the private key to whoever is listening there.
const base = (name, dflt) => {
  const v = process.env[name];
  if (!v) return dflt;
  const u = new URL(v);
  if (u.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) throw new Error(`${name} may only point at a local test server (http://127.0.0.1:<port>).`);
  return v.replace(/\/$/, "");
};
const ADMIN = () => base("BUILDER_ADMIN_BASE", "https://cdn.builder.io") + "/api/v2/admin";
const CONTENT = () => base("BUILDER_CONTENT_BASE", "https://cdn.builder.io") + "/api/v3/content";
const WRITE = () => base("BUILDER_WRITE_BASE", "https://builder.io") + "/api/v1/write";
const UPLOAD = () => base("BUILDER_WRITE_BASE", "https://builder.io") + "/api/v1/upload";

// Local files the adapter reads (an asset to upload, a page's data) must be inside this folder,
// the run's workspace (set by the console). An upload makes a file public on Builder's CDN, so
// nothing outside the workspace may ever be sent.
function workspaceFile(p) {
  const rootEnv = process.env.BUILDER_UPLOAD_ROOT;
  if (!rootEnv || !existsSync(rootEnv)) throw new BuilderError("Reading local files isn't available in this run (no workspace folder).", { code: "NO_ROOT" });
  const root = realpathSync(rootEnv);
  const full = resolve(root, String(p || ""));
  if (!existsSync(full)) throw new BuilderError(`No such file in the workspace: ${p}`, { code: "BAD_INPUT" });
  const real = realpathSync(full), rel = relative(root, real);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new BuilderError(`Refused: ${p} is outside the workspace folder.`, { code: "OUTSIDE_ROOT" });
  if (!statSync(real).isFile()) throw new BuilderError(`${p} isn't a file.`, { code: "BAD_INPUT" });
  return real;
}
// Builder's own preview parameters: a site using the Builder SDK renders the entry's latest
// saved version (a pending draft included) at its url with these, without anything being published.
export const previewQuery = (model, id) => `?builder.preview=${encodeURIComponent(model)}&builder.cachebust=true&builder.overrides.${encodeURIComponent(model)}=${id}`;

export class BuilderError extends Error {
  constructor(message, { status, code } = {}) { super(message); this.status = status; this.code = code; }
}

export function readCredentials() {
  if (!existsSync(CRED_FILE)) throw new BuilderError(`No Builder credentials on this computer (${CRED_FILE}).`, { code: "NO_CREDENTIALS" });
  let c;
  try { c = JSON.parse(readFileSync(CRED_FILE, "utf8")); } catch { throw new BuilderError(`The Builder credentials file isn't valid JSON (${CRED_FILE}).`, { code: "BAD_CREDENTIALS" }); }
  if (!c.publicKey || !c.privateKey) throw new BuilderError("The Builder credentials file needs both publicKey and privateKey.", { code: "BAD_CREDENTIALS" });
  return { label: String(c.label || "Builder space"), environment: c.environment === "test" ? "test" : "production", publicKey: String(c.publicKey), privateKey: String(c.privateKey) };
}
export const credentialsPresent = () => existsSync(CRED_FILE);

// Nothing secret leaves this module: any key that shows up in an error text is masked.
const mask = (s, c) => [c?.privateKey, c?.publicKey].filter(Boolean).reduce((t, k) => t.split(k).join("<key>"), String(s));
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const checkModel = (m) => { if (!MODEL_RE.test(String(m || ""))) throw new BuilderError(`"${m}" isn't a valid Builder model name.`, { code: "BAD_INPUT" }); return m; };
const checkId = (id) => { if (!ID_RE.test(String(id || ""))) throw new BuilderError(`"${id}" isn't a valid Builder content id.`, { code: "BAD_INPUT" }); return id; };

async function request(url, init, c) {
  let r;
  try { r = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) }); }
  catch (e) { throw new BuilderError(`Couldn't reach Builder: ${mask(e.message, c)}`, { code: "NETWORK" }); }
  const text = await r.text();
  let j; try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text.slice(0, 300) }; }
  if (!r.ok) {
    const why = mask(j.message || j.error || j.raw || JSON.stringify(j).slice(0, 300), c);
    throw new BuilderError(
      r.status === 401 ? `Builder rejected the key (401): ${why}`
      : r.status === 403 ? `Builder refused this operation for this key (403): ${why}`
      : r.status === 404 ? `Builder says this doesn't exist (404): ${why}`
      : `Builder API error ${r.status}: ${why}`, { status: r.status, code: `HTTP_${r.status}` });
  }
  if (j?.errors?.length) throw new BuilderError(`Builder API error: ${mask(j.errors.map((e) => e.message).join("; "), c)}`, { code: "GRAPHQL" });
  return j;
}

// ---- reading ------------------------------------------------------------------------
export async function listModels() {
  const c = readCredentials();
  const j = await request(ADMIN(), { method: "POST", headers: { authorization: `Bearer ${c.privateKey}`, "content-type": "application/json" }, body: JSON.stringify({ query: "{ models { id name kind } }" }) }, c);
  return (j.data?.models || []).map((m) => ({ id: m.id, name: m.name, kind: m.kind }));
}

// Compact, stable shape for the worker: what the entry is and its publication state.
export const summarize = (e) => ({
  id: e.id, name: e.name, published: e.published ?? null,
  url: e.data?.url ?? (e.query || []).find((q) => q.property === "urlPath")?.value ?? null,
  lastUpdated: e.lastUpdated ?? null, firstPublished: e.firstPublished ?? null, createdDate: e.createdDate ?? null,
});

// fresh: bypass Builder's CDN cache. includeUnpublished: drafts too (otherwise only live content).
// preview: the latest saved version, a pending draft (autosave) included (observed: preview=true).
async function query(model, params, c, { includeUnpublished = true, preview = false } = {}) {
  const u = new URL(`${CONTENT()}/${encodeURIComponent(checkModel(model))}`);
  u.searchParams.set("apiKey", c.publicKey);
  u.searchParams.set("cachebust", "true");
  u.searchParams.set("noCache", "true");
  if (includeUnpublished) u.searchParams.set("includeUnpublished", "true");
  if (preview) u.searchParams.set("preview", "true");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const j = await request(u, { method: "GET" }, c);
  return j.results || [];
}
// Builder's delivery (non-preview) responses inject a tracking-pixel block into data.blocks
// (observed 2026-10-10). It isn't part of the stored content, so it's removed before any data is
// shown, compared or written back.
const isPixel = (b) => typeof b?.id === "string" && b.id.startsWith("builder-pixel-") && /\/api\/v1\/pixel/.test(b?.properties?.src || "");
const clean = (data) => (data && Array.isArray(data.blocks) ? { ...data, blocks: data.blocks.filter((b) => !isPixel(b)) } : data);
const byId = async (model, id, c, opts) => { const e = (await query(model, { "query.id": checkId(id), limit: 1 }, c, opts)).find((x) => x.id === id); return e ? { ...e, data: clean(e.data) } : null; };
const bpOf = (e) => (e?.meta?.breakpoints && Object.keys(e.meta.breakpoints).length ? e.meta.breakpoints : null);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export async function listContent(model, { limit = 20, offset = 0, includeUnpublished = true } = {}) {
  const c = readCredentials();
  const rows = await query(model, { limit: Math.min(100, Math.max(1, limit)), offset: Math.max(0, offset) }, c, { includeUnpublished });
  return rows.map(summarize);
}
// draft:true reads the latest saved version, a pending draft included; otherwise the stored version.
export async function getContent(model, id, { includeData = true, includeUnpublished = true, draft = false } = {}) {
  const c = readCredentials();
  const e = await byId(model, id, c, { includeUnpublished, preview: draft });
  if (!e) return null;
  return { ...summarize(e), version: draft ? "latest saved (pending draft included)" : "stored", ...(includeData ? { data: e.data, ...(e.meta?.breakpoints ? { breakpoints: e.meta.breakpoints } : {}) } : {}) };
}

// ---- writing ------------------------------------------------------------------------
function writer() {
  const c = readCredentials();
  if (c.environment !== "test") throw new BuilderError(`Refused: the connected Builder space ("${c.label}") isn't marked as a test space, and this adapter never writes to a production space.`, { code: "PRODUCTION_REFUSED" });
  return c;
}
const writeReq = (c, method, path, body) => request(`${WRITE()}${path}`, { method, headers: { authorization: `Bearer ${c.privateKey}`, "content-type": "application/json" }, body: JSON.stringify(body) }, c);

// A draft is never a second copy of something that already exists: an entry in the same model
// with the same name, or the same URL, is reported instead of duplicated.
export async function createDraft(model, { name, data = {}, url } = {}) {
  const c = writer();
  checkModel(model);
  if (!String(name || "").trim()) throw new BuilderError("A draft needs a name.", { code: "BAD_INPUT" });
  const existing = (await query(model, { limit: 100 }, c)).map(summarize);
  const dup = existing.find((e) => e.name === name || (url && e.url === url));
  if (dup) throw new BuilderError(`Not created: "${dup.name}" (${dup.id}, ${dup.published}) already exists in ${model}${url && dup.url === url ? ` at ${url}` : ""}. Update that entry instead.`, { code: "DUPLICATE" });
  const body = { name, published: "draft", data: { ...data, ...(url ? { url } : {}) }, ...(url ? { query: [{ property: "urlPath", operator: "is", value: url }] } : {}) };
  const j = await writeReq(c, "POST", `/${encodeURIComponent(model)}`, body);
  if (!j.id) throw new BuilderError("Builder accepted the request but returned no id.", { code: "NO_ID" });
  return { id: j.id, name: j.name ?? name, published: j.published ?? "draft" };
}

// Updates an entry that exists in this model, by id: never a POST, so never a new entry. On a
// PUBLISHED entry a normal write is live immediately, so it needs one of:
//   draft:true  Builder's autosave (?autoSaveOnly=true): the live page is unchanged; the change is a
//               pending draft, visible at the entry's url with previewQuery, until it's published.
//   live:true   the change goes live now.
// data can come from a JSON file in the workspace (dataFile) instead of inline: a page's data is
// often too large to pass inline. meta may only carry breakpoints. Publication state changes only
// through publish.
export async function updateContent(model, id, { name, data, dataFile, breakpoints, live = false, draft = false } = {}) {
  const c = writer();
  if (live && draft) throw new BuilderError("Choose draft:true or live:true, not both.", { code: "BAD_INPUT" });
  if (data !== undefined && dataFile) throw new BuilderError("Give data or dataFile, not both.", { code: "BAD_INPUT" });
  if (dataFile) {
    let parsed; try { parsed = JSON.parse(readFileSync(workspaceFile(dataFile), "utf8")); } catch (e) { if (e instanceof BuilderError) throw e; throw new BuilderError(`${dataFile} isn't valid JSON: ${e.message}`, { code: "BAD_INPUT" }); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BuilderError(`${dataFile} must contain a JSON object (the entry's data).`, { code: "BAD_INPUT" });
    data = parsed;
  }
  if (breakpoints !== undefined && (!breakpoints || typeof breakpoints !== "object" || !Object.keys(breakpoints).length)) throw new BuilderError("Breakpoints must set at least one of xsmall/small/medium.", { code: "BAD_INPUT" });
  if (breakpoints !== undefined) for (const [k, v] of Object.entries(breakpoints)) if (!["xsmall", "small", "medium"].includes(k) || !Number.isInteger(v) || v < 200 || v > 3000) throw new BuilderError(`Breakpoints may only set xsmall/small/medium to a pixel width (got ${k}: ${v}).`, { code: "BAD_INPUT" });
  const e = await byId(model, id, c, { includeUnpublished: true });
  if (!e) throw new BuilderError(`No entry ${id} in model ${model} (checked before writing, so nothing was created).`, { code: "NOT_FOUND" });
  if (e.published === "published" && !live && !draft) throw new BuilderError(`Not changed: "${e.name}" is published, so a normal update would be live immediately. Pass draft:true to save it as a pending draft (the live page stays as it is), or live:true if it should go live now.`, { code: "LIVE_CHANGE" });
  const updated = [...(name !== undefined ? ["name"] : []), ...(data !== undefined ? ["data"] : []), ...(breakpoints ? ["breakpoints"] : [])];
  if (!updated.length) throw new BuilderError("Nothing to update: give name, data, dataFile and/or breakpoints.", { code: "BAD_INPUT" });
  // A write without meta clears the entry's breakpoints (observed 2026-10-10), so the current ones
  // (of the version being written: the draft, if writing a draft) always go along.
  const current = bpOf(draft ? (await byId(model, id, c, { includeUnpublished: true, preview: true })) || e : e);
  const keep = breakpoints || current;
  const body = { ...(name !== undefined ? { name } : {}), ...(data !== undefined ? { data } : {}), ...(keep ? { meta: { breakpoints: keep } } : {}) };
  await writeReq(c, "PATCH", `/${encodeURIComponent(model)}/${id}${draft ? "?autoSaveOnly=true" : ""}`, body);
  return { id, model, updated, breakpoints: keep, mode: draft ? "draft: saved as a pending draft, the live page is unchanged" : e.published === "published" ? "live: the change is live now" : "the entry is unpublished, so nothing is live", wasPublished: e.published, previewUrl: e.data?.url ? `${e.data.url}${previewQuery(model, id)}` : null };
}

// Publishes the entry's LATEST saved version. Observed against real Builder (2026-10-10): a bare
// published:"published" write discards a pending draft instead of publishing it. So the latest
// version (pending draft included) is read and written back, with published:"published". The
// API's response isn't treated as proof: the result says what independent reads show.
export async function publishContent(model, id) {
  const c = writer();
  const stored = await byId(model, id, c, { includeUnpublished: true });
  if (!stored) throw new BuilderError(`No entry ${id} in model ${model}; nothing was published.`, { code: "NOT_FOUND" });
  const latest = await byId(model, id, c, { includeUnpublished: true, preview: true }) || stored;
  const draftPending = !same(latest.data, stored.data) || !same(bpOf(latest), bpOf(stored));
  const body = { published: "published", ...(draftPending ? { data: latest.data } : {}), ...(bpOf(latest) ? { meta: { breakpoints: bpOf(latest) } } : {}) };
  const response = await writeReq(c, "PATCH", `/${encodeURIComponent(model)}/${id}`, body);
  return { id, model, before: stored.published, publishedPendingDraft: draftPending, apiSaid: response.published ?? null, verification: await verifyContent(model, id) };
}

// Independent, cache-busted reads. Observed against real Builder (2026-10-09): a Content API query
// that names an id returns the entry even when it's a draft, with or without includeUnpublished.
// So "returned by id" never means live. What does: its own published field, and, for an entry with
// a url, that a lookup by that url path (how a site resolves its pages) returns this entry.
// pendingDraft: the entry has saved changes (autosave) that aren't live yet.
export async function verifyContent(model, id) {
  const c = readCredentials();
  const e = await byId(model, id, c, { includeUnpublished: true });
  const url = e ? summarize(e).url : null;
  const servedAtUrl = url ? (await query(model, { "userAttributes.urlPath": url, limit: 1 }, c, { includeUnpublished: false }))[0]?.id === id : null;
  const latest = e ? await byId(model, id, c, { includeUnpublished: true, preview: true }) : null;
  const pendingDraft = !!latest && (!same(latest.data, e.data) || !same(bpOf(latest), bpOf(e)));
  const published = e?.published === "published";
  return { exists: !!e, state: e?.published ?? null, servedAsLive: published && servedAtUrl !== false, url, servedAtUrl, pendingDraft, previewUrl: url ? `${url}${previewQuery(model, id)}` : null, lastUpdated: e?.lastUpdated ?? null, firstPublished: e?.firstPublished ?? null };
}

// Uploads a file from the workspace to the space's asset library (Builder's Upload API) and
// returns its CDN url. Images and fonts only; an upload is public on Builder's CDN.
const ASSET_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2" };
export async function uploadAsset(path, { name, altText } = {}) {
  const c = writer();
  const file = workspaceFile(path), type = ASSET_TYPES[extname(file).toLowerCase()];
  if (!type) throw new BuilderError(`Only images and fonts can be uploaded (${Object.keys(ASSET_TYPES).join(", ")}).`, { code: "BAD_INPUT" });
  const bytes = statSync(file).size;
  if (bytes > 20e6) throw new BuilderError(`${path} is larger than 20 MB.`, { code: "BAD_INPUT" });
  const u = new URL(UPLOAD());
  u.searchParams.set("name", name || basename(file));
  if (altText) u.searchParams.set("altText", altText);
  const j = await request(u, { method: "POST", headers: { authorization: `Bearer ${c.privateKey}`, "content-type": type }, body: readFileSync(file) }, c);
  if (!j.url) throw new BuilderError("Builder accepted the upload but returned no url.", { code: "NO_URL" });
  return { url: j.url, name: name || basename(file), type, bytes };
}

export function accessSummary() {
  const c = readCredentials();
  return { label: c.label, environment: c.environment, writes: c.environment === "test" ? "allowed (test space)" : "refused (not a test space)" };
}
