// Figma Reader: reads a design straight from Figma's REST API, given only a Figma URL.
// No plugin, no open Figma window, no bridge. It reads; it never changes the file
// (changing a design stays the job of the Figma Executor plugin).
//
//   URL -> file key (+ node id) -> authenticated REST requests -> compact outline + renders
//
// Credentials live outside the repo, in ~/.figma-reader/credentials.json:
//   { "type": "pat",   "token": "figd_..." }                       personal access token
//   { "type": "oauth", "access_token": "...", "refresh_token": "...", "expires_at": 1790000000000,
//     "client_id": "...", "client_secret": "..." }                  written by oauth.mjs
// FIGMA_TOKEN in the environment (a personal access token) takes precedence.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const API = "https://api.figma.com";
// FIGMA_READER_DIR moves the credentials folder (tests use a scratch one); it holds a path, not a secret.
export const CRED_DIR = process.env.FIGMA_READER_DIR || join(homedir(), ".figma-reader");
export const CRED_FILE = join(CRED_DIR, "credentials.json");

// ---- URLs ------------------------------------------------------------------------
// https://www.figma.com/design/<key>/<name>?node-id=12038-273
// https://www.figma.com/file/<key>/..., /proto/<key>/..., /board/<key>/... (FigJam)
// https://www.figma.com/design/<key>/branch/<branchKey>/<name>  (a branch is its own file key)
export function parseFigmaUrl(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { throw new Error(`Not a URL: ${input}`); }
  if (!/(^|\.)figma\.com$/i.test(u.hostname)) throw new Error(`Not a figma.com URL: ${u.hostname}`);
  const m = /^\/(design|file|proto|board|slides)\/([A-Za-z0-9]{10,})(?:\/branch\/([A-Za-z0-9]{10,}))?/.exec(u.pathname);
  if (!m) throw new Error(`No file key in this Figma URL: ${u.pathname}`);
  const raw = u.searchParams.get("node-id");
  return { kind: m[1], fileKey: m[3] || m[2], mainFileKey: m[2], branchKey: m[3] || null, nodeId: raw ? raw.replace(/-/g, ":") : null };
}

