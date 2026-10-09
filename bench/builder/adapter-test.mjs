// Mocked tests of the Builder adapter, through its real MCP server (mcp/builder-server.mjs) and the
// real tool contracts, against a local Builder stand-in (mock-builder.mjs). They prove the adapter's
// requests, guards and result handling. They do NOT prove anything about Builder itself: real
// publishing is proven only by real-builder-test.mjs against a real test space.
//   node bench/builder/adapter-test.mjs
import { Client } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { startMock, KEYS } from "./mock-builder.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const mock = await startMock();
const BASE = `http://127.0.0.1:${mock.port}`;
const results = [], outputs = [];
const step = async (name, fn) => {
  try { const detail = await fn(); results.push({ step: name, ok: true, detail }); console.log("PASS", name, JSON.stringify(detail).slice(0, 200)); }
  catch (e) { results.push({ step: name, ok: false, error: e.message }); console.log("FAIL", name, e.message.slice(0, 300)); }
};
const assert = (c, msg) => { if (!c) throw new Error(msg); };

const dirs = [];
function credDir(creds) { const d = mkdtempSync(join(tmpdir(), "bld-")); dirs.push(d); if (creds) writeFileSync(join(d, "credentials.json"), JSON.stringify(creds)); return d; }
const TEST = { label: "Mock test space", environment: "test", publicKey: KEYS.public, privateKey: KEYS.private };

// The run's workspace (what the console sets as BUILDER_UPLOAD_ROOT), and a file outside it.
const WS = mkdtempSync(join(tmpdir(), "bld-ws-")), OUTSIDE = mkdtempSync(join(tmpdir(), "bld-out-"));
dirs.push(WS, OUTSIDE);
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
writeFileSync(join(WS, "page.json"), JSON.stringify({ blocks: [{ "@type": "@builder.io/sdk:Element", id: "builder-from-file", component: { name: "Text", options: { text: "<p>FROM-FILE</p>" } } }], title: "From file" }));
writeFileSync(join(WS, "array.json"), "[1,2]"); writeFileSync(join(WS, "broken.json"), "{ not json");
writeFileSync(join(WS, "logo.png"), PNG); writeFileSync(join(WS, "Heading.ttf"), Buffer.alloc(2048, 7)); writeFileSync(join(WS, "tool.exe"), "MZ");
writeFileSync(join(OUTSIDE, "secret.png"), PNG);

