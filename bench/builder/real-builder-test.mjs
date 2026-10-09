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
// Independent read: plain Content API request, made here, not by the adapter.
const rawRead = async (id, { drafts }) => {
  const u = new URL(`https://cdn.builder.io/api/v3/content/${encodeURIComponent(MODEL)}`);
  u.searchParams.set("apiKey", c.publicKey); u.searchParams.set("query.id", id); u.searchParams.set("cachebust", "true"); u.searchParams.set("limit", "1");
  if (drafts) u.searchParams.set("includeUnpublished", "true");
  const r = await fetch(u); const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`independent read failed: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  const e = (j.results || []).find((x) => x.id === id);
  return e ? { id: e.id, published: e.published, title: e.data?.title, lastUpdated: e.lastUpdated, firstPublished: e.firstPublished } : null;
};
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
  return { adapter: e, independent: await rawRead(EXISTING, { drafts: true }) };
});

created = await step("create a draft", async () => {
  const kind = (await B.listModels()).find((x) => x.name === MODEL)?.kind;
  const r = await B.createDraft(MODEL, { name: tag, data: { title: "v1" }, ...(kind === "page" ? { url: `/${tag}` } : {}) });
  const ind = await rawRead(r.id, { drafts: true });
  assert(ind && ind.published === "draft", `independent read: ${JSON.stringify(ind)}`);
  assert(!(await rawRead(r.id, { drafts: false })), "a draft must not be served as live content");
  return { created: r, independent: ind };
});

if (created) await step("update the draft (no duplicate, still a draft)", async () => {
  await B.updateContent(MODEL, created.created.id, { data: { title: "v2" } });
  const ind = await rawRead(created.created.id, { drafts: true });
  assert(ind.title === "v2" && ind.published === "draft", JSON.stringify(ind));
  const same = (await B.listContent(MODEL, { limit: 100 })).filter((e) => e.name === tag);
  assert(same.length === 1, `${same.length} entries named ${tag}`);
  return { independent: ind };
});

const publishProof = async (id, label) => step(`publish ${label}, then verify independently`, async () => {
  const r = await B.publishContent(MODEL, id);
  const live = await rawRead(id, { drafts: false }), withDrafts = await rawRead(id, { drafts: true });
  const out = { apiSaid: r.apiSaid, adapterVerification: r.verification, independentLive: live, independentState: withDrafts };
  assert(withDrafts?.published === "published", `state after publish: ${JSON.stringify(withDrafts)}`);
  assert(live, "the public Content API doesn't serve it as live content");
  return out;
});
if (created) await publishProof(created.created.id, "the adapter-created entry");
if (EXISTING) await publishProof(EXISTING, "the EXISTING entry (made in Builder's editor)");

if (created && SITE) await step("public page shows the published content", async () => {
  const url = new URL(`/${tag}`, SITE);
  const r = await fetch(url, { headers: { "cache-control": "no-cache" } });
  const html = await r.text();
  return { url: String(url), status: r.status, containsTitle: html.includes("v2") };
});
else results.push({ step: "public page", ok: null, detail: "not checked: set BUILDER_TEST_SITE to a site that renders this test space" });

writeFileSync(join(HERE, "real-builder-results.json"), JSON.stringify({ when: new Date().toISOString(), space: c.label, model: MODEL, createdEntry: created?.created?.id ?? null, existingEntry: EXISTING ?? null, results }, null, 1));
console.log(`\n${results.filter((x) => x.ok).length}/${results.filter((x) => x.ok !== null).length} passed (created entry: ${created?.created?.id ?? "none"}; nothing deleted)`);