// ---- auth --------------------------------------------------------------------------
function readCredentials() {
  if (process.env.FIGMA_TOKEN) return { type: "pat", token: process.env.FIGMA_TOKEN.trim() };
  if (!existsSync(CRED_FILE)) throw new Error(`No Figma credentials. Put a personal access token in FIGMA_TOKEN, or create ${CRED_FILE} (see figma-reader/README.md).`);
  return JSON.parse(readFileSync(CRED_FILE, "utf8"));
}
export function saveCredentials(c) { mkdirSync(CRED_DIR, { recursive: true }); writeFileSync(CRED_FILE, JSON.stringify(c, null, 1), { mode: 0o600 }); }
// Refresh goes to /v1/oauth/token with grant_type=refresh_token (changelog, May 16, 2025); the
// older /v1/oauth/refresh is still accepted and used as a fallback.
async function refreshOAuth(c) {
  const headers = { "content-type": "application/x-www-form-urlencoded", authorization: "Basic " + Buffer.from(`${c.client_id}:${c.client_secret}`).toString("base64") };
  let r = await fetch(`${API}/v1/oauth/token`, { method: "POST", headers, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: c.refresh_token }) });
  if (r.status === 404 || r.status === 400) r = await fetch(`${API}/v1/oauth/refresh`, { method: "POST", headers, body: new URLSearchParams({ refresh_token: c.refresh_token }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Figma OAuth refresh failed (${r.status}): ${j.message || j.error || JSON.stringify(j).slice(0, 200)}. Authorize again with oauth.mjs.`);
  const next = { ...c, access_token: j.access_token, expires_at: Date.now() + (j.expires_in || 0) * 1000, ...(j.refresh_token ? { refresh_token: j.refresh_token } : {}) };
  saveCredentials(next);
  return next;
}
async function authHeaders() {
  let c = readCredentials();
  if (c.type === "pat") return { "X-Figma-Token": c.token };
  if (c.type === "oauth") {
    if (c.expires_at && Date.now() > c.expires_at - 60_000 && c.refresh_token) c = await refreshOAuth(c);
    return { Authorization: `Bearer ${c.access_token}` };
  }
  throw new Error(`Unknown credential type in ${CRED_FILE}`);
}

// ---- requests ----------------------------------------------------------------------
// Waits and retries on 429 (Retry-After), and turns Figma's errors into plain messages.
// Rate limits (since Nov 17, 2025) depend on the token user's seat and the plan of the FILE:
// file, nodes and image renders are "Tier 1", capped at a few requests a month for View/Collab
// seats and for files in Starter teams, and 10-20/min for Dev/Full seats on paid plans. So the
// Reader makes as few Tier 1 calls as it can: a link with a node-id costs two (nodes + render).
export const stats = { requests: 0, retries: 0 };
export async function api(path, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    stats.requests++;
    const r = await fetch(API + path, { headers: await authHeaders() });
    if (r.status === 429 && attempt < retries) {
      const wait = Math.min(60, Number(r.headers.get("retry-after")) || 2 ** attempt * 5);
      stats.retries++; stats.lastRetryAfter = r.headers.get("retry-after"); stats.rateLimitType = r.headers.get("x-figma-rate-limit-type"); stats.planTier = r.headers.get("x-figma-plan-tier");
      await new Promise((ok) => setTimeout(ok, wait * 1000));
      continue;
    }
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
    if (!r.ok) {
      const why = j.err || j.message || j.error || text.slice(0, 200);
      const e = new Error(r.status === 401 ? `Figma rejected the authorization (401): ${why}. The token or OAuth grant is invalid, expired or revoked; connect Figma again.`
        : r.status === 403 ? `Figma refused access (403): ${why}. The token's user must be able to view this file, and the token needs the file_content:read scope.`
        : r.status === 404 ? `Figma says this file or node doesn't exist, or this account can't see it (404): ${why}`
        : r.status === 429 ? `Figma rate limit reached (429). Retry-After: ${r.headers.get("retry-after")}s, limit type: ${r.headers.get("x-figma-rate-limit-type") || "?"}, plan tier: ${r.headers.get("x-figma-plan-tier") || "?"}`
        : `Figma API error ${r.status}: ${why}`);
      e.status = r.status; e.headers = Object.fromEntries(r.headers); throw e;
    }
    return j;
  }
}

// ---- reading ----------------------------------------------------------------------
export async function readFile(fileKey, { depth = 2 } = {}) {
  return api(`/v1/files/${fileKey}?depth=${depth}`);
}
export async function readNodes(fileKey, ids, { depth } = {}) {
  return api(`/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(ids.join(","))}${depth ? `&depth=${depth}` : ""}`);
}
export async function renderNodes(fileKey, ids, { format = "png", scale = 1 } = {}) {
  return api(`/v1/images/${fileKey}?ids=${encodeURIComponent(ids.join(","))}&format=${format}&scale=${scale}`);
}
export async function download(url, to) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Couldn't download render (${r.status})`);
  writeFileSync(to, Buffer.from(await r.arrayBuffer()));
  return to;
}

