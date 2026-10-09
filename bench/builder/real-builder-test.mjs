// The real publishing proof, against a real Builder TEST space (never production). Each operation
// is done through the adapter and then checked with a separate, raw HTTP request made here, so the
// adapter's own reading of the result is never the evidence.
//
//   BUILDER_TEST_MODEL=page [BUILDER_TEST_ENTRY_ID=<an existing unpublished entry made in Builder's editor>]
//   [BUILDER_TEST_SITE=https://<a site that renders this test space>]   node bench/builder/real-builder-test.mjs
//
// Refuses to start unless the credentials file marks the space as "test". It creates one new entry
// (named adapter-proof-<time>) and, if BUILDER_TEST_ENTRY_ID is given, publishes that one entry.
// It deletes nothing; the ids are in the results so they can be inspected or removed in Builder.
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as B from "../../builder-adapter/builder.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.BUILDER_TEST_MODEL, EXISTING = process.env.BUILDER_TEST_ENTRY_ID, SITE = process.env.BUILDER_TEST_SITE;
const results = [];
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail).slice(0, 300)); return detail; }
  catch (e) { results.push({ step: name, ok: false, error: e.message, code: e.code, status: e.status }); console.log("FAIL", name, e.message.slice(0, 400)); return null; }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

let c;
try { c = B.readCredentials(); } catch (e) { console.log(`Not run: ${e.message} See builder-adapter/README.md.`); process.exit(1); }
if (c.environment !== "test") { console.log(`Refused: "${c.label}" isn't marked as a test space.`); process.exit(1); }
if (!MODEL) { console.log("Set BUILDER_TEST_MODEL (a model in the test space)."); process.exit(1); }
// Independent reads: plain Content API requests, made here, not by the adapter.
// Real Builder returns an entry to a by-id query even when it's a draft (observed 2026-10-09), so
// "live" is decided by its published field and by a lookup by url path, the way a site finds a page.
const cdn = async (params) => {
  const u = new URL(`https://cdn.builder.io/api/v3/content/${encodeURIComponent(MODEL)}`);
  u.searchParams.set("apiKey", c.publicKey); u.searchParams.set("cachebust", "true"); u.searchParams.set("limit", "1");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u); const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`independent read failed: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j.results || [];
};
const rawRead = async (id) => {
  const e = (await cdn({ "query.id": id, includeUnpublished: "true" })).find((x) => x.id === id);
  return e ? { id: e.id, published: e.published, title: e.data?.title, url: e.data?.url, lastUpdated: e.lastUpdated, firstPublished: e.firstPublished } : null;
};
const rawLiveAt = async (url) => (await cdn({ "userAttributes.urlPath": url }))[0]?.id ?? null;
const tag = `adapter-proof-${Date.now()}`;
let created;

await step("access: the key works and the model exists", async () => {
  const models = await B.listModels();
  const m = models.find((x) => x.name === MODEL);
  assert(m, `model "${MODEL}" not in this space: ${models.map((x) => x.name).join(", ")}`);
  return { space: c.label, model: m };
});

if (EXISTING) await step("read the existing test entry", async () => {
  const e = await B.getContent(MODEL, EXISTING, { includeData: false });
  assert(e, "not found (drafts included)");
  return { adapter: e, independent: await rawRead(EXISTING) };
});

created = await step("create a draft", async () => {
  const kind = (await B.listModels()).find((x) => x.name === MODEL)?.kind;
  const r = await B.createDraft(MODEL, { name: tag, data: { title: `${tag} v1` }, ...(kind === "page" ? { url: `/${tag}` } : {}) });
  const ind = await rawRead(r.id);
  assert(ind && ind.published === "draft", `independent read: ${JSON.stringify(ind)}`);
  const liveAt = ind.url ? await rawLiveAt(ind.url) : null;
  assert(liveAt !== r.id, "a draft must not be served at its url");
  return { created: r, independent: ind, servedAtUrl: liveAt === r.id };
});

if (created) await step("update the draft (no duplicate, still a draft)", async () => {
  await B.updateContent(MODEL, created.created.id, { data: { title: `${tag} v2` } });
  const ind = await rawRead(created.created.id);
  assert(ind.title === `${tag} v2` && ind.published === "draft", JSON.stringify(ind));
  const same = (await B.listContent(MODEL, { limit: 100 })).filter((e) => e.name === tag);
  assert(same.length === 1, `${same.length} entries named ${tag}`);
  return { independent: ind };
});

// The site renders only PUBLISHED content at a path and 404s otherwise, so it's a real check.
// Builder's CDN may take a moment to serve a fresh publish, so the "after" check retries.
const page = async (path) => { const r = await fetch(new URL(path, SITE), { headers: { "cache-control": "no-cache" } }); return { status: r.status, html: await r.text() }; };
const pageAfterPublish = async (path, marker) => {
  let last;
  for (let i = 0; i < 12; i++) { last = await page(path); if (last.status === 200 && (!marker || last.html.includes(marker))) break; await new Promise((ok) => setTimeout(ok, 5000)); }
  return { path, status: last.status, containsMarker: marker ? last.html.includes(marker) : null };
};
const siteBefore = {};
if (SITE) await step("public site BEFORE publishing: the draft pages aren't served (baseline)", async () => {
  if (created) siteBefore.created = (await page(`/${tag}`)).status;
  if (EXISTING) { const e = await B.getContent(MODEL, EXISTING, { includeData: false }); siteBefore.existingPath = e?.url; if (e?.url) siteBefore.existing = (await page(e.url)).status; }
  assert(Object.entries(siteBefore).filter(([k]) => k !== "existingPath").every(([, s]) => s === 404), JSON.stringify(siteBefore));
  return siteBefore;
});

const publishProof = async (id, label) => step(`publish ${label}, then verify independently`, async () => {
  const r = await B.publishContent(MODEL, id);
  const state = await rawRead(id);
  const liveAt = state?.url ? await rawLiveAt(state.url) : null;
  const out = { apiSaid: r.apiSaid, adapterVerification: r.verification, independentState: state, independentServedAtUrl: liveAt === id };
  assert(state?.published === "published", `state after publish: ${JSON.stringify(state)}`);
  if (state.url) assert(liveAt === id, `a lookup by ${state.url} returns ${liveAt}, not this entry`);
  assert(r.verification.servedAsLive === true, "the adapter's own verification disagrees");
  return out;
});
if (created) await publishProof(created.created.id, "the adapter-created entry");
if (EXISTING) await publishProof(EXISTING, "the EXISTING entry (made in Builder's editor)");

if (SITE) await step("public site AFTER publishing: the pages are served, with the updated content", async () => {
  const out = {};
  if (created) { out.created = await pageAfterPublish(`/${tag}`, `${tag} v2`); assert(out.created.status === 200 && out.created.containsMarker, JSON.stringify(out.created)); }
  if (EXISTING && siteBefore.existingPath) { out.existing = await pageAfterPublish(siteBefore.existingPath); assert(out.existing.status === 200, JSON.stringify(out.existing)); }
  return out;
});
else results.push({ step: "public page", ok: null, detail: "not checked: set BUILDER_TEST_SITE to a site that renders this test space" });

writeFileSync(join(HERE, "real-builder-results.json"), JSON.stringify({ when: new Date().toISOString(), space: c.label, model: MODEL, createdEntry: created?.created?.id ?? null, existingEntry: EXISTING ?? null, results }, null, 1));
console.log(`\n${results.filter((x) => x.ok).length}/${results.filter((x) => x.ok !== null).length} passed (created entry: ${created?.created?.id ?? "none"}; nothing deleted)`);
