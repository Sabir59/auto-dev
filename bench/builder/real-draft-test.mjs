// The draft workflow and asset upload against REAL Builder (a space marked "test") and a real site
// rendering it (SITE). Uses a disposable published entry and restores it afterwards. Every claim
// is checked with separate raw requests and the site itself.
//   BUILDER_TEST_MODEL=matw-next-application BUILDER_TEST_ENTRY_ID=<disposable published entry>
//   BUILDER_TEST_ASSETS=<folder with an image and a .ttf> SITE=http://localhost:3000  node bench/builder/real-draft-test.mjs
import { writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.BUILDER_TEST_MODEL, ID = process.env.BUILDER_TEST_ENTRY_ID, SITE = process.env.SITE || "http://localhost:3000", ASSETS = process.env.BUILDER_TEST_ASSETS;
process.env.BUILDER_UPLOAD_ROOT = ASSETS; // the adapter only reads files inside this folder
const B = await import("../../builder-adapter/builder.mjs");
const c = B.readCredentials();
if (c.environment !== "test" || !MODEL || !ID) { console.log("Not run: needs a test space, BUILDER_TEST_MODEL and BUILDER_TEST_ENTRY_ID."); process.exit(1); }
const results = [];
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail).slice(0, 260)); return detail; }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 400)); return null; }
};
const assert = (x, m) => { if (!x) throw new Error(m); };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const raw = async (extra) => { const u = new URL(`https://cdn.builder.io/api/v3/content/${MODEL}`); u.searchParams.set("apiKey", c.publicKey); u.searchParams.set("cachebust", "true"); u.searchParams.set("limit", "1"); for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v); return (await (await fetch(u)).json()).results?.[0] || null; };
const MARK = `DRAFT-MARKER-${Date.now()}`;
// The site reads published content through Builder's CDN, which can lag a change by ~35s
// (observed); preview URLs are cache-busted. So "after" checks poll, in either direction.
const bodyHas = async (path, tries = 1) => { for (let i = 0; i < tries; i++) { if ((await (await fetch(new URL(path, SITE))).text()).includes(MARK)) return true; if (i < tries - 1) await sleep(5000); } return false; };
const bodyGone = async (path, tries = 15) => { for (let i = 0; i < tries; i++) { if (!(await (await fetch(new URL(path, SITE))).text()).includes(MARK)) return true; await sleep(5000); } return false; };

// The true stored content is the preview read: delivery injects a tracking pixel into blocks.
const original = await raw({ "query.id": ID, includeUnpublished: "true", preview: "true" });
const URL_ = original.data.url;
const block = { "@type": "@builder.io/sdk:Element", id: "builder-draft-marker", component: { name: "Text", options: { text: `<p>${MARK}</p>` } } };

await step("draft update of a published entry (blocks + breakpoints): saved as a pending draft", async () => {
  const r = await B.updateContent(MODEL, ID, { data: { blocks: [block] }, breakpoints: { small: 700, medium: 1050 }, draft: true });
  assert(/pending draft/.test(r.mode) && r.previewUrl.includes(`builder.overrides.${MODEL}=${ID}`), JSON.stringify(r));
  return r;
});
await sleep(4000);

await step("INDEPENDENT: the live page is unchanged (API and site); the preview URL renders the draft", async () => {
  const live = await raw({ "query.id": ID, includeUnpublished: "true" }), latest = await raw({ "query.id": ID, includeUnpublished: "true", preview: "true" });
  const liveHas = JSON.stringify(live.data).includes(MARK), latestHas = JSON.stringify(latest.data).includes(MARK);
  const siteLive = await bodyHas(URL_), sitePreview = await bodyHas(`${URL_}${B.previewQuery(MODEL, ID)}`, 3);
  assert(!liveHas && latestHas && !siteLive && sitePreview, JSON.stringify({ liveHas, latestHas, siteLive, sitePreview }));
  return { storedHasMarker: liveHas, draftHasMarker: latestHas, draftBreakpoints: latest.meta?.breakpoints ?? null, siteLiveShowsIt: siteLive, sitePreviewShowsIt: sitePreview };
});

await step("verify reports the pending draft and the preview URL", async () => {
  const v = await B.verifyContent(MODEL, ID);
  assert(v.pendingDraft === true && v.servedAsLive === true && v.previewUrl.startsWith(URL_), JSON.stringify(v));
  return v;
});

await step("publish: the DRAFT's content goes live (API and site)", async () => {
  const r = await B.publishContent(MODEL, ID);
  await sleep(3000);
  const live = await raw({ "query.id": ID, includeUnpublished: "true" });
  const siteLive = await bodyHas(URL_, 15);
  const delivered = await raw({ "userAttributes.urlPath": URL_ });
  assert(r.publishedPendingDraft === true && JSON.stringify(live.data).includes(MARK) && siteLive && r.verification.pendingDraft === false, JSON.stringify({ r, siteLive }));
  assert(delivered?.meta?.breakpoints?.medium === 1050 && delivered.meta.breakpoints.small === 700, `delivered breakpoints: ${JSON.stringify(delivered?.meta)}`);
  return { publishedPendingDraft: r.publishedPendingDraft, deliveredBreakpoints: delivered.meta.breakpoints, siteLiveShowsIt: siteLive, verification: r.verification };
});

await step("a later write keeps the breakpoints; restore the disposable entry (live)", async () => {
  await B.updateContent(MODEL, ID, { data: { blocks: original.data.blocks || [] }, live: true });
  await sleep(3000);
  const live = await raw({ "query.id": ID, includeUnpublished: "true", preview: "true" });
  // test cleanup only, before any assertion: the original entry had no custom breakpoints
  await fetch(`https://builder.io/api/v1/write/${MODEL}/${ID}`, { method: "PATCH", headers: { authorization: `Bearer ${c.privateKey}`, "content-type": "application/json" }, body: JSON.stringify({ meta: { breakpoints: {} } }) });
  assert(live.meta?.breakpoints?.medium === 1050, `breakpoints lost: ${JSON.stringify(live.meta)}`);
  assert(!JSON.stringify(live.data).includes(MARK), "stored content still has the marker");
  const gone = await bodyGone(URL_);
  assert(gone, "the site still shows the marker after 75s");
  return { restoredBlocks: (live.data.blocks || []).length, breakpointsKeptByTheLaterWrite: live.meta.breakpoints, siteUpdated: gone };
});

for (const f of readdirSync(ASSETS).filter((x) => /\.(png|jpe?g|ttf)$/i.test(x))) await step(`upload ${f} for real; its CDN url serves it`, async () => {
  const r = await B.uploadAsset(f);
  const got = await fetch(r.url);
  const bytes = (await got.arrayBuffer()).byteLength;
  assert(got.ok && r.url.startsWith("https://cdn.builder.io/"), JSON.stringify({ r, status: got.status }));
  return { url: r.url, sentType: r.type, served: got.status, servedType: got.headers.get("content-type"), sentBytes: r.bytes, servedBytes: bytes };
});

writeFileSync(join(HERE, "real-draft-results.json"), JSON.stringify({ when: new Date().toISOString(), model: MODEL, entry: ID, results }, null, 1));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