// ---- outline for Claude -----------------------------------------------------------
// One line per node: type, absolute box, then only the properties that are set. Compact enough
// to read a whole screen, precise enough to rebuild it (this is the format the Stitch design was
// rebuilt from, there taken from the plugin).
const hex = (c, a = 1) => { const h = (v) => Math.round(v * 255).toString(16).padStart(2, "0"); const alpha = (c.a ?? 1) * a; return `#${h(c.r)}${h(c.g)}${h(c.b)}${alpha < 1 ? "@" + alpha.toFixed(2) : ""}`; };
function paints(list, styles) {
  return (list || []).filter((p) => p.visible !== false).map((p) => {
    if (p.type === "SOLID") return hex(p.color, p.opacity ?? 1);
    if (p.type?.startsWith("GRADIENT")) return `${p.type.replace("GRADIENT_", "").toLowerCase()}-gradient(${(p.gradientStops || []).map((s) => `${hex(s.color)} ${Math.round(s.position * 100)}%`).join(", ")})`;
    if (p.type === "IMAGE") return `image(${p.imageRef || "?"},${(p.scaleMode || "").toLowerCase()})`;
    return p.type;
  }).join("+");
}
function nodeLine(n, d, ctx) {
  const b = n.absoluteBoundingBox;
  let s = `${"  ".repeat(d)}${n.type} "${(n.name || "").slice(0, 60)}"`;
  if (b) s += ` ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`;
  if (n.visible === false) s += " hidden";
  if (n.type === "TEXT") {
    const st = n.style || {};
    s += ` text="${(n.characters || "").replace(/\s+/g, " ").slice(0, 120)}" ${st.fontFamily || ""} ${st.fontWeight || ""} ${st.fontSize || ""}/${st.lineHeightPx ? Math.round(st.lineHeightPx * 100) / 100 : "auto"}`;
    if (st.letterSpacing) s += ` ls${Math.round(st.letterSpacing * 100) / 100}`;
    if (st.textCase && st.textCase !== "ORIGINAL") s += ` ${st.textCase}`;
    if (st.textAlignHorizontal && st.textAlignHorizontal !== "LEFT") s += ` align-${st.textAlignHorizontal.toLowerCase()}`;
  }
  const f = paints(n.fills); if (f) s += ` fill:${f}`;
  const k = paints(n.strokes); if (k) s += ` stroke:${k}/${n.strokeWeight ?? 1}${n.strokeAlign ? "/" + n.strokeAlign.toLowerCase() : ""}`;
  if (n.cornerRadius) s += ` r${n.cornerRadius}`; else if (n.rectangleCornerRadii) s += ` r${n.rectangleCornerRadii.join("/")}`;
  if (n.layoutMode && n.layoutMode !== "NONE") s += ` ${n.layoutMode === "HORIZONTAL" ? "row" : "col"} gap${n.itemSpacing ?? 0} p${[n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft].map((v) => v ?? 0).join("/")}${n.primaryAxisAlignItems ? " main-" + n.primaryAxisAlignItems.toLowerCase() : ""}${n.counterAxisAlignItems ? " cross-" + n.counterAxisAlignItems.toLowerCase() : ""}${n.layoutWrap === "WRAP" ? " wrap" : ""}`;
  if (n.layoutSizingHorizontal || n.layoutSizingVertical) s += ` size:${(n.layoutSizingHorizontal || "-").toLowerCase()}/${(n.layoutSizingVertical || "-").toLowerCase()}`;
  if (n.opacity != null && n.opacity < 1) s += ` op${Math.round(n.opacity * 100) / 100}`;
  const fx = (n.effects || []).filter((e) => e.visible !== false);
  if (fx.length) s += ` fx:${fx.map((e) => e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW" ? `${e.type === "DROP_SHADOW" ? "shadow" : "inner"}(${e.offset?.x ?? 0},${e.offset?.y ?? 0},${e.radius}${e.spread ? "," + e.spread : ""},${hex(e.color)})` : `${e.type.toLowerCase()}(${e.radius})`).join(",")}`;
  if (n.componentId) s += ` instance-of:"${ctx.components?.[n.componentId]?.name || n.componentId}"`;
  if (n.componentProperties) s += ` props:${Object.entries(n.componentProperties).map(([k2, v]) => `${k2.split("#")[0]}=${v.value}`).join(",")}`;
  if (n.styles) s += ` styles:${Object.entries(n.styles).map(([k2, id]) => `${k2}=${ctx.styles?.[id]?.name || id}`).join(",")}`;
  if (n.boundVariables && Object.keys(n.boundVariables).length) s += ` vars:${Object.keys(n.boundVariables).join(",")}`;
  return s;
}
export function outline(root, ctx = {}, { maxNodes = 4000 } = {}) {
  const out = []; let count = 0, truncated = false;
  (function walk(n, d) {
    if (count >= maxNodes) { truncated = true; return; }
    count++; out.push(nodeLine(n, d, ctx));
    for (const c of n.children || []) walk(c, d + 1);
  })(root, 0);
  if (truncated) out.push(`… truncated at ${maxNodes} nodes`);
  return { text: out.join("\n"), nodes: count, truncated };
}
