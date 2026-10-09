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
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
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
async function query(model, params, c, { includeUnpublished = true } = {}) {
  const u = new URL(`${CONTENT()}/${encodeURIComponent(checkModel(model))}`);
  u.searchParams.set("apiKey", c.publicKey);
  u.searchParams.set("cachebust", "true");
  u.searchParams.set("noCache", "true");
  if (includeUnpublished) u.searchParams.set("includeUnpublished", "true");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const j = await request(u, { method: "GET" }, c);
  return j.results || [];
}
export async function listContent(model, { limit = 20, offset = 0, includeUnpublished = true } = {}) {
  const c = readCredentials();
  const rows = await query(model, { limit: Math.min(100, Math.max(1, limit)), offset: Math.max(0, offset) }, c, { includeUnpublished });
  return rows.map(summarize);
}
export async function getContent(model, id, { includeData = true, includeUnpublished = true } = {}) {
  const c = readCredentials();
  const rows = await query(model, { "query.id": checkId(id), limit: 1 }, c, { includeUnpublished });
  const e = rows.find((x) => x.id === id);
  if (!e) return null;
  return { ...summarize(e), ...(includeData ? { data: e.data } : {}) };
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

// Updates an entry that exists in this model, by id: never a POST, so never a new entry. Changing
// a published entry is live immediately (Builder's Write API has no separate draft of a published
// entry), so that needs an explicit live:true. Publication state changes only through publish.
export async function updateContent(model, id, { name, data, live = false } = {}) {
  const c = writer();
  const cur = await query(model, { "query.id": checkId(id), limit: 1 }, c);
  const e = cur.find((x) => x.id === id);
  if (!e) throw new BuilderError(`No entry ${id} in model ${model} (checked before writing, so nothing was created).`, { code: "NOT_FOUND" });
  if (e.published === "published" && !live) throw new BuilderError(`Not changed: "${e.name}" is published, and an update to it is live immediately. Pass live:true only if that's intended.`, { code: "LIVE_CHANGE" });
  const body = { ...(name !== undefined ? { name } : {}), ...(data !== undefined ? { data } : {}) };
  if (!Object.keys(body).length) throw new BuilderError("Nothing to update: give name and/or data.", { code: "BAD_INPUT" });
  await writeReq(c, "PATCH", `/${encodeURIComponent(model)}/${id}`, body);
  return { id, model, updated: Object.keys(body), wasPublished: e.published };
}

// Publishing an existing entry: the documented Write API field `published: "published"`. The
// API's own response isn't treated as proof: the result says what an independent read shows.
export async function publishContent(model, id) {
  const c = writer();
  const cur = await query(model, { "query.id": checkId(id), limit: 1 }, c);
  const e = cur.find((x) => x.id === id);
  if (!e) throw new BuilderError(`No entry ${id} in model ${model}; nothing was published.`, { code: "NOT_FOUND" });
  const response = await writeReq(c, "PATCH", `/${encodeURIComponent(model)}/${id}`, { published: "published" });
  return { id, model, before: e.published, apiSaid: response.published ?? null, verification: await verifyContent(model, id) };
}

// Two independent reads, both bypassing the CDN cache: with drafts (what the entry's state is) and
// without (whether the public Content API actually serves it as live content).
export async function verifyContent(model, id) {
  const c = readCredentials();
  const [withDrafts, liveOnly] = await Promise.all([
    query(model, { "query.id": checkId(id), limit: 1 }, c, { includeUnpublished: true }),
    query(model, { "query.id": id, limit: 1 }, c, { includeUnpublished: false }),
  ]);
  const e = withDrafts.find((x) => x.id === id), live = liveOnly.find((x) => x.id === id);
  return { exists: !!e, state: e?.published ?? null, servedAsLive: !!live, url: e ? summarize(e).url : null, lastUpdated: e?.lastUpdated ?? null, firstPublished: e?.firstPublished ?? null };
}

export function accessSummary() {
  const c = readCredentials();
  return { label: c.label, environment: c.environment, writes: c.environment === "test" ? "allowed (test space)" : "refused (not a test space)" };
}
