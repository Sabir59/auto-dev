// Builder.io adapter: reads and writes Builder content through Builder's own documented HTTP APIs.
// No Builder MCP server, no SDK, no model calls: deterministic requests, plain results. The worker
// decides what to do; this only does it, and refuses what the credential's Space doesn't allow.
//
//   Admin API (GraphQL, private key)    https://cdn.builder.io/api/v2/admin       models
//   Content API (REST, public key)      https://cdn.builder.io/api/v3/content/M   read, drafts with includeUnpublished
//   Write API (REST, private key)       https://builder.io/api/v1/write/M[/ID]    POST create, PATCH update
//
// Spaces: a person connects one or more Builder spaces on the console's Builder.io page (each one's
// public and private API keys, checked with Builder before they're kept). They're stored in one file,
// ~/.builder-adapter/credentials.json (BUILDER_ADAPTER_DIR moves the folder; hosted, it's the person's
// own folder), encrypted at rest with the person's credential key (worker-ui/secret-file.mjs):
//   { "v": 2, "spaces": [{ id, label, environment, publicKey, privateKey, addedAt, verifiedAt, testConfirmedAt?, models }] }
// The earlier single-space form ({ label, environment, publicKey, privateKey }) is read as one space.
// A space's id is derived from its public key, so connecting the same space again keeps its id (and
// the workers given it). "environment" is the person's statement about the space: production unless
// they explicitly confirmed it's a test space. Only a test space is ever written to.
//
// Which spaces a call can use: run by a console (AIW_AUTHZ_URL set), only the spaces the console
// releases for this run (worker-ui/server.mjs builderSpacesFor: the ones given to the worker, each
// with its access, read or write), asked again at every call, so a space removed, or marked as
// production, during a run is refused at once. Run on its own (the adapter's tests, a person's own
// scripts), every space in the file, writable only if it's a test space. Keys never appear in tool
// results or errors.
//
// BUILDER_ADAPTER_PROFILE=draft: an additional, narrower mode (set by the console, never by the
// worker) for a worker or Team scoped to draft-only writes. publishContent() and updateContent()
// with live:true both refuse here, in the adapter itself, regardless of how they're called.
import { readFileSync, existsSync, statSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { readSecretJson, writeSecretJson, SecretFileError } from "../worker-ui/secret-file.mjs";
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

// ---- the person's spaces ----------------------------------------------------------------
export const spaceIdOf = (publicKey) => "sp_" + createHash("sha256").update(String(publicKey)).digest("hex").slice(0, 12);
export const SPACE_ID = /^sp_[a-f0-9]{12}$/;
const normSpace = (s, legacy = false) => ({ id: spaceIdOf(s.publicKey), label: String(s.label || "Builder space").slice(0, 80), environment: s.environment === "test" ? "test" : "production",
  publicKey: String(s.publicKey), privateKey: String(s.privateKey), addedAt: s.addedAt || null, verifiedAt: s.verifiedAt || null,
  ...(s.environment === "test" ? { testConfirmedAt: s.testConfirmedAt || (legacy ? "set in the credentials file" : null) } : {}), models: Number.isInteger(s.models) ? s.models : null });
// Every space in the file, keys included (for the console and the adapter's own process only).
export function readSpaces() {
  if (!existsSync(CRED_FILE)) return [];
  let c;
  try { c = readSecretJson(CRED_FILE, "builder"); } catch (e) { if (e instanceof SecretFileError) throw new BuilderError(`The Builder spaces can't be read (${e.message})`, { code: "BAD_CREDENTIALS" }); throw new BuilderError(`The Builder credentials file isn't valid JSON (${CRED_FILE}).`, { code: "BAD_CREDENTIALS" }); }
  const list = Array.isArray(c?.spaces) ? c.spaces : c?.publicKey || c?.privateKey ? [c] : [];
  return list.filter((s) => s?.publicKey && s?.privateKey).map((s) => normSpace(s, !Array.isArray(c?.spaces)));
}
export function writeSpaces(list) {
  writeSecretJson(CRED_FILE, "builder", { v: 2, spaces: list.map(({ id, label, environment, publicKey, privateKey, addedAt, verifiedAt, testConfirmedAt, models }) => ({ id, label, environment, publicKey, privateKey, addedAt, verifiedAt, ...(environment === "test" ? { testConfirmedAt } : {}), models })) });
}
// A space as the page and workers may see it: never a key.
export const publicSpace = ({ publicKey, privateKey, ...s }) => s;
export const credentialsPresent = () => { try { return readSpaces().length > 0; } catch { return existsSync(CRED_FILE); } };
// The first space in the file; kept for scripts that read a single-space file directly.
export function readCredentials() {
  const list = readSpaces();
  if (!list.length) throw new BuilderError(`No Builder space is connected (${CRED_FILE}).`, { code: "NO_CREDENTIALS" });
  return list[0];
}

export const NO_SPACE = "No Builder space is available to this worker. The person connects a space on the console's Builder.io page (Integrations → Builder.io) and gives this worker access to it in the worker's editor (Builder.io → Builder spaces).";
// The spaces this process may use now, each with its access ("read" or "write").
async function available() {
  const url = process.env.AIW_AUTHZ_URL;
  if (url) {
    let j = null;
    try { const r = await fetch(`${url}/builder-spaces?server=${encodeURIComponent(process.env.AIW_AUTHZ_SERVER || "")}`, { headers: { "x-aiw-authz": process.env.AIW_AUTHZ_TOKEN || "" }, signal: AbortSignal.timeout(8000) }); j = r.ok ? await r.json().catch(() => null) : null; } catch {}
    if (!Array.isArray(j?.spaces)) throw new BuilderError("The console didn't confirm which Builder spaces this run may use, so nothing was done.", { code: "NO_CREDENTIALS" });
    return j.spaces.map((s) => ({ ...s, access: s.access === "write" && s.environment === "test" ? "write" : "read" }));
  }
  return readSpaces().map((s) => ({ ...s, access: s.environment === "test" ? "write" : "read" }));
}
const nameOf = (s) => `"${s.label}" (${s.id}, ${s.environment}, ${s.access === "write" ? "read and write" : "read only"})`;
// The space a call is for: the one named (by id or name), or the only one there is.
async function pick(space) {
  const list = await available();
  if (!list.length) throw new BuilderError(NO_SPACE, { code: "NO_CREDENTIALS" });
  if (space != null && String(space).trim()) {
    const want = String(space).trim().toLowerCase(), hit = list.filter((s) => s.id === want || s.label.toLowerCase() === want);
    if (hit.length === 1) return hit[0];
    throw new BuilderError(`${hit.length ? "More than one space is called" : "No space available to this worker is"} "${space}". Available: ${list.map(nameOf).join("; ")}.`, { code: "UNKNOWN_SPACE" });
  }
  if (list.length === 1) return list[0];
  throw new BuilderError(`Several Builder spaces are available to this worker: ${list.map(nameOf).join("; ")}. Say which with space (its id or name).`, { code: "SPACE_NEEDED" });
}
export async function availableSpaces() { return (await available()).map(publicSpace); }

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
const modelsOf = async (c) => {
  const j = await request(ADMIN(), { method: "POST", headers: { authorization: `Bearer ${c.privateKey}`, "content-type": "application/json" }, body: JSON.stringify({ query: "{ models { id name kind } }" }) }, c);
  return (j.data?.models || []).map((m) => ({ id: m.id, name: m.name, kind: m.kind }));
};
export async function listModels({ space } = {}) { return modelsOf(await pick(space)); }
// A connected space's keys still work: its private key lists its models (the console's status check).
export const spaceModels = async (s) => (await modelsOf(s)).length;

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
export async function listContent(model, { limit = 20, offset = 0, includeUnpublished = true, space } = {}) {
  const c = await pick(space);
  const rows = await query(model, { limit: Math.min(100, Math.max(1, limit)), offset: Math.max(0, offset) }, c, { includeUnpublished });
  return rows.map(summarize);
}
// draft:true reads the latest saved version, a pending draft included; otherwise the stored version.
export async function getContent(model, id, { includeData = true, includeUnpublished = true, draft = false, space } = {}) {
  const c = await pick(space);
  const e = await byId(model, id, c, { includeUnpublished, preview: draft });
  if (!e) return null;
  return { ...summarize(e), version: draft ? "latest saved (pending draft included)" : "stored", ...(includeData ? { data: e.data, ...(e.meta?.breakpoints ? { breakpoints: e.meta.breakpoints } : {}) } : {}) };
}

// ---- writing ------------------------------------------------------------------------
async function writer(space) {
  const c = await pick(space);
  if (c.environment !== "test") throw new BuilderError(`Refused: the Builder space "${c.label}" isn't marked as a test space, and production spaces are never written to.`, { code: "PRODUCTION_REFUSED" });
  if (c.access !== "write") throw new BuilderError(`Refused: this worker may only read the Builder space "${c.label}". Write access to a space is given in the worker's editor.`, { code: "READ_ONLY_SPACE" });
  return c;
}
// Draft-only mode (BUILDER_ADAPTER_PROFILE=draft, set by the console from a worker's or Team's
// scope, never by the worker itself): the worker may create and update drafts, but publishing and
// going live are refused here, in the adapter, below the model and below the MCP tool list — not
// only by the publish tool not being registered. Called at the top of every operation that would
// make a change live, so no caller of this module (whatever MCP tool, script or future entry point)
// can reach a live write while this env var is set.
function assertPublishAllowed(action) {
  if (process.env.BUILDER_ADAPTER_PROFILE === "draft") {
    throw new BuilderError(`Refused: this run is restricted to draft-only Builder writes, so it can't ${action}. Only draft:true changes are allowed. If this needs to change, ask whoever configured this worker or Team to change that policy; a worker can't grant itself this.`, { code: "DRAFT_ONLY_REFUSED" });
  }
}
const writeReq = (c, method, path, body) => request(`${WRITE()}${path}`, { method, headers: { authorization: `Bearer ${c.privateKey}`, "content-type": "application/json" }, body: JSON.stringify(body) }, c);

// A draft is never a second copy of something that already exists: an entry in the same model
// with the same name, or the same URL, is reported instead of duplicated.
export async function createDraft(model, { name, data = {}, url, space } = {}) {
  const c = await writer(space);
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
export async function updateContent(model, id, { name, data, dataFile, breakpoints, live = false, draft = false, space } = {}) {
  if (live) assertPublishAllowed("go live (live:true)");
  const c = await writer(space);
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
  return { id, model, space: c.label, updated, breakpoints: keep, mode: draft ? "draft: saved as a pending draft, the live page is unchanged" : e.published === "published" ? "live: the change is live now" : "the entry is unpublished, so nothing is live", wasPublished: e.published, previewUrl: e.data?.url ? `${e.data.url}${previewQuery(model, id)}` : null };
}

// Publishes the entry's LATEST saved version. Observed against real Builder (2026-10-10): a bare
// published:"published" write discards a pending draft instead of publishing it. So the latest
// version (pending draft included) is read and written back, with published:"published". The
// API's response isn't treated as proof: the result says what independent reads show.
export async function publishContent(model, id, { space } = {}) {
  assertPublishAllowed("publish");
  const c = await writer(space);
  const stored = await byId(model, id, c, { includeUnpublished: true });
  if (!stored) throw new BuilderError(`No entry ${id} in model ${model}; nothing was published.`, { code: "NOT_FOUND" });
  const latest = await byId(model, id, c, { includeUnpublished: true, preview: true }) || stored;
  const draftPending = !same(latest.data, stored.data) || !same(bpOf(latest), bpOf(stored));
  const body = { published: "published", ...(draftPending ? { data: latest.data } : {}), ...(bpOf(latest) ? { meta: { breakpoints: bpOf(latest) } } : {}) };
  const response = await writeReq(c, "PATCH", `/${encodeURIComponent(model)}/${id}`, body);
  return { id, model, space: c.label, before: stored.published, publishedPendingDraft: draftPending, apiSaid: response.published ?? null, verification: await verifyWith(c, model, id) };
}

// Independent, cache-busted reads. Observed against real Builder (2026-10-09): a Content API query
// that names an id returns the entry even when it's a draft, with or without includeUnpublished.
// So "returned by id" never means live. What does: its own published field, and, for an entry with
// a url, that a lookup by that url path (how a site resolves its pages) returns this entry.
// pendingDraft: the entry has saved changes (autosave) that aren't live yet.
export async function verifyContent(model, id, { space } = {}) { return verifyWith(await pick(space), model, id); }
async function verifyWith(c, model, id) {
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
export async function uploadAsset(path, { name, altText, space } = {}) {
  const c = await writer(space);
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

// Connecting a space: both keys work, and belong to the same space. The private key reads the
// space's models (Admin API); the public key reads content (Content API); when content comes back,
// its model must be one of the models the private key sees.
const PUBLIC_KEY = /^[A-Za-z0-9_-]{8,100}$/, PRIVATE_KEY = /^bpk-[A-Za-z0-9_-]{8,200}$/;
export async function verifySpace({ publicKey, privateKey }) {
  publicKey = String(publicKey || "").trim(); privateKey = String(privateKey || "").trim();
  if (!PUBLIC_KEY.test(publicKey)) throw new BuilderError("That doesn't look like a Builder public API key (in Builder: Account settings → Space → Public API key).", { code: "BAD_INPUT" });
  if (!PRIVATE_KEY.test(privateKey)) throw new BuilderError("That doesn't look like a Builder private key (bpk-…; in Builder: Account settings → Space → Private keys).", { code: "BAD_INPUT" });
  const c = { publicKey, privateKey };
  let models;
  try { models = await modelsOf(c); } catch (e) { throw e.status === 401 || e.status === 403 ? new BuilderError("Builder rejected the private key (revoked or mistyped).", { status: e.status, code: "KEY_REJECTED" }) : e; }
  const probe = models.find((m) => m.kind === "page") || models[0];
  if (probe) {
    let rows;
    try { rows = await query(probe.name, { limit: 5 }, c, { includeUnpublished: true }); } catch (e) { throw e.status === 401 || e.status === 403 ? new BuilderError("Builder rejected the public API key (mistyped, or from another space).", { status: e.status, code: "KEY_REJECTED" }) : e; }
    if (rows.some((r) => r.modelId && !models.some((m) => m.id === r.modelId))) throw new BuilderError("The public key and the private key belong to different Builder spaces. Copy both from the same space.", { code: "KEY_MISMATCH" });
  }
  return { publicKey, privateKey, models: models.length };
}

export async function accessSummary({ space } = {}) {
  const c = await pick(space);
  return { space: c.label, id: c.id, environment: c.environment, access: c.access, writes: c.access === "write" ? "allowed (test space)" : c.environment === "test" ? "refused (this worker may only read it)" : "refused (not a test space)" };
}