async function connect({ creds = TEST, profile = "full", bases = BASE, root = WS } = {}) {
  const env = { ...process.env, BUILDER_ADAPTER_DIR: credDir(creds), ...(profile ? { BUILDER_ADAPTER_PROFILE: profile } : {}) };
  delete env.BUILDER_UPLOAD_ROOT; if (root) env.BUILDER_UPLOAD_ROOT = root;
  delete env.BUILDER_ADAPTER_PROFILE; if (profile) env.BUILDER_ADAPTER_PROFILE = profile;
  if (bases) Object.assign(env, { BUILDER_ADMIN_BASE: bases, BUILDER_CONTENT_BASE: bases, BUILDER_WRITE_BASE: bases });
  const client = new Client({ name: "adapter-test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(REPO, "mcp", "builder-server.mjs")], env, cwd: REPO }));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content.map((c) => c.text).join("\n");
    outputs.push(text);
    let json = null; try { json = JSON.parse(text); } catch {}
    return { isError: !!r.isError, text, json };
  };
  return { client, call, close: () => client.close() };
}
const writesSince = (i) => mock.log.slice(i).filter((r) => r.path.startsWith("/api/v1/write"));

const A = await connect();

await step("missing credentials → explicit NEEDS, nothing sent to Builder", async () => {
  const c = await connect({ creds: null });
  const before = mock.log.length;
  const s = await c.call("builder_access_status");
  const l = await c.call("builder_list_models");
  await c.close();
  assert(s.json.connected === false && /NEEDS: builder read/.test(s.json.why), "access_status should say NEEDS");
  assert(l.isError && /^NEEDS: builder read/.test(l.text), "list_models should refuse with NEEDS");
  assert(mock.log.length === before, "no request should reach Builder");
  return { status: s.json.connected, error: l.text.slice(0, 60) };
});

await step("invalid key → 401 explained, key never echoed", async () => {
  const c = await connect({ creds: { ...TEST, privateKey: "bpk-WRONG-key-should-not-leak" } });
  const s = await c.call("builder_access_status");
  const l = await c.call("builder_list_models");
  await c.close();
  assert(s.json.connected === false && /401/.test(s.json.why), "should report 401");
  assert(l.isError && /rejected the key \(401\)/.test(l.text), "list_models should explain 401");
  assert(!l.text.includes("bpk-WRONG") && !s.text.includes("bpk-WRONG"), "key must not appear");
  return { why: s.json.why };
});

await step("access status and models with a working test-space key", async () => {
  const s = await A.call("builder_access_status");
  const m = await A.call("builder_list_models");
  assert(s.json.connected && s.json.environment === "test" && /allowed/.test(s.json.writes), "status");
  assert(m.json.map((x) => x.name).join() === "page,announcement-bat", "models");
  const adminReq = mock.log.filter((r) => r.path === "/api/v2/admin").at(-1);
  assert(adminReq.auth === `Bearer ${KEYS.private}` && /models/.test(adminReq.body.query), "admin request shape");
  return { status: s.json, models: m.json.length };
});

await step("list content: drafts included by default, live-only on request, always cache-busted", async () => {
  const all = await A.call("builder_list_content", { model: "page" });
  const live = await A.call("builder_list_content", { model: "page", includeUnpublished: false });
  const req = mock.log.filter((r) => r.path === "/api/v3/content/page").at(-2);
  assert(all.json.length === 2 && live.json.length === 1 && live.json[0].published === "published", "draft/live split");
  assert(req.search.cachebust === "true" && req.search.includeUnpublished === "true" && req.search.apiKey === KEYS.public, "content request params");
  return { all: all.json.map((e) => `${e.name}:${e.published}`), live: live.json.map((e) => e.name) };
});

await step("get content: by id with data; wrong id, wrong model and malformed id handled", async () => {
  const g = await A.call("builder_get_content", { model: "page", id: "seeddraft00001" });
  const missing = await A.call("builder_get_content", { model: "page", id: "doesnotexist1" });
  const wrongModel = await A.call("builder_get_content", { model: "nosuchmodel", id: "seeddraft00001" });
  const bad = await A.call("builder_get_content", { model: "page", id: "../../etc" });
  assert(g.json.published === "draft" && g.json.data.title === "Draft" && g.json.url === "/draft", "get");
  assert(missing.json.found === false, "missing id → found:false");
  assert(wrongModel.isError && /404/.test(wrongModel.text), "wrong model → 404 error");
  assert(bad.isError && /isn't a valid Builder content id/.test(bad.text), "bad id refused locally");
  return { got: g.json.name, missing: missing.json, wrongModel: wrongModel.text.slice(0, 60) };
});

let draftId;
await step("create draft: POST with published:\"draft\" and urlPath targeting", async () => {
  const i = mock.log.length;
  const r = await A.call("builder_create_draft", { model: "page", name: "Adapter test page", url: "/adapter-test", data: { title: "v1" } });
  const w = writesSince(i);
  assert(!r.isError && r.json.published === "draft", r.text);
  assert(w.length === 1 && w[0].method === "POST" && w[0].body.published === "draft" && w[0].body.query[0].value === "/adapter-test", "request shape");
  draftId = r.json.id;
  return { created: r.json, request: { method: w[0].method, published: w[0].body.published } };
});

await step("duplicate prevention: same name or same url → refused, no POST sent", async () => {
  const i = mock.log.length;
  const byName = await A.call("builder_create_draft", { model: "page", name: "Adapter test page" });
  const byUrl = await A.call("builder_create_draft", { model: "page", name: "Another name", url: "/adapter-test" });
  assert(byName.isError && /already exists/.test(byName.text) && byName.text.includes(draftId), "dup by name");
  assert(byUrl.isError && /already exists/.test(byUrl.text), "dup by url");
  assert(writesSince(i).length === 0, "no write request");
  return { byName: byName.text.slice(0, 90) };
});

await step("update draft: PATCH by id, never POST, publication state untouched", async () => {
  const i = mock.log.length;
  const r = await A.call("builder_update_content", { model: "page", id: draftId, data: { title: "v2" } });
  const w = writesSince(i);
  const after = await A.call("builder_get_content", { model: "page", id: draftId });
  assert(!r.isError, r.text);
  assert(w.length === 1 && w[0].method === "PATCH" && w[0].path.endsWith(`/page/${draftId}`) && !("published" in w[0].body), "PATCH without published");
  assert(after.json.data.title === "v2" && after.json.data.url === "/adapter-test" && after.json.published === "draft", "merged, still draft");
  assert([...mock.entries.values()].filter((e) => e.name === "Adapter test page").length === 1, "no duplicate entry");
  return { after: { title: after.json.data.title, state: after.json.published } };
});

await step("update: unknown id or wrong model → refused before any write", async () => {
  const i = mock.log.length;
  const a = await A.call("builder_update_content", { model: "page", id: "doesnotexist1", data: { x: 1 } });
  const b = await A.call("builder_update_content", { model: "announcement-bat", id: draftId, data: { x: 1 } });
  assert(a.isError && /nothing was created/.test(a.text) && b.isError, "refused");
  assert(writesSince(i).length === 0, "no write request");
  return { a: a.text.slice(0, 80) };
});

await step("update a PUBLISHED entry: refused without live:true (it goes live), allowed with it", async () => {
  const i = mock.log.length;
  const no = await A.call("builder_update_content", { model: "page", id: "seedpublished01", data: { title: "Live v2" } });
  assert(no.isError && /live immediately/.test(no.text) && writesSince(i).length === 0, "refused without live");
  const yes = await A.call("builder_update_content", { model: "page", id: "seedpublished01", data: { title: "Live v2" }, live: true });
  assert(!yes.isError && writesSince(i).length === 1, "allowed with live");
  return { refused: no.text.slice(0, 70), allowed: yes.json };
});

await step("publish: PATCH published:\"published\", then independent reads confirm it's live", async () => {
  const i = mock.log.length;
  const r = await A.call("builder_publish_content", { model: "page", id: draftId });
  const w = writesSince(i);
  assert(w.length === 1 && w[0].method === "PATCH" && w[0].body.published === "published", "publish request");
  assert(r.json.before === "draft" && r.json.verification.state === "published" && r.json.verification.servedAsLive === true, JSON.stringify(r.json));
  const liveRead = mock.log.slice(i).find((x) => x.path === "/api/v3/content/page" && x.search.includeUnpublished === undefined);
  assert(liveRead && liveRead.search.cachebust === "true", "a live-only, cache-busted read was made");
  return r.json;
});

await step("verify never calls a draft live, although Builder returns drafts to a by-id query", async () => {
  const v = await A.call("builder_verify_content", { model: "page", id: "seeddraft00001" });
  const byId = mock.log.filter((r) => r.search["query.id"] === "seeddraft00001").at(-1);
  assert(v.json.state === "draft" && v.json.servedAsLive === false, JSON.stringify(v.json));
  assert(byId, "the by-id read happened (and, like real Builder, returned the draft)");
  return v.json;
});

await step("publish where the API says OK but nothing changed → verification says NOT live", async () => {
  const d = await A.call("builder_create_draft", { model: "page", name: "Ignored publish", url: "/ignored" });
  mock.fault.publishIgnored = true;
  const r = await A.call("builder_publish_content", { model: "page", id: d.json.id });
  mock.fault.publishIgnored = false;
  assert(r.json.apiSaid === "published", "the API claimed success");
  assert(r.json.verification.state === "draft" && r.json.verification.servedAsLive === false, "verification must expose it");
  return { apiSaid: r.json.apiSaid, verification: r.json.verification };
});

await step("publish refused by Builder (403) → real error reported", async () => {
  const d = await A.call("builder_create_draft", { model: "page", name: "Refused publish" });
  mock.fault.publishStatus = 403;
  const r = await A.call("builder_publish_content", { model: "page", id: d.json.id });
  mock.fault.publishStatus = 0;
  assert(r.isError && /403/.test(r.text) && /not allowed/.test(r.text), r.text);
  return { error: r.text };
});

await step("production space (or unmarked) → every write refused, nothing sent to the Write API", async () => {
  const i = mock.log.length;
  const out = [];
  for (const creds of [{ ...TEST, environment: "production" }, { ...TEST, environment: undefined }]) {
    const c = await connect({ creds });
    out.push(await c.call("builder_create_draft", { model: "page", name: "Should never exist" }));
    out.push(await c.call("builder_update_content", { model: "page", id: "seeddraft00001", data: { x: 1 } }));
    out.push(await c.call("builder_publish_content", { model: "page", id: "seeddraft00001" }));
    const st = await c.call("builder_access_status");
    assert(st.json.environment === "production" && /refused/.test(st.json.writes), "status shows refused");
    await c.close();
  }
  assert(out.every((r) => r.isError && /never writes to a production space/.test(r.text)), "all refused");
  assert(writesSince(i).length === 0, "no write request at all");
  return { refused: out.length };
});

await step("read profile (Inspect, or no builder.write): write tools don't exist", async () => {
  const names = async (profile) => { const c = await connect({ profile }); const t = (await c.client.listTools()).tools.map((x) => x.name); await c.close(); return t; };
  const read = await names("read"), unset = await names(null), full = await names("full");
  for (const t of [read, unset]) assert(!t.some((n) => /create_draft|update_content|publish_content|upload_asset/.test(n)) && t.includes("builder_verify_content"), JSON.stringify(t));
  assert(full.includes("builder_upload_asset"), "full has the upload tool");
  assert(full.includes("builder_publish_content"), "full has write tools");
  return { read, full };
});

await step("base URL override to a non-local host is refused (the key is never sent there)", async () => {
  const c = await connect({ bases: "https://attacker.example" });
  const r = await c.call("builder_list_models");
  await c.close();
  assert(r.isError && /local test server/.test(r.text), r.text);
  return { error: r.text };
});

await step("draft update of a PUBLISHED entry: autoSaveOnly, live page unchanged, draft readable, verify shows it pending", async () => {
  const i = mock.log.length;
  const r = await A.call("builder_update_content", { model: "page", id: "seedpublished01", data: { title: "Live DRAFT v3" }, draft: true });
  const w = writesSince(i);
  assert(!r.isError && /pending draft/.test(r.json.mode) && r.json.previewUrl.startsWith("/live?builder.preview=page&builder.cachebust=true&builder.overrides.page=seedpublished01"), r.text);
  assert(w.length === 1 && w[0].search.autoSaveOnly === "true", "sent with autoSaveOnly");
  const stored = await A.call("builder_get_content", { model: "page", id: "seedpublished01" });
  const latest = await A.call("builder_get_content", { model: "page", id: "seedpublished01", draft: true });
  const v = await A.call("builder_verify_content", { model: "page", id: "seedpublished01" });
  assert(stored.json.data.title === "Live v2" && latest.json.data.title === "Live DRAFT v3", JSON.stringify({ stored: stored.json.data.title, latest: latest.json.data.title }));
  assert(v.json.servedAsLive === true && v.json.pendingDraft === true, JSON.stringify(v.json));
  return { mode: r.json.mode, stored: stored.json.data.title, latest: latest.json.data.title, pendingDraft: v.json.pendingDraft };
});

await step("publish with a pending draft: the DRAFT's content goes live (a bare flag would discard it)", async () => {
  const i = mock.log.length;
  const r = await A.call("builder_publish_content", { model: "page", id: "seedpublished01" });
  const w = writesSince(i);
  assert(r.json.publishedPendingDraft === true && w[0].body.data.title === "Live DRAFT v3" && w[0].body.published === "published" && !w[0].search.autoSaveOnly, JSON.stringify(w[0]));
  const stored = await A.call("builder_get_content", { model: "page", id: "seedpublished01" });
  assert(stored.json.data.title === "Live DRAFT v3" && r.json.verification.pendingDraft === false && r.json.verification.servedAsLive, JSON.stringify(r.json.verification));
  return { publishedPendingDraft: r.json.publishedPendingDraft, nowLive: stored.json.data.title };
});

await step("update a PUBLISHED entry with neither draft nor live → refused, nothing sent; both → refused", async () => {
  const i = mock.log.length;
  const none = await A.call("builder_update_content", { model: "page", id: "seedpublished01", data: { x: 1 } });
  const both = await A.call("builder_update_content", { model: "page", id: "seedpublished01", data: { x: 1 }, draft: true, live: true });
  assert(none.isError && /draft:true/.test(none.text) && both.isError && writesSince(i).length === 0, none.text + " | " + both.text);
  return { none: none.text.slice(0, 90) };
});

await step("dataFile: page data read from a JSON file in the workspace, with breakpoints as meta", async () => {
  const i = mock.log.length;
  const r = await A.call("builder_update_content", { model: "page", id: draftId, dataFile: "page.json", breakpoints: { small: 700, medium: 1050 }, draft: true });
  const w = writesSince(i)[0];
  assert(!r.isError && w.body.data.blocks[0].id === "builder-from-file" && w.body.meta.breakpoints.medium === 1050 && w.search.autoSaveOnly === "true", r.text);
  const g = await A.call("builder_get_content", { model: "page", id: draftId, draft: true });
  assert(g.json.breakpoints.small === 700 && g.json.data.title === "From file", JSON.stringify(g.json.breakpoints));
  return { updated: r.json.updated, breakpoints: g.json.breakpoints };
});

await step("breakpoints survive later writes (a write without meta clears them in Builder): draft, publish, live", async () => {
  const i = mock.log.length;
  await A.call("builder_update_content", { model: "page", id: draftId, data: { title: "Second draft write" }, draft: true });
  await A.call("builder_publish_content", { model: "page", id: draftId });
  await A.call("builder_update_content", { model: "page", id: draftId, data: { title: "Live write" }, live: true });
  const w = writesSince(i);
  assert(w.length === 3 && w.every((x) => x.body.meta?.breakpoints?.medium === 1050), JSON.stringify(w.map((x) => x.body.meta)));
  const g = await A.call("builder_get_content", { model: "page", id: draftId });
  assert(g.json.breakpoints?.small === 700 && g.json.data.title === "Live write", JSON.stringify(g.json));
  return { sentWithEachWrite: w.map((x) => x.body.meta.breakpoints), stored: g.json.breakpoints };
});

await step("delivery's injected tracking pixel is never shown, compared or written back", async () => {
  const g = await A.call("builder_get_content", { model: "page", id: draftId });
  const v = await A.call("builder_verify_content", { model: "page", id: draftId });
  const i = mock.log.length;
  await A.call("builder_publish_content", { model: "page", id: draftId });
  const w = writesSince(i)[0];
  assert(!JSON.stringify(g.json.data).includes("builder-pixel-") && v.json.pendingDraft === false && !JSON.stringify(w.body).includes("builder-pixel-"), JSON.stringify({ blocks: g.json.data.blocks, v: v.json, w: w.body }));
  return { blocksShown: g.json.data.blocks.length, pendingDraft: v.json.pendingDraft };
});

await step("dataFile refusals: outside the workspace, not an object, invalid JSON, bad breakpoints; nothing sent", async () => {
  const i = mock.log.length;
  const out = [
    await A.call("builder_update_content", { model: "page", id: draftId, dataFile: join(OUTSIDE, "secret.png") }),
    await A.call("builder_update_content", { model: "page", id: draftId, dataFile: "../" + OUTSIDE.split(/[\\/]/).pop() + "/secret.png" }),
    await A.call("builder_update_content", { model: "page", id: draftId, dataFile: "array.json" }),
    await A.call("builder_update_content", { model: "page", id: draftId, dataFile: "broken.json" }),
    await A.call("builder_update_content", { model: "page", id: draftId, data: {}, breakpoints: { large: 1200 }, draft: true }),
  ];
  assert(out.every((r) => r.isError) && /outside the workspace/.test(out[0].text) && /outside the workspace/.test(out[1].text) && /JSON object/.test(out[2].text) && /valid JSON/.test(out[3].text) && /Breakpoints|Invalid arguments/.test(out[4].text), out.map((r) => r.text).join(" | "));
  assert(writesSince(i).length === 0, "nothing sent");
  return { refused: out.length };
});

await step("upload: an image and a font from the workspace → CDN url, sent with its type and the private key", async () => {
  const before = mock.log.length;
  const img = await A.call("builder_upload_asset", { path: "logo.png", altText: "Logo" });
  const font = await A.call("builder_upload_asset", { path: "Heading.ttf" });
  const ups = mock.log.slice(before).filter((r) => r.path === "/api/v1/upload");
  assert(!img.isError && img.json.url.startsWith("https://cdn.builder.io/") && img.json.type === "image/png" && font.json.type === "font/ttf", img.text + font.text);
  assert(ups.length === 2 && ups[0].auth === `Bearer ${KEYS.private}` && ups[0].search.name === "logo.png" && ups[0].search.altText === "Logo", JSON.stringify(ups[0]));
  return { image: img.json, font: font.json };
});

await step("upload refusals: outside the workspace (absolute and ../), a non-asset type, no workspace, production; nothing sent", async () => {
  const before = mock.log.length;
  const out = [
    await A.call("builder_upload_asset", { path: join(OUTSIDE, "secret.png") }),
    await A.call("builder_upload_asset", { path: "../" + OUTSIDE.split(/[\\/]/).pop() + "/secret.png" }),
    await A.call("builder_upload_asset", { path: "tool.exe" }),
  ];
  const noRoot = await connect({ root: null }); out.push(await noRoot.call("builder_upload_asset", { path: "logo.png" })); await noRoot.close();
  const prod = await connect({ creds: { ...TEST, environment: "production" } }); out.push(await prod.call("builder_upload_asset", { path: "logo.png" })); await prod.close();
  assert(out.every((r) => r.isError), out.map((r) => r.text).join(" | "));
  assert(/outside the workspace/.test(out[0].text) && /outside the workspace/.test(out[1].text) && /Only images and fonts/.test(out[2].text) && /no workspace/.test(out[3].text) && /production/.test(out[4].text), out.map((r) => r.text).join(" | "));
  assert(mock.log.slice(before).filter((r) => r.path === "/api/v1/upload").length === 0, "nothing uploaded");
  return { refused: out.map((r) => r.text.slice(0, 50)) };
});

await step("no key ever appears in any tool output", async () => {
  const leaked = outputs.filter((t) => t.includes(KEYS.private) || t.includes(KEYS.public));
  assert(leaked.length === 0, `leaked in ${leaked.length} outputs`);
  return { outputsChecked: outputs.length };
});

await A.close();
await mock.close();
for (const d of dirs) rmSync(d, { recursive: true, force: true });
mkdirSync(HERE, { recursive: true });
writeFileSync(join(HERE, "adapter-results.json"), JSON.stringify({ when: new Date().toISOString(), note: "Mocked Builder API: proves the adapter's requests and guards, not Builder's behaviour.", results }, null, 1));
console.log(`\n${results.filter((x) => x.ok).length}/${results.length} passed`);
if (results.some((r) => !r.ok)) process.exitCode = 1;
